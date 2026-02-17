import {
  ContentLanguage,
  EngagementRuntimeSettings,
  ObservabilityRuntimeSettings,
  ReplyLanguageMode,
} from "../types/runtime.js";

export interface RuntimeConfig {
  schedulerMode: boolean;
  dailyActivityTarget: number;
  dailyTimezone: string;
  maxActionsPerCycle: number;
  minLoopMinutes: number;
  maxLoopMinutes: number;
  engagement: EngagementRuntimeSettings;
  observability: ObservabilityRuntimeSettings;
}

const DEFAULT_DAILY_ACTIVITY_TARGET = 20;
const DEFAULT_DAILY_TIMEZONE = "Asia/Seoul";
const DEFAULT_MAX_ACTIONS_PER_CYCLE = 4;
const DEFAULT_MIN_LOOP_MINUTES = 25;
const DEFAULT_MAX_LOOP_MINUTES = 70;
const DEFAULT_OBSERVABILITY_EVENT_LOG_PATH = "data/metrics-events.ndjson";

export const DEFAULT_ENGAGEMENT_SETTINGS: EngagementRuntimeSettings = {
  postGenerationMaxAttempts: 2,
  postMaxChars: 220,
  postMinLength: 20,
  postLanguage: "ko",
  replyLanguageMode: "match",
  minNewsSourceTrust: 0.28,
  minTrendTweetSourceTrust: 0.24,
  minTrendTweetScore: 3.2,
  minTrendTweetEngagement: 6,
  topicMaxSameTag24h: 3,
  topicBlockConsecutiveTag: true,
};

export const DEFAULT_OBSERVABILITY_SETTINGS: ObservabilityRuntimeSettings = {
  enabled: true,
  stdoutJson: true,
  eventLogPath: DEFAULT_OBSERVABILITY_EVENT_LOG_PATH,
};

function parseIntInRange(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  const parsed = Number.parseInt(raw || "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function parseFloatInRange(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  const parsed = Number.parseFloat(raw || "");
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (typeof raw !== "string") return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return fallback;
}

function parseContentLanguage(raw: string | undefined, fallback: ContentLanguage): ContentLanguage {
  if (typeof raw !== "string") return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "ko" || normalized === "en") {
    return normalized;
  }
  return fallback;
}

function parseReplyLanguageMode(raw: string | undefined, fallback: ReplyLanguageMode): ReplyLanguageMode {
  if (typeof raw !== "string") return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "en" || normalized === "ko") {
    return normalized;
  }
  if (normalized === "match") {
    return "match";
  }
  return fallback;
}

function parseNonEmptyString(raw: string | undefined, fallback: string, maxLength: number = 200): string {
  if (typeof raw !== "string") return fallback;
  const normalized = raw.trim();
  if (!normalized) return fallback;
  return normalized.slice(0, maxLength);
}

export function loadRuntimeConfig(): RuntimeConfig {
  const schedulerMode = process.env.SCHEDULER_MODE === "true";
  const dailyActivityTarget = parseIntInRange(
    process.env.DAILY_ACTIVITY_TARGET,
    DEFAULT_DAILY_ACTIVITY_TARGET,
    1,
    100
  );
  const dailyTimezone = process.env.DAILY_TARGET_TIMEZONE || DEFAULT_DAILY_TIMEZONE;
  const maxActionsPerCycle = parseIntInRange(
    process.env.MAX_ACTIONS_PER_CYCLE,
    DEFAULT_MAX_ACTIONS_PER_CYCLE,
    1,
    10
  );
  const minLoopMinutes = parseIntInRange(
    process.env.MIN_LOOP_MINUTES,
    DEFAULT_MIN_LOOP_MINUTES,
    5,
    180
  );
  const maxLoopMinutes = parseIntInRange(
    process.env.MAX_LOOP_MINUTES,
    DEFAULT_MAX_LOOP_MINUTES,
    minLoopMinutes,
    240
  );
  const engagement: EngagementRuntimeSettings = {
    postGenerationMaxAttempts: parseIntInRange(
      process.env.POST_GENERATION_MAX_ATTEMPTS,
      DEFAULT_ENGAGEMENT_SETTINGS.postGenerationMaxAttempts,
      1,
      4
    ),
    postMaxChars: parseIntInRange(
      process.env.POST_MAX_CHARS,
      DEFAULT_ENGAGEMENT_SETTINGS.postMaxChars,
      120,
      280
    ),
    postMinLength: parseIntInRange(
      process.env.POST_MIN_LENGTH,
      DEFAULT_ENGAGEMENT_SETTINGS.postMinLength,
      10,
      120
    ),
    postLanguage: parseContentLanguage(
      process.env.POST_LANGUAGE,
      DEFAULT_ENGAGEMENT_SETTINGS.postLanguage
    ),
    replyLanguageMode: parseReplyLanguageMode(
      process.env.REPLY_LANGUAGE_MODE,
      DEFAULT_ENGAGEMENT_SETTINGS.replyLanguageMode
    ),
    minNewsSourceTrust: parseFloatInRange(
      process.env.TREND_NEWS_MIN_SOURCE_TRUST,
      DEFAULT_ENGAGEMENT_SETTINGS.minNewsSourceTrust,
      0.05,
      0.9
    ),
    minTrendTweetSourceTrust: parseFloatInRange(
      process.env.TREND_TWEET_MIN_SOURCE_TRUST,
      DEFAULT_ENGAGEMENT_SETTINGS.minTrendTweetSourceTrust,
      0.05,
      0.9
    ),
    minTrendTweetScore: parseFloatInRange(
      process.env.TREND_TWEET_MIN_SCORE,
      DEFAULT_ENGAGEMENT_SETTINGS.minTrendTweetScore,
      0.5,
      12
    ),
    minTrendTweetEngagement: parseIntInRange(
      process.env.TREND_TWEET_MIN_ENGAGEMENT,
      DEFAULT_ENGAGEMENT_SETTINGS.minTrendTweetEngagement,
      1,
      200
    ),
    topicMaxSameTag24h: parseIntInRange(
      process.env.TOPIC_MAX_SAME_TAG_24H,
      DEFAULT_ENGAGEMENT_SETTINGS.topicMaxSameTag24h,
      1,
      8
    ),
    topicBlockConsecutiveTag: parseBoolean(
      process.env.TOPIC_BLOCK_CONSECUTIVE_TAG,
      DEFAULT_ENGAGEMENT_SETTINGS.topicBlockConsecutiveTag
    ),
  };
  const observability: ObservabilityRuntimeSettings = {
    enabled: parseBoolean(
      process.env.OBSERVABILITY_ENABLED,
      DEFAULT_OBSERVABILITY_SETTINGS.enabled
    ),
    stdoutJson: parseBoolean(
      process.env.OBSERVABILITY_STDOUT_JSON,
      DEFAULT_OBSERVABILITY_SETTINGS.stdoutJson
    ),
    eventLogPath: parseNonEmptyString(
      process.env.OBSERVABILITY_EVENT_LOG_PATH,
      DEFAULT_OBSERVABILITY_SETTINGS.eventLogPath,
      400
    ),
  };

  return {
    schedulerMode,
    dailyActivityTarget,
    dailyTimezone,
    maxActionsPerCycle,
    minLoopMinutes,
    maxLoopMinutes,
    engagement,
    observability,
  };
}
