import { randomUUID } from "node:crypto";
import type { ActionMode } from "../../types/runtime.js";
import type {
  EditorialFactSnapshotV2,
  FollowUpCheckpointV2,
  FollowUpResolutionRecordV2,
  MeaningfulChangeThresholdV2,
} from "./contracts.js";
import { EDITORIAL_COLLECTION_EPOCH_V2 } from "./contracts.js";
import {
  EditorialContinuityThreadConflictV2,
  EditorialEventStoreV2,
  type EditorialDraftStateV2,
} from "./event-store.js";
import {
  assessTierAEligibilityV2,
  evaluateEvidenceFreshnessV2,
  type EvidenceCardV2,
} from "./evidence.js";
import {
  FOLLOW_UP_CHECKPOINT_WINDOW_MS_V2,
  resolve24HourFollowUpV2,
  resolve72HourFollowUpV2,
} from "./follow-ups.js";
import { planEditorialV2, type DueRevisitV2, type EditorialHistoryEntryV2 } from "./planner.js";
import {
  collectEditorialEvidenceV2,
  type EditorialFollowUpTargetV2,
  type EditorialSensingResultV2,
} from "./provider-adapters.js";
import { appendEditorialMetricV2, buildEditorialMetricV2 } from "./telemetry.js";
import { writeEditorialDraftV2, type EditorialWriterModelV2 } from "./writer.js";

export type EditorialCollectResultV2 =
  | { status: "drafted"; draftId: string; draft: string; runId: string; actionId: string }
  | { status: "no-post"; stage: string; reason: string; runId: string; actionId: string };

export interface CollectEditorialDraftInputV2 {
  store: EditorialEventStoreV2;
  writerModel: EditorialWriterModelV2;
  metricLogPath: string;
  mode: ActionMode;
  now?: Date;
  runId?: string;
  actionId?: string;
  selectionSeed?: string;
  sensing?: EditorialSensingResultV2;
  sense?: (followUpTargets: readonly EditorialFollowUpTargetV2[]) => Promise<EditorialSensingResultV2>;
}

export interface CheckEditorialFollowUpsInputV2 {
  store: EditorialEventStoreV2;
  metricLogPath: string;
  mode: ActionMode;
  now?: Date;
  runId?: string;
  actionId?: string;
  sensing?: EditorialSensingResultV2;
  sense?: (followUpTargets: readonly EditorialFollowUpTargetV2[]) => Promise<EditorialSensingResultV2>;
}

export interface CheckEditorialFollowUpsResultV2 {
  status: "checked";
  targetCount: number;
  resolutionCount: number;
  publicCandidateCount: number;
  retryableCount: number;
  runId: string;
  actionId: string;
}

function factSnapshot(card: EvidenceCardV2): EditorialFactSnapshotV2 {
  return {
    factId: card.id,
    subject: card.subject,
    subjectKey: card.subjectKey,
    metric: { ...card.metric },
    source: {
      provider: card.source.provider,
      url: card.source.url,
      publishedAt: card.source.publishedAt,
      observedAt: card.source.observedAt,
    },
    followUp: card.followUp
      ? {
          metric: { ...card.followUp.metric },
          comparator: card.followUp.comparator,
          threshold: card.followUp.threshold,
        }
      : undefined,
    selection: card.selection
      ? {
          ...card.selection,
          priceNeutral: card.selection.priceNeutral
            ? { ...card.selection.priceNeutral }
            : undefined,
        }
      : undefined,
  };
}

function checkpointEvidence(
  snapshot: EditorialFactSnapshotV2,
  currentHealthCard: EvidenceCardV2,
  now: string
): EvidenceCardV2 {
  const kind = snapshot.source.publishedAt ? "news" : "signal";
  return {
    ...currentHealthCard,
    id: snapshot.factId,
    kind,
    subject: snapshot.subject,
    subjectKey: snapshot.subjectKey,
    metric: { ...snapshot.metric },
    followUp: snapshot.followUp
      ? { ...snapshot.followUp, metric: { ...snapshot.followUp.metric } }
      : undefined,
    selection: snapshot.selection
      ? {
          ...snapshot.selection,
          priceNeutral: snapshot.selection.priceNeutral
            ? { ...snapshot.selection.priceNeutral }
            : undefined,
        }
      : undefined,
    source: {
      ...currentHealthCard.source,
      provider: snapshot.source.provider as EvidenceCardV2["source"]["provider"],
      url: snapshot.source.url,
      publishedAt: snapshot.source.publishedAt,
      observedAt: snapshot.source.observedAt,
      origin: "direct",
      role: "primary",
    },
    freshness: evaluateEvidenceFreshnessV2({
      kind,
      observedAt: snapshot.source.observedAt,
      publishedAt: snapshot.source.publishedAt,
      now,
    }),
  };
}

