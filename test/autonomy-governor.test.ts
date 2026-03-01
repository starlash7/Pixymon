import test from "node:test";
import assert from "node:assert/strict";
import { evaluateAutonomyGovernor } from "../src/services/autonomy-governor.ts";

function buildBaseInput() {
  const now = new Date().toISOString();
  return {
    timezone: "Asia/Seoul",
    postText:
      "오늘 핵심은 Solana Firedancer 테스트넷 마일스톤. 근거는 Validator queue 정상화와 온체인 활동 증가 +12%.",
    trendSummary: "Protocol upgrades and validator performance moved higher.",
    eventPlan: {
      lane: "protocol" as const,
      event: {
        id: "event-1",
        lane: "protocol" as const,
        headline: "Solana Firedancer testnet milestone reached",
        summary: "Validator performance improved this cycle.",
        source: "news:coindesk",
        trust: 0.82,
        freshness: 0.9,
        capturedAt: now,
        keywords: ["solana", "firedancer", "validator"],
      },
      evidence: [
        {
          id: "ev1",
          lane: "protocol" as const,
          nutrientId: "n1",
          source: "news" as const,
          label: "Firedancer benchmark",
          value: "+18%",
          summary: "Benchmark throughput rose by 18%.",
          trust: 0.78,
          freshness: 0.88,
          capturedAt: now,
        },
        {
          id: "ev2",
          lane: "onchain" as const,
          nutrientId: "n2",
          source: "onchain" as const,
          label: "Validator queue",
          value: "stable",
          summary: "Queue pressure normalized.",
          trust: 0.76,
          freshness: 0.86,
          capturedAt: now,
        },
      ],
      hasOnchainEvidence: true,
      hasCrossSourceEvidence: true,
      evidenceSourceDiversity: 2,
      laneUsage: {
        totalPosts: 3,
        byLane: {
          protocol: 1,
          ecosystem: 0,
          regulation: 0,
          macro: 1,
          onchain: 1,
          "market-structure": 0,
        },
      },
      laneProjectedRatio: 0.5,
      laneQuotaLimited: false,
    },
    runtimeSettings: {
      postGenerationMaxAttempts: 2,
      postMaxChars: 220,
      postMinLength: 20,
      postMinIntervalMinutes: 90,
      maxPostsPerCycle: 1,
      nutrientMinDigestScore: 0.5,
      nutrientMaxIntakePerCycle: 12,
      sentimentMaxRatio24h: 0.25,
      postLanguage: "ko" as const,
      replyLanguageMode: "match" as const,
      requireOnchainEvidence: true,
      requireCrossSourceEvidence: true,
      enforceKoreanPosts: true,
      autonomyMaxBudgetUtilization: 0.92,
      autonomyRiskBlockScore: 7,
      minNewsSourceTrust: 0.28,
      minTrendTweetSourceTrust: 0.24,
      minTrendTweetScore: 3.2,
      minTrendTweetEngagement: 6,
      topicMaxSameTag24h: 2,
      topicBlockConsecutiveTag: true,
    },
    xApiCostSettings: {
      enabled: true,
      dailyMaxUsd: 0.1,
      estimatedReadCostUsd: 0.012,
      estimatedCreateCostUsd: 0.01,
      dailyReadRequestLimit: 8,
      dailyCreateRequestLimit: 10,
      mentionReadMinIntervalMinutes: 120,
      trendReadMinIntervalMinutes: 180,
      createMinIntervalMinutes: 20,
    },
    currentUsage: {
      estimatedTotalCostUsd: 0.03,
      readRequests: 2,
      createRequests: 2,
    },
  };
}

test("autonomy governor blocks non-korean post when korean policy is enforced", () => {
  const input = buildBaseInput();
  input.postText = "Solana milestone today, validator queue normalized and liquidity improved.";
  const decision = evaluateAutonomyGovernor(input);
  assert.equal(decision.allow, false);
  assert.equal(decision.level, "block");
  assert.ok(decision.reasons.includes("post_language_not_korean"));
});

test("autonomy governor blocks budget overflow before create dispatch", () => {
  const input = buildBaseInput();
  input.runtimeSettings.autonomyMaxBudgetUtilization = 0.85;
  input.currentUsage.estimatedTotalCostUsd = 0.09;
  const decision = evaluateAutonomyGovernor(input);
  assert.equal(decision.allow, false);
  assert.equal(decision.level, "block");
  assert.ok(decision.reasons.some((reason) => reason.startsWith("budget_utilization_exceeded")));
});

test("autonomy governor warns on high risk narrative without assertive claim", () => {
  const input = buildBaseInput();
  input.trendSummary = "해킹 이슈와 대규모 청산 이벤트가 동시 발생.";
  input.postText =
    "해킹 이슈와 청산 압력이 커졌지만, 오늘은 방향 단정 대신 유동성 회복 여부를 먼저 확인하겠다.";
  const decision = evaluateAutonomyGovernor(input);
  assert.equal(decision.allow, true);
  assert.equal(decision.level, "warn");
  assert.ok(decision.reasons.some((reason) => reason.startsWith("risk_high_watch")));
});
