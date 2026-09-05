import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  parseStrictEditorialReplayExportV2,
  type EditorialReplayExportV2,
  type EditorialReplayFixtureV2,
} from "./replay-export.js";

/** The replay artifact is authoritative for every V2-side field. */
export interface BlindReplayBindingV2 {
  replay: EditorialReplayExportV2;
  replayArtifactSha256: string;
  verifiedCommit: string;
}

export const BLIND_EVALUATION_PAIR_COUNT_V2 = 36;
export const BLIND_EVALUATION_READER_COUNT_V2 = 2;

export const BLIND_SCORE_AXES_V2 = [
  "grounding",
  "clarity",
  "insight",
  "character",
  "memorability",
  "followWorthiness",
  "overall",
] as const;

export type BlindScoreAxisV2 = (typeof BLIND_SCORE_AXES_V2)[number];
export type BlindSideV2 = "A" | "B";
export type BlindScoresV2 = Record<BlindScoreAxisV2, number>;
export type BlindEvaluationLaneV2 = "onchain" | "protocol" | "ecosystem";
export type BlindEvaluationFormatV2 = "bite" | "withhold" | "revisit" | "evolution";

export interface BlindEvidenceV2 {
  subject: string;
  metric: {
    name: string;
    value: number;
    raw: string;
    unit: string;
    period: string;
  };
  source: {
    provider: string;
    url: string;
    observedAt: string;
  };
}

export interface BlindComparisonCaseV2 {
  id: string;
  replayRowId: string;
  baselineText: string;
}

export interface BlindEvaluationLineageV2 {
  replayArtifactSha256: string;
  sourceLedgerSha256: string;
  collectionEpoch: string;
  verifiedCommit: string;
}

export interface BlindPublicEvidenceV2 {
  subject: string;
  metric: BlindEvidenceV2["metric"];
  source: {
    observedAt: string;
  };
}

export interface BlindEvaluationPackV2 {
  schemaVersion: 2;
  kind: "blind-comparison-pack";
  packId: string;
  mappingCommitment: string;
  pairs: readonly {
    pairId: string;
    evidence: BlindPublicEvidenceV2;
    A: { text: string };
    B: { text: string };
  }[];
}

export interface BlindEvaluationMappingV2 {
  schemaVersion: 2;
  kind: "pixymon-v2-blind-mapping";
  packId: string;
  commitmentNonce: string;
  mappingCommitment: string;
  publicPackDigest: string;
  lineage: BlindEvaluationLineageV2;
  pairs: readonly {
    pairId: string;
    sourceCaseId: string;
    replayRowId: string;
    replayRowSha256: string;
    contentFingerprint: string;
    v2Side: BlindSideV2;
    lane: BlindEvaluationLaneV2;
    format: BlindEvaluationFormatV2;
  }[];
}

export interface BlindEvaluationAnnotationV2 {
  packId: string;
  pairId: string;
  reviewerId: string;
  scores: Record<BlindSideV2, BlindScoresV2>;
  preference: BlindSideV2 | "tie";
  publishUnchanged: Record<BlindSideV2, boolean>;
  pixymonIdentified: Record<BlindSideV2, boolean>;
  hardVetoes: Record<BlindSideV2, readonly string[]>;
  reasonTags: Record<BlindSideV2, readonly string[]>;
  editedText?: Partial<Record<BlindSideV2, string>>;
  reviewedAt: string;
}

export interface BlindEvaluationAdjudicationV2 {
  packId: string;
  pairId: string;
  side: BlindSideV2;
  axis: BlindScoreAxisV2;
  adjudicatorId: string;
  resolvedScore: number;
  reason: string;
  adjudicatedAt: string;
}

export interface BlindEvaluationReportV2 {
  schemaVersion: 2;
  kind: "pixymon-v2-blind-report";
  packId: string;
  lineage: BlindEvaluationLineageV2;
  complete: boolean;
  passed: boolean;
  pairCount: number;
  reviewerCount: number;
  annotationCount: number;
  requiredAdjudicationCount: number;
  completedAdjudicationCount: number;
  means: Record<BlindScoreAxisV2, number | null>;
  v2PreferenceRate: number | null;
  publishUnchangedRate: number | null;
  pixymonIdentificationRate: number | null;
  hardVetoCount: number;
  incompleteReasons: readonly string[];
  gateFailures: readonly string[];
}

function requiredText(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${field} is required`);
  return text;
}

function requiredInstant(value: unknown, field: string): string {
  const text = requiredText(value, field);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${field} must be a valid instant`);
  return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  return value;
}

function onlyKeys(input: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const extras = Object.keys(input).filter((key) => !allowed.includes(key));
  if (extras.length > 0) throw new Error(`${field} has unsupported fields: ${extras.join(",")}`);
}

function side(value: unknown, field: string): BlindSideV2 {
  if (value !== "A" && value !== "B") throw new Error(`${field} must be A or B`);
  return value;
}

function lane(value: unknown, field: string): BlindEvaluationLaneV2 {
  if (!['onchain', 'protocol', 'ecosystem'].includes(String(value))) {
    throw new Error(`${field} is invalid`);
  }
  return value as BlindEvaluationLaneV2;
}

function evaluationFormat(value: unknown, field: string): BlindEvaluationFormatV2 {
  if (!['bite', 'withhold', 'revisit', 'evolution'].includes(String(value))) {
    throw new Error(`${field} is invalid`);
  }
  return value as BlindEvaluationFormatV2;
}