function firstFact(state: EditorialDraftStateV2): EditorialFactSnapshotV2 | null {
  return state.draft.facts[0] ?? null;
}

function historyFromStore(states: readonly EditorialDraftStateV2[]): EditorialHistoryEntryV2[] {
  return states.flatMap((state) => {
    if (!state.publication) return [];
    const fact = firstFact(state);
    if (!fact) return [];
    return [{
      subject: state.draft.subject,
      subjectKey: fact.subjectKey,
      provider: fact.source.provider,
      metricName: fact.metric.name,
      metricValue: fact.metric.value,
      factId: fact.factId,
      publishedAt: state.publication.publishedAt,
    }];
  });
}

function revisitThread(draftId: string, checkpoint: FollowUpCheckpointV2): string {
  return `${draftId}:${checkpoint}`;
}

function hasQueuedRevisit(
  states: readonly EditorialDraftStateV2[],
  draftId: string,
  checkpoint: FollowUpCheckpointV2
): boolean {
  const thread = revisitThread(draftId, checkpoint);
  return states.some(
    (state) => state.draft.format === "revisit" && state.draft.continuityThread === thread
  );
}

function dueFollowUpTargets(
  states: readonly EditorialDraftStateV2[],
  now: string
): EditorialFollowUpTargetV2[] {
  const nowMs = Date.parse(now);
  const targets = new Map<string, EditorialFollowUpTargetV2>();
  for (const state of states) {
    if (!state.publication || !["bite", "withhold"].includes(state.draft.format)) continue;
    const fact = firstFact(state);
    if (!fact) continue;
    const has24 = state.followUps.some((row) => row.checkpoint === "24h");
    const has72 = state.followUps.some((row) => row.checkpoint === "72h");
    const schedule = state.publication.followUpSchedule;
    const needs24 = !has24 && nowMs >= Date.parse(schedule.due24h) && nowMs < Date.parse(schedule.due72h);
    const needs72 = !has72 && nowMs >= Date.parse(schedule.due72h);
    const pendingPublicResolution = state.followUps.some(
      (row) =>
        resolutionHasPublicValue(fact, row) &&
        !hasQueuedRevisit(states, state.draft.id, row.checkpoint)
    );
    if (!needs24 && !needs72 && !pendingPublicResolution) continue;
    const metric = fact.followUp?.metric ?? fact.metric;
    const target: EditorialFollowUpTargetV2 = {
      provider: fact.source.provider as EditorialFollowUpTargetV2["provider"],
      subject: state.draft.subject,
      subjectKey: fact.subjectKey,
      metricName: metric.name,
      unit: metric.unit,
      period: metric.period,
    };
    targets.set(`${target.provider}\u0000${target.subjectKey || target.subject}\u0000${target.metricName}`, target);
  }
  return [...targets.values()];
}

function meaningfulChangeThreshold(fact: EditorialFactSnapshotV2): MeaningfulChangeThresholdV2 {
  const metric = fact.followUp?.metric ?? fact.metric;
  return metric.unit === "%"
    ? { kind: "absolute", value: 0.5 }
    : { kind: "relative", value: 0.02 };
}

function hasMeaningfulFollowUpChange(
  fact: EditorialFactSnapshotV2,
  observedValue: number
): boolean {
  const baseline = (fact.followUp?.metric ?? fact.metric).value;
  const threshold = meaningfulChangeThreshold(fact);
  const delta = Math.abs(observedValue - baseline);
  if (threshold.kind === "absolute") return delta >= threshold.value;
  if (baseline === 0) return delta > 0;
  return delta / Math.abs(baseline) >= threshold.value;
}

