import type { MachineComparatorV2 } from "./contracts.js";

const MALFORMED_KO_PATTERNS: Array<{ code: string; pattern: RegExp }> = [
  { code: "malformed-nuun", pattern: /(?:안|못)\s*눕은/u },
  { code: "malformed-stem-particle", pattern: /어긋난에서/u },
  { code: "analyst-ending", pattern: /(?:함께|계속)\s*(?:비교|확인|관찰)한다[.!]?$/u },
  { code: "scene-boilerplate", pattern: /기사로 끝날지 .*여기서 갈린다/u },
];

const NUMBER_TOKEN = /[-+]?\d+(?:[,.]\d+)*(?:%|[a-zA-Z가-힣/]+)?/gu;
const CHARACTER_CUE = /픽시몬|물고|씹고|먹고|소화|흉터|눕/gu;
const LATIN_NAMED_TOKEN = /\b[A-Za-z][A-Za-z0-9.-]{1,}\b/g;
const KNOWN_KO_CRYPTO_ENTITY = /비트코인|이더리움|솔라나|테더|리플|에이다|도지코인|아발란체|체인링크|폴리곤/gu;
const INCREASE_WORD = /늘|증가|상승|올랐|커졌|확대/u;
const DECREASE_WORD = /줄|감소|하락|내렸|빠졌|낮아졌|축소/u;
const JUDGMENT_WORD = /판정|판단|결론|해석|반증|승인|보류|기각|무효|철회|유지|지지|미결|틀리|거둔다|남긴다/u;
const REVERSAL_ACTION = /반증|기각|무효|철회|취소|번복|틀리|거둔|수정/u;
const CONDITIONAL_CUE = /(?:으)?면|경우|(?:아|어|여)도|더라도/u;
const COMPARATOR_CUE = /미만|이하|초과|이상|같|동일/u;
// Non-final prose is the free judgment area. Reserve future-check and threshold
// language for the exact final falsifier so a competing condition cannot hide there.
const NON_FINAL_FALSIFIER_LANGUAGE = /72시간|다음|추후|나중|후속|재검증|관측값|기준(?:선|값)|웃돌|밑돌|상회|하회|미만|이하|초과|이상|경우|(?:할|한|하는|될|된|되는)\s*(?:때|순간)|폐기|파기/u;
// Fixture-backed closed-world guard: a TVL level/change does not prove these separate phenomena.
const UNSUPPORTED_TVL_CLAIM = /사용자|활성\s*주소|신규\s*자금|자금\s*(?:유입|유출|복귀)|채택|수익|매출|거래량|구조적\s*성장|안정성|경쟁력|신뢰.{0,8}(?:회복|강화)|담보\s*건전성|청산\s*위험|확정적\s*신호|증명|보장/u;

export interface EditorialDraftValidationInputV2 {
  text: string;
  subject: string;
  displayValue: string;
  factIds: readonly string[];
  usedFactIds: readonly string[];
  allowedNumericValues?: readonly string[];
  allowedNamedTokens?: readonly string[];
  sourceTimeToken?: string;
  requireJudgment?: boolean;
  metricName?: string;
  metricDirection?: "increase" | "decrease" | "snapshot";
  falsifierComparator?: MachineComparatorV2;
  requireCanonicalFalsifier?: boolean;
  minChars?: number;
  maxChars?: number;
}

function hasExplicitFalsifierDirectionConflict(
  text: string,
  comparator: MachineComparatorV2
): boolean {
  const requiredLanguage: Record<MachineComparatorV2, RegExp> = {
    lt: /미만/u,
    lte: /이하/u,
    gt: /초과/u,
    gte: /이상/u,
    eq: /같|동일/u,
  };
  return !requiredLanguage[comparator].test(text);
}

export function hasKoreanConditionalCueV2(text: string): boolean {
  return CONDITIONAL_CUE.test(text);
}

