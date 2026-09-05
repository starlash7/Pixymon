import type { ActionMode } from "../../types/runtime.js";
import {
  EditorialDispatchReservationConflictV2,
  EditorialEventStoreV2,
} from "./event-store.js";
import type { EditorialFactSnapshotV2 } from "./contracts.js";
import { EDITORIAL_COLLECTION_EPOCH_V2 } from "./contracts.js";
import { appendEditorialMetricV2, buildEditorialMetricV2 } from "./telemetry.js";
import {
  formatEvidenceSourceTimeV2,
  inferMetricDirectionV2,
  validateEditorialDraftV2,
} from "./validator.js";

export type EditorialPublishResultV2 =
  | { status: "published"; externalPostId: string }
  | { status: "already-published"; externalPostId: string }
  | { status: "blocked"; reason: string };

export interface EditorialEvidenceRevalidationV2 {
  ok: boolean;
  reason?: string;
}

export async function publishEditorialDraftV2(input: {
  store: EditorialEventStoreV2;
  draftId: string;
  mode: ActionMode;
  dispatch: (text: string, beforeSend: () => void) => Promise<string | null>;
  revalidateEvidence: (
    facts: readonly EditorialFactSnapshotV2[]
  ) => Promise<EditorialEvidenceRevalidationV2>;
  metricLogPath: string;
  timezone: string;
  dailyLimit?: number;
  now?: Date;
  /** Rechecked immediately before dispatch; missing authority always blocks. */
  authorize?: () => void;
}): Promise<EditorialPublishResultV2> {
  const now = input.now ?? new Date();
  const state = input.store.getDraftState(input.draftId);
  const runId = state?.draft.runId || "unknown";
  const metricContext = { runId, actionId: state?.draft.id || input.draftId, mode: input.mode, now };
  const blocked = (reason: string, stage = "pre-dispatch"): EditorialPublishResultV2 => {
    appendEditorialMetricV2(input.metricLogPath, buildEditorialMetricV2(metricContext, {
      type: "dispatch_decision",
      stage,
      outcome: "blocked",
      reason,
      details: { draftId: input.draftId },
    }));
    return { status: "blocked", reason };
  };

  if (!state) return blocked("draft-not-found");
  if (state.publication) {
    appendEditorialMetricV2(input.metricLogPath, buildEditorialMetricV2(metricContext, {
      type: "dispatch_decision",
      stage: "idempotency",
      outcome: "already-published",
      details: { draftId: input.draftId, externalPostId: state.publication.externalPostId },
    }));
    return { status: "already-published", externalPostId: state.publication.externalPostId };
  }
  if (input.mode !== "live") return blocked("live-mode-required");
  if (!state.draft.generatedPayload) return blocked("writer-lineage-missing");
  if (state.draft.collectionEpoch !== EDITORIAL_COLLECTION_EPOCH_V2) return blocked("writer-epoch-not-current");
  if (state.draft.trackingMode === "shadow") return blocked("shadow-draft-cannot-publish");
  if (state.draft.lane !== "protocol") return blocked("protocol-only-milestone");
  try {
    if (!input.authorize) throw new Error("approved-live-authorization-required");
    input.authorize();
  } catch (error) {
    return blocked(error instanceof Error ? error.message : "publication-not-authorized", "authorization");
  }

  let preparation: ReturnType<EditorialEventStoreV2["preparePublication"]>;
  try {
    preparation = input.store.preparePublication(input.draftId);
  } catch (error) {
    return blocked(error instanceof Error ? error.message : "publication-not-ready");
  }
  if (preparation.status === "already-published") {
    return { status: "already-published", externalPostId: preparation.publication.externalPostId };
  }

  const fact = preparation.facts[0];
  if (!fact) return blocked("evidence-fact-missing");
  const validation = validateEditorialDraftV2({
    text: preparation.publishText,
    subject: state.draft.subject,
    displayValue: fact.metric.raw,
    factIds: state.draft.factIds,
    usedFactIds: state.draft.generatedPayload.usedFactIds,
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
    forbidFutureRecheck: true,
  });
  if (!validation.ok) return blocked(`publish-contract:${validation.reasons.join(",")}`);

  let evidenceHealth: EditorialEvidenceRevalidationV2;
  try {
    evidenceHealth = await input.revalidateEvidence(preparation.facts);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown";
    return blocked(`provider-health-check-failed:${reason}`);
  }
  if (!evidenceHealth.ok) {
    return blocked(`provider-not-green:${evidenceHealth.reason || "unknown"}`);
  }

  const requestedDailyLimit = input.dailyLimit ?? 1;
  const dailyLimit = Number.isFinite(requestedDailyLimit)
    ? Math.max(1, Math.min(2, Math.trunc(requestedDailyLimit)))
    : 1;

  let attempted = false;
  const beforeSend = () => {
    input.authorize!();
    input.store.markDispatching(input.draftId, {
      preparedAt: preparation.freshnessCheckedAt,
      expectedPublishText: preparation.publishText,
      timezone: input.timezone,
      dailyLimit,
    });
    attempted = true;
  };
  let externalPostId: string | null;
  try {
    externalPostId = await input.dispatch(preparation.publishText, beforeSend);
  } catch (error) {
    if (error instanceof EditorialDispatchReservationConflictV2) {
      return blocked(error.reason);
    }
    const reason = error instanceof Error ? error.message : "unknown";
    return attempted
      ? blocked(`x-dispatch-outcome-unresolved:${reason}`, "dispatch")
      : blocked(`x-dispatch-not-attempted:${reason}`);
  }
  if (!attempted) return blocked("x-dispatch-not-attempted");
  if (!externalPostId) return blocked("x-dispatch-outcome-unresolved", "dispatch");
  try {
    input.store.markPublished(input.draftId, {
      externalPostId,
      preparedAt: preparation.freshnessCheckedAt,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown";
    return blocked(`publication-commit-unresolved:${reason}`, "dispatch");
  }
  appendEditorialMetricV2(input.metricLogPath, buildEditorialMetricV2(metricContext, {
    type: "dispatch_decision",
    stage: "dispatch",
    outcome: "published",
    details: { draftId: input.draftId, externalPostId, dailyLimit },
  }));
  return { status: "published", externalPostId };
}
