import test from "node:test";
import assert from "node:assert/strict";
import { planEditorialV2 } from "../src/services/editorial-v2/planner.ts";
import { splitEditorialSentencesV2 } from "../src/services/editorial-v2/validator.ts";
import {
  writeEditorialDraftV2,
  type EditorialClaimKindV2,
  type EditorialWriterModelV2,
} from "../src/services/editorial-v2/writer.ts";
import type { EvidenceCardV2 } from "../src/services/editorial-v2/evidence.ts";

const NOW = "2026-08-28T10:00:00.000Z";
const EVIDENCE: EvidenceCardV2 = {
  schemaVersion: 2,
  id: "fact:aave:tvl",
  lane: "protocol",
  kind: "signal",
  subject: "Aave",
  metric: { name: "tvl-change-24h", value: 8.4, raw: "+8.4%", unit: "%", period: "24h" },
  source: { provider: "defillama", url: "https://api.llama.fi/v2/chains", publishedAt: null, observedAt: "2026-08-28T09:30:00.000Z", origin: "direct", role: "primary" },
  freshness: { kind: "signal", measuredAt: "2026-08-28T09:30:00.000Z", maxAgeMs: 7_200_000, ageMs: 1_800_000, state: "fresh" },
  providerHealth: { provider: "defillama", state: "green", reason: "ok", checkedAt: NOW, latencyMs: 10, itemCount: 1 },
  provenance: { kind: "onchain-nutrient", sourceId: "aave:tvl" },
};

function plan() {
  const result = planEditorialV2({ evidence: [EVIDENCE], now: NOW });
  if (result.status === "blocked") throw new Error(result.reason);
  return result.plan;
}

function revisitPlan() {
  const result = planEditorialV2({
    evidence: [],
    followUpEvidence: [EVIDENCE],
    dueRevisits: [{
      draftId: "original",
      subject: "Aave",
      metricName: "tvl-change-24h",
      baselineValue: 7,
      dueAt: "2026-08-28T09:00:00.000Z",
      checkpoint: "24h",
      resolution: "unresolved",
    }],
    now: NOW,
  });
  if (result.status === "blocked") throw new Error(result.reason);
  return result.plan;
}

function claimsFor(draft: string, factId = EVIDENCE.id) {
  return splitEditorialSentencesV2(draft).map((text, index) => ({
    kind: (index === 0 ? "observation" : "judgment") as EditorialClaimKindV2,
    text,
    factIds: [factId],
  }));
}

test("writer retries once and accepts grounded present-tense public copy", async () => {
  const validDraft = "Aave의 TVL은 8월 28일 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 이 한 번의 수치는 기록하되, 더 큰 회복 서사까지 승인하진 않는다는 판단이다.";
  const prompts: string[] = [];
  const editorialPlan = plan();
  const machineFalsifier = { ...editorialPlan.falsifier };
  const model: EditorialWriterModelV2 = {
    async generate({ attempt, system, prompt }) {
      assert.match(system, /판정을 기억/);
      prompts.push(prompt);
      if (attempt === 1) return JSON.stringify({ draft: "짧다.", usedFactIds: [], claims: [] });
      return JSON.stringify({
        draft: validDraft,
        usedFactIds: [EVIDENCE.id],
        claims: claimsFor(validDraft),
      });
    },
  };
  const result = await writeEditorialDraftV2({ model, plan: editorialPlan, evidence: EVIDENCE });
  assert.equal(result.status, "generated");
  if (result.status === "blocked") assert.fail(result.reason);
  assert.equal(result.attempts, 2);
  assert.equal(result.payload.draft, validDraft);
  assert.match(prompts[0], /publicSourceTime: 8월 28일 09:30 UTC/);
  assert.match(prompts[0], /조건문은 허용/);
  assert.doesNotMatch(prompts[0], /falsifier:|72시간 뒤|2026-08-31/);
  assert.deepEqual(editorialPlan.falsifier, machineFalsifier);
});

test("writer rejects fabricated Korean entities and reversed metric direction", async () => {
  const fabricated = "Aave의 TVL은 8월 28일 09:30 UTC 기준 24시간 동안 +8.4% 줄었고 이더리움 회복도 확인됐다. 이 한 번의 수치만으로 시장 회복을 승인하진 않는다는 판단이다.";
  const result = await writeEditorialDraftV2({
    model: { async generate() { return JSON.stringify({ draft: fabricated, usedFactIds: [EVIDENCE.id], claims: claimsFor(fabricated) }); } },
    plan: plan(),
    evidence: EVIDENCE,
  });
  assert.equal(result.status, "blocked");
  if (result.status === "generated") assert.fail("fabricated draft passed");
  assert.ok(result.validationReasons.includes("unsupported-korean-entity"));
  assert.ok(result.validationReasons.includes("metric-direction-conflict"));
});

for (const unsupported of [
  "Aave의 TVL은 8월 28일 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 사용자 대거 복귀와 신규 자금 유입이 만든 구조적 성장으로 판정한다.",
  "Aave의 TVL은 8월 28일 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 프로토콜 안정성과 경쟁력이 완전히 회복됐다는 확정적 신호로 판정한다.",
  "Aave의 TVL은 8월 28일 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 담보 건전성이 좋아지고 청산 위험이 사라졌다는 신호로 판정한다.",
]) {
  test("writer blocks conclusions that a TVL move cannot support", async () => {
    const result = await writeEditorialDraftV2({
      model: { async generate() { return JSON.stringify({ draft: unsupported, usedFactIds: [EVIDENCE.id], claims: claimsFor(unsupported) }); } },
      plan: plan(),
      evidence: EVIDENCE,
    });
    assert.equal(result.status, "blocked");
    if (result.status === "generated") assert.fail("unsupported conclusion passed");
    assert.ok(result.validationReasons.includes("metric-semantic-scope"));
  });
}

