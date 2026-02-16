import { MarketData } from "./blockchain-news.js";

interface TrendMetrics {
  like_count?: number;
  retweet_count?: number;
  reply_count?: number;
  quote_count?: number;
}

interface TrendAuthorMeta {
  followers_count?: number;
  verified?: boolean;
}

export interface TrendCandidateEvaluation {
  score: number;
  engagementRaw: number;
  isLowSignal: boolean;
}

export interface MarketConsistencyResult {
  ok: boolean;
  reason?: string;
}

const SPAM_PATTERNS = [
  /join my community/i,
  /private group/i,
  /vip group/i,
  /copy trade/i,
  /dm (me|for)/i,
  /giveaway/i,
  /airdrop/i,
  /presale/i,
  /\bca\s*:/i,
  /contract address/i,
];

const TECH_KEYWORDS = [
  "layer2",
  "rollup",
  "mainnet",
  "testnet",
  "upgrade",
  "validator",
  "staking",
  "mempool",
  "onchain",
  "liquidity",
  "tvl",
  "gas",
  "etf",
  "funding",
  "open interest",
  "zk",
  "ai",
  "agent",
  "macro",
  "fed",
  "fomc",
  "rates",
  "금리",
  "업그레이드",
  "메인넷",
  "유동성",
  "온체인",
];

const MEME_NOISE_KEYWORDS = [
  "100x",
  "moon",
  "degen",
  "gem",
  "pump",
  "lfg",
  "wen",
  "memecoin",
  "shitcoin",
];

