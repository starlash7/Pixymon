import { BlockchainNewsService, MarketData, NewsItem } from "../blockchain-news.js";
import { memory } from "../memory.js";
import { OnchainNutrient } from "../../types/agent.js";
import { sanitizeTweetText } from "./quality.js";
import { RecentPostRecord, TrendContext, TrendContextOptions, TrendFocus } from "./types.js";
import { buildTrendEvents, inferTrendLane, isLowQualityTrendHeadline } from "./event-evidence.js";

const TEST_MODE = process.env.TEST_MODE === "true";
const TEST_NO_EXTERNAL_CALLS =
  TEST_MODE && String(process.env.TEST_NO_EXTERNAL_CALLS ?? "true").trim().toLowerCase() !== "false";

interface LocalNarrativeTheme {
  lane: "protocol" | "ecosystem" | "regulation" | "macro" | "onchain" | "market-structure";
  headline: string;
  summary: string;
  keywords: string[];
  evidence: string[];
}

const LOCAL_NARRATIVE_THEMES: LocalNarrativeTheme[] = [
  {
    lane: "onchain",
    headline: "조용한 시간대에도 같은 방향으로 움직이는 큰 지갑",
    summary: "수수료가 낮아도 자금 이동이 이어지면 체인 안쪽 의도가 남아 있다고 본다.",
    keywords: ["whale-flow", "address-movement", "onchain", "wallets", "signal"],
    evidence: ["큰손 자금이 어디로 움직이는지", "비슷한 지갑이 한쪽으로 몰리는지", "체인 사용이 다시 살아나는지"],
  },
  {
    lane: "protocol",
    headline: "업그레이드 공지 뒤에도 그대로 붙어 있는 검증자",
    summary: "속도보다 운영 안정성과 합의 유지가 먼저인 장면을 추적한다.",
    keywords: ["protocol-upgrade", "validators", "consensus", "rollout", "resilience"],
    evidence: ["검증자가 얼마나 남아 있는지", "구현체가 한쪽에만 쏠리는지", "업그레이드 합의 과정"],
  },
  {
    lane: "ecosystem",
    headline: "보상 이벤트가 끝난 뒤에도 다시 돌아오는 사람들",
    summary: "토큰 이벤트보다 반복되는 사용 습관이 생태계 체류 시간을 만든다.",
    keywords: ["community", "retention", "ecosystem", "missions", "usage"],
    evidence: ["기여자가 다시 오는지", "미션 완료율", "새로 들어온 사람이 어디서 떠나는지"],
  },
  {
    lane: "regulation",
    headline: "정책 발표 뒤 엇갈리는 거래소 공지",
    summary: "규제 문장이 끝난 뒤 현장 반응이 어디서 갈리는지 확인한다.",
    keywords: ["regulation", "policy", "compliance", "exchange", "filing"],
    evidence: ["규제가 어디서 갈리는지", "거래소가 얼마나 빨리 반응하는지", "얼마나 투명하게 설명하는지"],
  },
  {
    lane: "macro",
    headline: "달러가 흔들린 날에도 남아 있는 체인 안 자금",
    summary: "거시 뉴스 뒤에도 위험 선호가 체인 안쪽에 남는지 확인한다.",
    keywords: ["macro", "usd", "liquidity", "risk", "flows"],
    evidence: ["달러 쪽 움직임", "사람들이 다시 위험을 감수하려는지", "방어 포지션이 얼마나 풀리는지"],
  },
  {
    lane: "market-structure",
    headline: "호가가 얇아진 뒤에도 버티는 큰 주문",
    summary: "시장 구조는 차트보다 실제 체결 품질에서 먼저 드러난다고 본다.",
    keywords: ["market-structure", "liquidity", "execution", "orderbook", "slippage"],
    evidence: ["호가 간격이 얼마나 안정적인지", "큰 주문이 얼마나 깔끔하게 소화되는지", "주문이 어디서 자꾸 미끄러지는지"],
  },
  {
    lane: "protocol",
    headline: "테스트넷 이슈 뒤에도 안정적으로 버티는 노드",
    summary: "기술 진보보다 장애 복구와 합의 안정성이 오래 남는 신뢰를 만든다.",
    keywords: ["testnet", "nodes", "protocol", "recovery", "upgrade"],
    evidence: ["업그레이드 후 장애 빈도", "장애 뒤 얼마나 빨리 복구되는지", "검증자 합의가 얼마나 안정적인지"],
  },
  {
    lane: "ecosystem",
    headline: "토큰 이벤트 뒤에 남는 실제 사용",
    summary: "이벤트 열기보다 실사용 습관이 남는지가 생태계의 핵심이다.",
    keywords: ["usage", "ecosystem", "community", "retention", "adoption"],
    evidence: ["재방문 비율", "실사용 실험", "기여자 전환률"],
  },
  {
    lane: "regulation",
    headline: "규제 문장 뒤 멈추는 사용자 흐름",
    summary: "정책 발표 뒤 실제 사용자 행동의 지연 시간을 추적한다.",
    keywords: ["policy", "regulation", "behavior", "compliance", "exchange"],
    evidence: ["정책 발표 후 거래량 변동", "공시 지연 패턴", "위험을 얼마나 솔직히 드러내는지"],
  },
  {
    lane: "macro",
    headline: "금리 뉴스 뒤에도 남는 위험 선호",
    summary: "거시 뉴스가 끝난 뒤 실제 자금 성격이 어떻게 남는지 확인한다.",
    keywords: ["rates", "macro", "liquidity", "risk", "dxy"],
    evidence: ["달러 인덱스 변동성", "위험자산 반응이 얼마나 예민한지", "헤지 수요 변화"],
  },
  {
    lane: "onchain",
    headline: "수수료가 낮아도 이어지는 자금 이동",
    summary: "체인이 조용해도 큰 지갑 움직임이 남으면 다음 행동의 실마리가 된다.",
    keywords: ["fees", "flows", "addresses", "onchain", "mempool"],
    evidence: ["체인 사용이 다시 살아나는지", "큰손 자금이 어디로 움직이는지", "비슷한 지갑이 한쪽으로 몰리는지"],
  },
  {
    lane: "market-structure",
    headline: "화면은 조용한데 커지는 주문 충격",
    summary: "체결 구조의 약화는 심리보다 실행 경로의 취약점에서 먼저 보인다.",
    keywords: ["orderbook", "execution", "slippage", "market-structure", "depth"],
    evidence: ["유동성이 얼마나 빨리 돌아오는지", "주문 충격에 약한 구간", "큰 주문이 얼마나 깔끔하게 소화되는지"],
  },
];

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
  "today",
  "todays",
  "book",
  "note",
  "memo",
  "mission",
  "reflection",
  "essay",
  "fable",
  "오늘",
  "오늘의",
  "책에서",
  "읽은",
  "문장",
  "하나",
  "근거",
  "메모",
  "노트",
  "실험",
  "회고",
  "우화",
  "짧은",
  "이야기",
  "공포",
  "탐욕",
  "지수",
  "온체인",
  "유동성",
  "스테이블",
  "고래",
  "수수료",
  ...parseCsvEnv(process.env.FOCUS_TOKEN_STOP_WORDS_EXTRA),
]);


