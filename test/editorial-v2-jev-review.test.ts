import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";
import { jevReviewCasesV2 } from "../eval/jev-review-cases.ts";
import { buildJevReviewRequestV2, jevRequestDigestV2, parseJevReviewResponseV2, interpretJevReviewV2,
  requestJevReviewV2, JEV_ENDPOINT_V2, JEV_MODEL_V2, type JevReviewRequestV2 } from "../src/services/editorial-v2/jev-review.ts";
import { runJevReviewV2, JEV_DAILY_REVIEW_LIMIT_V2 } from "../src/services/editorial-v2/jev-review-runner.ts";
import { EditorialEventStoreV2 } from "../src/services/editorial-v2/event-store.ts";

const NOW = new Date("2026-09-21T10:00:00.000Z");
const fixture = () => jevReviewCasesV2()[0].state;
const request = () => buildJevReviewRequestV2(fixture());
// This mock tests plumbing, never Jev's semantic accuracy on Korean.
function responseFor(payload: JevReviewRequestV2) {
  return { model: JEV_MODEL_V2, usage: { input_tokens: 1400, output_tokens: 120 },
    answers: Object.fromEntries(Object.entries(payload.questions).map(([id, question]) => {
      const choice = id === "memory_use" && payload.state.previous === null ? "not_applicable" : Object.keys(question.criteria)[0];
      return [id, { type: "choice", choice, confidence: 1,
        probabilities: Object.fromEntries(Object.keys(question.criteria).map((key) => [key, key === choice ? 1 : 0])) }];
    })) };
}
const successFetch: typeof fetch = async (_url, init) => new Response(JSON.stringify(responseFor(JSON.parse(String(init?.body)))));

test("Jev request contains narrow evidence/memory questions, no operational metadata, and stays deterministic", () => {
  const state = fixture();
  state.reviews = [{ schemaVersion: 2, id: "private-review", draftId: state.draft.id,
    action: "approve", reviewerId: "private-operator", reasonTags: ["secret-note"], reviewedAt: NOW.toISOString() }];
  const original = structuredClone(state);
  const payload = buildJevReviewRequestV2(state);
  assert.deepEqual(state, original);
  assert.equal(Object.keys(payload.questions).length, 5);
  assert.doesNotMatch(JSON.stringify(payload), /private-operator|private-review|secret-note|api\.llama|synthetic-jev-evaluation/);
  assert.match(payload.questions.question_fit.instructions, /untrusted/);
  assert.match(payload.questions.memory_use.instructions, /Shadow experience/);
  for (let index = 0; index < 100; index++) assert.equal(jevRequestDigestV2(buildJevReviewRequestV2(state)), jevRequestDigestV2(payload));
  state.publishText = state.publishText.replace("되돌려지는지", "유지되는지");
  assert.notEqual(jevRequestDigestV2(buildJevReviewRequestV2(state)), jevRequestDigestV2(payload));
});

for (const item of jevReviewCasesV2()) {
  test(`synthetic Jev case ${item.id} has explicit labels outside the API payload`, () => {
    const payload = buildJevReviewRequestV2(item.state);
    assert.ok(!Object.hasOwn(payload.state, "expected"));
    for (const [id, label] of Object.entries(item.expected)) assert.ok(Object.hasOwn(payload.questions[id].criteria, label));
    const parsed = parseJevReviewResponseV2(responseFor(payload), payload);
    const result = interpretJevReviewV2(parsed);
    assert.equal(result.publishAuthorized, false);
    assert.equal(result.humanReviewRequired, true);
    assert.equal(result.calibration, "unvalidated-ko");
  });
}

test("invalid inquiry lineage, missing inquiry, oversize content, and sentence counts stop before inference", () => {
  const state = fixture();
  state.draft.editorialCase!.inquiry!.factIds = ["invented"];
  assert.throws(() => buildJevReviewRequestV2(state), /fact-link-mismatch/);
  delete state.draft.editorialCase!.inquiry;
  assert.throws(() => buildJevReviewRequestV2(state), /inquiry-contract/);
  const large = fixture();
  large.publishText = "가".repeat(25000) + ". 판단이다.";
  assert.throws(() => buildJevReviewRequestV2(large), /request-too-large/);
  large.publishText = "짧은 글.";
  assert.throws(() => buildJevReviewRequestV2(large), /sentence-contract/);
});

test("Revisit review does not present new draft scheduling thresholds as the historical test", () => {
  const state = jevReviewCasesV2().find((item) => item.id === "memory-correction")!.state;
  state.draft.format = "revisit";
  state.draft.editorialCase!.inquiry!.check = "recorded-checkpoint";
  const payload = buildJevReviewRequestV2(state);
  assert.equal((payload.state.test as { falsifier: unknown }).falsifier, null);
  assert.equal((payload.state.previous as { outcome: { resolution: string } }).outcome.resolution, "invalidated");
});

