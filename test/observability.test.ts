import test from "node:test";
import assert from "node:assert/strict";
import { buildCycleObservabilityEvent, CycleObservabilityInput } from "../src/services/observability.ts";

test("buildCycleObservabilityEvent includes key telemetry fields", () => {
  const input: CycleObservabilityInput = {
    timezone: "Asia/Seoul",
    target: 20,
    executed: 4,
    remaining: 12,
    policy: {
      postDuplicateThreshold: 0.82,
      postNarrativeThreshold: 0.79,
      replyDuplicateThreshold: 0.88,
      replyNarrativeThreshold: 0.82,
      minTrendScore: 3.2,
      minTrendEngagement: 6,
      minSourceTrust: 0.32,
      rationale: "default",
    },
    runtimeSettings: {
      postGenerationMaxAttempts: 2,
      postMaxChars: 220,
      postMinLength: 20,
      postMinIntervalMinutes: 90,
      signalFingerprintCooldownHours: 8,
      maxPostsPerCycle: 1,
      fearGreedEventMinDelta: 10,
      fearGreedRequireRegimeChange: true,
      requireFearGreedEventForSentiment: true,
      sentimentMaxRatio24h: 0.25,
      postLanguage: "ko",
      replyLanguageMode: "match",
      minNewsSourceTrust: 0.28,
      minTrendTweetSourceTrust: 0.24,
      minTrendTweetScore: 3.2,
      minTrendTweetEngagement: 6,
      topicMaxSameTag24h: 3,
      topicBlockConsecutiveTag: true,
    },
    cacheMetrics: {
      cognitiveHits: 1,
      cognitiveMisses: 1,
      runContextHits: 1,
      runContextMisses: 1,
      trendContextHits: 1,
      trendContextMisses: 0,
      trendTweetsHits: 0,
      trendTweetsMisses: 1,
    },
  };

  const event = buildCycleObservabilityEvent(input, {
    activityCount: 8,
    postCount: 3,
    replyCount: 5,
    postGeneration: {
      postRuns: 3,
      postSuccesses: 2,
      postFailures: 1,
      totalRetries: 2,
      avgRetries: 0.67,
      fallbackRate: 0.33,
      failReasons: {
        duplicate: 2,
        "market-mismatch": 1,
      },
    },
  });

  assert.equal(event.type, "quota_cycle");
  assert.equal(event.target, 20);
  assert.equal(event.executed, 4);
  assert.equal(event.remaining, 12);
  assert.equal(event.postGeneration.retryCountTotal, 2);
  assert.equal(event.postGeneration.fallbackRate, 0.33);
  assert.deepEqual(event.postGeneration.failReasonsTop[0], { reason: "duplicate", count: 2 });
  assert.equal(event.runtime.postLanguage, "ko");
  assert.equal(event.runtime.requireFearGreedEventForSentiment, true);
  assert.equal(event.runtime.sentimentMaxRatio24h, 0.25);
});
