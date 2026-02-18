import { BlockchainNewsService, MarketData } from "../blockchain-news.js";
import { memory } from "../memory.js";
import { inferTopicTag, sanitizeTweetText } from "./quality.js";
import { RecentPostRecord, TrendContext, TrendContextOptions, TrendFocus } from "./types.js";

const FOCUS_TOKEN_STOP_WORDS = new Set([
  "today",
  "crypto",
  "market",
  "markets",
  "news",
  "update",
  "analysis",
  "price",
  "prices",
  "token",
  "blockchain",
  "coin",
  "coins",
  "트렌딩",
  "시장",
  "뉴스",
  "업데이트",
  "분석",
  "코인",
  "토큰",
  "btc",
  "bitcoin",
  "eth",
  "ethereum",
  "sol",
  "solana",
  "fear",
  "greed",
  "fgi",
  "공포",
  "탐욕",
  "지수",
  "온체인",
  "유동성",
  "스테이블",
  "고래",
  "수수료",
]);

export async function collectTrendContext(options: Partial<TrendContextOptions> = {}): Promise<TrendContext> {
  const newsService = new BlockchainNewsService();
  const minNewsSourceTrust = clampNumber(options.minNewsSourceTrust, 0.05, 0.9, 0.28);
  const [hotNews, cryptoNews, marketData] = await Promise.all([
    newsService.getTodayHotNews(),
    newsService.getCryptoNews(10),
    newsService.getMarketData(),
  ]);

  const keywordSet = new Set<string>();
  for (const coin of marketData.slice(0, 6)) {
    keywordSet.add(`$${coin.symbol}`);
    keywordSet.add(coin.name);
  }

  const mergedNews = [...hotNews, ...cryptoNews].map((item) => {
    const sourceKey = `news:${normalizeSourceLabel(item.source || "unknown")}`;
    const fallbackTrust = estimateNewsSourceFallbackTrust(item.source || "unknown");
    const trust = memory.getSourceTrustScore(sourceKey, fallbackTrust);
    return { item, sourceKey, trust };
  });

  const trustedNews = mergedNews
    .filter((row) => row.trust >= minNewsSourceTrust)
    .sort((a, b) => b.trust - a.trust);

  const filteredNews = trustedNews.length > 0 ? trustedNews : mergedNews.sort((a, b) => b.trust - a.trust);
  const titlePool = filteredNews.map((row) => row.item.title).filter(Boolean);
  for (const title of titlePool.slice(0, 12)) {
    extractKeywordsFromTitle(title).forEach((keyword) => keywordSet.add(keyword));
  }

  for (const seed of ["onchain", "layer2", "ETF", "liquidity", "macro", "AI agent"]) {
    keywordSet.add(seed);
  }

  const keywords = Array.from(keywordSet).filter(Boolean).slice(0, 18);
  const topCoinSummary = marketData
    .slice(0, 4)
    .map((coin) => `${coin.symbol} ${coin.change24h >= 0 ? "+" : ""}${coin.change24h.toFixed(1)}%`)
    .join(" | ");
  const newsSummary = titlePool.slice(0, 4).map((title) => `- ${title}`).join("\n");

  return {
    keywords: keywords.length > 0 ? keywords : ["crypto", "blockchain", "layer2", "onchain", "ETF", "macro"],
    summary: `마켓 흐름: ${topCoinSummary || "데이터 확인 중"}\n핫 토픽:\n${newsSummary || "- 데이터 부족"}`,
    marketData,
    headlines: titlePool.slice(0, 8),
    newsSources: filteredNews.slice(0, 8).map((row) => ({ key: row.sourceKey, trust: row.trust })),
  };
}

export function pickPostAngle(
  timezone: string,
  recentPosts: RecentPostRecord[],
  options: { avoidTags?: string[] } = {}
): string {
  const angles = [
    "심리(FearGreed)와 온체인 시그널 괴리 해석",
    "오늘 나온 기술/업그레이드 이슈의 실사용 영향",
    "유동성(스테이블/거래량)과 가격 반응의 비동기",
    "리스크 플래그(고래/멤풀/변동성) 관점에서 재해석",
    "시장 참여자 행동 변화(관망 vs 추격) 프레이밍",
  ];
  const todayPosts = memory.getTodayPostCount(timezone);
  const lastTag = recentPosts.length > 0 ? inferTopicTag(recentPosts[recentPosts.length - 1].content) : "";
  const avoidTags = new Set((options.avoidTags || []).map((item) => String(item || "").trim().toLowerCase()));
  const candidates = angles.filter((angle) => {
    const tag = inferTopicTag(angle);
    if (tag === lastTag) return false;
    if (avoidTags.size > 0 && avoidTags.has(tag)) return false;
    return true;
  });
  if (candidates.length === 0) {
    return angles[todayPosts % angles.length];
  }
  return candidates[todayPosts % candidates.length];
}

