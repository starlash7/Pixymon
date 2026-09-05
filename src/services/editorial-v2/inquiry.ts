import type { EditorialInquiryV2, EditorialMemoryContextV2 } from "./contracts.js";
import type { EvidenceCardV2 } from "./evidence.js";
import type { EditorialPlanV2 } from "./planner.js";
import type { EditorialWriterModelV2 } from "./writer.js";

export type EditorialInquiryResultV2 =
  | { status: "reasoned"; inquiry: EditorialInquiryV2; attempts: number }
  | { status: "blocked"; reason: string; attempts: number; validationReasons: string[] };

export function validateEditorialInquiryV2(
  value: unknown,
  context: { factIds: readonly string[]; revisit: boolean; levelTest: boolean; memory?: EditorialMemoryContextV2 }
): string[] {
  if (!value || typeof value !== "object") return ["inquiry-object-required"];
  const inquiry = value as EditorialInquiryV2;
  const reasons: string[] = [];
  for (const key of ["question", "whyThisEvidence", "judgment"] as const) {
    if (typeof inquiry[key] !== "string" || !inquiry[key].trim() || inquiry[key].length > 400) reasons.push(`inquiry-${key}-required`);
  }
  if (!["pursue", "withhold"].includes(inquiry.decision)) reasons.push("inquiry-decision-invalid");
  if (!Array.isArray(inquiry.factIds) || JSON.stringify(inquiry.factIds) !== JSON.stringify(context.factIds)) {
    reasons.push("inquiry-fact-link-mismatch");
  }
  const checks = context.revisit ? ["recorded-checkpoint"] :
    inquiry.decision === "withhold" ? ["observation-only"] :
      context.levelTest ? ["pre-move-level", "current-level"] : [];
  if (!checks.includes(inquiry.check)) reasons.push("inquiry-check-not-supported");
  const previous = context.memory?.previous;
  if (!previous) {
    if (inquiry.memory !== null) reasons.push("inquiry-invented-memory");
  } else if (!inquiry.memory || inquiry.memory.draftId !== previous.draftId ||
      inquiry.memory.resolutionId !== (previous.outcome?.id ?? null)) {
    reasons.push("inquiry-memory-link-mismatch");
  } else {
    for (const key of ["lesson", "change"] as const) {
      if (typeof inquiry.memory[key] !== "string" || !inquiry.memory[key].trim() || inquiry.memory[key].length > 400) {
        reasons.push(`inquiry-memory-${key}-required`);
      }
    }
  }
  return reasons;
}

export function buildEditorialInquiryPromptV2(plan: EditorialPlanV2, evidence: EvidenceCardV2): string {
  return `픽시몬이 무엇을 알아내려는지 먼저 결정하라. 아직 트윗은 쓰지 않는다.
현재 관측: ${JSON.stringify({ id: evidence.id, subject: evidence.subject, metric: evidence.metric, source: evidence.source })}
선별 맥락(파생 자료, 공개 사실로 단정 금지): ${JSON.stringify(evidence.selection ?? null)}
검사 가능한 기준점: ${JSON.stringify(evidence.followUp ?? null)}
기존 검증 계약: ${JSON.stringify(plan.editorialCase ?? null)}
현재 체크포인트 판정: ${plan.format === "revisit" ? plan.verdict : "새 가설의 결과는 아직 없음"}
관련 실제 기록: ${JSON.stringify(plan.memoryContext ?? null)}

스스로 답할 세 가지:
1. 무엇을 알아내고 싶은가? subject 이름만 바꿔 끼운 질문보다 지금 관측과 관련 기록에서 생긴 구체적인 불확실성을 고른다.
2. 왜 이 근거가 중요한가? 무엇을 구별하는 데 도움이 되고 무엇은 아직 모르는지 적는다. 단순히 큰 수치라는 이유로 원인·유입·채택을 만들어내지 않는다.
3. 지난 판단 때문에 이번에는 무엇을 다르게 확인하는가? 이전 질문과 실제 재관측 결과를 읽고, 검사 기준을 바꾸거나 유지하는 이유를 설명한다. 실패하지 않은 기록을 실패로 꾸미지 않는다. shadow는 공개 경험이 아니다.

사용 가능한 검사(새 공급자·임의 수치·새 일정을 만들지 않는다):
- pre-move-level: 변동 전 USD TVL로 완전히 되돌아가는지 확인한다.
- current-level: 지금 USD TVL 수준도 유지되는지 더 엄격하게 확인한다. 상승은 현재값 미만, 하락은 현재값 초과가 반증이다.
- observation-only: 비교 기준이나 검증 가치가 부족해 해석을 유보한다. 가설 지지 판정은 하지 않는다.
- recorded-checkpoint: Revisit 전용. 이미 기록된 기준과 결과를 해석하며 과거 검사 기준을 바꾸지 않는다.
새 가설의 pre-move-level/current-level은 USD TVL 변화와 절대 기준점이 모두 있을 때만 가능하다. 24/72시간 스케줄은 코드가 유지한다.
judgment는 지금 무엇을 중요하게 보고 어떻게 해석하는지다. 미래 가설이 미결이라는 이유만으로 모든 현재 판단을 '보류'로 끝낼 필요는 없다.
공개 가치가 없거나 지금 자료로 답할 수 없는 질문뿐이면 {"decision":"no-post","reason":"구체적 이유"}만 반환한다.
그 외에는 아래 JSON만 반환한다. factIds는 현재 관측 id만 사용한다. 이전 기록이 없으면 memory=null, 있으면 실제 draftId와 outcome.id(없으면 null)를 정확히 연결하고 lesson/change를 적는다.
{"decision":"pursue 또는 withhold","question":"알아내려는 질문","whyThisEvidence":"근거가 중요한 이유와 한계","judgment":"현재의 편집 판단","factIds":["${evidence.id}"],"check":"검사 이름","memory":null}`;
}

