import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  createGeminiEditorialModelV2,
  GEMINI_DAILY_REQUEST_LIMIT_V2,
  GEMINI_DEFAULT_MODEL_V2,
  resolveEditorialModelProviderV2,
  resolveGeminiModelIdV2,
} from "../src/services/editorial-v2/gemini-model.ts";

const NOW = new Date("2026-10-08T07:00:00.000Z");
const DAY_LOG = "2026-10-08.ndjson";

function ledgerDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-gemini-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// The suite runs with TEST_NO_EXTERNAL_CALLS=true; transport tests opt in explicitly with a mocked fetch.
function allowExternal(t: TestContext): void {
  const previous = process.env.TEST_NO_EXTERNAL_CALLS;
  process.env.TEST_NO_EXTERNAL_CALLS = "false";
  t.after(() => {
    if (previous === undefined) delete process.env.TEST_NO_EXTERNAL_CALLS;
    else process.env.TEST_NO_EXTERNAL_CALLS = previous;
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function okBody(text: string, finishReason = "STOP") {
  return { candidates: [{ finishReason, content: { parts: [{ text: "hidden reasoning", thought: true }, { text }] } }] };
}

function ledger(dir: string): Array<Record<string, unknown>> {
  return fs.readFileSync(path.join(dir, DAY_LOG), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function model(dir: string, fetchImpl: typeof fetch, sleeps: number[] = []) {
  return createGeminiEditorialModelV2({ apiKey: "test-key", model: GEMINI_DEFAULT_MODEL_V2, purpose: "write", ledgerDir: dir,
    fetchImpl, now: () => NOW, sleep: async (ms) => { sleeps.push(ms); } });
}

test("gemini provider defaults to anthropic and is confined to non-live shadow tracking", () => {
  assert.equal(resolveEditorialModelProviderV2({ env: {}, mode: "observe", trackingMode: "shadow" }), "anthropic");
  assert.equal(resolveEditorialModelProviderV2({ env: { EDITORIAL_MODEL_PROVIDER: "gemini" }, mode: "observe", trackingMode: "shadow" }), "gemini");
  assert.throws(() => resolveEditorialModelProviderV2({ env: { EDITORIAL_MODEL_PROVIDER: "gemini" }, mode: "observe", trackingMode: "live" }), /shadow/);
  assert.throws(() => resolveEditorialModelProviderV2({ env: { EDITORIAL_MODEL_PROVIDER: "gemini" }, mode: "live", trackingMode: "shadow" }), /non-live/);
  assert.throws(() => resolveEditorialModelProviderV2({ env: { EDITORIAL_MODEL_PROVIDER: "openai" }, mode: "observe", trackingMode: "shadow" }), /anthropic or gemini/);
});

test("gemini model id is validated before it is interpolated into the endpoint", () => {
  assert.equal(resolveGeminiModelIdV2({}), GEMINI_DEFAULT_MODEL_V2);
  assert.equal(resolveGeminiModelIdV2({ GEMINI_EDITORIAL_MODEL: "gemini-3.8-flash" }), "gemini-3.8-flash");
  assert.throws(() => resolveGeminiModelIdV2({ GEMINI_EDITORIAL_MODEL: "gemini-3/../x" }), /invalid/);
  assert.throws(() => resolveGeminiModelIdV2({ GEMINI_EDITORIAL_MODEL: "gpt-5" }), /invalid/);
});

test("gemini request sends JSON-mode contract and returns only non-thought text", async (t) => {
  allowExternal(t);
  const dir = ledgerDir(t);
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return jsonResponse(200, okBody('{"draft":"ok"}'));
  }) as typeof fetch;
  const text = await model(dir, fetchImpl).generate({ system: "SYS", prompt: "PROMPT", attempt: 1 });
  assert.equal(text, '{"draft":"ok"}');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/models\/gemini-3\.5-flash:generateContent$/);
  assert.equal((calls[0].init.headers as Record<string, string>)["x-goog-api-key"], "test-key");
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.systemInstruction.parts[0].text, "SYS");
  assert.equal(body.contents[0].parts[0].text, "PROMPT");
  assert.equal(body.generationConfig.responseMimeType, "application/json");
  assert.equal(body.generationConfig.temperature, 0);
  assert.deepEqual(ledger(dir).map((event) => event.status), ["reserved", "completed"]);
  assert.equal(JSON.stringify(ledger(dir)).includes("test-key"), false);
});

test("gemini retries 429 with the server delay and 503 with backoff, at most three attempts", async (t) => {
  allowExternal(t);
  const dir = ledgerDir(t);
  const responses = [
    jsonResponse(429, { error: { details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "7s" }] } }),
    jsonResponse(503, { error: { status: "UNAVAILABLE" } }),
    jsonResponse(200, okBody("{}")),
  ];
  const sleeps: number[] = [];
  const fetchImpl = (async () => responses.shift()!) as typeof fetch;
  assert.equal(await model(dir, fetchImpl, sleeps).generate({ system: "s", prompt: "p", attempt: 1 }), "{}");
  assert.deepEqual(sleeps, [7000, 4000]);
  assert.deepEqual(ledger(dir).map((event) => [event.status, event.reason ?? null]), [
    ["reserved", null], ["failed", "gemini-rate-limited"],
    ["reserved", null], ["failed", "gemini-http-503"],
    ["reserved", null], ["completed", null],
  ]);
});

