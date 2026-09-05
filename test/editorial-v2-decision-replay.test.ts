import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { planEditorialV2 } from "../src/services/editorial-v2/planner.ts";
import { readEditorialDecisionContextV2, replayEditorialDecisionV2, writeEditorialDecisionContextV2, type EditorialDecisionContextV2 } from "../src/services/editorial-v2/decision-replay.ts";
import type { EvidenceCardV2 } from "../src/services/editorial-v2/evidence.ts";
import { splitEditorialSentencesV2 } from "../src/services/editorial-v2/validator.ts";
import { inquiryModelFixture } from "./helpers/editorial-inquiry.ts";

test("decision replay captures no-post inputs, preserves clock/seed, and rejects overwritten input", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-decision-replay-"));
  try {
    const planningInput = { evidence: [], now: "2026-09-05T00:00:00.000Z", selectionSeed: "fixed-seed" };
    const context: EditorialDecisionContextV2 = {
      kind: "pixymon-decision-context", version: 1, actionId: "no-facts", trackingMode: "shadow",
      revision: { commit: "a".repeat(40), dirty: false }, modelId: "test", writerVersion: "hypothesis-writer-v2",
      planningInput, memories: {}, capturedPlanning: planEditorialV2(planningInput),
    };
    const file = writeEditorialDecisionContextV2(dir, context);
    assert.throws(() => writeEditorialDecisionContextV2(dir, context), /EEXIST/);
    const loaded = readEditorialDecisionContextV2(file);
    assert.deepEqual(loaded, context);
    let modelCalls = 0;
    const model = { async generate() { modelCalls += 1; return null; } };
    const baseline = await replayEditorialDecisionV2({ context: loaded, model, variant: "captured-plan" });
    for (let index = 0; index < 100; index++) {
      assert.deepEqual(await replayEditorialDecisionV2({ context: loaded, model, variant: "current-plan" }), baseline);
    }
    assert.equal(modelCalls, 0);
    const modified = JSON.parse(fs.readFileSync(file, "utf8"));
    modified.context.planningInput.selectionSeed = "changed";
    fs.writeFileSync(file, JSON.stringify(modified));
    assert.throws(() => readEditorialDecisionContextV2(file), /digest/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("same-context replay compares legacy writing with inquiry-first writing without changing its inputs", async () => {
  const now = "2026-08-28T09:30:00.000Z";
  const evidence: EvidenceCardV2 = {
    schemaVersion: 2, id: "fact:aave", subject: "Aave", lane: "protocol", kind: "signal",
    metric: { name: "tvl-change-24h", value: 8.4, raw: "+8.4%", unit: "%", period: "24h" },
    followUp: { metric: { name: "tvl-usd", value: 108.4, raw: "$108.4", unit: "USD", period: "snapshot" }, comparator: "lte", threshold: 100 },
    source: { provider: "defillama", url: "https://api.llama.fi/protocols", publishedAt: null, observedAt: now, origin: "direct", role: "primary" },
    freshness: { kind: "signal", measuredAt: now, maxAgeMs: 7_200_000, ageMs: 0, state: "fresh" },
    providerHealth: { provider: "defillama", state: "green", reason: "ok", checkedAt: now, latencyMs: 1, itemCount: 1 },
    provenance: { kind: "onchain-nutrient", sourceId: "aave" },
  };
  const planningInput = { evidence: [evidence], now, selectionSeed: "fixed" };
  const context: EditorialDecisionContextV2 = {
    kind: "pixymon-decision-context", version: 1, actionId: "same-facts", trackingMode: "shadow",
    revision: { commit: "a".repeat(40), dirty: false }, modelId: "fixture-writer", writerVersion: "hypothesis-writer-v2",
    planningInput, memories: {}, capturedPlanning: planEditorialV2(planningInput),
  };
  const snapshot = structuredClone(context);
  const prompts: string[] = [];
  const draft = "Aave의 TVL은 8월 28일 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 이 한 번의 수치는 기록하되, 더 큰 회복 서사까지 승인하진 않는다는 판단이다.";
  const model = { async generate({ prompt }: { prompt: string }) {
    prompts.push(prompt);
    return JSON.stringify({ draft, usedFactIds: [evidence.id], claims: splitEditorialSentencesV2(draft).map((text, index) => ({
      kind: index === 0 ? "observation" : "judgment", text, factIds: [evidence.id],
    })) });
  } };
  let inquiryCalls = 0;
  const inquiryModel = { async generate(input: Parameters<typeof inquiryModelFixture.generate>[0]) {
    inquiryCalls++;
    return inquiryModelFixture.generate(input);
  } };
  const baseline = await replayEditorialDecisionV2({ context, model, inquiryModel, variant: "captured-plan" });
  const current = await replayEditorialDecisionV2({ context, model, inquiryModel, variant: "current-plan" });
  assert.ok("writing" in baseline && baseline.writing.status === "generated");
  assert.ok("writing" in current && current.writing.status === "generated");
  assert.equal(inquiryCalls, 1);
  assert.match(prompts[0], /이번 탐구: null/);
  assert.match(prompts[1], /whyThisEvidence/);
  assert.deepEqual(context, snapshot);
  const expected = { status: "no-post", stage: "inquiry", reason: "inquiry-model-required" };
  assert.deepEqual(await replayEditorialDecisionV2({ context, model, variant: "current-plan" }), expected);
  assert.deepEqual(await replayEditorialDecisionV2({
    context: { ...context, writerVersion: "inquiry-writer-v3" }, model, variant: "captured-plan",
  }), expected);
  assert.equal(prompts.length, 2);
});