export async function reasonEditorialInquiryV2(input: {
  model: EditorialWriterModelV2; plan: EditorialPlanV2; evidence: EvidenceCardV2;
}): Promise<EditorialInquiryResultV2> {
  let reasons: string[] = [];
  for (const attempt of [1, 2] as const) {
    let response: string | null;
    try {
      response = await input.model.generate({
        system: "너는 Pixymon의 편집자다. 호기심을 근거와 실제 기억에 연결한다. 관측, 추론, 미확인을 구분하고 JSON만 반환한다.",
        prompt: buildEditorialInquiryPromptV2(input.plan, input.evidence) +
          (reasons.length ? `\n이전 계약 실패: ${reasons.join(", ")}` : ""), attempt,
      });
    } catch { reasons = ["inquiry-model-error"]; continue; }
    if (!response) return { status: "blocked", reason: "inquiry-model-empty", attempts: attempt, validationReasons: ["inquiry-model-empty"] };
    let value: unknown;
    try { value = JSON.parse(response.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/u, "$1")); }
    catch { reasons = ["inquiry-invalid-json"]; continue; }
    if (value && typeof value === "object" && (value as { decision?: string }).decision === "no-post") {
      const reason = (value as { reason?: unknown }).reason;
      if (typeof reason === "string" && reason.trim() && reason.length <= 400) {
        return { status: "blocked", reason: `inquiry-no-public-value:${reason.trim()}`, attempts: attempt, validationReasons: [] };
      }
    }
    reasons = validateEditorialInquiryV2(value, {
      factIds: input.plan.factIds, revisit: input.plan.format === "revisit",
      levelTest: input.plan.editorialCase?.scope === "usd-tvl-level", memory: input.plan.memoryContext,
    });
    if (!reasons.length) return { status: "reasoned", inquiry: structuredClone(value) as EditorialInquiryV2, attempts: attempt };
  }
  return { status: "blocked", reason: reasons[0], attempts: 2, validationReasons: reasons };
}

/** Changes only a NEW test. Historical originals and their checkpoint results stay immutable. */
export function applyEditorialInquiryV2(
  plan: EditorialPlanV2, evidence: EvidenceCardV2, inquiry: EditorialInquiryV2
): EditorialPlanV2 {
  const reasons = validateEditorialInquiryV2(inquiry, {
    factIds: plan.factIds, revisit: plan.format === "revisit",
    levelTest: plan.editorialCase?.scope === "usd-tvl-level", memory: plan.memoryContext,
  });
  if (reasons.length) throw new Error(reasons.join(","));
  const result = structuredClone(plan);
  result.thesis = inquiry.judgment;
  result.editorialCase = {
    question: inquiry.question, hypothesis: null, scope: "observation-only", factIds: [...plan.factIds],
    limitation: "현재 관측만 인정한다. USD TVL로 순유입, 사용자, 가격 중립 잔류나 원인을 입증하지 않는다.",
    ...result.editorialCase, inquiry: structuredClone(inquiry),
  };
  if (plan.format === "revisit") return result;
  result.editorialCase.question = inquiry.question;
  if (inquiry.check === "observation-only") {
    result.format = "withhold";
    result.editorialCase.scope = "observation-only";
    result.editorialCase.hypothesis = null;
    return result;
  }
  result.format = "bite";
  if (inquiry.check === "current-level") {
    if (!evidence.followUp) throw new Error("inquiry-level-baseline-missing");
    result.falsifier = {
      ...result.falsifier, threshold: evidence.followUp.metric.value,
      comparator: evidence.metric.value > 0 ? "lt" : "gt",
    };
  }
  const complement = { lt: "이상", lte: "초과", gt: "이하", gte: "미만", eq: "이외" };
  result.editorialCase.hypothesis = `72시간 시점 USD TVL이 ${result.falsifier.threshold} USD ${complement[result.falsifier.comparator]}에 남는지 검증한다.`;
  return result;
}
