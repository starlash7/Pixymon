export type ContentLanguage = "ko" | "en";
export type ReplyLanguageMode = "match" | ContentLanguage;

export interface EngagementRuntimeSettings {
  postGenerationMaxAttempts: number;
  postMaxChars: number;
  postMinLength: number;
  postMinIntervalMinutes: number;
  signalFingerprintCooldownHours: number;
  maxPostsPerCycle: number;
  nutrientMinDigestScore: number;
  nutrientMaxIntakePerCycle: number;
  fearGreedEventMinDelta: number;
  fearGreedRequireRegimeChange: boolean;
  requireFearGreedEventForSentiment: boolean;
  sentimentMaxRatio24h: number;
  postLanguage: ContentLanguage;
  replyLanguageMode: ReplyLanguageMode;
  minNewsSourceTrust: number;
  minTrendTweetSourceTrust: number;
  minTrendTweetScore: number;
  minTrendTweetEngagement: number;
  topicMaxSameTag24h: number;
  topicBlockConsecutiveTag: boolean;
}

export interface XApiCostRuntimeSettings {
  enabled: boolean;
  dailyMaxUsd: number;
  estimatedReadCostUsd: number;
  estimatedCreateCostUsd: number;
  dailyReadRequestLimit: number;
  dailyCreateRequestLimit: number;
  mentionReadMinIntervalMinutes: number;
  trendReadMinIntervalMinutes: number;
  createMinIntervalMinutes: number;
}

export interface ObservabilityRuntimeSettings {
  enabled: boolean;
  stdoutJson: boolean;
  eventLogPath: string;
}
