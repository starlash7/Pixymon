import type Anthropic from "@anthropic-ai/sdk";
import {
  CLAUDE_MODEL,
  extractTextFromClaude,
  requestBudgetedClaudeMessage,
} from "../llm.js";
import type { EvidenceCardV2 } from "./evidence.js";
import type { EditorialPlanV2 } from "./planner.js";
import {
  canonicalFalsifierSentenceV2,
  formatEvidenceSourceTimeV2,
  hasKoreanConditionalCueV2,
  inferMetricDirectionV2,
  splitEditorialSentencesV2,
  validateEditorialDraftV2,
} from "./validator.js";

export type EditorialClaimKindV2 = "observation" | "judgment" | "falsifier";

export interface EditorialClaimV2 {
  kind: EditorialClaimKindV2;
  text: string;
  factIds: readonly string[];
}

export interface EditorialWriterPayloadV2 {
  draft: string;
  usedFactIds: readonly string[];
  claims: readonly EditorialClaimV2[];
}

export interface EditorialWriterModelV2 {
  generate(input: { system: string; prompt: string; attempt: 1 | 2 }): Promise<string | null>;
}

export type EditorialWritingResultV2 =
  | {
      status: "generated";
      payload: EditorialWriterPayloadV2;
      attempts: 1 | 2;
    }
  | {
      status: "blocked";
      stage: "generation" | "contract";
      reason: string;
      attempts: number;
      validationReasons: readonly string[];
    };

function unwrapJson(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (fenced?.[1] || trimmed).trim();
}

function parsePayload(text: string): EditorialWriterPayloadV2 | null {
  try {
    const parsed = JSON.parse(unwrapJson(text)) as Partial<EditorialWriterPayloadV2>;
    if (typeof parsed.draft !== "string" || !Array.isArray(parsed.usedFactIds) || !Array.isArray(parsed.claims)) {
      return null;
    }
    const claims: EditorialClaimV2[] = [];
    for (const claim of parsed.claims) {
      if (!claim || typeof claim !== "object") return null;
      const row = claim as Partial<EditorialClaimV2>;
      if (
        !["observation", "judgment", "falsifier"].includes(String(row.kind || "")) ||
        typeof row.text !== "string" ||
        !Array.isArray(row.factIds)
      ) return null;
      claims.push({
        kind: row.kind as EditorialClaimKindV2,
        text: row.text.replace(/\s+/g, " ").trim(),
        factIds: row.factIds.map(String),
      });
    }
    return {
      draft: parsed.draft.replace(/\s+/g, " ").trim(),
      usedFactIds: parsed.usedFactIds.map(String),
      claims,
    };
  } catch {
    return null;
  }
}

