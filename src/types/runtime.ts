export type ContentLanguage = "ko" | "en";
export type ReplyLanguageMode = "match" | ContentLanguage;

export interface EngagementRuntimeSettings {
  postGenerationMaxAttempts: number;
  postMaxChars: number;
  postMinLength: number;
  postLanguage: ContentLanguage;
  replyLanguageMode: ReplyLanguageMode;
  minNewsSourceTrust: number;
  minTrendTweetSourceTrust: number;
  minTrendTweetScore: number;
  minTrendTweetEngagement: number;
  topicMaxSameTag24h: number;
  topicBlockConsecutiveTag: boolean;
}