export function evaluateTrendCandidate(input: {
  text: string;
  keywordHints: string[];
  metrics?: TrendMetrics;
  author?: TrendAuthorMeta;
}): TrendCandidateEvaluation {
  const text = String(input.text || "").trim();
  const lowered = text.toLowerCase();
  const metrics = input.metrics || {};

  const likes = clampSafeInt(metrics.like_count);
  const retweets = clampSafeInt(metrics.retweet_count);
  const replies = clampSafeInt(metrics.reply_count);
  const quotes = clampSafeInt(metrics.quote_count);

  const engagementRaw = likes + retweets * 2 + replies * 2 + quotes * 3;
  const engagementScore = Math.log1p(engagementRaw);

  const keywordHits = countKeywordHits(lowered, input.keywordHints.map((item) => item.toLowerCase()));
  const techHits = countKeywordHits(lowered, TECH_KEYWORDS);
  const memeHits = countKeywordHits(lowered, MEME_NOISE_KEYWORDS);
  const cashtagCount = (text.match(/\$[A-Za-z]{2,10}/g) || []).length;
  const urlCount = (text.match(/https?:\/\//gi) || []).length;

  const followers = clampSafeInt(input.author?.followers_count);
  const followerScore = Math.log10(followers + 10);
  const verifiedBoost = input.author?.verified ? 0.8 : 0;

  const spamLike = SPAM_PATTERNS.some((pattern) => pattern.test(text));
  const lowSignalByStructure =
    text.length < 35 ||
    cashtagCount >= 5 ||
    (urlCount >= 2 && techHits === 0);

  const score =
    engagementScore * 2.8 +
    followerScore +
    verifiedBoost +
    keywordHits * 0.25 +
    techHits * 0.55 -
    memeHits * 0.45 -
    Math.max(0, cashtagCount - 2) * 0.5 -
    (urlCount >= 2 ? 0.8 : 0);

  return {
    score: Math.round(score * 100) / 100,
    engagementRaw,
    isLowSignal: spamLike || lowSignalByStructure,
  };
}

export function validateMarketConsistency(text: string, marketData: MarketData[]): MarketConsistencyResult {
  const btc = marketData.find((coin) => coin.symbol.toUpperCase() === "BTC");
  if (!btc || !Number.isFinite(btc.price) || btc.price <= 0) {
    return { ok: true };
  }

  const btcClaims = extractBtcPriceClaimsUsd(text);
  if (btcClaims.length === 0) {
    return { ok: true };
  }

  const btcPrice = btc.price;
  const hard100kClaim = /(?:10\s*만|100\s*k|100,?000)/i.test(text) && /(?:\$?btc|비트코인)/i.test(text);
  if (hard100kClaim && btcPrice < 90000) {
    return {
      ok: false,
      reason: `BTC 실시간 가격(${formatUsdRounded(btcPrice)})과 100K 서술이 불일치`,
    };
  }

  for (const claim of btcClaims) {
    const diffRatio = Math.abs(claim - btcPrice) / btcPrice;
    if (diffRatio > 0.15) {
      return {
        ok: false,
        reason: `BTC 가격 주장(${formatUsdRounded(claim)})이 실시간 가격(${formatUsdRounded(btcPrice)})과 오차 과다`,
      };
    }
  }

  return { ok: true };
}

export function findNarrativeDuplicate(
  candidate: string,
  recentTexts: string[],
  threshold: number = 0.7
): { isDuplicate: boolean; similarity: number; matchedText?: string } {
  const candidateWords = narrativeWords(candidate);
  if (candidateWords.size === 0) {
    return { isDuplicate: false, similarity: 0 };
  }

  let best = 0;
  let bestText: string | undefined;

  for (const text of recentTexts) {
    const existingWords = narrativeWords(text);
    if (existingWords.size === 0) continue;
    const similarity = jaccard(candidateWords, existingWords);
    if (similarity > best) {
      best = similarity;
      bestText = text;
    }
  }

  return {
    isDuplicate: best >= threshold,
    similarity: Math.round(best * 100) / 100,
    matchedText: bestText,
  };
}

function extractBtcPriceClaimsUsd(text: string): number[] {
  if (!/(?:\$?btc|비트코인)/i.test(text)) {
    return [];
  }

  const claims: number[] = [];
  const anchoredDirectPattern = /(?:\$?btc|비트코인)\s*[:=]?\s*(\$?\s*\d[\d,]*(?:\.\d+)?\s*(?:k|K|만)?)/gi;
  const pricePhrasePattern = /(?:가격|price|at|around|근처|선)\s*(\$?\s*\d[\d,]*(?:\.\d+)?\s*(?:k|K|만)?)/gi;
  const standaloneKoreanPattern = /(\d+(?:\.\d+)?)\s*만(?=\s*(?:불|달러|usd|선|대|돌파|근처))/gi;
  const standaloneKPattern = /(\d+(?:\.\d+)?)\s*[kK](?=\s*(?:usd|달러|불|선|대|돌파|근처|resistance|support))/g;

  collectMatches(anchoredDirectPattern, text, (raw) => {
    const parsed = parseUsdToken(raw);
    if (parsed) claims.push(parsed);
  });

  collectMatches(pricePhrasePattern, text, (raw) => {
    const parsed = parseUsdToken(raw);
    if (parsed) claims.push(parsed);
  });

  collectMatches(standaloneKoreanPattern, text, (raw) => {
    const parsed = parseUsdToken(`${raw}만`);
    if (parsed) claims.push(parsed);
  });

  collectMatches(standaloneKPattern, text, (raw) => {
    const parsed = parseUsdToken(`${raw}k`);
    if (parsed) claims.push(parsed);
  });

  return [...new Set(claims.map((value) => Math.round(value)))].filter((value) => value >= 20000 && value <= 300000);
}

function collectMatches(pattern: RegExp, text: string, onMatch: (value: string) => void): void {
  for (const match of text.matchAll(pattern)) {
    const value = match[1] || match[0];
    if (value) onMatch(String(value));
  }
}

function parseUsdToken(raw: string): number | null {
  const normalized = raw
    .toLowerCase()
    .replace(/\$/g, "")
    .replace(/usd|달러|불|선|대|돌파|근처/g, "")
    .replace(/\s+/g, "")
    .trim();

  if (!normalized) return null;

  if (normalized.endsWith("만")) {
    const value = Number.parseFloat(normalized.replace(/만/g, ""));
    return Number.isFinite(value) ? value * 10000 : null;
  }

  if (normalized.endsWith("k")) {
    const value = Number.parseFloat(normalized.slice(0, -1));
    return Number.isFinite(value) ? value * 1000 : null;
  }

  const value = Number.parseFloat(normalized.replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;
  return value;
}

function narrativeWords(text: string): Set<string> {
  const normalized = normalizeNarrativeText(text);
  if (!normalized) return new Set<string>();
  const words = normalized
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);
  return new Set(words);
}

function normalizeNarrativeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/@\w+/g, " ")
    .replace(/\$[a-z]{2,10}/g, " ticker ")
    .replace(/[+-]?\d+(?:\.\d+)?%/g, " pct ")
    .replace(/\d[\d,]*(?:\.\d+)?\s*(?:k|m|b|t|만|억|조)?/gi, " num ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function countKeywordHits(text: string, keywords: string[]): number {
  let count = 0;
  for (const keyword of keywords) {
    if (!keyword) continue;
    if (text.includes(keyword)) count += 1;
  }
  return count;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  if (union <= 0) return 0;
  return intersection / union;
}

function clampSafeInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

function formatUsdRounded(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}
