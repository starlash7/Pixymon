import { OnchainEvidence, OnchainNutrient, TrendEvent, TrendLane } from "../../types/agent.js";
import { EventEvidencePlan, LaneUsageWindow, RecentPostRecord } from "./types.js";
import { NewsItem } from "../blockchain-news.js";
import { sanitizeTweetText } from "./quality.js";

const TREND_LANES: TrendLane[] = [
  "protocol",
  "ecosystem",
  "regulation",
  "macro",
  "onchain",
  "market-structure",
];

const LANE_MAX_RATIO: Record<TrendLane, number> = {
  protocol: 0.4,
  ecosystem: 0.4,
  regulation: 0.4,
  macro: 0.4,
  onchain: 0.3,
  "market-structure": 0.4,
};

const LANE_KEYWORDS: Record<TrendLane, RegExp> = {
  protocol:
    /upgrade|mainnet|testnet|fork|rollup|layer2|l2|validator|consensus|throughput|firedancer|업그레이드|메인넷|테스트넷|포크/,
  ecosystem:
    /ecosystem|adoption|wallet|gaming|app|developer|community|airdrop|partnership|meme|memecoin|생태계|채택|파트너십/,
  regulation: /sec|cftc|lawsuit|regulation|regulatory|policy|compliance|court|etf\s*approval|규제|소송|법안|당국/,
  macro: /fed|ecb|cpi|inflation|rates|bond|treasury|usd|eur\/usd|dxy|fomc|매크로|금리|인플레이션/,
  onchain: /onchain|mempool|fee|gas|whale|stablecoin|netflow|address|transaction|tvl|온체인|멤풀|수수료|고래|스테이블/,
  "market-structure": /exchange|listing|liquidity|volume|funding|open interest|derivatives|market maker|orderbook|거래소|유동성|거래량|파생/,
};

