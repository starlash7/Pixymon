import { MarketData } from "../blockchain-news.js";
import { findNarrativeDuplicate, validateMarketConsistency } from "../content-guard.js";
import { memory } from "../memory.js";
import {
  AdaptivePolicy,
  ContentQualityCheck,
  ContentQualityRules,
  PostQualityContext,
  RecentPostRecord,
} from "./types.js";

const DEFAULT_CONTENT_QUALITY_RULES: ContentQualityRules = {
  minPostLength: 20,
  topicMaxSameTag24h: 2,
  sentimentMaxRatio24h: 0.25,
  topicBlockConsecutiveTag: true,
};

const SIGNAL_LANE_PRIORITY = [
  "sentiment-fear",
  "sentiment-greed",
  "stable-flow",
  "whale-flow",
  "exchange-flow",
  "onchain",
  "btc",
  "eth",
  "sol",
  "divergence",
  "turning-point",
  "question-ending",
  "observation-ending",
];

const KO_CONTROL_TAG_PREFIX =
  /^(?:오늘의\s*)?(?:자아\s*노트|정체성\s*메모|철학\s*(?:메모|노트)|상호작용\s*실험|메타\s*회고|짧은\s*우화|실수\s*로그|관찰\s*노트|내\s*일지(?:\s*한\s*줄)?)\s*[:：-]\s*/i;
const EN_CONTROL_TAG_PREFIX =
  /^(?:identity\s*note|philosophy\s*note|interaction\s*experiment|meta\s*reflection|short\s*fable|failure\s*log|mission\s*post)\s*[:：-]\s*/i;
const NARRATIVE_LABEL_LEAK =
  /(상호작용\s*실험|짧은\s*우화|철학\s*메모|메타\s*회고|실수\s*로그|관찰\s*노트|identity\s*note|philosophy\s*note|interaction\s*experiment|meta\s*reflection|failure\s*log|observation\s*note)\s*[:：]/i;
const BOT_STYLE_LEAD =
  /^(?:오늘의\s*미션은|이번엔\s*반응\s*실험|짧은\s*우화로\s*남기면|이건\s*관찰이자\s*커뮤니티\s*실험|관찰\s*노트[:：]|실수\s*로그[:：]|나는\s*AI\s*생명체)/i;
const KO_ACTION_PATTERN = /(확인|점검|검증|추적|관찰|비교|대조|체크|기록|모니터링|살핀|보겠|맞춰|보고\s|다시\s*본)/;
const EN_ACTION_PATTERN = /\b(check|verify|track|monitor|observe|test|compare|review)\b/i;
const KO_INVALIDATION_PATTERN =
  /(반증|틀리|무효|기각|버리|수정|철회|바꾸|뒤집|내려놓|폐기|보류|종료|교체|무너지|닫지\s*않|가설[^.!?]{0,12}접|깨지면|조건\s*이?\s*깨지|않으면|아니라면|반대\s*(?:신호|증거))/;
const EN_INVALIDATION_PATTERN =
  /\b(falsif|invalidate|wrong if|drop this thesis|revise this thesis|if .*?(?:fails|breaks)|opposite evidence)\b/i;

const KO_ACTION_INVALIDATION_BRIDGES = [
  "먼저 핵심 단서부터 확인한다. 이 조건이 틀리면 해석을 바로 바꾼다.",
  "나는 지금 신호의 순서를 점검한다. 반대 근거가 이어지면 가설을 접는다.",
  "우선 로그를 맞춰 본다. 핵심 전제가 깨지면 결론을 철회한다.",
  "지금은 확인을 먼저 하고 확신을 늦춘다. 반증이 쌓이면 관점을 수정한다.",
  "먼저 흐름을 검증한다. 반대 증거가 늘어나면 이 읽기를 버린다.",
];
const KO_ACTION_INVALIDATION_BRIDGES_SHORT = [
  "반증이면 관점을 바꾼다.",
  "조건이 틀리면 이 해석을 접는다.",
  "핵심 전제가 깨지면 결론을 철회한다.",
];
const EN_ACTION_INVALIDATION_BRIDGES = [
  "I verify the key signals first, then revise the thesis if opposite evidence persists.",
  "I check the core premise first, and I drop this read when counter-evidence accumulates.",
  "I validate the sequence first, then invalidate the claim if the condition breaks.",
];
const EN_ACTION_INVALIDATION_BRIDGES_SHORT = [
  "I revise this if falsified.",
  "I drop this read if conditions fail.",
  "If the premise breaks, I retract this claim.",
];

