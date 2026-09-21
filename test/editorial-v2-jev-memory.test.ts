import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { jevReviewCasesV2 } from "../eval/jev-review-cases.ts";
import { EditorialEventStoreV2, type EditorialDraftStateV2 } from "../src/services/editorial-v2/event-store.ts";
import { collectEditorialDraftV2, editorialMemoryCandidatesV2, editorialMemoryFromStoreV2 } from "../src/services/editorial-v2/workflow.ts";
import { buildJevMemoryRequestV2, selectJevMemoryV2, JEV_MEMORY_EPOCH_V2 } from "../src/services/editorial-v2/jev-memory.ts";
import { runJevReviewV2, JEV_DAILY_REVIEW_LIMIT_V2 } from "../src/services/editorial-v2/jev-review-runner.ts";
import { JEV_MODEL_V2, type JevReviewRequestV2 } from "../src/services/editorial-v2/jev-review.ts";
import { readEditorialDecisionContextV2, replayEditorialDecisionV2 } from "../src/services/editorial-v2/decision-replay.ts";
import { planEditorialV2 } from "../src/services/editorial-v2/planner.ts";
import type { EvidenceCardV2 } from "../src/services/editorial-v2/evidence.ts";
import { inquiryModelFixture } from "./helpers/editorial-inquiry.ts";
import { createFollowUpScheduleV2 } from "../src/services/editorial-v2/follow-ups.ts";