export function canonicalFalsifierSentenceV2(comparator: MachineComparatorV2): string {
  const clause: Record<MachineComparatorV2, string> = {
    lt: "기준 미만이면",
    lte: "기준 이하라면",
    gt: "기준을 초과하면",
    gte: "기준 이상이라면",
    eq: "기준과 같다면",
  };
  return `72시간 뒤 같은 지표의 관측값이 ${clause[comparator]} 이 판정을 철회한다.`;
}

export interface EditorialDraftValidationV2 {
  ok: boolean;
  reasons: string[];
  sentenceCount: number;
  charCount: number;
}

export function inferMetricDirectionV2(
  metricName: string,
  raw: string,
  value: number
): "increase" | "decrease" | "snapshot" {
  if (!/change|delta|증감|변화/i.test(metricName) && !/^[+-]/.test(raw)) return "snapshot";
  return value > 0 ? "increase" : value < 0 ? "decrease" : "snapshot";
}

export function formatEvidenceSourceTimeV2(observedAt: string): string {
  const parsed = Date.parse(observedAt);
  if (!Number.isFinite(parsed)) throw new Error("evidence observedAt must be a valid instant");
  const iso = new Date(parsed).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export function splitEditorialSentencesV2(text: string): string[] {
  return String(text || "")
    .replace(/\n+/g, " ")
    .split(/(?<=[.!?])\s+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function normalizeNumericToken(token: string): string {
  return token.toLowerCase().replace(/,/g, "").trim();
}

function collectNumericTokens(text: string): string[] {
  return [...String(text || "").matchAll(NUMBER_TOKEN)].map((match) => normalizeNumericToken(match[0]));
}

function tokenSet(text: string): Set<string> {
  return new Set(
    String(text || "")
      .replace(/[^0-9a-zA-Z가-힣\s]/g, " ")
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2)
  );
}

function sentenceSimilarity(left: string, right: string): number {
  const a = tokenSet(left);
  const b = tokenSet(right);
  if (!a.size || !b.size) return 0;
  const overlap = [...a].filter((token) => b.has(token)).length;
  const union = new Set([...a, ...b]).size;
  return union > 0 ? overlap / union : 0;
}

export function validateEditorialDraftV2(
  input: EditorialDraftValidationInputV2
): EditorialDraftValidationV2 {
  const text = String(input.text || "").replace(/\s+/g, " ").trim();
  const minChars = input.minChars ?? 90;
  const maxChars = input.maxChars ?? 190;
  const sentences = splitEditorialSentencesV2(text);
  const reasons: string[] = [];

  if (text.length < minChars) reasons.push("too-short");
  if (text.length > maxChars) reasons.push("too-long");
  if (sentences.length < 2 || sentences.length > 3) reasons.push("sentence-count");
  if (!/[가-힣]/u.test(text)) reasons.push("korean-missing");
  if (!sentences[0]?.includes(input.subject)) reasons.push("subject-not-in-first-sentence");
  if (!sentences.slice(0, 2).join(" ").includes(input.displayValue)) {
    reasons.push("numeric-fact-not-in-first-two-sentences");
  }
  if (input.sourceTimeToken && !text.includes(input.sourceTimeToken)) {
    reasons.push("source-time-missing");
  }
  if (input.requireJudgment && !JUDGMENT_WORD.test(sentences.at(-1) || "")) {
    reasons.push("final-judgment-missing");
  }
  const finalSentence = sentences.at(-1) || "";
  const hasFalsifierLanguage =
    input.requireCanonicalFalsifier === true ||
    hasKoreanConditionalCueV2(finalSentence) ||
    COMPARATOR_CUE.test(finalSentence);
  if (
    input.falsifierComparator &&
    hasFalsifierLanguage &&
    hasExplicitFalsifierDirectionConflict(finalSentence, input.falsifierComparator)
  ) {
    reasons.push("falsifier-direction-mismatch");
  }
  if (
    input.falsifierComparator &&
    hasFalsifierLanguage &&
    finalSentence !== canonicalFalsifierSentenceV2(input.falsifierComparator)
  ) {
    // Do not try to infer arbitrary Korean logic here. A falsifier is executable
    // product state, so its public wording is deliberately a one-to-one grammar.
    reasons.push("falsifier-language-not-canonical");
  }
  if (input.requireCanonicalFalsifier) {
    const earlierSentences = sentences.slice(0, -1).join(" ");
    const deadlineCount = text.match(/72시간/gu)?.length ?? 0;
    if (deadlineCount !== 1) reasons.push("falsifier-deadline-not-isolated");
    if (hasKoreanConditionalCueV2(earlierSentences)) {
      // Non-Revisit copy gets exactly one executable condition: the final
      // machine-rendered sentence. This structural rule catches unseen
      // paraphrases without pretending a synonym list proves Korean logic.
      reasons.push("falsifier-condition-outside-final");
    }
    if (REVERSAL_ACTION.test(earlierSentences)) reasons.push("falsifier-action-outside-final");
    if (NON_FINAL_FALSIFIER_LANGUAGE.test(earlierSentences)) {
      reasons.push("falsifier-language-outside-final");
    }
  }
  if (/tvl/i.test(input.metricName || "") && UNSUPPORTED_TVL_CLAIM.test(text)) {
    reasons.push("metric-semantic-scope");
  }
  if (/https?:\/\/|www\./iu.test(text)) reasons.push("public-source-url");
  if (/#\S+/u.test(text)) reasons.push("hashtag");
  if ((text.match(CHARACTER_CUE) || []).length > 1) reasons.push("character-cue-overuse");
  for (const { code, pattern } of MALFORMED_KO_PATTERNS) {
    if (pattern.test(text)) reasons.push(code);
  }

  const allowedNumbers = new Set([
    ...collectNumericTokens(input.subject),
    ...collectNumericTokens(input.displayValue),
    ...collectNumericTokens(input.sourceTimeToken || ""),
    ...collectNumericTokens((input.allowedNumericValues || []).join(" ")),
  ]);
  const unsupportedNumbers = collectNumericTokens(text).filter((token) => !allowedNumbers.has(token));
  if (unsupportedNumbers.length > 0) reasons.push("unsupported-number");

  const allowedNames = new Set(
    [input.subject, input.displayValue, input.sourceTimeToken || "", ...(input.allowedNamedTokens || [])]
      .flatMap((value) => String(value).match(LATIN_NAMED_TOKEN) || [])
      .map((token) => token.toLowerCase())
  );
  const unsupportedNames = (text.match(LATIN_NAMED_TOKEN) || []).filter(
    (token) => !allowedNames.has(token.toLowerCase())
  );
  if (unsupportedNames.length > 0) reasons.push("unsupported-name");
  const unsupportedKoEntities = (text.match(KNOWN_KO_CRYPTO_ENTITY) || []).filter(
    (token) => !input.subject.includes(token)
  );
  if (unsupportedKoEntities.length > 0) reasons.push("unsupported-korean-entity");

  const factSentence = sentences.find((sentence) => sentence.includes(input.displayValue)) || "";
  if (input.metricDirection === "increase" && DECREASE_WORD.test(factSentence)) {
    reasons.push("metric-direction-conflict");
  }
  if (input.metricDirection === "decrease" && INCREASE_WORD.test(factSentence)) {
    reasons.push("metric-direction-conflict");
  }

  const allowedFactIds = new Set(input.factIds);
  if (input.usedFactIds.length === 0) reasons.push("used-fact-id-missing");
  if (input.usedFactIds.some((id) => !allowedFactIds.has(id))) reasons.push("unsupported-fact-id");
  if (sentences.some((sentence, index) => index > 0 && sentenceSimilarity(sentences[index - 1], sentence) >= 0.72)) {
    reasons.push("sentence-semantic-repeat");
  }

  return {
    ok: reasons.length === 0,
    reasons: [...new Set(reasons)],
    sentenceCount: sentences.length,
    charCount: text.length,
  };
}
