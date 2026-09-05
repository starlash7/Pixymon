import fs from "node:fs";
import path from "node:path";
import type { EditorialEventV2 } from "./event-store.js";
import { foldEditorialEventsV2, readEditorialEventsV2 } from "./event-store.js";
import type { BlindEvaluationReportV2 } from "./human-eval.js";
import type { GitHubNetworkIsolationVerificationV2 } from "./github-ci-verifier.js";
import { EDITORIAL_COLLECTION_EPOCH_V2 } from "./contracts.js";
import type { VerifiedEditorialR1BoundaryV2 } from "./r1-promotion.js";
import type { EditorialMetricTypeV2, EditorialMetricV2 } from "./telemetry.js";
import {
  formatEvidenceSourceTimeV2,
  inferMetricDirectionV2,
  validateEditorialDraftV2,
} from "./validator.js";

const METRIC_TYPES: readonly EditorialMetricTypeV2[] = [
  "provider_fetch",
  "planning_decision",
  "generation_attempt",
  "review_decision",
  "dispatch_decision",
  "followup_resolution",
];
const FACT_CHECKED_TAG = "fact-checked";
const LANGUAGE_CHECKED_TAG = "language-checked";
const FACT_ERROR_TAGS = new Set([
  "factual-error",
  "fact-error",
  "numeric-error",
  "wrong-name",
  "wrong-number",
  "wrong-time",
  "unsupported-claim",
]);
const MALFORMED_TAGS = new Set(["malformed", "malformed-korean", "grammar-error"]);

export interface RolloutMachineEvidenceV2 {
  schemaVersion: 2;
  kind: "pixymon-v2-rollout-evidence";
  offlineVerify?: {
    passed: boolean;
    /** Contract flag only; this is not proof that the OS denied network access. */
    offlineContractMode: boolean;
    completedAt: string;
    commit: string;
    pipelineDeterminismScope: "synthetic-contract";
    pipelineDeterminismPassed: boolean;
    pipelineDeterminismRuns: number;
  };
  realReplay?: {
    passed: boolean;
    candidateCount: number;
    evaluatedAt: string;
    artifactKind: "pixymon-v2-runtime-replay-export";
    artifactSha256: string;
    sourceLedgerSha256: string;
    sourceLedgerBytes: number;
    sourceEventCount: number;
    sourceDraftCount: number;
    collectionEpoch: string;
    epochDraftCount: number;
    excludedDraftCount: number;
    selectionPolicy: "first-created-in-epoch";
    textProvenance: "generated";
    /** File-reload determinism is descriptive and never satisfies pipeline determinism. */
    corpusReloadDeterminismPassed: boolean;
    corpusReloadDeterminismRuns: number;
  };
  networkIsolationAudit?: {
    passed: boolean;
    verifiedAt: string;
    source: string;
  };
  nonLiveWriteAudit?: {
    passed: boolean;
    writeCount: number;
    windowStartedAt: string;
    windowEndedAt: string;
    source: string;
  };
}

export interface RolloutGateCheckV2 {
  id: string;
  state: "pass" | "fail" | "unknown";
  observed: string | number | boolean | null;
  required: string;
  reason?: string;
}

export interface RolloutGateV2 {
  earned: boolean;
  checks: readonly RolloutGateCheckV2[];
}

export interface EditorialRolloutStatusV2 {
  schemaVersion: 2;
  kind: "pixymon-v2-rollout-status";
  generatedAt: string;
  timezone: string;
  manualPromotionRequired: true;
  highestEvidenceStage: "none" | "r0" | "r1" | "r2";
  repository: { currentCommit: string | null; verificationTreeClean: boolean | null };
  dataIntegrity: {
    eventLogPresent: boolean;
    metricLogPresent: boolean;
    futureEventCount: number;
    futureMetricCount: number;
    draftWithoutGenerationMetricCount: number;
    reviewedDraftWithoutReviewMetricCount: number;
    publicationWithoutLiveMetricCount: number;
    generationAttemptWithoutFallbackFlagCount: number;
    finalApprovedContractFailureCount: number;
    replayArtifactVerified: boolean | null;
    replayArtifactSha256: string | null;
    replaySourceLedgerSha256: string | null;
    replaySourceLedgerBytes: number | null;
    replaySourceEventCount: number | null;
    replaySourceDraftCount: number | null;
  };
  counts: {
    exportableGeneratedDrafts: number;
    observeDecisions: number;
    reviewedDrafts: number;
    approvedDrafts: number;
    editedDrafts: number;
    rejectedDrafts: number;
    noEditApprovedDrafts: number;
    factCheckedDrafts: number;
    observedFactualErrors: number;
    observedMalformedErrors: number;
    observedFallbackIncidents: number;
    observedNonLiveWriteIncidents: number;
  };
  windows: {
    observeDecisionDays: number;
    observeFirstAt: string | null;
    observeLastAt: string | null;
    reviewDays: number;
    reviewFirstAt: string | null;
    reviewLastAt: string | null;
  };
  rates: {
    approvalRate: number | null;
    noEditAcceptanceRate: number | null;
    observedFactualErrorRate: number | null;
    observedMalformedErrorRate: number | null;
  };
  gates: {
    r0: RolloutGateV2;
    r1: RolloutGateV2;
    r2: RolloutGateV2;
  };
}

export interface BuildEditorialRolloutStatusInputV2 {
  events: readonly EditorialEventV2[];
  metrics: readonly EditorialMetricV2[];
  eventLogPresent: boolean;
  metricLogPresent: boolean;
  now?: Date;
  timezone?: string;
  machineEvidence?: RolloutMachineEvidenceV2;
  replayArtifactVerification?: {
    artifactSha256: string;
    sourceLedgerSha256: string;
    collectionEpoch: string;
    verified: boolean;
  };
  humanEvaluation?: BlindEvaluationReportV2;
  r1Promotion?: VerifiedEditorialR1BoundaryV2;
  githubNetworkIsolation?: GitHubNetworkIsolationVerificationV2;
  currentCommit?: string;
  workingTreeClean?: boolean;
}

