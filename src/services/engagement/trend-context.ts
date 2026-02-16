import { BlockchainNewsService, MarketData } from "../blockchain-news.js";
import { memory } from "../memory.js";
import { inferTopicTag, sanitizeTweetText } from "./quality.js";
import { RecentPostRecord, TrendContext } from "./types.js";

export async function collectTrendContext(): Promise<TrendContext> {
  const newsService = new BlockchainNewsService();
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
    .filter((row) => row.trust >= 0.28)
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

export function pickPostAngle(timezone: string, recentPosts: RecentPostRecord[]): string {
  const angles = [
    "심리(FearGreed)와 온체인 시그널 괴리 해석",
    "오늘 나온 기술/업그레이드 이슈의 실사용 영향",
    "유동성(스테이블/거래량)과 가격 반응의 비동기",
    "리스크 플래그(고래/멤풀/변동성) 관점에서 재해석",
    "시장 참여자 행동 변화(관망 vs 추격) 프레이밍",
  ];
  const todayPosts = memory.getTodayPostCount(timezone);
  const lastTag = recentPosts.length > 0 ? inferTopicTag(recentPosts[recentPosts.length - 1].content) : "";
  const candidates = angles.filter((angle) => inferTopicTag(angle) !== lastTag);
  if (candidates.length === 0) {
    return angles[todayPosts % angles.length];
  }
  return candidates[todayPosts % candidates.length];
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

export function buildFallbackPost(trend: TrendContext, postAngle: string): string | null {
  const angle = postAngle.replace(/\s+/g, " ").trim();
  const headline = trend.headlines.find((item) => typeof item === "string" && item.trim().length > 0);
  const compactHeadline = headline ? headline.replace(/\s+/g, " ").trim().slice(0, 70) : "주요 시장 뉴스 업데이트";
  const marketLine = trend.marketData[0]
    ? `${trend.marketData[0].symbol} ${trend.marketData[0].change24h >= 0 ? "+" : ""}${trend.marketData[0].change24h.toFixed(1)}%`
    : "주요 코인 변동";
  const keywordPool = trend.keywords.filter((item) => item && !item.startsWith("$"));
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
  return normalized.slice(0, 220);
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
