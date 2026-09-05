import type { ActionMode } from "../../types/runtime.js";
import { EditorialEventStoreV2, type EditorialDraftStateV2 } from "./event-store.js";
import { appendEditorialMetricV2, buildEditorialMetricV2 } from "./telemetry.js";
import {
  formatEvidenceSourceTimeV2,
  inferMetricDirectionV2,
  validateEditorialDraftV2,
} from "./validator.js";

export function formatEditorialReviewCardV2(state: EditorialDraftStateV2): string {
  const facts = state.draft.facts.map((fact, index) => [
    `  fact ${index + 1}: ${fact.subject} · ${fact.metric.name} · ${fact.metric.raw} (${fact.metric.period})`,
    `  source: ${fact.source.provider} · ${fact.source.observedAt}`,
    `  url: ${fact.source.url}`,
    ...(fact.selection
      ? [
          `  selection: raw abs $${Math.round(fact.selection.absoluteMoveUsd).toLocaleString("en-US")} · benchmark ${fact.selection.benchmarkChangePercent.toFixed(2)}% · residual ${fact.selection.residualPercentagePoints >= 0 ? "+" : ""}${fact.selection.residualPercentagePoints.toFixed(2)}pp`,
          ...(fact.selection.priceNeutral
            ? [`  price-neutral screen: quantity ${fact.selection.priceNeutral.quantityChangePercent >= 0 ? "+" : ""}${fact.selection.priceNeutral.quantityChangePercent.toFixed(2)}% · $${Math.round(Math.abs(fact.selection.priceNeutral.quantityMoveUsd)).toLocaleString("en-US")} · share ${(fact.selection.priceNeutral.quantityShare * 100).toFixed(1)}% · coverage ${(Math.min(fact.selection.priceNeutral.coverageAtT0, fact.selection.priceNeutral.coverageAtT1) * 100).toFixed(1)}%`]
            : []),
        ]
      : []),
  ].join("\n")).join("\n");
  return [
    `[${state.draft.id}] ${state.reviewStatus.toUpperCase()} · ${state.draft.format} · ${state.draft.voiceState}`,
    `planner: ${state.draft.thesis}`,
    `verdict: ${state.draft.verdict}`,
    `tracking: ${state.draft.trackingMode ?? "live"}`,
    `question: ${state.draft.editorialCase?.question ?? "legacy — no question contract"}`,
    `hypothesis: ${state.draft.editorialCase?.hypothesis ?? "none — observation only"}`,
    `limit: ${state.draft.editorialCase?.limitation ?? "legacy"}`,
    `previous: ${state.draft.memoryContext?.previous ? JSON.stringify(state.draft.memoryContext.previous) : "none"}`,
    `writer lineage: ${state.draft.generatedPayload ? "captured" : "missing (legacy; publish blocked)"}`,
    `falsifier: ${state.draft.falsifier.metric} ${state.draft.falsifier.comparator} ${state.draft.falsifier.threshold} ${state.draft.falsifier.unit || ""} @ ${state.draft.falsifier.deadline}`,
    facts,
    "",
    state.publishText,
  ].join("\n");
}

export function recordEditorialReviewV2(input: {
  store: EditorialEventStoreV2;
  draftId: string;
  action: "approve" | "edit" | "reject";
  reviewerId: string;
  reasonTags?: readonly string[];
  editedDraft?: string;
  metricLogPath: string;
  mode: ActionMode;
  now?: Date;
}): void {
  const state = input.store.getDraftState(input.draftId);
  if (!state) throw new Error(`unknown editorial draft: ${input.draftId}`);
  if (input.action === "edit") {
    const fact = state.draft.facts[0];
    if (!fact) throw new Error("editorial draft has no evidence fact");
    const validation = validateEditorialDraftV2({
      text: input.editedDraft || "",
      subject: state.draft.subject,
      displayValue: fact.metric.raw,
      factIds: state.draft.factIds,
      usedFactIds: state.draft.factIds,
      allowedNumericValues: [fact.metric.period, "24시간", "72시간"],
      allowedNamedTokens: [
        ...fact.metric.name.split(/[^a-zA-Z0-9]+/).filter(Boolean).map((token) => token.toUpperCase()),
        fact.metric.unit,
      ],
      sourceTimeToken: formatEvidenceSourceTimeV2(fact.source.observedAt),
      requireJudgment: true,
      metricName: fact.metric.name,
      metricDirection: inferMetricDirectionV2(
        fact.metric.name,
        fact.metric.raw,
        fact.metric.value
      ),
      forbidPublicFollowUp: false,
      forbidFutureRecheck: true,
    });
    if (!validation.ok) throw new Error(`edited draft failed contract: ${validation.reasons.join(",")}`);
    input.store.edit(input.draftId, {
      reviewerId: input.reviewerId,
      reasonTags: input.reasonTags,
      editedDraft: input.editedDraft as string,
    });
  } else if (input.action === "approve") {
    input.store.approve(input.draftId, { reviewerId: input.reviewerId, reasonTags: input.reasonTags });
  } else {
    input.store.reject(input.draftId, { reviewerId: input.reviewerId, reasonTags: input.reasonTags });
  }
  appendEditorialMetricV2(input.metricLogPath, buildEditorialMetricV2(
    {
      runId: state.draft.runId,
      actionId: state.draft.id,
      mode: input.mode,
      now: input.now,
    },
    {
      type: "review_decision",
      stage: "human-review",
      outcome: input.action,
      details: { draftId: input.draftId, reviewerId: input.reviewerId, reasonTags: [...(input.reasonTags || [])] },
    }
  ));
}
