export type SignalImportance = "high" | "medium" | "low";
export type SignalDirection = "up" | "down" | "flat";
export type ResearchObjective = "briefing" | "engagement" | "reply";
export type ActionStyle = "assertive" | "curious" | "cautious";
export type CognitiveObjective = ResearchObjective;
export type ClusterSentiment = "bullish" | "bearish" | "mixed" | "neutral";
export type ActionIntent = "thesis" | "challenge" | "probe";
export type NutrientSource = "onchain" | "market" | "news";
export type EvolutionStage = "seed" | "sprout" | "crawler" | "sentinel" | "mythic";
export type TrendLane =
  | "protocol"
  | "ecosystem"
  | "regulation"
  | "macro"
  | "onchain"
  | "market-structure";

export interface OnchainSignal {
  id: string;
  label: string;
  value: string;
  source: string;
  direction: SignalDirection;
  importance: SignalImportance;
  summary: string;
}

export interface OnchainSnapshot {
  createdAt: string;
  signals: OnchainSignal[];
  highlights: string[];
  riskFlags: string[];
}

export interface OnchainNutrient {
  id: string;
  source: NutrientSource;
  category: string;
  label: string;
  value: string;
  evidence: string;
  direction?: SignalDirection;
  trust: number;
  freshness: number;
  consistencyHint?: number;
  capturedAt: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface TrendEvent {
  id: string;
  lane: TrendLane;
  headline: string;
  summary: string;
  source: string;
  trust: number;
  freshness: number;
  capturedAt: string;
  keywords: string[];
}

export interface OnchainEvidence {
  id: string;
  lane: TrendLane;
  nutrientId: string;
  source: NutrientSource;
  label: string;
  value: string;
  summary: string;
  trust: number;
  freshness: number;
  digestScore?: number;
  capturedAt: string;
}

export interface DigestScore {
  trust: number;
  freshness: number;
  consistency: number;
  total: number;
  reasonCodes: string[];
}

export interface AbilityUnlock {
  id: string;
  name: string;
  description: string;
  unlockedAt: EvolutionStage;
}

export interface NutrientLedgerEntry {
  id: string;
  nutrientId: string;
  source: NutrientSource;
  category: string;
  label: string;
  digestScore: DigestScore;
  xpGain: number;
  accepted: boolean;
  capturedAt: string;
}

export interface ResearchInput {
  objective: ResearchObjective;
  language: "ko" | "en";
  topic: string;
  marketContext: string;
  onchainContext?: string;
  influencerContext?: string;
  memoryContext?: string;
}

export interface EvidenceItem {
  point: string;
  source: "market" | "onchain" | "news" | "influencer" | "memory" | "mixed";
  confidence: number;
}

export interface StructuredInsight {
  claim: string;
  evidence: EvidenceItem[];
  counterpoint: string;
  confidence: number;
  actionStyle: ActionStyle;
}

export interface ReflectionPolicy {
  createdAt: string;
  windowHours: number;
  summary: string;
  strengths: string[];
  gaps: string[];
  policyAdjustments: string[];
  metrics: {
    totalTweets: number;
    replyRatio: number;
    averageLength: number;
    tickerMentionRatio: number;
    questionEndingRatio: number;
    averageLikes: number;
    averageRepliesReceived: number;
    likeRate: number;
    replyReceiveRate: number;
    engagementCoverage: number;
  };
}

export interface MomentumCluster {
  id: string;
  topic: string;
  tickers: string[];
  score: number;
  sentiment: ClusterSentiment;
  evidenceCount: number;
  summary: string;
}

export interface BeliefHypothesis {
  id: string;
  statement: string;
  probability: number;
  basedOnClusterIds: string[];
  contradictingSignals: string[];
}

export interface CognitiveActionPlan {
  intent: ActionIntent;
  style: ActionStyle;
  shouldReply: boolean;
  shouldEndWithQuestion: boolean;
  maxChars: number;
  riskMode: "defensive" | "balanced" | "aggressive";
  rationale: string;
}

export interface CognitiveRunContext {
  objective: CognitiveObjective;
  createdAt: string;
  marketContext: string;
  onchainContext: string;
  reflectionContext: string;
  evolutionContext: string;
}

export interface CognitivePacket {
  objective: CognitiveObjective;
  language: "ko" | "en";
  clusters: MomentumCluster[];
  beliefs: BeliefHypothesis[];
  insight: StructuredInsight;
  action: CognitiveActionPlan;
  promptContext: string;
}
