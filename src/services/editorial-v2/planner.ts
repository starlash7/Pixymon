import { createFollowUpScheduleV2, createMachineFalsifierV2 } from "./follow-ups.js";
import {
  assessTierAEligibilityV2,
  type EvidenceCardV2,
  type EvidenceLaneV2,
} from "./evidence.js";
import type {
  EditorialFormatV2,
  EditorialVoiceStateV2,
  FollowUpScheduleV2,
  MachineFalsifierV2,
  EditorialCaseV2,
  EditorialMemoryContextV2,
} from "./contracts.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export type EditorialVerdictV2 = "approve" | "digesting" | "reject" | "corrected";

export interface EditorialPlanV2 {
  schemaVersion: 2;
  format: EditorialFormatV2;
  lane: EvidenceLaneV2;
  subject: string;
  thesis: string;
  factIds: readonly string[];
  verdict: EditorialVerdictV2;
  falsifier: MachineFalsifierV2;
  followUpAt: FollowUpScheduleV2;
  continuityThread?: string;
  voiceState: EditorialVoiceStateV2;
  blockReasons: readonly string[];
  editorialCase?: EditorialCaseV2;
  memoryContext?: EditorialMemoryContextV2;
}

export interface EditorialHistoryEntryV2 {
  subject: string;
  subjectKey?: string;
  provider?: string;
  metricName: string;
  metricValue: number;
  factId: string;
  publishedAt: string;
}

export interface DueRevisitV2 {
  draftId: string;
  subject: string;
  subjectKey?: string;
  provider?: string;
  metricName: string;
  unit?: string;
  period?: string;
  baselineValue: number;
  dueAt: string;
  checkpoint: "24h" | "72h";
  resolution?: "supported" | "invalidated" | "unresolved";
  previousVerdict?: string;
  editorialCase?: EditorialCaseV2;
}

export type EditorialPlanningResultV2 =
  | {
      status: "planned";
      plan: EditorialPlanV2;
      evidence: EvidenceCardV2;
    }
  | {
      status: "blocked";
      stage: "eligibility" | "followup" | "novelty";
      reason: "no-tier-a-evidence" | "followup-no-change" | "subject-repeat-without-delta";
      blockReasons: readonly string[];
      candidateCount: number;
    };

export interface PlanEditorialInputV2 {
  evidence: readonly EvidenceCardV2[];
  /** Tracked measurements may satisfy a due revisit but can never become a new generic post. */
  followUpEvidence?: readonly EvidenceCardV2[];
  history?: readonly EditorialHistoryEntryV2[];
  dueRevisits?: readonly DueRevisitV2[];
  now: string;
  selectionSeed?: string;
}

function parseInstant(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`invalid editorial instant: ${value}`);
  return parsed;
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function recentSubjectRows(
  card: EvidenceCardV2,
  history: readonly EditorialHistoryEntryV2[],
  nowMs: number
): EditorialHistoryEntryV2[] {
  return history.filter(
    (row) => {
      const sameStableSubject = Boolean(
        card.subjectKey &&
        row.subjectKey &&
        card.subjectKey === row.subjectKey &&
        (!row.provider || row.provider === card.source.provider)
      );
      return (sameStableSubject || row.subject === card.subject) &&
        nowMs - parseInstant(row.publishedAt) < DAY_MS;
    }
  );
}

function hasNumericDelta(card: EvidenceCardV2, rows: readonly EditorialHistoryEntryV2[]): boolean {
  if (rows.length === 0) return true;
  return rows.every(
    (row) => {
      if (row.factId === card.id) return false;
      if (row.metricName !== card.metric.name) return true;
      const delta = Math.abs(row.metricValue - card.metric.value);
      if (card.metric.unit === "%") return delta >= 0.5;
      if (row.metricValue === 0) return delta > 0;
      return delta / Math.abs(row.metricValue) >= 0.02;
    }
  );
}

function absoluteEventSize(card: EvidenceCardV2): number | null {
  if (card.selection?.kind === "tvl-outlier") {
    return Math.abs(
      card.selection.priceNeutral?.quantityMoveUsd ?? card.selection.absoluteMoveUsd
    );
  }
  if (!card.followUp || card.followUp.metric.unit !== "USD") return null;
  const size = Math.abs(card.followUp.metric.value - card.followUp.threshold);
  return Number.isFinite(size) ? size : null;
}

