import fs from "fs";
import path from "path";
import { randomUUID } from "node:crypto";
import {
  EDITORIAL_V2_SCHEMA_VERSION,
  EditorialDraftRecordV2,
  EditorialDispatchIntentRecordV2,
  EditorialFactSnapshotV2,
  EditorialPublicationRecordV2,
  EditorialReviewActionV2,
  EditorialReviewRecordV2,
  FollowUpResolutionRecordV2,
} from "./contracts.js";
import { createFollowUpScheduleV2 } from "./follow-ups.js";
import { acquireRuntimeLock } from "../process-lock.js";

const SIGNAL_FRESHNESS_MS = 2 * 60 * 60 * 1000;
const NEWS_FRESHNESS_MS = 6 * 60 * 60 * 1000;
const SUBJECT_NOVELTY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface DraftCreatedEventV2 {
  schemaVersion: typeof EDITORIAL_V2_SCHEMA_VERSION;
  eventId: string;
  type: "draft-created";
  recordedAt: string;
  draft: EditorialDraftRecordV2;
}

export interface ReviewRecordedEventV2 {
  schemaVersion: typeof EDITORIAL_V2_SCHEMA_VERSION;
  eventId: string;
  type: "review-recorded";
  recordedAt: string;
  review: EditorialReviewRecordV2;
}

export interface DraftPublishedEventV2 {
  schemaVersion: typeof EDITORIAL_V2_SCHEMA_VERSION;
  eventId: string;
  type: "draft-published";
  recordedAt: string;
  publication: EditorialPublicationRecordV2;
}

export interface DispatchPreparedEventV2 {
  schemaVersion: typeof EDITORIAL_V2_SCHEMA_VERSION;
  eventId: string;
  type: "dispatch-prepared";
  recordedAt: string;
  intent: EditorialDispatchIntentRecordV2;
}

export interface FollowUpResolvedEventV2 {
  schemaVersion: typeof EDITORIAL_V2_SCHEMA_VERSION;
  eventId: string;
  type: "follow-up-resolved";
  recordedAt: string;
  resolution: FollowUpResolutionRecordV2;
}

export type EditorialEventV2 =
  | DraftCreatedEventV2
  | ReviewRecordedEventV2
  | DispatchPreparedEventV2
  | DraftPublishedEventV2
  | FollowUpResolvedEventV2;

export type EditorialReviewStatusV2 = "pending" | "approved" | "rejected";

export interface EditorialDraftStateV2 {
  draft: EditorialDraftRecordV2;
  reviews: readonly EditorialReviewRecordV2[];
  reviewStatus: EditorialReviewStatusV2;
  publishText: string;
  dispatchIntent?: EditorialDispatchIntentRecordV2;
  publication?: EditorialPublicationRecordV2;
  followUps: readonly FollowUpResolutionRecordV2[];
}

export interface EditorialLedgerV2 {
  drafts: ReadonlyMap<string, EditorialDraftStateV2>;
}

type EditorialIdKindV2 = "draft" | "review" | "dispatch" | "follow-up" | "event";

export interface EditorialEventStoreOptionsV2 {
  eventLogPath: string;
  now?: () => Date;
  idFactory?: (kind: EditorialIdKindV2) => string;
}

export type CreateEditorialDraftInputV2 = Omit<
  EditorialDraftRecordV2,
  "schemaVersion" | "id" | "createdAt"
> & {
  id?: string;
  createdAt?: string;
};

export interface RecordEditorialReviewInputV2 {
  reviewerId: string;
  reasonTags?: readonly string[];
  reviewedAt?: string;
}

export interface EditEditorialDraftInputV2 extends RecordEditorialReviewInputV2 {
  editedDraft: string;
}

export interface MarkEditorialPublishedInputV2 {
  externalPostId: string;
  publishedAt?: string;
  /** Freshness token returned by preparePublication immediately before X dispatch. */
  preparedAt?: string;
}

export interface MarkEditorialPublishedResultV2 {
  status: "published" | "already-published";
  publication: EditorialPublicationRecordV2;
}

export interface MarkEditorialDispatchingResultV2 {
  status: "dispatching";
  intent: EditorialDispatchIntentRecordV2;
}

export type PrepareEditorialPublicationResultV2 =
  | {
      status: "ready";
      draftId: string;
      publishText: string;
      facts: readonly EditorialFactSnapshotV2[];
      freshnessCheckedAt: string;
    }
  | {
      status: "already-published";
      publication: EditorialPublicationRecordV2;
    };

export type RecordFollowUpResolutionInputV2 = Omit<
  FollowUpResolutionRecordV2,
  "schemaVersion" | "id" | "draftId" | "resolvedAt"
> & {
  resolvedAt?: string;
};

export interface RecordFollowUpResolutionResultV2 {
  status: "recorded" | "already-recorded";
  resolution: FollowUpResolutionRecordV2;
}

