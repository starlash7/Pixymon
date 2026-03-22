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
  "protocol-flow",
  "ecosystem-flow",
  "regulation-flow",
  "macro-flow",
  "microstructure-flow",
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
const KO_ACTION_PATTERN =
  /(확인|점검|검증|추적|해석|비교|대조|체크|기록|모니터링|검토|살핀|지켜본|짚어?\s*본|가려내|가른다|맞춰\s*본|부터\s*본|보겠|보고\s|다시\s*본|교차\s*검토|교차\s*확인)/;
const EN_ACTION_PATTERN = /\b(check|verify|track|monitor|observe|test|compare|review)\b/i;
const KO_INVALIDATION_PATTERN =
  /(반증|틀리|무효|기각|버리|수정|철회|바꾸|바꾼|뒤집|내려놓|폐기|보류|종료|교체|무너지|닫지\s*않|갈아엎|놓아주|미루|돌아가|다시\s*읽|접는다|접게|늦춘다|멈춘다|효력을\s*잃|가설[^.!?]{0,12}접|깨지면|조건\s*이?\s*깨지|않으면|아니라면|반대\s*(?:신호|증거)|딴소리)/;
const EN_INVALIDATION_PATTERN =
  /\b(falsif|invalidate|wrong if|drop this thesis|revise this thesis|if .*?(?:fails|breaks)|opposite evidence)\b/i;

