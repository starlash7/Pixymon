import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { acquireRuntimeLock } from "../process-lock.js";
import type { EditorialDraftStateV2 } from "./event-store.js";
import { buildJevReviewRequestV2, jevRequestDigestV2, requestJevChoicesV2, interpretJevReviewV2, JEV_RUBRIC_V2,
  JEV_REVIEW_CONFIDENCE_V2, type JevChoicesResultV2, type JevReviewRequestV2 } from "./jev-review.js";

export const JEV_DAILY_REVIEW_LIMIT_V2 = 12;

/** An operator-only experiment ledger. It is deliberately not a human-review or rollout event. */
export async function runJevReviewV2(input: {
  state: EditorialDraftStateV2; execute: boolean; allowExternal: boolean; apiKey?: string;
  sourceKind: "ledger" | "synthetic";
  auditDir: string; now?: Date; fetchImpl?: typeof fetch; timeoutMs?: number;
}) {
  const request = buildJevReviewRequestV2(input.state);
  return runJevExperimentV2({ ...input, request, rubric: JEV_RUBRIC_V2,
    kind: "pixymon-jev-advisory", metadata: {
      sourceKind: input.sourceKind, confidenceThreshold: JEV_REVIEW_CONFIDENCE_V2,
      runId: input.state.draft.runId, actionId: input.state.draft.id,
      trackingMode: input.state.draft.trackingMode ?? "live", reviewedText: input.state.publishText,
    } });
}

/** Review and pre-writing memory selection share the same durable, operator-only allowance. */
export async function runJevExperimentV2(input: {
  request: JevReviewRequestV2; rubric: string; kind: "pixymon-jev-advisory" | "pixymon-jev-memory";
  metadata: Record<string, unknown>; execute: boolean; allowExternal: boolean; apiKey?: string;
  auditDir: string; now?: Date; fetchImpl?: typeof fetch; timeoutMs?: number;
}) {
  const base = { ...input.metadata, kind: input.kind, version: 1, rubric: input.rubric,
    requestDigest: jevRequestDigestV2(input.request, input.rubric), request: input.request,
    humanReviewRequired: true as const, publishAuthorized: false as const };
  if (!input.execute) return { ...base, status: "preview" as const, externalCalls: 0 as const };
  const unavailable = (reason: string): JevChoicesResultV2 => ({ status: "unavailable", reason,
    humanReviewRequired: true, publishAuthorized: false });
  if (!input.allowExternal || !input.apiKey?.trim()) return { ...base,
    status: "completed" as const, externalCalls: 0 as const,
    result: unavailable(!input.allowExternal ? "external-calls-disabled" : "typesafe-key-missing") };
  const now = (input.now ?? new Date()).toISOString();
  const day = now.slice(0, 10);
  const lock = acquireRuntimeLock(path.join(input.auditDir, "request.lock"));
  if (!lock.acquired) return { ...base, status: "completed" as const, externalCalls: 0 as const,
    result: unavailable("jev-audit-locked") };
  try {
    const logPath = path.join(input.auditDir, `${day}.ndjson`);
    const events = fs.existsSync(logPath)
      ? fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    // Unknown/corrupt accounting fails closed instead of resetting the allowance.
    if (events.some((event) => !event || !["pixymon-jev-advisory", "pixymon-jev-memory"].includes(event.kind) || event.version !== 1 ||
        !["reserved", "completed"].includes(event.status) || typeof event.requestId !== "string" ||
        typeof event.timestamp !== "string" || event.timestamp.slice(0, 10) !== day)) {
      throw new Error("jev-audit-invalid");
    }
    if (events.filter((event) => event.status === "reserved").length >= JEV_DAILY_REVIEW_LIMIT_V2) {
      return { ...base, status: "completed" as const, externalCalls: 0 as const, result: unavailable("jev-daily-request-limit") };
    }
    const requestId = randomUUID();
    const append = (event: unknown) => {
      const fd = fs.openSync(logPath, "a", 0o600);
      try { fs.writeFileSync(fd, `${JSON.stringify(event)}\n`); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
    };
    // A crash or timeout still consumes its reservation. Never replay an uncertain paid request automatically.
    append({ ...base, requestId, timestamp: now, status: "reserved" });
    const started = performance.now();
    const transport = await requestJevChoicesV2({ request: input.request, apiKey: input.apiKey, allowExternal: input.allowExternal,
      fetchImpl: input.fetchImpl, timeoutMs: input.timeoutMs });
    const result = input.kind === "pixymon-jev-advisory" && transport.status === "evaluated"
      ? interpretJevReviewV2(transport.response) : transport;
    const report = { ...base, requestId, timestamp: now, status: "completed" as const, externalCalls: 1 as const,
      latencyMs: Math.round(performance.now() - started), result };
    append(report);
    return { ...report, logPath };
  } finally { lock.release(); }
}