export async function collectTrendContext(options: Partial<TrendContextOptions> = {}): Promise<TrendContext> {
  if (TEST_NO_EXTERNAL_CALLS) {
    return buildLocalNarrativeTrendContext();
  }

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

  if (keywordSet.size < 10) {
    for (const seed of resolveTrendKeywordSeeds()) {
      keywordSet.add(seed);
    }
  }

  const keywords = Array.from(keywordSet).filter(Boolean).slice(0, 18);
  const newsSummary = titlePool.slice(0, 4).map((title) => `- ${title}`).join("\n");
  const createdAt = new Date().toISOString();
  const nutrients = buildTrendNutrients({
    marketData,
    newsRows: filteredNews,
    createdAt,
  });
  const marketEvents = buildTrendEvents({
    newsRows: filteredNews,
    createdAt,
  });
  const narrativeBridgeEvents = buildNarrativeBridgeEvents({
    newsRows: filteredNews,
    createdAt,
  });
  const events = dedupTrendEvents(marketEvents.length > 0 ? marketEvents : narrativeBridgeEvents, 12);
  const laneMix = summarizeLaneMix(events);
  const soulIntent = memory.getSoulIntentPlan("ko");

  return {
    keywords: keywords.length > 0 ? keywords : ["crypto", "blockchain", "layer2", "onchain", "ETF", "macro"],
    summary: `핵심 프레임: ${laneMix}\n서사 초점: ${soulIntent.primaryDesire}\n핫 토픽:\n${newsSummary || "- 데이터 부족"}`,
    marketData,
    headlines: titlePool.slice(0, 8),
    newsSources: filteredNews.slice(0, 8).map((row) => ({ key: row.sourceKey, trust: row.trust })),
    nutrients,
    events,
  };
}

