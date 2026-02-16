export type SignalImportance = "high" | "medium" | "low";
export type SignalDirection = "up" | "down" | "flat";
export type ResearchObjective = "briefing" | "engagement" | "reply";
export type ActionStyle = "assertive" | "curious" | "cautious";

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
