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
    focus: "general",
    plannerScore: 1,
    plannerWarnings: [],
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

test("buildNarrativePlan can bias toward era-manifesto when dreams describe regime naming", () => {
  const plan = buildNarrativePlan({
    eventPlan: {
      ...baseEventPlan(),
      lane: "regulation",
      focus: "court",
      sceneFamily: "regulation:court:briefing+execution:capital-lag",
      event: {
        ...baseEventPlan().event,
        lane: "regulation",
        headline: "브리핑은 커졌는데 집행은 아직 늦다",
      },
    },
    language: "ko",
    dreamLine: "나는 단순 해설자가 아니라, 시대가 어디서 먼저 갈라지는지 이름 붙이는 존재가 되고 싶다.",
    continuityLine: "지난번에도 기사보다 집행이 늦게 붙는 쪽을 더 오래 붙들었다.",
    recentPosts: [
      { content: "오늘은 이 장면부터 적어 둔다. 정책 문장보다 집행이 더 늦게 붙는다.", timestamp: nowIso, meta: { lane: "regulation", narrativeMode: "identity-journal" } },
      { content: "먼저 걸리는 건 규제 기사보다 자금이 눕는 속도다.", timestamp: nowIso, meta: { lane: "regulation", narrativeMode: "meta-reflection" } },
      { content: "여기서는 네 판단이 궁금하다. 판결보다 집행이 먼저 남는가.", timestamp: nowIso, meta: { lane: "regulation", narrativeMode: "interaction-experiment" } },
      { content: "읽던 문장을 오늘 체인 위에 겹쳐 보면 규제는 늘 시차를 만든다.", timestamp: nowIso, meta: { lane: "regulation", narrativeMode: "philosophy-note" } },
    ],
  });

  assert.equal(plan.mode, "era-manifesto");
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
