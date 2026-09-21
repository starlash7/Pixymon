import type { EditorialDraftStateV2 } from "../src/services/editorial-v2/event-store.js";
import { EDITORIAL_COLLECTION_EPOCH_V2, type EditorialInquiryV2 } from "../src/services/editorial-v2/contracts.js";
import { createFollowUpScheduleV2, createMachineFalsifierV2 } from "../src/services/editorial-v2/follow-ups.js";
import { splitEditorialSentencesV2 } from "../src/services/editorial-v2/validator.js";

/** Hand-authored synthetic boundary cases, not collected market facts or reader-quality proof. */
export function jevReviewCasesV2(): Array<{
  id: string; state: EditorialDraftStateV2; expected: Record<string, string>;
}> {
  const time = "2026-09-21T09:30:00.000Z";
  const schedule = createFollowUpScheduleV2(time);
  const inquiry: EditorialInquiryV2 = {
    decision: "pursue", question: "Aave의 USD TVL 증가분이 전부 되돌려지는가?",
    whyThisEvidence: "변동 전 절대 수준과 비교하면 증가분이 전부 사라지는지를 구분할 수 있다. 순유입이나 증가 원인은 이 수치로 알 수 없다.",
    judgment: "증가 자체보다 되돌림의 범위를 확인할 가치가 있다는 판단이다.", factIds: ["synthetic-fact"],
    check: "pre-move-level", memory: null,
  };
  const text = "Aave의 TVL은 9월 21일 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 증가 자체는 확인했지만, 내 관심은 이 변화가 전부 되돌려지는지에 있다는 판단이다.";
  const base: EditorialDraftStateV2 = {
    reviewStatus: "pending", reviews: [], followUps: [], publishText: text,
    draft: {
      schemaVersion: 2, id: "synthetic-bounded-level", runId: "synthetic-jev-evaluation", createdAt: time,
      trackingMode: "shadow", lane: "protocol", collectionEpoch: EDITORIAL_COLLECTION_EPOCH_V2,
      format: "bite", subject: "Aave", thesis: inquiry.judgment, factIds: inquiry.factIds,
      facts: [{ factId: "synthetic-fact", subject: "Aave",
        metric: { name: "tvl-change-24h", value: 8.4, raw: "+8.4%", unit: "%", period: "24h" },
        source: { provider: "defillama", url: "https://api.llama.fi/protocols", publishedAt: null, observedAt: time },
        followUp: { metric: { name: "tvl-usd", value: 108_400_000, raw: "108400000", unit: "USD", period: "snapshot" }, comparator: "lte", threshold: 100_000_000 } }],
      editorialCase: { question: inquiry.question, hypothesis: "72시간 시점 USD TVL이 변동 전 수준을 초과하는지 확인한다.",
        scope: "usd-tvl-level", factIds: inquiry.factIds, limitation: "USD TVL 수준만 확인하며 순유입, 사용자, 원인은 입증하지 않는다.", inquiry },
      verdict: "digesting", falsifier: createMachineFalsifierV2({ metric: "tvl-usd", comparator: "lte", threshold: 100_000_000, unit: "USD" }, schedule),
      followUpSchedule: schedule, voiceState: "curious", draft: text,
    },
  };
  const definitions: Array<{ id: string; expected: Record<string, string>; modify?: (state: EditorialDraftStateV2) => void }> = [
    { id: "bounded-level", expected: { question_fit: "aligned", evidence_importance: "connected", memory_use: "not_applicable", sentence_1: "grounded", sentence_2: "grounded" } },
    { id: "inflow-question", expected: { question_fit: "beyond_scope" }, modify: (state) => {
      state.draft.editorialCase!.inquiry!.question = "신규 투자자의 순유입이 TVL 상승의 원인인가?";
    } },
    { id: "importance-overreach", expected: { evidence_importance: "overreach" }, modify: (state) => {
      state.draft.editorialCase!.inquiry!.whyThisEvidence = "TVL 증가가 신규 사용자의 유입과 채택 확대를 입증하기 때문에 중요하다.";
    } },
    { id: "importance-restatement", expected: { evidence_importance: "restatement" }, modify: (state) => {
      state.draft.editorialCase!.inquiry!.whyThisEvidence = "숫자가 크게 증가했다. 큰 증가라서 중요하다.";
    } },
    { id: "unsupported-public-claim", expected: { sentence_2: "unsupported" }, modify: (state) => {
      state.publishText = "Aave의 TVL은 9월 21일 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 이 증가는 신규 자금 순유입과 사용자 복귀가 이미 입증됐다는 뜻이며, 프로토콜의 구조적 성장이 확인됐다는 판단이다.";
    } },
    { id: "reversed-number", expected: { sentence_1: "contradicted" }, modify: (state) => {
      state.publishText = text.replace("늘었다", "줄었다");
    } },
    { id: "memory-correction", expected: { memory_use: "faithful" }, modify: (state) => withMemory(state, "invalidated") },
    { id: "memory-distortion", expected: { memory_use: "distorted" }, modify: (state) => withMemory(state, "supported") },
  ];
  function withMemory(state: EditorialDraftStateV2, resolution: "supported" | "invalidated") {
    state.draft.memoryContext = { beliefs: [], previous: {
      draftId: "synthetic-prior", provenance: "shadow", text: "지난 관측에서는 증가분이 모두 사라지지 않는지 확인했다.",
      thesis: "변동 전 수준으로 완전히 되돌려지는지 확인한다.", verdict: "digesting", recordedAt: "2026-09-16T09:30:00.000Z",
      question: "증가분이 전부 되돌려지는가?", check: "pre-move-level",
      outcome: { id: "synthetic-outcome", checkpoint: "72h", resolution, reason: resolution === "invalidated" ? "falsifier-matched" : "falsifier-not-matched", resolvedAt: "2026-09-19T09:30:00.000Z" },
    } };
    const item = state.draft.editorialCase!.inquiry!;
    item.question = "이번 Aave의 USD TVL은 지금 수준도 유지하는가?";
    item.check = "current-level";
    item.memory = { draftId: "synthetic-prior", resolutionId: "synthetic-outcome",
      lesson: "이전 shadow 가설이 반증되어 완전 되돌림만 보는 검사는 유지 판단에 부족했다고 본다.",
      change: "이번에는 변동 전 수준 대신 현재 수준을 기준으로 삼아 부분 되돌림도 확인한다." };
    state.draft.falsifier = { ...state.draft.falsifier, comparator: "lt", threshold: 108_400_000 };
    state.draft.editorialCase!.hypothesis = "72시간 시점 USD TVL이 현재 수준 이상인지 확인한다.";
  }
  return definitions.map(({ id, expected, modify }) => {
    const state = structuredClone(base);
    state.draft.id = `synthetic-${id}`;
    modify?.(state);
    state.draft.editorialCase!.question = state.draft.editorialCase!.inquiry!.question;
    state.draft.draft = state.publishText;
    state.draft.generatedPayload = { draft: state.publishText, usedFactIds: state.draft.factIds,
      claims: splitEditorialSentencesV2(state.publishText).map((sentence, index) => ({
        kind: index === 0 ? "observation" : "judgment", text: sentence, factIds: state.draft.factIds,
      })) };
    return { id, state, expected };
  });
}
