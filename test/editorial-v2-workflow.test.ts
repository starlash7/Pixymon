import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { EditorialEventStoreV2 } from "../src/services/editorial-v2/event-store.ts";
import { checkEditorialFollowUpsV2, collectEditorialDraftV2 } from "../src/services/editorial-v2/workflow.ts";
import { splitEditorialSentencesV2 } from "../src/services/editorial-v2/validator.ts";
import type { EditorialClaimKindV2 } from "../src/services/editorial-v2/writer.ts";
import type { EvidenceCardV2 } from "../src/services/editorial-v2/evidence.ts";
import type { EditorialSensingResultV2 } from "../src/services/editorial-v2/provider-adapters.ts";
import { createFollowUpScheduleV2, createMachineFalsifierV2 } from "../src/services/editorial-v2/follow-ups.ts";

const NOW = new Date("2026-08-28T10:00:00.000Z");

function evidence(): EvidenceCardV2 {
  return {
    schemaVersion: 2,
    id: "fact:aave:tvl",
    lane: "protocol",
    kind: "signal",
    subject: "Aave",
    metric: { name: "tvl-change-24h", value: 8.4, raw: "+8.4%", unit: "%", period: "24h" },
    source: { provider: "defillama", url: "https://api.llama.fi/v2/chains", publishedAt: null, observedAt: "2026-08-28T09:30:00.000Z", origin: "direct", role: "primary" },
    freshness: { kind: "signal", measuredAt: "2026-08-28T09:30:00.000Z", maxAgeMs: 7_200_000, ageMs: 1_800_000, state: "fresh" },
    providerHealth: { provider: "defillama", state: "green", reason: "ok", checkedAt: NOW.toISOString(), latencyMs: 5, itemCount: 1 },
    provenance: { kind: "onchain-nutrient", sourceId: "aave:tvl" },
  };
}

function sensing(cards: EvidenceCardV2[], observations: EvidenceCardV2[] = []): EditorialSensingResultV2 {
  return { evidence: cards, observations, discoveries: [], providers: [{ outcome: { kind: "success", provider: "defillama", checkedAt: NOW.toISOString(), latencyMs: 5, itemCount: cards.length + observations.length }, evidence: cards, observations, discoveries: [] }] };
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-v2-workflow-"));
  let id = 0;
  return {
    dir,
    metrics: path.join(dir, "metrics.ndjson"),
    store: new EditorialEventStoreV2({ eventLogPath: path.join(dir, "events.ndjson"), now: () => NOW, idFactory: (kind) => `${kind}-${++id}` }),
  };
}

function claimsFor(draft: string, factId: string) {
  return splitEditorialSentencesV2(draft).map((text, index) => ({
    kind: (index === 0
      ? "observation"
      : /(?:으)?면|경우/u.test(text) ? "falsifier" : "judgment") as EditorialClaimKindV2,
    text,
    factIds: [factId],
  }));
}

test("observe collection creates a review draft without any X dependency", async () => {
  const f = fixture();
  const text = "Aave의 TVL은 2026-08-28 09:30 UTC 기준 24시간 동안 +8.4% 늘었지만, 바로 승인하진 않겠다. 72시간 뒤 같은 지표의 관측값이 기준 미만이면 이 판정을 철회한다.";
  const result = await collectEditorialDraftV2({
    store: f.store,
    metricLogPath: f.metrics,
    mode: "observe",
    now: NOW,
    runId: "run-1",
    actionId: "action-1",
    sensing: sensing([evidence()]),
    writerModel: { async generate() { return JSON.stringify({ draft: text, usedFactIds: ["fact:aave:tvl"], claims: claimsFor(text, "fact:aave:tvl") }); } },
  });
  assert.equal(result.status, "drafted");
  assert.equal(f.store.listDraftStates().length, 1);
  assert.equal(f.store.listDraftStates()[0].draft.facts[0].source.url, "https://api.llama.fi/v2/chains");
  assert.match(fs.readFileSync(f.metrics, "utf8"), /"type":"generation_attempt"/);
});

