import test from "node:test";
import assert from "node:assert/strict";
import { buildNarrativePlan, validateNarrativeNovelty } from "../src/services/narrative-os.ts";

const nowIso = new Date().toISOString();

function baseEventPlan() {
  return {
    lane: "protocol" as const,
    event: {
      id: "event:protocol:1",
      lane: "protocol" as const,
      headline: "Solana Firedancer testnet milestone reached",
      summary: "Validator throughput improved in latest tests",
      source: "news:coindesk",
      trust: 0.82,
      freshness: 0.91,
      capturedAt: nowIso,
      keywords: ["solana", "firedancer", "testnet"],
    },
    evidence: [
      {
        id: "ev:1",
        lane: "protocol" as const,
        nutrientId: "n:1",
        source: "news" as const,
        label: "Firedancer benchmark",
        value: "+18%",
        summary: "Benchmark throughput rose by 18%",
        trust: 0.77,
        freshness: 0.88,
        capturedAt: nowIso,
      },
      {
        id: "ev:2",
        lane: "onchain" as const,
        nutrientId: "n:2",
        source: "onchain" as const,
        label: "Validator queue",
        value: "stable",
        summary: "Queue pressure normalized",
        trust: 0.74,
        freshness: 0.86,
        capturedAt: nowIso,
      },
    ],
    hasOnchainEvidence: true,
    hasCrossSourceEvidence: true,
    evidenceSourceDiversity: 2,
    laneUsage: {
      totalPosts: 4,
      byLane: {
        protocol: 1,
        ecosystem: 1,
        regulation: 0,
        macro: 1,
        onchain: 1,
        "market-structure": 0,
      },
    },
    laneProjectedRatio: 0.4,
    laneQuotaLimited: false,
  };
}

test("buildNarrativePlan rotates mode away from overused mode", () => {
  const plan = buildNarrativePlan({
    eventPlan: baseEventPlan(),
    language: "ko",
    recentPosts: [
      {
        content: "철학 노트로 번역하면 오늘 장면은 검증자 행동 변화.",
        timestamp: nowIso,
        meta: { lane: "protocol", narrativeMode: "philosophy-note" },
      },
      {
        content: "읽던 문장을 체인 위로 옮기면 합의 지연은 신뢰 비용.",
        timestamp: nowIso,
        meta: { lane: "protocol", narrativeMode: "philosophy-note" },
      },
    ],
  });

  assert.notEqual(plan.mode, "philosophy-note");
  assert.equal(plan.lane, "protocol");
});

test("buildNarrativePlan defaults protocol posts away from philosophy-heavy mode", () => {
  const plan = buildNarrativePlan({
    eventPlan: baseEventPlan(),
    language: "ko",
    recentPosts: [],
  });

  assert.ok(["identity-journal", "meta-reflection"].includes(plan.mode));
});

test("validateNarrativeNovelty rejects repeated opening pattern", () => {
  const plan = buildNarrativePlan({
    eventPlan: baseEventPlan(),
    language: "ko",
    recentPosts: [
      {
        content: "오늘 픽시몬 일지 첫 줄은 오늘도 Firedancer 속도 변화다.",
        timestamp: nowIso,
      },
    ],
  });

  const result = validateNarrativeNovelty(
    "오늘 픽시몬 일지 첫 줄은 오늘도 Firedancer 속도 변화다.",
    [
      {
        content: "오늘 픽시몬 일지 첫 줄은 오늘도 Firedancer 속도 변화다.",
        timestamp: nowIso,
      },
    ],
    plan
  );

  assert.equal(result.ok, false);
  assert.equal(typeof result.reason, "string");
  assert.equal(typeof result.score, "number");
  assert.ok(result.score < 0.62);
});

test("validateNarrativeNovelty passes distinct narrative structure", () => {
  const plan = buildNarrativePlan({
    eventPlan: baseEventPlan(),
    language: "en",
    recentPosts: [
      {
        content: "Meta reflection first: one macro shock and one liquidity response.",
        timestamp: nowIso,
      },
    ],
  });

  const result = validateNarrativeNovelty(
    "Philosophy note, translated onchain: Firedancer progress shifts validator behavior before headline consensus forms.",
    [
      {
        content: "Meta reflection first: one macro shock and one liquidity response.",
        timestamp: nowIso,
      },
    ],
    plan
  );

  assert.equal(result.ok, true);
  assert.ok(result.score >= 0.62);
});

test("validateNarrativeNovelty applies soft penalty for banned opener only", () => {
  const plan = buildNarrativePlan({
    eventPlan: baseEventPlan(),
    language: "ko",
    recentPosts: [
      {
        content: "오늘 픽시몬 일지 첫 줄은 솔라나 TPS 개선이다.",
        timestamp: nowIso,
      },
      {
        content: "짧은 우화로 남기면 수수료 압력 둔화는 조용한 선택이다.",
        timestamp: nowIso,
      },
    ],
  });

  const result = validateNarrativeNovelty(
    "오늘 픽시몬 일지 첫 줄은 검증 포인트가 체인별 유동성 전이라는 사실이다.",
    [
      {
        content: "철학 노트로 번역하면 사용자 체감 지연은 신뢰 문제다.",
        timestamp: nowIso,
      },
    ],
    plan
  );

  assert.equal(result.ok, true);
  assert.ok(result.score >= 0.62);
});