const invalidResponses: Array<[string, (value: any) => void]> = [
  ["unexpected model", (v) => { v.model = "jev-latest"; }],
  ["missing answer", (v) => { delete v.answers.question_fit; }],
  ["unknown answer", (v) => { v.answers.other = v.answers.question_fit; }],
  ["unknown choice", (v) => { v.answers.question_fit.choice = "auto-publish"; }],
  ["wrong primitive", (v) => { v.answers.question_fit.type = "score"; }],
  ["invalid confidence", (v) => { v.answers.question_fit.confidence = Number.NaN; }],
  ["negative probability", (v) => { v.answers.question_fit.probabilities.aligned = -1; }],
  ["incomplete distribution", (v) => { delete v.answers.question_fit.probabilities.unclear; }],
  ["extra distribution key", (v) => { v.answers.question_fit.probabilities.other = 0; }],
  ["invalid distribution sum", (v) => { v.answers.question_fit.probabilities.unclear = 0.4; }],
  ["choice disagrees with peak", (v) => { v.answers.question_fit.choice = "beyond_scope"; }],
  ["missing usage", (v) => { delete v.usage; }],
  ["invalid usage", (v) => { v.usage.input_tokens = -1; }],
];
for (const [name, corrupt] of invalidResponses) test(`Jev response fails closed: ${name}`, () => {
  const payload = request();
  const result = responseFor(payload);
  corrupt(result);
  assert.throws(() => parseJevReviewResponseV2(result, payload), /response-contract/);
});

test("high confidence never approves; one semantic problem cannot be averaged away", () => {
  const payload = request();
  const response = responseFor(payload);
  response.answers.sentence_2.choice = "unsupported";
  response.answers.sentence_2.probabilities = { grounded: 0, contradicted: 0, unsupported: 1, unclear: 0 };
  response.answers.question_fit.confidence = 0.2;
  const result = interpretJevReviewV2(parseJevReviewResponseV2(response, payload));
  assert.deepEqual(result.flags, ["sentence_2:unsupported"]);
  assert.deepEqual(result.uncertain, ["question_fit"]);
  assert.equal(result.publishAuthorized, false);
});

test("Jev requires explicit network permission and key; no fallback is returned", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => { calls++; throw new Error("unexpected"); };
  for (const [allowExternal, apiKey, reason] of [
    [false, "fake-key", "external-calls-disabled"], [true, "", "typesafe-key-missing"],
  ] as const) {
    assert.deepEqual(await requestJevReviewV2({ request: request(), allowExternal, apiKey, fetchImpl }),
      { status: "unavailable", reason, humanReviewRequired: true, publishAuthorized: false });
  }
  assert.equal(calls, 0);
});

test("Jev transport sends one batched request only to the official pinned endpoint", async () => {
  let calls = 0;
  const result = await requestJevReviewV2({ request: request(), apiKey: "fake-key", allowExternal: true,
    fetchImpl: async (url, init) => {
      calls++;
      assert.equal(url, JEV_ENDPOINT_V2);
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer fake-key");
      assert.ok(init?.signal);
      return successFetch(url, init);
    } });
  assert.equal(result.status, "evaluated");
  assert.equal(calls, 1);
});

for (const [status, reason] of [[401, "jev-auth-failed"], [403, "jev-auth-failed"], [429, "jev-rate-limited"], [529, "jev-overloaded"], [500, "jev-http-500"]] as const) {
  test(`Jev ${status} is explicit, sanitized and never automatically retried`, async () => {
    let calls = 0;
    const result = await requestJevReviewV2({ request: request(), apiKey: "fake-key", allowExternal: true,
      fetchImpl: async () => { calls++; return new Response("secret-provider-body", { status }); } });
    assert.deepEqual(result, { status: "unavailable", reason, humanReviewRequired: true, publishAuthorized: false });
    assert.equal(calls, 1);
  });
}

test("Jev timeout, invalid JSON, broken contract and network error cannot become a successful review", async () => {
  for (const [fetchImpl, reason] of [
    [async () => new Promise<Response>(() => {}), "jev-timeout"],
    [async () => new Response("not-json"), "jev-invalid-json"],
    [async () => new Response("{}"), "jev-response-contract"],
    [async () => { throw new Error("fake-key secret network error"); }, "jev-network-error"],
  ] as Array<[typeof fetch, string]>) {
    const result = await requestJevReviewV2({ request: request(), apiKey: "fake-key", allowExternal: true, fetchImpl, timeoutMs: 5 });
    assert.equal(result.status, "unavailable");
    if (result.status === "unavailable") assert.equal(result.reason, reason);
    assert.doesNotMatch(JSON.stringify(result), /fake-key|secret/);
  }
});

