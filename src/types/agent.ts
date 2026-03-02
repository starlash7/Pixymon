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
  | "identity-journal"
  | "philosophy-note"
  | "interaction-experiment"
  | "meta-reflection"
  | "fable-essay";
export type HypothesisStatus = "open" | "watching" | "resolved" | "dropped";
export type ClaimResolution = "supported" | "invalidated" | "superseded";
export type MoodTone = "playful" | "focused" | "curious" | "contrarian" | "cautious";
export type QuestStatus = "planned" | "active" | "completed" | "dropped";
export type StyleVoice = "pixie-analyst" | "mythic-reporter" | "builder-guide";
export type NarrativeForm = "diary" | "myth" | "paradox" | "thesis" | "quest";
export type ArcStage = "setup" | "tension" | "reveal" | "reflection";
export type RhythmPattern = "short-pulse" | "mixed" | "essay";

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

export interface OpenHypothesis {
  id: string;
  lane: TrendLane;
  statement: string;
  confidence: number;
  status: HypothesisStatus;
  evidenceIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface NarrativeThread {
  id: string;
  lane: TrendLane;
  eventId: string;
  headline: string;
  mode?: NarrativeMode;
  activityCount: number;
  evidenceIds: string[];
  openedAt: string;
  updatedAt: string;
}

export interface ResolvedClaim {
  id: string;
  lane: TrendLane;
  claim: string;
  resolution: ClaimResolution;
  confidence: number;
  evidenceIds: string[];
  resolvedAt: string;
}

export interface AutonomyContext {
  openHypotheses: OpenHypothesis[];
  narrativeThreads: NarrativeThread[];
  resolvedClaims: ResolvedClaim[];
  lastUpdated: string;
}

export interface DesireState {
  noveltyHunger: number;
  attentionHunger: number;
  convictionHunger: number;
  primaryDesire: string;
  secondaryDesire: string;
  hungerDecay: number;
  updatedAt: string;
}

export interface MoodState {
  tone: MoodTone;
  energy: number;
  confidence: number;
  updatedAt: string;
}

export interface QuestThread {
  id: string;
  lane: TrendLane;
  title: string;
  objective: string;
  status: QuestStatus;
  progress: number;
  evidenceIds: string[];
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface StyleProfile {
  voice: StyleVoice;
  assertiveness: number;
  curiosity: number;
  playfulness: number;
  evidenceBias: number;
  rhythm: RhythmPattern;
  metaphorDensity: number;
  humorTemperature: number;
  preferredForms: NarrativeForm[];
  updatedAt: string;
}

export interface ShadowState {
  fearOf: string;
  avoidancePattern: string;
  updatedAt: string;
}

export interface CuriosityEngineState {
  openQuestions: string[];
  surpriseThreshold: number;
  questionCarryoverDays: number;
  updatedAt: string;
}

export interface NarrativeArcState {
  activeArcId: string;
  arcStage: ArcStage;
  lastTurnSummary: string;
  updatedAt: string;
}

export interface AutonomyBudgetState {
  exploreRatio: number;
  initiativeSlotsPerDay: number;
  riskBudget: number;
  updatedAt: string;
}

export interface IdentityKernel {
  selfNarrative: string;
  signatureBelief: string;
  desireVector: string[];
  updatedAt: string;
}

export interface WorldviewKernel {
  philosophyNotes: string[];
  bookFragments: string[];
  interactionMissions: string[];
  updatedAt: string;
}

export interface SoulState {
  desire: DesireState;
  mood: MoodState;
  shadow: ShadowState;
  curiosity: CuriosityEngineState;
  arc: NarrativeArcState;
  autonomyBudget: AutonomyBudgetState;
  identity: IdentityKernel;
  worldview: WorldviewKernel;
  quests: QuestThread[];
  style: StyleProfile;
  lastUpdated: string;
}
