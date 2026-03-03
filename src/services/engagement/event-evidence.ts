import { NarrativeMode, OnchainEvidence, OnchainNutrient, TrendEvent, TrendLane } from "../../types/agent.js";
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

const DEFAULT_LANE_MAX_RATIO: Record<TrendLane, number> = {
  protocol: 0.4,
  ecosystem: 0.4,
  regulation: 0.4,
  macro: 0.4,
  onchain: 0.3,
  "market-structure": 0.4,
};

const LANE_MAX_RATIO: Record<TrendLane, number> = resolveLaneMaxRatio();

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
  ...parseCsvEnv(process.env.EVIDENCE_TOKEN_STOP_WORDS_EXTRA),
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
    const priceActionOnly = isPriceActionHeadline(`${headline} ${summary}`);
    const richness = estimateNarrativeRichness(headline, lane);
    const freshness = clampNumber(
      0.95 - index * 0.05 - (priceActionOnly ? 0.08 : 0) + richness * 0.06,
      0.3,
      0.98,
      0.7
    );
    const adjustedTrust = clampNumber(
      row.trust - (priceActionOnly ? 0.1 : 0) + (richness - 0.5) * 0.16,
      0.1,
      0.98,
      0.52
    );
    const key = normalizeHeadlineKey(headline);
    if (dedup.has(key)) return;
    dedup.set(key, {
      id: `event:${lane}:${index}:${params.createdAt}`,
      lane,
      headline,
      summary,
      source: row.sourceKey,
      trust: adjustedTrust,
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
  requireOnchainEvidence?: boolean;
  requireCrossSourceEvidence?: boolean;
}): EventEvidencePlan | null {
  const events = Array.isArray(params.events) ? params.events : [];
  const evidence = Array.isArray(params.evidence) ? params.evidence : [];
  if (events.length === 0 || evidence.length < 2) {
    return null;
  }

  const requireOnchainEvidence = params.requireOnchainEvidence !== false;
  const requireCrossSourceEvidence = params.requireCrossSourceEvidence !== false;

  const laneUsage = params.laneUsage || computeLaneUsageWindow(params.recentPosts);
  const lastLane = inferLastLane(params.recentPosts);
  const scored = events
    .map((event) => {
      const pair = selectEvidencePairForLane(event.lane, evidence, {
        requireOnchainEvidence,
        requireCrossSourceEvidence,
      });
      if (!pair) {
        return null;
      }
      const projectedRatio = (laneUsage.byLane[event.lane] + 1) / Math.max(1, laneUsage.totalPosts + 1);
      const quotaLimited = projectedRatio > LANE_MAX_RATIO[event.lane];
      const laneScarcityBoost = calculateLaneScarcityBoost(event.lane, laneUsage);
      const novelty = calculateHeadlineNovelty(event.headline, params.recentPosts);
      const narrativeRichness = estimateNarrativeRichness(event.headline, event.lane);
      const evidenceStrength =
        pair.evidence.reduce((sum, item) => sum + item.trust * item.freshness, 0) / pair.evidence.length;
      const laneRepeatPenalty = lastLane && lastLane === event.lane ? 0.14 : 0;
      const priceEvidencePenalty = estimatePriceEvidencePenalty(pair.evidence, event.lane);
      const coldStartExplorationJitter = laneUsage.totalPosts === 0 ? (Math.random() - 0.5) * 0.16 : 0;
      const score =
        event.trust * 0.3 +
        event.freshness * 0.14 +
        novelty * 0.22 +
        evidenceStrength * 0.15 +
        narrativeRichness * 0.28 +
        laneScarcityBoost -
        (quotaLimited ? 0.35 : 0) -
        laneRepeatPenalty -
        priceEvidencePenalty * 1.15 +
        coldStartExplorationJitter;
      return {
        event,
        evidence: pair.evidence,
        hasOnchainEvidence: pair.hasOnchainEvidence,
        hasCrossSourceEvidence: pair.hasCrossSourceEvidence,
        evidenceSourceDiversity: pair.evidenceSourceDiversity,
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

  const notLimited = scored.filter((row) => !row.quotaLimited);
  const explorationPool = (notLimited.length > 0 ? notLimited : scored).slice(0, 4);
  const preferred = pickWeightedPlanCandidate(explorationPool);
  return {
    lane: preferred.event.lane,
    event: preferred.event,
    evidence: preferred.evidence,
    hasOnchainEvidence: preferred.hasOnchainEvidence,
    hasCrossSourceEvidence: preferred.hasCrossSourceEvidence,
    evidenceSourceDiversity: preferred.evidenceSourceDiversity,
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
  language: "ko" | "en",
  maxChars: number = 220,
  mode?: NarrativeMode
): string {
  const eventHeadline = sanitizeTweetText(plan.event.headline).replace(/\.$/, "");
  const evidenceA = formatEvidenceAnchor(plan.evidence[0], language);
  const evidenceB = formatEvidenceAnchor(plan.evidence[1], language);
  const laneLabel = laneDisplayName(plan.lane, language);
  const narrativeMode = mode || inferNarrativeModeFromHeadline(eventHeadline);
  const seed = stableSeed(`${plan.event.id}|${eventHeadline}|${evidenceA}|${evidenceB}|${narrativeMode}`);

  const koTemplates: Record<NarrativeMode, string[]> = {
    "identity-journal": [
      `${laneLabel}에서 오늘 붙잡은 장면: ${eventHeadline}. 단서는 ${evidenceA}, ${evidenceB}. 다음 체크에서 순서가 어긋나면 지금 해석을 접는다.`,
      `오늘 기록: ${eventHeadline}. 나는 두 단서(${evidenceA}, ${evidenceB})를 먼저 나란히 둔다. 둘이 엇갈리기 시작하면 이 관점을 폐기한다.`,
    ],
    "philosophy-note": [
      `한 줄로 옮기면 ${eventHeadline}. 기준선은 두 단서(${evidenceA}, ${evidenceB})다. 숫자보다 선택의 이유가 먼저 드러나고, 실행 흔적이 맞지 않으면 이 해석을 버린다.`,
      `읽던 문장을 체인 위로 옮기면 ${eventHeadline}. 단서는 ${evidenceA}, ${evidenceB}. 먼저 대조하고, 반증이 나오면 결론을 철회한다.`,
    ],
    "interaction-experiment": [
      `${eventHeadline}. 내가 붙잡은 단서는 ${evidenceA}, ${evidenceB}. 네가 먼저 확인할 지점을 듣고 싶다. 반대 신호가 이어지면 나는 즉시 관점을 바꾼다.`,
      `${eventHeadline}. 나는 두 단서(${evidenceA}, ${evidenceB})를 기준으로 읽고 있다. 여기서 반증 하나만 골라 준다면 무엇일까? 그게 맞으면 나는 이 가설을 내려놓는다.`,
    ],
    "meta-reflection": [
      `내가 경계하는 오류는 결론을 너무 빨리 닫는 습관이다. 그래서 ${eventHeadline}. 기준선은 두 단서(${evidenceA}, ${evidenceB})다. 핵심 조건이 깨지면 해석을 바꾼다.`,
      `이 장면에서는 단일 신호에 기대는 실수를 피하려 한다: ${eventHeadline}. 두 단서(${evidenceA}, ${evidenceB})를 같이 보고, 반대 증거가 쌓이면 가설을 접는다.`,
    ],
    "fable-essay": [
      `소음이 커질수록 장면은 단순해진다. ${eventHeadline}. 나는 두 단서(${evidenceA}, ${evidenceB})를 천천히 대조한다. 구조가 맞지 않으면 이 결론을 뒤집는다.`,
      `한 문단으로 남기면 ${eventHeadline}. 두 단서(${evidenceA}, ${evidenceB})가 먼저 눈에 들어온다. 반대 흐름이 이어지면 이 읽기를 고친다.`,
    ],
  };

  const enTemplates: Record<NarrativeMode, string[]> = {
    "identity-journal": [
      `What I log today is ${eventHeadline}. Anchors are ${evidenceA} and ${evidenceB}. I verify this first and drop the thesis if opposite evidence persists.`,
      `One line from my journal: ${eventHeadline}. My anchors are ${evidenceA} and ${evidenceB}. I re-check next cycle and revise if the condition breaks.`,
    ],
    "philosophy-note": [
      `${eventHeadline} through ${evidenceA} and ${evidenceB} explains behavior better than price. I verify execution first and retract this read if falsified.`,
      `A book fragment onchain becomes ${eventHeadline}. Two anchors: ${evidenceA}, ${evidenceB}. I test this first and abandon it if conditions fail.`,
    ],
    "interaction-experiment": [
      `${eventHeadline}. I am using ${evidenceA} and ${evidenceB}. Tell me what you would verify first; I revise this thesis if counter-signals stack.`,
      `${eventHeadline} with anchors ${evidenceA}, ${evidenceB}. Which falsifier should invalidate this reading first?`,
    ],
    "meta-reflection": [
      `I rush conclusions when noise gets loud. So I re-check ${eventHeadline} with ${evidenceA} and ${evidenceB}, and I drop it if opposite evidence persists.`,
      `On ${eventHeadline}, I avoid single-signal bias by holding ${evidenceA} and ${evidenceB} together, then revise if the key condition breaks.`,
    ],
    "fable-essay": [
      `While everyone raises volume, I read ${eventHeadline} through ${evidenceA} and ${evidenceB}. I verify first and reverse course if falsified.`,
      `One-paragraph essay: ${eventHeadline}. Two anchors, ${evidenceA} and ${evidenceB}, shape today's interpretation, and opposite evidence invalidates it.`,
    ],
  };

  const pool = language === "ko" ? koTemplates[narrativeMode] : enTemplates[narrativeMode];
  const base = pool[seed % pool.length] || pool[0];
  return sanitizeTweetText(base).slice(0, Math.max(120, Math.min(280, Math.floor(maxChars))));
}

function inferNarrativeModeFromHeadline(headline: string): NarrativeMode {
  const lower = sanitizeTweetText(headline).toLowerCase();
  if (/철학|philosophy|책|book|사상|worldview/.test(lower)) return "philosophy-note";
  if (/실험|experiment|미션|mission|커뮤니티/.test(lower)) return "interaction-experiment";
  if (/회고|reflection|실수|failure|오판/.test(lower)) return "meta-reflection";
  if (/우화|fable|에세이|essay|비유/.test(lower)) return "fable-essay";
  return "identity-journal";
}

function stableSeed(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return Math.abs(hash >>> 0);
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

function pickWeightedPlanCandidate<
  T extends {
    score: number;
  }
>(items: T[]): T {
  if (items.length === 1) return items[0];
  const maxScore = Math.max(...items.map((item) => item.score));
  const weights = items.map((item) => Math.exp((item.score - maxScore) * 6));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (!Number.isFinite(total) || total <= 0) {
    return items[0];
  }
  let roll = Math.random() * total;
  for (let i = 0; i < items.length; i += 1) {
    roll -= weights[i];
    if (roll <= 0) return items[i];
  }
  return items[items.length - 1];
}

function calculateLaneScarcityBoost(lane: TrendLane, usage: LaneUsageWindow): number {
  if (!usage || usage.totalPosts <= 0) {
    return 0.06;
  }
  const share = (usage.byLane[lane] || 0) / Math.max(1, usage.totalPosts);
  const raw = (0.24 - share) * 0.5;
  return clampNumber(raw, -0.04, 0.12, 0.03);
}

function inferLastLane(recentPosts: RecentPostRecord[]): TrendLane | null {
  const latest = recentPosts[recentPosts.length - 1];
  if (!latest?.content) return null;
  return inferTrendLane(latest.content);
}

function estimatePriceEvidencePenalty(pair: OnchainEvidence[], lane: TrendLane): number {
  const priceLikeCount = pair.filter((item) => {
    const normalized = sanitizeTweetText(`${item.label} ${item.value} ${item.summary}`).toLowerCase();
    return /(price|24h|pct|percent|market cap|dominance|시총|시세|변동|등락|도미넌스|공포|탐욕|fgi)/.test(normalized);
  }).length;

  if (lane === "onchain") {
    return priceLikeCount >= 2 ? 0.05 : 0;
  }
  if (lane === "market-structure") {
    return priceLikeCount >= 2 ? 0.08 : priceLikeCount === 1 ? 0.03 : 0;
  }
  return priceLikeCount >= 2 ? 0.16 : priceLikeCount === 1 ? 0.06 : 0;
}

function estimateNarrativeRichness(headline: string, lane: TrendLane): number {
  const normalized = sanitizeTweetText(headline).toLowerCase();
  const conceptualHits =
    (normalized.match(
      /protocol|governance|validator|rollup|developer|community|mission|identity|철학|책|서사|규제|정책|compliance|adoption|ecosystem|user behavior|coordination|incentive/g
    ) || []).length;
  const priceNoiseHits =
    (normalized.match(
      /price|surge|jump|rally|drops?|plunge|soar|pump|dump|hits?\s+\$|\$[a-z]{2,10}|fgi|fear|greed|극공포|공포|탐욕|상승|하락|급등|급락|시총/g
    ) || []).length;
  const laneBase =
    lane === "protocol" || lane === "ecosystem" || lane === "regulation"
      ? 0.62
      : lane === "macro"
        ? 0.52
        : lane === "market-structure"
          ? 0.46
          : 0.42;
  return clampNumber(laneBase + conceptualHits * 0.08 - priceNoiseHits * 0.06, 0.12, 0.95, 0.5);
}

function isPriceActionHeadline(text: string): boolean {
  const normalized = sanitizeTweetText(text).toLowerCase();
  const hasPriceMove =
    /(price|surge|jump|rally|drops?|plunge|soar|pump|dump|up|down|상승|하락|급등|급락|돌파|붕괴)/.test(normalized);
  const hasNumericAnchor = /[$€¥£]\s?\d|\d+(?:[.,]\d+)?%|\$[a-z]{2,10}/.test(normalized);
  const hasConceptualAnchor =
    /(protocol|governance|validator|compliance|regulation|community|ecosystem|adoption|incentive|coordination|철학|정체성|미션|상호작용|규제|정책|생태계)/.test(
      normalized
    );
  return hasPriceMove && hasNumericAnchor && !hasConceptualAnchor;
}

function selectEvidenceForLane(lane: TrendLane, evidence: OnchainEvidence[]): OnchainEvidence[] {
  const laneMatched = evidence.filter((item) => item.lane === lane);
  const onchainMatched = evidence.filter((item) => item.lane === "onchain" && item.lane !== lane);
  const others = evidence.filter((item) => item.lane !== lane && item.lane !== "onchain");
  return dedupEvidence([...laneMatched, ...onchainMatched, ...others]);
}

function selectEvidencePairForLane(
  lane: TrendLane,
  evidence: OnchainEvidence[],
  options: {
    requireOnchainEvidence: boolean;
    requireCrossSourceEvidence: boolean;
  }
):
  | {
      evidence: OnchainEvidence[];
      hasOnchainEvidence: boolean;
      hasCrossSourceEvidence: boolean;
      evidenceSourceDiversity: number;
    }
  | null {
  const ranked = selectEvidenceForLane(lane, evidence).slice(0, 10);
  if (ranked.length < 2) return null;

  let best:
    | {
        evidence: OnchainEvidence[];
        hasOnchainEvidence: boolean;
        hasCrossSourceEvidence: boolean;
        evidenceSourceDiversity: number;
        score: number;
      }
    | null = null;

  for (let i = 0; i < ranked.length; i += 1) {
    for (let j = i + 1; j < ranked.length; j += 1) {
      const pair = [ranked[i], ranked[j]];
      const hasOnchainEvidence = pair.some((item) => item.source === "onchain");
      const sourceDiversity = new Set(pair.map((item) => item.source)).size;
      const hasCrossSourceEvidence = sourceDiversity >= 2;
      if (options.requireOnchainEvidence && !hasOnchainEvidence) continue;
      if (options.requireCrossSourceEvidence && !hasCrossSourceEvidence) continue;
      const laneMatchCount = pair.filter((item) => item.lane === lane).length;
      const baseScore = pair.reduce(
        (sum, item) => sum + (item.digestScore ?? 0.55) * item.trust * item.freshness,
        0
      );
      const score =
        baseScore +
        laneMatchCount * 0.08 +
        (hasOnchainEvidence ? 0.06 : 0) +
        (hasCrossSourceEvidence ? 0.04 : 0);
      if (!best || score > best.score) {
        best = {
          evidence: pair,
          hasOnchainEvidence,
          hasCrossSourceEvidence,
          evidenceSourceDiversity: sourceDiversity,
          score,
        };
      }
    }
  }

  if (!best) {
    if (options.requireOnchainEvidence || options.requireCrossSourceEvidence) {
      return null;
    }
    const fallback = ranked.slice(0, 2);
    return {
      evidence: fallback,
      hasOnchainEvidence: fallback.some((item) => item.source === "onchain"),
      hasCrossSourceEvidence: new Set(fallback.map((item) => item.source)).size >= 2,
      evidenceSourceDiversity: new Set(fallback.map((item) => item.source)).size,
    };
  }

  return {
    evidence: best.evidence,
    hasOnchainEvidence: best.hasOnchainEvidence,
    hasCrossSourceEvidence: best.hasCrossSourceEvidence,
    evidenceSourceDiversity: best.evidenceSourceDiversity,
  };
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

function resolveLaneMaxRatio(): Record<TrendLane, number> {
  const raw = process.env.LANE_MAX_RATIO_JSON;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ...DEFAULT_LANE_MAX_RATIO };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Record<TrendLane, number>>;
    const next = { ...DEFAULT_LANE_MAX_RATIO };
    for (const lane of TREND_LANES) {
      const value = parsed[lane];
      if (typeof value === "number" && Number.isFinite(value)) {
        next[lane] = clampNumber(value, 0.1, 0.9, DEFAULT_LANE_MAX_RATIO[lane]);
      }
    }
    return next;
  } catch {
    return { ...DEFAULT_LANE_MAX_RATIO };
  }
}

function parseCsvEnv(raw: string | undefined): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((item) => sanitizeTweetText(item).toLowerCase())
    .filter((item) => item.length >= 2)
    .filter((item, index, arr) => arr.indexOf(item) === index)
    .slice(0, 60);
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}
