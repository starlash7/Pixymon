import type { EditorialDraftStateV2 } from "./event-store.js";
import type { EditorialFactSnapshotV2 } from "./contracts.js";
import { createFollowUpScheduleV2, createMachineFalsifierV2 } from "./follow-ups.js";
import type { EditorialPlanV2, EditorialVerdictV2 } from "./planner.js";

export const EVOLUTION_MIN_RECORDS_V2 = 2;
export const EVOLUTION_MAX_RECORDS_V2 = 3;
export const EVOLUTION_COOLDOWN_MS_V2 = 24 * 60 * 60 * 1000;
export const EVOLUTION_LOOKBACK_MS_V2 = 14 * 24 * 60 * 60 * 1000;

/** One closed past judgment, copied from the ledger. Nothing here is model-generated. */
export interface EditorialReflectionRecordV2 {
  draftId: string;
  provenance: "live" | "shadow";
  subject: string;
  fact: EditorialFactSnapshotV2;
  said: string;
  question?: string;
  outcome: { resolution: "supported" | "invalidated" | "unresolved"; reason: string; resolvedAt: string };
}

export type EditorialEvolutionSelectionV2 =
  | { status: "planned"; records: EditorialReflectionRecordV2[] }
  | { status: "blocked"; reason: "evolution-cooldown" | "evolution-insufficient-memory" };

// The outcome grades Pixymon's judgment, not the market move; plain words keep that distinction.
const OUTCOME_LABEL: Record<EditorialReflectionRecordV2["outcome"]["resolution"], string> = {
  supported: "사흘 뒤 다시 보니 그때 픽시 생각이 맞는 쪽이었음",
  invalidated: "사흘 뒤 다시 보니 그때 픽시 생각이 틀린 쪽이었음",
  unresolved: "사흘이 지나도 그때 픽시 생각이 맞는지 틀린지 판정이 안 났음",
};

function anchoredAt(state: EditorialDraftStateV2, trackingMode: "live" | "shadow"): string | undefined {
  if (trackingMode === "live") return state.publication?.publishedAt;
  return state.draft.trackingMode === "shadow" && !state.publication ? state.draft.createdAt : undefined;
}

/**
 * Picks closed judgments Pixymon has not reflected on yet. Live reflections read only published
 * originals; shadow rehearsal reads only shadow records, so the two never mix.
 */
export function selectEditorialEvolutionV2(
  states: readonly EditorialDraftStateV2[],
  now: string,
  trackingMode: "live" | "shadow"
): EditorialEvolutionSelectionV2 {
  const nowMs = Date.parse(now);
  const sameLedger = states.filter((state) => (state.draft.trackingMode ?? "live") === trackingMode);
  const reflections = sameLedger.filter((state) => state.draft.format === "evolution");
  if (reflections.some((state) => nowMs - Date.parse(state.draft.createdAt) < EVOLUTION_COOLDOWN_MS_V2)) {
    return { status: "blocked", reason: "evolution-cooldown" };
  }
  const reflected = new Set(reflections.flatMap((state) => state.draft.factIds));
  const seenSubjects = new Set<string>();
  const records: EditorialReflectionRecordV2[] = [];
  const closed = sameLedger
    .filter((state) => ["bite", "withhold"].includes(state.draft.format) && anchoredAt(state, trackingMode))
    .map((state) => ({ state, outcome: state.followUps.find((row) => row.checkpoint === "72h" &&
      ["supported", "invalidated", "unresolved"].includes(row.resolution)) }))
    .filter(({ state, outcome }) => outcome && Date.parse(outcome.resolvedAt) <= nowMs &&
      nowMs - Date.parse(outcome.resolvedAt) <= EVOLUTION_LOOKBACK_MS_V2 && state.draft.facts[0] &&
      !reflected.has(state.draft.factIds[0]))
    .sort((a, b) => Date.parse(b.outcome!.resolvedAt) - Date.parse(a.outcome!.resolvedAt) ||
      a.state.draft.id.localeCompare(b.state.draft.id, "en"));
  for (const { state, outcome } of closed) {
    if (records.length >= EVOLUTION_MAX_RECORDS_V2 || seenSubjects.has(state.draft.subject)) continue;
    seenSubjects.add(state.draft.subject);
    records.push({
      draftId: state.draft.id,
      provenance: state.publication ? "live" : "shadow",
      subject: state.draft.subject,
      fact: state.draft.facts[0],
      said: state.publication?.publishedText ?? state.publishText ?? state.draft.draft,
      question: state.draft.editorialCase?.question,
      outcome: {
        resolution: outcome!.resolution as EditorialReflectionRecordV2["outcome"]["resolution"],
        reason: outcome!.reason,
        resolvedAt: outcome!.resolvedAt,
      },
    });
  }
  return records.length >= EVOLUTION_MIN_RECORDS_V2
    ? { status: "planned", records }
    : { status: "blocked", reason: "evolution-insufficient-memory" };
}