test("every no-post records a planning stage and reason", async () => {
  const f = fixture();
  const bad = evidence();
  bad.source.origin = "derived";
  const result = await collectEditorialDraftV2({
    store: f.store,
    metricLogPath: f.metrics,
    mode: "observe",
    now: NOW,
    sensing: sensing([bad]),
    writerModel: { async generate() { throw new Error("writer must not run"); } },
  });
  assert.deepEqual({ status: result.status, stage: result.status === "no-post" ? result.stage : "", reason: result.status === "no-post" ? result.reason : "" }, { status: "no-post", stage: "eligibility", reason: "no-tier-a-evidence" });
  assert.match(fs.readFileSync(f.metrics, "utf8"), /"outcome":"no-post"/);
});

function publishedFollowUpFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-v2-followup-workflow-"));
  let current = new Date("2026-08-01T01:00:00.000Z");
  let id = 0;
  const store = new EditorialEventStoreV2({
    eventLogPath: path.join(dir, "events.ndjson"),
    now: () => current,
    idFactory: (kind) => `${kind}-${++id}`,
  });
  const createdAt = "2026-08-01T00:00:00.000Z";
  const schedule = createFollowUpScheduleV2(createdAt);
  store.createDraft({
    id: "original",
    runId: "original-run",
    createdAt,
    format: "bite",
    subject: "Aave",
    thesis: "Aave의 일간 TVL 변화를 절대 TVL로 다시 검증한다.",
    factIds: ["original-fact"],
    facts: [{
      factId: "original-fact",
      subject: "Aave",
      subjectKey: "aave",
      metric: { name: "tvl-change-24h", value: 8, raw: "+8.00%", unit: "%", period: "24h" },
      source: { provider: "defillama", url: "https://api.llama.fi/protocols", publishedAt: null, observedAt: "2026-08-01T00:30:00.000Z" },
      followUp: {
        metric: { name: "tvl-usd", value: 108_000_000, raw: "$108.00M", unit: "USD", period: "snapshot" },
        comparator: "lt",
        threshold: 100_000_000,
      },
    }],
    verdict: "approve",
    falsifier: createMachineFalsifierV2({ metric: "tvl-usd", comparator: "lt", threshold: 100_000_000, unit: "USD" }, schedule),
    followUpSchedule: schedule,
    voiceState: "curious",
    draft: "Aave의 TVL은 2026-08-01 00:30 UTC 기준 24시간 동안 +8.00% 늘었다. 변동 전 수준 아래로 돌아가면 이 판정을 철회한다.",
  });
  store.approve("original", { reviewerId: "operator" });
  const preparation = store.preparePublication("original");
  if (preparation.status !== "ready") assert.fail("expected ready publication");
  store.markDispatching("original", { preparedAt: preparation.freshnessCheckedAt, expectedPublishText: preparation.publishText });
  store.markPublished("original", { externalPostId: "x-original", preparedAt: preparation.freshnessCheckedAt, publishedAt: current.toISOString() });
  return {
    dir,
    metrics: path.join(dir, "metrics.ndjson"),
    store,
    setNow(value: string) { current = new Date(value); },
  };
}

function followUpObservation(observedAt: string, value = 80_000_000): EvidenceCardV2 {
  return {
    ...evidence(),
    id: `fact:aave:tvl-usd:${observedAt}`,
    subjectKey: "aave",
    metric: { name: "tvl-usd", value, raw: `$${(value / 1_000_000).toFixed(2)}M`, unit: "USD", period: "snapshot" },
    source: { ...evidence().source, url: "https://api.llama.fi/protocols", observedAt },
    freshness: { ...evidence().freshness, measuredAt: observedAt, ageMs: 0 },
    providerHealth: { ...evidence().providerHealth, checkedAt: observedAt },
  };
}

