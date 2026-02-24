export type SignalImportance = "high" | "medium" | "low";
export type SignalDirection = "up" | "down" | "flat";
export type NutrientSource = "onchain" | "market" | "news";
export type EvolutionStage = "seed" | "sprout" | "crawler" | "sentinel" | "mythic";
export type TrendLane =
  | "protocol"
  | "ecosystem"
  | "regulation"
  | "macro"
  | "onchain"
  | "market-structure";
export type NarrativeMode =
  | "signal-pulse"
  | "builder-note"
  | "contrarian-check"
  | "field-journal"
  | "mythic-analogy";

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