function followUpMetricDetails(input: {
  draftId: string;
  dueAt: string;
  now: string;
  observedAt?: string;
}): Record<string, string | number | null> {
  const dueMs = Date.parse(input.dueAt);
  const effectiveMs = input.observedAt ? Date.parse(input.observedAt) : Date.parse(input.now);
  return {
    draftId: input.draftId,
    dueAt: input.dueAt,
    observedAt: input.observedAt ?? null,
    delayMs: Number.isFinite(dueMs) && Number.isFinite(effectiveMs) ? effectiveMs - dueMs : 0,
    windowEndAt: new Date(dueMs + FOLLOW_UP_CHECKPOINT_WINDOW_MS_V2).toISOString(),
  };
}

function resolutionHasPublicValue(
  fact: EditorialFactSnapshotV2,
  resolution: FollowUpResolutionRecordV2
): resolution is FollowUpResolutionRecordV2 & {
  resolution: "candidate" | "supported" | "invalidated";
} {
  if (resolution.checkpoint === "24h") return resolution.resolution === "candidate";
  if (resolution.resolution === "invalidated") return true;
  return resolution.resolution === "supported" &&
    typeof resolution.observedValue === "number" &&
    hasMeaningfulFollowUpChange(fact, resolution.observedValue);
}

function matchingObservation(
  state: EditorialDraftStateV2,
  cards: readonly EvidenceCardV2[],
  now: string
): EvidenceCardV2 | undefined {
  const fact = firstFact(state);
  if (!fact) return undefined;
  const metric = fact.followUp?.metric ?? fact.metric;
  return cards.find(
    (card) =>
      card.source.provider === fact.source.provider &&
      (fact.subjectKey ? card.subjectKey === fact.subjectKey : card.subject === state.draft.subject) &&
      card.metric.name === metric.name &&
      card.metric.unit === metric.unit &&
      card.metric.period === metric.period &&
      assessTierAEligibilityV2(card, now).eligible
  );
}

function appendProviderMetrics(
  sensing: EditorialSensingResultV2,
  context: { runId: string; actionId: string; mode: ActionMode; now: Date },
  metricLogPath: string
): void {
  for (const provider of sensing.providers) {
    const outcome = provider.outcome;
    const gapReasonCounts = new Map<string, number>();
    for (const reason of provider.selectionGaps?.flatMap((gap) => gap.reasons) ?? []) {
      gapReasonCounts.set(reason, (gapReasonCounts.get(reason) ?? 0) + 1);
    }
    appendEditorialMetricV2(metricLogPath, buildEditorialMetricV2(context, {
      type: "provider_fetch",
      stage: "sensing",
      outcome: outcome.kind,
      reason: outcome.kind === "failure" ? outcome.failure : undefined,
      details: {
        provider: outcome.provider,
        latencyMs: outcome.latencyMs,
        itemCount: outcome.kind === "success" ? outcome.itemCount : 0,
        statusCode: outcome.kind === "failure" ? outcome.statusCode ?? null : null,
        qualifiedEvidenceCount: provider.evidence.length,
        selectionGapCount: provider.selectionGaps?.length ?? 0,
        selectionGapReasons: [
          ...gapReasonCounts.keys(),
        ],
        selectionGapSummary: [...gapReasonCounts]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([reason, count]) => `${reason}=${count}`),
        selectionClassSummary: (provider.selectionClassSummary ?? []).flatMap((row) => [
          `${row.selectionClass}:attempted=${row.attempted}`,
          `${row.selectionClass}:qualified=${row.qualified}`,
          ...row.gapSummary.map((gap) => `${row.selectionClass}:${gap}`),
        ]),
      },
    }));
  }
}

