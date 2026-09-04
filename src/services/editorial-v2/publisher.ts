import type { ActionMode } from "../../types/runtime.js";
import { EditorialEventStoreV2 } from "./event-store.js";
import type { EditorialFactSnapshotV2 } from "./contracts.js";
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

function calendarDate(value: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

function exactDuplicate(store: EditorialEventStoreV2, draftId: string, text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  return store.listDraftStates().some(
    (state) =>
      state.draft.id !== draftId &&
      (state.publication?.publishedText.replace(/\s+/g, " ").trim() === normalized ||
        state.dispatchIntent?.publishText.replace(/\s+/g, " ").trim() === normalized)
  );
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

  let preparation: ReturnType<EditorialEventStoreV2["preparePublication"]>;
  try {
    preparation = input.store.preparePublication(input.draftId);
  } catch (error) {
    return blocked(error instanceof Error ? error.message : "publication-not-ready");
  }
  if (preparation.status === "already-published") {
    return { status: "already-published", externalPostId: preparation.publication.externalPostId };
  }
  if (exactDuplicate(input.store, input.draftId, preparation.publishText)) return blocked("duplicate-published-text");

  const fact = preparation.facts[0];
  if (!fact) return blocked("evidence-fact-missing");
  const validation = validateEditorialDraftV2({
    text: preparation.publishText,
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
    falsifierComparator: state.draft.falsifier.comparator,
    requireCanonicalFalsifier: state.draft.format !== "revisit",
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

  const today = calendarDate(now.toISOString(), input.timezone);
  const requestedDailyLimit = input.dailyLimit ?? 1;
  const dailyLimit = Number.isFinite(requestedDailyLimit)
    ? Math.max(1, Math.min(2, Math.trunc(requestedDailyLimit)))
    : 1;
  const dispatchedToday = input.store.listDraftStates().filter((row) => {
    const dispatchedAt = row.publication?.publishedAt || row.dispatchIntent?.recordedAt;
    return dispatchedAt && calendarDate(dispatchedAt, input.timezone) === today;
  }).length;
  if (dispatchedToday >= dailyLimit) return blocked("editorial-daily-limit");

  let attempted = false;
  const beforeSend = () => {
    input.store.markDispatching(input.draftId, {
      preparedAt: preparation.freshnessCheckedAt,
      expectedPublishText: preparation.publishText,
    });
    attempted = true;
  };
  let externalPostId: string | null;
  try {
    externalPostId = await input.dispatch(preparation.publishText, beforeSend);
  } catch (error) {
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