export function resolveContentQualityRules(raw?: Partial<ContentQualityRules>): ContentQualityRules {
  return {
    minPostLength: clampInt(raw?.minPostLength, 10, 120, DEFAULT_CONTENT_QUALITY_RULES.minPostLength),
    topicMaxSameTag24h: clampInt(raw?.topicMaxSameTag24h, 1, 8, DEFAULT_CONTENT_QUALITY_RULES.topicMaxSameTag24h),
    sentimentMaxRatio24h: clampNumber(
      raw?.sentimentMaxRatio24h,
      0.05,
      1,
      DEFAULT_CONTENT_QUALITY_RULES.sentimentMaxRatio24h
    ),
    topicBlockConsecutiveTag:
      typeof raw?.topicBlockConsecutiveTag === "boolean"
        ? raw.topicBlockConsecutiveTag
        : DEFAULT_CONTENT_QUALITY_RULES.topicBlockConsecutiveTag,
  };
}

export function sanitizeTweetText(text: string): string {
  return String(text || "")
    .replace(/\r?\n+/g, " ")
    .replace(/\t+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .trim();
}

export function polishTweetText(text: string, language: "ko" | "en" = "ko"): string {
  let output = sanitizeTweetText(text)
    .replace(/\s*([,;:!?])\s*/g, "$1 ")
    .replace(/\s*\(\s*/g, "(")
    .replace(/\s*\)\s*/g, ") ")
    .replace(/\)\s+([,.;:!?])/g, ")$1")
    .replace(/\)\s+([은는이가을를와과도에의로])/g, ")$1")
    .replace(/\)\s*\(/g, ") (")
    .replace(/([0-9A-Za-z$])\(/g, "$1 (")
    .replace(/\s*[|]\s*/g, " | ")
    .replace(/\s*·\s*/g, " · ")
    .replace(/\s{2,}/g, " ");

  const quoteCount = (output.match(/"/g) || []).length;
  if (quoteCount % 2 === 1) {
    output = output.replace(/"/g, "");
  }

  if (language === "ko") {
    output = output
      .replace(/([가-힣])([$A-Za-z]{2,10})/g, "$1 $2")
      .replace(/([가-힣])(\d)/g, "$1 $2")
      .replace(/\b([A-Za-z]{2,10})\s+([은는이가을를와과도에의로]\b)/g, "$1$2")
      .replace(/\b([A-Za-z]{2,10})\s+([은는이가을를와과도에의로][가-힣])/g, "$1$2");
  }

  return sanitizeTweetText(output);
}

export function stripNarrativeControlTags(text: string): string {
  let output = sanitizeTweetText(String(text || ""));
  for (let i = 0; i < 3; i += 1) {
    const trimmed = output
      .replace(KO_CONTROL_TAG_PREFIX, "")
      .replace(EN_CONTROL_TAG_PREFIX, "")
      .replace(/\b(?:meta reflection|interaction experiment|philosophy note|identity note)\s*[:：]/gi, "")
      .replace(/(?:메타\s*회고|상호작용\s*실험|철학\s*메모|관찰\s*노트)\s*[:：]/g, "")
      .trim();
    if (trimmed === output) break;
    output = trimmed;
  }
  return polishTweetText(output, inferTextLanguage(output));
}

export function validateActionAndInvalidation(
  text: string,
  language: "ko" | "en"
): { ok: true } | { ok: false; reason: string } {
  const normalized = sanitizeTweetText(String(text || ""));
  if (!normalized) {
    return { ok: false, reason: "행동/반증 구조 없음(empty)" };
  }
  const hasAction = containsActionSignal(normalized, language);
  if (!hasAction) {
    return { ok: false, reason: "행동 계획 부재(무엇을 확인할지 없음)" };
  }
  const hasInvalidation = containsInvalidationSignal(normalized, language);
  if (!hasInvalidation) {
    return { ok: false, reason: "반증/무효화 조건 부재" };
  }
  return { ok: true };
}

export function enforceActionAndInvalidation(
  text: string,
  language: "ko" | "en",
  maxChars: number
): string {
  const cleaned = polishTweetText(stripNarrativeControlTags(text), language);
  const structure = validateActionAndInvalidation(cleaned, language);
  if (structure.ok) {
    return polishTweetText(cleaned, language).slice(0, maxChars);
  }
  const seed = stableHash(cleaned || "pixymon");
  const room = Math.max(0, maxChars - cleaned.length);
  const useShortBridge = room < 44;
  const bridge =
    language === "ko"
      ? useShortBridge
        ? KO_ACTION_INVALIDATION_BRIDGES_SHORT[seed % KO_ACTION_INVALIDATION_BRIDGES_SHORT.length]
        : KO_ACTION_INVALIDATION_BRIDGES[seed % KO_ACTION_INVALIDATION_BRIDGES.length]
      : useShortBridge
        ? EN_ACTION_INVALIDATION_BRIDGES_SHORT[seed % EN_ACTION_INVALIDATION_BRIDGES_SHORT.length]
        : EN_ACTION_INVALIDATION_BRIDGES[seed % EN_ACTION_INVALIDATION_BRIDGES.length];
  const separator = /[.!?]$/.test(cleaned) ? " " : ". ";
  return polishTweetText(`${cleaned}${separator}${bridge}`, language).slice(0, maxChars);
}

export function evaluateReplyQuality(
  text: string,
  marketData: MarketData[],
  recentReplyTexts: string[],
  policy: AdaptivePolicy
): ContentQualityCheck {
  const language = inferTextLanguage(text);
  const normalized = polishTweetText(text, language);
  const surfaceIssue = detectSurfaceIssue(normalized, language);
  if (surfaceIssue) {
    return { ok: false, reason: surfaceIssue };
  }

  const marketConsistency = validateMarketConsistency(normalized, marketData);
  if (!marketConsistency.ok) {
    return { ok: false, reason: marketConsistency.reason || "시장 숫자 불일치" };
  }

  const duplicate = memory.checkDuplicate(normalized, policy.replyDuplicateThreshold);
  if (duplicate.isDuplicate) {
    return { ok: false, reason: "기존 발화와 과도하게 유사" };
  }

  const narrativeDup = findNarrativeDuplicate(normalized, recentReplyTexts, policy.replyNarrativeThreshold);
  if (narrativeDup.isDuplicate) {
    return {
      ok: false,
      reason: `최근 댓글과 내러티브 중복(sim=${narrativeDup.similarity})`,
    };
  }

  return { ok: true };
}

export function evaluatePostQuality(
  text: string,
  marketData: MarketData[],
  recentPosts: RecentPostRecord[],
  policy: AdaptivePolicy,
  rules: ContentQualityRules = DEFAULT_CONTENT_QUALITY_RULES,
  context: PostQualityContext = {}
): ContentQualityCheck {
  const language = context.language || inferTextLanguage(text);
  const normalizedText = polishTweetText(text, language);
  if (!normalizedText || normalizedText.length < rules.minPostLength) {
    return { ok: false, reason: "문장이 너무 짧음" };
  }
  const surfaceIssue = detectSurfaceIssue(normalizedText, language);
  if (surfaceIssue) {
    return { ok: false, reason: surfaceIssue };
  }
  if (NARRATIVE_LABEL_LEAK.test(normalizedText)) {
    return { ok: false, reason: "내부 서사 라벨 노출" };
  }
  if (BOT_STYLE_LEAD.test(normalizedText)) {
    return { ok: false, reason: "폼 기반 오프너 노출" };
  }
  const numericProfile = inspectNumericProfile(normalizedText);
  if (numericProfile.hardNoise) {
    return {
      ok: false,
      reason: `숫자/티커 과밀(숫자 ${numericProfile.numberCount}, 티커 ${numericProfile.tickerCount})`,
    };
  }

  const repetitiveWord = detectLexicalRepetition(normalizedText, language);
  if (repetitiveWord) {
    return { ok: false, reason: `문장 반복 패턴 과다(${repetitiveWord})` };
  }

  const recentPostTexts = recentPosts.map((post) => post.content);
  const marketConsistency = validateMarketConsistency(normalizedText, marketData);
  if (!marketConsistency.ok) {
    return { ok: false, reason: marketConsistency.reason || "시장 숫자 불일치" };
  }

  const duplicate = memory.checkDuplicate(normalizedText, policy.postDuplicateThreshold);
  if (duplicate.isDuplicate) {
    return { ok: false, reason: "기존 트윗과 의미 중복" };
  }

  const narrativeDup = findNarrativeDuplicate(normalizedText, recentPostTexts, policy.postNarrativeThreshold);
  if (narrativeDup.isDuplicate) {
    return {
      ok: false,
      reason: `최근 포스트와 내러티브 중복(sim=${narrativeDup.similarity})`,
    };
  }
  const candidateMotifs = extractNarrativeMotifs(normalizedText);
  const modeShiftAllowed =
    context.allowTopicRepeatOnModeShift === true &&
    typeof context.narrativeMode === "string" &&
    typeof context.previousNarrativeMode === "string" &&
    context.narrativeMode.length > 0 &&
    context.previousNarrativeMode.length > 0 &&
    context.narrativeMode !== context.previousNarrativeMode;

  if (candidateMotifs.size >= 4) {
    const motifDup = recentPostTexts
      .slice(-16)
      .some((item) => motifSimilarity(candidateMotifs, extractNarrativeMotifs(item)) >= 0.7);
    if (motifDup) {
      return { ok: false, reason: "핵심 서사 모티프 반복" };
    }
  }
  const recentWithin24 = recentPosts.filter((post) => isWithinHours(post.timestamp, 24));
  const candidateLane = buildSignalLane(normalizedText, candidateMotifs);
  if (candidateLane && recentWithin24.length > 0) {
    const sameLaneCount = recentWithin24.filter((post) => {
      const lane = buildSignalLane(post.content);
      return lane && lane === candidateLane;
    }).length;
    const laneAllowance = modeShiftAllowed ? 1 : 0;
    if (sameLaneCount >= 2 + laneAllowance) {
      return { ok: false, reason: `동일 시그널 레인 반복(${candidateLane})` };
    }
  }

  const normalized = sanitizeTweetText(normalizedText).slice(0, 24);
  if (normalized) {
    const openingRepeatCount = recentPostTexts
      .slice(-12)
      .filter((item) => sanitizeTweetText(item).slice(0, 24) === normalized).length;
    if (openingRepeatCount >= 2) {
      return { ok: false, reason: "문장 시작 패턴 중복" };
    }
  }
  const recentStructures = recentPostTexts.slice(-20).map((item) => normalizeNarrativeStructure(item));
  const candidateStructure = normalizeNarrativeStructure(normalizedText);
  if (candidateStructure) {
    const prefix = candidateStructure.slice(0, 34);
    if (prefix && recentStructures.some((item) => item.slice(0, 34) === prefix)) {
      return { ok: false, reason: "서두 구조 반복" };
    }
    const suffix = candidateStructure.slice(-32);
    const sameSuffixCount =
      suffix.length >= 16 ? recentStructures.filter((item) => item.slice(-32) === suffix).length : 0;
    if (sameSuffixCount >= 2) {
      return { ok: false, reason: "마무리 패턴 반복" };
    }
  }

  if (recentWithin24.length > 0) {
    const candidateTag = inferTopicTag(normalizedText);
    const recentTags = recentWithin24.map((post) => inferTopicTag(post.content));
    const lastTag = recentTags[recentTags.length - 1];

    if (rules.topicBlockConsecutiveTag && lastTag === candidateTag && !modeShiftAllowed) {
      return { ok: false, reason: `주제 다양성 부족(${candidateTag} 연속)` };
    }
    const sameTagCount = recentTags.filter((tag) => tag === candidateTag).length;
    const tagAllowance = rules.topicMaxSameTag24h + (modeShiftAllowed ? 1 : 0);
    if (isCoreTopicTag(candidateTag) && sameTagCount >= tagAllowance) {
      return { ok: false, reason: `24h 내 동일 주제 과밀(${candidateTag})` };
    }
    if (candidateTag === "sentiment") {
      const projectedRatio = (sameTagCount + 1) / Math.max(1, recentWithin24.length + 1);
      if (projectedRatio > rules.sentimentMaxRatio24h) {
        return { ok: false, reason: `sentiment 비중 초과(${Math.round(projectedRatio * 100)}%)` };
      }
    }
  }

  const requiredTrendTokens = normalizeRequiredTrendTokens(context.requiredTrendTokens);
  if (requiredTrendTokens.length > 0 && !containsAnyTrendToken(normalizedText, requiredTrendTokens)) {
    return { ok: false, reason: "트렌드 포커스 키워드 미반영" };
  }
  if (context.fearGreedEvent?.required) {
    const candidateTag = inferTopicTag(text);
    if (candidateTag === "sentiment" && !context.fearGreedEvent.isEvent) {
      return { ok: false, reason: "FGI 이벤트 없음(sentiment 서사 제한)" };
    }
  }

  if (context.requireActionAndInvalidation) {
    const structure = validateActionAndInvalidation(normalizedText, language);
    if (!structure.ok) {
      return { ok: false, reason: structure.reason };
    }
  }

  return { ok: true };
}

export function inferTopicTag(text: string): string {
  const lower = text.toLowerCase();
  const lead = lower.slice(0, 110);
  if (/fear|greed|fgi|극공포|공포\s*지수|탐욕\s*지수/.test(lead)) return "sentiment";
  if (/\$btc|bitcoin|비트코인/.test(lead)) return "bitcoin";
  if (/\$eth|ethereum|이더/.test(lead)) return "ethereum";
  if (/규제|regulation|policy|compliance|sec|cftc|법안|당국/.test(lead)) return "regulation";
  if (/fomc|fed|macro|금리|inflation|dxy/.test(lead)) return "macro";
  if (/onchain|멤풀|수수료|고래|stablecoin|스테이블|유동성|tvl/.test(lead)) return "onchain";
  if (/layer2|rollup|업그레이드|mainnet|testnet|protocol/.test(lead)) return "tech";
  if (/ai|agent|inference/.test(lead)) return "ai";
  if (/defi|dex|lending|staking|ecosystem|생태계/.test(lead)) return "defi";
  if (/철학|philosophy|사상|book|책|worldview/.test(lead)) return "philosophy";
  if (/실험|experiment|미션|mission|커뮤니티에게/.test(lead)) return "interaction";
  if (/회고|reflection|실수|오판|failure|mistake/.test(lead)) return "reflection";
  if (/우화|fable|에세이|essay|비유|metaphor/.test(lead)) return "fable";
  if (/일지|정체성|identity|self narrative|자아/.test(lead)) return "identity";
  return "general";
}

function inferTextLanguage(text: string): "ko" | "en" {
  return /[ㄱ-ㅎ가-힣]/.test(text) ? "ko" : "en";
}

function containsActionSignal(text: string, language: "ko" | "en"): boolean {
  return language === "ko" ? KO_ACTION_PATTERN.test(text) : EN_ACTION_PATTERN.test(text);
}

function containsInvalidationSignal(text: string, language: "ko" | "en"): boolean {
  return language === "ko" ? KO_INVALIDATION_PATTERN.test(text) : EN_INVALIDATION_PATTERN.test(text);
}

function stableHash(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function isWithinHours(isoTimestamp: string, hours: number): boolean {
  const timestamp = new Date(isoTimestamp).getTime();
  if (!Number.isFinite(timestamp)) return false;
  return Date.now() - timestamp <= hours * 60 * 60 * 1000;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const floored = Math.floor(value);
  return Math.max(min, Math.min(max, floored));
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, value));
}

function normalizeNarrativeStructure(text: string): string {
  return sanitizeTweetText(text)
    .toLowerCase()
    .replace(/\$[a-z]{2,10}/g, " ticker ")
    .replace(/[+-]?\d+(?:\.\d+)?%/g, " pct ")
    .replace(/\d[\d,]*(?:\.\d+)?\s*(?:k|m|b|t|만|억|조)?/gi, " num ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractNarrativeMotifs(text: string): Set<string> {
  const lower = sanitizeTweetText(text).toLowerCase();
  const motifs: string[] = [];
  if (/fear|fgi|극공포|공포\s*지수/.test(lower)) motifs.push("sentiment-fear");
  if (/greed|탐욕/.test(lower)) motifs.push("sentiment-greed");
  if (/stablecoin|스테이블|유동성/.test(lower)) motifs.push("stable-flow");
  if (/고래|whale|대형\s*주소/.test(lower)) motifs.push("whale-flow");
  if (/거래소|exchange\s*flow|netflow|순유입|순유출/.test(lower)) motifs.push("exchange-flow");
  if (/\$btc|bitcoin|비트코인/.test(lower)) motifs.push("btc");
  if (/\$eth|ethereum|이더/.test(lower)) motifs.push("eth");
  if (/\$sol|solana|솔라나/.test(lower)) motifs.push("sol");
  if (/onchain|온체인|멤풀|수수료/.test(lower)) motifs.push("onchain");
  if (/괴리|비동기|엇갈/.test(lower)) motifs.push("divergence");
  if (/바닥|반등|데드캣|함정|불트랩|베어트랩/.test(lower)) motifs.push("turning-point");
  if (/\?$|일까|어떻게\s*봐|어떻게\s*읽/.test(lower)) motifs.push("question-ending");
  if (!/\?$|일까|어떻게\s*봐|어떻게\s*읽/.test(lower)) motifs.push("observation-ending");

  return new Set(motifs);
}

function motifSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  if (union <= 0) return 0;
  return intersection / union;
}

function buildSignalLane(text: string, motifsInput?: Set<string>): string | null {
  const motifs = motifsInput || extractNarrativeMotifs(text);
  if (motifs.size === 0) return null;
  const ordered = SIGNAL_LANE_PRIORITY.filter((key) => motifs.has(key)).slice(0, 4);
  if (ordered.length === 0) return null;
  if (ordered.length === 1 && (ordered[0] === "observation-ending" || ordered[0] === "question-ending")) {
    return null;
  }
  return ordered.join("|");
}

function inspectNumericProfile(text: string): {
  numberCount: number;
  percentCount: number;
  tickerCount: number;
  hardNoise: boolean;
} {
  const normalized = sanitizeTweetText(text);
  const numbers = normalized.match(/(?<![a-z])\d[\d,]*(?:\.\d+)?(?:\s?(?:k|m|b|t|천|만|억|조))?/gi) || [];
  const percents = normalized.match(/[+-]?\d+(?:\.\d+)?\s?%/g) || [];
  const tickers = normalized.match(/\$[a-z]{2,10}\b/gi) || [];
  const hardNoise = numbers.length >= 7 || percents.length >= 3 || tickers.length >= 5;
  return {
    numberCount: numbers.length,
    percentCount: percents.length,
    tickerCount: tickers.length,
    hardNoise,
  };
}

function normalizeRequiredTrendTokens(tokens: string[] | undefined): string[] {
  if (!Array.isArray(tokens)) return [];
  const normalized = tokens
    .map((token) => String(token || "").trim().toLowerCase())
    .filter((token) => token.length >= 2);
  return [...new Set(normalized)].slice(0, 8);
}

function containsAnyTrendToken(text: string, requiredTrendTokens: string[]): boolean {
  if (!requiredTrendTokens.length) return true;
  const normalizedText = sanitizeTweetText(text).toLowerCase();
  return requiredTrendTokens.some((token) => {
    if (normalizedText.includes(token)) return true;
    if (token.startsWith("$") && normalizedText.includes(token.slice(1))) return true;
    return false;
  });
}

function isCoreTopicTag(tag: string): boolean {
  return [
    "sentiment",
    "bitcoin",
    "ethereum",
    "regulation",
    "macro",
    "onchain",
    "ai",
    "defi",
  ].includes(String(tag || "").toLowerCase());
}

function detectSurfaceIssue(text: string, language: "ko" | "en"): string | null {
  const normalized = sanitizeTweetText(text);
  if (!normalized) return "빈 문장";
  if (!hasBalancedParentheses(normalized)) {
    return "괄호 짝 불일치";
  }
  if (/[0-9A-Za-z$]\([0-9A-Za-z$+-]/.test(normalized)) {
    return "비정상 숫자/괄호 결합";
  }
  if (/(\b(?:btc|eth|sol)\s*:\s*\$?0(?:\.0+)?\b)/i.test(normalized)) {
    return "비정상 시세 포맷";
  }
  if (/\b\d+(?:\.\d+)?\s*\([+-]?\d+(?:\.\d+)?\s*\([+-]?\d+/i.test(normalized)) {
    return "수치 포맷 손상";
  }
  if (language === "ko") {
    const hangulCount = (normalized.match(/[가-힣]/g) || []).length;
    const spaceCount = (normalized.match(/\s/g) || []).length;
    if (hangulCount >= 36 && spaceCount <= 1) {
      return "띄어쓰기 이상";
    }
  }
  return null;
}

function hasBalancedParentheses(text: string): boolean {
  let balance = 0;
  for (const ch of text) {
    if (ch === "(") balance += 1;
    if (ch === ")") balance -= 1;
    if (balance < 0) return false;
  }
  return balance === 0;
}

function detectLexicalRepetition(text: string, language: "ko" | "en"): string | null {
  const normalized = sanitizeTweetText(text).toLowerCase();
  if (!normalized) return null;
  const tokens = normalized
    .split(/\s+/)
    .map((token) => token.replace(/[^\p{L}\p{N}$]/gu, ""))
    .filter((token) => token.length >= 2);

  if (tokens.length < 8) return null;
  const stopwords =
    language === "ko"
      ? new Set(["그리고", "하지만", "그래서", "지금", "오늘", "먼저", "우선", "정말", "아직", "이건", "그건", "하는", "이다", "같다"])
      : new Set(["this", "that", "with", "from", "into", "then", "when", "over", "just", "very"]);

  const counts = new Map<string, number>();
  for (const token of tokens) {
    if (stopwords.has(token)) continue;
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  let topWord = "";
  let topCount = 0;
  for (const [word, count] of counts.entries()) {
    if (count > topCount) {
      topWord = word;
      topCount = count;
    }
  }
  if (topCount >= 4) {
    return topWord || "same-word";
  }
  return null;
}