function resolveDueFollowUps(input: {
  states: readonly EditorialDraftStateV2[];
  evidence: readonly EvidenceCardV2[];
  store: EditorialEventStoreV2;
  now: string;
  metricLogPath: string;
  runId: string;
  actionId: string;
  mode: ActionMode;
}): { dueRevisits: DueRevisitV2[]; revisitEvidence: EvidenceCardV2[]; retryableCount: number } {
  const nowMs = Date.parse(input.now);
  const due: DueRevisitV2[] = [];
  const revisitEvidence: EvidenceCardV2[] = [];
  let retryableCount = 0;
  for (const state of input.states) {
    if (!state.publication || !["bite", "withhold"].includes(state.draft.format)) continue;
    const fact = firstFact(state);
    if (!fact) continue;
    const followUpMetric = fact.followUp?.metric ?? fact.metric;
    const observation = matchingObservation(state, input.evidence, input.now);
    const has24 = state.followUps.some((row) => row.checkpoint === "24h");
    const has72 = state.followUps.some((row) => row.checkpoint === "72h");
    const followUpSchedule = state.publication.followUpSchedule;
    const effectiveFalsifier = state.publication.falsifier;
    const due72 = Date.parse(followUpSchedule.due72h);
    const due24 = Date.parse(followUpSchedule.due24h);

    for (const recorded of state.followUps) {
      if (
        resolutionHasPublicValue(fact, recorded) &&
        !hasQueuedRevisit(input.states, state.draft.id, recorded.checkpoint)
      ) {
        if (!observation || !recorded.observation) {
          retryableCount += 1;
          continue;
        }
        const recordedEvidence = checkpointEvidence(recorded.observation, observation, input.now);
        due.push({
          draftId: state.draft.id,
          subject: state.draft.subject,
          subjectKey: fact.subjectKey,
          provider: fact.source.provider,
          metricName: followUpMetric.name,
          unit: followUpMetric.unit,
          period: followUpMetric.period,
          baselineValue: followUpMetric.value,
          dueAt: recorded.checkpoint === "24h" ? followUpSchedule.due24h : followUpSchedule.due72h,
          checkpoint: recorded.checkpoint,
          resolution: recorded.resolution === "candidate"
            ? recorded.falsifierMatched === true ? "invalidated" : "unresolved"
            : recorded.resolution,
          previousVerdict: state.draft.verdict,
        });
        revisitEvidence.push(recordedEvidence);
      }
    }

    if (!has24 && nowMs >= due72) {
      input.store.recordFollowUpResolution(state.draft.id, {
        checkpoint: "24h",
        resolution: "silent",
        reason: "checkpoint-window-missed",
        metric: followUpMetric.name,
        baselineValue: followUpMetric.value,
      });
      appendEditorialMetricV2(input.metricLogPath, buildEditorialMetricV2(
        { runId: input.runId, actionId: input.actionId, mode: input.mode, now: new Date(input.now) },
        {
          type: "followup_resolution",
          stage: "24h",
          outcome: "silent",
          reason: "checkpoint-window-missed",
          details: followUpMetricDetails({
            draftId: state.draft.id,
            dueAt: followUpSchedule.due24h,
            now: input.now,
          }),
        }
      ));
    }

    if (!has72 && nowMs >= due72) {
      const decision = resolve72HourFollowUpV2({
        now: input.now,
        schedule: followUpSchedule,
        falsifier: effectiveFalsifier,
        observation: observation
          ? { metric: observation.metric.name, value: observation.metric.value, observedAt: observation.source.observedAt }
          : undefined,
      });
      if (decision.resolution === "pending" && decision.reason !== "not-due") {
        retryableCount += 1;
        appendEditorialMetricV2(input.metricLogPath, buildEditorialMetricV2(
          { runId: input.runId, actionId: input.actionId, mode: input.mode, now: new Date(input.now) },
          {
            type: "followup_resolution",
            stage: "72h",
            outcome: "retryable",
            reason: decision.reason,
            details: followUpMetricDetails({
              draftId: state.draft.id,
              dueAt: followUpSchedule.due72h,
              now: input.now,
              observedAt: observation?.source.observedAt,
            }),
          }
        ));
      }
      if (decision.resolution !== "pending") {
        input.store.recordFollowUpResolution(state.draft.id, {
          checkpoint: "72h",
          resolution: decision.resolution,
          reason: decision.reason,
          observedAt: "observedAt" in decision ? decision.observedAt : undefined,
          metric: followUpMetric.name,
          baselineValue: followUpMetric.value,
          observedValue: "observedValue" in decision ? decision.observedValue : undefined,
          falsifierMatched: "falsifierMatched" in decision ? decision.falsifierMatched : undefined,
          observation: "observedValue" in decision && observation
            ? factSnapshot(observation)
            : undefined,
        });
        appendEditorialMetricV2(input.metricLogPath, buildEditorialMetricV2(
          { runId: input.runId, actionId: input.actionId, mode: input.mode, now: new Date(input.now) },
          {
            type: "followup_resolution",
            stage: "72h",
            outcome: decision.resolution,
            reason: decision.reason,
            details: followUpMetricDetails({
              draftId: state.draft.id,
              dueAt: followUpSchedule.due72h,
              now: input.now,
              observedAt: "observedAt" in decision ? decision.observedAt : undefined,
            }),
          }
        ));
        const publiclyValuable = observation && (
          decision.resolution === "invalidated" ||
          hasMeaningfulFollowUpChange(fact, observation.metric.value)
        );
        if (publiclyValuable && observation) {
          due.push({ draftId: state.draft.id, subject: state.draft.subject, subjectKey: fact.subjectKey, provider: fact.source.provider, metricName: followUpMetric.name, unit: followUpMetric.unit, period: followUpMetric.period, baselineValue: followUpMetric.value, dueAt: followUpSchedule.due72h, checkpoint: "72h", resolution: decision.resolution, previousVerdict: state.draft.verdict });
          revisitEvidence.push(observation);
        }
      }
      continue;
    }

    if (!has24 && nowMs >= due24 && nowMs < due72) {
      const decision = resolve24HourFollowUpV2({
        now: input.now,
        schedule: followUpSchedule,
        falsifier: effectiveFalsifier,
        baselineValue: followUpMetric.value,
        observation: observation
          ? { metric: observation.metric.name, value: observation.metric.value, observedAt: observation.source.observedAt }
          : undefined,
        changeThreshold: meaningfulChangeThreshold(fact),
      });
      if (decision.resolution !== "pending") {
        const retryableObservationFailure =
          decision.resolution === "silent" &&
          ["missing-observation", "metric-mismatch", "observation-before-checkpoint"].includes(decision.reason);
        if (retryableObservationFailure) {
          retryableCount += 1;
          appendEditorialMetricV2(input.metricLogPath, buildEditorialMetricV2(
            { runId: input.runId, actionId: input.actionId, mode: input.mode, now: new Date(input.now) },
            {
              type: "followup_resolution",
              stage: "24h",
              outcome: "retryable",
              reason: decision.reason,
              details: followUpMetricDetails({
                draftId: state.draft.id,
                dueAt: followUpSchedule.due24h,
                now: input.now,
                observedAt: observation?.source.observedAt,
              }),
            }
          ));
          continue;
        }
        input.store.recordFollowUpResolution(state.draft.id, {
          checkpoint: "24h",
          resolution: decision.resolution,
          reason: decision.reason,
          observedAt: "observedAt" in decision ? decision.observedAt : undefined,
          metric: followUpMetric.name,
          baselineValue: followUpMetric.value,
          observedValue: "observedValue" in decision ? decision.observedValue : undefined,
          falsifierMatched: "falsifierMatched" in decision ? decision.falsifierMatched : undefined,
          observation: decision.resolution === "candidate" && observation
            ? factSnapshot(observation)
            : undefined,
        });
        appendEditorialMetricV2(input.metricLogPath, buildEditorialMetricV2(
          { runId: input.runId, actionId: input.actionId, mode: input.mode, now: new Date(input.now) },
          {
            type: "followup_resolution",
            stage: "24h",
            outcome: decision.resolution,
            reason: decision.reason,
            details: followUpMetricDetails({
              draftId: state.draft.id,
              dueAt: followUpSchedule.due24h,
              now: input.now,
              observedAt: "observedAt" in decision ? decision.observedAt : undefined,
            }),
          }
        ));
        if (decision.resolution === "candidate" && observation) {
          due.push({ draftId: state.draft.id, subject: state.draft.subject, subjectKey: fact.subjectKey, provider: fact.source.provider, metricName: followUpMetric.name, unit: followUpMetric.unit, period: followUpMetric.period, baselineValue: followUpMetric.value, dueAt: followUpSchedule.due24h, checkpoint: "24h", resolution: decision.provisionalVerdict, previousVerdict: state.draft.verdict });
          revisitEvidence.push(observation);
        }
      }
    }
  }
  return { dueRevisits: due, revisitEvidence, retryableCount };
}

