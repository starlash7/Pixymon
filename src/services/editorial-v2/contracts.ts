export const EDITORIAL_V2_SCHEMA_VERSION = 2 as const;
export const EDITORIAL_COLLECTION_EPOCH_V2 = "hypothesis-writer-v2" as const;

/** A test of a measured level, never a test of adoption, flows, or causality. */
export interface EditorialCaseV2 {
  question: string;
  hypothesis: string | null;
  scope: "usd-tvl-level" | "observation-only";
  factIds: readonly string[];
  limitation: string;
}

export interface EditorialMemoryContextV2 {
  beliefs: readonly string[];
  previous?: {
    draftId: string;
    provenance: "live" | "shadow";
    text: string;
    thesis: string;
    verdict: string;
    recordedAt: string;
  };
}

export type EditorialFormatV2 = "bite" | "withhold" | "revisit" | "evolution";
export type EditorialLaneV2 = "onchain" | "protocol" | "ecosystem";

export type EditorialVoiceStateV2 =
  | "curious"
  | "energized"
  | "skeptical"
  | "patient"
  | "humbled";

export type MachineComparatorV2 = "gt" | "gte" | "lt" | "lte" | "eq";

export interface MachineFalsifierV2 {
  metric: string;
  comparator: MachineComparatorV2;
  threshold: number;
  deadline: string;
  unit?: string;
}

export interface FollowUpScheduleV2 {
  due24h: string;
  due72h: string;
}

/** Immutable evidence fields needed by review and publish-time freshness checks. */
export interface EditorialFactSnapshotV2 {
  readonly factId: string;
  readonly subject: string;
  readonly subjectKey?: string;
  readonly metric: {
    readonly name: string;
    readonly value: number;
    readonly raw: string;
    readonly unit: string;
    readonly period: string;
  };
  readonly source: {
    readonly provider: string;
    readonly url: string;
    readonly publishedAt: string | null;
    readonly observedAt: string;
  };
  readonly followUp?: {
    readonly metric: {
      readonly name: string;
      readonly value: number;
      readonly raw: string;
      readonly unit: string;
      readonly period: string;
    };
    readonly comparator: MachineComparatorV2;
    readonly threshold: number;
  };
  readonly selection?: {
    readonly kind: "tvl-outlier";
    readonly absoluteMoveUsd: number;
    readonly benchmarkChangePercent: number;
    readonly residualPercentagePoints: number;
    readonly priceNeutral?: {
      readonly quantityChangePercent: number;
      readonly priceChangePercent: number;
      readonly quantityMoveUsd: number;
      readonly quantityShare: number;
      readonly coverageAtT0: number;
      readonly coverageAtT1: number;
      readonly t0: number;
      readonly t1: number;
      readonly interpolatedT0: boolean;
    };
  };
}

export type EditorialGeneratedClaimKindV2 = "observation" | "judgment";

export interface EditorialGeneratedClaimV2 {
  readonly kind: EditorialGeneratedClaimKindV2;
  readonly text: string;
  readonly factIds: readonly string[];
}

/** Immutable structured writer output captured before any human edit. */
export interface EditorialGeneratedPayloadV2 {
  readonly draft: string;
  readonly usedFactIds: readonly string[];
  readonly claims: readonly EditorialGeneratedClaimV2[];
}

export interface EditorialDraftRecordV2 {
  schemaVersion: typeof EDITORIAL_V2_SCHEMA_VERSION;
  id: string;
  runId: string;
  createdAt: string;
  /** Shadow records are never publications and can never be dispatched. */
  trackingMode?: "live" | "shadow";
  editorialCase?: EditorialCaseV2;
  memoryContext?: EditorialMemoryContextV2;
  /** Absent only on legacy events created before evaluation lineage capture. */
  lane?: EditorialLaneV2;
  /** Absent only on legacy events created before evaluation lineage capture. */
  collectionEpoch?: string;
  format: EditorialFormatV2;
  subject: string;
  thesis: string;
  factIds: readonly string[];
  facts: readonly EditorialFactSnapshotV2[];
  verdict: string;
  falsifier: MachineFalsifierV2;
  followUpSchedule: FollowUpScheduleV2;
  continuityThread?: string;
  voiceState: EditorialVoiceStateV2;
  draft: string;
  /** Optional only so schema-v2 events written before lineage capture remain readable. */
  generatedPayload?: EditorialGeneratedPayloadV2;
}