export function editorialCaseForV2(card: EvidenceCardV2): EditorialCaseV2 {
  const followUp = card.followUp;
  const hasLevelTest = card.metric.name === "tvl-change-24h" && card.metric.unit === "%" &&
    followUp?.metric.name === "tvl-usd" && followUp.metric.unit === "USD" &&
    followUp.metric.value > 0 && followUp.threshold > 0 &&
    ((card.metric.value > 0 && ["lt", "lte"].includes(followUp.comparator) && followUp.threshold < followUp.metric.value) ||
      (card.metric.value < 0 && ["gt", "gte"].includes(followUp.comparator) && followUp.threshold > followUp.metric.value));
  return {
    question: hasLevelTest
      ? `${card.subject}의 USD TVL 변화는 변동 전 수준으로 완전히 되돌려지는가?`
      : `${card.subject}의 ${card.metric.name} 관측으로 어디까지 판단할 수 있는가?`,
    hypothesis: hasLevelTest
      ? `72시간 시점의 USD TVL이 ${followUp.threshold} USD ${{ lt: "이상", lte: "초과", gt: "이하", gte: "미만", eq: "이외" }[followUp.comparator]}에 남는다는 가설을 검증한다.`
      : null,
    scope: hasLevelTest ? "usd-tvl-level" : "observation-only",
    factIds: [card.id],
    limitation: hasLevelTest
      ? "USD 표시 TVL 수준만 검증한다. 가격 중립 잔류, 순유입, 사용자, 원인이나 프로토콜의 좋고 나쁨을 입증하지 않는다."
      : "비교 가능한 기준점이 없어 지속성은 판정하지 않는다. 반증 조건은 재관측 알림이며 가설 지지로 계산하지 않는다.",
  };
}

function falsifierFor(card: EvidenceCardV2, schedule: FollowUpScheduleV2): MachineFalsifierV2 {
  if (card.followUp) {
    return createMachineFalsifierV2(
      {
        metric: card.followUp.metric.name,
        comparator: card.followUp.comparator,
        threshold: card.followUp.threshold,
        unit: card.followUp.metric.unit,
      },
      schedule
    );
  }
  const value = card.metric.value;
  return createMachineFalsifierV2(
    {
      metric: card.metric.name,
      comparator: value > 0 ? "lt" : value < 0 ? "gt" : "eq",
      threshold: value,
      unit: card.metric.unit,
    },
    schedule
  );
}

function buildPlan(
  card: EvidenceCardV2,
  now: string,
  revisit?: DueRevisitV2
): EditorialPlanV2 {
  const schedule = createFollowUpScheduleV2(now);
  const editorialCase = revisit?.editorialCase ?? editorialCaseForV2(card);
  const format: EditorialFormatV2 = revisit ? "revisit" : editorialCase.hypothesis ? "bite" : "withhold";
  const verdict: EditorialVerdictV2 = revisit
    ? revisit.resolution === "invalidated"
      ? "corrected"
      : revisit.resolution === "supported"
        ? "approve"
        : "digesting"
    : "digesting";
  const thesis = revisit
    ? `${card.subject}의 현재 ${card.metric.name}은 ${card.metric.raw}다. ${revisit.checkpoint} 측정 결과는 ${revisit.resolution || "unresolved"}다. 기존 질문: ${editorialCase.question} ${editorialCase.limitation}`
    : format === "withhold"
      ? `${card.subject}의 ${card.metric.name} ${card.metric.raw}를 기록하되, 이 한 번의 수치만으로 더 큰 서사는 승인하지 않는다.`
      : `${card.subject}의 ${card.metric.name} ${card.metric.raw}는 검증할 변화다. USD TVL 수준의 지속성은 아직 미결이며 원인이나 사용자 잔류로 확대하지 않는다.`;
  return {
    schemaVersion: 2,
    format,
    lane: card.lane,
    subject: card.subject,
    thesis,
    factIds: [card.id],
    verdict,
    falsifier: falsifierFor(card, schedule),
    followUpAt: schedule,
    continuityThread: revisit ? `${revisit.draftId}:${revisit.checkpoint}` : undefined,
    voiceState: revisit
      ? revisit.resolution === "invalidated" ? "humbled" : revisit.resolution === "supported" ? "curious" : "patient"
      : editorialCase.hypothesis ? "curious" : "patient",
    blockReasons: [],
    editorialCase,
  };
}

