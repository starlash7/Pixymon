import { MarketData } from "../blockchain-news.js";

export interface DailyQuotaOptions {
  dailyTarget?: number;
  timezone?: string;
  maxActionsPerCycle?: number;
  minLoopMinutes?: number;
  maxLoopMinutes?: number;
}

export interface TrendContext {
  keywords: string[];
  summary: string;
  marketData: MarketData[];
  headlines: string[];
  newsSources: Array<{ key: string; trust: number }>;
}

export interface ContentQualityCheck {
  ok: boolean;
  reason?: string;
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
