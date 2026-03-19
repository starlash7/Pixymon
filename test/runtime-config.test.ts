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
      ALLOW_FALLBACK_AUTO_PUBLISH: "true",
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
      ANTHROPIC_COST_GUARD_ENABLED: "true",
      ANTHROPIC_DAILY_MAX_USD: "0.45",
      ANTHROPIC_DAILY_REQUEST_LIMIT: "28",
      ANTHROPIC_DEGRADE_AT_UTILIZATION: "0.72",
      ANTHROPIC_LOCAL_ONLY_AT_UTILIZATION: "0.88",
      ANTHROPIC_PROMPT_CACHING_ENABLED: "false",
      ANTHROPIC_CACHE_WRITE_MULTIPLIER: "1.4",
      ANTHROPIC_CACHE_READ_MULTIPLIER: "0.15",
      ANTHROPIC_USAGE_API_ENABLED: "true",
      ANTHROPIC_USAGE_API_MIN_SYNC_MINUTES: "9",
      ANTHROPIC_PRIMARY_INPUT_COST_PER_MILLION_USD: "3.2",
      ANTHROPIC_PRIMARY_OUTPUT_COST_PER_MILLION_USD: "16",
      ANTHROPIC_RESEARCH_INPUT_COST_PER_MILLION_USD: "0.9",
      ANTHROPIC_RESEARCH_OUTPUT_COST_PER_MILLION_USD: "4.5",
      TOTAL_COST_GUARD_ENABLED: "true",
      TOTAL_DAILY_MAX_USD: "0.6",
      ANTHROPIC_BATCH_ENABLED: "true",
      ANTHROPIC_BATCH_MAX_REQUESTS: "12",
      ANTHROPIC_BATCH_MAX_SYNC_BATCHES: "4",
      ANTHROPIC_BATCH_MIN_SYNC_MINUTES: "15",
      OBSERVABILITY_ENABLED: "true",
      OBSERVABILITY_STDOUT_JSON: "false",
      OBSERVABILITY_EVENT_LOG_PATH: "data/custom-observability.ndjson",
      SOUL_MODE: "false",
      SOFT_GATE_MODE: "true",
      QUEST_MODE: "false",
      ACTION_MODE: "paper",
      STATE_RECONCILE_ON_BOOT: "false",
      ACTION_TWO_PHASE_COMMIT: "false",
      CRASH_FLUSH_ON_EXCEPTION: "false",
      SESSION_QUARANTINE_ON_PARSE_ERROR: "false",
      TOOL_CALL_STRICT_VALIDATE: "false",
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
      assert.equal(config.engagement.allowFallbackAutoPublish, true);
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
      assert.equal(config.anthropicCost.enabled, true);
      assert.equal(config.anthropicCost.dailyMaxUsd, 0.45);
      assert.equal(config.anthropicCost.dailyRequestLimit, 28);
      assert.equal(config.anthropicCost.degradeAtUtilization, 0.72);
      assert.equal(config.anthropicCost.localOnlyAtUtilization, 0.88);
      assert.equal(config.anthropicCost.promptCachingEnabled, false);
      assert.equal(config.anthropicCost.cacheWriteMultiplier, 1.4);
      assert.equal(config.anthropicCost.cacheReadMultiplier, 0.15);
      assert.equal(config.anthropicCost.usageApiEnabled, true);
      assert.equal(config.anthropicCost.usageApiMinSyncMinutes, 9);
      assert.equal(config.anthropicCost.primaryInputCostPerMillionUsd, 3.2);
      assert.equal(config.anthropicCost.primaryOutputCostPerMillionUsd, 16);
      assert.equal(config.anthropicCost.researchInputCostPerMillionUsd, 0.9);
      assert.equal(config.anthropicCost.researchOutputCostPerMillionUsd, 4.5);
      assert.equal(config.totalCost.enabled, true);
      assert.equal(config.totalCost.dailyMaxUsd, 0.6);
      assert.equal(config.batch.enabled, true);
      assert.equal(config.batch.maxRequestsPerBatch, 12);
      assert.equal(config.batch.maxSyncBatchesPerRun, 4);
      assert.equal(config.batch.minSyncMinutes, 15);
      assert.equal(config.observability.enabled, true);
      assert.equal(config.observability.stdoutJson, false);
      assert.equal(config.observability.eventLogPath, "data/custom-observability.ndjson");
      assert.equal(config.soul.soulMode, false);
      assert.equal(config.soul.softGateMode, true);
      assert.equal(config.soul.questMode, false);
      assert.equal(config.operational.actionMode, "paper");
      assert.equal(config.operational.stateReconcileOnBoot, false);
      assert.equal(config.operational.actionTwoPhaseCommit, false);
      assert.equal(config.operational.crashFlushOnException, false);
      assert.equal(config.operational.sessionQuarantineOnParseError, false);
      assert.equal(config.operational.toolCallStrictValidate, false);
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
      ALLOW_FALLBACK_AUTO_PUBLISH: "invalid",
      X_API_COST_GUARD_ENABLED: "invalid",
      X_API_DAILY_MAX_USD: "invalid",
      X_API_ESTIMATED_READ_COST_USD: "invalid",
      X_API_ESTIMATED_CREATE_COST_USD: "invalid",
      X_API_DAILY_READ_REQUEST_LIMIT: "invalid",
      X_API_DAILY_CREATE_REQUEST_LIMIT: "invalid",
      ANTHROPIC_COST_GUARD_ENABLED: "invalid",
      ANTHROPIC_DAILY_MAX_USD: "invalid",
      ANTHROPIC_DAILY_REQUEST_LIMIT: "invalid",
      ANTHROPIC_DEGRADE_AT_UTILIZATION: "invalid",
      ANTHROPIC_LOCAL_ONLY_AT_UTILIZATION: "invalid",
      ANTHROPIC_PROMPT_CACHING_ENABLED: "invalid",
      ANTHROPIC_CACHE_WRITE_MULTIPLIER: "invalid",
      ANTHROPIC_CACHE_READ_MULTIPLIER: "invalid",
      ANTHROPIC_USAGE_API_ENABLED: "invalid",
      ANTHROPIC_USAGE_API_MIN_SYNC_MINUTES: "invalid",
      ANTHROPIC_PRIMARY_INPUT_COST_PER_MILLION_USD: "invalid",
      ANTHROPIC_PRIMARY_OUTPUT_COST_PER_MILLION_USD: "invalid",
      ANTHROPIC_RESEARCH_INPUT_COST_PER_MILLION_USD: "invalid",
      ANTHROPIC_RESEARCH_OUTPUT_COST_PER_MILLION_USD: "invalid",
      TOTAL_COST_GUARD_ENABLED: "invalid",
      TOTAL_DAILY_MAX_USD: "invalid",
      ANTHROPIC_BATCH_ENABLED: "invalid",
      ANTHROPIC_BATCH_MAX_REQUESTS: "invalid",
      ANTHROPIC_BATCH_MAX_SYNC_BATCHES: "invalid",
      ANTHROPIC_BATCH_MIN_SYNC_MINUTES: "invalid",
      SOUL_MODE: "invalid",
      SOFT_GATE_MODE: "invalid",
      QUEST_MODE: "invalid",
      ACTION_MODE: "invalid",
      STATE_RECONCILE_ON_BOOT: "invalid",
      ACTION_TWO_PHASE_COMMIT: "invalid",
      CRASH_FLUSH_ON_EXCEPTION: "invalid",
      SESSION_QUARANTINE_ON_PARSE_ERROR: "invalid",
      TOOL_CALL_STRICT_VALIDATE: "invalid",
    },
    () => {
      const config = loadRuntimeConfig();
      assert.equal(config.observability.enabled, true);
      assert.equal(config.observability.stdoutJson, true);
      assert.equal(config.observability.eventLogPath, "data/metrics-events.ndjson");
      assert.equal(config.engagement.postMinIntervalMinutes, 60);
      assert.equal(config.engagement.maxPostsPerCycle, 1);
      assert.equal(config.engagement.nutrientMinDigestScore, 0.5);
      assert.equal(config.engagement.nutrientMaxIntakePerCycle, 12);
      assert.equal(config.engagement.sentimentMaxRatio24h, 0.25);
      assert.equal(config.engagement.requireOnchainEvidence, true);
      assert.equal(config.engagement.requireCrossSourceEvidence, true);
      assert.equal(config.engagement.enforceKoreanPosts, true);
      assert.equal(config.engagement.autonomyMaxBudgetUtilization, 0.92);
      assert.equal(config.engagement.autonomyRiskBlockScore, 7);
      assert.equal(config.engagement.allowFallbackAutoPublish, false);
      assert.equal(config.xApiCost.enabled, true);
      assert.equal(config.xApiCost.dailyMaxUsd, 0.1);
      assert.equal(config.xApiCost.estimatedReadCostUsd, 0.012);
      assert.equal(config.xApiCost.estimatedCreateCostUsd, 0.01);
      assert.equal(config.xApiCost.dailyReadRequestLimit, 8);
      assert.equal(config.xApiCost.dailyCreateRequestLimit, 10);
      assert.equal(config.xApiCost.createMinIntervalMinutes, 20);
      assert.equal(config.anthropicCost.enabled, true);
      assert.equal(config.anthropicCost.dailyMaxUsd, 0.4);
      assert.equal(config.anthropicCost.dailyRequestLimit, 40);
      assert.equal(config.anthropicCost.degradeAtUtilization, 0.7);
      assert.equal(config.anthropicCost.localOnlyAtUtilization, 0.85);
      assert.equal(config.anthropicCost.promptCachingEnabled, true);
      assert.equal(config.anthropicCost.cacheWriteMultiplier, 1.25);
      assert.equal(config.anthropicCost.cacheReadMultiplier, 0.1);
      assert.equal(config.anthropicCost.usageApiEnabled, false);
      assert.equal(config.anthropicCost.usageApiMinSyncMinutes, 5);
      assert.equal(config.anthropicCost.primaryInputCostPerMillionUsd, 3);
      assert.equal(config.anthropicCost.primaryOutputCostPerMillionUsd, 15);
      assert.equal(config.anthropicCost.researchInputCostPerMillionUsd, 0.8);
      assert.equal(config.anthropicCost.researchOutputCostPerMillionUsd, 4);
      assert.equal(config.totalCost.enabled, true);
      assert.equal(config.totalCost.dailyMaxUsd, 0.5);
      assert.equal(config.batch.enabled, false);
      assert.equal(config.batch.maxRequestsPerBatch, 8);
      assert.equal(config.batch.maxSyncBatchesPerRun, 3);
      assert.equal(config.batch.minSyncMinutes, 10);
      assert.equal(config.soul.soulMode, true);
      assert.equal(config.soul.softGateMode, false);
      assert.equal(config.soul.questMode, true);
      assert.equal(config.operational.actionMode, "observe");
      assert.equal(config.operational.stateReconcileOnBoot, true);
      assert.equal(config.operational.actionTwoPhaseCommit, true);
      assert.equal(config.operational.crashFlushOnException, true);
      assert.equal(config.operational.sessionQuarantineOnParseError, true);
      assert.equal(config.operational.toolCallStrictValidate, true);
    }
  );
});