export function buildEditorialEvolutionPlanV2(
  records: readonly EditorialReflectionRecordV2[],
  now: string,
  lane: EditorialPlanV2["lane"]
): EditorialPlanV2 {
  const first = records[0].fact;
  const schedule = createFollowUpScheduleV2(new Date(now));
  const invalidated = records.some((record) => record.outcome.resolution === "invalidated");
  const verdict: EditorialVerdictV2 = invalidated ? "corrected"
    : records.every((record) => record.outcome.resolution === "supported") ? "approve" : "digesting";
  return {
    schemaVersion: 2,
    format: "evolution",
    lane,
    subject: records[0].subject,
    thesis: `기억 성찰: ${records.map((record) => `${record.subject} ${record.outcome.resolution}`).join(", ")}`,
    factIds: records.map((record) => record.fact.factId),
    verdict,
    // Reflections are never re-measured (follow-ups track bite/withhold only); the record schema still needs one.
    falsifier: createMachineFalsifierV2({ metric: first.metric.name, comparator: "eq", threshold: first.metric.value,
      unit: first.metric.unit }, schedule),
    followUpAt: schedule,
    voiceState: invalidated ? "humbled" : "patient",
    blockReasons: [],
    rendering: "thought",
  };
}

export function formatEditorialReflectionRecordsV2(records: readonly EditorialReflectionRecordV2[]): string {
  return records.map((record, index) => [
    `${index + 1}. ${record.subject} (factId: ${record.fact.factId}, ${record.provenance === "shadow" ? "비공개 연습 기록" : "실제 게시"})`,
    `   - 그때 본 숫자: ${record.fact.metric.name} ${record.fact.metric.raw}`,
    `   - 그때 픽시가 쓴 글: ${record.said}`,
    record.question ? `   - 그때 품은 질문: ${record.question}` : "",
    `   - 결과: ${OUTCOME_LABEL[record.outcome.resolution]} (${record.outcome.reason})`,
  ].filter(Boolean).join("\n")).join("\n");
}

export function buildEditorialEvolutionPromptV2(
  plan: EditorialPlanV2,
  records: readonly EditorialReflectionRecordV2[],
  retryReasons: readonly string[]
): string {
  const factIds = JSON.stringify(plan.factIds);
  const shadow = records.some((record) => record.provenance === "shadow");
  return `새 데이터가 없는 날, 픽시가 지난 판단들을 돌아보는 생각 글을 한국어 원문 트윗 하나로 써라.

돌아볼 기록(기록에 있는 것만 사실이다):
${formatEditorialReflectionRecordsV2(records)}

규칙:
- 새 사실을 보고하는 글이 아니다. 이 판단들이 어떻게 끝났는지에서 픽시가 무엇을 배웠는지, 믿음이 어떻게 굳거나 흔들렸는지 쓴다
- 흐름: 떠오른 기억 하나 → 그게 어떻게 끝났는지 → 그래서 픽시가 지금 믿거나 의심하는 것. 문장을 이 순서의 틀로 복사하지 말고 흐름만 따른다
- 2~3문장, 공백 포함 40~190자. 기록의 대상 이름 중 하나 이상을 그대로 넣는다
- 결과는 시장이 아니라 그때 픽시의 생각이 맞았는지에 대한 것이다. "급감이 틀렸다"처럼 움직임 자체를 판정하지 않는다
- 맞았다/틀렸다/몇 번 같은 말은 위 결과와 정확히 맞아야 한다. 기록에 없는 결과, 원인, 유입·유출, 앞으로의 전망은 만들지 않는다
- 숫자는 기본으로 쓰지 않는다. 꼭 필요하면 기록의 숫자만 그대로 쓴다
${shadow ? "- 비공개 연습 기록은 실제로 올렸던 글처럼 말하지 않는다(\"올렸던\", \"말했던\" 대신 \"봤던\", \"찍어뒀던\")\n" : ""}- 다음에 다시 확인하겠다는 약속은 하지 않는다
- 해시태그, 이모지, 투자 조언, 존댓말 금지
- JSON 외 텍스트 금지
- claims는 draft의 각 문장을 순서대로 빠짐없이 복사한다. 첫 claim은 기억한 결과(observation), 나머지는 지금의 생각(judgment)이다. 모든 claim의 factIds는 ${factIds} 전체다
${retryReasons.length > 0 ? `- 이전 실패 원인: ${retryReasons.join(", ")}\n` : ""}
출력 JSON:
{"draft":"첫 문장. 둘째 문장.","usedFactIds":${factIds},"claims":[{"kind":"observation","text":"첫 문장.","factIds":${factIds}},{"kind":"judgment","text":"둘째 문장.","factIds":${factIds}}]}`;
}
