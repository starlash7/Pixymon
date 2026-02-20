import fs from "fs";
import path from "path";
import { memory } from "./memory.js";
import { AdaptivePolicy, CycleCacheMetrics } from "./engagement/types.js";
import { EngagementRuntimeSettings, ObservabilityRuntimeSettings } from "../types/runtime.js";
import { TrendLane } from "../types/agent.js";

interface PostGenerationSnapshot {
  postRuns: number;
  postSuccesses: number;
  postFailures: number;
  totalRetries: number;
  avgRetries: number;
  fallbackRate: number;
  failReasons: Record<string, number>;
}

interface ObservabilitySnapshot {
  activityCount: number;
  postCount: number;
  replyCount: number;
  postGeneration: PostGenerationSnapshot;
  laneUsage24h: Array<{ lane: TrendLane; count: number }>;
  nutrient: {
    nutrientIntake: number;
    acceptedCount: number;
    avgDigestScore: number;
    xpGain: number;
    xpGainBySource: {
      onchain: number;
      market: number;
      news: number;
    };
    evolutionEvent: number;
  };
}

export interface CycleObservabilityInput {
  timezone: string;
  target: number;
  executed: number;
  remaining: number;
  policy: AdaptivePolicy;
  runtimeSettings: EngagementRuntimeSettings;
  cacheMetrics?: CycleCacheMetrics;
}

export interface CycleObservabilityEvent {
  type: "quota_cycle";
  timestamp: string;
  timezone: string;
  target: number;
  executed: number;
  remaining: number;
  progressRatio: number;
  activity: {
    today: number;
    posts: number;
    replies: number;
  };
  postGeneration: {
    runs: number;
    successes: number;
    failures: number;
    retryCountTotal: number;
    retryCountAvg: number;
    fallbackRate: number;
    failReasonsTop: Array<{ reason: string; count: number }>;
  };
  policy: {
    rationale: string;
    minTrendScore: number;
    minTrendEngagement: number;
    minSourceTrust: number;
    postDuplicateThreshold: number;
    replyDuplicateThreshold: number;
  };
  runtime: {
    postLanguage: string;
    replyLanguageMode: string;
    postMinIntervalMinutes: number;
    signalFingerprintCooldownHours: number;
    maxPostsPerCycle: number;
    nutrientMinDigestScore: number;
    nutrientMaxIntakePerCycle: number;
    fearGreedEventMinDelta: number;
    fearGreedRequireRegimeChange: boolean;
    requireFearGreedEventForSentiment: boolean;
    sentimentMaxRatio24h: number;
    minNewsSourceTrust: number;
    minTrendTweetSourceTrust: number;
    minTrendTweetScore: number;
    minTrendTweetEngagement: number;
    topicMaxSameTag24h: number;
    topicBlockConsecutiveTag: boolean;
  };
  nutrition: {
    nutrient_intake: number;
    accepted_nutrient_count: number;
    avg_digest_score: number;
    xp_gain: number;
    xp_gain_by_source: {
      onchain: number;
      market: number;
      news: number;
    };
    evolution_event: number;
  };
  planning: {
    lane_usage_24h: Record<TrendLane, number>;
    dominant_lane_24h: TrendLane | "none";
    onchain_ratio_24h: number;
  };
  cache?: CycleCacheMetrics;
}

export function emitCycleObservability(
  input: CycleObservabilityInput,
  settings: ObservabilityRuntimeSettings
): void {
  if (!settings.enabled) return;

  const snapshot: ObservabilitySnapshot = {
    activityCount: memory.getTodayActivityCount(input.timezone),
    postCount: memory.getTodayPostCount(input.timezone),
    replyCount: memory.getTodayReplyCount(input.timezone),
    postGeneration: memory.getTodayPostGenerationMetrics(input.timezone),
    laneUsage24h: memory.getRecentBriefingLaneUsage(24),
    nutrient: memory.getTodayNutrientMetrics(input.timezone),
  };

  const event = buildCycleObservabilityEvent(input, snapshot);
  if (settings.stdoutJson) {
    console.log(`[METRIC] ${JSON.stringify(event)}`);
  }
  appendObservabilityEvent(settings.eventLogPath, event);
}

