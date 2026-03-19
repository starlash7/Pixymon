export type ContentLanguage = "ko" | "en";
export type ReplyLanguageMode = "match" | ContentLanguage;
export type ActionMode = "observe" | "paper" | "live";

export interface EngagementRuntimeSettings {
  postGenerationMaxAttempts: number;
  postMaxChars: number;
  postMinLength: number;
  allowFallbackAutoPublish: boolean;
  postMinIntervalMinutes: number;
  maxPostsPerCycle: number;
  nutrientMinDigestScore: number;
  nutrientMaxIntakePerCycle: number;
  sentimentMaxRatio24h: number;
  postLanguage: ContentLanguage;
  replyLanguageMode: ReplyLanguageMode;
  requireOnchainEvidence: boolean;
  requireCrossSourceEvidence: boolean;
  enforceKoreanPosts: boolean;
  autonomyMaxBudgetUtilization: number;
  autonomyRiskBlockScore: number;
  minNewsSourceTrust: number;
  minTrendTweetSourceTrust: number;
  minTrendTweetScore: number;
  minTrendTweetEngagement: number;
  trendTweetMaxAgeHours: number;
  trendTweetRequireRootPost: boolean;
  trendTweetBlockSuspiciousPromo: boolean;
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

export interface AnthropicCostRuntimeSettings {
  enabled: boolean;
  dailyMaxUsd: number;
  dailyRequestLimit: number;
  degradeAtUtilization: number;
  localOnlyAtUtilization: number;
  promptCachingEnabled: boolean;
  cacheWriteMultiplier: number;
  cacheReadMultiplier: number;
  usageApiEnabled: boolean;
  usageApiMinSyncMinutes: number;
  primaryInputCostPerMillionUsd: number;
  primaryOutputCostPerMillionUsd: number;
  researchInputCostPerMillionUsd: number;
  researchOutputCostPerMillionUsd: number;
}

export interface TotalCostRuntimeSettings {
  enabled: boolean;
  dailyMaxUsd: number;
}

export interface LlmBatchRuntimeSettings {
  enabled: boolean;
  maxRequestsPerBatch: number;
  maxSyncBatchesPerRun: number;
  minSyncMinutes: number;
}

export interface ObservabilityRuntimeSettings {
  enabled: boolean;
  stdoutJson: boolean;
  eventLogPath: string;
}

export interface SoulRuntimeSettings {
  soulMode: boolean;
  softGateMode: boolean;
  questMode: boolean;
}

export interface OperationalRuntimeSettings {
  actionMode: ActionMode;
  stateReconcileOnBoot: boolean;
  actionTwoPhaseCommit: boolean;
  crashFlushOnException: boolean;
  sessionQuarantineOnParseError: boolean;
  toolCallStrictValidate: boolean;
}
