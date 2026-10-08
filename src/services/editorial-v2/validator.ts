import type { EditorialRenderingV2 } from "./contracts.js";

const MALFORMED_KO_PATTERNS: Array<{ code: string; pattern: RegExp }> = [
  { code: "malformed-nuun", pattern: /(?:안|못)\s*눕은/u },
  { code: "malformed-stem-particle", pattern: /어긋난에서/u },
  { code: "analyst-ending", pattern: /(?:함께|계속)\s*(?:비교|확인|관찰)한다[.!]?$/u },
  { code: "scene-boilerplate", pattern: /기사로 끝날지 .*여기서 갈린다/u },
];

// Digits inside a Latin name ("Stargate V2의") belong to the name, which the named-token gate checks.
const NUMBER_TOKEN = /(?<![A-Za-z0-9.])[-+]?\d+(?:[,.]\d+)*(?:%|[a-zA-Z가-힣/]+)?/gu;
const CHARACTER_CUE = /픽시몬|물고|씹고|먹고|소화|흉터|눕/gu;
const LATIN_NAMED_TOKEN = /\b[A-Za-z][A-Za-z0-9.-]{1,}\b/g;
const KNOWN_KO_CRYPTO_ENTITY = /비트코인|이더리움|솔라나|테더|리플|에이다|도지코인|아발란체|체인링크|폴리곤|유니스왑|아비트럼|커브|메이커다오/gu;
const INCREASE_WORD = /늘|증가|상승|올랐|커졌|확대/u;
const DECREASE_WORD = /줄|감소|하락|내렸|빠졌|낮아졌|축소/u;
// Conjugated stems only: thought copy is free prose, so bare "늘" would match "오늘" or "늘 그렇듯".
const THOUGHT_INCREASE_WORD = /늘었|늘어|증가|상승|올랐|커졌|불어났|부풀|확대/u;
const THOUGHT_DECREASE_WORD = /줄었|줄어|감소|하락|내렸|빠졌|빠지|낮아졌|축소|홀쭉|쪼그라/u;
const JUDGMENT_WORD = /판정|판단|결론|해석|반증|승인|보류|유예|기각|무효|철회|유지|지지|미결|틀리|거둔다|남긴다/u;
const FUTURE_RECHECK_PROMISE = /(?:다음|후속).{0,32}(?:확인|검증|점검|살피|다시\s*보|판단.{0,8}갱신|판정.{0,8}갱신|갱신|업데이트|다시\s*쓰)(?:하겠다|겠다|할\s*(?:예정|계획|생각))|(?:다음|후속).{0,24}(?:오면|도착하면|나오면).{0,16}(?:확인|검증|점검|갱신|업데이트|다시\s*쓰)|(?:재검증|다시\s*(?:확인|검증|점검|살피|보|쓰)|지켜보)(?:하겠다|겠다)|(?:확인|검증|관찰|점검)할\s*(?:예정|계획)|(?:새|새로운)\s*(?:숫자|수치|데이터).{0,16}(?:오면|도착하면|나오면).{0,16}(?:갱신|업데이트|다시\s*쓰)|(?:다음|후속|향후|차후|앞으로|추후|나중|(?:새|새로운)\s*(?:숫자|수치|데이터)).{0,48}(?:재평가할|바꿀|고칠|(?:고쳐|다시)\s*쓸)\s*(?:예정|계획|생각)|돌아오겠다/u;
// Fixture-backed closed-world guard: a TVL level/change does not prove these separate phenomena.
const UNSUPPORTED_TVL_CLAIM = /사용자|활성\s*주소|신규\s*(?:자금|예치)|자금\s*(?:유입|유출|복귀|이탈)|유입|유출|채택|수익|매출|거래량|구조적\s*성장|안정성|경쟁력|신뢰.{0,8}(?:회복|강화)|담보\s*건전성|청산\s*위험|고래\s*지갑|기관\s*(?:매수|복귀)|매수.{0,12}(?:원인|배경)|확정적\s*신호|증명|보장/u;
const SCOPE_NEGATION = /(?:뜻|의미|증명|보장|확정|단정|승인)하지\s*않|(?:확인|증명|보장)되지\s*않|아니(?:다|라는|라고|며|고)|(?:단정|구분|구별)할\s*수\s*없|모른다|모르겠/u;
const POSITIVE_SCOPE_BEFORE_NEGATION = /(?:뜻|의미)(?:하고|하며|하나)|확인(?:됐|되었)(?:고|으며)/u;
// Formal 합쇼체 reads as a news desk or assistant, not the character ("아니다" is plain speech).
const FORMAL_REGISTER = /(?<!아)니다(?=[.!?,\s]|$)|니까[?]/u;
const UNSUPPORTED_KO_QUANTITY = /(?:두|세|네)\s*배|절반|반토막|수(?:십|백|천|만|억)(?:만|억)?(?:\s*달러)?/u;

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
  forbidFutureRecheck?: boolean;
  minChars?: number;
  maxChars?: number;
  /** `thought` drops the mandatory number/source-time/judgment-word placement; every stated fact stays grounded. */
  rendering?: EditorialRenderingV2;
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
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  return `${month}월 ${day}일 ${iso.slice(11, 16)} UTC`;
}