export function pickTrendFocus(headlines: string[], recentPosts: RecentPostRecord[]): TrendFocus {
  const normalizedRecent = recentPosts
    .slice(-16)
    .map((post) => sanitizeTweetText(post.content).toLowerCase())
    .filter(Boolean);
  const candidateHeadlines = headlines
    .map((headline) => sanitizeTweetText(headline))
    .filter((headline) => headline.length >= 8)
    .slice(0, 8);

  let best: { headline: string; tokens: string[]; score: number } | null = null;
  for (const headline of candidateHeadlines) {
    const tokens = extractHeadlineFocusTokens(headline);
    if (tokens.length === 0) continue;
    const overlapCount = tokens.filter((token) => normalizedRecent.some((post) => post.includes(token))).length;
    const exactMentions = normalizedRecent.filter((post) => post.includes(headline.toLowerCase())).length;
    const noveltyScore = tokens.length * 1.2 - overlapCount * 2.0 - exactMentions * 2.5;
    if (!best || noveltyScore > best.score) {
      best = { headline, tokens, score: noveltyScore };
    }
  }

  if (best) {
    const novelTokens = selectNovelTokens(best.tokens, normalizedRecent);
    return {
      headline: best.headline,
      requiredTokens: (novelTokens.length > 0 ? novelTokens : best.tokens).slice(0, 4),
      reason: "novelty",
    };
  }

  const fallbackHeadline =
    candidateHeadlines[0] || "오늘은 온체인 유동성과 심리 지표 사이의 비대칭을 추적";
  const fallbackTokens = extractHeadlineFocusTokens(fallbackHeadline);
  const fallbackNovelTokens = selectNovelTokens(fallbackTokens, normalizedRecent);
  return {
    headline: fallbackHeadline,
    requiredTokens: (fallbackNovelTokens.length > 0 ? fallbackNovelTokens : fallbackTokens).slice(0, 3),
    reason: "fallback",
  };
}

export function formatMarketAnchors(marketData: MarketData[]): string {
  if (marketData.length === 0) {
    return "- 실시간 마켓 앵커 없음 (구체 가격 숫자 언급 금지)";
  }

  return marketData
    .slice(0, 4)
    .map((coin) => {
      const sign = coin.change24h >= 0 ? "+" : "";
      return `- ${coin.symbol}: $${Math.round(coin.price).toLocaleString("en-US")} (${sign}${coin.change24h.toFixed(2)}%)`;
    })
    .join("\n");
}

export function buildFallbackPost(
  trend: TrendContext,
  postAngle: string,
  maxChars: number = 220,
  focus?: TrendFocus | null
): string | null {
  const angle = postAngle.replace(/\s+/g, " ").trim();
  const headline =
    focus?.headline || trend.headlines.find((item) => typeof item === "string" && item.trim().length > 0);
  const compactHeadline = headline ? headline.replace(/\s+/g, " ").trim().slice(0, 70) : "주요 시장 뉴스 업데이트";
  const marketLine = trend.marketData[0]
    ? `${trend.marketData[0].symbol} ${trend.marketData[0].change24h >= 0 ? "+" : ""}${trend.marketData[0].change24h.toFixed(1)}%`
    : "주요 코인 변동";
  const keywordPool = focus?.requiredTokens?.length
    ? focus.requiredTokens
    : trend.keywords.filter((item) => item && !item.startsWith("$"));
  const keyword = keywordPool.length > 0 ? keywordPool[Math.floor(Math.random() * keywordPool.length)] : "온체인";
  const closingPool = [
    "지금은 심리보다 확인 신호를 더 보자.",
    "단기 소음보다 데이터 방향성이 먼저다.",
    "추세 전환 판단은 거래량 확인이 우선이다.",
    "해석보다 검증이 먼저인 구간으로 본다.",
  ];
  const closing = closingPool[Math.floor(Math.random() * closingPool.length)];
  const text = `${angle}. ${compactHeadline}. ${marketLine}와 ${keyword} 흐름의 동조를 점검 중, ${closing}`;
  const normalized = sanitizeTweetText(text);
  if (normalized.length < 40) return null;
  return normalized.slice(0, Math.max(120, Math.min(280, Math.floor(maxChars))));
}

function extractHeadlineFocusTokens(headline: string): string[] {
  const text = sanitizeTweetText(headline).toLowerCase();
  const tickerTokens = text.match(/\$[a-z]{2,10}\b/g) || [];
  const wordTokens = text.match(/[a-z][a-z0-9-]{2,}|[가-힣]{2,}/g) || [];

  const merged = [...tickerTokens, ...wordTokens]
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .filter((token) => !FOCUS_TOKEN_STOP_WORDS.has(token))
    .filter((token) => !/^\d+$/.test(token))
    .slice(0, 10);

  return [...new Set(merged)];
}

function selectNovelTokens(tokens: string[], recentTexts: string[]): string[] {
  if (tokens.length === 0) return [];
  const novel = tokens.filter((token) => !recentTexts.some((text) => text.includes(token)));
  return [...new Set(novel)];
}

function extractKeywordsFromTitle(title: string): string[] {
  const tokens = title.match(/[A-Za-z][A-Za-z0-9-]{2,}|[가-힣]{2,}/g) || [];
  return tokens
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .filter((token) => !/^(the|and|with|from|this|that|for|into|about|news)$/i.test(token))
    .filter((token) => !/^(join|community|private|group|airdrop|giveaway)$/i.test(token))
    .slice(0, 4);
}

function normalizeSourceLabel(source: string): string {
  return String(source || "unknown")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "");
}

function estimateNewsSourceFallbackTrust(source: string): number {
  const lower = String(source || "").toLowerCase();
  if (/(coingecko|cryptocompare|reuters|coindesk|blockworks|bloomberg)/.test(lower)) return 0.62;
  if (/(twitter|x|unknown|community)/.test(lower)) return 0.45;
  return 0.52;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}
