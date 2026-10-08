import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { externalCallsDisabled } from "../external-call-policy.js";
import { acquireRuntimeLock } from "../process-lock.js";
import type { ActionMode } from "../../types/runtime.js";
import type { EditorialWriterModelV2 } from "./writer.js";

export const GEMINI_DEFAULT_MODEL_V2 = "gemini-3.5-flash";
export const GEMINI_DAILY_REQUEST_LIMIT_V2 = 60;
export const GEMINI_MAX_ATTEMPTS_V2 = 3;
const GEMINI_ENDPOINT_V2 = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_TIMEOUT_MS_V2 = 60_000;
const GEMINI_MAX_RETRY_DELAY_MS_V2 = 30_000;
// Thinking tokens count against the output cap; a tight cap truncates the JSON contract.
const GEMINI_MAX_OUTPUT_TOKENS_V2 = 8192;

export type EditorialModelProviderV2 = "anthropic" | "gemini";

/**
 * Gemini is a free-tier experiment for shadow collection only. Live tracking keeps the
 * Anthropic writer so shadow evidence can never be mistaken for the publishing model.
 */
export function resolveEditorialModelProviderV2(input: {
  env?: NodeJS.ProcessEnv;
  mode: ActionMode;
  trackingMode: "live" | "shadow";
}): EditorialModelProviderV2 {
  const raw = String((input.env ?? process.env).EDITORIAL_MODEL_PROVIDER ?? "").trim().toLowerCase();
  if (!raw || raw === "anthropic") return "anthropic";
  if (raw !== "gemini") throw new Error("EDITORIAL_MODEL_PROVIDER must be anthropic or gemini");
  if (input.trackingMode !== "shadow" || input.mode === "live") {
    throw new Error("EDITORIAL_MODEL_PROVIDER=gemini requires EDITORIAL_TRACKING_MODE=shadow and a non-live ACTION_MODE");
  }
  return "gemini";
}

export function resolveGeminiModelIdV2(env: NodeJS.ProcessEnv = process.env): string {
  const model = String(env.GEMINI_EDITORIAL_MODEL || GEMINI_DEFAULT_MODEL_V2).trim();
  if (!/^gemini-[a-z0-9][a-z0-9.-]*$/u.test(model)) throw new Error("GEMINI_EDITORIAL_MODEL is invalid");
  return model;
}

class GeminiRequestError extends Error {
  constructor(readonly reason: string, readonly retryable: boolean, readonly retryAfterMs?: number) {
    super(reason);
  }
}

function logGemini(event: Record<string, unknown>): void {
  console.error(`[GEMINI] ${JSON.stringify(event)}`);
}

/** Honors the server's RetryInfo delay when present, otherwise backs off exponentially. */
function parseRetryDelayMs(body: unknown): number | undefined {
  const details = (body as { error?: { details?: unknown } })?.error?.details;
  if (!Array.isArray(details)) return undefined;
  for (const detail of details) {
    const delay = (detail as { retryDelay?: unknown })?.retryDelay;
    const match = typeof delay === "string" ? delay.match(/^(\d+(?:\.\d+)?)s$/u) : null;
    if (match) return Math.ceil(Number(match[1]) * 1000);
  }
  return undefined;
}

function extractText(body: unknown): string {
  const candidate = (body as { candidates?: Array<{ finishReason?: string; content?: { parts?: unknown[] } }> })
    ?.candidates?.[0];
  if (!candidate) throw new GeminiRequestError("gemini-no-candidate", false);
  if (candidate.finishReason && candidate.finishReason !== "STOP") {
    throw new GeminiRequestError(`gemini-finish-${candidate.finishReason.toLowerCase()}`, false);
  }
  const text = (candidate.content?.parts ?? [])
    .filter((part): part is { text: string; thought?: boolean } =>
      typeof (part as { text?: unknown })?.text === "string" && (part as { thought?: unknown }).thought !== true)
    .map((part) => part.text)
    .join("")
    .trim();
  if (!text) throw new GeminiRequestError("gemini-empty-text", false);
  return text;
}

async function requestOnce(input: {
  apiKey: string; model: string; system: string; prompt: string; fetchImpl: typeof fetch; timeoutMs: number;
}): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    let response: Response;
    try {
      response = await input.fetchImpl(`${GEMINI_ENDPOINT_V2}/${input.model}:generateContent`, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: { "x-goog-api-key": input.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: input.system }] },
          contents: [{ role: "user", parts: [{ text: input.prompt }] }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS_V2,
            responseMimeType: "application/json",
            thinkingConfig: { thinkingLevel: "low" },
          },
        }),
      });
    } catch {
      throw new GeminiRequestError(controller.signal.aborted ? "gemini-timeout" : "gemini-network-error", true);
    }
    let body: unknown;
    try { body = await response.json(); } catch { body = undefined; }
    if (!response.ok) {
      const status = response.status;
      if (status === 429) throw new GeminiRequestError("gemini-rate-limited", true, parseRetryDelayMs(body));
      if (status === 401 || status === 403) throw new GeminiRequestError("gemini-auth-failed", false);
      throw new GeminiRequestError(`gemini-http-${status}`, status >= 500);
    }
    if (body === undefined) throw new GeminiRequestError("gemini-invalid-json", true);
    return extractText(body);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Every attempt reserves a slot in a durable daily ledger before dispatch, so crashes and
 * timeouts still count. Corrupt accounting fails closed instead of resetting the allowance.
 */