const NOW = new Date("2026-09-21T10:00:00.000Z");
const sample = () => jevReviewCasesV2()[0].state;
function evidence(): EvidenceCardV2 {
  const fact = sample().draft.facts[0];
  return { schemaVersion: 2, id: fact.factId, subject: fact.subject, lane: "protocol", kind: "signal",
    metric: fact.metric, followUp: fact.followUp,
    source: { ...fact.source, provider: "defillama", origin: "direct", role: "primary" },
    freshness: { kind: "signal", measuredAt: fact.source.observedAt, maxAgeMs: 7_200_000, ageMs: 1_800_000, state: "fresh" },
    providerHealth: { provider: "defillama", state: "green", reason: "ok", checkedAt: NOW.toISOString(), latencyMs: 1, itemCount: 1 },
    provenance: { kind: "onchain-nutrient", sourceId: "aave" } };
}
function past(id: string, date: string, resolution: "supported" | "invalidated" = "supported"): EditorialDraftStateV2 {
  const state = sample();
  state.draft.id = id;
  state.draft.createdAt = date;
  state.draft.followUpSchedule = createFollowUpScheduleV2(date);
  state.draft.falsifier.deadline = state.draft.followUpSchedule.due72h;
  const observedAt = state.draft.followUpSchedule.due72h;
  const observedValue = resolution === "invalidated" ? 99_000_000 : 108_400_000;
  state.followUps = [{ schemaVersion: 2, id: `${id}:outcome`, draftId: id, checkpoint: "72h", resolution,
    reason: resolution === "invalidated" ? "falsifier-matched" : "falsifier-not-matched",
    resolvedAt: observedAt, observedAt, metric: "tvl-usd", observedValue, falsifierMatched: resolution === "invalidated",
    observation: { factId: `${id}:checkpoint`, subject: "Aave",
      metric: { name: "tvl-usd", value: observedValue, raw: String(observedValue), unit: "USD", period: "snapshot" },
      source: { ...state.draft.facts[0].source, observedAt } } }];
  return state;
}
function states() {
  return [past("older-failed-test", "2026-09-10T09:30:00.000Z", "invalidated"), past("latest-observation", "2026-09-15T09:30:00.000Z")];
}
function planned() {
  const result = planEditorialV2({ evidence: [evidence()], now: NOW.toISOString() });
  if (result.status !== "planned") assert.fail(result.reason);
  result.plan.memoryContext = editorialMemoryFromStoreV2(states(), evidence());
  return result.plan;
}
function candidates() { return editorialMemoryCandidatesV2(states(), evidence(), NOW.toISOString(), "shadow"); }
function responseFor(request: JevReviewRequestV2, choice = "memory_2", confidence = 1) {
  return { model: JEV_MODEL_V2, usage: { input_tokens: 800, output_tokens: 80 }, answers: {
    memory: { type: "choice", choice, confidence,
      probabilities: Object.fromEntries(Object.keys(request.questions.memory.criteria).map((key) => [key, key === choice ? 1 : 0])) },
  } };
}
function mockFetch(choice = "memory_2", confidence = 1): typeof fetch {
  return async (_url, init) => new Response(JSON.stringify(responseFor(JSON.parse(String(init?.body)), choice, confidence)));
}
function options(auditDir: string, fetchImpl: typeof fetch = mockFetch()) {
  return { auditDir, apiKey: "test-key", allowExternal: true, fetchImpl };
}
function selectionInput(auditDir: string) {
  return { plan: planned(), evidence: evidence(), candidates: candidates(), options: options(auditDir),
    runId: "memory-run", actionId: "memory-action", now: NOW };
}
function temp(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-jev-memory-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("recall filters entity, metric, provenance and future knowledge before Jev; stable shortlist is bounded", () => {
  const original = states();
  const mutations: Array<(s: EditorialDraftStateV2) => void> = [
    (s) => { s.draft.trackingMode = "live"; },
    (s) => { s.draft.subject = "Different"; },
    (s) => { s.draft.facts[0].source.provider = "coingecko"; },
    (s) => { s.draft.facts[0].metric.name = "other"; },
    (s) => { s.draft.facts[0].metric.unit = "USD"; },
    (s) => { s.draft.facts[0].metric.period = "7d"; },
    (s) => { s.draft.facts[0].subjectKey = "lookalike"; },
    (s) => { s.draft.lane = "onchain"; },
    (s) => { s.draft.createdAt = "2026-09-22T00:00:00.000Z"; },
  ];
  const irrelevant = mutations.map((mutate, i) => { const state = past(`excluded-${i}`, "2026-09-19T00:00:00.000Z"); mutate(state); return state; });
  const pool = [...original, ...irrelevant];
  const snapshot = structuredClone(pool);
  assert.deepEqual(editorialMemoryCandidatesV2(pool, evidence(), NOW.toISOString(), "shadow"), candidates());
  assert.deepEqual(pool, snapshot);
  assert.deepEqual(editorialMemoryCandidatesV2(pool, evidence(), NOW.toISOString(), "live"), []); // unposted is not experience
  const many = Array.from({ length: 9 }, (_, i) => past(`history-${i}`, `2026-09-${String(i + 1).padStart(2, "0")}T00:00:00Z`));
  assert.equal(editorialMemoryCandidatesV2(many, evidence(), NOW.toISOString(), "shadow").length, 6);
  assert.deepEqual(editorialMemoryCandidatesV2([...many].reverse(), evidence(), NOW.toISOString(), "shadow"),
    editorialMemoryCandidatesV2(many, evidence(), NOW.toISOString(), "shadow"));
  const futureOutcome = past("known-original", "2026-09-10T09:30:00Z");
  futureOutcome.followUps[0].resolvedAt = "2026-09-22T00:00:00Z";
  assert.equal(editorialMemoryCandidatesV2([futureOutcome], evidence(), NOW.toISOString(), "shadow")[0].memory.previous?.outcome, undefined);
});

test("recall deduplicates original/Revisit threads and rejects dangling or cross-entity parent links", () => {
  const original = states()[0];
  const revisit = past("revisit", "2026-09-20T09:30:00Z");
  revisit.draft.format = "revisit";
  revisit.draft.continuityThread = `${original.draft.id}:72h`;
  // Real Revisit evidence is the absolute level, not the original percentage move.
  revisit.draft.facts = [original.followUps[0].observation!];
  const result = editorialMemoryCandidatesV2([original, revisit], evidence(), NOW.toISOString(), "shadow");
  assert.equal(result.length, 1);
  assert.equal(result[0].memory.previous?.draftId, "revisit");
  assert.equal(result[0].memory.previous?.outcome?.resolution, "invalidated");
  assert.deepEqual(editorialMemoryCandidatesV2([revisit], evidence(), NOW.toISOString(), "shadow"), []);
  original.draft.subject = "Different";
  assert.deepEqual(editorialMemoryCandidatesV2([original, revisit], evidence(), NOW.toISOString(), "shadow"), []);
});

test("recall keeps a final 72h verdict when a missed 24h checkpoint was logged later", () => {
  const state = states()[0];
  state.followUps = [...state.followUps, { schemaVersion: 2, id: "late-24h", draftId: state.draft.id,
    checkpoint: "24h", resolution: "silent", reason: "checkpoint-window-missed", resolvedAt: NOW.toISOString() }];
  assert.equal(editorialMemoryCandidatesV2([state], evidence(), NOW.toISOString(), "shadow")[0].memory.previous?.outcome?.resolution, "invalidated");
});

test("Jev receives a narrow bounded question and candidates, no IDs/URLs/reviews; request deterministic 100 times", () => {
  const input = { plan: planned(), evidence: evidence(), candidates: candidates() };
  const request = buildJevMemoryRequestV2(input);
  const encoded = JSON.stringify(request);
  assert.doesNotMatch(encoded, /older-failed-test|latest-observation|api\.llama|runId|reviewerId/);
  assert.match(request.questions.memory.instructions, /Shared subject alone is insufficient/);
  assert.ok(request.questions.memory.criteria.none);
  for (let i = 0; i < 100; i++) assert.deepEqual(buildJevMemoryRequestV2(input), request);
  assert.throws(() => buildJevMemoryRequestV2({ ...input, candidates: [] }), /candidate-contract/);
  const large = candidates();
  large[0].memory.previous!.text = "가".repeat(25_000);
  assert.throws(() => buildJevMemoryRequestV2({ ...input, candidates: large }), /request-too-large/);
});

for (const [choice, confidence, expected] of [
  ["memory_2", 1, "selected"], ["none", 1, "none"], ["unclear", 1, "uncertain"], ["memory_2", 0.4, "uncertain"],
] as const) test(`selection ${choice}/${confidence} copies the older record or explicitly omits memory`, async (t) => {
  const dir = temp(t);
  const input = selectionInput(dir);
  const before = structuredClone(input.candidates);
  const result = await selectJevMemoryV2({ ...input, options: options(dir, mockFetch(choice, confidence)) });
  assert.equal(result.status, expected);
  assert.equal(result.memory.previous?.draftId, expected === "selected" ? "older-failed-test" : undefined);
  assert.equal(result.memory.previous?.outcome?.resolution, expected === "selected" ? "invalidated" : undefined);
  assert.deepEqual(input.candidates, before);
  assert.ok(result.requestDigest);
  assert.equal(result.response?.answers.memory.confidence, confidence);
});

test("empty recall and Revisit parent require zero Jev calls or audit writes", async (t) => {
  const dir = path.join(temp(t), "audit");
  const input = selectionInput(dir);
  input.options.fetchImpl = async () => { assert.fail("must not call"); };
  assert.equal((await selectJevMemoryV2({ ...input, candidates: [] })).status, "empty");
  input.plan.format = "revisit";
  input.plan.continuityThread = "latest-observation:72h";
  const before = structuredClone(input.plan);
  const result = await selectJevMemoryV2(input);
  assert.equal(result.status, "revisit-parent");
  assert.deepEqual(result.memory, before.memoryContext);
  assert.deepEqual(input.plan, before);
  input.plan.continuityThread = "nonexistent:72h";
  assert.equal((await selectJevMemoryV2(input)).status, "blocked");
  assert.equal(fs.existsSync(dir), false);
});

test("fabricated choice and missing key fail closed without latest-memory fallback", async (t) => {
  const dir = temp(t);
  const input = selectionInput(dir);
  const invalid = await selectJevMemoryV2({ ...input, options: options(dir, mockFetch("invented")) });
  assert.equal(invalid.status, "blocked");
  assert.equal(invalid.reason, "jev-response-contract");
  assert.equal(invalid.memory.previous, undefined);
  const missing = await selectJevMemoryV2({ ...input, options: { ...options(dir), apiKey: "" } });
  assert.equal(missing.status, "blocked");
  assert.equal(missing.reason, "typesafe-key-missing");
});

test("a concentrated-confidence field cannot override a split choice distribution", async (t) => {
  const dir = temp(t);
  const input = selectionInput(dir);
  input.options.fetchImpl = async (_url, init) => {
    const response = responseFor(JSON.parse(String(init?.body)));
    response.answers.memory.probabilities = { memory_1: 0.2, memory_2: 0.5, none: 0.2, unclear: 0.1 };
    return new Response(JSON.stringify(response));
  };
  const result = await selectJevMemoryV2(input);
  assert.equal(result.status, "uncertain");
  assert.equal(result.memory.previous, undefined);
});

test("collection rejects Jev on live-candidate ledgers before reading providers or generating", async (t) => {
  const dir = temp(t);
  const store = new EditorialEventStoreV2({ eventLogPath: path.join(dir, "events.ndjson") });
  await assert.rejects(collectEditorialDraftV2({ store, mode: "observe", trackingMode: "live", now: NOW,
    metricLogPath: path.join(dir, "metrics.ndjson"), jevMemory: options(dir),
    sense: async () => assert.fail("provider must not run"),
    inquiryModel: { async generate() { assert.fail("inquiry must not run"); } },
    writerModel: { async generate() { assert.fail("writer must not run"); } },
  }), /requires isolated shadow tracking/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("hard evidence failure is decided before Jev, with no remote or generation call", async (t) => {
  const dir = temp(t);
  const card = evidence();
  card.source.origin = "derived";
  const result = await collectEditorialDraftV2({
    store: new EditorialEventStoreV2({ eventLogPath: path.join(dir, "events.ndjson") }), mode: "observe", trackingMode: "shadow", now: NOW,
    metricLogPath: path.join(dir, "metrics.ndjson"), jevMemory: options(dir, async () => assert.fail("Jev must not run")),
    sensing: { evidence: [card], observations: [], discoveries: [], providers: [] },
    inquiryModel: { async generate() { assert.fail("inquiry must not run"); } },
    writerModel: { async generate() { assert.fail("writer must not run"); } },
  });
  assert.ok(result.status === "no-post" && result.reason === "no-tier-a-evidence");
});

test("memory calls share the advisory request limit including failures", async (t) => {
  const dir = temp(t);
  let calls = 0;
  const opts = options(dir, async () => { calls++; return new Response("no", { status: 429 }); });
  for (let i = 0; i < JEV_DAILY_REVIEW_LIMIT_V2 - 1; i++) {
    await runJevReviewV2({ ...opts, state: sample(), execute: true, sourceKind: "synthetic", now: NOW });
  }
  const input = { ...selectionInput(dir), options: opts };
  assert.equal((await selectJevMemoryV2(input)).reason, "jev-rate-limited");
  assert.equal((await selectJevMemoryV2(input)).reason, "jev-daily-request-limit");
  assert.equal(calls, JEV_DAILY_REVIEW_LIMIT_V2);
});

async function collectFixture(dir: string, choice = "memory_2", confidence = 1, fail = false) {
  const store = new EditorialEventStoreV2({ eventLogPath: path.join(dir, "events.ndjson"), now: () => NOW });
  for (const state of states()) {
    store.createDraft(state.draft as Parameters<typeof store.createDraft>[0]);
    store.recordFollowUpResolution(state.draft.id, { checkpoint: "24h", resolution: "silent", reason: "no-change",
      resolvedAt: state.draft.followUpSchedule.due24h });
    store.recordFollowUpResolution(state.draft.id, state.followUps[0]);
  }
  const card = evidence();
  const prompts: string[] = [];
  let calls = 0;
  const writerModel = { async generate({ prompt }: { prompt: string }) {
    prompts.push(prompt);
    return JSON.stringify(sample().draft.generatedPayload);
  } };
  const result = await collectEditorialDraftV2({
    store, mode: "observe", trackingMode: "shadow", now: NOW, runId: "jev-flow", actionId: "jev-next",
    metricLogPath: path.join(dir, "metrics.ndjson"), inquiryModel: inquiryModelFixture, writerModel,
    sensing: { evidence: [card], observations: [], discoveries: [], providers: [] },
    jevMemory: options(path.join(dir, "editorial-jev"), async (url, init) => {
      calls++;
      return fail ? new Response("private failure", { status: 429 }) : mockFetch(choice, confidence)(url, init);
    }),
  });
  const contextPath = path.join(dir, "decision-contexts", fs.readdirSync(path.join(dir, "decision-contexts"))[0]);
  return { store, result, prompts, calls, writerModel, context: readEditorialDecisionContextV2(contextPath) };
}

test("Jev's older memory reaches inquiry, writer and executable check; same-context replay isolates its effect", async (t) => {
  const { store, result, prompts, calls, writerModel, context } = await collectFixture(temp(t));
  assert.equal(result.status, "drafted", JSON.stringify(result));
  assert.equal(calls, 1);
  const draft = store.getDraftState("jev-next")!.draft;
  assert.equal(draft.collectionEpoch, JEV_MEMORY_EPOCH_V2);
  assert.equal(draft.memoryContext?.previous?.draftId, "older-failed-test");
  assert.equal(draft.editorialCase?.inquiry?.memory?.draftId, "older-failed-test");
  assert.equal(draft.editorialCase?.inquiry?.check, "current-level");
  assert.equal(draft.falsifier.threshold, 108_400_000);
  assert.match(prompts[0], /older-failed-test/);
  assert.doesNotMatch(prompts[0], /latest-observation/);
  assert.equal(context.memorySelection?.response?.answers.memory.choice, "memory_2");
  const before = JSON.stringify(context);
  for (const variant of ["captured-plan", "current-plan", "latest-memory"] as const) {
    const replay = await replayEditorialDecisionV2({ context, model: writerModel, inquiryModel: inquiryModelFixture, variant });
    assert.ok("planning" in replay);
    if ("planning" in replay) {
      assert.equal(replay.planning.plan.memoryContext?.previous?.draftId, variant === "latest-memory" ? "latest-observation" : "older-failed-test");
      assert.equal(replay.planning.plan.falsifier.threshold, variant === "latest-memory" ? 100_000_000 : 108_400_000);
    }
  }
  assert.equal(JSON.stringify(context), before);
  store.approve("jev-next", { reviewerId: "tester" });
  assert.throws(() => store.preparePublication("jev-next"), /shadow-draft-cannot-publish/);
  assert.equal(store.readEvents().some((e) => e.type === "draft-published" || e.type === "dispatch-prepared"), false);
});

for (const [choice, confidence] of [["none", 1], ["memory_2", 0.4]] as const) {
  test(`workflow ${choice}/${confidence} does not leak latest memory through inquiry or replay`, async (t) => {
    const { store, result, prompts, context, writerModel } = await collectFixture(temp(t), choice, confidence);
    assert.equal(result.status, "drafted", JSON.stringify(result));
    assert.equal(store.getDraftState("jev-next")!.draft.editorialCase?.inquiry?.memory, null);
    assert.equal(store.getDraftState("jev-next")!.draft.memoryContext?.previous, undefined);
    assert.doesNotMatch(prompts[0], /older-failed-test|latest-observation/);
    const replay = await replayEditorialDecisionV2({ context, model: writerModel, inquiryModel: inquiryModelFixture, variant: "current-plan" });
    assert.ok("planning" in replay && !replay.planning.plan.memoryContext?.previous);
  });
}

test("Jev outage stops inquiry/writer, records no-post and remains blocked in replay", async (t) => {
  const dir = temp(t);
  const { store, result, prompts, context, writerModel } = await collectFixture(dir, "memory_2", 1, true);
  assert.equal(result.status, "no-post");
  assert.ok(result.status === "no-post" && result.stage === "memory" && result.reason === "jev-rate-limited");
  assert.equal(prompts.length, 0);
  assert.equal(store.getDraftState("jev-next"), null);
  assert.match(fs.readFileSync(path.join(dir, "metrics.ndjson"), "utf8"), /"stage":"memory","outcome":"no-post"/);
  const replay = await replayEditorialDecisionV2({ context, model: writerModel, inquiryModel: inquiryModelFixture, variant: "current-plan" });
  assert.deepEqual(replay, { status: "no-post", stage: "memory", reason: "jev-rate-limited" });
  delete context.memorySelection;
  assert.deepEqual(await replayEditorialDecisionV2({ context, model: writerModel, variant: "captured-plan" }),
    { status: "no-post", stage: "memory", reason: "jev-memory-selection-missing" });
});

test("CLI rejects non-shadow, disabled network and missing key before provider or writer calls", () => {
  const env = { ...process.env, DOTENV_CONFIG_PATH: "/nonexistent/jev-test.env", POST_PIPELINE_VERSION: "v2",
    ACTION_MODE: "observe", TYPESAFE_API_KEY: "", ANTHROPIC_API_KEY: "", TEST_MODE: "false", TEST_NO_EXTERNAL_CALLS: "false" };
  for (const [overrides, message] of [
    [{ EDITORIAL_TRACKING_MODE: "live" }, /requires EDITORIAL_TRACKING_MODE=shadow/],
    [{ EDITORIAL_TRACKING_MODE: "shadow", TEST_MODE: "true" }, /requires TEST_MODE=false/],
    [{ EDITORIAL_TRACKING_MODE: "shadow" }, /TYPESAFE_API_KEY is required/],
  ] as const) {
    assert.throws(() => execFileSync(process.execPath, ["--import", "tsx", "scripts/editorial-collect.ts", "--jev-memory"],
      { env: { ...env, ...overrides }, stdio: "pipe" }), message);
  }
});