function requiredText(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${field} is required`);
  return text;
}

function instant(value: unknown, field: string): string {
  const text = requiredText(value, field);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${field} must be a valid instant`);
  return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(input: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const extras = Object.keys(input).filter((key) => !allowed.includes(key));
  if (extras.length > 0) throw new Error(`${field} has unsupported fields: ${extras.join(",")}`);
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be boolean`);
  return value;
}

function sha256Hex(value: unknown, field: string): string {
  const text = requiredText(value, field);
  if (!/^[a-f0-9]{64}$/.test(text)) throw new Error(`${field} must be SHA-256 hex`);
  return text;
}

function parseMetric(value: unknown, index: number): EditorialMetricV2 {
  if (!isRecord(value)) throw new Error(`metric[${index}] must be an object`);
  if (value.schemaVersion !== 2 || !METRIC_TYPES.includes(value.type as EditorialMetricTypeV2)) {
    throw new Error(`metric[${index}] has an unsupported schema or type`);
  }
  if (!['observe', 'paper', 'live'].includes(String(value.mode))) {
    throw new Error(`metric[${index}].mode is invalid`);
  }
  const details = value.details;
  if (typeof details !== "undefined" && !isRecord(details)) {
    throw new Error(`metric[${index}].details must be an object`);
  }
  return {
    schemaVersion: 2,
    type: value.type as EditorialMetricTypeV2,
    timestamp: instant(value.timestamp, `metric[${index}].timestamp`),
    runId: requiredText(value.runId, `metric[${index}].runId`),
    actionId: requiredText(value.actionId, `metric[${index}].actionId`),
    mode: value.mode as EditorialMetricV2["mode"],
    stage: requiredText(value.stage, `metric[${index}].stage`),
    outcome: requiredText(value.outcome, `metric[${index}].outcome`),
    reason: typeof value.reason === "undefined"
      ? undefined
      : requiredText(value.reason, `metric[${index}].reason`),
    details: details as EditorialMetricV2["details"],
  };
}

export function readEditorialMetricsForRolloutV2(metricLogPath: string): EditorialMetricV2[] {
  const target = path.resolve(requiredText(metricLogPath, "metric log path"));
  if (!fs.existsSync(target)) throw new Error("editorial metric log not found");
  const rows: EditorialMetricV2[] = [];
  const raw = fs.readFileSync(target, "utf8");
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      rows.push(parseMetric(JSON.parse(line) as unknown, index));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`invalid editorial metric at line ${index + 1}: ${message}`);
    }
  }
  return rows;
}

function parseMachineEvidence(value: unknown): RolloutMachineEvidenceV2 {
  if (!isRecord(value) || value.schemaVersion !== 2 || value.kind !== "pixymon-v2-rollout-evidence") {
    throw new Error("unsupported rollout evidence schema");
  }
  onlyKeys(value, [
    "schemaVersion",
    "kind",
    "offlineVerify",
    "realReplay",
    "networkIsolationAudit",
    "nonLiveWriteAudit",
  ], "rollout evidence");
  const output: RolloutMachineEvidenceV2 = {
    schemaVersion: 2,
    kind: "pixymon-v2-rollout-evidence",
  };
  if (typeof value.offlineVerify !== "undefined") {
    if (!isRecord(value.offlineVerify)) throw new Error("offlineVerify must be an object");
    const row = value.offlineVerify;
    onlyKeys(row, [
      "passed",
      "offlineContractMode",
      "completedAt",
      "commit",
      "pipelineDeterminismScope",
      "pipelineDeterminismPassed",
      "pipelineDeterminismRuns",
    ], "offlineVerify");
    if (row.pipelineDeterminismScope !== "synthetic-contract") {
      throw new Error("offlineVerify.pipelineDeterminismScope is invalid");
    }
    output.offlineVerify = {
      passed: booleanValue(row.passed, "offlineVerify.passed"),
      offlineContractMode: booleanValue(
        row.offlineContractMode,
        "offlineVerify.offlineContractMode"
      ),
      completedAt: instant(row.completedAt, "offlineVerify.completedAt"),
      commit: requiredText(row.commit, "offlineVerify.commit"),
      pipelineDeterminismScope: "synthetic-contract",
      pipelineDeterminismPassed: booleanValue(
        row.pipelineDeterminismPassed,
        "offlineVerify.pipelineDeterminismPassed"
      ),
      pipelineDeterminismRuns: nonnegativeInteger(
        row.pipelineDeterminismRuns,
        "offlineVerify.pipelineDeterminismRuns"
      ),
    };
  }
  if (typeof value.realReplay !== "undefined") {
    if (!isRecord(value.realReplay)) throw new Error("realReplay must be an object");
    const row = value.realReplay;
    onlyKeys(row, [
      "passed",
      "candidateCount",
      "evaluatedAt",
      "artifactKind",
      "artifactSha256",
      "sourceLedgerSha256",
      "sourceLedgerBytes",
      "sourceEventCount",
      "sourceDraftCount",
      "collectionEpoch",
      "epochDraftCount",
      "excludedDraftCount",
      "selectionPolicy",
      "textProvenance",
      "corpusReloadDeterminismPassed",
      "corpusReloadDeterminismRuns",
    ], "realReplay");
    if (
      row.artifactKind !== "pixymon-v2-runtime-replay-export" ||
      row.selectionPolicy !== "first-created-in-epoch" ||
      row.textProvenance !== "generated"
    ) {
      throw new Error("realReplay lineage contract is invalid");
    }
    output.realReplay = {
      passed: booleanValue(row.passed, "realReplay.passed"),
      candidateCount: nonnegativeInteger(row.candidateCount, "realReplay.candidateCount"),
      evaluatedAt: instant(row.evaluatedAt, "realReplay.evaluatedAt"),
      artifactKind: "pixymon-v2-runtime-replay-export",
      artifactSha256: sha256Hex(row.artifactSha256, "realReplay.artifactSha256"),
      sourceLedgerSha256: sha256Hex(
        row.sourceLedgerSha256,
        "realReplay.sourceLedgerSha256"
      ),
      sourceLedgerBytes: nonnegativeInteger(row.sourceLedgerBytes, "realReplay.sourceLedgerBytes"),
      sourceEventCount: nonnegativeInteger(row.sourceEventCount, "realReplay.sourceEventCount"),
      sourceDraftCount: nonnegativeInteger(row.sourceDraftCount, "realReplay.sourceDraftCount"),
      collectionEpoch: requiredText(row.collectionEpoch, "realReplay.collectionEpoch"),
      epochDraftCount: nonnegativeInteger(row.epochDraftCount, "realReplay.epochDraftCount"),
      excludedDraftCount: nonnegativeInteger(row.excludedDraftCount, "realReplay.excludedDraftCount"),
      selectionPolicy: "first-created-in-epoch",
      textProvenance: "generated",
      corpusReloadDeterminismPassed: booleanValue(
        row.corpusReloadDeterminismPassed,
        "realReplay.corpusReloadDeterminismPassed"
      ),
      corpusReloadDeterminismRuns: nonnegativeInteger(
        row.corpusReloadDeterminismRuns,
        "realReplay.corpusReloadDeterminismRuns"
      ),
    };
    if (
      output.realReplay.sourceDraftCount > output.realReplay.sourceEventCount ||
      output.realReplay.epochDraftCount > output.realReplay.sourceDraftCount ||
      output.realReplay.excludedDraftCount !==
        output.realReplay.sourceDraftCount - output.realReplay.epochDraftCount ||
      output.realReplay.candidateCount > output.realReplay.epochDraftCount
    ) {
      throw new Error("realReplay lineage counts are inconsistent");
    }
  }
  if (typeof value.networkIsolationAudit !== "undefined") {
    if (!isRecord(value.networkIsolationAudit)) {
      throw new Error("networkIsolationAudit must be an object");
    }
    const row = value.networkIsolationAudit;
    onlyKeys(row, ["passed", "verifiedAt", "source"], "networkIsolationAudit");
    output.networkIsolationAudit = {
      passed: booleanValue(row.passed, "networkIsolationAudit.passed"),
      verifiedAt: instant(row.verifiedAt, "networkIsolationAudit.verifiedAt"),
      source: requiredText(row.source, "networkIsolationAudit.source"),
    };
  }
  if (typeof value.nonLiveWriteAudit !== "undefined") {
    if (!isRecord(value.nonLiveWriteAudit)) throw new Error("nonLiveWriteAudit must be an object");
    const row = value.nonLiveWriteAudit;
    onlyKeys(
      row,
      ["passed", "writeCount", "windowStartedAt", "windowEndedAt", "source"],
      "nonLiveWriteAudit"
    );
    output.nonLiveWriteAudit = {
      passed: booleanValue(row.passed, "nonLiveWriteAudit.passed"),
      writeCount: nonnegativeInteger(row.writeCount, "nonLiveWriteAudit.writeCount"),
      windowStartedAt: instant(row.windowStartedAt, "nonLiveWriteAudit.windowStartedAt"),
      windowEndedAt: instant(row.windowEndedAt, "nonLiveWriteAudit.windowEndedAt"),
      source: requiredText(row.source, "nonLiveWriteAudit.source"),
    };
    if (
      Date.parse(output.nonLiveWriteAudit.windowEndedAt) <
      Date.parse(output.nonLiveWriteAudit.windowStartedAt)
    ) {
      throw new Error("nonLiveWriteAudit window is inverted");
    }
  }
  if (
    !output.offlineVerify &&
    !output.realReplay &&
    !output.networkIsolationAudit &&
    !output.nonLiveWriteAudit
  ) {
    throw new Error("rollout evidence must contain at least one evidence record");
  }
  return output;
}

function nonnegativeInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return Number(value);
}

export function readRolloutMachineEvidenceV2(pathname: string): RolloutMachineEvidenceV2 {
  return parseMachineEvidence(
    JSON.parse(fs.readFileSync(path.resolve(pathname), "utf8")) as unknown
  );
}

function calendarDay(value: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

function distinctDays(values: readonly string[], timezone: string): number {
  return new Set(values.map((value) => calendarDay(value, timezone))).size;
}

function bounds(values: readonly string[]): { first: string | null; last: string | null } {
  if (values.length === 0) return { first: null, last: null };
  const sorted = [...values].sort((left, right) => Date.parse(left) - Date.parse(right));
  return { first: sorted[0], last: sorted[sorted.length - 1] };
}

function elapsedMs(window: { first: string | null; last: string | null }): number {
  return window.first && window.last ? Date.parse(window.last) - Date.parse(window.first) : 0;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function pass(id: string, observed: RolloutGateCheckV2["observed"], required: string): RolloutGateCheckV2 {
  return { id, state: "pass", observed, required };
}

function fail(
  id: string,
  observed: RolloutGateCheckV2["observed"],
  required: string,
  reason?: string
): RolloutGateCheckV2 {
  return { id, state: "fail", observed, required, reason };
}

function unknown(id: string, required: string, reason: string): RolloutGateCheckV2 {
  return { id, state: "unknown", observed: null, required, reason };
}

function gate(checks: readonly RolloutGateCheckV2[]): RolloutGateV2 {
  return { earned: checks.every((check) => check.state === "pass"), checks };
}

function normalizedTags(tags: readonly string[]): Set<string> {
  return new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean));
}

function hasAny(tags: ReadonlySet<string>, candidates: ReadonlySet<string>): boolean {
  for (const tag of tags) if (candidates.has(tag)) return true;
  return false;
}

function knownNonLiveWrite(metric: EditorialMetricV2): boolean {
  if (metric.type !== "dispatch_decision" || metric.mode === "live") return false;
  return metric.outcome === "published" ||
    Boolean(metric.details?.externalPostId) ||
    /(?:x-dispatch-outcome-unresolved|publication-commit-unresolved)/.test(metric.reason || "");
}

function eventInstants(event: EditorialEventV2): string[] {
  if (event.type === "draft-created") {
    return [
      event.recordedAt,
      event.draft.createdAt,
      ...event.draft.facts.flatMap((fact) => [
        fact.source.observedAt,
        ...(fact.source.publishedAt ? [fact.source.publishedAt] : []),
      ]),
    ];
  }
  if (event.type === "review-recorded") {
    return [event.recordedAt, event.review.reviewedAt];
  }
  if (event.type === "dispatch-prepared") {
    return [event.recordedAt, event.intent.preparedAt, event.intent.recordedAt];
  }
  if (event.type === "draft-published") {
    return [event.recordedAt, event.publication.publishedAt];
  }
  return [
    event.recordedAt,
    event.resolution.resolvedAt,
    ...(event.resolution.observedAt ? [event.resolution.observedAt] : []),
  ];
}

export function buildEditorialRolloutStatusV2(
  input: BuildEditorialRolloutStatusInputV2
): EditorialRolloutStatusV2 {
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("rollout status clock is invalid");
  const timezone = requiredText(input.timezone ?? "Asia/Seoul", "timezone");
  calendarDay(now.toISOString(), timezone);
  const ledger = foldEditorialEventsV2(input.events);
  const metrics = input.metrics.map((metric, index) => parseMetric(metric, index));
  const nowMs = now.getTime();
  const verify = input.machineEvidence?.offlineVerify;
  const rolloutStartMs = verify ? Date.parse(verify.completedAt) : Number.NEGATIVE_INFINITY;
  const promotion = input.r1Promotion;
  const promotionValid = Boolean(
    promotion && input.workingTreeClean && input.currentCommit &&
    promotion.currentCommit === input.currentCommit &&
    /^[a-f0-9]{64}$/.test(promotion.sourceStatusSha256) &&
    Number.isFinite(Date.parse(promotion.statusGeneratedAt)) &&
    Date.parse(promotion.statusGeneratedAt) >= rolloutStartMs &&
    Date.parse(promotion.boundaryAt) >= Date.parse(promotion.statusGeneratedAt) &&
    Date.parse(promotion.boundaryAt) <= nowMs
  );
  // Without a promotion, review figures remain descriptive. Supplied but
  // invalid boundaries must never credit reviews from before promotion.
  const reviewStartMs = promotion
    ? promotionValid ? Date.parse(promotion.boundaryAt) : Number.POSITIVE_INFINITY
    : rolloutStartMs;
  const operationalMetrics = metrics.filter(
    (metric) => Date.parse(metric.timestamp) >= rolloutStartMs
  );
  const futureEventCount = input.events.filter((event) =>
    eventInstants(event).some((value) => Date.parse(value) > nowMs)
  ).length;
  const futureMetricCount = metrics.filter((metric) => Date.parse(metric.timestamp) > nowMs).length;

  const observeDecisionByAction = new Map<string, string>();
  for (const metric of operationalMetrics) {
    if (metric.type !== "planning_decision" || metric.mode !== "observe") continue;
    if (Date.parse(metric.timestamp) < rolloutStartMs) continue;
    const prior = observeDecisionByAction.get(metric.actionId);
    if (!prior || Date.parse(metric.timestamp) < Date.parse(prior)) {
      observeDecisionByAction.set(metric.actionId, metric.timestamp);
    }
  }
  const observeDecisionTimes = [...observeDecisionByAction.values()];
  const observeBounds = bounds(observeDecisionTimes);

  const states = [...ledger.drafts.values()];
  const exportableGeneratedDraftCount = states.filter(
    (state) => state.draft.collectionEpoch === EDITORIAL_COLLECTION_EPOCH_V2 &&
      Boolean(state.draft.generatedPayload && state.draft.lane)
  ).length;
  const reviewRecordedAt = new Map(
    input.events.flatMap((event) =>
      event.type === "review-recorded" ? [[event.review.id, event.recordedAt] as const] : []
    )
  );
  const operationalReviewCountByDraft = new Map<string, number>();
  const operationalDraftIds = new Set<string>();
  const operationalPublicationIds = new Set<string>();
  for (const event of input.events) {
    if (Date.parse(event.recordedAt) < rolloutStartMs) continue;
    if (event.type === "draft-created") operationalDraftIds.add(event.draft.id);
    if (event.type === "review-recorded") {
      operationalReviewCountByDraft.set(
        event.review.draftId,
        (operationalReviewCountByDraft.get(event.review.draftId) ?? 0) + 1
      );
    }
    if (event.type === "draft-published") operationalPublicationIds.add(event.publication.draftId);
  }
  const terminalReviews = states.flatMap((state) => {
    const review = state.reviews.at(-1);
    if (!review) return [];
    const recordedAt = reviewRecordedAt.get(review.id);
    if (!recordedAt) throw new Error(`review event timestamp missing: ${review.id}`);
    const createdEvent = input.events.find(
      (event) => event.type === "draft-created" && event.draft.id === state.draft.id
    );
    return Date.parse(recordedAt) >= reviewStartMs &&
      (!promotion || (createdEvent && Date.parse(createdEvent.recordedAt) >= reviewStartMs))
      ? [{ state, review }] : [];
  });
  const reviewedStates = terminalReviews.map(({ state }) => state);
  const approvedStates = reviewedStates.filter((state) => state.reviewStatus === "approved");
  const editedStates = reviewedStates.filter((state) =>
    state.reviews.some((review) => review.action === "edit")
  );
  const rejectedStates = reviewedStates.filter((state) => state.reviewStatus === "rejected");
  const noEditApprovedStates = approvedStates.filter((state) =>
    state.reviews.every((review) => review.action !== "edit")
  );
  const reviewTimes = terminalReviews.map(({ review }) => {
    const recordedAt = reviewRecordedAt.get(review.id);
    if (!recordedAt) throw new Error(`review event timestamp missing: ${review.id}`);
    return recordedAt;
  });
  const reviewBounds = bounds(reviewTimes);
  const factCheckedStates = terminalReviews.filter(({ review }) =>
    normalizedTags(review.reasonTags).has(FACT_CHECKED_TAG)
  );
  const languageCheckedStates = terminalReviews.filter(({ review }) =>
    normalizedTags(review.reasonTags).has(LANGUAGE_CHECKED_TAG)
  );
  const factualErrorStates = terminalReviews.filter(({ state }) =>
    state.reviews.some((review) => hasAny(normalizedTags(review.reasonTags), FACT_ERROR_TAGS))
  );
  const malformedErrorStates = terminalReviews.filter(({ state }) =>
    state.reviews.some((review) => hasAny(normalizedTags(review.reasonTags), MALFORMED_TAGS))
  );
  const finalApprovedContractFailureCount = approvedStates.filter((state) => {
    const fact = state.draft.facts[0];
    if (!fact) return true;
    const isGeneratedCopy = state.publishText === state.draft.draft;
    const usedFactIds = isGeneratedCopy
      ? state.draft.generatedPayload?.usedFactIds
      : state.draft.factIds;
    if (!usedFactIds) return true;
    return !validateEditorialDraftV2({
      text: state.publishText,
      subject: state.draft.subject,
      displayValue: fact.metric.raw,
      factIds: state.draft.factIds,
      usedFactIds,
      allowedNumericValues: [fact.metric.period, "24시간", "72시간"],
      allowedNamedTokens: [
        ...fact.metric.name.split(/[^a-zA-Z0-9]+/).filter(Boolean).map((token) => token.toUpperCase()),
        fact.metric.unit,
      ],
      sourceTimeToken: formatEvidenceSourceTimeV2(fact.source.observedAt),
      requireJudgment: true,
      metricName: fact.metric.name,
      metricDirection: inferMetricDirectionV2(fact.metric.name, fact.metric.raw, fact.metric.value),
      forbidFutureRecheck: true,
    }).ok;
  }).length;

  const draftedMetrics = new Set(
    operationalMetrics
      .filter((metric) => metric.type === "generation_attempt" && metric.outcome === "drafted")
      .map((metric) => metric.actionId)
  );
  const reviewMetricCountByDraft = new Map<string, number>();
  for (const metric of operationalMetrics) {
    if (metric.type !== "review_decision") continue;
    const draftId = String(metric.details?.draftId || metric.actionId);
    reviewMetricCountByDraft.set(draftId, (reviewMetricCountByDraft.get(draftId) ?? 0) + 1);
  }
  const livePublishedMetrics = new Set(
    operationalMetrics
      .filter(
        (metric) =>
          metric.type === "dispatch_decision" &&
          metric.mode === "live" &&
          metric.outcome === "published"
      )
      .map((metric) => String(metric.details?.draftId || metric.actionId))
  );
  const draftWithoutGenerationMetricCount = states.filter(
    (state) => operationalDraftIds.has(state.draft.id) && !draftedMetrics.has(state.draft.id)
  ).length;
  const reviewedDraftWithoutReviewMetricCount = reviewedStates.filter(
    (state) =>
      (reviewMetricCountByDraft.get(state.draft.id) ?? 0) <
      (operationalReviewCountByDraft.get(state.draft.id) ?? 0)
  ).length;
  const publicationWithoutLiveMetricCount = states.filter(
    (state) => operationalPublicationIds.has(state.draft.id) && !livePublishedMetrics.has(state.draft.id)
  ).length;
  const observedNonLiveWriteIncidents = operationalMetrics.filter(knownNonLiveWrite).length;
  const rolloutGenerationAttempts = operationalMetrics.filter(
    (metric) => metric.type === "generation_attempt"
  );
  const generationAttemptWithoutFallbackFlagCount = rolloutGenerationAttempts.filter(
    (metric) => typeof metric.details?.fallbackUsed !== "boolean"
  ).length;
  const observedFallbackIncidents = rolloutGenerationAttempts.filter(
    (metric) => metric.details?.fallbackUsed === true
  ).length;

  const dataLogsCheck = input.eventLogPresent && input.metricLogPresent
    ? pass("runtime-logs", true, "event and metric logs present")
    : unknown("runtime-logs", "event and metric logs present", "one or more runtime logs are missing");
  const noFutureData = futureEventCount + futureMetricCount === 0
    ? pass("no-future-records", 0, "0")
    : fail("no-future-records", futureEventCount + futureMetricCount, "0");
  const telemetryLinked =
    draftWithoutGenerationMetricCount + reviewedDraftWithoutReviewMetricCount + publicationWithoutLiveMetricCount;

  const replay = input.machineEvidence?.realReplay;
  const human = input.humanEvaluation;
  const evidenceHasFutureTime = Boolean(
    (verify && Date.parse(verify.completedAt) > nowMs) ||
    (replay && Date.parse(replay.evaluatedAt) > nowMs) ||
    (input.githubNetworkIsolation?.state === "pass" &&
      Date.parse(input.githubNetworkIsolation.completedAt) > nowMs) ||
    (input.machineEvidence?.networkIsolationAudit &&
      Date.parse(input.machineEvidence.networkIsolationAudit.verifiedAt) > nowMs) ||
    (input.machineEvidence?.nonLiveWriteAudit &&
      Date.parse(input.machineEvidence.nonLiveWriteAudit.windowEndedAt) > nowMs)
  );
  const currentCommit = String(input.currentCommit || "").trim();
  const networkAudit = input.machineEvidence?.networkIsolationAudit;
  const githubNetworkIsolation = input.githubNetworkIsolation;
  const githubNetworkBindingValid = Boolean(
    githubNetworkIsolation?.state === "pass" &&
      currentCommit &&
      githubNetworkIsolation.headSha === currentCommit.toLowerCase() &&
      githubNetworkIsolation.workflowPath === ".github/workflows/verify.yml" &&
      Number.isInteger(githubNetworkIsolation.runId) &&
      githubNetworkIsolation.runId > 0 &&
      Number.isInteger(githubNetworkIsolation.runAttempt) &&
      githubNetworkIsolation.runAttempt > 0 &&
      Number.isInteger(githubNetworkIsolation.jobId) &&
      githubNetworkIsolation.jobId > 0 &&
      Number.isFinite(Date.parse(githubNetworkIsolation.completedAt))
  );
  const replayArtifact = input.replayArtifactVerification;
  const replayArtifactMatches = Boolean(
    replay &&
      replayArtifact?.verified &&
      replayArtifact.artifactSha256 === replay.artifactSha256 &&
      replayArtifact.sourceLedgerSha256 === replay.sourceLedgerSha256 &&
      replayArtifact.collectionEpoch === replay.collectionEpoch
  );
  const r0 = gate([
    verify
      ? verify.passed && verify.offlineContractMode
        ? pass("offline-contract-verify", true, "verify passed with external-call test guards")
        : fail("offline-contract-verify", false, "verify passed with external-call test guards")
      : unknown(
          "offline-contract-verify",
          "verify passed with external-call test guards",
          "verify evidence not supplied"
        ),
    networkAudit && !networkAudit.passed
      ? fail("network-isolation", false, "trusted GitHub push/main workflow verification")
      : githubNetworkIsolation?.state === "pass"
        ? githubNetworkBindingValid
          ? pass(
              "network-isolation",
              `run:${githubNetworkIsolation.runId}/attempt:${githubNetworkIsolation.runAttempt}`,
              "trusted GitHub push/main workflow verification"
            )
          : fail(
              "network-isolation",
              githubNetworkIsolation.reason,
              "trusted GitHub push/main workflow verification",
              "GitHub verification is not bound to the current commit or complete run lineage"
            )
        : githubNetworkIsolation?.state === "fail"
          ? fail(
              "network-isolation",
              githubNetworkIsolation.reason,
              "trusted GitHub push/main workflow verification"
            )
          : githubNetworkIsolation?.state === "unknown"
            ? unknown(
                "network-isolation",
                "trusted GitHub push/main workflow verification",
                githubNetworkIsolation.reason
              )
            : networkAudit?.passed
              ? unknown(
                  "network-isolation",
                  "trusted GitHub push/main workflow verification",
                  "audit metadata is informational; use --github-ci-repo for a live server verification"
                )
      : unknown(
          "network-isolation",
          "trusted GitHub push/main workflow verification",
          "TEST flags do not prove that the process had no network access; use --github-ci-repo"
        ),
    verify && currentCommit && typeof input.workingTreeClean === "boolean"
      ? verify.commit === currentCommit && input.workingTreeClean
        ? pass("verified-current-tree", true, "evidence commit equals clean current HEAD")
        : fail(
            "verified-current-tree",
            false,
            "evidence commit equals clean current HEAD",
            input.workingTreeClean ? "verification belongs to another commit" : "working tree is dirty"
          )
      : unknown(
          "verified-current-tree",
          "evidence commit equals clean current HEAD",
          "current commit or working-tree state was not supplied"
        ),
    evidenceHasFutureTime
      ? fail("evidence-not-from-future", false, "all evidence timestamps <= status time")
      : pass("evidence-not-from-future", true, "all evidence timestamps <= status time"),
    verify
      ? verify.pipelineDeterminismPassed && verify.pipelineDeterminismRuns >= 100
        ? pass("pipeline-determinism", verify.pipelineDeterminismRuns, ">=100 identical pipeline runs")
        : fail("pipeline-determinism", verify.pipelineDeterminismRuns, ">=100 identical pipeline runs")
      : unknown("pipeline-determinism", ">=100 identical pipeline runs", "pipeline evidence not supplied"),
  ]);

  // Quality evidence is collected during shadow observation/review, not required
  // before observation can start. It remains mandatory before approved live.
  const qualityChecks = [
    replay
      ? replay.passed && replay.candidateCount === 100 && replay.collectionEpoch === EDITORIAL_COLLECTION_EPOCH_V2
        ? pass("real-replay", replay.candidateCount, "100 exported runtime replay rows, corpus gates passed")
        : fail("real-replay", replay.candidateCount, "100 exported runtime replay rows, corpus gates passed")
      : unknown(
          "real-replay",
          "100 exported runtime replay rows, corpus gates passed",
          `no evaluated replay supplied; ${exportableGeneratedDraftCount} generated drafts are exportable`
        ),
    replay
      ? replayArtifact
        ? replayArtifactMatches
          ? pass("replay-lineage", replay.artifactSha256, "artifact digest and ledger prefix verified")
          : fail(
              "replay-lineage",
              replayArtifact.artifactSha256,
              "artifact digest and ledger prefix verified"
            )
        : unknown(
            "replay-lineage",
            "artifact digest and ledger prefix verified",
            "replay artifact was not supplied to status"
          )
      : unknown(
          "replay-lineage",
          "artifact digest and ledger prefix verified",
          "real replay evidence not supplied"
        ),
    replay
      ? replay.corpusReloadDeterminismPassed && replay.corpusReloadDeterminismRuns >= 100
        ? pass(
            "corpus-reload-determinism",
            replay.corpusReloadDeterminismRuns,
            ">=100 identical parses of the immutable replay file (not pipeline reruns)"
          )
        : fail(
            "corpus-reload-determinism",
            replay.corpusReloadDeterminismRuns,
            ">=100 identical parses of the immutable replay file (not pipeline reruns)"
          )
      : unknown(
          "corpus-reload-determinism",
          ">=100 identical parses of the immutable replay file (not pipeline reruns)",
          "real replay evidence not supplied"
        ),
    human
      ? human.complete && human.passed
        ? pass("two-reader-blind-evaluation", true, "36 pairs, two readers, all promotion thresholds")
        : fail(
            "two-reader-blind-evaluation",
            false,
            "36 pairs, two readers, all promotion thresholds",
            [...human.incompleteReasons, ...human.gateFailures].join(", ")
          )
      : unknown(
          "two-reader-blind-evaluation",
          "36 pairs, two readers, all promotion thresholds",
          "human evaluation not supplied"
        ),
    human && replay && replayArtifact && verify && currentCommit
      ? replayArtifactMatches && input.workingTreeClean && verify.commit === currentCommit &&
        human.lineage?.verifiedCommit === currentCommit &&
        human.lineage.replayArtifactSha256 === replay.artifactSha256 &&
        human.lineage.sourceLedgerSha256 === replay.sourceLedgerSha256 &&
        human.lineage.collectionEpoch === replay.collectionEpoch
        ? pass("human-evaluation-lineage", human.packId, "36 V2 sides bound to the current replay artifact and verified commit")
        : fail("human-evaluation-lineage", false, "36 V2 sides bound to the current replay artifact and verified commit")
      : unknown(
          "human-evaluation-lineage",
          "36 V2 sides bound to the current replay artifact and verified commit",
          "bound human evaluation, replay artifact, or current verification evidence is missing"
        ),
  ];

  const writeAudit = input.machineEvidence?.nonLiveWriteAudit;
  const auditCoversWindow = Boolean(
    writeAudit &&
      observeBounds.first &&
      observeBounds.last &&
      Date.parse(writeAudit.windowStartedAt) <= Date.parse(observeBounds.first) &&
      Date.parse(writeAudit.windowEndedAt) >= Date.parse(observeBounds.last)
  );
  const r1 = gate([
    r0.earned
      ? pass("r0-prerequisite", true, "R0 earned before observe evidence window")
      : unknown(
          "r0-prerequisite",
          "R0 earned before observe evidence window",
          "R0 is incomplete or failed"
        ),
    dataLogsCheck,
    noFutureData,
    observeDecisionTimes.length >= 30
      ? pass("observe-decisions", observeDecisionTimes.length, ">=30 unique actions")
      : fail("observe-decisions", observeDecisionTimes.length, ">=30 unique actions"),
    distinctDays(observeDecisionTimes, timezone) >= 7
      ? pass("observe-days", distinctDays(observeDecisionTimes, timezone), ">=7 distinct calendar days")
      : fail("observe-days", distinctDays(observeDecisionTimes, timezone), ">=7 distinct calendar days"),
    elapsedMs(observeBounds) >= 7 * 24 * 60 * 60 * 1000
      ? pass("observe-elapsed-time", elapsedMs(observeBounds), ">=7 full 24-hour periods")
      : fail("observe-elapsed-time", elapsedMs(observeBounds), ">=7 full 24-hour periods"),
    observedNonLiveWriteIncidents === 0
      ? pass("known-non-live-write-incidents", 0, "0")
      : fail("known-non-live-write-incidents", observedNonLiveWriteIncidents, "0"),
    writeAudit
      ? !writeAudit.passed || writeAudit.writeCount > 0
        ? fail(
            "non-live-write-audit",
            writeAudit.writeCount,
            "trusted zero-write attestation covering the observe window"
          )
        : unknown(
            "non-live-write-audit",
            "trusted zero-write attestation covering the observe window",
            auditCoversWindow
              ? "audit metadata is informational until a trusted artifact verifier is integrated"
              : "audit does not cover the observed decision window"
          )
      : unknown(
          "non-live-write-audit",
          "trusted zero-write attestation covering the observe window",
          "absence of dispatch metrics is not proof of zero external writes"
        ),
    telemetryLinked === 0
      ? pass("telemetry-links", 0, "0 unlinked draft/review/publication records")
      : fail("telemetry-links", telemetryLinked, "0 unlinked draft/review/publication records"),
    observedFallbackIncidents === 0
      ? pass("fallback-incidents", 0, "0")
      : fail("fallback-incidents", observedFallbackIncidents, "0"),
    generationAttemptWithoutFallbackFlagCount === 0
      ? pass("fallback-telemetry-complete", 0, "all generation attempts declare fallbackUsed")
      : unknown(
          "fallback-telemetry-complete",
          "all generation attempts declare fallbackUsed",
          `${generationAttemptWithoutFallbackFlagCount} generation attempts omit fallbackUsed`
        ),
  ]);

  const noEditAcceptanceRate = ratio(noEditApprovedStates.length, reviewedStates.length);
  const allFinalTextsFactChecked =
    reviewedStates.length > 0 && factCheckedStates.length === reviewedStates.length;
  const allFinalTextsLanguageChecked =
    reviewedStates.length > 0 && languageCheckedStates.length === reviewedStates.length;
  const r2 = gate([
    ...qualityChecks,
    r1.earned
      ? pass("r1-prerequisite", true, "R1 earned before review evidence window")
      : unknown(
          "r1-prerequisite",
          "R1 earned before review evidence window",
          "R1 is incomplete or failed"
        ),
    promotion
      ? promotionValid
        ? pass("r1-promotion-boundary", promotion.boundaryAt, "review drafts and decisions recorded after verified manual R1 promotion")
        : fail("r1-promotion-boundary", promotion.boundaryAt, "review drafts and decisions recorded after verified manual R1 promotion")
      : unknown(
          "r1-promotion-boundary",
          "review drafts and decisions recorded after verified manual R1 promotion",
          "manual R1 promotion artifact not supplied; review evidence is descriptive only"
        ),
    dataLogsCheck,
    noFutureData,
    reviewedStates.length >= 30
      ? pass("reviewed-drafts", reviewedStates.length, ">=30 unique drafts")
      : fail("reviewed-drafts", reviewedStates.length, ">=30 unique drafts"),
    distinctDays(reviewTimes, timezone) >= 14
      ? pass("review-days", distinctDays(reviewTimes, timezone), ">=14 distinct calendar days")
      : fail("review-days", distinctDays(reviewTimes, timezone), ">=14 distinct calendar days"),
    elapsedMs(reviewBounds) >= 14 * 24 * 60 * 60 * 1000
      ? pass("review-elapsed-time", elapsedMs(reviewBounds), ">=14 full 24-hour periods")
      : fail("review-elapsed-time", elapsedMs(reviewBounds), ">=14 full 24-hour periods"),
    allFinalTextsFactChecked
      ? pass("fact-check-coverage", factCheckedStates.length, "explicit fact-checked tag on every final review")
      : unknown(
          "fact-check-coverage",
          "explicit fact-checked tag on every final review",
          `${factCheckedStates.length}/${reviewedStates.length} final reviews carry fact-checked`
        ),
    factualErrorStates.length > 0
      ? fail("factual-errors", factualErrorStates.length, "0")
      : allFinalTextsFactChecked
        ? pass("factual-errors", 0, "0")
        : unknown(
            "factual-errors",
            "0",
            "absence of an error tag is not proof until every final text is explicitly fact-checked"
          ),
    allFinalTextsLanguageChecked
      ? pass(
          "language-check-coverage",
          languageCheckedStates.length,
          "explicit language-checked tag on every final review"
        )
      : unknown(
          "language-check-coverage",
          "explicit language-checked tag on every final review",
          `${languageCheckedStates.length}/${reviewedStates.length} final reviews carry language-checked`
        ),
    malformedErrorStates.length > 0
      ? fail("malformed-errors", malformedErrorStates.length, "0")
      : allFinalTextsLanguageChecked
        ? pass("malformed-errors", 0, "0")
        : unknown(
            "malformed-errors",
            "0",
            "absence of an error tag is not proof until every final text is explicitly language-checked"
          ),
    noEditAcceptanceRate === null
      ? unknown("no-edit-acceptance", ">=80% of unique reviewed drafts", "no reviewed drafts")
      : noEditAcceptanceRate >= 0.8
        ? pass("no-edit-acceptance", noEditAcceptanceRate, ">=80% of unique reviewed drafts")
        : fail("no-edit-acceptance", noEditAcceptanceRate, ">=80% of unique reviewed drafts"),
    finalApprovedContractFailureCount === 0
      ? pass("final-approved-contract", 0, "0 approved final copies fail the public contract")
      : fail(
          "final-approved-contract",
          finalApprovedContractFailureCount,
          "0 approved final copies fail the public contract"
        ),
    telemetryLinked === 0
      ? pass("telemetry-links", 0, "0 unlinked draft/review/publication records")
      : fail("telemetry-links", telemetryLinked, "0 unlinked draft/review/publication records"),
    observedFallbackIncidents === 0
      ? pass("fallback-incidents", 0, "0")
      : fail("fallback-incidents", observedFallbackIncidents, "0"),
    generationAttemptWithoutFallbackFlagCount === 0
      ? pass("fallback-telemetry-complete", 0, "all generation attempts declare fallbackUsed")
      : unknown(
          "fallback-telemetry-complete",
          "all generation attempts declare fallbackUsed",
          `${generationAttemptWithoutFallbackFlagCount} generation attempts omit fallbackUsed`
        ),
  ]);

  const highestEvidenceStage = r0.earned
    ? r1.earned
      ? r2.earned
        ? "r2"
        : "r1"
      : "r0"
    : "none";

  return {
    schemaVersion: 2,
    kind: "pixymon-v2-rollout-status",
    generatedAt: now.toISOString(),
    timezone,
    manualPromotionRequired: true,
    highestEvidenceStage,
    repository: {
      currentCommit: currentCommit || null,
      verificationTreeClean: input.workingTreeClean ?? null,
    },
    dataIntegrity: {
      eventLogPresent: input.eventLogPresent,
      metricLogPresent: input.metricLogPresent,
      futureEventCount,
      futureMetricCount,
      draftWithoutGenerationMetricCount,
      reviewedDraftWithoutReviewMetricCount,
      publicationWithoutLiveMetricCount,
      generationAttemptWithoutFallbackFlagCount,
      finalApprovedContractFailureCount,
      replayArtifactVerified: replay ? replayArtifactMatches : null,
      replayArtifactSha256: replay?.artifactSha256 ?? null,
      replaySourceLedgerSha256: replay?.sourceLedgerSha256 ?? null,
      replaySourceLedgerBytes: replay?.sourceLedgerBytes ?? null,
      replaySourceEventCount: replay?.sourceEventCount ?? null,
      replaySourceDraftCount: replay?.sourceDraftCount ?? null,
    },
    counts: {
      exportableGeneratedDrafts: exportableGeneratedDraftCount,
      observeDecisions: observeDecisionTimes.length,
      reviewedDrafts: reviewedStates.length,
      approvedDrafts: approvedStates.length,
      editedDrafts: editedStates.length,
      rejectedDrafts: rejectedStates.length,
      noEditApprovedDrafts: noEditApprovedStates.length,
      factCheckedDrafts: factCheckedStates.length,
      observedFactualErrors: factualErrorStates.length,
      observedMalformedErrors: malformedErrorStates.length,
      observedFallbackIncidents,
      observedNonLiveWriteIncidents,
    },
    windows: {
      observeDecisionDays: distinctDays(observeDecisionTimes, timezone),
      observeFirstAt: observeBounds.first,
      observeLastAt: observeBounds.last,
      reviewDays: distinctDays(reviewTimes, timezone),
      reviewFirstAt: reviewBounds.first,
      reviewLastAt: reviewBounds.last,
    },
    rates: {
      approvalRate: ratio(approvedStates.length, reviewedStates.length),
      noEditAcceptanceRate,
      observedFactualErrorRate: ratio(factualErrorStates.length, reviewedStates.length),
      observedMalformedErrorRate: ratio(malformedErrorStates.length, reviewedStates.length),
    },
    gates: { r0, r1, r2 },
  };
}

export function readEditorialRolloutInputsV2(input: {
  eventLogPath: string;
  metricLogPath: string;
}): {
  events: EditorialEventV2[];
  metrics: EditorialMetricV2[];
  eventLogPresent: boolean;
  metricLogPresent: boolean;
} {
  const eventLogPresent = fs.existsSync(input.eventLogPath);
  const metricLogPresent = fs.existsSync(input.metricLogPath);
  return {
    events: eventLogPresent ? readEditorialEventsV2(input.eventLogPath) : [],
    metrics: metricLogPresent ? readEditorialMetricsForRolloutV2(input.metricLogPath) : [],
    eventLogPresent,
    metricLogPresent,
  };
}

export function serializeEditorialRolloutStatusV2(status: EditorialRolloutStatusV2): string {
  return `${JSON.stringify(status, null, 2)}\n`;
}

export function writeNewEditorialRolloutStatusV2(
  outputPath: string,
  status: EditorialRolloutStatusV2
): string {
  const target = path.resolve(requiredText(outputPath, "status output path"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, serializeEditorialRolloutStatusV2(status), {
    encoding: "utf8",
    flag: "wx",
  });
  return target;
}

export function writeNewRolloutMachineEvidenceV2(
  outputPath: string,
  evidence: RolloutMachineEvidenceV2
): string {
  const validated = parseMachineEvidence(evidence);
  const target = path.resolve(requiredText(outputPath, "machine evidence output path"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(validated, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return target;
}