/** Provider-only checkpoint worker. It records observations without requiring an LLM or X. */
export async function checkEditorialFollowUpsV2(
  input: CheckEditorialFollowUpsInputV2
): Promise<CheckEditorialFollowUpsResultV2> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const runId = input.runId || `run_${randomUUID()}`;
  const actionId = input.actionId || `followup_${randomUUID()}`;
  const states = input.store.listDraftStates();
  const targets = dueFollowUpTargets(states, nowIso);
  if (targets.length === 0) {
    return { status: "checked", targetCount: 0, resolutionCount: 0, publicCandidateCount: 0, retryableCount: 0, runId, actionId };
  }
  const sensing = input.sensing ?? await (input.sense
    ? input.sense(targets)
    : collectEditorialEvidenceV2({
        now: nowIso,
        followUpTargets: targets,
        includeGenericCandidates: false,
      }));
  appendProviderMetrics(sensing, { runId, actionId, mode: input.mode, now }, input.metricLogPath);
  const beforeCount = states.reduce((sum, state) => sum + state.followUps.length, 0);
  const followUps = resolveDueFollowUps({
    states,
    evidence: [...sensing.evidence, ...sensing.observations],
    store: input.store,
    now: nowIso,
    metricLogPath: input.metricLogPath,
    runId,
    actionId,
    mode: input.mode,
  });
  const afterCount = input.store.listDraftStates().reduce((sum, state) => sum + state.followUps.length, 0);
  return {
    status: "checked",
    targetCount: targets.length,
    resolutionCount: afterCount - beforeCount,
    publicCandidateCount: followUps.dueRevisits.length,
    retryableCount: followUps.retryableCount,
    runId,
    actionId,
  };
}

