export type ContentLanguage = "ko" | "en";
export type ReplyLanguageMode = "match" | ContentLanguage;
export type ActionMode = "observe" | "paper" | "live";

export interface EngagementRuntimeSettings {
  postGenerationMaxAttempts: number;
  postMaxChars: number;
  postMinLength: number;
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
