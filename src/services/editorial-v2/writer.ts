import type Anthropic from "@anthropic-ai/sdk";
import {
  CLAUDE_MODEL,
  extractTextFromClaude,
  requestBudgetedClaudeMessage,
} from "../llm.js";
import type { EvidenceCardV2 } from "./evidence.js";
import type { EditorialPlanV2 } from "./planner.js";
import {
  formatEvidenceSourceTimeV2,
  inferMetricDirectionV2,
  splitEditorialSentencesV2,
  validateEditorialDraftV2,
} from "./validator.js";

export type EditorialClaimKindV2 = "observation" | "judgment";

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
  modelId?: string;
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
        !["observation", "judgment"].includes(String(row.kind || "")) ||
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
    forbidFutureRecheck: true,
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
  if (!finalClaim || finalClaim.kind !== "judgment") {
    reasons.push("final-claim-kind");
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

export function buildEditorialPromptV2(
  plan: EditorialPlanV2,
  evidence: EvidenceCardV2,
  retryReasons: readonly string[]
): string {
  const sourceTimeToken = formatEvidenceSourceTimeV2(evidence.source.observedAt);
  const voiceGuide: Record<EditorialPlanV2["voiceState"], string> = {
    curious: "숫자의 의미를 열어 두되 현재 근거의 경계는 선명하게 둔다",
    energized: "큰 변화를 짧고 생기 있게 받아들이되 확신을 부풀리지 않는다",
    skeptical: "나쁜 방향도 공포로 팔지 않고 현재 근거가 허락하는 판단만 적는다",
    patient: "사실은 인정하고 넓은 해석은 서두르지 않는다",
    humbled: "이전 판단이 틀렸다면 변명 없이 먼저 고친다",
  };
  const formatGuide: Record<EditorialPlanV2["format"], string> = {
    bite: "중요한 움직임을 물고 현재 숫자의 범위 안에서 잠정 판정을 남긴다",
    withhold: "수치는 확인하지만 그보다 넓은 서사는 승인하지 않는다",
    revisit: "예전 판정으로 돌아와 지지·철회·미결 중 하나로 책임 있게 닫는다",
    evolution: "여러 번 검증된 패턴이 기존 믿음을 어떻게 바꿨는지 말한다",
  };
  const verdictGuide: Record<EditorialPlanV2["verdict"], string> = {
    approve: "잠정 지지",
    corrected: "기존 해석의 수정",
    digesting: "해석 보류",
    reject: "기각",
  };
  const endingRule = plan.format === "revisit"
    ? "마지막 문장은 이전 판정을 지지·철회·미결 중 하나로 닫고, 새 24·72시간 재검증을 약속하지 않는다"
    : plan.editorialCase?.inquiry
      ? "마지막 문장은 편집 판단을 자기 말로 표현한다. 검증 결과가 아직 없다는 이유로 모든 글을 보류로 끝내지 않는다. 미래 가설을 이미 확인한 사실처럼 말하지 않는다"
    : `마지막 문장은 지금 관측에 대한 ${verdictGuide[plan.verdict]} 판단으로 닫는다. 조건문은 허용하되 새 관측 일정은 약속하지 않는다`;
  return `다음 편집 계약을 사실 왜곡 없이 한국어 원문 트윗 하나로 렌더링하라.

편집 계약:
- format: ${plan.format}
- subject: ${plan.subject}
- thesis: ${plan.thesis}
- verdict: ${plan.verdict}
- voiceState: ${plan.voiceState}
- voiceGuide: ${voiceGuide[plan.voiceState]}
- formatGuide: ${formatGuide[plan.format]}
- 검증 계약: ${JSON.stringify(plan.editorialCase ?? null)}
- 이번 탐구: ${JSON.stringify(plan.editorialCase?.inquiry ?? null)}
- 이번 탐구가 있으면 질문·근거의 의미·기억에서 바꾼 확인 방법 중 독자가 알아야 할 핵심을 현재 판단에 담는다. 내부 필드명이나 검토용 수치를 옮겨 적지 않는다.
- 읽기 전용 기억: ${JSON.stringify(plan.memoryContext ?? null)}
- 기억은 과거 판단을 연결하는 자료이지 현재 사실의 추가 근거가 아니다. 기억의 숫자를 본문에 재사용하지 않는다. shadow 기억을 실제 공개 게시라고 표현하지 않는다.
- Revisit은 기억의 실제 질문·판정 중 무엇이 바뀌었는지 밝힌다. USD TVL 수준의 가설 지지를 가격 중립 잔류나 원인 입증으로 확대하지 않는다.

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
- claims는 draft의 각 문장을 순서대로 빠짐없이 복사한다. kind는 관측 사실=observation, 현재 판단=judgment 둘 중 하나다
- 첫 claim만 observation이고 나머지 claim은 judgment다
- 반증 수치와 일정은 검토함에 보존한다. 본문에서 새로운 숫자·일정·재검증 약속은 만들지 않는다
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
        prompt: buildEditorialPromptV2(input.plan, input.evidence, retryReasons),
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
  timezone?: string,
  purpose: "write" | "inquire" = "write"
): EditorialWriterModelV2 {
  return {
    modelId: CLAUDE_MODEL,
    async generate({ system, prompt }) {
      const response = await requestBudgetedClaudeMessage(
        claude,
        {
          model: CLAUDE_MODEL,
          max_tokens: purpose === "inquire" ? 1000 : 550,
          temperature: 0,
          system,
          messages: [{ role: "user", content: prompt }],
        },
        { kind: `editorial-v2:${purpose}`, timezone, allowResearchModel: false }
      );
      return response ? extractTextFromClaude(response.message.content) : null;
    },
  };
}