export type EditorialReviewActionV2 = "approve" | "edit" | "reject";

export interface EditorialReviewRecordV2 {
  schemaVersion: typeof EDITORIAL_V2_SCHEMA_VERSION;
  id: string;
  draftId: string;
  action: EditorialReviewActionV2;
  reviewerId: string;
  reasonTags: readonly string[];
  reviewedAt: string;
  editedDraft?: string;
}

export interface EditorialPublicationRecordV2 {
  schemaVersion: typeof EDITORIAL_V2_SCHEMA_VERSION;
  draftId: string;
  platform: "x";
  externalPostId: string;
  publishedText: string;
  publishedAt: string;
  followUpSchedule: FollowUpScheduleV2;
  falsifier: MachineFalsifierV2;
}

export interface EditorialDispatchIntentRecordV2 {
  schemaVersion: typeof EDITORIAL_V2_SCHEMA_VERSION;
  id: string;
  draftId: string;
  publishText: string;
  preparedAt: string;
  recordedAt: string;
}

export type FollowUpCheckpointV2 = "24h" | "72h";

export type FollowUpResolutionV2 =
  | "candidate"
  | "silent"
  | "supported"
  | "invalidated"
  | "unresolved";

export interface FollowUpResolutionRecordV2 {
  schemaVersion: typeof EDITORIAL_V2_SCHEMA_VERSION;
  id: string;
  draftId: string;
  checkpoint: FollowUpCheckpointV2;
  resolution: FollowUpResolutionV2;
  reason: string;
  resolvedAt: string;
  observedAt?: string;
  metric?: string;
  baselineValue?: number;
  observedValue?: number;
  falsifierMatched?: boolean;
  /** Immutable evidence for public Revisit copy; later fetches only revalidate health. */
  observation?: EditorialFactSnapshotV2;
}

export interface NumericFollowUpObservationV2 {
  metric: string;
  value: number;
  observedAt: string;
}

export type MeaningfulChangeThresholdV2 =
  | { kind: "absolute"; value: number }
  /** A ratio where 0.05 means a five-percent change. */
  | { kind: "relative"; value: number };

export type FollowUp24DecisionV2 =
  | {
      checkpoint: "24h";
      resolution: "pending";
      reason: "not-due";
    }
  | {
      checkpoint: "24h";
      resolution: "silent";
      reason:
        | "missing-observation"
        | "metric-mismatch"
        | "observation-before-checkpoint"
        | "checkpoint-window-missed"
        | "no-meaningful-change";
    }
  | {
      checkpoint: "24h";
      resolution: "candidate";
      reason: "meaningful-change";
      provisionalVerdict: "invalidated" | "unresolved";
      falsifierMatched: boolean;
      baselineValue: number;
      observedValue: number;
      observedAt: string;
    };

export type FollowUp72DecisionV2 =
  | {
      checkpoint: "72h";
      resolution: "pending";
      reason:
        | "not-due"
        | "missing-observation"
        | "metric-mismatch"
        | "observation-before-deadline";
    }
  | {
      checkpoint: "72h";
      resolution: "unresolved";
      reason: "checkpoint-window-missed";
    }
  | {
      checkpoint: "72h";
      resolution: "supported" | "invalidated" | "unresolved";
      reason: "falsifier-clear" | "falsifier-matched" | "observation-only-not-a-hypothesis";
      falsifierMatched: boolean;
      observedValue: number;
      observedAt: string;
    };
