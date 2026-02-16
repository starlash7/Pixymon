export type SignalImportance = "high" | "medium" | "low";
export type SignalDirection = "up" | "down" | "flat";
export type ResearchObjective = "briefing" | "engagement" | "reply";
export type ActionStyle = "assertive" | "curious" | "cautious";
export type CognitiveObjective = ResearchObjective;
export type ClusterSentiment = "bullish" | "bearish" | "mixed" | "neutral";
export type ActionIntent = "thesis" | "challenge" | "probe";

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