test("24h verification requests the absolute tracked metric and can draft without a generic candidate", async () => {
  const f = publishedFollowUpFixture();
  const dueAt = "2026-08-02T02:00:00.000Z";
  f.setNow(dueAt);
  const observation = followUpObservation(dueAt);
  const text = "Aave의 현재 TVL은 2026-08-02 02:00 UTC 기준 $80.00M 수준이다. 24시간 재검증에서 변동 전 기준이 무너졌으므로 이전 판정을 철회하고 미결로 남긴다.";
  const result = await collectEditorialDraftV2({
    store: f.store,
    metricLogPath: f.metrics,
    mode: "observe",
    now: new Date(dueAt),
    runId: "followup-run",
    actionId: "followup-draft",
    sense: async (targets) => {
      assert.deepEqual(targets, [{ provider: "defillama", subject: "Aave", subjectKey: "aave", metricName: "tvl-usd", unit: "USD", period: "snapshot" }]);
      return sensing([], [observation]);
    },
    writerModel: { async generate() { return JSON.stringify({ draft: text, usedFactIds: [observation.id], claims: claimsFor(text, observation.id) }); } },
  });
  assert.equal(result.status, "drafted");
  const original = f.store.getDraftState("original");
  assert.equal(original?.followUps[0]?.resolution, "candidate");
  const revisit = f.store.getDraftState("followup-draft");
  assert.equal(revisit?.draft.format, "revisit");
  assert.equal(revisit?.draft.continuityThread, "original:24h");
  assert.equal(revisit?.draft.facts[0]?.metric.name, "tvl-usd");
});

test("a recorded follow-up candidate remains retryable after writer failure", async () => {
  const f = publishedFollowUpFixture();
  const firstAt = "2026-08-02T02:00:00.000Z";
  f.setNow(firstAt);
  const firstObservation = followUpObservation(firstAt);
  const failed = await collectEditorialDraftV2({
    store: f.store,
    metricLogPath: f.metrics,
    mode: "observe",
    now: new Date(firstAt),
    runId: "failed-run",
    actionId: "failed-draft",
    sensing: sensing([], [firstObservation]),
    writerModel: { async generate() { return null; } },
  });
  assert.equal(failed.status, "no-post");
  assert.equal(f.store.getDraftState("original")?.followUps[0]?.resolution, "candidate");

  const retryAt = "2026-08-02T02:05:00.000Z";
  f.setNow(retryAt);
  const retryObservation = followUpObservation(retryAt, 105_000_000);
  const text = "Aave의 현재 TVL은 2026-08-02 02:00 UTC 기준 $80.00M 수준이다. 24시간 재검증에서 기준이 무너졌으므로 이전 판정을 철회하고 미결로 남긴다.";
  const retried = await collectEditorialDraftV2({
    store: f.store,
    metricLogPath: f.metrics,
    mode: "observe",
    now: new Date(retryAt),
    runId: "retry-run",
    actionId: "retry-draft",
    sensing: sensing([], [retryObservation]),
    writerModel: { async generate() { return JSON.stringify({ draft: text, usedFactIds: [firstObservation.id], claims: claimsFor(text, firstObservation.id) }); } },
  });
  assert.equal(retried.status, "drafted");
  assert.equal(f.store.getDraftState("retry-draft")?.draft.continuityThread, "original:24h");
  assert.equal(f.store.getDraftState("retry-draft")?.draft.verdict, "corrected");
  assert.equal(f.store.getDraftState("retry-draft")?.draft.facts[0]?.metric.value, 80_000_000);
  assert.equal(f.store.getDraftState("retry-draft")?.draft.facts[0]?.source.observedAt, firstAt);
});