function reserveAttempt(ledgerDir: string, entry: Record<string, unknown>, now: Date): string {
  const day = now.toISOString().slice(0, 10);
  const lock = acquireRuntimeLock(path.join(ledgerDir, "request.lock"));
  if (!lock.acquired) throw new GeminiRequestError("gemini-ledger-locked", false);
  try {
    const logPath = path.join(ledgerDir, `${day}.ndjson`);
    const events = fs.existsSync(logPath)
      ? fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
      : [];
    if (events.some((event) => event?.kind !== "pixymon-gemini-editorial" ||
        !["reserved", "completed", "failed"].includes(String(event.status)) ||
        typeof event.requestId !== "string" || String(event.timestamp).slice(0, 10) !== day)) {
      throw new GeminiRequestError("gemini-ledger-invalid", false);
    }
    if (events.filter((event) => event.status === "reserved").length >= GEMINI_DAILY_REQUEST_LIMIT_V2) {
      throw new GeminiRequestError("gemini-daily-request-limit", false);
    }
    const requestId = randomUUID();
    appendLedger(logPath, { ...entry, kind: "pixymon-gemini-editorial", requestId, timestamp: now.toISOString(), status: "reserved" });
    return requestId;
  } finally {
    lock.release();
  }
}

function appendLedger(logPath: string, event: Record<string, unknown>): void {
  const fd = fs.openSync(logPath, "a", 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(event)}\n`); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

export function createGeminiEditorialModelV2(input: {
  apiKey?: string;
  model?: string;
  purpose: "write" | "inquire";
  ledgerDir: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}): EditorialWriterModelV2 {
  const model = input.model ?? resolveGeminiModelIdV2();
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return {
    modelId: model,
    async generate({ system, prompt, attempt: contractAttempt }) {
      // Checked per call so a long-lived process cannot keep stale permissions.
      if (externalCallsDisabled()) throw new Error("gemini-external-calls-disabled");
      const apiKey = input.apiKey?.trim();
      if (!apiKey) throw new Error("gemini-key-missing");
      fs.mkdirSync(input.ledgerDir, { recursive: true });
      for (let attempt = 1; attempt <= GEMINI_MAX_ATTEMPTS_V2; attempt += 1) {
        const now = (input.now ?? (() => new Date()))();
        const base = { model, purpose: input.purpose, contractAttempt, attempt };
        let requestId: string;
        try {
          requestId = reserveAttempt(input.ledgerDir, base, now);
        } catch (error) {
          const reason = error instanceof GeminiRequestError ? error.reason : "gemini-ledger-invalid";
          logGemini({ ...base, status: "blocked", reason });
          throw new Error(reason);
        }
        const logPath = path.join(input.ledgerDir, `${now.toISOString().slice(0, 10)}.ndjson`);
        const started = performance.now();
        try {
          const text = await requestOnce({ apiKey, model, system, prompt,
            fetchImpl: input.fetchImpl ?? fetch, timeoutMs: input.timeoutMs ?? GEMINI_TIMEOUT_MS_V2 });
          appendLedger(logPath, { ...base, kind: "pixymon-gemini-editorial", requestId, timestamp: now.toISOString(),
            status: "completed", latencyMs: Math.round(performance.now() - started) });
          return text;
        } catch (error) {
          const failure = error instanceof GeminiRequestError ? error : new GeminiRequestError("gemini-unknown-error", false);
          appendLedger(logPath, { ...base, kind: "pixymon-gemini-editorial", requestId, timestamp: now.toISOString(),
            status: "failed", reason: failure.reason, latencyMs: Math.round(performance.now() - started) });
          const willRetry = failure.retryable && attempt < GEMINI_MAX_ATTEMPTS_V2;
          logGemini({ ...base, status: "failed", reason: failure.reason, willRetry });
          if (!willRetry) throw new Error(failure.reason);
          const backoffMs = failure.retryAfterMs ?? 2000 * 2 ** (attempt - 1);
          await sleep(Math.min(GEMINI_MAX_RETRY_DELAY_MS_V2, backoffMs));
        }
      }
      throw new Error("gemini-retries-exhausted");
    },
  };
}