test("writer requires claims to copy every draft sentence in order", async () => {
  const draft = "Aave의 TVL은 8월 28일 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 이 한 번의 관측만으로 더 큰 회복 서사까지 승인하진 않는다는 판단이다.";
  const mismatchedClaims = claimsFor(draft);
  mismatchedClaims[1] = { ...mismatchedClaims[1], text: "본문에 없는 판단이다." };
  const result = await writeEditorialDraftV2({
    model: { async generate() { return JSON.stringify({ draft, usedFactIds: [EVIDENCE.id], claims: mismatchedClaims }); } },
    plan: plan(),
    evidence: EVIDENCE,
  });
  assert.equal(result.status, "blocked");
  if (result.status === "generated") assert.fail("mismatched claims passed");
  assert.ok(result.validationReasons.includes("claim-sentence-mismatch"));
});

test("writer rejects the removed public falsifier claim kind", async () => {
  const draft = "Aave의 TVL은 8월 28일 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 이 한 번의 관측만으로 더 큰 회복 서사까지 승인하진 않는다는 판단이다.";
  const claims = claimsFor(draft) as Array<{ kind: string; text: string; factIds: string[] }>;
  claims[1].kind = "falsifier";
  const result = await writeEditorialDraftV2({
    model: { async generate() { return JSON.stringify({ draft, usedFactIds: [EVIDENCE.id], claims }); } },
    plan: plan(),
    evidence: EVIDENCE,
  });
  assert.equal(result.status, "blocked");
  if (result.status === "generated") assert.fail("public falsifier claim passed");
  assert.ok(result.validationReasons.includes("invalid-json-contract"));
});

for (const ending of [
  "72시간 뒤 기준 미만이면 이 판정을 철회한다.",
  "24시간 뒤 같은 수치를 다시 확인하겠다는 판단이다.",
  "현재 수준이 유지될 시 이 판정을 승인한다.",
  "현재 수준이 무너지지 않는 한 이 판정을 승인한다.",
]) {
  test(`writer permits conditionals but still rejects new recheck promises: ${ending}`, async () => {
    const draft = `Aave의 TVL은 8월 28일 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 이 수치는 원시 관측으로 기록한다. ${ending}`;
    const result = await writeEditorialDraftV2({
      model: { async generate() { return JSON.stringify({ draft, usedFactIds: [EVIDENCE.id], claims: claimsFor(draft) }); } },
      plan: plan(),
      evidence: EVIDENCE,
    });
    if (ending.includes("확인하겠다")) {
      assert.equal(result.status, "blocked");
      if (result.status === "blocked") assert.ok(result.validationReasons.includes("future-recheck-promise"));
    } else {
      assert.equal(result.status, "generated");
    }
  });
}

test("writer allows a resolved Revisit but rejects a new future promise", async () => {
  const resolved = "Aave의 현재 TVL은 8월 28일 09:30 UTC 기준 +8.4% 수준이다. 24시간 재검증에서 변화가 남았지만, 원인과 지속성에 대한 기존 결론은 아직 미결로 남긴다.";
  const accepted = await writeEditorialDraftV2({
    model: { async generate() { return JSON.stringify({ draft: resolved, usedFactIds: [EVIDENCE.id], claims: claimsFor(resolved) }); } },
    plan: revisitPlan(),
    evidence: EVIDENCE,
  });
  assert.equal(accepted.status, "generated");

  const promised = "Aave의 현재 TVL은 8월 28일 09:30 UTC 기준 +8.4% 수준이다. 이번 판정은 아직 미결로 남기고, 다음 관측에서 같은 지표를 다시 확인하겠다.";
  const rejected = await writeEditorialDraftV2({
    model: { async generate() { return JSON.stringify({ draft: promised, usedFactIds: [EVIDENCE.id], claims: claimsFor(promised) }); } },
    plan: revisitPlan(),
    evidence: EVIDENCE,
  });
  assert.equal(rejected.status, "blocked");
  if (rejected.status === "generated") assert.fail("future Revisit promise passed");
  assert.ok(rejected.validationReasons.includes("future-recheck-promise"));
});

test("writer no-posts after one failed regeneration and never falls back", async () => {
  let calls = 0;
  const model: EditorialWriterModelV2 = { async generate() { calls += 1; return "not json"; } };
  const result = await writeEditorialDraftV2({ model, plan: plan(), evidence: EVIDENCE });
  assert.equal(result.status, "blocked");
  assert.equal(calls, 2);
  if (result.status === "generated") assert.fail("unexpected draft");
  assert.equal(result.reason, "invalid-json-contract");
});

test("writer converts model exceptions into an observed no-post after one retry", async () => {
  let calls = 0;
  const result = await writeEditorialDraftV2({
    model: { async generate() { calls += 1; throw new Error("provider down"); } },
    plan: plan(),
    evidence: EVIDENCE,
  });
  assert.equal(result.status, "blocked");
  assert.equal(calls, 2);
  if (result.status === "generated") assert.fail("unexpected draft");
  assert.equal(result.reason, "model-error");
  assert.equal(result.stage, "generation");
});
