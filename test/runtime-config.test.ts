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
      POST_GENERATION_MAX_ATTEMPTS: "2",
      TREND_TWEET_MIN_SCORE: "4.4",
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
      assert.equal(config.engagement.minTrendTweetScore, 4.4);
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
    },
    () => {
      const config = loadRuntimeConfig();
      assert.equal(config.observability.enabled, true);
      assert.equal(config.observability.stdoutJson, true);
      assert.equal(config.observability.eventLogPath, "data/metrics-events.ndjson");
    }
  );
});