test("gemini stops after three transient failures and surfaces the reason", async (t) => {
  allowExternal(t);
  const dir = ledgerDir(t);
  let calls = 0;
  const fetchImpl = (async () => { calls += 1; return jsonResponse(503, {}); }) as typeof fetch;
  await assert.rejects(model(dir, fetchImpl).generate({ system: "s", prompt: "p", attempt: 1 }), /gemini-http-503/);
  assert.equal(calls, 3);
});

test("gemini does not retry auth failures or truncated output", async (t) => {
  allowExternal(t);
  const dir = ledgerDir(t);
  let calls = 0;
  const auth = (async () => { calls += 1; return jsonResponse(403, {}); }) as typeof fetch;
  await assert.rejects(model(dir, auth).generate({ system: "s", prompt: "p", attempt: 1 }), /gemini-auth-failed/);
  assert.equal(calls, 1);
  const truncated = (async () => { calls += 1; return jsonResponse(200, okBody('{"draft":', "MAX_TOKENS")); }) as typeof fetch;
  await assert.rejects(model(dir, truncated).generate({ system: "s", prompt: "p", attempt: 1 }), /gemini-finish-max_tokens/);
  assert.equal(calls, 2);
});

test("gemini enforces the durable daily allowance before dispatch", async (t) => {
  allowExternal(t);
  const dir = ledgerDir(t);
  const reserved = Array.from({ length: GEMINI_DAILY_REQUEST_LIMIT_V2 }, (_, index) => JSON.stringify({
    kind: "pixymon-gemini-editorial", requestId: `r${index}`, timestamp: NOW.toISOString(), status: "reserved" }));
  fs.writeFileSync(path.join(dir, DAY_LOG), `${reserved.join("\n")}\n`);
  let calls = 0;
  const fetchImpl = (async () => { calls += 1; return jsonResponse(200, okBody("{}")); }) as typeof fetch;
  await assert.rejects(model(dir, fetchImpl).generate({ system: "s", prompt: "p", attempt: 1 }), /gemini-daily-request-limit/);
  assert.equal(calls, 0);
});

test("gemini fails closed on corrupt accounting", async (t) => {
  allowExternal(t);
  const dir = ledgerDir(t);
  fs.writeFileSync(path.join(dir, DAY_LOG), `${JSON.stringify({ kind: "other", status: "reserved" })}\n`);
  let calls = 0;
  const fetchImpl = (async () => { calls += 1; return jsonResponse(200, okBody("{}")); }) as typeof fetch;
  await assert.rejects(model(dir, fetchImpl).generate({ system: "s", prompt: "p", attempt: 1 }), /gemini-ledger-invalid/);
  assert.equal(calls, 0);
});

test("gemini honors the external-call guard and a missing key without dispatching", async (t) => {
  const dir = ledgerDir(t);
  let calls = 0;
  const fetchImpl = (async () => { calls += 1; return jsonResponse(200, okBody("{}")); }) as typeof fetch;
  await assert.rejects(model(dir, fetchImpl).generate({ system: "s", prompt: "p", attempt: 1 }), /gemini-external-calls-disabled/);
  allowExternal(t);
  const keyless = createGeminiEditorialModelV2({ apiKey: " ", model: GEMINI_DEFAULT_MODEL_V2, purpose: "write", ledgerDir: dir, fetchImpl });
  await assert.rejects(keyless.generate({ system: "s", prompt: "p", attempt: 1 }), /gemini-key-missing/);
  assert.equal(calls, 0);
  assert.equal(fs.existsSync(path.join(dir, DAY_LOG)), false);
});
