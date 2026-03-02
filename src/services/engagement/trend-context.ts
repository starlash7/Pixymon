import { BlockchainNewsService, MarketData, NewsItem } from "../blockchain-news.js";
import { memory } from "../memory.js";
import { OnchainNutrient } from "../../types/agent.js";
import { sanitizeTweetText } from "./quality.js";
import { RecentPostRecord, TrendContext, TrendContextOptions, TrendFocus } from "./types.js";
import { buildTrendEvents, inferTrendLane } from "./event-evidence.js";

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
    headline: "내 지갑이 스스로 움직인 날, 책임의 주어가 바뀌었다",
    summary: "에이전트 지갑 시대에는 성과보다 책임 경로를 먼저 설계해야 한다.",
    keywords: ["agent-wallet", "accountability", "onchain-intent", "crypto-ai", "identity"],
    evidence: ["자동 실행 정책 문서", "트랜잭션 감사 로그", "실패 복구 규칙"],
  },
  {
    lane: "protocol",
    headline: "철학 메모: 자유는 느림이 아니라 설명 가능한 합의다",
    summary: "프로토콜 철학을 UX로 번역하는 팀이 장기 신뢰를 얻는다.",
    keywords: ["protocol-design", "decentralization", "ux-tradeoff", "governance", "philosophy"],
    evidence: ["검증자 참여율 변화", "클라이언트 다양성", "업그레이드 합의 과정"],
  },
  {
    lane: "ecosystem",
    headline: "오늘의 상호작용 실험: 커뮤니티 미션은 토큰보다 오래 남는가",
    summary: "보상 이벤트보다 반복 가능한 미션 설계가 생태계 체류 시간을 만든다.",
    keywords: ["community-loop", "mission-design", "retention", "ecosystem", "interaction"],
    evidence: ["기여자 재방문 패턴", "미션 완료율", "신규 온보딩 경로"],
  },
  {
    lane: "regulation",
    headline: "메타 회고: 규제를 핑계로 삼는 순간 제품은 멈춘다",
    summary: "규제를 장벽이 아닌 인터페이스로 다루는 팀이 생존 확률을 높인다.",
    keywords: ["regulation", "compliance-by-design", "policy", "crypto", "meta-reflection"],
    evidence: ["관할별 요구사항 매핑", "투명성 보고 체계", "리스크 공개 원칙"],
  },
  {
    lane: "macro",
    headline: "책에서 읽은 문장 하나: 불확실할수록 사람은 이야기에 기대어 움직인다",
    summary: "거시 불확실성 구간일수록 가격보다 기대와 신뢰 구조가 길게 남는다.",
    keywords: ["macro-narrative", "expectation", "liquidity", "trust", "book-fragment"],
    evidence: ["리스크 선호 전환 신호", "헤지 포지셔닝 변화", "자금 이동 서사"],
  },
  {
    lane: "market-structure",
    headline: "짧은 우화: 유동성은 숫자가 아니라 허용된 행동의 지도다",
    summary: "시장 구조는 가격보다 참여자가 할 수 있는 행동 범위를 규정한다.",
    keywords: ["market-structure", "liquidity-behavior", "execution", "crypto-microstructure", "fable"],
    evidence: ["호가 간격 안정성", "체결 실패 패턴", "슬리피지 민감 구간"],
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
  const topCoinSummary = marketData
    .slice(0, 4)
    .map((coin) => `${coin.symbol} ${coin.change24h >= 0 ? "+" : ""}${coin.change24h.toFixed(1)}%`)
    .join(" | ");
  const newsSummary = titlePool.slice(0, 4).map((title) => `- ${title}`).join("\n");
  const createdAt = new Date().toISOString();
  const nutrients = buildTrendNutrients({
    marketData,
    newsRows: filteredNews,
    createdAt,
  });
  const events = buildTrendEvents({
    newsRows: filteredNews,
    createdAt,
  });

  return {
    keywords: keywords.length > 0 ? keywords : ["crypto", "blockchain", "layer2", "onchain", "ETF", "macro"],
    summary: `마켓 흐름: ${topCoinSummary || "데이터 확인 중"}\n핫 토픽:\n${newsSummary || "- 데이터 부족"}`,
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
  const marketNutrients: OnchainNutrient[] = params.marketData.slice(0, 5).map((coin, index) => {
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
  const keywords = Array.from(
    new Set(
      selectedThemes
        .flatMap((theme) => theme.keywords)
        .concat(["blockchain", "crypto", "onchain", "protocol", "governance"])
    )
  ).slice(0, 20);
  const headlines = selectedThemes.map((theme) => theme.headline);
  const summary = [
    "로컬 테스트 모드(외부 호출 없음): 숫자 예측 대신 내러티브 품질을 검증한다.",
    ...selectedThemes.map((theme, index) => `- 주제${index + 1}: ${theme.summary}`),
  ].join("\n");

  const nutrients: OnchainNutrient[] = selectedThemes.flatMap((theme, themeIndex) =>
    theme.evidence.map((item, evidenceIndex) => {
      const source = evidenceIndex % 2 === 0 ? "onchain" : "news";
      return {
        id: `local:${theme.lane}:${themeIndex}:${evidenceIndex}:${createdAt}`,
        source,
        category: `narrative-${theme.lane}`,
        label: `${theme.headline.slice(0, 72)} 근거`,
        value: item,
        evidence: `${theme.summary} | ${item}`,
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
    headline: theme.headline,
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
  const secondSeed = Math.floor(Date.now() / 1000);
  const start = secondSeed % LOCAL_NARRATIVE_THEMES.length;
  const result: LocalNarrativeTheme[] = [];
  for (let i = 0; i < safeCount; i += 1) {
    result.push(LOCAL_NARRATIVE_THEMES[(start + i) % LOCAL_NARRATIVE_THEMES.length]);
  }
  return result;
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