/**
 * V2 intentionally uses lexicographic hard gates. No score or fallback can
 * resurrect an ineligible/stale card.
 */
export function planEditorialV2(input: PlanEditorialInputV2): EditorialPlanningResultV2 {
  const nowMs = parseInstant(input.now);
  const history = input.history ?? [];
  const due = (input.dueRevisits ?? [])
    .filter((row) => parseInstant(row.dueAt) <= nowMs)
    .sort((left, right) => parseInstant(left.dueAt) - parseInstant(right.dueAt));
  const assessed = input.evidence.map((card) => ({
    card,
    eligibility: assessTierAEligibilityV2(card, input.now),
  }));
  const eligible = assessed.filter((row) => row.eligibility.eligible).map((row) => row.card);
  const followUpEligible = (input.followUpEvidence ?? [])
    .filter((card) => assessTierAEligibilityV2(card, input.now).eligible);

  for (const revisit of due) {
    const matching = followUpEligible.find(
      (card) =>
        (revisit.provider ? card.source.provider === revisit.provider : true) &&
        (revisit.subjectKey ? card.subjectKey === revisit.subjectKey : card.subject === revisit.subject) &&
        card.metric.name === revisit.metricName &&
        (revisit.unit ? card.metric.unit === revisit.unit : true) &&
        (revisit.period ? card.metric.period === revisit.period : true) &&
        (Boolean(revisit.resolution) || revisit.checkpoint === "72h" || card.metric.value !== revisit.baselineValue)
    );
    if (matching) return { status: "planned", plan: buildPlan(matching, input.now, revisit), evidence: matching };
  }

  if (eligible.length === 0) {
    return {
      status: "blocked",
      stage: "eligibility",
      reason: "no-tier-a-evidence",
      blockReasons: [...new Set(assessed.flatMap((row) => row.eligibility.reasons))].sort(),
      candidateCount: input.evidence.length,
    };
  }

  const unchangedDueKeys = new Set(
    due
      .filter((row) => row.checkpoint === "24h")
      .map((row) => `${row.subject}\u0000${row.metricName}\u0000${row.baselineValue}`)
  );
  const notSilentFollowUps = eligible.filter(
    (card) => !unchangedDueKeys.has(`${card.subject}\u0000${card.metric.name}\u0000${card.metric.value}`)
  );
  if (notSilentFollowUps.length === 0 && unchangedDueKeys.size > 0) {
    return {
      status: "blocked",
      stage: "followup",
      reason: "followup-no-change",
      blockReasons: ["24h-no-meaningful-change"],
      candidateCount: eligible.length,
    };
  }

  const novel = notSilentFollowUps.filter((card) =>
    hasNumericDelta(card, recentSubjectRows(card, history, nowMs))
  );
  if (novel.length === 0) {
    return {
      status: "blocked",
      stage: "novelty",
      reason: "subject-repeat-without-delta",
      blockReasons: ["same-subject-within-24h", "numeric-delta-missing"],
      candidateCount: eligible.length,
    };
  }

  const seed = input.selectionSeed ?? input.now;
  const selected = [...novel].sort((left, right) => {
    const leftAge = assessTierAEligibilityV2(left, input.now).freshness.ageMs ?? Number.MAX_SAFE_INTEGER;
    const rightAge = assessTierAEligibilityV2(right, input.now).freshness.ageMs ?? Number.MAX_SAFE_INTEGER;
    if (leftAge !== rightAge) return leftAge - rightAge;
    const leftSize = absoluteEventSize(left);
    const rightSize = absoluteEventSize(right);
    if (leftSize !== null && rightSize !== null && leftSize !== rightSize) return rightSize - leftSize;
    if (left.metric.name === right.metric.name && left.metric.unit === right.metric.unit) {
      const magnitude = Math.abs(right.metric.value) - Math.abs(left.metric.value);
      if (magnitude !== 0) return magnitude;
    }
    return stableHash(`${seed}:${left.id}`) - stableHash(`${seed}:${right.id}`);
  })[0];

  return { status: "planned", plan: buildPlan(selected, input.now), evidence: selected };
}
