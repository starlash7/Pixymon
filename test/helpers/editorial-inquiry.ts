import type { EditorialCaseV2, EditorialInquiryV2, EditorialMemoryContextV2 } from "../../src/services/editorial-v2/contracts.ts";
import type { EditorialWriterModelV2 } from "../../src/services/editorial-v2/writer.ts";

/** Deterministic test double, never a production or reader-quality sample. */
export function inquiryFixture(input: {
  factId: string; judgment?: string; levelTest?: boolean; revisit?: boolean; memory?: EditorialMemoryContextV2;
}): EditorialInquiryV2 {
  const previous = input.memory?.previous;
  return {
    decision: input.levelTest || input.revisit ? "pursue" : "withhold",
    question: "이번 수치 변화가 이전에 놓쳤던 지속성을 확인하는 데 도움이 되는가?",
    whyThisEvidence: "같은 지표의 기준점을 고정할 수 있어 되돌림과 현재 수준 유지를 구분할 수 있다. 원인은 아직 모른다.",
    judgment: input.judgment ?? "수치의 크기보다 변화가 유지되는 기준을 확인할 가치가 있다는 판단이다.",
    factIds: [input.factId],
    check: input.revisit ? "recorded-checkpoint" : !input.levelTest ? "observation-only" :
      previous?.outcome?.resolution === "invalidated" ? "current-level" : "pre-move-level",
    memory: previous ? {
      draftId: previous.draftId, resolutionId: previous.outcome?.id ?? null,
      lesson: previous.outcome?.resolution === "invalidated" ? "이전 수준 가설은 반증되어 유지 판단의 범위를 다시 확인해야 한다." : "이전 관측을 출발점으로 삼되 기록된 결과 이상으로 확대하지 않는다.",
      change: previous.outcome?.resolution === "invalidated" ? "이번 새 가설은 변동 전 수준이 아니라 현재 수준까지 유지되는지 검사한다." : "비교 가능성을 위해 원래 검증 기준을 유지한다.",
    } : null,
  };
}

export function inquiryCaseFixture(factId: string, judgment: string, revisit = false): EditorialCaseV2 {
  const inquiry = inquiryFixture({ factId, judgment, revisit });
  return { question: inquiry.question, hypothesis: null, scope: "observation-only", factIds: [factId], limitation: "관측만 인정한다.", inquiry };
}

export const inquiryModelFixture: EditorialWriterModelV2 = {
  modelId: "fixture-inquiry-not-a-real-model",
  async generate({ prompt }) {
    const read = (label: string) => JSON.parse(prompt.split("\n").find((line) => line.startsWith(label))!.slice(label.length));
    const fact = read("현재 관측: ");
    const memory = read("관련 실제 기록: ");
    const contract = read("기존 검증 계약: ");
    const revisit = !prompt.includes("현재 체크포인트 판정: 새 가설의 결과는 아직 없음");
    return JSON.stringify(inquiryFixture({ factId: fact.id, levelTest: contract?.scope === "usd-tvl-level", revisit, memory }));
  },
};