function score(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 5) {
    throw new Error(`${field} must be an integer from 1 to 5`);
  }
  return Number(value);
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be boolean`);
  return value;
}

function reviewerPseudonym(value: unknown, field: string): string {
  const text = requiredText(value, field);
  if (text !== "reader-1" && text !== "reader-2") {
    throw new Error(`${field} must be reader-1 or reader-2`);
  }
  return text;
}

function adjudicatorPseudonym(value: unknown, field: string): string {
  const text = requiredText(value, field);
  if (!/^adjudicator-[1-9]\d*$/.test(text)) {
    throw new Error(`${field} must be a pseudonym such as adjudicator-1`);
  }
  return text;
}

function uniqueStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  const values = value.map((item, index) => requiredText(item, `${field}[${index}]`));
  if (new Set(values).size !== values.length) throw new Error(`${field} must be unique`);
  return values;
}

function parseScores(value: unknown, field: string): BlindScoresV2 {
  const input = record(value, field);
  onlyKeys(input, BLIND_SCORE_AXES_V2, field);
  const output = {} as BlindScoresV2;
  for (const axis of BLIND_SCORE_AXES_V2) {
    output[axis] = score(input[axis], `${field}.${axis}`);
  }
  return output;
}

function parseSideBooleans(value: unknown, field: string): Record<BlindSideV2, boolean> {
  const input = record(value, field);
  onlyKeys(input, ["A", "B"], field);
  return {
    A: booleanValue(input.A, `${field}.A`),
    B: booleanValue(input.B, `${field}.B`),
  };
}

function parseSideArrays(value: unknown, field: string): Record<BlindSideV2, string[]> {
  const input = record(value, field);
  onlyKeys(input, ["A", "B"], field);
  return {
    A: uniqueStringArray(input.A, `${field}.A`),
    B: uniqueStringArray(input.B, `${field}.B`),
  };
}

function parseEditedText(value: unknown, field: string): Partial<Record<BlindSideV2, string>> {
  const input = record(value, field);
  onlyKeys(input, ["A", "B"], field);
  if (typeof input.A === "undefined" && typeof input.B === "undefined") {
    throw new Error(`${field} must contain A or B`);
  }
  const output: Partial<Record<BlindSideV2, string>> = {};
  if (typeof input.A !== "undefined") output.A = requiredText(input.A, `${field}.A`);
  if (typeof input.B !== "undefined") output.B = requiredText(input.B, `${field}.B`);
  if (typeof output.A === "undefined" && typeof output.B === "undefined") {
    throw new Error(`${field} must contain A or B`);
  }
  return output;
}

function parseAnnotation(value: unknown, index: number): BlindEvaluationAnnotationV2 {
  const input = record(value, `annotation[${index}]`);
  onlyKeys(input, [
    "packId",
    "pairId",
    "reviewerId",
    "scores",
    "preference",
    "publishUnchanged",
    "pixymonIdentified",
    "hardVetoes",
    "reasonTags",
    "editedText",
    "reviewedAt",
  ], `annotation[${index}]`);
  const scores = record(input.scores, `annotation[${index}].scores`);
  onlyKeys(scores, ["A", "B"], `annotation[${index}].scores`);
  const preference = input.preference;
  if (preference !== "A" && preference !== "B" && preference !== "tie") {
    throw new Error(`annotation[${index}].preference must be A, B, or tie`);
  }
  const publishUnchanged = parseSideBooleans(input.publishUnchanged, `annotation[${index}].publishUnchanged`);
  const editedText = typeof input.editedText === "undefined"
    ? undefined : parseEditedText(input.editedText, `annotation[${index}].editedText`);
  for (const side of ["A", "B"] as const) {
    if (editedText?.[side] && publishUnchanged[side]) {
      throw new Error(`annotation[${index}] edited ${side} cannot be publishUnchanged`);
    }
  }
  return {
    packId: requiredText(input.packId, `annotation[${index}].packId`),
    pairId: requiredText(input.pairId, `annotation[${index}].pairId`),
    reviewerId: reviewerPseudonym(input.reviewerId, `annotation[${index}].reviewerId`),
    scores: {
      A: parseScores(scores.A, `annotation[${index}].scores.A`),
      B: parseScores(scores.B, `annotation[${index}].scores.B`),
    },
    preference,
    publishUnchanged,
    pixymonIdentified: parseSideBooleans(
      input.pixymonIdentified,
      `annotation[${index}].pixymonIdentified`
    ),
    hardVetoes: parseSideArrays(input.hardVetoes, `annotation[${index}].hardVetoes`),
    reasonTags: parseSideArrays(input.reasonTags, `annotation[${index}].reasonTags`),
    editedText,
    reviewedAt: requiredInstant(input.reviewedAt, `annotation[${index}].reviewedAt`),
  };
}

function parseAdjudication(value: unknown, index: number): BlindEvaluationAdjudicationV2 {
  const input = record(value, `adjudication[${index}]`);
  onlyKeys(input, [
    "packId",
    "pairId",
    "side",
    "axis",
    "adjudicatorId",
    "resolvedScore",
    "reason",
    "adjudicatedAt",
  ], `adjudication[${index}]`);
  const axis = input.axis;
  if (!BLIND_SCORE_AXES_V2.includes(axis as BlindScoreAxisV2)) {
    throw new Error(`adjudication[${index}].axis is invalid`);
  }
  return {
    packId: requiredText(input.packId, `adjudication[${index}].packId`),
    pairId: requiredText(input.pairId, `adjudication[${index}].pairId`),
    side: side(input.side, `adjudication[${index}].side`),
    axis: axis as BlindScoreAxisV2,
    adjudicatorId: adjudicatorPseudonym(
      input.adjudicatorId,
      `adjudication[${index}].adjudicatorId`
    ),
    resolvedScore: score(input.resolvedScore, `adjudication[${index}].resolvedScore`),
    reason: requiredText(input.reason, `adjudication[${index}].reason`),
    adjudicatedAt: requiredInstant(
      input.adjudicatedAt,
      `adjudication[${index}].adjudicatedAt`
    ),
  };
}

function sha256Hex(value: unknown, field: string): string {
  const text = requiredText(value, field);
  if (!/^[a-f0-9]{64}$/.test(text)) throw new Error(`${field} must be SHA-256 hex`);
  return text;
}

function parseEvaluationLineage(value: unknown, field: string): BlindEvaluationLineageV2 {
  const input = record(value, field);
  onlyKeys(input, [
    "replayArtifactSha256",
    "sourceLedgerSha256",
    "collectionEpoch",
    "verifiedCommit",
  ], field);
  return {
    replayArtifactSha256: sha256Hex(
      input.replayArtifactSha256,
      `${field}.replayArtifactSha256`
    ),
    sourceLedgerSha256: sha256Hex(
      input.sourceLedgerSha256,
      `${field}.sourceLedgerSha256`
    ),
    collectionEpoch: requiredText(input.collectionEpoch, `${field}.collectionEpoch`),
    verifiedCommit: requiredText(input.verifiedCommit, `${field}.verifiedCommit`),
  };
}

function parsePublicEvidence(value: unknown, field: string): BlindPublicEvidenceV2 {
  const input = record(value, field);
  onlyKeys(input, ["subject", "metric", "source"], field);
  const metric = record(input.metric, `${field}.metric`);
  onlyKeys(metric, ["name", "value", "raw", "unit", "period"], `${field}.metric`);
  const source = record(input.source, `${field}.source`);
  onlyKeys(source, ["observedAt"], `${field}.source`);
  if (typeof metric.value !== "number" || !Number.isFinite(metric.value)) {
    throw new Error(`${field}.metric.value must be finite`);
  }
  const raw = requiredText(metric.raw, `${field}.metric.raw`);
  if (!/\d/.test(raw)) throw new Error(`${field}.metric.raw must contain a number`);
  return {
    subject: requiredText(input.subject, `${field}.subject`),
    metric: {
      name: requiredText(metric.name, `${field}.metric.name`),
      value: metric.value,
      raw,
      unit: requiredText(metric.unit, `${field}.metric.unit`),
      period: requiredText(metric.period, `${field}.metric.period`),
    },
    source: { observedAt: requiredInstant(source.observedAt, `${field}.source.observedAt`) },
  };
}

function parsePack(value: unknown): BlindEvaluationPackV2 {
  const input = record(value, "pack");
  onlyKeys(input, ["schemaVersion", "kind", "packId", "mappingCommitment", "pairs"], "pack");
  if (input.schemaVersion !== 2 || input.kind !== "blind-comparison-pack") {
    throw new Error("unsupported blind pack schema");
  }
  if (!Array.isArray(input.pairs)) throw new Error("pack.pairs must be an array");
  const seen = new Set<string>();
  const pairs = input.pairs.map((value, index) => {
    const field = `pack.pairs[${index}]`;
    const row = record(value, field);
    onlyKeys(row, ["pairId", "evidence", "A", "B"], field);
    const pairId = requiredText(row.pairId, `${field}.pairId`);
    if (seen.has(pairId)) throw new Error(`duplicate pack pair: ${pairId}`);
    seen.add(pairId);
    const parseText = (value: unknown, sideName: BlindSideV2): { text: string } => {
      const sideRow = record(value, `${field}.${sideName}`);
      onlyKeys(sideRow, ["text"], `${field}.${sideName}`);
      return { text: requiredText(sideRow.text, `${field}.${sideName}.text`) };
    };
    return {
      pairId,
      evidence: parsePublicEvidence(row.evidence, `${field}.evidence`),
      A: parseText(row.A, "A"),
      B: parseText(row.B, "B"),
    };
  });
  return {
    schemaVersion: 2,
    kind: "blind-comparison-pack",
    packId: requiredText(input.packId, "pack.packId"),
    mappingCommitment: sha256Hex(input.mappingCommitment, "pack.mappingCommitment"),
    pairs,
  };
}

function parseMapping(value: unknown): BlindEvaluationMappingV2 {
  const input = record(value, "mapping");
  onlyKeys(input, [
    "schemaVersion",
    "kind",
    "packId",
    "commitmentNonce",
    "mappingCommitment",
    "publicPackDigest",
    "lineage",
    "pairs",
  ], "mapping");
  if (input.schemaVersion !== 2 || input.kind !== "pixymon-v2-blind-mapping") {
    throw new Error("unsupported blind mapping schema");
  }
  if (!Array.isArray(input.pairs)) throw new Error("mapping.pairs must be an array");
  const packId = requiredText(input.packId, "mapping.packId");
  const seen = new Set<string>();
  const sourceIds = new Set<string>();
  const replayRowIds = new Set<string>();
  const contentFingerprints = new Set<string>();
  const pairs = input.pairs.map((value, index) => {
    const row = record(value, `mapping.pairs[${index}]`);
    onlyKeys(row, [
      "pairId",
      "sourceCaseId",
      "replayRowId",
      "replayRowSha256",
      "contentFingerprint",
      "v2Side",
      "lane",
      "format",
    ], `mapping.pairs[${index}]`);
    const pairId = requiredText(row.pairId, `mapping.pairs[${index}].pairId`);
    if (seen.has(pairId)) throw new Error(`duplicate mapping pair: ${pairId}`);
    seen.add(pairId);
    const sourceCaseId = requiredText(
      row.sourceCaseId,
      `mapping.pairs[${index}].sourceCaseId`
    );
    if (sourceIds.has(sourceCaseId)) throw new Error(`duplicate mapping source case: ${sourceCaseId}`);
    sourceIds.add(sourceCaseId);
    const contentFingerprint = sha256Hex(
      row.contentFingerprint,
      `mapping.pairs[${index}].contentFingerprint`
    );
    if (contentFingerprints.has(contentFingerprint)) {
      throw new Error(`duplicate mapping content: ${contentFingerprint}`);
    }
    contentFingerprints.add(contentFingerprint);
    const replayRowId = requiredText(
      row.replayRowId,
      `mapping.pairs[${index}].replayRowId`
    );
    if (replayRowIds.has(replayRowId)) throw new Error(`duplicate replay row: ${replayRowId}`);
    replayRowIds.add(replayRowId);
    return {
      pairId,
      sourceCaseId,
      replayRowId,
      replayRowSha256: sha256Hex(
        row.replayRowSha256,
        `mapping.pairs[${index}].replayRowSha256`
      ),
      contentFingerprint,
      v2Side: side(row.v2Side, `mapping.pairs[${index}].v2Side`),
      lane: lane(row.lane, `mapping.pairs[${index}].lane`),
      format: evaluationFormat(row.format, `mapping.pairs[${index}].format`),
    };
  });
  return {
    schemaVersion: 2,
    kind: "pixymon-v2-blind-mapping",
    packId,
    commitmentNonce: sha256Hex(input.commitmentNonce, "mapping.commitmentNonce"),
    mappingCommitment: sha256Hex(input.mappingCommitment, "mapping.mappingCommitment"),
    publicPackDigest: sha256Hex(input.publicPackDigest, "mapping.publicPackDigest"),
    lineage: parseEvaluationLineage(input.lineage, "mapping.lineage"),
    pairs,
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function comparisonFingerprint(input: {
  evidence: BlindPublicEvidenceV2;
  baselineText: string;
  v2Text: string;
}): string {
  return hash(JSON.stringify({
    subject: input.evidence.subject,
    metric: input.evidence.metric,
    observedAt: input.evidence.source.observedAt,
    baselineText: input.baselineText,
    v2Text: input.v2Text,
  }));
}

function mappingCore(
  packId: string,
  lineage: BlindEvaluationLineageV2,
  pairs: BlindEvaluationMappingV2["pairs"]
): {
  packId: string;
  lineage: BlindEvaluationLineageV2;
  pairs: BlindEvaluationMappingV2["pairs"];
} {
  return { packId, lineage, pairs };
}

function mappingCommitment(
  packId: string,
  lineage: BlindEvaluationLineageV2,
  pairs: BlindEvaluationMappingV2["pairs"],
  nonce: string
): string {
  return hash(`${JSON.stringify(mappingCore(packId, lineage, pairs))}\u0000${nonce}`);
}

function replayPublicEvidence(row: EditorialReplayFixtureV2): BlindPublicEvidenceV2 {
  if (row.facts.length !== 1 || row.usedFactIds.length !== 1) {
    throw new Error(`blind evaluation currently requires one used replay fact: ${row.id}`);
  }
  const evidence = row.facts[0];
  if (row.usedFactIds[0] !== evidence.factId) {
    throw new Error(`blind evaluation fact binding is invalid: ${row.id}`);
  }
  return {
    subject: evidence.subject,
    metric: {
      name: evidence.metric.name,
      value: evidence.metric.value,
      raw: evidence.metric.raw,
      unit: evidence.metric.unit,
      period: evidence.metric.period,
    },
    source: { observedAt: evidence.source.observedAt },
  };
}

export function buildBlindEvaluationPackV2(
  comparisons: readonly BlindComparisonCaseV2[],
  seed: string,
  binding: BlindReplayBindingV2
): { pack: BlindEvaluationPackV2; mapping: BlindEvaluationMappingV2 } {
  const normalizedSeed = requiredText(seed, "blind seed");
  const replay = parseStrictEditorialReplayExportV2(binding.replay);
  const lineage: BlindEvaluationLineageV2 = {
    replayArtifactSha256: sha256Hex(
      binding.replayArtifactSha256,
      "replay artifact SHA-256"
    ),
    sourceLedgerSha256: replay.lineage.sourceLedgerSha256,
    collectionEpoch: replay.lineage.collectionEpoch,
    verifiedCommit: requiredText(binding.verifiedCommit, "verified commit"),
  };
  if (comparisons.length !== BLIND_EVALUATION_PAIR_COUNT_V2) {
    throw new Error(`blind pack requires exactly ${BLIND_EVALUATION_PAIR_COUNT_V2} pairs`);
  }
  const replayById = new Map(replay.rows.map((row) => [row.id, row]));
  const sourceIds = new Set<string>();
  const replayRowIds = new Set<string>();
  const contentFingerprints = new Set<string>();
  const normalized = comparisons.map((comparison, index) => {
    const id = requiredText(comparison.id, `comparisons[${index}].id`);
    if (sourceIds.has(id)) throw new Error(`duplicate comparison id: ${id}`);
    sourceIds.add(id);
    const replayRowId = requiredText(
      comparison.replayRowId,
      `comparisons[${index}].replayRowId`
    );
    if (replayRowIds.has(replayRowId)) throw new Error(`duplicate replay row: ${replayRowId}`);
    replayRowIds.add(replayRowId);
    const replayRow = replayById.get(replayRowId);
    if (!replayRow) throw new Error(`unknown replay row: ${replayRowId}`);
    const baselineText = requiredText(
      comparison.baselineText,
      `comparisons[${index}].baselineText`
    );
    const v2Text = replayRow.draft;
    if (baselineText === v2Text) throw new Error(`comparison texts are identical: ${id}`);
    const evidence = replayPublicEvidence(replayRow);
    const contentFingerprint = comparisonFingerprint({
      evidence,
      baselineText,
      v2Text,
    });
    if (contentFingerprints.has(contentFingerprint)) {
      throw new Error(`duplicate comparison content: ${id}`);
    }
    contentFingerprints.add(contentFingerprint);
    return {
      id,
      replayRowId,
      replayRowSha256: hash(JSON.stringify(replayRow)),
      contentFingerprint,
      lane: replayRow.lane,
      format: replayRow.format,
      evidence,
      baselineText,
      v2Text,
      order: hash(`${normalizedSeed}\u0000order\u0000${id}`),
      sideOrder: hash(`${normalizedSeed}\u0000side\u0000${id}`),
    };
  }).sort((left, right) => left.order.localeCompare(right.order) || left.id.localeCompare(right.id));
  const revisitCount = normalized.filter((comparison) => comparison.format === "revisit").length;
  if (revisitCount !== 12) throw new Error(`blind pack requires exactly 12 revisit pairs`);
  for (const requiredLane of ['onchain', 'protocol', 'ecosystem'] as const) {
    for (const originalFormat of ["bite", "withhold"] as const) {
      const formatCount = normalized.filter(
        (comparison) =>
          comparison.lane === requiredLane &&
          comparison.format === originalFormat
      ).length;
      if (formatCount !== 4) {
        throw new Error(
          `blind pack requires 4 ${originalFormat} ${requiredLane} pairs; received ${formatCount}`
        );
      }
    }
  }
  const aSideIds = new Set(
    [...normalized]
      .sort((left, right) => left.sideOrder.localeCompare(right.sideOrder) || left.id.localeCompare(right.id))
      .slice(0, BLIND_EVALUATION_PAIR_COUNT_V2 / 2)
      .map((comparison) => comparison.id)
  );
  const packId = `blind-${hash(`${normalizedSeed}\u0000${JSON.stringify(normalized)}`).slice(0, 16)}`;
  const pairs = normalized.map((comparison, index) => {
    const pairId = `pair-${String(index + 1).padStart(3, "0")}`;
    const v2Side: BlindSideV2 = aSideIds.has(comparison.id) ? "A" : "B";
    const A = v2Side === "A" ? comparison.v2Text : comparison.baselineText;
    const B = v2Side === "B" ? comparison.v2Text : comparison.baselineText;
    return {
      publicPair: {
        pairId,
        evidence: comparison.evidence,
        A: { text: A },
        B: { text: B },
      },
      privatePair: {
        pairId,
        sourceCaseId: comparison.id,
        replayRowId: comparison.replayRowId,
        replayRowSha256: comparison.replayRowSha256,
        contentFingerprint: comparison.contentFingerprint,
        v2Side,
        lane: comparison.lane,
        format: comparison.format,
      },
    };
  });
  const privatePairs = pairs.map((pair) => pair.privatePair);
  const commitmentNonce = hash(`${normalizedSeed}\u0000mapping-nonce\u0000${packId}`);
  const commitment = mappingCommitment(packId, lineage, privatePairs, commitmentNonce);
  const pack: BlindEvaluationPackV2 = {
      schemaVersion: 2,
      kind: "blind-comparison-pack",
      packId,
      mappingCommitment: commitment,
      pairs: pairs.map((pair) => pair.publicPair),
  };
  return {
    pack,
    mapping: {
      schemaVersion: 2,
      kind: "pixymon-v2-blind-mapping",
      packId,
      commitmentNonce,
      mappingCommitment: commitment,
      publicPackDigest: hash(JSON.stringify(pack)),
      lineage,
      pairs: privatePairs,
    },
  };
}

function mean(values: readonly number[]): number | null {
  return values.length === 0
    ? null
    : values.reduce((total, value) => total + value, 0) / values.length;
}

function adjudicationKey(input: {
  pairId: string;
  side: BlindSideV2;
  axis: BlindScoreAxisV2;
}): string {
  return `${input.pairId}:${input.side}:${input.axis}`;
}

function assertPackMappingBinding(
  pack: BlindEvaluationPackV2,
  mapping: BlindEvaluationMappingV2,
  binding?: BlindReplayBindingV2
): void {
  if (pack.packId !== mapping.packId) throw new Error("blind pack and mapping packId mismatch");
  if (pack.mappingCommitment !== mapping.mappingCommitment) {
    throw new Error("blind pack and mapping commitment mismatch");
  }
  const expectedCommitment = mappingCommitment(
    mapping.packId,
    mapping.lineage,
    mapping.pairs,
    mapping.commitmentNonce
  );
  if (expectedCommitment !== mapping.mappingCommitment) {
    throw new Error("blind mapping commitment is invalid");
  }
  if (hash(JSON.stringify(pack)) !== mapping.publicPackDigest) {
    throw new Error("blind public pack digest mismatch");
  }
  if (pack.pairs.length !== mapping.pairs.length) {
    throw new Error("blind pack and mapping pair counts differ");
  }
  const replay = binding ? parseStrictEditorialReplayExportV2(binding.replay) : undefined;
  if (binding) {
    const expectedArtifactSha256 = sha256Hex(
      binding.replayArtifactSha256,
      "replay artifact SHA-256"
    );
    const expectedCommit = requiredText(binding.verifiedCommit, "verified commit");
    if (
      mapping.lineage.replayArtifactSha256 !== expectedArtifactSha256 ||
      mapping.lineage.sourceLedgerSha256 !== replay?.lineage.sourceLedgerSha256 ||
      mapping.lineage.collectionEpoch !== replay?.lineage.collectionEpoch ||
      mapping.lineage.verifiedCommit !== expectedCommit
    ) {
      throw new Error("blind mapping replay lineage mismatch");
    }
  }
  const replayById = replay
    ? new Map(replay.rows.map((row) => [row.id, row]))
    : undefined;
  for (let index = 0; index < mapping.pairs.length; index += 1) {
    const privatePair = mapping.pairs[index];
    const publicPair = pack.pairs[index];
    if (!publicPair || publicPair.pairId !== privatePair.pairId) {
      throw new Error(`blind pack and mapping pair order mismatch at ${index}`);
    }
    const baselineText = privatePair.v2Side === "A" ? publicPair.B.text : publicPair.A.text;
    const v2Text = privatePair.v2Side === "A" ? publicPair.A.text : publicPair.B.text;
    const expectedFingerprint = comparisonFingerprint({
      evidence: publicPair.evidence,
      baselineText,
      v2Text,
    });
    if (expectedFingerprint !== privatePair.contentFingerprint) {
      throw new Error(`blind pair content fingerprint mismatch: ${privatePair.pairId}`);
    }
    if (replayById) {
      const replayRow = replayById.get(privatePair.replayRowId);
      if (!replayRow) throw new Error(`blind pair references unknown replay row: ${privatePair.replayRowId}`);
      if (hash(JSON.stringify(replayRow)) !== privatePair.replayRowSha256) {
        throw new Error(`blind replay row digest mismatch: ${privatePair.pairId}`);
      }
      if (privatePair.lane !== replayRow.lane || privatePair.format !== replayRow.format) {
        throw new Error(`blind replay row classification mismatch: ${privatePair.pairId}`);
      }
      const expectedEvidence = replayPublicEvidence(replayRow);
      if (
        v2Text !== replayRow.draft ||
        JSON.stringify(publicPair.evidence) !== JSON.stringify(expectedEvidence)
      ) {
        throw new Error(`blind V2 side does not match replay row: ${privatePair.pairId}`);
      }
    }
  }
}

export function verifyBlindEvaluationLineageV2(input: {
  pack: BlindEvaluationPackV2;
  mapping: BlindEvaluationMappingV2;
  binding: BlindReplayBindingV2;
}): BlindEvaluationLineageV2 {
  const pack = parsePack(input.pack);
  const mapping = parseMapping(input.mapping);
  assertPackMappingBinding(pack, mapping, input.binding);
  return { ...mapping.lineage };
}

export function aggregateBlindEvaluationV2(input: {
  pack: BlindEvaluationPackV2;
  mapping: BlindEvaluationMappingV2;
  annotations: readonly BlindEvaluationAnnotationV2[];
  adjudications?: readonly BlindEvaluationAdjudicationV2[];
  binding: BlindReplayBindingV2;
}): BlindEvaluationReportV2 {
  const pack = parsePack(input.pack);
  const mapping = parseMapping(input.mapping);
  assertPackMappingBinding(pack, mapping, input.binding);
  const annotations = input.annotations.map(parseAnnotation);
  const adjudications = (input.adjudications ?? []).map(parseAdjudication);
  const pairById = new Map(mapping.pairs.map((pair) => [pair.pairId, pair]));
  const annotationKeys = new Set<string>();
  const annotationsByPair = new Map<string, BlindEvaluationAnnotationV2[]>();
  const reviewers = new Set<string>();

  for (const annotation of annotations) {
    if (annotation.packId !== mapping.packId) throw new Error("annotation packId mismatch");
    if (!pairById.has(annotation.pairId)) {
      throw new Error(`annotation references unknown pair: ${annotation.pairId}`);
    }
    const key = `${annotation.pairId}:${annotation.reviewerId}`;
    if (annotationKeys.has(key)) throw new Error(`duplicate annotation: ${key}`);
    annotationKeys.add(key);
    reviewers.add(annotation.reviewerId);
    annotationsByPair.set(annotation.pairId, [
      ...(annotationsByPair.get(annotation.pairId) ?? []),
      annotation,
    ]);
  }

  const requiredAdjudications = new Set<string>();
  for (const pair of mapping.pairs) {
    const rows = annotationsByPair.get(pair.pairId) ?? [];
    if (rows.length !== BLIND_EVALUATION_READER_COUNT_V2) continue;
    for (const blindSide of ["A", "B"] as const) {
      for (const axis of BLIND_SCORE_AXES_V2) {
        if (Math.abs(rows[0].scores[blindSide][axis] - rows[1].scores[blindSide][axis]) >= 2) {
          requiredAdjudications.add(adjudicationKey({ pairId: pair.pairId, side: blindSide, axis }));
        }
      }
    }
  }

  const adjudicationByKey = new Map<string, BlindEvaluationAdjudicationV2>();
  for (const adjudication of adjudications) {
    if (adjudication.packId !== mapping.packId) throw new Error("adjudication packId mismatch");
    if (!pairById.has(adjudication.pairId)) {
      throw new Error(`adjudication references unknown pair: ${adjudication.pairId}`);
    }
    const key = adjudicationKey(adjudication);
    if (!requiredAdjudications.has(key)) throw new Error(`unexpected adjudication: ${key}`);
    if (adjudicationByKey.has(key)) throw new Error(`duplicate adjudication: ${key}`);
    adjudicationByKey.set(key, adjudication);
  }

  const incompleteReasons: string[] = [];
  if (mapping.pairs.length !== BLIND_EVALUATION_PAIR_COUNT_V2) {
    incompleteReasons.push(
      `pair-count:${mapping.pairs.length}/${BLIND_EVALUATION_PAIR_COUNT_V2}`
    );
  }
  const mappedRevisits = mapping.pairs.filter((pair) => pair.format === "revisit").length;
  if (mappedRevisits !== 12) incompleteReasons.push(`revisit-pairs:${mappedRevisits}/12`);
  for (const requiredLane of ['onchain', 'protocol', 'ecosystem'] as const) {
    for (const originalFormat of ["bite", "withhold"] as const) {
      const formatCount = mapping.pairs.filter(
        (pair) =>
          pair.lane === requiredLane &&
          pair.format === originalFormat
      ).length;
      if (formatCount !== 4) {
        incompleteReasons.push(
          `original-format:${requiredLane}:${originalFormat}:${formatCount}/4`
        );
      }
    }
  }
  if (reviewers.size !== BLIND_EVALUATION_READER_COUNT_V2) {
    incompleteReasons.push(
      `reviewer-count:${reviewers.size}/${BLIND_EVALUATION_READER_COUNT_V2}`
    );
  }
  const expectedAnnotations = mapping.pairs.length * BLIND_EVALUATION_READER_COUNT_V2;
  if (annotations.length !== expectedAnnotations) {
    incompleteReasons.push(`annotation-count:${annotations.length}/${expectedAnnotations}`);
  }
  const incompletePairs = mapping.pairs.filter(
    (pair) => (annotationsByPair.get(pair.pairId) ?? []).length !== BLIND_EVALUATION_READER_COUNT_V2
  ).length;
  if (incompletePairs > 0) incompleteReasons.push(`pairs-without-two-readers:${incompletePairs}`);
  const missingAdjudications = [...requiredAdjudications].filter(
    (key) => !adjudicationByKey.has(key)
  );
  if (missingAdjudications.length > 0) {
    incompleteReasons.push(`missing-adjudications:${missingAdjudications.length}`);
  }

  const axisValues = Object.fromEntries(
    BLIND_SCORE_AXES_V2.map((axis) => [axis, [] as number[]])
  ) as Record<BlindScoreAxisV2, number[]>;
  let v2Preferences = 0;
  let publishUnchanged = 0;
  let pixymonIdentified = 0;
  let hardVetoCount = 0;
  let v2AnnotationCount = 0;

  for (const pair of mapping.pairs) {
    const rows = annotationsByPair.get(pair.pairId) ?? [];
    if (rows.length !== BLIND_EVALUATION_READER_COUNT_V2) continue;
    for (const axis of BLIND_SCORE_AXES_V2) {
      const values = rows.map((row) => row.scores[pair.v2Side][axis]);
      const key = adjudicationKey({ pairId: pair.pairId, side: pair.v2Side, axis });
      const adjudicated = adjudicationByKey.get(key);
      axisValues[axis].push(adjudicated?.resolvedScore ?? (values[0] + values[1]) / 2);
    }
    for (const annotation of rows) {
      v2AnnotationCount += 1;
      if (annotation.preference === pair.v2Side) v2Preferences += 1;
      if (annotation.publishUnchanged[pair.v2Side]) publishUnchanged += 1;
      if (annotation.pixymonIdentified[pair.v2Side]) pixymonIdentified += 1;
      hardVetoCount += annotation.hardVetoes[pair.v2Side].length;
    }
  }

  const means = Object.fromEntries(
    BLIND_SCORE_AXES_V2.map((axis) => [axis, mean(axisValues[axis])])
  ) as Record<BlindScoreAxisV2, number | null>;
  const v2PreferenceRate = v2AnnotationCount > 0 ? v2Preferences / v2AnnotationCount : null;
  const publishUnchangedRate = v2AnnotationCount > 0
    ? publishUnchanged / v2AnnotationCount
    : null;
  const pixymonIdentificationRate = v2AnnotationCount > 0
    ? pixymonIdentified / v2AnnotationCount
    : null;
  const complete = incompleteReasons.length === 0;
  const gateFailures: string[] = [];
  if (complete) {
    if (hardVetoCount !== 0) gateFailures.push(`hard-vetoes:${hardVetoCount}`);
    if ((means.grounding ?? 0) < 4) gateFailures.push(`grounding:${means.grounding}`);
    if ((means.clarity ?? 0) < 4) gateFailures.push(`clarity:${means.clarity}`);
    if ((means.character ?? 0) < 3.7) gateFailures.push(`character:${means.character}`);
    if ((means.memorability ?? 0) < 3.7) {
      gateFailures.push(`memorability:${means.memorability}`);
    }
    if ((means.overall ?? 0) < 3.8) gateFailures.push(`overall:${means.overall}`);
    if ((v2PreferenceRate ?? 0) < 0.6) {
      gateFailures.push(`v2-preference-rate:${v2PreferenceRate}`);
    }
    if ((publishUnchangedRate ?? 0) < 0.8) {
      gateFailures.push(`publish-unchanged-rate:${publishUnchangedRate}`);
    }
    if ((pixymonIdentificationRate ?? 0) < 0.7) {
      gateFailures.push(`pixymon-identification-rate:${pixymonIdentificationRate}`);
    }
  }

  return {
    schemaVersion: 2,
    kind: "pixymon-v2-blind-report",
    packId: mapping.packId,
    lineage: { ...mapping.lineage },
    complete,
    passed: complete && gateFailures.length === 0,
    pairCount: mapping.pairs.length,
    reviewerCount: reviewers.size,
    annotationCount: annotations.length,
    requiredAdjudicationCount: requiredAdjudications.size,
    completedAdjudicationCount: adjudicationByKey.size,
    means,
    v2PreferenceRate,
    publishUnchangedRate,
    pixymonIdentificationRate,
    hardVetoCount,
    incompleteReasons,
    gateFailures,
  };
}

function readJson(pathname: string): unknown {
  return JSON.parse(fs.readFileSync(path.resolve(pathname), "utf8")) as unknown;
}

export function readBlindComparisonCasesV2(pathname: string): BlindComparisonCaseV2[] {
  const value = readJson(pathname);
  if (!Array.isArray(value)) throw new Error("blind comparison input must be an array");
  return value.map((entry, index) => {
    const field = `comparisons[${index}]`;
    const input = record(entry, field);
    onlyKeys(input, ["id", "replayRowId", "baselineText"], field);
    return {
      id: requiredText(input.id, `${field}.id`),
      replayRowId: requiredText(input.replayRowId, `${field}.replayRowId`),
      baselineText: requiredText(input.baselineText, `${field}.baselineText`),
    };
  });
}

export function readBlindEvaluationPackV2(pathname: string): BlindEvaluationPackV2 {
  return parsePack(readJson(pathname));
}

export function readBlindEvaluationMappingV2(pathname: string): BlindEvaluationMappingV2 {
  return parseMapping(readJson(pathname));
}

export function readBlindEvaluationAnnotationsV2(
  pathname: string
): BlindEvaluationAnnotationV2[] {
  const value = readJson(pathname);
  if (!Array.isArray(value)) throw new Error("blind annotations must be an array");
  return value.map(parseAnnotation);
}

export function readBlindEvaluationAdjudicationsV2(
  pathname: string
): BlindEvaluationAdjudicationV2[] {
  const value = readJson(pathname);
  if (!Array.isArray(value)) throw new Error("blind adjudications must be an array");
  return value.map(parseAdjudication);
}

function writeNewJson(pathname: string, value: unknown, mode?: number): string {
  const normalized = String(pathname || "").trim();
  if (!normalized) throw new Error("output path is required");
  const target = path.resolve(normalized);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    ...(typeof mode === "number" ? { mode } : {}),
  });
  return target;
}

export function writeNewBlindEvaluationPackV2(
  packPath: string,
  mappingPath: string,
  result: { pack: BlindEvaluationPackV2; mapping: BlindEvaluationMappingV2 }
): { packPath: string; mappingPath: string } {
  const pack = parsePack(result.pack);
  const mapping = parseMapping(result.mapping);
  assertPackMappingBinding(pack, mapping);
  const resolvedPack = path.resolve(requiredText(packPath, "pack output path"));
  const resolvedMapping = path.resolve(requiredText(mappingPath, "mapping output path"));
  if (resolvedPack === resolvedMapping) throw new Error("pack and mapping paths must differ");
  if (fs.existsSync(resolvedPack) || fs.existsSync(resolvedMapping)) {
    throw new Error("blind pack outputs already exist");
  }
  return {
    packPath: writeNewJson(resolvedPack, pack),
    mappingPath: writeNewJson(resolvedMapping, mapping, 0o600),
  };
}

export function writeNewBlindEvaluationReportV2(
  outputPath: string,
  report: BlindEvaluationReportV2
): string {
  return writeNewJson(outputPath, report);
}