export function pickTrendFocus(headlines: string[], recentPosts: RecentPostRecord[]): TrendFocus {
  const normalizedRecent = recentPosts
    .slice(-16)
    .map((post) => sanitizeTweetText(post.content).toLowerCase())
    .filter(Boolean);
  const btcSaturation = getRecentBtcSaturation(normalizedRecent);
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
    const btcPenalty =
      btcSaturation >= 0.67 && isBtcCentricText(headline)
        ? 3.2
        : btcSaturation >= 0.5 && isBtcCentricText(headline)
          ? 1.8
          : 0;
    const noveltyScore = tokens.length * 1.2 - overlapCount * 2.0 - exactMentions * 2.5 - btcPenalty;
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
    candidateHeadlines[0] || "오늘은 숫자보다 행동의 원인을 먼저 추적한다";
  const fallbackTokens = extractHeadlineFocusTokens(fallbackHeadline);
  const fallbackNovelTokens = selectNovelTokens(fallbackTokens, normalizedRecent);
  return {
    headline: fallbackHeadline,
    requiredTokens: (fallbackNovelTokens.length > 0 ? fallbackNovelTokens : fallbackTokens).slice(0, 3),
    reason: "fallback",
  };
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

function getRecentBtcSaturation(recentTexts: string[]): number {
  if (!Array.isArray(recentTexts) || recentTexts.length === 0) return 0;
  const sample = recentTexts.slice(-8);
  const btcMentions = sample.filter((text) => isBtcCentricText(text)).length;
  return btcMentions / Math.max(1, sample.length);
}

function isBtcCentricText(text: string): boolean {
  const lower = sanitizeTweetText(text).toLowerCase();
  return /(^|\s)(\$?btc|bitcoin|비트코인)(\s|$)|fear\s*greed|fgi|공포\s*지수|극공포/.test(lower);
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

function resolveTrendKeywordSeeds(): string[] {
  const envSeeds = parseCsvEnv(process.env.TREND_KEYWORD_SEEDS);
  if (envSeeds.length > 0) {
    return envSeeds;
  }
  // fallback only when keyword pool is too sparse
  return ["protocol", "governance", "community", "onchain", "liquidity", "ethics"];
}

function parseCsvEnv(raw: string | undefined): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((item) => sanitizeTweetText(item).toLowerCase())
    .filter((item) => item.length >= 2)
    .filter((item, index, arr) => arr.indexOf(item) === index)
    .slice(0, 40);
}

export function buildTrendNutrients(params: {
  marketData: MarketData[];
  newsRows: Array<{ item: NewsItem; sourceKey: string; trust: number }>;
  createdAt: string;
}): OnchainNutrient[] {
  const marketNutrients: OnchainNutrient[] = params.marketData.slice(0, 2).map((coin, index) => {
    const absChange = Math.abs(coin.change24h);
    const direction = coin.change24h > 0.1 ? "up" : coin.change24h < -0.1 ? "down" : "flat";
    const lane = inferTrendLane(`${coin.symbol} price ${coin.change24h}% liquidity market`);
    return {
      id: `market:${coin.symbol}:${params.createdAt}:${index}`,
      source: "market",
      category: "price-action",
      label: `${coin.symbol} 24h 변동`,
      value: `${coin.change24h >= 0 ? "+" : ""}${coin.change24h.toFixed(2)}%`,
      evidence: `${coin.name} $${Math.round(coin.price).toLocaleString("en-US")} (${coin.change24h >= 0 ? "+" : ""}${coin.change24h.toFixed(2)}%)`,
      direction,
      trust: clampNumber(0.74 + Math.min(0.12, absChange / 80), 0.3, 0.94, 0.76),
      freshness: 0.95,
      consistencyHint: clampNumber(0.62 + Math.min(0.2, absChange / 40), 0.25, 0.9, 0.66),
      capturedAt: params.createdAt,
      metadata: {
        symbol: coin.symbol,
        change24h: Number(coin.change24h.toFixed(2)),
        lane,
      },
    };
  });

  const newsNutrients: OnchainNutrient[] = params.newsRows.slice(0, 8).map((row, index) => {
    const category = inferNewsCategory(row.item.title, row.item.category);
    const lane = inferTrendLane(`${row.item.title} ${row.item.summary} ${category}`);
    return {
      id: `news:${row.sourceKey}:${index}:${params.createdAt}`,
      source: "news",
      category,
      label: row.item.title.slice(0, 120),
      value: row.item.source || "unknown",
      evidence: `${row.item.title} | ${row.item.summary || "summary-missing"}`,
      trust: clampNumber(row.trust, 0.15, 0.96, 0.5),
      freshness: clampNumber(0.92 - index * 0.05, 0.35, 0.92, 0.72),
      consistencyHint: 0.62,
      capturedAt: params.createdAt,
      metadata: {
        sourceKey: row.sourceKey,
        lane,
      },
    };
  });

  const dedup = new Map<string, OnchainNutrient>();
  for (const nutrient of [...marketNutrients, ...newsNutrients]) {
    const key = `${nutrient.source}|${nutrient.category}|${sanitizeTweetText(nutrient.label).toLowerCase()}`;
    if (!dedup.has(key)) {
      dedup.set(key, nutrient);
    }
  }
  return Array.from(dedup.values());
}

function buildNarrativeBridgeEvents(params: {
  newsRows: Array<{ item: NewsItem; sourceKey: string; trust: number }>;
  createdAt: string;
}): Array<{
  id: string;
  lane: "protocol" | "ecosystem" | "regulation" | "macro" | "onchain" | "market-structure";
  headline: string;
  summary: string;
  source: string;
  trust: number;
  freshness: number;
  capturedAt: string;
  keywords: string[];
}> {
  const topNews = params.newsRows
    .map((row) => sanitizeTweetText(row.item.title))
    .filter((title) => title.length >= 10)
    .filter((title) => !isLowQualityTrendHeadline(title))
    .slice(0, 2);
  if (topNews.length === 0) return [];

  const reframed = topNews.map((headline, index) => {
    const lane = inferTrendLane(headline);
    const narrativeHeadline = rewriteNarrativeBridgeHeadline(headline, lane);
    const summary = buildNarrativeBridgeSummary(lane, headline, index);

    return {
      id: `event:bridge:${lane}:${index}:${params.createdAt}`,
      lane,
      headline: sanitizeTweetText(narrativeHeadline).slice(0, 150),
      summary: sanitizeTweetText(summary).slice(0, 220),
      source: "soul:narrative-bridge",
      trust: 0.66,
      freshness: 0.9 - index * 0.04,
      capturedAt: params.createdAt,
      keywords: extractHeadlineFocusTokens(narrativeHeadline).slice(0, 6),
    };
  });

  return reframed.slice(0, 2);
}

function rewriteNarrativeBridgeHeadline(
  headline: string,
  lane: "protocol" | "ecosystem" | "regulation" | "macro" | "onchain" | "market-structure"
): string {
  const cleaned = sanitizeTweetText(headline).replace(/[.!?]+$/g, "").trim();
  if (!cleaned) return buildBridgeLaneFallback(lane);
  const lower = cleaned.toLowerCase();

  if (/sec|cftc|policy|compliance|lawsuit|court|etf|filing|approval|review/.test(lower)) {
    return "규제 뉴스 뒤 실제 반응이 같은 방향인지 본다";
  }
  if (/upgrade|mainnet|testnet|validator|rollout|consensus|firedancer|fork|throughput/.test(lower)) {
    return "업그레이드 뉴스 뒤 운영 안정성이 유지되는지 본다";
  }
  if (/wallet|community|developer|adoption|usage|user|app|ecosystem/.test(lower)) {
    return "생태계 뉴스 뒤 실제 사용이 이어지는지 본다";
  }
  if (/fed|ecb|cpi|inflation|rates|treasury|dxy|usd|eur/.test(lower)) {
    return "거시 뉴스 뒤 위험 선호가 체인 안쪽에 남는지 본다";
  }
  if (/exchange|liquidity|volume|funding|open interest|market maker|orderbook/.test(lower)) {
    return "시장 뉴스 뒤 실제 주문이 받쳐주는지 본다";
  }
  return buildBridgeLaneFallback(lane);
}

function buildNarrativeBridgeSummary(
  lane: "protocol" | "ecosystem" | "regulation" | "macro" | "onchain" | "market-structure",
  headline: string,
  index: number
): string {
  const compact = sanitizeTweetText(headline).replace(/\.$/, "");
  const byLane: Record<
    "protocol" | "ecosystem" | "regulation" | "macro" | "onchain" | "market-structure",
    string[]
  > = {
    protocol: [
      `${compact}. 속도보다 운영 안정성과 합의 유지가 먼저다.`,
      `${compact}. 뉴스보다 검증자와 운영 현장의 반응을 먼저 본다.`,
    ],
    ecosystem: [
      `${compact}. 서사보다 실제 사용과 재방문이 이어지는지 확인한다.`,
      `${compact}. 이벤트 열기보다 사람들의 재방문이 남는지가 더 중요하다.`,
    ],
    regulation: [
      `${compact}. 정책 문장 뒤 현장 반응이 어디서 갈리는지 본다.`,
      `${compact}. 공지보다 실제 사용자 흐름이 어디서 멈추는지 확인한다.`,
    ],
    macro: [
      `${compact}. 거시 뉴스 뒤에도 위험 선호가 체인 안쪽에 남는지 본다.`,
      `${compact}. 거시 바람보다 실제 자금 성격이 어떻게 남는지 확인한다.`,
    ],
    onchain: [
      `${compact}. 조용한 체인 안쪽에서 자금 이동이 계속 살아 있는지 본다.`,
      `${compact}. 수수료가 낮아도 주소 움직임이 이어지는지 확인한다.`,
    ],
    "market-structure": [
      `${compact}. 차트가 뜨거워도 실제 돈이 붙는지 본다.`,
      `${compact}. 화면 분위기와 실제 체결이 같은 방향인지 확인한다.`,
    ],
  };
  const pool = byLane[lane];
  return pool[index % pool.length];
}

function buildBridgeLaneFallback(
  lane: "protocol" | "ecosystem" | "regulation" | "macro" | "onchain" | "market-structure"
): string {
  const byLane = {
    protocol: "코드 변화 뒤 실제 운영이 흔들리지 않는지 본다",
    ecosystem: "사람들이 말이 아니라 사용으로 남는지 본다",
    regulation: "정책 문장 뒤 현장 반응이 같은 방향인지 본다",
    macro: "큰 뉴스 뒤에도 체인 안 자금이 그대로 남는지 본다",
    onchain: "조용한 체인에서도 자금 이동이 이어지는지 본다",
    "market-structure": "차트가 뜨거워도 실제 돈이 붙는지 본다",
  } satisfies Record<
    "protocol" | "ecosystem" | "regulation" | "macro" | "onchain" | "market-structure",
    string
  >;
  return byLane[lane];
}

function dedupTrendEvents(
  events: Array<{
    id: string;
    lane: "protocol" | "ecosystem" | "regulation" | "macro" | "onchain" | "market-structure";
    headline: string;
    summary: string;
    source: string;
    trust: number;
    freshness: number;
    capturedAt: string;
    keywords: string[];
  }>,
  maxItems: number
): Array<{
  id: string;
  lane: "protocol" | "ecosystem" | "regulation" | "macro" | "onchain" | "market-structure";
  headline: string;
  summary: string;
  source: string;
  trust: number;
  freshness: number;
  capturedAt: string;
  keywords: string[];
}> {
  const dedup = new Map<string, (typeof events)[number]>();
  for (const event of events) {
    const key = sanitizeTweetText(event.headline).toLowerCase().replace(/[^a-z0-9가-힣]/g, "");
    if (!dedup.has(key)) {
      dedup.set(key, event);
    }
  }
  return Array.from(dedup.values()).slice(0, Math.max(2, Math.min(24, maxItems)));
}

function summarizeLaneMix(
  events: Array<{
    lane: "protocol" | "ecosystem" | "regulation" | "macro" | "onchain" | "market-structure";
  }>
): string {
  if (!Array.isArray(events) || events.length === 0) return "이벤트 부족, 해석 모드";
  const counts = new Map<string, number>();
  for (const event of events) {
    counts.set(event.lane, (counts.get(event.lane) || 0) + 1);
  }
  const top = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([lane, count]) => `${lane} ${count}`);
  return top.join(" | ");
}