export async function collectEditorialDraftV2(
  input: CollectEditorialDraftInputV2
): Promise<EditorialCollectResultV2> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const runId = input.runId || `run_${randomUUID()}`;
  const actionId = input.actionId || `action_${randomUUID()}`;
  const metricContext = { runId, actionId, mode: input.mode, now };
  const statesBefore = input.store.listDraftStates();
  const followUpTargets = dueFollowUpTargets(statesBefore, nowIso);
  const sensing = input.sensing ?? await (input.sense
    ? input.sense(followUpTargets)
    : collectEditorialEvidenceV2({
        now: nowIso,
        followUpTargets,
        // The action id is durably logged, so production runs broaden coverage
        // without sacrificing replayability. Tests can pin selectionSeed.
        selectionSeed: input.selectionSeed || actionId,
      }));

  appendProviderMetrics(sensing, metricContext, input.metricLogPath);

  const followUps = resolveDueFollowUps({
    states: statesBefore,
    evidence: [...sensing.evidence, ...sensing.observations],
    store: input.store,
    now: nowIso,
    metricLogPath: input.metricLogPath,
    runId,
    actionId,
    mode: input.mode,
  });
  if (followUps.dueRevisits.length === 0 && followUps.retryableCount > 0) {
    appendEditorialMetricV2(input.metricLogPath, buildEditorialMetricV2(metricContext, {
      type: "planning_decision",
      stage: "followup",
      outcome: "deferred",
      reason: "followup-observation-unavailable",
      details: { retryableCount: followUps.retryableCount },
    }));
  }
  const planning = planEditorialV2({
    evidence: sensing.evidence,
    followUpEvidence: followUps.revisitEvidence,
    history: historyFromStore(statesBefore),
    dueRevisits: followUps.dueRevisits,
    now: nowIso,
    selectionSeed: input.selectionSeed || actionId,
  });
  if (planning.status === "blocked") {
    appendEditorialMetricV2(input.metricLogPath, buildEditorialMetricV2(metricContext, {
      type: "planning_decision",
      stage: planning.stage,
      outcome: "no-post",
      reason: planning.reason,
      details: { candidateCount: planning.candidateCount, blockReasons: [...planning.blockReasons] },
    }));
    return { status: "no-post", stage: planning.stage, reason: planning.reason, runId, actionId };
  }

  const recentPublishedFormats = statesBefore
    .filter((state) => state.publication)
    .sort((left, right) => Date.parse(left.publication!.publishedAt) - Date.parse(right.publication!.publishedAt))
    .slice(-19)
    .map((state) => state.draft.format);
  appendEditorialMetricV2(input.metricLogPath, buildEditorialMetricV2(metricContext, {
    type: "planning_decision",
    stage: "selection",
    outcome: "planned",
    details: {
      format: planning.plan.format,
      subject: planning.plan.subject,
      factIds: [...planning.plan.factIds],
      provider: planning.evidence.source.provider,
      dueRevisit: planning.plan.format === "revisit",
      rollingBite: recentPublishedFormats.filter((format) => format === "bite").length + (planning.plan.format === "bite" ? 1 : 0),
      rollingWithhold: recentPublishedFormats.filter((format) => format === "withhold").length + (planning.plan.format === "withhold" ? 1 : 0),
      rollingRevisit: recentPublishedFormats.filter((format) => format === "revisit").length + (planning.plan.format === "revisit" ? 1 : 0),
      rollingEvolution: recentPublishedFormats.filter((format) => format === "evolution").length + (planning.plan.format === "evolution" ? 1 : 0),
      absoluteMoveUsd: planning.evidence.selection?.absoluteMoveUsd ?? null,
      benchmarkChangePercent: planning.evidence.selection?.benchmarkChangePercent ?? null,
      residualPercentagePoints: planning.evidence.selection?.residualPercentagePoints ?? null,
      quantityChangePercent: planning.evidence.selection?.priceNeutral?.quantityChangePercent ?? null,
      priceChangePercent: planning.evidence.selection?.priceNeutral?.priceChangePercent ?? null,
      quantityMoveUsd: planning.evidence.selection?.priceNeutral?.quantityMoveUsd ?? null,
      quantityShare: planning.evidence.selection?.priceNeutral?.quantityShare ?? null,
    },
  }));
  const written = await writeEditorialDraftV2({ model: input.writerModel, plan: planning.plan, evidence: planning.evidence });
  if (written.status === "blocked") {
    appendEditorialMetricV2(input.metricLogPath, buildEditorialMetricV2(metricContext, {
      type: "generation_attempt",
      stage: written.stage,
      outcome: "no-post",
      reason: written.reason,
      details: { attempts: written.attempts, validationReasons: [...written.validationReasons], fallbackUsed: false },
    }));
    return { status: "no-post", stage: written.stage, reason: written.reason, runId, actionId };
  }

  let draft: ReturnType<EditorialEventStoreV2["createDraft"]>;
  try {
    draft = input.store.createDraft({
      id: actionId,
      runId,
      createdAt: nowIso,
      lane: planning.plan.lane,
      collectionEpoch: EDITORIAL_COLLECTION_EPOCH_V2,
      format: planning.plan.format,
      subject: planning.plan.subject,
      thesis: planning.plan.thesis,
      factIds: planning.plan.factIds,
      facts: [factSnapshot(planning.evidence)],
      verdict: planning.plan.verdict,
      falsifier: planning.plan.falsifier,
      followUpSchedule: planning.plan.followUpAt,
      continuityThread: planning.plan.continuityThread,
      voiceState: planning.plan.voiceState,
      draft: written.payload.draft,
      generatedPayload: {
        draft: written.payload.draft,
        usedFactIds: [...written.payload.usedFactIds],
        claims: written.payload.claims.map((claim) => ({
          kind: claim.kind,
          text: claim.text,
          factIds: [...claim.factIds],
        })),
      },
    });
  } catch (error) {
    if (!(error instanceof EditorialContinuityThreadConflictV2)) throw error;
    appendEditorialMetricV2(input.metricLogPath, buildEditorialMetricV2(metricContext, {
      type: "generation_attempt",
      stage: "followup-idempotency",
      outcome: "no-post",
      reason: "followup-revisit-already-queued",
      details: {
        attempts: written.attempts,
        fallbackUsed: false,
        existingDraftId: error.existingDraftId,
        continuityThread: error.continuityThread,
      },
    }));
    return {
      status: "no-post",
      stage: "followup",
      reason: "followup-revisit-already-queued",
      runId,
      actionId,
    };
  }
  appendEditorialMetricV2(input.metricLogPath, buildEditorialMetricV2(metricContext, {
    type: "generation_attempt",
    stage: "contract",
    outcome: "drafted",
    details: { attempts: written.attempts, draftId: draft.id, fallbackUsed: false },
  }));
  return { status: "drafted", draftId: draft.id, draft: draft.draft, runId, actionId };
}
