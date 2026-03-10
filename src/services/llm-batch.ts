import { OnchainNutrient, TrendLane } from "../types/agent.js";
import { ContentLanguage } from "../types/runtime.js";
import { CLAUDE_MODEL, ClaudeMessageCreateParams, PIXYMON_SYSTEM_PROMPT } from "./llm.js";

export interface BatchReadyClaudeJob {
  customId: string;
  kind: string;
  request: ClaudeMessageCreateParams;
  execution: {
    kind: string;
    allowResearchModel?: boolean;
    cacheSharedPrefix?: boolean;
  };
  metadata: Record<string, string | number | boolean>;
}

export interface DigestReflectionBatchInput {
  language: ContentLanguage;
  lane: TrendLane;
  summary: string;
  acceptedNutrients: Array<Pick<OnchainNutrient, "label" | "value" | "source">>;
  rejectReasons: string[];
  xpGainTotal: number;
  evolvedCount: number;
  maxChars: number;
}

export function buildLanguageRewriteJob(input: {
  text: string;
  language: ContentLanguage;
  maxChars: number;
}): BatchReadyClaudeJob {
  const prompt =
    input.language === "ko"
      ? `아래 문장을 자연스러운 한국어 한 줄로 다시 써줘.

원문:\n${input.text}

규칙:
- ${input.maxChars}자 이내
- 의미 유지
- 해시태그/이모지 금지
- 최종 문장만 출력`
      : `Rewrite the text in natural English, one line.

Original:\n${input.text}

Rules:
- Max ${input.maxChars} chars
- Keep meaning
- No hashtags or emoji
- Output only the final sentence`;

  return {
    customId: buildCustomId("rewrite-language", input.language, input.text),
    kind: "rewrite:language",
    request: {
      model: CLAUDE_MODEL,
      max_tokens: 220,
      system: PIXYMON_SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
    },
    execution: {
      kind: "rewrite:language",
    },
    metadata: {
      language: input.language,
      maxChars: input.maxChars,
    },
  };
}

export function buildReplyRewriteJob(input: {
  text: string;
  language: ContentLanguage;
  maxChars: number;
}): BatchReadyClaudeJob {
  const prompt =
    input.language === "ko"
      ? `아래 답글을 자연스러운 한국어 한 줄로 다시 써줘.

원문:
${input.text}

규칙:
- ${input.maxChars}자 이내
- 의미 유지
- 해시태그/이모지 금지
- 문장만 출력`
      : `Rewrite this as a one-line English reply.

Original:
${input.text}

Rules:
- Max ${input.maxChars} chars
- Keep meaning
- No hashtags or emoji
- Output sentence only`;

  return {
    customId: buildCustomId("rewrite-reply", input.language, input.text),
    kind: "rewrite:reply-language",
    request: {
      model: CLAUDE_MODEL,
      max_tokens: 220,
      system: PIXYMON_SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
    },
    execution: {
      kind: "rewrite:reply-language",
    },
    metadata: {
      language: input.language,
      maxChars: input.maxChars,
    },
  };
}

export function buildDigestReflectionJob(input: DigestReflectionBatchInput): BatchReadyClaudeJob {
  const nutrientLines = input.acceptedNutrients
    .slice(0, 4)
    .map((item) => `${item.label} ${item.value} (${item.source})`)
    .join("\n");
  const rejectLine = input.rejectReasons.length > 0 ? input.rejectReasons.join(", ") : "none";
  const prompt =
    input.language === "ko"
      ? `아래 nutrient digest를 바탕으로 짧은 reflection memo 1개 작성.

레인: ${input.lane}
요약: ${input.summary}
채택 nutrient:
${nutrientLines || "- none"}
거절 사유:
${rejectLine}
XP gain: ${input.xpGainTotal}
진화 이벤트: ${input.evolvedCount}

규칙:
- ${input.maxChars}자 이내
- 한국어
- 2~3문장
- 숫자 자랑보다 무엇을 다시 확인해야 하는지 중심
- 본문만 출력`
      : `Write one short reflection memo from this nutrient digest.

Lane: ${input.lane}
Summary: ${input.summary}
Accepted nutrients:
${nutrientLines || "- none"}
Reject reasons:
${rejectLine}
XP gain: ${input.xpGainTotal}
Evolution events: ${input.evolvedCount}

Rules:
- Max ${input.maxChars} chars
- English
- 2-3 sentences
- Focus on what to verify next, not on boasting numbers
- Output text only`;

  return {
    customId: buildCustomId("digest-reflection", input.language, `${input.lane}|${input.summary}`),
    kind: "digest:reflection",
    request: {
      model: CLAUDE_MODEL,
      max_tokens: 260,
      system: PIXYMON_SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
    },
    execution: {
      kind: "digest:reflection",
    },
    metadata: {
      language: input.language,
      lane: input.lane,
      maxChars: input.maxChars,
      nutrientCount: input.acceptedNutrients.length,
      summarySnippet: input.summary.slice(0, 80),
    },
  };
}

function buildCustomId(prefix: string, language: ContentLanguage, text: string): string {
  return `${prefix}:${language}:${String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, "-")
    .slice(0, 40)}`;
}