function inferNewsCategory(title: string, fallback: string): string {
  const lower = sanitizeTweetText(title).toLowerCase();
  if (/upgrade|mainnet|testnet|rollup|layer2|fork|firedancer|validator/.test(lower)) return "protocol-upgrade";
  if (/etf|sec|ecb|fed|fomc|rates|macro|cpi|inflation|eur\/usd|usd/.test(lower)) return "macro-news";
  if (/hack|exploit|breach|incident|outage/.test(lower)) return "risk-event";
  if (/listing|exchange|volume|liquidity/.test(lower)) return "market-structure";
  const normalized = String(fallback || "headline")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "");
  return normalized || "headline";
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

function buildLocalNarrativeTrendContext(): TrendContext {
  const createdAt = new Date().toISOString();
  const selectedThemes = selectLocalThemes(4);
  const remixedHeadlines = selectedThemes.map((theme) => remixLocalHeadline(theme));
  const keywords = Array.from(
    new Set(
      selectedThemes
        .flatMap((theme) => theme.keywords)
        .concat(["blockchain", "crypto", "onchain", "protocol", "governance"])
    )
  ).slice(0, 20);
  const headlines = remixedHeadlines;
  const summary = [
    "로컬 테스트 모드(외부 호출 없음): 숫자 예측 대신 먹기→소화→진화 서사 품질을 검증한다.",
    ...selectedThemes.map((theme, index) => `- 주제${index + 1}: ${theme.summary}`),
  ].join("\n");

  const nutrients: OnchainNutrient[] = selectedThemes.flatMap((theme, themeIndex) =>
    theme.evidence.map((item, evidenceIndex) => {
      const source = evidenceIndex % 2 === 0 ? "onchain" : "news";
      const compactValue = sanitizeTweetText(item).slice(0, 48);
      return {
        id: `local:${theme.lane}:${themeIndex}:${evidenceIndex}:${createdAt}`,
        source,
        category: `narrative-${theme.lane}`,
        label: compactValue,
        value: "",
        evidence: `${theme.summary} | ${compactValue}`,
        trust: clampNumber(0.62 + evidenceIndex * 0.05, 0.35, 0.9, 0.68),
        freshness: 0.98,
        consistencyHint: 0.78,
        capturedAt: createdAt,
        metadata: {
          lane: theme.lane,
          localNarrative: true,
          themeIndex,
        },
      } as OnchainNutrient;
    })
  );

  const events = selectedThemes.map((theme, index) => ({
    id: `event:local:${theme.lane}:${index}:${createdAt}`,
    lane: theme.lane,
    headline: remixedHeadlines[index] || theme.headline,
    summary: theme.summary,
    source: "local:narrative-lab",
    trust: 0.68,
    freshness: 1,
    capturedAt: createdAt,
    keywords: theme.keywords.slice(0, 6),
  }));

  return {
    keywords,
    summary,
    marketData: [],
    headlines,
    newsSources: [{ key: "local:narrative-lab", trust: 0.68 }],
    nutrients,
    events,
  };
}