function validatePayload(
  payload: EditorialWriterPayloadV2,
  plan: EditorialPlanV2,
  evidence: EvidenceCardV2
): string[] {
  const sourceTimeToken = formatEvidenceSourceTimeV2(evidence.source.observedAt);
  const metricTokens = [
    ...evidence.metric.name.split(/[^a-zA-Z0-9]+/).filter(Boolean).map((token) => token.toUpperCase()),
    evidence.metric.unit,
  ];
  const validation = validateEditorialDraftV2({
    text: payload.draft,
    subject: plan.subject,
    displayValue: evidence.metric.raw,
    factIds: plan.factIds,
    usedFactIds: payload.usedFactIds,
    allowedNumericValues: [evidence.metric.period, "24시간", "72시간"],
    allowedNamedTokens: metricTokens,
    sourceTimeToken,
    requireJudgment: true,
    metricName: evidence.metric.name,
    metricDirection: inferMetricDirectionV2(
      evidence.metric.name,
      evidence.metric.raw,
      evidence.metric.value
    ),
    falsifierComparator: plan.falsifier.comparator,
    requireCanonicalFalsifier:
      plan.format !== "revisit" || payload.claims.at(-1)?.kind === "falsifier",
  });
  const reasons = [...validation.reasons];
  const allowed = new Set(plan.factIds);
  const sentences = splitEditorialSentencesV2(payload.draft);
  if (payload.claims.length !== sentences.length) reasons.push("claim-sentence-count");
  for (const [index, claim] of payload.claims.entries()) {
    if (!claim.text || claim.factIds.length === 0) reasons.push("claim-grounding-missing");
    if (claim.factIds.some((id) => !allowed.has(id))) reasons.push("unsupported-claim-fact-id");
    if (claim.text !== sentences[index]) reasons.push("claim-sentence-mismatch");
    if (claim.factIds.length !== plan.factIds.length || claim.factIds.some((id, index) => id !== plan.factIds[index])) {
      reasons.push("claim-fact-coverage-mismatch");
    }
  }
  if (payload.claims[0]?.kind !== "observation") reasons.push("first-claim-not-observation");
  if (payload.claims.filter((claim) => claim.kind === "observation").length !== 1) {
    reasons.push("observation-claim-count");
  }
  const finalClaim = payload.claims.at(-1);
  if (!finalClaim || !["judgment", "falsifier"].includes(finalClaim.kind)) {
    reasons.push("final-claim-kind");
  }
  if (plan.format !== "revisit" && finalClaim?.kind !== "falsifier") {
    reasons.push("non-revisit-final-claim-must-be-falsifier");
  }
  if (
    plan.format !== "revisit" &&
    payload.claims.slice(0, -1).some((claim) => claim.kind === "falsifier")
  ) {
    reasons.push("falsifier-claim-outside-final");
  }
  if (plan.format === "revisit" && finalClaim?.kind !== "judgment") {
    reasons.push("revisit-final-claim-kind");
  }
  if (plan.format === "revisit" && payload.claims.some((claim) => claim.kind === "falsifier")) {
    reasons.push("revisit-falsifier-claim");
  }
  if (finalClaim?.kind === "judgment" && hasKoreanConditionalCueV2(finalClaim.text)) {
    reasons.push("conditional-claim-must-be-falsifier");
  }
  if (plan.format === "revisit" && finalClaim) {
    const verdictLanguage: Record<EditorialPlanV2["verdict"], RegExp> = {
      approve: /지지|유지|맞았|버텼/u,
      corrected: /철회|무효|고치|수정|틀렸/u,
      digesting: /미결|보류|유예|아직/u,
      reject: /기각|거부|반대/u,
    };
    if (!verdictLanguage[plan.verdict].test(finalClaim.text)) {
      reasons.push("revisit-verdict-mismatch");
    }
  }
  if (
    payload.usedFactIds.length !== plan.factIds.length ||
    payload.usedFactIds.some((id, index) => id !== plan.factIds[index])
  ) reasons.push("fact-coverage-mismatch");
  return [...new Set(reasons)];
}

