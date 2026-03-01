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
        content: "빌더 관점에서 보면 오늘 포인트는 latency 개선.",
        timestamp: nowIso,
        meta: { lane: "protocol", narrativeMode: "builder-note" },
      },
      {
        content: "프로덕트 관점으로 번역하면 핵심은 실행 속도.",
        timestamp: nowIso,
        meta: { lane: "protocol", narrativeMode: "builder-note" },
      },
    ],
  });

  assert.notEqual(plan.mode, "builder-note");
  assert.equal(plan.lane, "protocol");
});

test("validateNarrativeNovelty rejects repeated opening pattern", () => {
  const plan = buildNarrativePlan({
    eventPlan: baseEventPlan(),
    language: "ko",
    recentPosts: [
      {
        content: "오늘 타임라인에서 가장 크게 튄 건 Solana Firedancer 업데이트.",
        timestamp: nowIso,
      },
    ],
  });

  const result = validateNarrativeNovelty(
    "오늘 타임라인에서 가장 크게 튄 건 Solana validator 성능 회복 신호.",
    [
      {
        content: "오늘 타임라인에서 가장 크게 튄 건 Solana Firedancer 업데이트.",
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
        content: "Field note for today: one macro shock and one liquidity response.",
        timestamp: nowIso,
      },
    ],
  });

  const result = validateNarrativeNovelty(
    "From a builder lens, Firedancer progress changes validator behavior before it changes price.",
    [
      {
        content: "Field note for today: one macro shock and one liquidity response.",
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
        content: "지금 시장에서 제일 시끄러운 신호 하나만 집으면 솔라나 TPS 개선.",
        timestamp: nowIso,
      },
      {
        content: "오늘 관찰 일지에서 눈에 띈 건 수수료 압력 둔화.",
        timestamp: nowIso,
      },
    ],
  });

  const result = validateNarrativeNovelty(
    "지금 시장에서 제일 시끄러운 신호 하나만 집으면 검증 포인트는 체인별 유동성 전이.",
    [
      {
        content: "빌더 관점에서 보면 오늘 포인트는 사용자 체감 지연 개선.",
        timestamp: nowIso,
      },
    ],
    plan
  );

  assert.equal(result.ok, true);
  assert.ok(result.score >= 0.62);
});
