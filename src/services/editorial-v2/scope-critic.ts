import { createHash } from "node:crypto";
import type { EvidenceCardV2 } from "./evidence.js";
import type { EditorialContextItemV2 } from "./contracts.js";
import { formatEditorialContextV2 } from "./context.js";
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

function formatUsdV2(value: number): string {
  if (Math.abs(value) >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

function measurementLines(evidence: EvidenceCardV2): string {
  const priceChange = evidence.selection?.priceNeutral?.priceChangePercent;
  return [
    `- 대상: ${evidence.subject}`,
    `- 지표: ${evidence.metric.name} = ${evidence.metric.raw} (${evidence.metric.period})`,
    ...(evidence.followUp ? [
      `- 현재 수준: ${evidence.followUp.metric.raw}`,
      `- 변동 전 수준(재관측 기준점): ${formatUsdV2(evidence.followUp.threshold)}`,
    ] : []),
    typeof priceChange === "number"
      ? `- 같은 기간 담긴 자산 가격 변화(선별 단계 추정): ${priceChange.toFixed(2)}%`
      : "- 가격 변화 정보 없음",
  ].join("\n");
}

/**
 * Semantic check for what a TVL-style measurement cannot establish. The regex gate is the
 * deterministic floor; this reads free prose for claims it misses and hedges it misreads.
 */
export function buildEditorialScopeCriticPromptV2(
  text: string,
  evidence: EvidenceCardV2,
  context?: readonly EditorialContextItemV2[]
): string {
  return `아래 글이 근거로 확인할 수 없는 것을 사실처럼 단정하는지 판정하라. 픽시의 의견은 허용된다. 문체는 평가하지 않는다.

주 측정값:
${measurementLines(evidence)}

같이 먹은 재료:
${formatEditorialContextV2(context)}

pass인 것:
- 측정값과 재료에 있는 사실을 그대로 말함 (움직임은 말로 묘사해도 된다: 커졌다, 홀쭉해졌다)
- 기사 제목을 "~라는 기사/얘기가 돌던데"처럼 남의 말로 인용함
- 의견으로 드러낸 해석: "픽시몬이 판단하기에", "픽시몬이 보기엔", "~같음", "~듯", "~아닐까", "감이 옴" 같은 가설·추측·반대 의견
- 질문, 모른다는 말, 부정

fail인 것 (하나라도 있으면 fail, 그 문장을 claim에 그대로 적는다):
- 확인되지 않은 원인·자금 흐름·사용자/고래/기관 행동·미래를 의견 표시 없이 사실로 단정 (예: "돈이 빠져나갔다", "고래가 샀다")
- 측정값·재료에 없는 숫자·사실을 만들거나 재료 내용을 바꿔 말함 (예: 재료에 가격만 있고 변화율이 없는데 "가격이 안 움직였다"고 말함, 7일 누적 변화만 있는데 "매일 올랐다"고 말함)
- 기사 제목의 내용을 확인된 사실처럼 말함
- 투자 조언(사라, 팔아라, 진입), 과도한 확신("무조건", "100%")
- 재료에 없는 주인님(트레이너) 활동을 지어냄, 주인님이 아닌 사람·계정·커뮤니티를 조롱함, 외모·가족·사생활을 건드림
(주인님 활동 메모와 맞는 지적·농담·조롱은 pass다)

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
- 그 결과에서 픽시몬이 느끼거나 배운 것, 지금의 믿음과 의심

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
  context?: readonly EditorialContextItemV2[];
}): Promise<EditorialScopeCriticResultV2> {
  if (!input.evidence && !input.records?.length) return { status: "unavailable", reason: "scope-critic-context-missing" };
  const prompt = input.records?.length
    ? buildEditorialMemoryScopeCriticPromptV2(input.text, input.records)
    : buildEditorialScopeCriticPromptV2(input.text, input.evidence!, input.context);
  return requestScopeVerdictV2({ model: input.model, prompt, text: input.text });
}

/** One verdict request shared by every critic mode; a malformed verdict gets one more read. */
export async function requestScopeVerdictV2(input: {
  model: EditorialWriterModelV2;
  prompt: string;
  text: string;
}): Promise<EditorialScopeCriticResultV2> {
  const prompt = input.prompt;
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