const KO_ACTION_INVALIDATION_BRIDGES = [
  "지금은 두 근거가 실제로 이어지는지 확인한다. 하나라도 무너지면 이 판단은 접는다.",
  "확신보다 검증이 먼저다. 반대 근거가 더 오래 버티면 이 해석은 수정한다.",
  "먼저 남는 근거가 무엇인지 본다. 조건이 깨지면 이 결론은 보류한다.",
  "지금은 순서보다 연결을 본다. 둘이 다른 방향으로 가면 이 읽기는 버린다.",
  "말보다 행동을 먼저 확인한다. 행동이 붙지 않으면 오늘 해석은 미룬다.",
];
const KO_ACTION_INVALIDATION_BRIDGES_SHORT = [
  "엇갈리면 이 해석은 접는다.",
  "전제가 깨지면 판단을 보류한다.",
  "근거가 갈리면 다시 쓴다.",
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
const PIXYMON_CONCEPT_SIGNAL =
  /(픽시몬|pixymon|온체인\s*데이터를?\s*먹|영양소|소화|진화|레벨업|레벨\s*\d|사이클\s*먹|먹은\s*단서|먹은\s*걸로\s*치지\s*않|먹지\s*않|먹기엔|먹을\s*단서|채집한\s*단서|체인\s*로그를?\s*소화|주워\s*온\s*(?:단서|건)|건진\s*단서|덜\s*소화된\s*신호|내\s*장부|장부에\s*남긴다|장부에\s*넣지\s*않는다|장부에\s*올리지\s*않는다|근거로\s*남긴다|근거가\s*된다|단서로\s*취급한다|진화에\s*쓸\s*단서|바로\s*먹을\s*만한|삼키지\s*않|삼키기엔|쉽게\s*삼켜지|한입에\s*설명|한\s*번\s*더\s*(?:씹|의심)|천천히\s*소화|입에\s*(?:넣|걸린)|허기|사냥|냄새가\s*남|오래\s*남는\s*흔적|끝까지\s*남는\s*근거|버틴\s*(?:흔적|근거|숫자)|하루를\s*(?:버틴|넘긴)\s*신호|반짝이는\s*서사보다|오늘\s*단서로\s*남긴|바로\s*믿기엔\s*이르|쉽게\s*믿지\s*않는다|서두르지\s*않는다|늦게\s*틀리는\s*편이\s*낫)/i;
const LEAD_ISSUE_DOMAIN_TOKEN_KO =
  /(프로토콜|업그레이드|검증자|거버넌스|생태계|커뮤니티|실사용|사용자|규제|정책|컴플라이언스|온체인|체인|지갑|거래소|유동성|호가|호가창|주문|체결|멤풀|고래|스테이블|달러|금리|위험선호|거시|매크로|ETF|롤업|L2|디파이|크립토|블록체인|BTC|ETH|SOL|XRP)/i;
const LEAD_ISSUE_DOMAIN_TOKEN_EN =
  /(protocol|upgrade|validator|governance|ecosystem|community|usage|user|regulation|policy|compliance|onchain|chain|wallet|exchange|liquidity|orderbook|orders|execution|mempool|whale|stable|dollar|rates|risk appetite|macro|etf|rollup|layer2|defi|crypto|blockchain|btc|eth|sol|xrp)/i;
const LEAD_ISSUE_VAGUE_PREFIX =
  /^(?:나는|I\s+am|I\s+feel|오늘은|today|이번엔|this\s+time|지금은)\s+(?:그냥|그저|일단|먼저)\b/i;
const LEAD_ISSUE_MARKER_KO = /(핵심|이슈|쟁점|장면|문제|사건|변화|논점|포인트)/;
const LEAD_ISSUE_MARKER_EN = /(issue|core|scene|problem|event|shift|point|focus)/i;

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
    .replace(/\)\s+(다[.!?]?)/g, ")$1")
    .replace(/\)\s*\(/g, ") (")
    .replace(/([0-9A-Za-z$])\(/g, "$1 (")
    .replace(/\s*[|]\s*/g, " | ")
    .replace(/\s*·\s*/g, " · ")
    .replace(/\s{2,}/g, " ");

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
  if (context.requireLeadIssueClarity) {
    const leadIssue = validateLeadIssueClarity(normalizedText, language);
    if (!leadIssue.ok) {
      return { ok: false, reason: leadIssue.reason };
    }
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
    if (sameLaneCount >= 3) {
      return { ok: false, reason: `동일 시그널 레인 반복(${candidateLane})` };
    }
  }

  const normalized = sanitizeTweetText(normalizedText).slice(0, 24);
  if (normalized && recentPostTexts.slice(-12).some((item) => sanitizeTweetText(item).slice(0, 24) === normalized)) {
    return { ok: false, reason: "문장 시작 패턴 중복" };
  }
  const recentStructures = recentPostTexts.slice(-14).map((item) => normalizeNarrativeStructure(item));
  const candidateStructure = normalizeNarrativeStructure(normalizedText);
  if (candidateStructure) {
    const prefix = candidateStructure.slice(0, 34);
    const samePrefixCount = prefix ? recentStructures.filter((item) => item.slice(0, 34) === prefix).length : 0;
    if (samePrefixCount >= 3) {
      return { ok: false, reason: "서두 구조 반복" };
    }
    const suffix = candidateStructure.slice(-32);
    const sameSuffixCount = suffix.length >= 16 ? recentStructures.filter((item) => item.slice(-32) === suffix).length : 0;
    if (sameSuffixCount >= 2) {
      return { ok: false, reason: "마무리 패턴 반복" };
    }
  }

  if (recentWithin24.length > 0) {
    const candidateTag = inferTopicTag(normalizedText);
    const recentTags = recentWithin24.map((post) => inferTopicTag(post.content));
    const lastTag = recentTags[recentTags.length - 1];
    const modeShiftAllowed =
      context.allowTopicRepeatOnModeShift === true &&
      typeof context.narrativeMode === "string" &&
      typeof context.previousNarrativeMode === "string" &&
      context.narrativeMode.length > 0 &&
      context.previousNarrativeMode.length > 0 &&
      context.narrativeMode !== context.previousNarrativeMode;

    if (rules.topicBlockConsecutiveTag && lastTag === candidateTag && !modeShiftAllowed) {
      return { ok: false, reason: `주제 다양성 부족(${candidateTag} 연속)` };
    }
    const sameTagCount = recentTags.filter((tag) => tag === candidateTag).length;
    const tagAllowance = rules.topicMaxSameTag24h + (modeShiftAllowed ? 1 : 0);
    if (sameTagCount >= tagAllowance) {
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
  if (context.requirePixymonConceptSignal && !containsPixymonConceptSignal(normalizedText)) {
    return { ok: false, reason: "픽시몬 컨셉 신호 부족(먹기/소화/진화)" };
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
  const leadWindow =
    sanitizeTweetText(lower)
      .split(/[.!?]/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(0, 2)
      .join(" ") || lower;
  const lead = leadWindow.slice(0, 190);
  if (/fear|greed|fgi|극공포|공포\s*지수|탐욕\s*지수/.test(lead)) return "sentiment";
  if (/시장구조|market[-\s]?structure|오더북|호가|슬리피지|체결|basis|funding|미결제|oi\b/.test(lead)) return "market-structure";
  if (/프로토콜|protocol|거버넌스|검증자|업그레이드|rollup|layer2|l2|eip|bip/.test(lead)) return "protocol";
  if (/실험|experiment|미션|mission|커뮤니티에게/.test(lead)) return "interaction";
  if (/회고|reflection|실수|오판|failure|mistake/.test(lead)) return "reflection";
  if (/우화|fable|에세이|essay|비유|metaphor/.test(lead)) return "fable";
  if (/일지|정체성|identity|self narrative|자아/.test(lead)) return "identity";
  if (/생태계|ecosystem|커뮤니티|코호트|retention|tvl|dapp|airdrop|staking|dex|lending|defi/.test(lead)) return "ecosystem";
  if (/\$btc|bitcoin|비트코인/.test(lead)) return "bitcoin";
  if (/\$eth|ethereum|이더/.test(lead)) return "ethereum";
  if (/규제|regulation|policy|compliance|sec|cftc|법안|당국/.test(lead)) return "regulation";
  if (/fomc|fed|macro|금리|inflation|dxy/.test(lead)) return "macro";
  if (/onchain|멤풀|수수료|고래|stablecoin|스테이블|유동성|tvl/.test(lead)) return "onchain";
  if (/layer2|rollup|업그레이드|mainnet|testnet|protocol/.test(lead)) return "protocol";
  if (/ai|agent|inference/.test(lead)) return "ai";
  if (/철학|philosophy|사상|book|책|worldview/.test(lead)) return "philosophy";
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
  if (/프로토콜|protocol|거버넌스|검증자|업그레이드|eip|bip|rollup|layer2|l2/.test(lower)) {
    motifs.push("protocol-flow");
  }
  if (/생태계|ecosystem|커뮤니티|코호트|리텐션|tvl|dapp|defi|dex|lending|staking|airdrop/.test(lower)) {
    motifs.push("ecosystem-flow");
  }
  if (/규제|regulation|policy|compliance|sec|cftc|법안|당국/.test(lower)) {
    motifs.push("regulation-flow");
  }
  if (/매크로|macro|금리|fed|fomc|dxy|달러|cpi|인플레이션/.test(lower)) {
    motifs.push("macro-flow");
  }
  if (/시장구조|market[-\s]?structure|오더북|호가|슬리피지|체결|basis|funding|미결제|oi\b/.test(lower)) {
    motifs.push("microstructure-flow");
  }
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
  const endingLaneSet = new Set(["question-ending", "observation-ending"]);
  let ordered = SIGNAL_LANE_PRIORITY.filter((key) => motifs.has(key)).slice(0, 4);
  const nonEnding = ordered.filter((key) => !endingLaneSet.has(key));
  if (nonEnding.length > 0) {
    ordered = nonEnding.slice(0, 3);
  }
  if (ordered.length === 0) return null;
  if (ordered.length === 1 && endingLaneSet.has(ordered[0])) {
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

function expandRequiredTrendTokenAliases(token: string): string[] {
  const normalized = sanitizeTweetText(token).toLowerCase();
  if (!normalized) return [];
  const aliases = new Set<string>([normalized]);
  const groups: Array<[RegExp, string[]]> = [
    [/(regulation|policy|compliance|sec|cftc|court|lawsuit)/, ["규제", "정책", "당국", "집행", "법원", "컴플라이언스"]],
    [/(protocol|upgrade|validator|consensus|mainnet|testnet|rollup|firedancer)/, ["프로토콜", "업그레이드", "검증자", "합의", "메인넷", "테스트넷"]],
    [/(ecosystem|wallet|usage|user|community|developer|adoption|app)/, ["생태계", "지갑", "사용", "사용자", "커뮤니티", "개발자", "실사용"]],
    [/(macro|rates|inflation|dollar|usd|eur|dxy|cpi|fed|ecb)/, ["매크로", "금리", "물가", "달러", "환율", "거시"]],
    [/(onchain|chain|stable|whale|mempool|address|flow|tvl)/, ["온체인", "체인", "스테이블", "고래", "멤풀", "주소", "자금"]],
    [/(exchange|liquidity|orderbook|execution|volume)/, ["거래소", "유동성", "체결", "주문", "거래량"]],
  ];
  for (const [pattern, mapped] of groups) {
    if (pattern.test(normalized)) {
      mapped.forEach((item) => aliases.add(item));
    }
  }
  if (normalized.startsWith("$")) aliases.add(normalized.slice(1));
  return [...aliases];
}

function containsAnyTrendToken(text: string, requiredTrendTokens: string[]): boolean {
  if (!requiredTrendTokens.length) return true;
  const normalizedText = sanitizeTweetText(text).toLowerCase();
  return requiredTrendTokens.some((token) => {
    return expandRequiredTrendTokenAliases(token).some((alias) => normalizedText.includes(alias));
  });
}

function detectSurfaceIssue(text: string, language: "ko" | "en"): string | null {
  const normalized = sanitizeTweetText(text);
  if (!normalized) return "빈 문장";
  if (/(?:관찰축|핵심어|서사축|패턴\s*태그)\s*[:：(]/i.test(normalized)) {
    return "내부 편집 태그 노출";
  }
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

function validateLeadIssueClarity(
  text: string,
  language: "ko" | "en"
): { ok: true } | { ok: false; reason: string } {
  const normalized = sanitizeTweetText(text);
  const sentenceParts = normalized
    .split(/(?<=[.!?])/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 1);
  const firstSentence = sentenceParts[0] || normalized;
  const leadWindow = sentenceParts.slice(0, 2).join(" ");
  if (firstSentence.length < 12) {
    return { ok: false, reason: "첫 문장 핵심 이슈가 너무 짧음" };
  }
  if (LEAD_ISSUE_VAGUE_PREFIX.test(firstSentence)) {
    return { ok: false, reason: "첫 문장이 모호함(핵심 이슈 불명확)" };
  }
  if (language === "ko" && !LEAD_ISSUE_DOMAIN_TOKEN_KO.test(firstSentence)) {
    const hasMarker = LEAD_ISSUE_MARKER_KO.test(firstSentence);
    const leadWindowAnchored = LEAD_ISSUE_DOMAIN_TOKEN_KO.test(leadWindow);
    const firstSceneAnchored =
      firstSentence.length >= 16 &&
      /(다|한다|된다|보인다|남는다|걸린다|멈춘다|붙는다|시작한다|궁금하다|읽는다|돌아온다|살핀다|본다)$/.test(
        firstSentence.replace(/[.!?]+$/g, "").trim()
      );
    if (!(leadWindowAnchored && (hasMarker || firstSceneAnchored))) {
      return { ok: false, reason: "첫 문장에 크립토 맥락 이슈가 없음" };
    }
  }
  if (language === "en" && !LEAD_ISSUE_DOMAIN_TOKEN_EN.test(firstSentence)) {
    const hasMarker = LEAD_ISSUE_MARKER_EN.test(firstSentence);
    const leadWindowAnchored = LEAD_ISSUE_DOMAIN_TOKEN_EN.test(leadWindow);
    const firstSceneAnchored = firstSentence.length >= 16;
    if (!(leadWindowAnchored && (hasMarker || firstSceneAnchored))) {
      return { ok: false, reason: "Lead sentence missing crypto issue anchor" };
    }
  }
  return { ok: true };
}

function containsPixymonConceptSignal(text: string): boolean {
  return PIXYMON_CONCEPT_SIGNAL.test(sanitizeTweetText(text));
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