function buildPrompt(
  plan: EditorialPlanV2,
  evidence: EvidenceCardV2,
  retryReasons: readonly string[]
): string {
  const sourceTimeToken = formatEvidenceSourceTimeV2(evidence.source.observedAt);
  const voiceGuide: Record<EditorialPlanV2["voiceState"], string> = {
    curious: "숫자의 의미를 열어 두되 확인할 조건은 선명하게 둔다",
    energized: "큰 변화를 짧고 생기 있게 받아들이되 확신을 부풀리지 않는다",
    skeptical: "나쁜 방향도 공포로 팔지 않고 무엇이 반전시킬지 적는다",
    patient: "사실은 인정하고 넓은 해석은 서두르지 않는다",
    humbled: "이전 판단이 틀렸다면 변명 없이 먼저 고친다",
  };
  const formatGuide: Record<EditorialPlanV2["format"], string> = {
    bite: "중요한 움직임을 물되 반증 가능한 판정을 남긴다",
    withhold: "수치는 확인하지만 그보다 넓은 서사는 승인하지 않는다",
    revisit: "예전 판정으로 돌아와 지지·철회·미결 중 하나로 책임 있게 닫는다",
    evolution: "여러 번 검증된 패턴이 기존 믿음을 어떻게 바꿨는지 말한다",
  };
  const endingRule = plan.format === "revisit"
    ? "마지막 문장은 이전 판정을 지지·철회·미결 중 하나로 닫고, 새 24·72시간 재검증을 약속하지 않는다"
    : `마지막 문장은 반드시 정확히 다음 문장으로 쓴다: ${canonicalFalsifierSentenceV2(plan.falsifier.comparator)}`;
  return `다음 편집 계약을 사실 왜곡 없이 한국어 원문 트윗 하나로 렌더링하라.

편집 계약:
- format: ${plan.format}
- subject: ${plan.subject}
- thesis: ${plan.thesis}
- verdict: ${plan.verdict}
- voiceState: ${plan.voiceState}
- voiceGuide: ${voiceGuide[plan.voiceState]}
- formatGuide: ${formatGuide[plan.format]}
- falsifier: ${plan.falsifier.metric} ${plan.falsifier.comparator} ${plan.falsifier.threshold} ${plan.falsifier.unit || ""} by ${plan.falsifier.deadline}

사용 가능한 유일한 사실:
- factId: ${evidence.id}
- subject: ${evidence.subject}
- metric: ${evidence.metric.name}
- rawValue: ${evidence.metric.raw}
- unit: ${evidence.metric.unit}
- period: ${evidence.metric.period}
- source: ${evidence.source.provider}
- observedAt: ${evidence.source.observedAt}
- publicSourceTime: ${sourceTimeToken}

규칙:
- 정확히 2~3문장, 공백 포함 90~190자
- 첫 문장에 subject, 첫 두 문장 안에 rawValue를 그대로 한 번 넣는다
- 본문에 publicSourceTime을 그대로 한 번 넣는다
- ${endingRule}
- 출처 URL, 해시태그, 투자 조언, 지원되지 않은 이름·숫자는 쓰지 않는다
- TVL만으로 자금 유입, 사용자 복귀, 채택, 수익, 거래량 또는 원인을 사실처럼 단정하지 않는다
- 관측 사실과 픽시몬의 잠정 판단을 구분한다
- 캐릭터 비유는 최대 한 번이며 억지로 넣지 않는다
- 사실을 새로 만들거나 생성 후 문장을 덧붙이지 않는다
- JSON 외 텍스트 금지
- claims는 draft의 각 문장을 순서대로 빠짐없이 복사한다. kind는 관측 사실=observation, 현재 판단=judgment, 반증 조건=falsifier다
- 조건문을 썼다면 해당 claim kind는 falsifier여야 하며, Revisit의 마지막 claim은 judgment여야 한다
- Revisit이 아니면 falsifier claim은 정확히 하나이며 반드시 마지막이어야 한다
- 반증 조건은 의미를 바꾸거나 수식하지 말고 위에 제시한 정확한 통제 문장을 쓴다
- Revisit이 아니면 72시간과 반증·철회 표현은 마지막 통제 문장에서만 한 번 쓴다
- Revisit이 아니면 마지막 문장 전에는 다음·추후·재검증·관측값·기준선 등 별도 후속 조건을 쓰지 않는다
${retryReasons.length > 0 ? `- 이전 실패 원인: ${retryReasons.join(", ")}\n` : ""}
출력 JSON:
{"draft":"첫 문장. 둘째 문장.","usedFactIds":["${evidence.id}"],"claims":[{"kind":"observation","text":"첫 문장.","factIds":["${evidence.id}"]},{"kind":"judgment","text":"둘째 문장.","factIds":["${evidence.id}"]}]}`;
}

export async function writeEditorialDraftV2(input: {
  model: EditorialWriterModelV2;
  plan: EditorialPlanV2;
  evidence: EvidenceCardV2;
}): Promise<EditorialWritingResultV2> {
  let retryReasons: string[] = [];
  for (const attempt of [1, 2] as const) {
    let response: string | null;
    try {
      response = await input.model.generate({
        system: "너는 숫자를 먹고 판정을 기억하는 Pixymon V2다. 헤드라인을 요약하지 않고, 확인한 사실과 잠정 판단을 분리하며, 다시 돌아와 틀리면 먼저 고친다. JSON 계약만 반환한다.",
        prompt: buildPrompt(input.plan, input.evidence, retryReasons),
        attempt,
      });
    } catch {
      retryReasons = ["model-error"];
      continue;
    }
    if (!response) {
      retryReasons = ["model-empty"];
      continue;
    }
    const payload = parsePayload(response);
    if (!payload) {
      retryReasons = ["invalid-json-contract"];
      continue;
    }
    retryReasons = validatePayload(payload, input.plan, input.evidence);
    if (retryReasons.length === 0) return { status: "generated", payload, attempts: attempt };
  }
  return {
    status: "blocked",
    stage: retryReasons.some((reason) => reason === "model-empty" || reason === "model-error")
      ? "generation"
      : "contract",
    reason: retryReasons[0] || "generation-failed",
    attempts: 2,
    validationReasons: retryReasons,
  };
}

export function createAnthropicEditorialWriterV2(
  claude: Anthropic,
  timezone?: string
): EditorialWriterModelV2 {
  return {
    async generate({ system, prompt }) {
      const response = await requestBudgetedClaudeMessage(
        claude,
        {
          model: CLAUDE_MODEL,
          max_tokens: 550,
          temperature: 0,
          system,
          messages: [{ role: "user", content: prompt }],
        },
        { kind: "editorial-v2:write", timezone, allowResearchModel: false }
      );
      return response ? extractTextFromClaude(response.message.content) : null;
    },
  };
}
