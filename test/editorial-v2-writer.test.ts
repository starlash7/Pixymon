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

function claimsFor(draft: string, factId = EVIDENCE.id) {
  return splitEditorialSentencesV2(draft).map((text, index) => ({
    kind: (index === 0
      ? "observation"
      : /(?:으)?면|경우/u.test(text) ? "falsifier" : "judgment") as EditorialClaimKindV2,
    text,
    factIds: [factId],
  }));
}

test("writer retries once and accepts only a grounded structured draft", async () => {
  const validDraft = "Aave의 TVL은 2026-08-28 09:30 UTC 기준 24시간 동안 +8.4% 늘었지만, 바로 승인하진 않겠다. 72시간 뒤 같은 지표의 관측값이 기준 미만이면 이 판정을 철회한다.";
  const prompts: string[] = [];
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
  const result = await writeEditorialDraftV2({ model, plan: plan(), evidence: EVIDENCE });
  assert.equal(result.status, "generated");
  if (result.status === "blocked") assert.fail(result.reason);
  assert.equal(result.attempts, 2);
  assert.equal(result.payload.draft, validDraft);
  assert.match(prompts[0], /publicSourceTime: 2026-08-28 09:30 UTC/);
  assert.match(prompts[0], /formatGuide:/);
});

test("writer rejects fabricated Korean entities and reversed metric direction", async () => {
  const fabricated = "Aave의 TVL은 2026-08-28 09:30 UTC 기준 24시간 동안 +8.4% 줄었고 이더리움 회복도 확인됐다. 72시간 뒤에도 같으면 판정을 승인하겠다.";
  const result = await writeEditorialDraftV2({
    model: {
      async generate() {
        return JSON.stringify({
          draft: fabricated,
          usedFactIds: [EVIDENCE.id],
          claims: claimsFor(fabricated),
        });
      },
    },
    plan: plan(),
    evidence: EVIDENCE,
  });
  assert.equal(result.status, "blocked");
  if (result.status === "generated") assert.fail("fabricated draft passed");
  assert.ok(result.validationReasons.includes("unsupported-korean-entity"));
  assert.ok(result.validationReasons.includes("metric-direction-conflict"));
});

test("writer blocks causal claims that a TVL change cannot support", async () => {
  const unsupported = "Aave의 TVL은 2026-08-28 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 사용자 대거 복귀와 신규 자금 유입이 만든 구조적 성장으로 판정한다.";
  const result = await writeEditorialDraftV2({
    model: {
      async generate() {
        return JSON.stringify({
          draft: unsupported,
          usedFactIds: [EVIDENCE.id],
          claims: claimsFor(unsupported),
        });
      },
    },
    plan: plan(),
    evidence: EVIDENCE,
  });
  assert.equal(result.status, "blocked");
  if (result.status === "generated") assert.fail("unsupported causal draft passed");
  assert.ok(result.validationReasons.includes("metric-semantic-scope"));
});

test("writer blocks unsupported protocol-quality conclusions from a TVL move", async () => {
  const unsupported = "Aave의 TVL은 2026-08-28 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 프로토콜의 안정성과 경쟁력이 완전히 회복됐다는 확정적 신호로 판정한다.";
  const result = await writeEditorialDraftV2({
    model: {
      async generate() {
        return JSON.stringify({
          draft: unsupported,
          usedFactIds: [EVIDENCE.id],
          claims: claimsFor(unsupported),
        });
      },
    },
    plan: plan(),
    evidence: EVIDENCE,
  });
  assert.equal(result.status, "blocked");
  if (result.status === "generated") assert.fail("unsupported quality conclusion passed");
  assert.ok(result.validationReasons.includes("metric-semantic-scope"));
});

test("writer blocks unsupported collateral-health conclusions from a TVL move", async () => {
  const unsupported = "Aave의 TVL은 2026-08-28 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 담보 건전성이 좋아지고 청산 위험이 사라졌다는 신호로 판정한다.";
  const result = await writeEditorialDraftV2({
    model: {
      async generate() {
        return JSON.stringify({
          draft: unsupported,
          usedFactIds: [EVIDENCE.id],
          claims: claimsFor(unsupported),
        });
      },
    },
    plan: plan(),
    evidence: EVIDENCE,
  });
  assert.equal(result.status, "blocked");
  if (result.status === "generated") assert.fail("unsupported collateral conclusion passed");
  assert.ok(result.validationReasons.includes("metric-semantic-scope"));
});

