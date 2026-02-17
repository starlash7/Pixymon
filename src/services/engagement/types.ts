import { MarketData } from "../blockchain-news.js";
import {
  EngagementRuntimeSettings,
  ObservabilityRuntimeSettings,
  XApiCostRuntimeSettings,
} from "../../types/runtime.js";

export interface DailyQuotaOptions {
  dailyTarget?: number;
  timezone?: string;
  maxActionsPerCycle?: number;
  minLoopMinutes?: number;
  maxLoopMinutes?: number;
  engagement?: Partial<EngagementRuntimeSettings>;
  xApiCost?: Partial<XApiCostRuntimeSettings>;
  observability?: Partial<ObservabilityRuntimeSettings>;
}

export interface TrendContext {
  keywords: string[];
  summary: string;
  marketData: MarketData[];
  headlines: string[];
  newsSources: Array<{ key: string; trust: number }>;
}

export interface TrendFocus {
  headline: string;
  requiredTokens: string[];
  reason: "novelty" | "fallback";
}

export interface ContentQualityCheck {
  ok: boolean;
  reason?: string;
}

export interface ContentQualityRules {
  minPostLength: number;
  topicMaxSameTag24h: number;
  topicBlockConsecutiveTag: boolean;
}

export interface PostQualityContext {
  requiredTrendTokens?: string[];
}

export interface AdaptivePolicy {
  postDuplicateThreshold: number;
  postNarrativeThreshold: number;
  replyDuplicateThreshold: number;
  replyNarrativeThreshold: number;
  minTrendScore: number;
  minTrendEngagement: number;
  minSourceTrust: number;
  rationale: string;
}

export interface RecentPostRecord {
  content: string;
  timestamp: string;
}

export interface TrendContextOptions {
  minNewsSourceTrust: number;
}

export interface TrendTweetSearchRules {
  minSourceTrust: number;
  minScore: number;
  minEngagement: number;
}

export interface CycleCacheMetrics {
  cognitiveHits: number;
  cognitiveMisses: number;
  runContextHits: number;
  runContextMisses: number;
  trendContextHits: number;
  trendContextMisses: number;
  trendTweetsHits: number;
  trendTweetsMisses: number;
}