test("provider-only follow-up checks do not require a writer", async () => {
  const f = publishedFollowUpFixture();
  const dueAt = "2026-08-02T02:00:00.000Z";
  f.setNow(dueAt);
  const checked = await checkEditorialFollowUpsV2({
    store: f.store,
    metricLogPath: f.metrics,
    mode: "observe",
    now: new Date(dueAt),
    sensing: sensing([], [followUpObservation(dueAt)]),
  });
  assert.deepEqual(
    { targets: checked.targetCount, resolutions: checked.resolutionCount, candidates: checked.publicCandidateCount },
    { targets: 1, resolutions: 1, candidates: 1 }
  );
  assert.equal(f.store.listDraftStates().length, 1);
  assert.equal(f.store.getDraftState("original")?.followUps[0]?.resolution, "candidate");
});

test("an unavailable due observation stays retryable without starving an unrelated Tier A draft", async () => {
  const f = publishedFollowUpFixture();
  const dueAt = "2026-08-02T02:00:00.000Z";
  f.setNow(dueAt);
  let writerCalls = 0;
  const unrelated = evidence();
  unrelated.id = "fact:compound:tvl";
  unrelated.subject = "Compound";
  unrelated.source = { ...unrelated.source, observedAt: dueAt };
  unrelated.providerHealth = { ...unrelated.providerHealth, checkedAt: dueAt };
  unrelated.freshness = { ...unrelated.freshness, measuredAt: dueAt, ageMs: 0, state: "fresh" };
  const text = "Compound의 TVL은 2026-08-02 02:00 UTC 기준 24시간 동안 +8.4% 늘었다. 아직 한 번의 관측이라 더 큰 서사는 보류한다. 72시간 뒤 같은 지표의 관측값이 기준 미만이면 이 판정을 철회한다.";
  const result = await collectEditorialDraftV2({
    store: f.store,
    metricLogPath: f.metrics,
    mode: "observe",
    now: new Date(dueAt),
    sensing: sensing([unrelated]),
    writerModel: {
      async generate() {
        writerCalls += 1;
        return JSON.stringify({
          draft: text,
          usedFactIds: [unrelated.id],
          claims: claimsFor(text, unrelated.id),
        });
      },
    },
  });
  assert.equal(result.status, "drafted");
  assert.equal(writerCalls, 1);
  assert.equal(f.store.getDraftState("original")?.followUps.length, 0);
  assert.match(fs.readFileSync(f.metrics, "utf8"), /"outcome":"deferred","reason":"followup-observation-unavailable"/);
});

test("a first run at 72h records a missed 24h checkpoint without using the late value", async () => {
  const f = publishedFollowUpFixture();
  const after72 = "2026-08-04T02:00:00.000Z";
  f.setNow(after72);
  const observation = followUpObservation(after72);
  await collectEditorialDraftV2({
    store: f.store,
    metricLogPath: f.metrics,
    mode: "observe",
    now: new Date(after72),
    sensing: sensing([], [observation]),
    writerModel: { async generate() { return null; } },
  });
  const followUps = f.store.getDraftState("original")?.followUps;
  assert.deepEqual(followUps?.map((row) => row.checkpoint), ["24h", "72h"]);
  assert.equal(followUps?.[0]?.reason, "checkpoint-window-missed");
  assert.equal(followUps?.[0]?.observedValue, undefined);
});

test("72h closes the ledger but stays publicly silent without a meaningful change", async () => {
  const f = publishedFollowUpFixture();
  const after72 = "2026-08-04T02:00:00.000Z";
  f.setNow(after72);
  let writerCalls = 0;
  const result = await collectEditorialDraftV2({
    store: f.store,
    metricLogPath: f.metrics,
    mode: "observe",
    now: new Date(after72),
    sensing: sensing([], [followUpObservation(after72, 107_000_000)]),
    writerModel: { async generate() { writerCalls += 1; throw new Error("must stay silent"); } },
  });
  assert.equal(result.status, "no-post");
  assert.equal(writerCalls, 0);
  const followUps = f.store.getDraftState("original")?.followUps;
  assert.deepEqual(followUps?.map((row) => [row.checkpoint, row.resolution]), [
    ["24h", "silent"],
    ["72h", "supported"],
  ]);
});
