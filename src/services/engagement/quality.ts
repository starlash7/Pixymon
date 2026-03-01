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

const TEMPLATE_TOKEN_STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "into",
  "after",
  "today",
  "market",
  "crypto",
  "token",
  "price",
  "signal",
  "context",
  "data",
  "flow",
  "coin",
  "coins",
  "오늘",
  "시장",
  "데이터",
  "흐름",
  "신호",
  "코인",
  "그리고",
  "하지만",
  "지금",
  "구간",
]);

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
  return text.replace(/\s+/g, " ").replace(/[“”]/g, "\"").trim();
}

export function evaluateReplyQuality(
  text: string,
  marketData: MarketData[],
  recentReplyTexts: string[],
  policy: AdaptivePolicy
): ContentQualityCheck {
  const marketConsistency = validateMarketConsistency(text, marketData);
  if (!marketConsistency.ok) {
    return { ok: false, reason: marketConsistency.reason || "시장 숫자 불일치" };
  }

  const duplicate = memory.checkDuplicate(text, policy.replyDuplicateThreshold);
  if (duplicate.isDuplicate) {
    return { ok: false, reason: "기존 발화와 과도하게 유사" };
  }

  const narrativeDup = findNarrativeDuplicate(text, recentReplyTexts, policy.replyNarrativeThreshold);
  if (narrativeDup.isDuplicate) {
    return {
      ok: false,
      reason: `최근 댓글과 내러티브 중복(sim=${narrativeDup.similarity})`,
    };
  }

  if (isTemplateDuplicate(text, recentReplyTexts, 0.74, 18)) {
    return { ok: false, reason: "최근 댓글 템플릿 반복" };
  }

  const recentTags = recentReplyTexts.slice(-8).map((item) => inferTopicTag(item));
  const candidateTag = inferTopicTag(text);
  if (recentTags.length >= 2) {
    const lastTag = recentTags[recentTags.length - 1];
    const prevTag = recentTags[recentTags.length - 2];
    if (lastTag === candidateTag && prevTag === candidateTag) {
      return { ok: false, reason: `댓글 주제 연속 반복(${candidateTag})` };
    }
  }

  const sameTagCount = recentTags.filter((tag) => tag === candidateTag).length;
  if (sameTagCount >= 4) {
    return { ok: false, reason: `댓글 주제 편중(${candidateTag})` };
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
  if (!text || text.length < rules.minPostLength) {
    return { ok: false, reason: "문장이 너무 짧음" };
  }

  const recentPostTexts = recentPosts.map((post) => post.content);
  const marketConsistency = validateMarketConsistency(text, marketData);
  if (!marketConsistency.ok) {
    return { ok: false, reason: marketConsistency.reason || "시장 숫자 불일치" };
  }

  const duplicate = memory.checkDuplicate(text, policy.postDuplicateThreshold);
  if (duplicate.isDuplicate) {
    return { ok: false, reason: "기존 트윗과 의미 중복" };
  }

  const narrativeDup = findNarrativeDuplicate(text, recentPostTexts, policy.postNarrativeThreshold);
  if (narrativeDup.isDuplicate) {
    return {
      ok: false,
      reason: `최근 포스트와 내러티브 중복(sim=${narrativeDup.similarity})`,
    };
  }
  if (isTemplateDuplicate(text, recentPostTexts, 0.7, 22)) {
    return { ok: false, reason: "최근 포스트 템플릿 반복" };
  }
  const candidateMotifs = extractNarrativeMotifs(text);
  if (candidateMotifs.size >= 3) {
    const motifDup = recentPostTexts
      .slice(-16)
      .some((item) => motifSimilarity(candidateMotifs, extractNarrativeMotifs(item)) >= 0.7);
    if (motifDup) {
      return { ok: false, reason: "핵심 서사 모티프 반복" };
    }
  }
  const recentWithin24 = recentPosts.filter((post) => isWithinHours(post.timestamp, 24));
  const candidateLane = buildSignalLane(text, candidateMotifs);
  if (candidateLane && recentWithin24.length > 0) {
    const sameLaneCount = recentWithin24.filter((post) => {
      const lane = buildSignalLane(post.content);
      return lane && lane === candidateLane;
    }).length;
    if (sameLaneCount >= 1) {
      return { ok: false, reason: `동일 시그널 레인 반복(${candidateLane})` };
    }
  }
  const candidatePrimaryLane = buildPrimarySignalLane(text, candidateMotifs);
  if (candidatePrimaryLane && recentWithin24.length > 0) {
    const samePrimaryLaneCount = recentWithin24.filter((post) => {
      const lane = buildPrimarySignalLane(post.content);
      return lane && lane === candidatePrimaryLane;
    }).length;
    if (samePrimaryLaneCount >= 2) {
      return { ok: false, reason: `동일 시그널 축 반복(${candidatePrimaryLane})` };
    }
  }

  const normalized = sanitizeTweetText(text).slice(0, 24);
  if (normalized && recentPostTexts.some((item) => sanitizeTweetText(item).slice(0, 24) === normalized)) {
    return { ok: false, reason: "문장 시작 패턴 중복" };
  }
  const recentStructures = recentPostTexts.slice(-20).map((item) => normalizeNarrativeStructure(item));
  const candidateStructure = normalizeNarrativeStructure(text);
  if (candidateStructure) {
    const prefix = candidateStructure.slice(0, 34);
    if (prefix && recentStructures.some((item) => item.slice(0, 34) === prefix)) {
      return { ok: false, reason: "서두 구조 반복" };
    }
    const suffix = candidateStructure.slice(-32);
    if (suffix.length >= 16 && recentStructures.some((item) => item.slice(-32) === suffix)) {
      return { ok: false, reason: "마무리 패턴 반복" };
    }
  }

  if (recentWithin24.length > 0) {
    const candidateTag = inferTopicTag(text);
    const recentTags = recentWithin24.map((post) => inferTopicTag(post.content));
    const lastTag = recentTags[recentTags.length - 1];
    if (rules.topicBlockConsecutiveTag && lastTag === candidateTag) {
      return { ok: false, reason: `주제 다양성 부족(${candidateTag} 연속)` };
    }
    const sameTagCount = recentTags.filter((tag) => tag === candidateTag).length;
    if (sameTagCount >= rules.topicMaxSameTag24h) {
      return { ok: false, reason: `24h 내 동일 주제 과밀(${candidateTag})` };
    }
    if (candidateTag === "sentiment") {
      const projectedRatio = (sameTagCount + 1) / Math.max(1, recentWithin24.length + 1);
      if (projectedRatio > rules.sentimentMaxRatio24h) {
        return { ok: false, reason: `sentiment 비중 초과(${Math.round(projectedRatio * 100)}%)` };
      }
    }
  }

  if (recentWithin24.length >= 4) {
    const btcRatio = computeBtcCentricRatio(recentWithin24.map((post) => post.content));
    if (btcRatio >= 0.6 && isBtcCentricText(text) && !hasNonBtcSignal(text)) {
      return { ok: false, reason: `BTC 편중 완화 필요(${Math.round(btcRatio * 100)}%)` };
    }
  }

  const requiredTrendTokens = normalizeRequiredTrendTokens(context.requiredTrendTokens);
  if (requiredTrendTokens.length > 0 && !containsAnyTrendToken(text, requiredTrendTokens)) {
    return { ok: false, reason: "트렌드 포커스 키워드 미반영" };
  }
  if (context.fearGreedEvent?.required) {
    const candidateTag = inferTopicTag(text);
    if (candidateTag === "sentiment" && !context.fearGreedEvent.isEvent) {
      return { ok: false, reason: "FGI 이벤트 없음(sentiment 서사 제한)" };
    }
  }

  return { ok: true };
}

export function inferTopicTag(text: string): string {
  const lower = text.toLowerCase();
  if (/fear|greed|fgi|극공포|공포\s*지수|탐욕\s*지수/.test(lower)) return "sentiment";
  if (/\$btc|bitcoin|비트코인/.test(lower)) return "bitcoin";
  if (/\$eth|ethereum|이더/.test(lower)) return "ethereum";
  if (/fomc|fed|macro|금리|inflation|dxy/.test(lower)) return "macro";
  if (/onchain|멤풀|수수료|고래|stable|유동성|tvl/.test(lower)) return "onchain";
  if (/layer2|rollup|업그레이드|mainnet|testnet/.test(lower)) return "tech";
  if (/ai|agent|inference/.test(lower)) return "ai";
  if (/defi|dex|lending|staking/.test(lower)) return "defi";
  return "general";
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
  if (/stable|스테이블|유동성/.test(lower)) motifs.push("stable-flow");
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
  return ordered.join("|");
}

function buildPrimarySignalLane(text: string, motifsInput?: Set<string>): string | null {
  const motifs = motifsInput || extractNarrativeMotifs(text);
  if (motifs.size === 0) return null;
  const ordered = SIGNAL_LANE_PRIORITY.filter((key) => motifs.has(key)).slice(0, 2);
  if (ordered.length === 0) return null;
  return ordered.join("|");
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

function isTemplateDuplicate(
  text: string,
  recentTexts: string[],
  threshold: number,
  windowSize: number
): boolean {
  const candidate = buildTemplateFingerprint(text);
  if (candidate.length < 4) return false;

  return recentTexts
    .slice(-Math.max(4, windowSize))
    .some((item) => templateSimilarity(candidate, buildTemplateFingerprint(item)) >= threshold);
}

function buildTemplateFingerprint(text: string): string[] {
  const normalized = normalizeNarrativeStructure(text)
    .replace(/\b(ticker|pct|num)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return [];
  const tokens = normalized
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .filter((token) => !TEMPLATE_TOKEN_STOP_WORDS.has(token));
  return [...new Set(tokens)].slice(0, 20);
}

function templateSimilarity(aTokens: string[], bTokens: string[]): number {
  if (aTokens.length === 0 || bTokens.length === 0) return 0;
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  if (union <= 0) return 0;
  return intersection / union;
}

function isBtcCentricText(text: string): boolean {
  const lower = sanitizeTweetText(text).toLowerCase();
  return /(^|\s)(\$?btc|bitcoin|비트코인)(\s|$)|fear\s*greed|fgi|공포\s*지수|극공포/.test(lower);
}

function hasNonBtcSignal(text: string): boolean {
  const lower = sanitizeTweetText(text).toLowerCase();
  return /(\$?eth|ethereum|이더|solana|\$?sol|sec|etf|fomc|fed|layer2|rollup|defi|dex|regulation|규제|macro|매크로)/.test(
    lower
  );
}

function computeBtcCentricRatio(texts: string[]): number {
  if (texts.length === 0) return 0;
  const btcCount = texts.filter((item) => isBtcCentricText(item)).length;
  return btcCount / texts.length;
}