test("preview is side-effect-free; executing records provenance and usage without changing editorial state", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-jev-review-"));
  try {
    const store = new EditorialEventStoreV2({ eventLogPath: path.join(dir, "events.ndjson") });
    store.createDraft(fixture().draft as Parameters<typeof store.createDraft>[0]);
    const state = store.getDraftState(fixture().draft.id)!;
    const before = fs.readFileSync(path.join(dir, "events.ndjson"), "utf8");
    const auditDir = path.join(dir, "advisory");
    const input = { state, auditDir, sourceKind: "ledger" as const, allowExternal: true, apiKey: "fake-key", fetchImpl: successFetch, now: NOW };
    const preview = await runJevReviewV2({ ...input, execute: false });
    assert.equal(preview.status, "preview");
    assert.equal(preview.externalCalls, 0);
    assert.equal(fs.existsSync(auditDir), false);
    const report = await runJevReviewV2({ ...input, execute: true });
    assert.ok("result" in report && report.result.status === "evaluated");
    assert.equal(fs.readFileSync(path.join(dir, "events.ndjson"), "utf8"), before);
    assert.deepEqual(store.getDraftState(state.draft.id), state);
    const log = fs.readFileSync(path.join(auditDir, "2026-09-21.ndjson"), "utf8");
    const events = log.trim().split("\n").map((row) => JSON.parse(row));
    assert.deepEqual(events.map((event) => event.status), ["reserved", "completed"]);
    assert.equal(events[0].requestId, events[1].requestId);
    assert.equal(events[1].requestDigest, preview.requestDigest);
    assert.equal(events[1].result.response.usage.input_tokens, 1400);
    assert.doesNotMatch(log, /fake-key|review-recorded|draft-published|dispatch-prepared/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("Jev daily request limit counts failed calls, survives reruns, and resets only on a new UTC day", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-jev-budget-"));
  try {
    let calls = 0;
    const input = { state: fixture(), auditDir: dir, sourceKind: "synthetic" as const, execute: true, allowExternal: true,
      apiKey: "fake-key", now: NOW, fetchImpl: (async () => { calls++; return new Response("error", { status: 429 }); }) as typeof fetch };
    for (let index = 0; index < JEV_DAILY_REVIEW_LIMIT_V2; index++) await runJevReviewV2(input);
    const result = await runJevReviewV2(input);
    assert.ok("result" in result && result.result.status === "unavailable" && result.result.reason === "jev-daily-request-limit");
    assert.equal(calls, JEV_DAILY_REVIEW_LIMIT_V2);
    await runJevReviewV2({ ...input, now: new Date("2026-09-22T00:00:00.000Z") });
    assert.equal(calls, JEV_DAILY_REVIEW_LIMIT_V2 + 1);
    fs.appendFileSync(path.join(dir, "2026-09-21.ndjson"), "corrupt\n");
    await assert.rejects(() => runJevReviewV2(input));
    assert.equal(calls, JEV_DAILY_REVIEW_LIMIT_V2 + 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("concurrent Jev invocations cannot spend through the same reservation lock", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-jev-concurrent-"));
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  try {
    const input = { state: fixture(), auditDir: dir, sourceKind: "synthetic" as const, execute: true, allowExternal: true,
      apiKey: "fake-key", now: NOW, fetchImpl: (async (url, init) => { await waiting; return successFetch(url, init); }) as typeof fetch };
    const first = runJevReviewV2(input);
    const second = await runJevReviewV2(input);
    assert.ok("result" in second && second.result.status === "unavailable" && second.result.reason === "jev-audit-locked");
    release();
    assert.ok("result" in await first);
  } finally { release(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("operator CLI previews synthetic Korean cases offline and rejects live mode", () => {
  const env = { ...process.env, ACTION_MODE: "observe", TEST_MODE: "true", TEST_NO_EXTERNAL_CALLS: "true", TYPESAFE_API_KEY: "",
    DOTENV_CONFIG_PATH: "/nonexistent/jev-test.env" };
  const args = ["--import", "tsx", "scripts/editorial-jev-review.ts", "--case", "memory-distortion"];
  const report = JSON.parse(execFileSync(process.execPath, args, { env, encoding: "utf8" }));
  assert.equal(report.status, "preview");
  assert.equal(report.externalCalls, 0);
  assert.equal(report.sourceKind, "synthetic");
  assert.equal(report.publishAuthorized, false);
  assert.throws(() => execFileSync(process.execPath, args, { env: { ...env, ACTION_MODE: "live" }, stdio: "pipe" }));
});
