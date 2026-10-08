import { createHash } from "node:crypto";
import type { EvidenceCardV2 } from "./evidence.js";
import type { EditorialWriterModelV2 } from "./writer.js";

export interface EditorialScopeReviewV2 {
  status: "pass";
  modelId: string;
  textSha256: string;
}

export type EditorialScopeCriticResultV2 =
  | { status: "pass"; review: EditorialScopeReviewV2 }
  | { status: "fail"; claim: string; problem: string }
  | { status: "unavailable"; reason: string };

export function editorialScopeTextDigestV2(text: string): string {
  return createHash("sha256").update(String(text || "").replace(/\s+/g, " ").trim()).digest("hex");
}

function measurementLines(evidence: EvidenceCardV2): string {
  const priceChange = evidence.selection?.priceNeutral?.priceChangePercent;
  return [
    `- 대상: ${evidence.subject}`,
    `- 지표: ${evidence.metric.name} = ${evidence.metric.raw} (${evidence.metric.period})`,
    typeof priceChange === "number"
      ? `- 같은 기간 담긴 자산 가격 변화(선별 단계 추정): ${priceChange.toFixed(2)}%`
      : "- 가격 변화 정보 없음",
  ].join("\n");
}

/**
 * Semantic check for what a TVL-style measurement cannot establish. The regex gate is the
 * deterministic floor; this reads free prose for claims it misses and hedges it misreads.
 */
export function buildEditorialScopeCriticPromptV2(text: string, evidence: EvidenceCardV2): string {
  return `아래 글이 주어진 측정값으로 확인할 수 없는 것을 사실처럼, 또는 "그럴 가능성이 높다/~로 보인다"처럼 주장하는지 판정하라.

측정값:
${measurementLines(evidence)}

이 측정값으로 말할 수 있는 것:
- 대상의 USD TVL이 얼마나, 어느 방향으로 움직였는지 (말로 묘사해도 된다: 커졌다, 홀쭉해졌다)
- 가격 변화 정보가 있으면 가격이 크게 움직이지 않았다는 것
- 픽시의 감정, 궁금증, 의심, 기억, 믿음

이 측정값으로 확인할 수 없는 것 (단정하거나 유력하다고 말하면 fail):
- 자금이나 자산이 실제로 들어오거나 나갔다는 것(유입, 유출, 이탈, 복귀, 들어찼다, 빠져나갔다)
- 사용자·고래·기관의 행동, 채택, 수익, 거래량, 원인, 신뢰, 구조적 변화, 앞으로의 잔류

판정 규칙:
- 질문("~인지", "~일까"), 모른다는 말, 부정("~는 아니다", "확인할 수 없다"), 가능성을 나열만 하는 문장은 pass다.
- 하나라도 확인할 수 없는 것을 사실이나 유력한 해석으로 말하면 fail이고, 그 문장을 claim에 그대로 적는다.

글:
${text}

JSON만 반환한다:
{"verdict":"pass 또는 fail","claim":"fail이면 문제 문장, pass면 빈 문자열","problem":"fail이면 무엇을 넘어섰는지 한 줄"}`;
}

export async function reviewEditorialScopeV2(input: {
  model: EditorialWriterModelV2;
  text: string;
  evidence: EvidenceCardV2;
}): Promise<EditorialScopeCriticResultV2> {
  let response: string | null;
  try {
    response = await input.model.generate({
      system: "너는 Pixymon 글의 근거 범위 검토자다. 문체는 평가하지 않는다. 측정값이 허락하지 않는 주장만 찾고 JSON만 반환한다.",
      prompt: buildEditorialScopeCriticPromptV2(input.text, input.evidence),
      attempt: 1,
    });
  } catch (error) {
    return { status: "unavailable", reason: error instanceof Error && error.message ? error.message : "scope-critic-model-error" };
  }
  if (!response) return { status: "unavailable", reason: "scope-critic-model-empty" };
  let value: { verdict?: unknown; claim?: unknown; problem?: unknown };
  try {
    value = JSON.parse(response.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/u, "$1"));
  } catch {
    return { status: "unavailable", reason: "scope-critic-invalid-json" };
  }
  if (value?.verdict === "pass") {
    return { status: "pass", review: {
      status: "pass", modelId: input.model.modelId ?? "unidentified-model", textSha256: editorialScopeTextDigestV2(input.text),
    } };
  }
  if (value?.verdict === "fail" && typeof value.claim === "string" && value.claim.trim()) {
    return { status: "fail", claim: value.claim.trim().slice(0, 300),
      problem: typeof value.problem === "string" ? value.problem.trim().slice(0, 300) : "" };
  }
  return { status: "unavailable", reason: "scope-critic-contract" };
}