export function splitEditorialSentencesV2(text: string): string[] {
  return String(text || "")
    .replace(/\n+/g, " ")
    .split(/(?<=[.!?])\s+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

export function hasUnsupportedTvlClaimV2(text: string): boolean {
  return splitEditorialSentencesV2(text).some((sentence) =>
    sentence
      // Keep the negating connective on the clause it governs, then inspect
      // the following assertion independently so one caveat cannot shield it.
      .replace(/(않(?:고|으며|지만|으나)|아니(?:고|며|지만|나))\s*,?\s*/gu, "$1\u0000")
      .split(/\u0000|그러나|반면|다만|;/u)
      .some((clause) => {
        const mentions = [...clause.matchAll(
          new RegExp(UNSUPPORTED_TVL_CLAIM.source, "gu")
        )];
        if (mentions.length === 0) return false;
        const negation = SCOPE_NEGATION.exec(clause);
        if (!negation || POSITIVE_SCOPE_BEFORE_NEGATION.test(clause)) return true;
        // A negation can govern a preceding list ("A나 B를 뜻하지 않는다"),
        // but it cannot excuse a new unsupported assertion that begins after it.
        return mentions.some((mention) => (mention.index ?? 0) > negation.index);
      })
  );
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
  const thought = input.rendering === "thought";
  const minChars = input.minChars ?? (thought ? 40 : 90);
  const maxChars = input.maxChars ?? 190;
  const sentences = splitEditorialSentencesV2(text);
  const reasons: string[] = [];

  if (text.length < minChars) reasons.push("too-short");
  if (text.length > maxChars) reasons.push("too-long");
  if (sentences.length < 2 || sentences.length > 3) reasons.push("sentence-count");
  if (!/[가-힣]/u.test(text)) reasons.push("korean-missing");
  if (thought) {
    // A thought may say "Stargate" for "Stargate V2"; it still has to be about the selected subject.
    if (!text.includes(subjectAnchorV2(input.subject))) reasons.push("subject-missing");
  } else {
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
  }
  if (input.forbidFutureRecheck && FUTURE_RECHECK_PROMISE.test(text)) {
    reasons.push("future-recheck-promise");
  }
  if (/tvl/i.test(input.metricName || "") && hasUnsupportedTvlClaimV2(text)) {
    reasons.push("metric-semantic-scope");
  }
  if (FORMAL_REGISTER.test(text)) reasons.push("formal-register");
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
  if (UNSUPPORTED_KO_QUANTITY.test(text)) reasons.push("unsupported-number-word");

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

  const numericSentence = sentences.find((sentence) => sentence.includes(input.displayValue));
  // Without the number, a thought describes the move in words in its opening observation.
  const factSentence = numericSentence ?? (thought ? sentences[0] || "" : "");
  const increaseWord = thought && !numericSentence ? THOUGHT_INCREASE_WORD : INCREASE_WORD;
  const decreaseWord = thought && !numericSentence ? THOUGHT_DECREASE_WORD : DECREASE_WORD;
  if (input.metricDirection === "increase" && decreaseWord.test(factSentence)) {
    reasons.push("metric-direction-conflict");
  }
  if (input.metricDirection === "decrease" && increaseWord.test(factSentence)) {
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

export function subjectAnchorV2(subject: string): string {
  return String(subject || "").trim().split(/\s+/u)[0] || "";
}

/** One contract for writer, review, publish and rollout re-validation of the same draft. */
export function editorialDraftValidationInputV2(input: {
  text: string;
  subject: string;
  fact: {
    metric: { name: string; raw: string; value: number; period: string; unit: string };
    source: { observedAt: string };
  };
  factIds: readonly string[];
  usedFactIds: readonly string[];
  rendering?: EditorialRenderingV2;
}): EditorialDraftValidationInputV2 {
  const { metric } = input.fact;
  return {
    text: input.text,
    subject: input.subject,
    displayValue: metric.raw,
    factIds: input.factIds,
    usedFactIds: input.usedFactIds,
    allowedNumericValues: [metric.period, "24시간", "72시간"],
    allowedNamedTokens: [
      ...metric.name.split(/[^a-zA-Z0-9]+/).filter(Boolean).map((token) => token.toUpperCase()),
      metric.unit,
    ],
    sourceTimeToken: formatEvidenceSourceTimeV2(input.fact.source.observedAt),
    requireJudgment: true,
    metricName: metric.name,
    metricDirection: inferMetricDirectionV2(metric.name, metric.raw, metric.value),
    forbidFutureRecheck: true,
    rendering: input.rendering ?? "data",
  };
}
