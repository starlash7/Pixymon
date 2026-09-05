import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  EditorialFactSnapshotV2,
  EditorialFormatV2,
  EditorialLaneV2,
  MachineComparatorV2,
} from "./contracts.js";
import { EDITORIAL_COLLECTION_EPOCH_V2 } from "./contracts.js";
import type { EditorialEventV2 } from "./event-store.js";
import { foldEditorialEventsV2, readEditorialEventsV2 } from "./event-store.js";

export const EDITORIAL_REPLAY_EXPORT_KIND_V2 = "pixymon-v2-runtime-replay-export" as const;

export interface EditorialReplayFactV2 {
  factId: string;
  subject: string;
  metric: EditorialFactSnapshotV2["metric"];
  source: { observedAt: string };
}

/** Runtime identifiers, reviewers, provider identity/URLs, and X IDs are absent. */
export interface EditorialReplayFixtureV2 {
  schemaVersion: 2;
  id: string;
  lane: EditorialLaneV2;
  format: EditorialFormatV2;
  subject: string;
  factIds: readonly string[];
  usedFactIds: readonly string[];
  claims: readonly {
    kind: "observation" | "judgment";
    text: string;
    factIds: readonly string[];
  }[];
  facts: readonly EditorialReplayFactV2[];
  falsifier: {
    metric: string;
    comparator: MachineComparatorV2;
    threshold: number;
    deadline: string;
    unit?: string;
  };
  textProvenance: "generated";
  trackingMode?: "live" | "shadow";
  reviewDisposition: "pending" | "approved-unchanged" | "approved-edited" | "rejected";
  wasEverEdited: boolean;
  draft: string;
}

export interface EditorialReplayExportV2 {
  schemaVersion: 2;
  kind: typeof EDITORIAL_REPLAY_EXPORT_KIND_V2;
  lineage: {
    source: "editorial-event-ledger";
    sourceLedgerSha256: string;
    sourceLedgerBytes: number;
    sourceEventCount: number;
    sourceDraftCount: number;
    collectionEpoch: string;
    epochDraftCount: number;
    excludedDraftCount: number;
    selectionPolicy: "first-created-in-epoch";
    requestedLimit: number | null;
    exportedDraftCount: number;
  };
  rows: readonly EditorialReplayFixtureV2[];
}

export interface BuildEditorialReplayOptionsV2 {
  limit?: number;
  collectionEpoch?: string;
}

function normalizedLimit(limit: number | undefined): number | undefined {
  if (typeof limit === "undefined") return undefined;
  if (!Number.isInteger(limit) || limit < 1) throw new Error("replay limit must be a positive integer");
  return limit;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
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

function nonnegativeInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return Number(value);
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${field} must be finite`);
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${field} must be a non-empty array`);
  const values = value.map((entry, index) => requiredText(entry, `${field}[${index}]`));
  if (new Set(values).size !== values.length) throw new Error(`${field} must be unique`);
  return values;
}

function replayFormat(value: unknown, field: string): EditorialFormatV2 {
  if (!["bite", "withhold", "revisit", "evolution"].includes(String(value))) {
    throw new Error(`${field} is invalid`);
  }
  return value as EditorialFormatV2;
}

function replayLane(value: unknown, field: string): EditorialLaneV2 {
  if (!["onchain", "protocol", "ecosystem"].includes(String(value))) {
    throw new Error(`${field} is invalid`);
  }
  return value as EditorialLaneV2;
}

function comparator(value: unknown, field: string): MachineComparatorV2 {
  if (!["gt", "gte", "lt", "lte", "eq"].includes(String(value))) throw new Error(`${field} is invalid`);
  return value as MachineComparatorV2;
}