test("writer requires claims to copy every draft sentence in order", async () => {
  const draft = "Aave의 TVL은 2026-08-28 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 이 한 번의 관측만으로 더 큰 서사를 승인하진 않는다.";
  const mismatchedClaims = claimsFor(draft);
  mismatchedClaims[1] = { ...mismatchedClaims[1], text: "본문에 없는 판단이다." };
  const result = await writeEditorialDraftV2({
    model: {
      async generate() {
        return JSON.stringify({ draft, usedFactIds: [EVIDENCE.id], claims: mismatchedClaims });
      },
    },
    plan: plan(),
    evidence: EVIDENCE,
  });
  assert.equal(result.status, "blocked");
  if (result.status === "generated") assert.fail("mismatched claims passed");
  assert.ok(result.validationReasons.includes("claim-sentence-mismatch"));
});

test("writer rejects a falsifier whose explicit direction contradicts the comparator", async () => {
  const draft = "Aave의 TVL은 2026-08-28 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 72시간 뒤 기준 이상으로 늘어나면 이 판정을 철회한다.";
  const result = await writeEditorialDraftV2({
    model: {
      async generate() {
        return JSON.stringify({ draft, usedFactIds: [EVIDENCE.id], claims: claimsFor(draft) });
      },
    },
    plan: plan(),
    evidence: EVIDENCE,
  });
  assert.equal(result.status, "blocked");
  if (result.status === "generated") assert.fail("reversed falsifier passed");
  assert.ok(result.validationReasons.includes("falsifier-direction-mismatch"));
});

for (const clause of [
  "기준 미만이 아니어도",
  "기준 미만을 제외한 값일 경우",
  "기준 미만 범위를 벗어날 때",
  "기준 미만의 반대편에 설 경우",
  "기준 미만일 때를 빼고",
]) {
  test(`writer rejects non-canonical falsifier logic: ${clause}`, async () => {
    const draft = `Aave의 TVL은 2026-08-28 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 이 한 번의 관측만으로 더 큰 서사를 승인하진 않는다. 72시간 뒤 TVL이 ${clause} 이 판정을 철회한다.`;
    const result = await writeEditorialDraftV2({
      model: {
        async generate() {
          return JSON.stringify({ draft, usedFactIds: [EVIDENCE.id], claims: claimsFor(draft) });
        },
      },
      plan: plan(),
      evidence: EVIDENCE,
    });
    assert.equal(result.status, "blocked");
    if (result.status === "generated") assert.fail("non-canonical falsifier passed");
    assert.ok(result.validationReasons.includes("falsifier-language-not-canonical"));
  });
}

for (const draft of [
  "Aave의 TVL은 2026-08-28 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 이 한 번의 관측만으로 더 큰 서사를 승인하진 않는다. 72시간 뒤 TVL 관측값이 기준선을 웃도는 때 이 판정을 철회한다.",
  "Aave의 TVL은 2026-08-28 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 72시간 뒤 기준 이상으로 늘어나면 이 판정을 철회한다. 72시간 뒤 같은 지표의 관측값이 기준 미만이면 이 판정을 철회한다.",
  "Aave의 TVL은 2026-08-28 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 다음 관측값이 기준선을 웃돌 때 이 판정을 폐기한다. 72시간 뒤 같은 지표의 관측값이 기준 미만이면 이 판정을 철회한다.",
  "Aave의 TVL은 2026-08-28 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 사흘 후 수치가 경계보다 높아지면 이 판정을 취소한다. 72시간 뒤 같은 지표의 관측값이 기준 미만이면 이 판정을 철회한다.",
]) {
  test("writer cannot hide an opposite falsifier around the canonical sentence", async () => {
    const result = await writeEditorialDraftV2({
      model: {
        async generate() {
          return JSON.stringify({ draft, usedFactIds: [EVIDENCE.id], claims: claimsFor(draft) });
        },
      },
      plan: plan(),
      evidence: EVIDENCE,
    });
    assert.equal(result.status, "blocked");
    if (result.status === "generated") assert.fail("wrapped falsifier passed");
    assert.ok(result.validationReasons.some((reason) =>
      ["falsifier-language-not-canonical", "falsifier-deadline-not-isolated", "falsifier-condition-outside-final", "falsifier-claim-outside-final", "falsifier-action-outside-final", "falsifier-language-outside-final"].includes(reason)
    ));
  });
}

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
