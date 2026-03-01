import test from "node:test";
import assert from "node:assert/strict";
import { loadRuntimeConfig } from "../src/config/runtime.ts";

function withEnv(
  overrides: Record<string, string | undefined>,
  run: () => void
): void {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (typeof value === "undefined") {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (typeof value === "undefined") {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("loadRuntimeConfig parses engagement and observability settings", () => {
  withEnv(
    {
      SCHEDULER_MODE: "true",
      DAILY_ACTIVITY_TARGET: "24",
      DAILY_TARGET_TIMEZONE: "Asia/Seoul",
      MAX_ACTIONS_PER_CYCLE: "5",
      POST_LANGUAGE: "ko",
      REPLY_LANGUAGE_MODE: "match",
      REQUIRE_ONCHAIN_EVIDENCE: "true",
      REQUIRE_CROSS_SOURCE_EVIDENCE: "true",
      ENFORCE_KOREAN_POSTS: "true",
      AUTONOMY_MAX_BUDGET_UTILIZATION: "0.9",
      AUTONOMY_RISK_BLOCK_SCORE: "8",
      POST_GENERATION_MAX_ATTEMPTS: "2",
      POST_MIN_INTERVAL_MINUTES: "120",
      MAX_POSTS_PER_CYCLE: "1",
      NUTRIENT_MIN_DIGEST_SCORE: "0.62",
      NUTRIENT_MAX_INTAKE_PER_CYCLE: "14",
      SENTIMENT_MAX_RATIO_24H: "0.4",
      TREND_TWEET_MIN_SCORE: "4.4",
      X_API_COST_GUARD_ENABLED: "true",
      X_API_DAILY_MAX_USD: "0.10",
      X_API_ESTIMATED_READ_COST_USD: "0.02",
      X_API_ESTIMATED_CREATE_COST_USD: "0.03",
      X_API_DAILY_READ_REQUEST_LIMIT: "4",
      X_API_DAILY_CREATE_REQUEST_LIMIT: "3",
      X_MENTION_READ_MIN_INTERVAL_MINUTES: "90",
      X_TREND_READ_MIN_INTERVAL_MINUTES: "150",
      X_CREATE_MIN_INTERVAL_MINUTES: "45",
      OBSERVABILITY_ENABLED: "true",
      OBSERVABILITY_STDOUT_JSON: "false",
      OBSERVABILITY_EVENT_LOG_PATH: "data/custom-observability.ndjson",
    },
    () => {
      const config = loadRuntimeConfig();
      assert.equal(config.schedulerMode, true);
      assert.equal(config.dailyActivityTarget, 24);
      assert.equal(config.maxActionsPerCycle, 5);
      assert.equal(config.engagement.postLanguage, "ko");
      assert.equal(config.engagement.replyLanguageMode, "match");
      assert.equal(config.engagement.requireOnchainEvidence, true);
      assert.equal(config.engagement.requireCrossSourceEvidence, true);
      assert.equal(config.engagement.enforceKoreanPosts, true);
      assert.equal(config.engagement.autonomyMaxBudgetUtilization, 0.9);
      assert.equal(config.engagement.autonomyRiskBlockScore, 8);
      assert.equal(config.engagement.postMinIntervalMinutes, 120);
      assert.equal(config.engagement.maxPostsPerCycle, 1);
      assert.equal(config.engagement.nutrientMinDigestScore, 0.62);
      assert.equal(config.engagement.nutrientMaxIntakePerCycle, 14);
      assert.equal(config.engagement.sentimentMaxRatio24h, 0.4);
      assert.equal(config.engagement.minTrendTweetScore, 4.4);
      assert.equal(config.xApiCost.enabled, true);
      assert.equal(config.xApiCost.dailyMaxUsd, 0.1);
      assert.equal(config.xApiCost.estimatedReadCostUsd, 0.02);
      assert.equal(config.xApiCost.estimatedCreateCostUsd, 0.03);
      assert.equal(config.xApiCost.dailyReadRequestLimit, 4);
      assert.equal(config.xApiCost.dailyCreateRequestLimit, 3);
      assert.equal(config.xApiCost.mentionReadMinIntervalMinutes, 90);
      assert.equal(config.xApiCost.trendReadMinIntervalMinutes, 150);
      assert.equal(config.xApiCost.createMinIntervalMinutes, 45);
      assert.equal(config.observability.enabled, true);
      assert.equal(config.observability.stdoutJson, false);
      assert.equal(config.observability.eventLogPath, "data/custom-observability.ndjson");
    }
  );
});

test("loadRuntimeConfig falls back on invalid observability values", () => {
  withEnv(
    {
      OBSERVABILITY_ENABLED: "invalid",
      OBSERVABILITY_STDOUT_JSON: "invalid",
      OBSERVABILITY_EVENT_LOG_PATH: "   ",
      POST_MIN_INTERVAL_MINUTES: "invalid",
      MAX_POSTS_PER_CYCLE: "invalid",
      NUTRIENT_MIN_DIGEST_SCORE: "invalid",
      NUTRIENT_MAX_INTAKE_PER_CYCLE: "invalid",
      SENTIMENT_MAX_RATIO_24H: "invalid",
      X_API_COST_GUARD_ENABLED: "invalid",
      X_API_DAILY_MAX_USD: "invalid",
      X_API_ESTIMATED_READ_COST_USD: "invalid",
      X_API_ESTIMATED_CREATE_COST_USD: "invalid",
      X_API_DAILY_READ_REQUEST_LIMIT: "invalid",
      X_API_DAILY_CREATE_REQUEST_LIMIT: "invalid",
    },
    () => {
      const config = loadRuntimeConfig();
      assert.equal(config.observability.enabled, true);
      assert.equal(config.observability.stdoutJson, true);
      assert.equal(config.observability.eventLogPath, "data/metrics-events.ndjson");
      assert.equal(config.engagement.postMinIntervalMinutes, 90);
      assert.equal(config.engagement.maxPostsPerCycle, 1);
      assert.equal(config.engagement.nutrientMinDigestScore, 0.5);
      assert.equal(config.engagement.nutrientMaxIntakePerCycle, 12);
      assert.equal(config.engagement.sentimentMaxRatio24h, 0.25);
      assert.equal(config.engagement.requireOnchainEvidence, true);
      assert.equal(config.engagement.requireCrossSourceEvidence, true);
      assert.equal(config.engagement.enforceKoreanPosts, true);
      assert.equal(config.engagement.autonomyMaxBudgetUtilization, 0.92);
      assert.equal(config.engagement.autonomyRiskBlockScore, 7);
      assert.equal(config.xApiCost.enabled, true);
      assert.equal(config.xApiCost.dailyMaxUsd, 0.1);
      assert.equal(config.xApiCost.estimatedReadCostUsd, 0.012);
      assert.equal(config.xApiCost.estimatedCreateCostUsd, 0.01);
      assert.equal(config.xApiCost.dailyReadRequestLimit, 8);
      assert.equal(config.xApiCost.dailyCreateRequestLimit, 10);
      assert.equal(config.xApiCost.createMinIntervalMinutes, 20);
    }
  );
});