const EVIDENCE_TOKEN_STOP_WORDS = new Set([
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

export function buildTrendEvents(params: {
  newsRows: Array<{ item: NewsItem; sourceKey: string; trust: number }>;
  createdAt: string;
}): TrendEvent[] {
  const dedup = new Map<string, TrendEvent>();
  params.newsRows.slice(0, 12).forEach((row, index) => {
    const headline = sanitizeTweetText(row.item.title || "").slice(0, 160);
    if (headline.length < 12) return;
    const summary = sanitizeTweetText(row.item.summary || row.item.title || "").slice(0, 220);
    const lane = inferTrendLane([headline, row.item.category, row.item.summary].join(" "));
    const freshness = clampNumber(0.95 - index * 0.05, 0.35, 0.95, 0.7);
    const key = normalizeHeadlineKey(headline);
    if (dedup.has(key)) return;
    dedup.set(key, {
      id: `event:${lane}:${index}:${params.createdAt}`,
      lane,
      headline,
      summary,
      source: row.sourceKey,
      trust: clampNumber(row.trust, 0.1, 0.98, 0.52),
      freshness,
      capturedAt: params.createdAt,
      keywords: extractHeadlineTokens(headline).slice(0, 6),
    });
  });
  return Array.from(dedup.values());
}

export function buildOnchainEvidence(
  nutrients: OnchainNutrient[],
  maxItems: number = 12
): OnchainEvidence[] {
  const limit = clampNumber(maxItems, 2, 30, 12);
  const dedup = new Map<string, OnchainEvidence>();
  nutrients.forEach((nutrient, index) => {
    const lane = inferTrendLane(`${nutrient.category} ${nutrient.label} ${nutrient.evidence}`);
    const digestScore =
      typeof nutrient.metadata?.digestScore === "number"
        ? clampNumber(nutrient.metadata.digestScore, 0, 1, 0.5)
        : undefined;
    const key = `${nutrient.source}|${nutrient.category}|${normalizeHeadlineKey(nutrient.label)}|${normalizeHeadlineKey(
      nutrient.value
    )}`;
    if (dedup.has(key)) return;
    dedup.set(key, {
      id: `evidence:${lane}:${index}:${nutrient.id}`,
      lane: nutrient.source === "onchain" ? "onchain" : lane,
      nutrientId: nutrient.id,
      source: nutrient.source,
      label: sanitizeTweetText(nutrient.label).slice(0, 110),
      value: sanitizeTweetText(nutrient.value).slice(0, 80),
      summary: sanitizeTweetText(nutrient.evidence || `${nutrient.label} ${nutrient.value}`).slice(0, 180),
      trust: clampNumber(nutrient.trust, 0.05, 0.99, 0.52),
      freshness: clampNumber(nutrient.freshness, 0.05, 0.99, 0.7),
      digestScore,
      capturedAt: nutrient.capturedAt || new Date().toISOString(),
    });
  });
  return Array.from(dedup.values())
    .sort((a, b) => {
      const aScore = (a.digestScore ?? 0.55) * a.trust * a.freshness;
      const bScore = (b.digestScore ?? 0.55) * b.trust * b.freshness;
      return bScore - aScore;
    })
    .slice(0, Math.floor(limit));
}

export function computeLaneUsageWindow(recentPosts: RecentPostRecord[]): LaneUsageWindow {
  const byLane: Record<TrendLane, number> = {
    protocol: 0,
    ecosystem: 0,
    regulation: 0,
    macro: 0,
    onchain: 0,
    "market-structure": 0,
  };

  recentPosts.forEach((post) => {
    const lane = inferTrendLane(post.content);
    byLane[lane] += 1;
  });

  return {
    totalPosts: recentPosts.length,
    byLane,
  };
}

export function planEventEvidenceAct(params: {
  events: TrendEvent[];
  evidence: OnchainEvidence[];
  recentPosts: RecentPostRecord[];
  laneUsage?: LaneUsageWindow;
}): EventEvidencePlan | null {
  const events = Array.isArray(params.events) ? params.events : [];
  const evidence = Array.isArray(params.evidence) ? params.evidence : [];
  if (events.length === 0 || evidence.length < 2) {
    return null;
  }

  const laneUsage = params.laneUsage || computeLaneUsageWindow(params.recentPosts);
  const scored = events
    .map((event) => {
      const candidateEvidence = selectEvidenceForLane(event.lane, evidence).slice(0, 2);
      if (candidateEvidence.length < 2) {
        return null;
      }
      const projectedRatio = (laneUsage.byLane[event.lane] + 1) / Math.max(1, laneUsage.totalPosts + 1);
      const quotaLimited = projectedRatio > LANE_MAX_RATIO[event.lane];
      const novelty = calculateHeadlineNovelty(event.headline, params.recentPosts);
      const evidenceStrength =
        candidateEvidence.reduce((sum, item) => sum + item.trust * item.freshness, 0) / candidateEvidence.length;
      const score = event.trust * 0.42 + event.freshness * 0.2 + novelty * 0.22 + evidenceStrength * 0.16 - (quotaLimited ? 0.35 : 0);
      return {
        event,
        evidence: candidateEvidence,
        score,
        projectedRatio,
        quotaLimited,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return null;
  }

  const preferred = scored.find((row) => !row.quotaLimited) || scored[0];
  return {
    lane: preferred.event.lane,
    event: preferred.event,
    evidence: preferred.evidence,
    laneUsage,
    laneProjectedRatio: Math.round(preferred.projectedRatio * 1000) / 1000,
    laneQuotaLimited: preferred.quotaLimited,
  };
}

export function validateEventEvidenceContract(
  text: string,
  plan: EventEvidencePlan
): { ok: boolean; reason?: string; eventHit: boolean; evidenceHitCount: number } {
  const normalized = sanitizeTweetText(text).toLowerCase();
  const eventTokens = [...new Set([...plan.event.keywords, ...extractHeadlineTokens(plan.event.headline)])]
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 3)
    .slice(0, 8);
  const eventHit = eventTokens.some((token) => normalized.includes(token));

  let evidenceHitCount = 0;
  for (const evidence of plan.evidence.slice(0, 2)) {
    const tokens = buildEvidenceAnchorTokens(evidence);
    const hit = tokens.some((token) => {
      if (!token) return false;
      if (normalized.includes(token)) return true;
      if (token.startsWith("$") && normalized.includes(token.slice(1))) return true;
      return false;
    });
    if (hit) evidenceHitCount += 1;
  }

  if (!eventHit) {
    return {
      ok: false,
      reason: "event anchor missing",
      eventHit,
      evidenceHitCount,
    };
  }
  if (evidenceHitCount < 2) {
    return {
      ok: false,
      reason: "evidence anchor < 2",
      eventHit,
      evidenceHitCount,
    };
  }
  return {
    ok: true,
    eventHit,
    evidenceHitCount,
  };
}

export function buildEventEvidenceFallbackPost(
  plan: EventEvidencePlan,
  postAngle: string,
  language: "ko" | "en",
  maxChars: number = 220
): string {
  const eventHeadline = sanitizeTweetText(plan.event.headline).replace(/\.$/, "");
  const evidenceA = formatEvidenceAnchor(plan.evidence[0], language);
  const evidenceB = formatEvidenceAnchor(plan.evidence[1], language);
  const laneLabel = laneDisplayName(plan.lane, language);
  const base =
    language === "ko"
      ? `${laneLabel} 이슈: ${eventHeadline}. 근거1 ${evidenceA}. 근거2 ${evidenceB}. ${postAngle} 관점으로 추가 확인 중.`
      : `${laneLabel} event: ${eventHeadline}. Evidence 1: ${evidenceA}. Evidence 2: ${evidenceB}. Tracking follow-through from a ${postAngle} lens.`;
  return sanitizeTweetText(base).slice(0, Math.max(120, Math.min(280, Math.floor(maxChars))));
}

export function inferTrendLane(text: string): TrendLane {
  const normalized = sanitizeTweetText(text).toLowerCase();
  for (const lane of TREND_LANES) {
    if (LANE_KEYWORDS[lane].test(normalized)) {
      return lane;
    }
  }
  return "market-structure";
}

function calculateHeadlineNovelty(headline: string, recentPosts: RecentPostRecord[]): number {
  const normalizedHeadline = sanitizeTweetText(headline).toLowerCase();
  if (!normalizedHeadline) return 0.4;
  const recent = recentPosts.slice(-16).map((post) => sanitizeTweetText(post.content).toLowerCase());
  if (recent.length === 0) return 0.9;
  const overlapCount = recent.filter((text) => text.includes(normalizedHeadline)).length;
  if (overlapCount >= 2) return 0.2;
  if (overlapCount === 1) return 0.45;
  return 0.82;
}

function selectEvidenceForLane(lane: TrendLane, evidence: OnchainEvidence[]): OnchainEvidence[] {
  const laneMatched = evidence.filter((item) => item.lane === lane);
  const onchainMatched = evidence.filter((item) => item.lane === "onchain" && item.lane !== lane);
  const others = evidence.filter((item) => item.lane !== lane && item.lane !== "onchain");
  return dedupEvidence([...laneMatched, ...onchainMatched, ...others]);
}

function dedupEvidence(items: OnchainEvidence[]): OnchainEvidence[] {
  const dedup = new Map<string, OnchainEvidence>();
  items.forEach((item) => {
    const key = `${item.lane}|${normalizeHeadlineKey(item.label)}|${normalizeHeadlineKey(item.value)}`;
    if (!dedup.has(key)) {
      dedup.set(key, item);
    }
  });
  return Array.from(dedup.values()).sort((a, b) => {
    const aScore = (a.digestScore ?? 0.55) * a.trust * a.freshness;
    const bScore = (b.digestScore ?? 0.55) * b.trust * b.freshness;
    return bScore - aScore;
  });
}

function buildEvidenceAnchorTokens(evidence: OnchainEvidence): string[] {
  const merged = `${evidence.label} ${evidence.value} ${evidence.summary}`.toLowerCase();
  const tokens = merged.match(/\$[a-z]{2,10}\b|[a-z][a-z0-9-]{2,}|[가-힣]{2,}/g) || [];
  return [...new Set(tokens.filter((token) => !EVIDENCE_TOKEN_STOP_WORDS.has(token)).slice(0, 8))];
}

function formatEvidenceAnchor(evidence: OnchainEvidence | undefined, language: "ko" | "en"): string {
  if (!evidence) {
    return language === "ko" ? "데이터 확인 중" : "data pending";
  }
  if (language === "ko") {
    return `${evidence.label} ${evidence.value}`.replace(/\s+/g, " ").trim().slice(0, 70);
  }
  return `${evidence.label} ${evidence.value}`.replace(/\s+/g, " ").trim().slice(0, 70);
}

function laneDisplayName(lane: TrendLane, language: "ko" | "en"): string {
  const ko: Record<TrendLane, string> = {
    protocol: "프로토콜",
    ecosystem: "생태계",
    regulation: "규제",
    macro: "매크로",
    onchain: "온체인",
    "market-structure": "시장구조",
  };
  const en: Record<TrendLane, string> = {
    protocol: "Protocol",
    ecosystem: "Ecosystem",
    regulation: "Regulation",
    macro: "Macro",
    onchain: "On-chain",
    "market-structure": "Market structure",
  };
  return language === "ko" ? ko[lane] : en[lane];
}

function extractHeadlineTokens(headline: string): string[] {
  const text = sanitizeTweetText(headline).toLowerCase();
  const tickerTokens = text.match(/\$[a-z]{2,10}\b/g) || [];
  const wordTokens = text.match(/[a-z][a-z0-9-]{2,}|[가-힣]{2,}/g) || [];

  const merged = [...tickerTokens, ...wordTokens]
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .filter((token) => !EVIDENCE_TOKEN_STOP_WORDS.has(token))
    .filter((token) => !/^\d+$/.test(token))
    .slice(0, 10);

  return [...new Set(merged)];
}

function normalizeHeadlineKey(text: string): string {
  return sanitizeTweetText(text)
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]/g, "")
    .slice(0, 80);
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}
