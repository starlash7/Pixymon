import { createHash } from "node:crypto";
import type { EvidenceCardV2 } from "./evidence.js";
import type { EditorialWriterModelV2 } from "./writer.js";
import { formatEditorialReflectionRecordsV2, type EditorialReflectionRecordV2 } from "./evolution.js";

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

/** Reflections are checked against the recorded outcomes instead of a fresh measurement. */
export function buildEditorialMemoryScopeCriticPromptV2(text: string, records: readonly EditorialReflectionRecordV2[]): string {
  return `아래 글이 픽시의 지난 판단 기록과 다른 주장을 하거나, 기록으로 확인할 수 없는 것을 사실처럼 말하는지 판정하라.

기록:
${formatEditorialReflectionRecordsV2(records)}

말할 수 있는 것:
- 기록된 판단과 그 결과(버텼다, 반증됐다, 판정이 안 났다), 그리고 그 개수
- 그 결과에서 픽시가 느끼거나 배운 것, 지금의 믿음과 의심

fail인 것:
- 기록과 다른 결과나 개수(예: 반증된 것을 맞았다고 함, 하나를 두 번이라고 함)
- 기록에 없는 원인, 자금 유입·유출, 사용자 행동, 앞으로의 전망을 사실이나 유력한 해석으로 말함
- 비공개 연습 기록을 실제로 올렸던 글처럼 말함

질문, 모른다는 말, 부정은 pass다.

글:
${text}

JSON만 반환한다:
{"verdict":"pass 또는 fail","claim":"fail이면 문제 문장, pass면 빈 문자열","problem":"fail이면 무엇을 넘어섰는지 한 줄"}`;
}

export async function reviewEditorialScopeV2(input: {
  model: EditorialWriterModelV2;
  text: string;
  evidence?: EvidenceCardV2;
  records?: readonly EditorialReflectionRecordV2[];
}): Promise<EditorialScopeCriticResultV2> {
  if (!input.evidence && !input.records?.length) return { status: "unavailable", reason: "scope-critic-context-missing" };
  const prompt = input.records?.length
    ? buildEditorialMemoryScopeCriticPromptV2(input.text, input.records)
    : buildEditorialScopeCriticPromptV2(input.text, input.evidence!);
  let malformed = "scope-critic-contract";
  // Transport retries live in the model adapter; a malformed verdict gets one more read of the same text.
  for (const attempt of [1, 2] as const) {
    let response: string | null;
    try {
      response = await input.model.generate({
        system: "너는 Pixymon 글의 근거 범위 검토자다. 문체는 평가하지 않는다. 근거가 허락하지 않는 주장만 찾고 JSON만 반환한다.",
        prompt,
        attempt,
      });
    } catch (error) {
      return { status: "unavailable", reason: error instanceof Error && error.message ? error.message : "scope-critic-model-error" };
    }
    if (!response) return { status: "unavailable", reason: "scope-critic-model-empty" };
    let value: { verdict?: unknown; claim?: unknown; problem?: unknown };
    try {
      const parsed = JSON.parse(response.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/u, "$1"));
      // Small models sometimes wrap the single verdict object in an array.
      value = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;
    } catch {
      malformed = "scope-critic-invalid-json";
      continue;
    }
    const verdict = typeof value?.verdict === "string" ? value.verdict.trim().toLowerCase() : "";
    if (verdict === "pass") {
      return { status: "pass", review: {
        status: "pass", modelId: input.model.modelId ?? "unidentified-model", textSha256: editorialScopeTextDigestV2(input.text),
      } };
    }
    if (verdict === "fail" && typeof value.claim === "string" && value.claim.trim()) {
      return { status: "fail", claim: value.claim.trim().slice(0, 300),
        problem: typeof value.problem === "string" ? value.problem.trim().slice(0, 300) : "" };
    }
    malformed = "scope-critic-contract";
  }
  return { status: "unavailable", reason: malformed };
}