function selectLocalThemes(count: number): LocalNarrativeTheme[] {
  const safeCount = Math.max(1, Math.min(LOCAL_NARRATIVE_THEMES.length, Math.floor(count)));
  const laneOrder: LocalNarrativeTheme["lane"][] = [
    "protocol",
    "ecosystem",
    "regulation",
    "macro",
    "onchain",
    "market-structure",
  ];
  const laneMap = new Map<LocalNarrativeTheme["lane"], LocalNarrativeTheme[]>();
  for (const lane of laneOrder) {
    laneMap.set(
      lane,
      LOCAL_NARRATIVE_THEMES.filter((theme) => theme.lane === lane)
    );
  }

  const shuffledLanes = [...laneOrder].sort(() => Math.random() - 0.5);
  const picked: LocalNarrativeTheme[] = [];

  for (let i = 0; i < shuffledLanes.length && picked.length < safeCount; i += 1) {
    const lane = shuffledLanes[i];
    const laneThemes = laneMap.get(lane) || [];
    if (laneThemes.length === 0) continue;
    const themeIndex = Math.floor(Math.random() * laneThemes.length);
    picked.push(laneThemes[themeIndex]);
  }

  while (picked.length < safeCount) {
    const candidate = LOCAL_NARRATIVE_THEMES[Math.floor(Math.random() * LOCAL_NARRATIVE_THEMES.length)];
    if (!picked.includes(candidate)) {
      picked.push(candidate);
    }
  }

  return picked;
}

function remixLocalHeadline(theme: LocalNarrativeTheme): string {
  const base = sanitizeTweetText(theme.headline).replace(/\.$/, "");
  const seed = Math.floor(Math.random() * 1000);
  const templates = [
    `${base}`,
    `오늘은 ${base}`,
    `${base}부터 다시 본다`,
    `${base}부터 먼저 짚는다`,
  ];
  return templates[seed % templates.length];
}

function localLaneLabel(lane: LocalNarrativeTheme["lane"]): string {
  if (lane === "protocol") return "프로토콜";
  if (lane === "ecosystem") return "생태계";
  if (lane === "regulation") return "규제";
  if (lane === "macro") return "매크로";
  if (lane === "onchain") return "온체인";
  return "시장구조";
}

export {
  buildEventEvidenceFallbackPost,
  buildOnchainEvidence,
  buildTrendEvents,
  computeLaneUsageWindow,
  inferTrendLane,
  planEventEvidenceAct,
  validateEventEvidenceContract,
} from "./event-evidence.js";