function parseReplayFact(value: unknown, field: string): EditorialReplayFactV2 {
  const input = record(value, field);
  onlyKeys(input, ["factId", "subject", "metric", "source"], field);
  const metric = record(input.metric, `${field}.metric`);
  onlyKeys(metric, ["name", "value", "raw", "unit", "period"], `${field}.metric`);
  const source = record(input.source, `${field}.source`);
  onlyKeys(source, ["observedAt"], `${field}.source`);
  const raw = requiredText(metric.raw, `${field}.metric.raw`);
  if (!/\d/.test(raw)) throw new Error(`${field}.metric.raw must contain a number`);
  return {
    factId: requiredText(input.factId, `${field}.factId`),
    subject: requiredText(input.subject, `${field}.subject`),
    metric: {
      name: requiredText(metric.name, `${field}.metric.name`),
      value: finiteNumber(metric.value, `${field}.metric.value`),
      raw,
      unit: requiredText(metric.unit, `${field}.metric.unit`),
      period: requiredText(metric.period, `${field}.metric.period`),
    },
    source: { observedAt: instant(source.observedAt, `${field}.source.observedAt`) },
  };
}

function parseReplayFixture(value: unknown, index: number): EditorialReplayFixtureV2 {
  const field = `replay.rows[${index}]`;
  const input = record(value, field);
  onlyKeys(input, [
    "schemaVersion", "id", "lane", "format", "subject", "factIds", "usedFactIds", "claims", "facts",
    "falsifier", "textProvenance", "trackingMode", "reviewDisposition", "wasEverEdited", "draft",
  ], field);
  if (input.schemaVersion !== 2 || input.textProvenance !== "generated") {
    throw new Error(`${field} has unsupported schema or text provenance`);
  }
  const expectedId = `replay-${String(index + 1).padStart(6, "0")}`;
  if (input.trackingMode !== undefined && input.trackingMode !== "live" && input.trackingMode !== "shadow") {
    throw new Error(`${field}.trackingMode is invalid`);
  }
  const id = requiredText(input.id, `${field}.id`);
  if (id !== expectedId) throw new Error(`${field}.id must be ${expectedId}`);
  const factIds = stringArray(input.factIds, `${field}.factIds`);
  const usedFactIds = stringArray(input.usedFactIds, `${field}.usedFactIds`);
  if (!Array.isArray(input.claims) || input.claims.length === 0) {
    throw new Error(`${field}.claims must be a non-empty array`);
  }
  const claims: EditorialReplayFixtureV2["claims"] = input.claims.map((value, claimIndex) => {
    const claimField = `${field}.claims[${claimIndex}]`;
    const claim = record(value, claimField);
    onlyKeys(claim, ["kind", "text", "factIds"], claimField);
    if (claim.kind !== "observation" && claim.kind !== "judgment") {
      throw new Error(`${claimField}.kind is invalid`);
    }
    const expectedKind = claimIndex === 0 ? "observation" : "judgment";
    if (claim.kind !== expectedKind) throw new Error(`${claimField}.kind must be ${expectedKind}`);
    return {
      kind: claim.kind,
      text: requiredText(claim.text, `${claimField}.text`),
      factIds: stringArray(claim.factIds, `${claimField}.factIds`),
    };
  });
  if (!Array.isArray(input.facts) || input.facts.length === 0) throw new Error(`${field}.facts must be non-empty`);
  const facts = input.facts.map((fact, factIndex) => parseReplayFact(fact, `${field}.facts[${factIndex}]`));
  if (JSON.stringify(factIds) !== JSON.stringify(facts.map((fact) => fact.factId))) {
    throw new Error(`${field}.factIds must map exactly to nested facts in order`);
  }
  if (usedFactIds.some((factId) => !factIds.includes(factId))) {
    throw new Error(`${field}.usedFactIds must be a non-empty subset of factIds`);
  }
  if (claims.some((claim) => claim.factIds.some((factId) => !factIds.includes(factId)))) {
    throw new Error(`${field}.claims contain an unknown factId`);
  }
  const claimedFactIds = new Set(claims.flatMap((claim) => claim.factIds));
  if (usedFactIds.some((factId) => !claimedFactIds.has(factId))) {
    throw new Error(`${field}.claims must cover every usedFactId`);
  }
  const subject = requiredText(input.subject, `${field}.subject`);
  if (subject !== facts[0].subject) throw new Error(`${field}.subject must match the first nested fact`);
  const falsifier = record(input.falsifier, `${field}.falsifier`);
  onlyKeys(falsifier, ["metric", "comparator", "threshold", "deadline", "unit"], `${field}.falsifier`);
  const disposition = input.reviewDisposition;
  if (!["pending", "approved-unchanged", "approved-edited", "rejected"].includes(String(disposition))) {
    throw new Error(`${field}.reviewDisposition is invalid`);
  }
  if (typeof input.wasEverEdited !== "boolean") throw new Error(`${field}.wasEverEdited must be boolean`);
  if (
    (disposition === "approved-edited" && !input.wasEverEdited) ||
    (disposition === "approved-unchanged" && input.wasEverEdited)
  ) {
    throw new Error(`${field} edit provenance conflicts with review disposition`);
  }
  const draft = requiredText(input.draft, `${field}.draft`);
  const sentences = draft
    .replace(/\n+/g, " ")
    .split(/(?<=[.!?])\s+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  if (
    claims.length !== sentences.length ||
    claims.some((claim, claimIndex) => claim.text !== sentences[claimIndex])
  ) {
    throw new Error(`${field}.claims must preserve draft sentence order exactly`);
  }
  return {
    schemaVersion: 2,
    id,
    ...(input.trackingMode ? { trackingMode: input.trackingMode as "live" | "shadow" } : {}),
    lane: replayLane(input.lane, `${field}.lane`),
    format: replayFormat(input.format, `${field}.format`),
    subject,
    factIds,
    usedFactIds,
    claims,
    facts,
    falsifier: {
      metric: requiredText(falsifier.metric, `${field}.falsifier.metric`),
      comparator: comparator(falsifier.comparator, `${field}.falsifier.comparator`),
      threshold: finiteNumber(falsifier.threshold, `${field}.falsifier.threshold`),
      deadline: instant(falsifier.deadline, `${field}.falsifier.deadline`),
      unit: typeof falsifier.unit === "undefined" ? undefined : requiredText(falsifier.unit, `${field}.falsifier.unit`),
    },
    textProvenance: "generated",
    reviewDisposition: disposition as EditorialReplayFixtureV2["reviewDisposition"],
    wasEverEdited: input.wasEverEdited,
    draft,
  };
}

export function buildEditorialReplayFixturesV2(
  events: readonly EditorialEventV2[],
  options: BuildEditorialReplayOptionsV2 = {}
): EditorialReplayFixtureV2[] {
  const limit = normalizedLimit(options.limit);
  const collectionEpoch = requiredText(
    options.collectionEpoch ?? EDITORIAL_COLLECTION_EPOCH_V2,
    "replay collection epoch"
  );
  const drafts = events.filter(
    (event): event is Extract<EditorialEventV2, { type: "draft-created" }> => event.type === "draft-created"
  );
  const epochDrafts = drafts.filter((event) => event.draft.collectionEpoch === collectionEpoch);
  const selected = typeof limit === "number" ? epochDrafts.slice(0, limit) : epochDrafts;
  const ledger = foldEditorialEventsV2(events);
  return selected.map((event, draftIndex) => {
    const state = ledger.drafts.get(event.draft.id);
    if (!state) throw new Error(`replay draft missing from folded ledger: ${event.draft.id}`);
    const facts = event.draft.facts.map((fact, factIndex) => ({
      factId: `fact-${factIndex + 1}`,
      subject: fact.subject,
      metric: {
        name: fact.metric.name,
        value: fact.metric.value,
        raw: fact.metric.raw,
        unit: fact.metric.unit,
        period: fact.metric.period,
      },
      source: { observedAt: fact.source.observedAt },
    }));
    const factIds = facts.map((fact) => fact.factId);
    const generatedPayload = event.draft.generatedPayload;
    if (!generatedPayload) {
      throw new Error(`replay draft missing durable generated payload: ${event.draft.id}`);
    }
    if (generatedPayload.draft !== event.draft.draft) {
      throw new Error(`replay draft generated payload text mismatch: ${event.draft.id}`);
    }
    const lane = event.draft.lane;
    if (!lane) throw new Error(`replay draft missing durable lane: ${event.draft.id}`);
    const anonymizedFactIds = new Map(
      event.draft.facts.map((fact, factIndex) => [fact.factId, `fact-${factIndex + 1}`])
    );
    const mapFactIds = (ids: readonly string[], field: string): string[] => ids.map((factId) => {
      const mapped = anonymizedFactIds.get(factId);
      if (!mapped) throw new Error(`${field} references an unknown fact`);
      return mapped;
    });
    const usedFactIds = mapFactIds(
      generatedPayload.usedFactIds,
      `replay draft ${event.draft.id} usedFactIds`
    );
    const claims = generatedPayload.claims.map((claim, claimIndex) => ({
      kind: claim.kind,
      text: claim.text,
      factIds: mapFactIds(
        claim.factIds,
        `replay draft ${event.draft.id} claim ${claimIndex + 1}`
      ),
    }));
    const wasEverEdited = state.reviews.some((review) => review.action === "edit");
    return {
      schemaVersion: 2,
      id: `replay-${String(draftIndex + 1).padStart(6, "0")}`,
      trackingMode: event.draft.trackingMode ?? "live",
      lane,
      format: event.draft.format,
      subject: event.draft.subject,
      factIds,
      usedFactIds,
      claims,
      facts,
      falsifier: {
        metric: event.draft.falsifier.metric,
        comparator: event.draft.falsifier.comparator,
        threshold: event.draft.falsifier.threshold,
        deadline: event.draft.falsifier.deadline,
        unit: event.draft.falsifier.unit,
      },
      textProvenance: "generated",
      reviewDisposition: state.reviewStatus === "pending"
        ? "pending"
        : state.reviewStatus === "rejected"
          ? "rejected"
          : wasEverEdited ? "approved-edited" : "approved-unchanged",
      wasEverEdited,
      draft: event.draft.draft,
    };
  });
}

export function readEditorialReplayFixturesV2(
  eventLogPath: string,
  options: BuildEditorialReplayOptionsV2 = {}
): EditorialReplayFixtureV2[] {
  if (!fs.existsSync(eventLogPath)) throw new Error("editorial event log not found");
  return buildEditorialReplayFixturesV2(readEditorialEventsV2(eventLogPath), options);
}

export function buildEditorialReplayExportFromLedgerV2(
  eventLogPath: string,
  options: BuildEditorialReplayOptionsV2 = {}
): EditorialReplayExportV2 {
  const target = path.resolve(requiredText(eventLogPath, "editorial event log path"));
  if (!fs.existsSync(target)) throw new Error("editorial event log not found");
  const before = fs.readFileSync(target);
  const events = readEditorialEventsV2(target);
  const after = fs.readFileSync(target);
  if (!before.equals(after)) throw new Error("editorial event log changed during replay export");
  const limit = normalizedLimit(options.limit);
  const collectionEpoch = requiredText(
    options.collectionEpoch ?? EDITORIAL_COLLECTION_EPOCH_V2,
    "replay collection epoch"
  );
  const rows = buildEditorialReplayFixturesV2(events, options);
  const sourceDraftCount = events.filter((event) => event.type === "draft-created").length;
  const epochDraftCount = events.filter(
    (event) => event.type === "draft-created" && event.draft.collectionEpoch === collectionEpoch
  ).length;
  return {
    schemaVersion: 2,
    kind: EDITORIAL_REPLAY_EXPORT_KIND_V2,
    lineage: {
      source: "editorial-event-ledger",
      sourceLedgerSha256: sha256(after),
      sourceLedgerBytes: after.byteLength,
      sourceEventCount: events.length,
      sourceDraftCount,
      collectionEpoch,
      epochDraftCount,
      excludedDraftCount: sourceDraftCount - epochDraftCount,
      selectionPolicy: "first-created-in-epoch",
      requestedLimit: limit ?? null,
      exportedDraftCount: rows.length,
    },
    rows,
  };
}

export function parseStrictEditorialReplayExportV2(value: unknown): EditorialReplayExportV2 {
  const input = record(value, "replay export");
  onlyKeys(input, ["schemaVersion", "kind", "lineage", "rows"], "replay export");
  if (input.schemaVersion !== 2 || input.kind !== EDITORIAL_REPLAY_EXPORT_KIND_V2) {
    throw new Error("unsupported replay export schema");
  }
  const lineage = record(input.lineage, "replay export.lineage");
  onlyKeys(lineage, [
    "source", "sourceLedgerSha256", "sourceLedgerBytes", "sourceEventCount", "sourceDraftCount",
    "collectionEpoch", "epochDraftCount", "excludedDraftCount", "selectionPolicy",
    "requestedLimit", "exportedDraftCount",
  ], "replay export.lineage");
  if (
    lineage.source !== "editorial-event-ledger" ||
    lineage.selectionPolicy !== "first-created-in-epoch"
  ) {
    throw new Error("replay export lineage source or selection policy is invalid");
  }
  const sourceLedgerSha256 = requiredText(lineage.sourceLedgerSha256, "replay export.lineage.sourceLedgerSha256");
  if (!/^[a-f0-9]{64}$/.test(sourceLedgerSha256)) {
    throw new Error("replay export.lineage.sourceLedgerSha256 must be SHA-256 hex");
  }
  const sourceLedgerBytes = nonnegativeInteger(lineage.sourceLedgerBytes, "replay export.lineage.sourceLedgerBytes");
  const sourceEventCount = nonnegativeInteger(lineage.sourceEventCount, "replay export.lineage.sourceEventCount");
  const sourceDraftCount = nonnegativeInteger(lineage.sourceDraftCount, "replay export.lineage.sourceDraftCount");
  const collectionEpoch = requiredText(lineage.collectionEpoch, "replay export.lineage.collectionEpoch");
  const epochDraftCount = nonnegativeInteger(lineage.epochDraftCount, "replay export.lineage.epochDraftCount");
  const excludedDraftCount = nonnegativeInteger(lineage.excludedDraftCount, "replay export.lineage.excludedDraftCount");
  const exportedDraftCount = nonnegativeInteger(lineage.exportedDraftCount, "replay export.lineage.exportedDraftCount");
  const requestedLimit = lineage.requestedLimit === null
    ? null
    : normalizedLimit(typeof lineage.requestedLimit === "number" ? lineage.requestedLimit : Number.NaN);
  if (!Array.isArray(input.rows)) throw new Error("replay export.rows must be an array");
  const rows = input.rows.map(parseReplayFixture);
  const expectedExportedCount = Math.min(epochDraftCount, requestedLimit ?? epochDraftCount);
  if (
    sourceDraftCount > sourceEventCount ||
    epochDraftCount > sourceDraftCount ||
    excludedDraftCount !== sourceDraftCount - epochDraftCount ||
    exportedDraftCount !== rows.length ||
    exportedDraftCount !== expectedExportedCount
  ) {
    throw new Error("replay export lineage counts do not match rows");
  }
  return {
    schemaVersion: 2,
    kind: EDITORIAL_REPLAY_EXPORT_KIND_V2,
    lineage: {
      source: "editorial-event-ledger",
      sourceLedgerSha256,
      sourceLedgerBytes,
      sourceEventCount,
      sourceDraftCount,
      collectionEpoch,
      epochDraftCount,
      excludedDraftCount,
      selectionPolicy: "first-created-in-epoch",
      requestedLimit: requestedLimit ?? null,
      exportedDraftCount,
    },
    rows,
  };
}

export function readStrictEditorialReplayExportV2(inputPath: string): EditorialReplayExportV2 {
  const target = path.resolve(requiredText(inputPath, "replay input path"));
  if (!fs.existsSync(target)) throw new Error("replay export not found");
  return parseStrictEditorialReplayExportV2(JSON.parse(fs.readFileSync(target, "utf8")) as unknown);
}

/** Later append-only events are allowed; any source-prefix rewrite is rejected. */
export function verifyEditorialReplayLineageV2(replay: EditorialReplayExportV2, eventLogPath: string): void {
  const validated = parseStrictEditorialReplayExportV2(replay);
  const target = path.resolve(requiredText(eventLogPath, "editorial event log path"));
  if (!fs.existsSync(target)) throw new Error("editorial event log not found");
  const currentBytes = fs.readFileSync(target);
  if (currentBytes.byteLength < validated.lineage.sourceLedgerBytes) {
    throw new Error("editorial event log is shorter than replay lineage");
  }
  const sourcePrefix = currentBytes.subarray(0, validated.lineage.sourceLedgerBytes);
  if (sha256(sourcePrefix) !== validated.lineage.sourceLedgerSha256) {
    throw new Error("editorial event log prefix does not match replay lineage");
  }
  const allEvents = readEditorialEventsV2(target);
  const prefixLineCount = sourcePrefix.toString("utf8").split(/\r?\n/).filter((line) => line.trim()).length;
  if (prefixLineCount !== validated.lineage.sourceEventCount) {
    throw new Error("replay lineage event count does not match ledger prefix");
  }
  const sourceEvents = allEvents.slice(0, validated.lineage.sourceEventCount);
  const sourceDrafts = sourceEvents.filter(
    (event): event is Extract<EditorialEventV2, { type: "draft-created" }> =>
      event.type === "draft-created"
  );
  const sourceDraftCount = sourceDrafts.length;
  if (sourceDraftCount !== validated.lineage.sourceDraftCount) {
    throw new Error("replay lineage draft count does not match ledger prefix");
  }
  const epochDraftCount = sourceDrafts.filter(
    (event) => event.draft.collectionEpoch === validated.lineage.collectionEpoch
  ).length;
  if (
    epochDraftCount !== validated.lineage.epochDraftCount ||
    sourceDraftCount - epochDraftCount !== validated.lineage.excludedDraftCount
  ) {
    throw new Error("replay lineage epoch counts do not match ledger prefix");
  }
  const rebuilt = buildEditorialReplayFixturesV2(sourceEvents, {
    limit: validated.lineage.requestedLimit ?? undefined,
    collectionEpoch: validated.lineage.collectionEpoch,
  });
  if (JSON.stringify(rebuilt) !== JSON.stringify(validated.rows)) {
    throw new Error("replay rows do not match the source ledger prefix");
  }
}

export function sha256FileV2(inputPath: string): string {
  return sha256(fs.readFileSync(path.resolve(requiredText(inputPath, "input path"))));
}

export function serializeEditorialReplayExportV2(replay: EditorialReplayExportV2): string {
  return `${JSON.stringify(parseStrictEditorialReplayExportV2(replay), null, 2)}\n`;
}

/** Explicit export is immutable: a prior snapshot is never overwritten. */
export function writeNewEditorialReplayFileV2(outputPath: string, replay: EditorialReplayExportV2): string {
  const normalized = String(outputPath || "").trim();
  if (!normalized) throw new Error("replay output path is required");
  const target = path.resolve(normalized);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, serializeEditorialReplayExportV2(replay), { encoding: "utf8", flag: "wx" });
  return target;
}