function parseInstant(value: string, field: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${field} must be a valid instant`);
  }
  return timestamp;
}

function requireText(value: string, field: string): string {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new Error(`${field} is required`);
  }
  return normalized;
}

function normalizeTags(tags: readonly string[] | undefined): string[] {
  return [...new Set((tags ?? []).map((tag) => String(tag || "").trim()).filter(Boolean))];
}

function assertFiniteOptional(value: number | undefined, field: string): void {
  if (typeof value !== "undefined" && !Number.isFinite(value)) {
    throw new Error(`${field} must be finite`);
  }
}

function assertHttpUrl(value: string, field: string): void {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
  } catch {
    throw new Error(`${field} must be an HTTP URL`);
  }
}

function assertFact(fact: EditorialFactSnapshotV2): void {
  requireText(fact.factId, "fact.factId");
  requireText(fact.subject, "fact.subject");
  requireText(fact.metric.name, "fact.metric.name");
  requireText(fact.metric.raw, "fact.metric.raw");
  requireText(fact.metric.unit, "fact.metric.unit");
  requireText(fact.metric.period, "fact.metric.period");
  if (!Number.isFinite(fact.metric.value) || !/\d/.test(fact.metric.raw)) {
    throw new Error("fact.metric must contain a finite value and numeric raw text");
  }
  requireText(fact.source.provider, "fact.source.provider");
  assertHttpUrl(fact.source.url, "fact.source.url");
  parseInstant(fact.source.observedAt, "fact.source.observedAt");
  if (fact.source.publishedAt !== null) {
    parseInstant(fact.source.publishedAt, "fact.source.publishedAt");
  }
  if (fact.followUp) {
    requireText(fact.followUp.metric.name, "fact.followUp.metric.name");
    requireText(fact.followUp.metric.raw, "fact.followUp.metric.raw");
    requireText(fact.followUp.metric.unit, "fact.followUp.metric.unit");
    requireText(fact.followUp.metric.period, "fact.followUp.metric.period");
    if (!Number.isFinite(fact.followUp.metric.value) || !Number.isFinite(fact.followUp.threshold)) {
      throw new Error("fact.followUp values must be finite");
    }
    if (!["gt", "gte", "lt", "lte", "eq"].includes(fact.followUp.comparator)) {
      throw new Error("fact.followUp comparator is invalid");
    }
  }
  if (fact.selection) {
    if (
      fact.selection.kind !== "tvl-outlier" ||
      !Number.isFinite(fact.selection.absoluteMoveUsd) ||
      !Number.isFinite(fact.selection.benchmarkChangePercent) ||
      !Number.isFinite(fact.selection.residualPercentagePoints)
    ) {
      throw new Error("fact.selection is invalid");
    }
  }
}

function copyFact(fact: EditorialFactSnapshotV2): EditorialFactSnapshotV2 {
  return {
    ...fact,
    metric: { ...fact.metric },
    source: { ...fact.source },
    followUp: fact.followUp
      ? { ...fact.followUp, metric: { ...fact.followUp.metric } }
      : undefined,
    selection: fact.selection ? { ...fact.selection } : undefined,
  };
}

function assertDraft(draft: EditorialDraftRecordV2): void {
  if (draft.schemaVersion !== EDITORIAL_V2_SCHEMA_VERSION) {
    throw new Error("unsupported editorial draft schema");
  }
  requireText(draft.id, "draft.id");
  requireText(draft.runId, "draft.runId");
  requireText(draft.subject, "draft.subject");
  requireText(draft.thesis, "draft.thesis");
  requireText(draft.verdict, "draft.verdict");
  requireText(draft.draft, "draft.draft");
  if (!["bite", "withhold", "revisit", "evolution"].includes(draft.format)) {
    throw new Error(`unsupported editorial format: ${String(draft.format)}`);
  }
  if (!["curious", "energized", "skeptical", "patient", "humbled"].includes(draft.voiceState)) {
    throw new Error(`unsupported editorial voice state: ${String(draft.voiceState)}`);
  }
  const createdAt = parseInstant(draft.createdAt, "draft.createdAt");
  if (draft.factIds.length === 0 || draft.factIds.some((factId) => !String(factId || "").trim())) {
    throw new Error("draft.factIds must contain at least one non-empty id");
  }
  if (draft.facts.length !== draft.factIds.length) {
    throw new Error("draft.factIds must map exactly to draft.facts");
  }
  const factIds = new Set<string>();
  draft.facts.forEach((fact, index) => {
    assertFact(fact);
    if (factIds.has(fact.factId) || fact.factId !== draft.factIds[index]) {
      throw new Error("draft.factIds must map exactly to unique draft.facts in order");
    }
    factIds.add(fact.factId);
  });

  const expectedSchedule = createFollowUpScheduleV2(new Date(createdAt));
  if (
    parseInstant(draft.followUpSchedule.due24h, "draft.followUpSchedule.due24h") !==
      Date.parse(expectedSchedule.due24h) ||
    parseInstant(draft.followUpSchedule.due72h, "draft.followUpSchedule.due72h") !==
      Date.parse(expectedSchedule.due72h)
  ) {
    throw new Error("draft follow-up schedule must be exactly +24h and +72h from createdAt");
  }
  if (
    parseInstant(draft.falsifier.deadline, "draft.falsifier.deadline") !==
    Date.parse(expectedSchedule.due72h)
  ) {
    throw new Error("draft.falsifier.deadline must match the +72h checkpoint");
  }
  requireText(draft.falsifier.metric, "draft.falsifier.metric");
  if (!Number.isFinite(draft.falsifier.threshold)) {
    throw new Error("draft.falsifier.threshold must be finite");
  }
}

function assertReview(review: EditorialReviewRecordV2): void {
  if (review.schemaVersion !== EDITORIAL_V2_SCHEMA_VERSION) {
    throw new Error("unsupported editorial review schema");
  }
  requireText(review.id, "review.id");
  requireText(review.draftId, "review.draftId");
  requireText(review.reviewerId, "review.reviewerId");
  parseInstant(review.reviewedAt, "review.reviewedAt");
  if (!["approve", "edit", "reject"].includes(review.action)) {
    throw new Error(`unsupported editorial review action: ${String(review.action)}`);
  }
  if (review.action === "edit") {
    requireText(review.editedDraft || "", "review.editedDraft");
  } else if (typeof review.editedDraft !== "undefined") {
    throw new Error("review.editedDraft is only valid for edit decisions");
  }
  if ((review.action === "edit" || review.action === "reject") && review.reasonTags.length === 0) {
    throw new Error(`${review.action} review requires at least one reason tag`);
  }
}

function assertPublication(publication: EditorialPublicationRecordV2): void {
  if (publication.schemaVersion !== EDITORIAL_V2_SCHEMA_VERSION || publication.platform !== "x") {
    throw new Error("unsupported editorial publication record");
  }
  requireText(publication.draftId, "publication.draftId");
  requireText(publication.externalPostId, "publication.externalPostId");
  requireText(publication.publishedText, "publication.publishedText");
  const publishedAt = parseInstant(publication.publishedAt, "publication.publishedAt");
  const expected = createFollowUpScheduleV2(new Date(publishedAt));
  if (
    parseInstant(publication.followUpSchedule.due24h, "publication.followUpSchedule.due24h") !==
      Date.parse(expected.due24h) ||
    parseInstant(publication.followUpSchedule.due72h, "publication.followUpSchedule.due72h") !==
      Date.parse(expected.due72h)
  ) {
    throw new Error("publication follow-up schedule must be exactly +24h and +72h from publishedAt");
  }
  requireText(publication.falsifier.metric, "publication.falsifier.metric");
  if (!Number.isFinite(publication.falsifier.threshold)) {
    throw new Error("publication.falsifier.threshold must be finite");
  }
  if (parseInstant(publication.falsifier.deadline, "publication.falsifier.deadline") !== Date.parse(expected.due72h)) {
    throw new Error("publication falsifier deadline must match the published +72h checkpoint");
  }
}

function copyPublication(publication: EditorialPublicationRecordV2): EditorialPublicationRecordV2 {
  return {
    ...publication,
    followUpSchedule: { ...publication.followUpSchedule },
    falsifier: { ...publication.falsifier },
  };
}

function assertDispatchIntent(intent: EditorialDispatchIntentRecordV2): void {
  if (intent.schemaVersion !== EDITORIAL_V2_SCHEMA_VERSION) {
    throw new Error("unsupported editorial dispatch intent schema");
  }
  requireText(intent.id, "dispatchIntent.id");
  requireText(intent.draftId, "dispatchIntent.draftId");
  requireText(intent.publishText, "dispatchIntent.publishText");
  parseInstant(intent.preparedAt, "dispatchIntent.preparedAt");
  parseInstant(intent.recordedAt, "dispatchIntent.recordedAt");
}

function assertFollowUp(resolution: FollowUpResolutionRecordV2): void {
  if (resolution.schemaVersion !== EDITORIAL_V2_SCHEMA_VERSION) {
    throw new Error("unsupported editorial follow-up schema");
  }
  requireText(resolution.id, "resolution.id");
  requireText(resolution.draftId, "resolution.draftId");
  requireText(resolution.reason, "resolution.reason");
  parseInstant(resolution.resolvedAt, "resolution.resolvedAt");
  if (resolution.observedAt) parseInstant(resolution.observedAt, "resolution.observedAt");
  assertFiniteOptional(resolution.baselineValue, "resolution.baselineValue");
  assertFiniteOptional(resolution.observedValue, "resolution.observedValue");
  const valid24h = resolution.checkpoint === "24h" && ["candidate", "silent"].includes(resolution.resolution);
  const valid72h =
    resolution.checkpoint === "72h" &&
    ["supported", "invalidated", "unresolved"].includes(resolution.resolution);
  if (!valid24h && !valid72h) {
    throw new Error("resolution is invalid for its checkpoint");
  }
  const publicResolution = ["candidate", "supported", "invalidated"].includes(resolution.resolution);
  if (publicResolution && !resolution.observation) {
    throw new Error("public follow-up resolution requires an immutable observation");
  }
  if (resolution.observation) {
    assertFact(resolution.observation);
    if (
      resolution.metric !== resolution.observation.metric.name ||
      resolution.observedValue !== resolution.observation.metric.value ||
      resolution.observedAt !== resolution.observation.source.observedAt
    ) {
      throw new Error("follow-up observation must match its recorded metric, value, and time");
    }
  }
}

function copyFollowUp(resolution: FollowUpResolutionRecordV2): FollowUpResolutionRecordV2 {
  return {
    ...resolution,
    observation: resolution.observation ? copyFact(resolution.observation) : undefined,
  };
}

function assertEvent(event: EditorialEventV2): void {
  if (event.schemaVersion !== EDITORIAL_V2_SCHEMA_VERSION) {
    throw new Error(`unsupported editorial event schema: ${String(event.schemaVersion)}`);
  }
  requireText(event.eventId, "event.eventId");
  parseInstant(event.recordedAt, "event.recordedAt");
  if (event.type === "draft-created") {
    assertDraft(event.draft);
  } else if (event.type === "review-recorded") {
    assertReview(event.review);
  } else if (event.type === "dispatch-prepared") {
    assertDispatchIntent(event.intent);
  } else if (event.type === "draft-published") {
    assertPublication(event.publication);
  } else if (event.type === "follow-up-resolved") {
    assertFollowUp(event.resolution);
  } else {
    throw new Error(`unsupported editorial event type: ${String((event as { type?: unknown }).type)}`);
  }
}

function copyState(state: EditorialDraftStateV2): EditorialDraftStateV2 {
  return {
    ...state,
    draft: {
      ...state.draft,
      factIds: [...state.draft.factIds],
      facts: state.draft.facts.map(copyFact),
      falsifier: { ...state.draft.falsifier },
      followUpSchedule: { ...state.draft.followUpSchedule },
    },
    reviews: state.reviews.map((review) => ({ ...review, reasonTags: [...review.reasonTags] })),
    dispatchIntent: state.dispatchIntent ? { ...state.dispatchIntent } : undefined,
    publication: state.publication ? copyPublication(state.publication) : undefined,
    followUps: state.followUps.map(copyFollowUp),
  };
}

export function foldEditorialEventsV2(events: readonly EditorialEventV2[]): EditorialLedgerV2 {
  const drafts = new Map<string, EditorialDraftStateV2>();
  const eventIds = new Set<string>();

  for (const event of events) {
    assertEvent(event);
    if (eventIds.has(event.eventId)) {
      throw new Error(`duplicate editorial event id: ${event.eventId}`);
    }
    eventIds.add(event.eventId);

    if (event.type === "draft-created") {
      if (drafts.has(event.draft.id)) {
        throw new Error(`duplicate editorial draft id: ${event.draft.id}`);
      }
      drafts.set(event.draft.id, {
        draft: {
          ...event.draft,
          factIds: [...event.draft.factIds],
          facts: event.draft.facts.map(copyFact),
        },
        reviews: [],
        reviewStatus: "pending",
        publishText: event.draft.draft,
        followUps: [],
      });
      continue;
    }

    const draftId =
      event.type === "review-recorded"
        ? event.review.draftId
        : event.type === "dispatch-prepared"
          ? event.intent.draftId
          : event.type === "draft-published"
            ? event.publication.draftId
            : event.resolution.draftId;
    const current = drafts.get(draftId);
    if (!current) {
      throw new Error(`${event.type} references unknown draft: ${draftId}`);
    }

    if (event.type === "review-recorded") {
      if (current.publication) {
        throw new Error(`published draft cannot be reviewed again: ${draftId}`);
      }
      if (current.dispatchIntent) {
        throw new Error(`dispatching draft cannot be reviewed again: ${draftId}`);
      }
      const reviewStatus = event.review.action === "reject" ? "rejected" : "approved";
      drafts.set(draftId, {
        ...current,
        reviews: [...current.reviews, { ...event.review, reasonTags: [...event.review.reasonTags] }],
        reviewStatus,
        publishText: event.review.action === "edit" ? event.review.editedDraft as string : current.publishText,
      });
      continue;
    }

    if (event.type === "dispatch-prepared") {
      if (current.publication) throw new Error(`published draft cannot dispatch again: ${draftId}`);
      if (current.dispatchIntent) throw new Error(`draft already has a dispatch intent: ${draftId}`);
      if (current.reviewStatus !== "approved") {
        throw new Error(`draft must be approved before dispatch: ${draftId}`);
      }
      if (event.intent.publishText !== current.publishText) {
        throw new Error(`dispatch text does not match the approved draft: ${draftId}`);
      }
      drafts.set(draftId, { ...current, dispatchIntent: { ...event.intent } });
      continue;
    }

    if (event.type === "draft-published") {
      if (current.publication) {
        if (
          current.publication.externalPostId === event.publication.externalPostId &&
          current.publication.publishedText === event.publication.publishedText
        ) {
          continue;
        }
        throw new Error(`draft has conflicting publication records: ${draftId}`);
      }
      if (current.reviewStatus !== "approved") {
        throw new Error(`draft must be approved before publication: ${draftId}`);
      }
      if (!current.dispatchIntent) {
        throw new Error(`draft must have a dispatch intent before publication: ${draftId}`);
      }
      if (event.publication.publishedText !== current.publishText) {
        throw new Error(`published text does not match the approved draft: ${draftId}`);
      }
      drafts.set(draftId, {
        ...current,
        publication: copyPublication(event.publication),
      });
      continue;
    }

    const existing = current.followUps.find(
      (resolution) => resolution.checkpoint === event.resolution.checkpoint
    );
    if (existing) {
      if (
        existing.resolution === event.resolution.resolution &&
        existing.reason === event.resolution.reason
      ) {
        continue;
      }
      throw new Error(`draft has conflicting ${event.resolution.checkpoint} resolutions: ${draftId}`);
    }
    drafts.set(draftId, {
      ...current,
      followUps: [...current.followUps, copyFollowUp(event.resolution)],
    });
  }

  return {
    drafts: new Map([...drafts].map(([id, state]) => [id, copyState(state)])),
  };
}

export function readEditorialEventsV2(eventLogPath: string): EditorialEventV2[] {
  if (!fs.existsSync(eventLogPath)) return [];
  const raw = fs.readFileSync(eventLogPath, "utf-8");
  const events: EditorialEventV2[] = [];
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as EditorialEventV2;
      assertEvent(event);
      events.push(event);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown parse error";
      throw new Error(`invalid editorial event at line ${index + 1}: ${message}`);
    }
  }
  return events;
}

export class EditorialEventStoreV2 {
  private readonly eventLogPath: string;
  private readonly mutationLockPath: string;
  private readonly clock: () => Date;
  private readonly idFactory: (kind: EditorialIdKindV2) => string;

  constructor(options: EditorialEventStoreOptionsV2) {
    this.eventLogPath = requireText(options.eventLogPath, "eventLogPath");
    this.mutationLockPath = `${this.eventLogPath}.lock`;
    this.clock = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? ((kind) => `${kind}_${randomUUID()}`);
  }

  createDraft(input: CreateEditorialDraftInputV2): EditorialDraftRecordV2 {
    return this.withMutationLock("create-draft", () => {
    const createdAt = this.normalizeInstant(input.createdAt ?? this.nowIso(), "draft.createdAt");
    const draft: EditorialDraftRecordV2 = {
      ...input,
      schemaVersion: EDITORIAL_V2_SCHEMA_VERSION,
      id: requireText(input.id ?? this.newId("draft"), "draft.id"),
      runId: requireText(input.runId, "draft.runId"),
      createdAt,
      subject: requireText(input.subject, "draft.subject"),
      thesis: requireText(input.thesis, "draft.thesis"),
      factIds: [...new Set(input.factIds.map((factId) => String(factId || "").trim()).filter(Boolean))],
      facts: input.facts.map(copyFact),
      verdict: requireText(input.verdict, "draft.verdict"),
      falsifier: { ...input.falsifier },
      followUpSchedule: { ...input.followUpSchedule },
      continuityThread: input.continuityThread?.trim() || undefined,
      draft: requireText(input.draft, "draft.draft"),
    };
    assertDraft(draft);
    if (this.ledger().drafts.has(draft.id)) {
      throw new Error(`duplicate editorial draft id: ${draft.id}`);
    }
    this.append({
      schemaVersion: EDITORIAL_V2_SCHEMA_VERSION,
      eventId: this.newId("event"),
      type: "draft-created",
      recordedAt: this.nowIso(),
      draft,
    });
    return copyState({ draft, reviews: [], reviewStatus: "pending", publishText: draft.draft, followUps: [] }).draft;
    });
  }

  approve(draftId: string, input: RecordEditorialReviewInputV2): EditorialReviewRecordV2 {
    return this.recordReview(draftId, "approve", input);
  }

  edit(draftId: string, input: EditEditorialDraftInputV2): EditorialReviewRecordV2 {
    return this.recordReview(draftId, "edit", input, input.editedDraft);
  }

  reject(draftId: string, input: RecordEditorialReviewInputV2): EditorialReviewRecordV2 {
    return this.recordReview(draftId, "reject", input);
  }

  preparePublication(draftId: string): PrepareEditorialPublicationResultV2 {
    const state = this.requireDraftState(draftId);
    if (state.publication) {
      return {
        status: "already-published",
        publication: copyPublication(state.publication),
      };
    }
    if (state.dispatchIntent) {
      throw new Error(`draft has unresolved dispatch intent: ${draftId}`);
    }
    if (state.reviewStatus !== "approved") {
      throw new Error(`draft must be approved before publication: ${draftId}`);
    }
    const freshnessCheckedAt = this.nowIso();
    this.assertFactsFreshForPublication(state.draft.facts, freshnessCheckedAt);
    return {
      status: "ready",
      draftId: state.draft.id,
      publishText: state.publishText,
      facts: state.draft.facts.map(copyFact),
      freshnessCheckedAt,
    };
  }

  markDispatching(
    draftId: string,
    input: { preparedAt: string; expectedPublishText: string }
  ): MarkEditorialDispatchingResultV2 {
    return this.withMutationLock("mark-dispatching", () => {
    const preparation = this.preparePublicationAt(draftId, input.preparedAt, false);
    if (preparation.status === "already-published") {
      throw new Error(`published draft cannot dispatch again: ${draftId}`);
    }
    if (preparation.publishText !== input.expectedPublishText) {
      throw new Error(`approved draft changed after publication preparation: ${draftId}`);
    }
    this.assertSubjectNoveltyForDispatch(preparation.draftId, preparation.freshnessCheckedAt);
    const recordedAt = this.nowIso();
    const intent: EditorialDispatchIntentRecordV2 = {
      schemaVersion: EDITORIAL_V2_SCHEMA_VERSION,
      id: this.newId("dispatch"),
      draftId: preparation.draftId,
      publishText: preparation.publishText,
      preparedAt: preparation.freshnessCheckedAt,
      recordedAt,
    };
    this.append({
      schemaVersion: EDITORIAL_V2_SCHEMA_VERSION,
      eventId: this.newId("event"),
      type: "dispatch-prepared",
      recordedAt,
      intent,
    });
    return { status: "dispatching", intent: { ...intent } };
    });
  }

  markPublished(
    draftId: string,
    input: MarkEditorialPublishedInputV2
  ): MarkEditorialPublishedResultV2 {
    return this.withMutationLock("mark-published", () => {
    const state = this.requireDraftState(draftId);
    if (state.publication) {
      return {
        status: "already-published",
        publication: copyPublication(state.publication),
      };
    }
    if (state.reviewStatus !== "approved") {
      throw new Error(`draft must be approved before publication: ${draftId}`);
    }
    if (!state.dispatchIntent) {
      throw new Error(`draft must have a dispatch intent before publication: ${draftId}`);
    }
    if (input.preparedAt && input.preparedAt !== state.dispatchIntent.preparedAt) {
      throw new Error("publication preparedAt does not match dispatch intent");
    }
    const preparation = this.preparePublicationAt(
      draftId,
      state.dispatchIntent.preparedAt,
      true
    );
    if (preparation.status === "already-published") {
      return preparation;
    }
    return this.appendPublication(preparation, input);
    });
  }

  /**
   * Operator-only recovery for an X response that was accepted but could not
   * be durably committed locally. It never calls X and requires a prior intent.
   */
  reconcilePublished(
    draftId: string,
    input: Required<Pick<MarkEditorialPublishedInputV2, "externalPostId" | "publishedAt">>
  ): MarkEditorialPublishedResultV2 {
    return this.withMutationLock("reconcile-published", () => {
    const state = this.requireDraftState(draftId);
    if (state.publication) {
      return {
        status: "already-published",
        publication: copyPublication(state.publication),
      };
    }
    if (!state.dispatchIntent) {
      throw new Error(`draft has no dispatch intent to reconcile: ${draftId}`);
    }
    const publishedAt = this.normalizeInstant(input.publishedAt, "publication.publishedAt");
    if (Date.parse(publishedAt) < Date.parse(state.dispatchIntent.recordedAt)) {
      throw new Error("reconciled publication predates dispatch intent");
    }
    return this.appendPublication(
      {
        status: "ready",
        draftId: state.draft.id,
        publishText: state.publishText,
        facts: state.draft.facts.map(copyFact),
        freshnessCheckedAt: state.dispatchIntent.preparedAt,
      },
      { ...input, publishedAt }
    );
    });
  }

  private appendPublication(
    preparation: Extract<PrepareEditorialPublicationResultV2, { status: "ready" }>,
    input: MarkEditorialPublishedInputV2
  ): MarkEditorialPublishedResultV2 {
    const publishedAt = this.normalizeInstant(input.publishedAt ?? this.nowIso(), "publication.publishedAt");
    const followUpSchedule = createFollowUpScheduleV2(publishedAt);
    const draftFalsifier = this.requireDraftState(preparation.draftId).draft.falsifier;
    const publication: EditorialPublicationRecordV2 = {
      schemaVersion: EDITORIAL_V2_SCHEMA_VERSION,
      draftId: preparation.draftId,
      platform: "x",
      externalPostId: requireText(input.externalPostId, "publication.externalPostId"),
      publishedText: preparation.publishText,
      publishedAt,
      followUpSchedule,
      falsifier: { ...draftFalsifier, deadline: followUpSchedule.due72h },
    };
    this.append({
      schemaVersion: EDITORIAL_V2_SCHEMA_VERSION,
      eventId: this.newId("event"),
      type: "draft-published",
      recordedAt: this.nowIso(),
      publication,
    });
    return {
      status: "published",
      publication: copyPublication(publication),
    };
  }

  private preparePublicationAt(
    draftId: string,
    freshnessCheckedAt: string,
    allowDispatchIntent: boolean
  ): PrepareEditorialPublicationResultV2 {
    const state = this.requireDraftState(draftId);
    if (state.publication) {
      return {
        status: "already-published",
        publication: copyPublication(state.publication),
      };
    }
    if (state.dispatchIntent && !allowDispatchIntent) {
      throw new Error(`draft has unresolved dispatch intent: ${draftId}`);
    }
    if (state.reviewStatus !== "approved") {
      throw new Error(`draft must be approved before publication: ${draftId}`);
    }
    const preparedMs = parseInstant(freshnessCheckedAt, "publication.preparedAt");
    const currentMs = this.clock().getTime();
    if (preparedMs > currentMs || currentMs - preparedMs > 5 * 60 * 1000) {
      throw new Error("publication freshness preparation expired");
    }
    const normalized = new Date(preparedMs).toISOString();
    this.assertFactsFreshForPublication(state.draft.facts, normalized);
    return {
      status: "ready",
      draftId: state.draft.id,
      publishText: state.publishText,
      facts: state.draft.facts.map(copyFact),
      freshnessCheckedAt: normalized,
    };
  }

  recordFollowUpResolution(
    draftId: string,
    input: RecordFollowUpResolutionInputV2
  ): RecordFollowUpResolutionResultV2 {
    return this.withMutationLock("record-follow-up", () => {
    const state = this.requireDraftState(draftId);
    const existing = state.followUps.find((resolution) => resolution.checkpoint === input.checkpoint);
    if (existing) {
      return { status: "already-recorded", resolution: copyFollowUp(existing) };
    }
    const resolution: FollowUpResolutionRecordV2 = {
      ...input,
      schemaVersion: EDITORIAL_V2_SCHEMA_VERSION,
      id: this.newId("follow-up"),
      draftId: state.draft.id,
      reason: requireText(input.reason, "resolution.reason"),
      resolvedAt: this.normalizeInstant(input.resolvedAt ?? this.nowIso(), "resolution.resolvedAt"),
    };
    assertFollowUp(resolution);
    this.append({
      schemaVersion: EDITORIAL_V2_SCHEMA_VERSION,
      eventId: this.newId("event"),
      type: "follow-up-resolved",
      recordedAt: this.nowIso(),
      resolution,
    });
    return { status: "recorded", resolution: copyFollowUp(resolution) };
    });
  }

  getDraftState(draftId: string): EditorialDraftStateV2 | null {
    const state = this.ledger().drafts.get(String(draftId || "").trim());
    return state ? copyState(state) : null;
  }

  listDraftStates(): EditorialDraftStateV2[] {
    return [...this.ledger().drafts.values()].map(copyState);
  }

  readEvents(): EditorialEventV2[] {
    return readEditorialEventsV2(this.eventLogPath);
  }

  private recordReview(
    draftId: string,
    action: EditorialReviewActionV2,
    input: RecordEditorialReviewInputV2,
    editedDraft?: string
  ): EditorialReviewRecordV2 {
    return this.withMutationLock("record-review", () => {
    const state = this.requireDraftState(draftId);
    if (state.publication) {
      throw new Error(`published draft cannot be reviewed again: ${draftId}`);
    }
    if (state.dispatchIntent) {
      throw new Error(`dispatching draft cannot be reviewed again: ${draftId}`);
    }
    const review: EditorialReviewRecordV2 = {
      schemaVersion: EDITORIAL_V2_SCHEMA_VERSION,
      id: this.newId("review"),
      draftId: state.draft.id,
      action,
      reviewerId: requireText(input.reviewerId, "review.reviewerId"),
      reasonTags: normalizeTags(input.reasonTags),
      reviewedAt: this.normalizeInstant(input.reviewedAt ?? this.nowIso(), "review.reviewedAt"),
      editedDraft: action === "edit" ? requireText(editedDraft || "", "review.editedDraft") : undefined,
    };
    assertReview(review);
    this.append({
      schemaVersion: EDITORIAL_V2_SCHEMA_VERSION,
      eventId: this.newId("event"),
      type: "review-recorded",
      recordedAt: this.nowIso(),
      review,
    });
    return { ...review, reasonTags: [...review.reasonTags] };
    });
  }

  private withMutationLock<T>(operation: string, run: () => T): T {
    const lock = acquireRuntimeLock(this.mutationLockPath);
    if (!lock.acquired) {
      throw new Error(`editorial ledger busy during ${operation}`);
    }
    try {
      return run();
    } finally {
      lock.release();
    }
  }

  private ledger(): EditorialLedgerV2 {
    return foldEditorialEventsV2(this.readEvents());
  }

  private requireDraftState(draftId: string): EditorialDraftStateV2 {
    const normalizedId = requireText(draftId, "draftId");
    const state = this.ledger().drafts.get(normalizedId);
    if (!state) {
      throw new Error(`unknown editorial draft: ${normalizedId}`);
    }
    return state;
  }

  private append(event: EditorialEventV2): void {
    assertEvent(event);
    fs.mkdirSync(path.dirname(this.eventLogPath), { recursive: true });
    const descriptor = fs.openSync(this.eventLogPath, "a");
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(event)}\n`, { encoding: "utf-8" });
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  }

  private assertFactsFreshForPublication(
    facts: readonly EditorialFactSnapshotV2[],
    checkedAt: string
  ): void {
    const checkedAtMs = parseInstant(checkedAt, "freshness.checkedAt");
    for (const fact of facts) {
      const isNews = fact.source.publishedAt !== null;
      const measuredAt = fact.source.publishedAt ?? fact.source.observedAt;
      const ageMs = checkedAtMs - parseInstant(measuredAt, `fact ${fact.factId} measuredAt`);
      const maxAgeMs = isNews ? NEWS_FRESHNESS_MS : SIGNAL_FRESHNESS_MS;
      if (ageMs < 0) {
        throw new Error(`draft evidence is from the future at publication: ${fact.factId}`);
      }
      if (ageMs > maxAgeMs) {
        throw new Error(`draft evidence is stale at publication: ${fact.factId}`);
      }
    }
  }

  private assertSubjectNoveltyForDispatch(draftId: string, checkedAt: string): void {
    const ledger = this.ledger();
    const current = ledger.drafts.get(draftId);
    if (!current) throw new Error(`unknown editorial draft: ${draftId}`);
    if (current.draft.format === "revisit") return;
    const currentFact = current.draft.facts[0];
    if (!currentFact) throw new Error(`draft has no evidence fact: ${draftId}`);
    const checkedAtMs = parseInstant(checkedAt, "subjectNovelty.checkedAt");
    const latest = [...ledger.drafts.values()]
      .filter((candidate) => candidate.draft.id !== draftId)
      .flatMap((candidate) => {
        const actedAt = candidate.publication?.publishedAt || candidate.dispatchIntent?.recordedAt;
        const fact = candidate.draft.facts[0];
        if (!actedAt || !fact) return [];
        const actedAtMs = parseInstant(actedAt, "subjectNovelty.actedAt");
        const stableMatch = Boolean(
          currentFact.subjectKey &&
          fact.subjectKey &&
          currentFact.subjectKey === fact.subjectKey &&
          currentFact.source.provider === fact.source.provider
        );
        const displayMatch = current.draft.subject === candidate.draft.subject;
        if ((!stableMatch && !displayMatch) || actedAtMs > checkedAtMs || checkedAtMs - actedAtMs >= SUBJECT_NOVELTY_WINDOW_MS) {
          return [];
        }
        return [{ actedAtMs, fact }];
      })
      .sort((left, right) => right.actedAtMs - left.actedAtMs)[0];
    if (!latest) return;

    const prior = latest.fact;
    const comparable =
      prior.metric.name === currentFact.metric.name &&
      prior.metric.unit === currentFact.metric.unit &&
      prior.metric.period === currentFact.metric.period;
    const laterObservation =
      parseInstant(currentFact.source.observedAt, "subjectNovelty.currentObservedAt") >
      parseInstant(prior.source.observedAt, "subjectNovelty.priorObservedAt");
    const delta = Math.abs(currentFact.metric.value - prior.metric.value);
    const meaningfulDelta = currentFact.metric.unit === "%"
      ? delta >= 0.5
      : prior.metric.value === 0
        ? delta > 0
        : delta / Math.abs(prior.metric.value) >= 0.02;
    if (!comparable || !laterObservation || currentFact.factId === prior.factId || !meaningfulDelta) {
      throw new Error(`same subject within 24h requires a new meaningful numeric change: ${draftId}`);
    }
  }

  private nowIso(): string {
    const now = this.clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error("editorial clock returned an invalid date");
    }
    return now.toISOString();
  }

  private newId(kind: EditorialIdKindV2): string {
    return requireText(this.idFactory(kind), `${kind} id`);
  }

  private normalizeInstant(value: string, field: string): string {
    return new Date(parseInstant(value, field)).toISOString();
  }
}