export function buildCycleObservabilityEvent(
  input: CycleObservabilityInput,
  snapshot: ObservabilitySnapshot
): CycleObservabilityEvent {
  const progressRaw = input.target > 0 ? (input.target - input.remaining) / input.target : 1;
  const laneUsageRecord = toLaneUsageRecord(snapshot.laneUsage24h || []);
  const laneEntries = Object.entries(laneUsageRecord) as Array<[TrendLane, number]>;
  const dominantLaneEntry = laneEntries.sort((a, b) => b[1] - a[1])[0];
  const dominantLane = dominantLaneEntry && dominantLaneEntry[1] > 0 ? dominantLaneEntry[0] : "none";
  const laneTotal = laneEntries.reduce((sum, [, count]) => sum + count, 0);
  const onchainRatio = laneTotal > 0 ? laneUsageRecord.onchain / laneTotal : 0;
  return {
    type: "quota_cycle",
    timestamp: new Date().toISOString(),
    timezone: input.timezone,
    target: input.target,
    executed: input.executed,
    remaining: input.remaining,
    progressRatio: round(progressRaw, 3),
    activity: {
      today: snapshot.activityCount,
      posts: snapshot.postCount,
      replies: snapshot.replyCount,
    },
    postGeneration: {
      runs: snapshot.postGeneration.postRuns,
      successes: snapshot.postGeneration.postSuccesses,
      failures: snapshot.postGeneration.postFailures,
      retryCountTotal: snapshot.postGeneration.totalRetries,
      retryCountAvg: snapshot.postGeneration.avgRetries,
      fallbackRate: snapshot.postGeneration.fallbackRate,
      failReasonsTop: pickTopFailReasons(snapshot.postGeneration.failReasons),
    },
    policy: {
      rationale: input.policy.rationale,
      minTrendScore: round(input.policy.minTrendScore, 2),
      minTrendEngagement: input.policy.minTrendEngagement,
      minSourceTrust: round(input.policy.minSourceTrust, 2),
      postDuplicateThreshold: round(input.policy.postDuplicateThreshold, 2),
      replyDuplicateThreshold: round(input.policy.replyDuplicateThreshold, 2),
    },
    runtime: {
      postLanguage: input.runtimeSettings.postLanguage,
      replyLanguageMode: input.runtimeSettings.replyLanguageMode,
      postMinIntervalMinutes: input.runtimeSettings.postMinIntervalMinutes,
      signalFingerprintCooldownHours: input.runtimeSettings.signalFingerprintCooldownHours,
      maxPostsPerCycle: input.runtimeSettings.maxPostsPerCycle,
      nutrientMinDigestScore: round(input.runtimeSettings.nutrientMinDigestScore, 2),
      nutrientMaxIntakePerCycle: input.runtimeSettings.nutrientMaxIntakePerCycle,
      fearGreedEventMinDelta: input.runtimeSettings.fearGreedEventMinDelta,
      fearGreedRequireRegimeChange: input.runtimeSettings.fearGreedRequireRegimeChange,
      requireFearGreedEventForSentiment: input.runtimeSettings.requireFearGreedEventForSentiment,
      sentimentMaxRatio24h: round(input.runtimeSettings.sentimentMaxRatio24h, 2),
      minNewsSourceTrust: round(input.runtimeSettings.minNewsSourceTrust, 2),
      minTrendTweetSourceTrust: round(input.runtimeSettings.minTrendTweetSourceTrust, 2),
      minTrendTweetScore: round(input.runtimeSettings.minTrendTweetScore, 2),
      minTrendTweetEngagement: input.runtimeSettings.minTrendTweetEngagement,
      topicMaxSameTag24h: input.runtimeSettings.topicMaxSameTag24h,
      topicBlockConsecutiveTag: input.runtimeSettings.topicBlockConsecutiveTag,
    },
    nutrition: {
      nutrient_intake: snapshot.nutrient.nutrientIntake,
      accepted_nutrient_count: snapshot.nutrient.acceptedCount,
      avg_digest_score: snapshot.nutrient.avgDigestScore,
      xp_gain: snapshot.nutrient.xpGain,
      xp_gain_by_source: snapshot.nutrient.xpGainBySource,
      evolution_event: snapshot.nutrient.evolutionEvent,
    },
    planning: {
      lane_usage_24h: laneUsageRecord,
      dominant_lane_24h: dominantLane,
      onchain_ratio_24h: round(onchainRatio, 3),
    },
    cache: input.cacheMetrics,
  };
}

function appendObservabilityEvent(eventLogPath: string, event: CycleObservabilityEvent): void {
  const normalized = String(eventLogPath || "").trim();
  if (!normalized) return;

  const targetPath = path.isAbsolute(normalized)
    ? normalized
    : path.join(process.cwd(), normalized);

  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.appendFileSync(targetPath, `${JSON.stringify(event)}\n`);
  } catch (error) {
    console.log(`[METRIC] 이벤트 파일 저장 실패: ${(error as Error).message}`);
  }
}

function pickTopFailReasons(
  failReasons: Record<string, number>,
  maxItems: number = 3
): Array<{ reason: string; count: number }> {
  return Object.entries(failReasons || {})
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, Math.max(1, maxItems));
}

function toLaneUsageRecord(rows: Array<{ lane: TrendLane; count: number }>): Record<TrendLane, number> {
  const record: Record<TrendLane, number> = {
    protocol: 0,
    ecosystem: 0,
    regulation: 0,
    macro: 0,
    onchain: 0,
    "market-structure": 0,
  };
  if (!Array.isArray(rows)) {
    return record;
  }
  rows.forEach((row) => {
    if (!row) return;
    record[row.lane] = Number.isFinite(row.count) ? Math.max(0, Math.floor(row.count)) : 0;
  });
  return record;
}

function round(value: number, precision: number): number {
  if (!Number.isFinite(value)) return 0;
  const scale = Math.pow(10, Math.max(0, precision));
  return Math.round(value * scale) / scale;
}
