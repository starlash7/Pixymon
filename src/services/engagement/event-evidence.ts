import { NarrativeMode, OnchainEvidence, OnchainNutrient, SignalDirection, TrendEvent, TrendLane } from "../../types/agent.js";
import { EventEvidencePlan, LaneUsageWindow, RecentPostRecord } from "./types.js";
import { NewsItem } from "../blockchain-news.js";
import { sanitizeTweetText } from "./quality.js";
import { applyKoNarrativeLexicon } from "../narrative-lexicon.js";
import { buildKoIdentityWriterCandidate } from "./identity-writer.js";

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
  regulation: /sec|cftc|lawsuit|regulation|regulatory|policy|compliance|court|etf\s*approval|규제|정책|집행|컴플라이언스|소송|법안|당국/,
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
    const rawHeadline = stripPublicKoHeadlinePrefix(sanitizeTweetText(row.item.title || "")).slice(0, 160);
    const summary = sanitizeTweetText(row.item.summary || row.item.title || "").slice(0, 220);
    const inferredLane = inferTrendLane([rawHeadline, row.item.category, summary].join(" "));
    const headline = localizeTrendHeadline(rawHeadline, inferredLane, summary).slice(0, 160);
    const localizedLane = inferTrendLane(headline);
    const lane = localizedLane !== "market-structure" ? localizedLane : inferredLane;
    if (headline.length < 12) return;
    if (isLowQualityTrendHeadline(headline, summary)) return;
    const priceHeadlinePenalty = estimateHeadlineCommodityPenalty(headline, summary, lane);
    const richness = estimateNarrativeRichness(headline, lane);
    const freshness = clampNumber(
      0.95 - index * 0.05 - priceHeadlinePenalty * 0.28 + richness * 0.06,
      0.3,
      0.98,
      0.7
    );
    const adjustedTrust = clampNumber(
      row.trust - priceHeadlinePenalty * 0.42 + (richness - 0.5) * 0.16,
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
    const humanized = humanizeEvidenceForNarrative(nutrient);
    const digestScore =
      typeof nutrient.metadata?.digestScore === "number"
        ? clampNumber(nutrient.metadata.digestScore, 0, 1, 0.5)
        : undefined;
    const key = `${nutrient.source}|${nutrient.category}|${normalizeHeadlineKey(humanized.label)}|${normalizeHeadlineKey(
      humanized.value
    )}`;
    if (dedup.has(key)) return;
    dedup.set(key, {
      id: `evidence:${lane}:${index}:${nutrient.id}`,
      lane: nutrient.source === "onchain" ? "onchain" : lane,
      nutrientId: nutrient.id,
      source: nutrient.source,
      label: humanized.label.slice(0, 110),
      value: humanized.value.slice(0, 80),
      summary: humanized.summary.slice(0, 180),
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

export function buildStructuralFallbackEventsFromEvidence(
  evidence: OnchainEvidence[],
  createdAt: string,
  maxItems: number = 4
): TrendEvent[] {
  const cleaned = dedupEvidence(evidence).filter((item) => {
    if (isLowSignalEvidenceForEvent(item)) return false;
    if (item.lane === "onchain") {
      return !countPriceLikeEvidence([item]) && (!isFeeLikeEvidence(item) || isConcreteNarrativeEvidence(item, "onchain"));
    }
    return isConcreteNarrativeEvidence(item, item.lane);
  });
  if (cleaned.length < 2) return [];

  const candidates = TREND_LANES.map((lane) => {
    const lanePool = cleaned.filter((item) => item.lane === lane);
    if (lane === "onchain" && lanePool.length < 2) return null;
    if (lane !== "onchain" && lanePool.length < 1) return null;
    const onchainSupport =
      lane === "onchain" ? [] : cleaned.filter((item) => item.source === "onchain" && item.lane === "onchain");
    const pool = dedupEvidence([...lanePool, ...onchainSupport]).filter((item) => !isLowSignalEvidenceForEvent(item));
    if (pool.length < 2) return null;

    const pair = selectEvidencePairForLane(lane, pool, {
      requireOnchainEvidence: lane === "onchain",
      requireCrossSourceEvidence: false,
    });
    if (!pair) return null;

    const [primary, secondary] = pair.evidence;
    if (!primary || !secondary) return null;

    const trust = clampNumber((primary.trust + secondary.trust) / 2, 0.18, 0.96, 0.68);
    const freshness = clampNumber((primary.freshness + secondary.freshness) / 2, 0.18, 0.98, 0.74);
    const headline = buildStructuralHeadlineFromEvidence(lane, primary, secondary);
    if (!headline || isLowQualityTrendHeadline(headline)) return null;
    const summary = buildStructuralSummaryFromEvidence(lane, primary, secondary);
    const keywords = [...extractHeadlineTokens(primary.label), ...extractHeadlineTokens(secondary.label)].slice(0, 6);
    const specificity =
      (estimateEvidenceSpecificity(primary, lane) + estimateEvidenceSpecificity(secondary, lane)) / 2;

    return {
      id: `event:fallback:${lane}:${normalizeHeadlineKey(primary.label)}:${normalizeHeadlineKey(secondary.label)}:${createdAt}`,
      lane,
      headline,
      summary,
      source: "evidence:structural-fallback",
      trust,
      freshness,
      capturedAt: createdAt,
      keywords,
      score:
        (primary.digestScore ?? 0.58) * primary.trust * primary.freshness +
        (secondary.digestScore ?? 0.58) * secondary.trust * secondary.freshness +
        specificity * 0.28 +
        (primary.source === "onchain" || secondary.source === "onchain" ? 0.08 : 0),
    };
  })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(8, maxItems)))
    .map(({ score: _score, ...event }) => event);

  return candidates;
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
  const structurallyRichEvents = events.filter(
    (event) => estimateHeadlineCommodityPenalty(event.headline, event.summary, event.lane) < 0.18
  );
  const commodityEvents = events.filter(
    (event) => estimateHeadlineCommodityPenalty(event.headline, event.summary, event.lane) >= 0.18
  );
  const candidateEvents =
    structurallyRichEvents.length >= 1 && commodityEvents.length >= 1 ? structurallyRichEvents : events;
  const scored = candidateEvents
    .map((event) => {
      let pair = selectEvidencePairForLane(event.lane, evidence, {
        requireOnchainEvidence,
        requireCrossSourceEvidence,
      });
      if (!pair && event.source === "evidence:structural-fallback" && event.lane === "onchain") {
        pair = selectEvidencePairForLane(event.lane, evidence, {
          requireOnchainEvidence,
          requireCrossSourceEvidence: false,
        });
      }
      if (!pair) {
        return null;
      }
      if (event.lane === "onchain" && countPriceLikeEvidence(pair.evidence) > 0) {
        const onchainOnlyPair = selectEvidencePairForLane(event.lane, evidence, {
          requireOnchainEvidence,
          requireCrossSourceEvidence: false,
        });
        if (onchainOnlyPair && countPriceLikeEvidence(onchainOnlyPair.evidence) < countPriceLikeEvidence(pair.evidence)) {
          pair = onchainOnlyPair;
        }
      }
      if (event.lane === "onchain") {
        const onchainOnlyPair = selectEvidencePairForLane(event.lane, evidence, {
          requireOnchainEvidence,
          requireCrossSourceEvidence: false,
        });
        const currentWeakPenalty = estimateWeakEvidencePenalty(pair.evidence);
        const currentHasGenericExternal = pair.evidence.some(
          (item) =>
            item.source !== "onchain" &&
            /(외부 뉴스 흐름|외부 뉴스 반응|시장 반응|가격 분위기|실사용 실험|실사용 흐름|규제 쪽 실제 움직임|규제 일정|프로토콜 변화 신호|업그레이드 진행|업계 스트레스 신호|업계 스트레스)/.test(
              item.label
            )
        );
        if (
          onchainOnlyPair &&
          onchainOnlyPair.evidence.every((item) => item.source === "onchain") &&
          (countPriceLikeEvidence(onchainOnlyPair.evidence) < countPriceLikeEvidence(pair.evidence) ||
            estimateWeakEvidencePenalty(onchainOnlyPair.evidence) < currentWeakPenalty ||
            currentHasGenericExternal)
        ) {
          pair = onchainOnlyPair;
        }
      }
      const projectedRatio = (laneUsage.byLane[event.lane] + 1) / Math.max(1, laneUsage.totalPosts + 1);
      const quotaLimited = projectedRatio > LANE_MAX_RATIO[event.lane];
      const laneScarcityBoost = calculateLaneScarcityBoost(event.lane, laneUsage);
      const novelty = calculateHeadlineNovelty(event.headline, params.recentPosts);
      const narrativeRichness = estimateNarrativeRichness(event.headline, event.lane);
      const headlineCommodityPenalty = estimateHeadlineCommodityPenalty(event.headline, event.summary, event.lane);
      const evidenceStrength =
        pair.evidence.reduce((sum, item) => sum + item.trust * item.freshness, 0) / pair.evidence.length;
      const laneRepeatPenalty = lastLane && lastLane === event.lane ? 0.14 : 0;
      const priceEvidencePenalty = estimatePriceEvidencePenalty(pair.evidence, event.lane);
      const eventEvidenceMismatchPenalty = estimateEventEvidenceMismatchPenalty(event, pair.evidence);
      const coldStartExplorationJitter = laneUsage.totalPosts === 0 ? (Math.random() - 0.5) * 0.16 : 0;
      const score =
        event.trust * 0.3 +
        event.freshness * 0.14 +
        novelty * 0.22 +
        evidenceStrength * 0.15 +
        narrativeRichness * 0.28 +
        laneScarcityBoost -
        headlineCommodityPenalty * 1.25 -
        (quotaLimited ? 0.35 : 0) -
        laneRepeatPenalty -
        priceEvidencePenalty * 1.15 +
        eventEvidenceMismatchPenalty * -1.35 +
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
  const localizedHeadline = containsKorean(plan.event.headline)
    ? sanitizeTweetText(plan.event.headline)
    : localizeTrendHeadline(plan.event.headline, plan.lane, plan.event.summary || "");
  const eventTokens = [
    ...new Set([
      ...extractHeadlineTokens(localizedHeadline),
      ...expandLocalizedEventTokens([...plan.event.keywords, ...extractHeadlineTokens(plan.event.headline)]),
      ...plan.event.keywords,
      ...extractHeadlineTokens(plan.event.headline),
    ]),
  ]
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 2)
    .slice(0, 12);
  const laneAnchorTokens = buildLaneAnchorTokens(plan.lane);

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
  const rawEventHit = eventTokens.some((token) => normalized.includes(token));
  const laneAnchorHit = laneAnchorTokens.some((token) => normalized.includes(token));
  const eventHit = rawEventHit || (laneAnchorHit && evidenceHitCount >= 1);

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

function buildLaneAnchorTokens(lane: TrendLane): string[] {
  const aliasMap: Record<TrendLane, string[]> = {
    protocol: ["프로토콜", "업그레이드", "검증자", "합의", "테스트넷", "메인넷"],
    ecosystem: ["생태계", "실사용", "지갑", "커뮤니티", "채택", "개발자"],
    regulation: ["규제", "정책", "당국", "집행", "법원", "컴플라이언스"],
    macro: ["매크로", "달러", "금리", "거시", "물가", "유동성"],
    onchain: ["온체인", "체인", "주소", "멤풀", "수수료", "고래"],
    "market-structure": ["유동성", "거래소", "체결", "호가", "거래량", "시장"],
  };
  return aliasMap[lane] || [];
}

export function buildEventEvidenceFallbackPost(
  plan: EventEvidencePlan,
  language: "ko" | "en",
  maxChars: number = 220,
  mode?: NarrativeMode
): string {
  const stripKoHeadlinePrefix = (text: string): string => {
    let output = String(text || "").trim();
    for (let i = 0; i < 2; i += 1) {
      const next = output
        .replace(
          /^(?:오늘\s*다룰\s*핵심\s*이슈는|이번\s*글의\s*중심\s*쟁점은|한\s*줄\s*요약[:：]?|오늘\s*픽시몬이\s*보는\s*핵심\s*이슈는|픽시몬\s*메모의\s*중심\s*쟁점은|지금\s*픽시몬의\s*한\s*줄\s*요약은|픽시몬이\s*먼저\s*짚는\s*포인트는|픽시몬\s*기준으로\s*핵심만\s*말하면|오늘\s*픽시몬이\s*고른\s*핵심\s*장면은|픽시몬이\s*이번\s*사이클에서\s*먼저\s*확인할\s*이슈는|픽시몬\s*노트의\s*출발점은|(?:프로토콜|생태계|규제|매크로|온체인|시장구조)\s*(?:이슈|맥락|포인트)\s*[:：]?)\s*/i,
          ""
        )
        .trim();
      if (next === output) break;
      output = next;
    }
    return output;
  };
  const humanizeKoEventHeadline = (text: string): string => {
    const cleaned = stripKoHeadlinePrefix(sanitizeTweetText(text || "").replace(/[.!?]+$/g, "")).trim();
    if (!cleaned) return "핵심 쟁점부터 다시 정리한다";
    if (/[A-Za-z]{5,}/.test(cleaned)) {
      const localized = localizeTrendHeadline(cleaned, plan.lane, plan.event.summary || "");
      if (containsKorean(localized)) return localized;
    }
    const rewriteVariant = (...pool: string[]): string => pool[stableSeed(`${cleaned}|ko-event`) % pool.length];
    const exactRewriteMap: Record<string, string[]> = {
      "달러가 흔들릴 때 내러티브의 수명이 먼저 길어진다": [
        "달러가 흔들리는 날엔 숫자보다 이야기가 더 오래 남는다",
        "달러 쪽이 출렁이면 가격보다 서사가 오래 버틴다",
      ],
      "자유는 느림이 아니라 설명 가능한 합의라는 생각": [
        "자유라는 말은 결국 속도보다 설명 가능한 합의 쪽에서 더 또렷해진다",
        "요즘은 자유가 빠름보다 설명 가능한 합의에 더 가까워 보인다",
      ],
      "규제를 핑계로 삼는 순간 제품은 멈춘다": [
        "규제를 핑계로 멈춰 서는 순간 제품은 더 이상 자라지 못한다",
        "규제를 이유로 움직임을 멈추는 순간 제품은 금방 굳어 버린다",
      ],
    };
    const exactPool = exactRewriteMap[cleaned];
    if (exactPool?.length) return rewriteVariant(...exactPool);
    const importantMatch = cleaned.match(/^(.+?)보다\s+중요한\s+건\s+(.+)$/);
    if (importantMatch) {
      const left = importantMatch[1].trim();
      const right = importantMatch[2].trim();
      return rewriteVariant(
        `${left}보다 ${right} 쪽이 더 중요하게 느껴진다`,
        `이번엔 ${left}보다 ${right} 쪽을 먼저 붙잡게 된다`
      );
    }
    const retentionQuestionMatch = cleaned.match(/^(.+?)[은는]\s+(.+?)보다\s+오래\s+남는가$/);
    if (retentionQuestionMatch) {
      const left = retentionQuestionMatch[1].trim();
      const right = retentionQuestionMatch[2].trim();
      return rewriteVariant(
        `요즘은 ${left}가 ${right}보다 오래 남는지부터 다시 보게 된다`,
        `이번엔 ${left}가 ${right}보다 오래 남는 쪽인지부터 본다`
      );
    }
    if (/는가$/.test(cleaned)) return `${cleaned.replace(/는가$/, "는지가 계속 남는다")}`;
    if (/(인가|일까|될까|할까)$/.test(cleaned)) return `${cleaned} 하는 쪽이 계속 걸린다`;
    if (/생각$/.test(cleaned)) {
      return rewriteVariant(
        `${cleaned}이 오늘 유독 오래 남는다`,
        `오늘은 ${cleaned} 쪽으로 자꾸 다시 돌아오게 된다`
      );
    }
    const decideMatch = cleaned.match(/^(.+?)[은는]\s+(.+?)에서\s+먼저\s+결정된다$/);
    if (decideMatch) {
      const left = decideMatch[1].trim();
      const right = decideMatch[2].trim();
      return rewriteVariant(
        `${left}는 결국 ${right}에서 먼저 갈린다`,
        `요즘은 ${left}가 ${right}에서 먼저 정해지는 장면으로 읽힌다`
      );
    }
    const lagMatch = cleaned.match(/^(.+?)[은는]\s+짧아도\s+(.+?)[은는]\s+길다$/);
    if (lagMatch) {
      const left = lagMatch[1].trim();
      const right = lagMatch[2].trim();
      return rewriteVariant(
        `${left}는 금방 끝나는데 ${right}는 꼭 더 늦게 따라온다`,
        `${left}는 짧게 지나가도 ${right}는 생각보다 오래 남는다`
      );
    }
    if (/다$/.test(cleaned)) return cleaned;
    if (cleaned.length >= 12) {
      return rewriteVariant(
        `${cleaned} 쪽이 실제로 이어지는지 다시 본다`,
        `${cleaned}가 말에서 끝나는지 행동으로 이어지는지 다시 본다`
      );
    }
    return cleaned;
  };

  const eventHeadlineRaw = sanitizeTweetText(plan.event.headline).replace(/\.$/, "");
  const eventHeadline = language === "ko" ? humanizeKoEventHeadline(eventHeadlineRaw) : eventHeadlineRaw;
  const evidenceA = formatEvidenceAnchor(plan.evidence[0], language);
  const evidenceB = formatEvidenceAnchor(plan.evidence[1], language);
  const narrativeMode = resolveFallbackNarrativeMode(mode || inferNarrativeModeFromHeadline(eventHeadline));
  const seed = stableSeed(`${plan.event.id}|${eventHeadline}|${evidenceA}|${evidenceB}|${narrativeMode}`);

  if (language === "ko") {
    const worldviewByLane: Record<TrendLane, string> = {
      protocol: "신뢰는 발표보다 운영 기록에서 늦게 쌓인다",
      ecosystem: "사람이 남지 않으면 큰 서사도 금방 광고가 된다",
      regulation: "정책 문장보다 집행 흔적이 더 늦고 정확하다",
      macro: "큰 뉴스보다 자금 배치가 더 오래 진실을 끌고 간다",
      onchain: "온체인 숫자는 오래 남을 때만 단서가 된다",
      "market-structure": "화면 열기보다 실제 체결이 더 늦고 정확하다",
    };
    const signatureByLane: Record<TrendLane, string> = {
      protocol: "박수보다 복구 속도를 오래 본다",
      ecosystem: "재방문이 없는 열기는 오래 믿지 않는다",
      regulation: "기사보다 행동 편에 더 오래 남는다",
      macro: "해설보다 자금 습관 쪽을 더 늦게 믿는다",
      onchain: "하루도 못 버틴 숫자는 장식으로 본다",
      "market-structure": "돈이 안 붙은 자신감은 제일 먼저 버린다",
    };
    return buildKoIdentityWriterCandidate({
      headline: eventHeadline,
      primaryAnchor: evidenceA,
      secondaryAnchor: evidenceB,
      lane: plan.lane,
      mode: narrativeMode,
      worldviewHint: worldviewByLane[plan.lane],
      signatureBelief: signatureByLane[plan.lane],
      recentReflection: worldviewByLane[plan.lane],
      maxChars,
      seedHint: `${plan.event.id}|fallback|${narrativeMode}`,
    });
  }

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

  const pool = enTemplates[narrativeMode];
  const base = pool[seed % pool.length] || pool[0];
  return sanitizeTweetText(base).slice(0, Math.max(120, Math.min(280, Math.floor(maxChars))));
}

function resolveFallbackNarrativeMode(mode: NarrativeMode): NarrativeMode {
  if (mode === "interaction-experiment" || mode === "fable-essay") {
    return "identity-journal";
  }
  if (mode === "philosophy-note") {
    return "meta-reflection";
  }
  return mode;
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

function chooseKoPairParticle(token: string): "과" | "와" {
  const cleaned = sanitizeTweetText(token || "").trim();
  const last = cleaned.charCodeAt(cleaned.length - 1);
  if (!cleaned || last < 0xac00 || last > 0xd7a3) return "와";
  return (last - 0xac00) % 28 !== 0 ? "과" : "와";
}

function joinKoPair(left: string, right: string): string {
  const a = sanitizeTweetText(left || "").trim();
  const b = sanitizeTweetText(right || "").trim();
  if (!a) return b;
  if (!b) return a;
  return `${a}${chooseKoPairParticle(a)} ${b}`;
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

function countPriceLikeEvidence(pair: OnchainEvidence[]): number {
  return pair.filter((item) => {
    const normalized = sanitizeTweetText(`${item.label} ${item.value} ${item.summary}`).toLowerCase();
    return /(price|24h|pct|percent|market cap|dominance|시총|시세|변동|등락|도미넌스|공포|탐욕|fgi)/.test(normalized);
  }).length;
}

function containsKorean(text: string): boolean {
  return /[가-힣]/.test(text);
}

function isEnglishHeavyHeadline(text: string): boolean {
  const normalized = sanitizeTweetText(text);
  if (!normalized || containsKorean(normalized)) return false;
  const letters = (normalized.match(/[A-Za-z]/g) || []).length;
  const spaces = (normalized.match(/\s/g) || []).length;
  return letters >= 18 && spaces >= 2;
}

function isEnglishHeavyEvidence(text: string): boolean {
  const normalized = sanitizeTweetText(text);
  if (!normalized || containsKorean(normalized)) return false;
  const letters = (normalized.match(/[A-Za-z]/g) || []).length;
  return letters >= 12;
}

function humanizeEvidenceForNarrative(nutrient: OnchainNutrient): {
  label: string;
  value: string;
  summary: string;
} {
  const rawLabel = sanitizeTweetText(nutrient.label || "");
  const rawValue = sanitizeTweetText(nutrient.value || "");
  const rawEvidence = sanitizeTweetText(nutrient.evidence || `${rawLabel} ${rawValue}`);
  const normalized = `${rawLabel} ${rawValue} ${rawEvidence}`.toLowerCase();
  const source = String(nutrient.source || "");
  const direction = nutrient.direction || inferDirectionFromText(`${rawValue} ${rawEvidence}`);

  const rewrite = (label: string, value: string, summary: string) => ({
    label: sanitizeTweetText(label),
    value: sanitizeTweetText(value),
    summary: sanitizeTweetText(summary),
  });

  if (source === "onchain") {
    if (/수수료|sat\/vB|fee/.test(normalized)) {
      const feeValue = extractSignedNumber(rawValue);
      const feeDirection =
        direction !== "flat"
          ? direction
          : typeof feeValue === "number"
            ? feeValue >= 35
              ? "up"
              : feeValue <= 10
                ? "down"
                : "flat"
            : direction;
      const label =
        feeDirection === "up"
          ? "높아진 체인 사용 압박"
          : feeDirection === "down"
            ? "낮아진 체인 사용 압박"
            : "중립 체인 사용 압박";
      return rewrite(
        label,
        "",
        feeDirection === "up"
          ? "체인 사용 압박이 실제 혼잡과 과열로 이어지는지 봐야 하는 장면이다."
          : feeDirection === "down"
            ? "체인 사용 압박이 빠르게 풀린 상태가 유지되는지 봐야 하는 장면이다."
            : "체인 사용 압박이 아직 방향을 만들지 못한 구간인지 봐야 하는 장면이다."
      );
    }
    if (/멤풀|backlog|대기열|pending/.test(normalized)) {
      const backlogValue = extractSignedNumber(rawValue);
      const backlogDirection =
        direction !== "flat"
          ? direction
          : typeof backlogValue === "number"
            ? backlogValue > 150000
              ? "up"
              : backlogValue < 60000
                ? "down"
                : "flat"
            : direction;
      const label =
        backlogDirection === "up"
          ? "쌓이는 거래 대기 압박"
          : backlogDirection === "down"
            ? "풀리는 거래 대기 압박"
            : "중립 거래 대기 압박";
      return rewrite(
        label,
        "",
        backlogDirection === "up"
          ? "대기 거래 압박이 실제 체결 지연으로 이어지는지 볼 장면이다."
          : backlogDirection === "down"
            ? "밀린 거래 압박이 빠르게 해소되는지 확인할 장면이다."
            : "대기 거래 압박이 중립권에서 머무는지 확인할 장면이다."
      );
    }
    if (/고래|whale|대형주소|large wallet/.test(normalized)) {
      const label =
        direction === "up"
          ? "큰손 움직임 확대"
          : direction === "down"
            ? "큰손 움직임 둔화"
            : "큰손 움직임 정체";
      return rewrite(
        label,
        "",
        direction === "up"
          ? "큰손 움직임이 실제 방향 전환으로 이어지는지 볼 장면이다."
          : direction === "down"
            ? "큰손 움직임이 식으면서 시장 주도권이 바뀌는지 볼 장면이다."
            : "큰손 움직임이 아직 결론을 만들 정도로 커지지 않았는지 볼 장면이다."
      );
    }
    if (/스테이블|stablecoin|stable flow|stable supply/.test(normalized)) {
      const label =
        direction === "up"
          ? "대기 자금 유입"
          : direction === "down"
            ? "대기 자금 이탈"
            : "대기 자금 정체";
      return rewrite(
        label,
        "",
        direction === "up"
          ? "대기 자금이 실제 위험 선호로 번지는지 볼 장면이다."
          : direction === "down"
            ? "대기 자금이 빠지며 체인 안쪽 열기가 식는지 볼 장면이다."
            : "대기 자금이 아직 방향을 만들지 못한 채 머무는지 볼 장면이다."
      );
    }
    if (/거래소 순유입|exchange netflow|netflow/.test(normalized)) {
      const label =
        direction === "up"
          ? "거래소 쪽 자금 유입"
          : direction === "down"
            ? "거래소 쪽 자금 이탈"
            : "거래소 쪽 자금 정체";
      return rewrite(
        label,
        "",
        direction === "up"
          ? "거래소 쪽 자금이 실제 매도 압박으로 이어지는지 볼 장면이다."
          : direction === "down"
            ? "거래소 밖으로 빠지는 자금이 보관 전환인지 확인할 장면이다."
            : "거래소 쪽 자금 흐름이 방향을 못 만드는지 확인할 장면이다."
      );
    }
    if (/active address|address activity|wallet activity/.test(normalized)) {
      const label =
        direction === "up" ? "사용 지갑 증가" : direction === "down" ? "사용 지갑 둔화" : "사용 지갑 정체";
      return rewrite(label, "", "실사용이 실제로 다시 붙는지 볼 장면이다.");
    }
    if (/tvl/.test(normalized)) {
      const label = direction === "up" ? "TVL 유입" : direction === "down" ? "TVL 이탈" : "TVL 정체";
      return rewrite(label, "", "잠긴 자금이 실제로 돌아오는지 확인할 장면이다.");
    }
    return {
      label: applyKoNarrativeLexicon(rawLabel).trim() || rawLabel,
      value: applyKoNarrativeLexicon(rawValue).trim() || rawValue,
      summary: applyKoNarrativeLexicon(rawEvidence).trim() || rawEvidence,
    };
  }

  if (/fed|ecb|cpi|inflation|rates|treasury|dxy|usd|eur|eur\/usd|dollar/.test(normalized)) {
    if (/cpi|inflation/.test(normalized)) {
      const label =
        direction === "up"
          ? "물가 압력 확대"
          : direction === "down"
            ? "물가 압력 완화"
            : "물가 압력 정체";
      return rewrite(label, "", "물가 압력이 실제 위험 선호까지 번지는지 볼 장면이다.");
    }
    if (/rates|fed|ecb|treasury/.test(normalized)) {
      const label =
        direction === "up"
          ? "금리 기대 상향"
          : direction === "down"
            ? "금리 기대 완화"
            : "금리 기대 정체";
      return rewrite(label, "", "금리 기대 변화가 체인 안쪽 자금 태도까지 번지는지 볼 장면이다.");
    }
    if (/dxy|usd|dollar|eur|eur\/usd/.test(normalized)) {
      const label =
        direction === "up"
          ? "달러 강세"
          : direction === "down"
            ? "달러 약세"
            : "달러 정체";
      return rewrite(label, "", "달러 흐름이 체인 안쪽 자금 성격까지 바꾸는지 볼 장면이다.");
    }
    return rewrite("거시 압력 변화", "", "거시 흐름 변화가 체인 안쪽 자금 태도까지 번지는지 볼 장면이다.");
  }
  if (/court|lawsuit|sec|cftc|policy|regulation|regulatory|compliance|etf/.test(normalized)) {
    if (/sec.+cftc|cftc.+sec/.test(normalized)) {
      return rewrite("당국 공조 신호", "", "당국의 메시지가 실제 규칙 변화로 이어지는지 더 봐야 하는 장면이다.");
    }
    if (/etf/.test(normalized)) {
      if (/approval|approve|승인/.test(normalized)) {
        return rewrite("ETF 승인 기대", "", "ETF 승인 기대가 실제 자금 흐름까지 번지는지 확인할 장면이다.");
      }
      if (/filing|application|신청/.test(normalized)) {
        return rewrite("ETF 신청 일정", "", "ETF 신청 일정이 실제 기대를 키우는지 확인할 장면이다.");
      }
      return rewrite("ETF 심사 일정", "", "ETF 심사 일정이 실제 기대와 자금 흐름까지 번지는지 확인할 장면이다.");
    }
    if (/court|lawsuit/.test(normalized)) {
      if (/lawsuit|소송/.test(normalized)) {
        return rewrite("소송 일정", "", "소송 일정이 해석보다 더 오래 남는지 볼 장면이다.");
      }
      return rewrite("법원 일정", "", "법원 일정이 해석보다 더 오래 남는지 볼 장면이다.");
    }
    return rewrite("규제 집행 일정", "", "규제 해석보다 실제 집행 일정과 시장 반응의 간격을 볼 장면이다.");
  }
  if (/bankruptcy|chapter 11|liquidation|insolvency|distress|default/.test(normalized)) {
    return rewrite("업계 스트레스 확대", "", "업계 안쪽 압박이 실제 자금 이동으로 번지는지 확인할 장면이다.");
  }
  if (/upgrade|mainnet|testnet|validator|consensus|throughput|firedancer|rollup|fork/.test(normalized)) {
    if (/firedancer/.test(normalized)) {
      return rewrite("Firedancer 검증자 반응", "", "검증자 쪽 기대가 실제 운영 반응으로 이어지는지 볼 장면이다.");
    }
    if (/validator|consensus/.test(normalized)) {
      return rewrite("검증자 안정성", "", "검증자 쪽 움직임이 실제 운영 안정성으로 이어지는지 볼 장면이다.");
    }
    if (/mainnet|testnet/.test(normalized)) {
      return rewrite(/mainnet/.test(normalized) ? "메인넷 준비도" : "테스트넷 반응", "", "배포 일정이 실제 사용과 운영 반응까지 이어지는지 확인할 장면이다.");
    }
    return rewrite("업그레이드 운영 반응", "", "코드 변화가 실제 운영 흐름으로 이어지는지 확인할 장면이다.");
  }
  if (/ai agent|visa|prediction market|wallet|adoption|community|developer|ecosystem|app/.test(normalized)) {
    if (/visa/.test(normalized)) {
      return rewrite("Visa 실사용", "", "결제 인프라 쪽 얘기가 실제 사용 흐름까지 번지는지 볼 장면이다.");
    }
    if (/prediction market/.test(normalized)) {
      return rewrite("예측시장 사용", "", "예측시장 쪽 사용 습관이 실제 거래 행동을 바꾸는지 볼 장면이다.");
    }
    if (/wallet/.test(normalized)) {
      return rewrite("지갑 재방문", "", "지갑 안쪽 사용 습관이 서사보다 먼저 바뀌는지 볼 장면이다.");
    }
    if (/developer/.test(normalized)) {
      return rewrite("개발자 잔류", "", "개발자 쪽 움직임이 실제 생태계 습관으로 번지는지 볼 장면이다.");
    }
    if (/community/.test(normalized)) {
      return rewrite("커뮤니티 잔류", "", "커뮤니티 열기가 실제로 남는 사람 수로 이어지는지 볼 장면이다.");
    }
    return rewrite("실사용 잔류", "", "사람이 실제로 남는 흐름이 커지는지 볼 만한 장면이다.");
  }
  if (/spot volume|volume/.test(normalized)) {
    const label =
      direction === "up" ? "현물 거래량 확대" : direction === "down" ? "현물 거래량 둔화" : "현물 거래량 정체";
    return rewrite(label, "", "거래량이 실제 사용 열기까지 번지는지 볼 장면이다.");
  }
  if (/open interest|funding|liquidity|orderbook/.test(normalized)) {
    const label =
      direction === "up" ? "체결 쪽 유동성 확대" : direction === "down" ? "체결 쪽 유동성 둔화" : "체결 쪽 유동성 정체";
    return rewrite(label, "", "체결 쪽 유동성이 실제 과열과 냉각을 가르는지 볼 장면이다.");
  }
  if (/xrp|sol|altcoin|breakout|bitcoin-led|broad move|surge|rally|pump/.test(normalized)) {
    if (/xrp/.test(normalized)) {
      return rewrite("XRP 쪽 반응", "과열 가능성", "가격이 먼저 움직였는지 실제 자금이 따라오는지 더 봐야 하는 장면이다.");
    }
    if (/sol|altcoin/.test(normalized)) {
      return rewrite("알트 쪽 반응", "과열 가능성", "알트 쪽 분위기가 실제 주문으로 이어지는지 더 봐야 하는 장면이다.");
    }
    return rewrite("가격 분위기", "과열 가능성", "먼저 뜨거워진 가격 분위기가 실제 움직임으로 이어지는지 더 봐야 하는 장면이다.");
  }
  if (isEnglishHeavyEvidence(rawEvidence) || isEnglishHeavyEvidence(rawLabel)) {
    return rewrite("외부 뉴스 반응", "포착", "바깥 뉴스가 체인 안쪽 움직임까지 번지는지 아직 더 봐야 한다.");
  }

  return {
    label: applyKoNarrativeLexicon(rawLabel).trim() || rawLabel,
    value: applyKoNarrativeLexicon(rawValue).trim() || rawValue,
    summary: applyKoNarrativeLexicon(rawEvidence).trim() || rawEvidence,
  };
}

function extractSignedNumber(text: string): number | null {
  const match = sanitizeTweetText(text || "").match(/([+-]?\d+(?:[.,]\d+)?)/);
  if (!match) return null;
  const value = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

function humanizeSignedOnchainValue(
  text: string,
  labels: { positive: string; neutral: string; negative: string }
): string {
  const value = extractSignedNumber(text);
  if (value === null) return labels.neutral;
  if (value > 0) return labels.positive;
  if (value < 0) return labels.negative;
  return labels.neutral;
}

function inferDirectionFromText(text: string): SignalDirection {
  const normalized = sanitizeTweetText(text || "").toLowerCase();
  if (!normalized) return "flat";
  if (/[+]\s*[$€£₩]?\d|(?:^|[\s(])[+]\d/.test(normalized)) return "up";
  if (/[-]\s*[$€£₩]?\d|(?:^|[\s(])-\d/.test(normalized)) return "down";
  if (/(expanded|rose|grew|increase|surged|inflow|유입|증가|확대|상향)/.test(normalized)) return "up";
  if (/(fell|drop|decrease|decline|outflow|유출|감소|둔화|완화|이탈|약세)/.test(normalized)) return "down";
  return "flat";
}

function localizeTrendHeadline(headline: string, lane: TrendLane, summary: string): string {
  const cleaned = stripPublicKoHeadlinePrefix(sanitizeTweetText(headline)).replace(/[.!?]+$/g, "").trim();
  if (!cleaned) return cleaned;
  if (!isEnglishHeavyHeadline(cleaned)) return groundKoAbstractHeadline(cleaned, lane) || cleaned;

  const normalized = `${cleaned} ${sanitizeTweetText(summary)}`.toLowerCase();
  const gapMatch = normalized.match(/gap between ([a-z0-9\s/-]+?) and ([a-z0-9\s/-]+?)(?:\s|$)/i);
  if (gapMatch) {
    const left = humanizeEnglishSignalPhrase(gapMatch[1]);
    const right = humanizeEnglishSignalPhrase(gapMatch[2]);
    const pool = [
      `${left}와 ${right}가 따로 움직이는지 먼저 가른다`,
      `${left}와 ${right}가 같은 장면 안에서 엇갈리는지 살핀다`,
      `${left}와 ${right} 중 어느 쪽이 먼저 미끄러지는지 짚는다`,
    ];
    return pool[stableSeed(`${cleaned}|gap`) % pool.length];
  }

  const laneFallback: Record<TrendLane, string[]> = {
    protocol: [
      "업그레이드 이야기가 진짜 사용 흔적으로 남는지 끝까지 확인한다",
      "프로토콜 변화가 체인 위 행동으로 번지는 쪽인지 먼저 짚는다",
      "코드 변경이 실제 움직임으로 이어지는 순간이 있는지 살핀다",
    ],
    ecosystem: [
      "말만 커지는 날이 아닌지, 실제로 다시 돌아오는 사람이 있는지 본다",
      "다시 열어보는 손이 늘어나는지부터 먼저 본다",
      "바깥 기대보다 실제 사용이 다시 붙는지 살핀다",
    ],
    regulation: [
      "규제 문장과 실제 반응이 어디서 갈라지는지 먼저 짚는다",
      "정책 이야기보다 실제 행동이 먼저 바뀌는 지점을 확인한다",
      "규제 해석과 현장 움직임 사이에 틈이 나는지 살핀다",
    ],
    macro: [
      "거시 바람이 체인 안쪽으로 실제로 닿는지 본다",
      "달러 쪽 변화가 크립토 안쪽 행동까지 밀고 오는지 짚는다",
      "큰 바깥 바람이 체인 안쪽 자금 성격까지 바꾸는지 살핀다",
    ],
    onchain: [
      "체인 안쪽에서 오래 남는 움직임이 있는지 본다",
      "가격보다 먼저 식지 않는 온체인 흐름이 남아 있는지 확인한다",
      "체인 위 작은 변화가 어디서부터 진짜로 번지는지 살핀다",
    ],
    "market-structure": [
      "차트가 뜨거워도 실제 체결이 비지 않는지 본다",
      "분위기보다 실제 주문이 남는 쪽을 먼저 짚는다",
      "화면이 달아올라도 돈이 끝까지 붙는지 가른다",
    ],
  };

  if (/court|lawsuit|sec|cftc|policy|compliance|etf|filing|review|approval/.test(normalized)) {
    return laneFallback.regulation[stableSeed(`${cleaned}|reg`)% laneFallback.regulation.length];
  }
  if (/upgrade|mainnet|testnet|validator|rollup|fork|throughput|firedancer|consensus/.test(normalized)) {
    return laneFallback.protocol[stableSeed(`${cleaned}|protocol`)% laneFallback.protocol.length];
  }
  if (/wallet|developer|community|adoption|network use|user|ecosystem|token value|xrp|app/.test(normalized)) {
    return laneFallback.ecosystem[stableSeed(`${cleaned}|ecosystem`)% laneFallback.ecosystem.length];
  }
  if (/fed|ecb|cpi|inflation|rates|treasury|dxy|usd|eur/.test(normalized)) {
    return laneFallback.macro[stableSeed(`${cleaned}|macro`)% laneFallback.macro.length];
  }
  if (/exchange|liquidity|volume|funding|open interest|market maker|orderbook/.test(normalized)) {
    return laneFallback["market-structure"][stableSeed(`${cleaned}|ms`)% laneFallback["market-structure"].length];
  }

  return laneFallback[lane][stableSeed(`${cleaned}|${lane}`) % laneFallback[lane].length];
}

function stripPublicKoHeadlinePrefix(text: string): string {
  return sanitizeTweetText(text || "")
    .replace(
      /^(?:프로토콜|생태계|규제|매크로|온체인|시장구조)\s*(?:맥락|포인트|이슈)\s*[:：]\s*/u,
      ""
    )
    .trim();
}

function groundKoAbstractHeadline(text: string, lane: TrendLane): string {
  const cleaned = sanitizeTweetText(text).replace(/[.!?]+$/g, "").trim();
  if (!cleaned) return cleaned;
  const pick = (...pool: string[]) => pool[stableSeed(`${cleaned}|${lane}|grounded-ko`) % pool.length];

  const importantMatch = cleaned.match(/^(.+?)보다\s+중요한\s+건\s+(.+)$/);
  if (importantMatch) {
    const left = importantMatch[1].trim();
    const right = importantMatch[2].trim();
    return pick(
      `${left}보다 ${right}가 실제로 더 오래 버티는지 본다`,
      `${left}보다 ${right} 쪽에서 먼저 행동이 바뀌는지 짚는다`
    );
  }

  const decideMatch = cleaned.match(/^(.+?)[은는]\s+(.+?)에서\s+먼저\s+결정된다$/);
  if (decideMatch) {
    const left = decideMatch[1].trim();
    const right = decideMatch[2].trim();
    return pick(
      `${left}가 실제로 갈리는 곳이 ${right}인지 먼저 본다`,
      `${left} 얘기가 아니라 ${right}에서 먼저 갈리는 장면인지 짚는다`
    );
  }

  const lagMatch = cleaned.match(/^(.+?)[은는]\s+짧아도\s+(.+?)[은는]\s+길다$/);
  if (lagMatch) {
    const left = lagMatch[1].trim();
    const right = lagMatch[2].trim();
    return pick(
      `${left}가 끝난 뒤에도 ${right}가 오래 남는지 본다`,
      `${left}는 금방 지나가도 ${right}가 실제로 더 길게 끄는지 짚는다`
    );
  }

  const stateMatch = cleaned.match(/^(.+?)[은는]\s+(.+?)이다$/);
  if (stateMatch) {
    const left = stateMatch[1].trim();
    const right = stateMatch[2].trim();
    if (lane === "market-structure") {
      return pick(
        `${left}를 숫자보다 실제 행동으로 읽어야 하는 장면인지 본다`,
        `${left}를 ${right}처럼 말하기보다 실제 주문으로 확인해야 하는지 짚는다`
      );
    }
    if (lane === "ecosystem") {
      return pick(
        `${left}가 말이 아니라 관계와 습관으로 남는지 본다`,
        `${left}가 실제 사용자 버릇으로 이어지는지 짚는다`
      );
    }
    if (lane === "regulation") {
      return pick(
        `${left}가 문장에 머무는지 행동까지 번지는지 본다`,
        `${left}가 실제 반응으로 이어지는 장면인지 짚는다`
      );
    }
  }

  if (/생각$/.test(cleaned)) {
    return pick(
      `${cleaned.replace(/생각$/, "")}이 실제 장면으로 이어지는지 본다`,
      `${cleaned.replace(/생각$/, "")}이 숫자 밖 행동까지 닿는지 짚는다`
    );
  }

  return cleaned;
}

function humanizeEnglishSignalPhrase(input: string): string {
  const value = sanitizeTweetText(input).toLowerCase().trim();
  if (!value) return "흐름";
  if (/network use|activity|usage/.test(value)) return "실제 사용 흔적";
  if (/token value|valuation|price/.test(value)) return "토큰 가격 분위기";
  if (/liquidity/.test(value)) return "유동성";
  if (/developer/.test(value)) return "개발자 흐름";
  if (/community/.test(value)) return "커뮤니티 반응";
  return value.replace(/[^a-z0-9\s/-]/g, "").trim() || "흐름";
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

function estimateHeadlineCommodityPenalty(headline: string, summary: string, lane: TrendLane): number {
  const normalized = sanitizeTweetText(`${headline} ${summary}`).toLowerCase();
  const priceActionOnly = isPriceActionHeadline(normalized);
  const btcCentric = isBtcCentricHeadline(normalized);
  const tickerHeavy = (normalized.match(/\$[a-z]{2,10}\b/g) || []).length >= 2;
  const conceptualAnchor =
    /(protocol|governance|validator|compliance|regulation|community|ecosystem|adoption|incentive|coordination|upgrade|court|etf|policy|developer|철학|정체성|미션|상호작용|규제|정책|생태계|업그레이드|개발자)/.test(
      normalized
    );

  if (priceActionOnly && btcCentric) {
    return lane === "macro" ? 0.24 : 0.38;
  }
  if (priceActionOnly && !conceptualAnchor) {
    return lane === "macro" ? 0.16 : 0.28;
  }
  if (btcCentric && !conceptualAnchor) {
    return 0.18;
  }
  if (tickerHeavy && !conceptualAnchor) {
    return 0.1;
  }
  return 0;
}

function estimateWeakEvidencePenalty(pair: OnchainEvidence[]): number {
  return pair.reduce((sum, item) => {
    const normalized = sanitizeTweetText(`${item.label} ${item.value} ${item.summary}`).toLowerCase();
    if (/coindesk|cointelegraph|rss|reuters/.test(normalized)) return sum + 0.12;
    if (/(외부 뉴스 흐름|시장 반응)\b/.test(item.label)) return sum + 0.1;
    if (isEnglishHeavyEvidence(`${item.label} ${item.summary}`)) return sum + 0.14;
    return sum;
  }, 0);
}

function isFeeLikeEvidence(item: OnchainEvidence): boolean {
  const normalized = sanitizeTweetText(`${item.label} ${item.value} ${item.summary}`).toLowerCase();
  return /(네트워크\s*수수료|체인\s*수수료|체인\s*사용|멤풀|대기\s*거래|거래\s*대기|mempool|network fee|backlog)/.test(
    normalized
  );
}

function isMarketStructureSpecificEvidence(item: OnchainEvidence): boolean {
  const normalized = sanitizeTweetText(`${item.label} ${item.value} ${item.summary}`).toLowerCase();
  return /(호가|체결|주문|거래량|유동성|슬리피지|funding|orderbook|execution|liquidity|volume|exchange flow|거래소 유입)/.test(
    normalized
  );
}

function isGenericLaneEvidenceLabel(label: string): boolean {
  return /^(시장 반응|가격 반응|가격 움직임|알트 쪽 움직임|실사용 실험|실사용 흐름|실사용 흔적|실사용 잔류|사용으로 남는 흔적|규제 쪽 실제 움직임|규제 반응|규제 일정|규제 쪽 일정|규제 집행 일정|프로토콜 변화 신호|업그레이드 진행|업그레이드 운영 반응|외부 뉴스 흐름|외부 뉴스 반응|업계 스트레스 신호|업계 스트레스|업계 스트레스 확대|가격 분위기|체인 안쪽 사용|체인 사용|거래 대기|큰손 움직임|대기 자금|대기 자금 흐름|거래소 쪽 자금 이동|지갑 안쪽 사용|개발자 반응|커뮤니티 반응|검증자 반응|테스트넷·메인넷 흐름|금리 기대 변화|달러 흐름|거시 흐름 변화|거시 압력 변화|ETF 쪽 일정|SEC·CFTC 움직임|법원 쪽 일정)$/i.test(
    sanitizeTweetText(label)
  );
}

function estimateEvidenceSpecificity(item: OnchainEvidence, lane: TrendLane): number {
  const label = sanitizeTweetText(item.label || "");
  const merged = sanitizeTweetText(`${item.label} ${item.value} ${item.summary}`).toLowerCase();
  if (isLowSignalEvidenceForEvent(item)) return 0.05;

  let score = 0.42;

  if (isGenericLaneEvidenceLabel(label)) score -= 0.18;
  if (/(유입|이탈|확대|둔화|강세|약세|압박|정체|심사|승인|신청|소송|법원|집행|검증자|복구|재방문|잔류|체결|호가|유동성|대기 자금|거래소 쪽 자금|큰손 움직임)/.test(label)) {
    score += 0.24;
  }
  if (/(체인 안쪽 사용|실사용 흔적|대기 자금 흐름|거래소 쪽 자금 이동|규제 반응|규제 일정|업그레이드 진행|외부 뉴스 반응|가격 반응)/.test(label)) {
    score -= 0.12;
  }
  if (item.value && !/^(?:포착|감지|정상화|안정|중립|과열 가능성|컷 기대 지연|이동 포착|observed)$/i.test(item.value.trim())) {
    score += 0.05;
  }

  const laneSpecificByLane: Record<TrendLane, RegExp> = {
    protocol: /(검증자|복구|메인넷|테스트넷|합의|firedancer|rollup|업그레이드)/,
    ecosystem: /(재방문|잔류|커뮤니티|개발자|지갑|실사용|사용|앱)/,
    regulation: /(규제|정책|법원|소송|당국|etf|심사|승인|집행)/,
    macro: /(달러|금리|물가|inflation|rates|dxy|usd|eur)/,
    onchain: /(체인 사용|거래 대기|대기 자금|거래소 쪽 자금|큰손|주소|온체인|멤풀|스테이블)/,
    "market-structure": /(체결|호가|유동성|주문|거래량|펀딩|funding|orderbook|exchange)/,
  };

  if (laneSpecificByLane[lane].test(merged)) score += 0.12;
  if (lane !== item.lane && item.source !== "onchain" && !laneSpecificByLane[lane].test(merged)) score -= 0.08;

  return clampNumber(score, 0.05, 0.95, 0.42);
}

function isConcreteNarrativeEvidence(item: OnchainEvidence, lane: TrendLane): boolean {
  const normalized = sanitizeTweetText(`${item.label} ${item.value} ${item.summary}`).toLowerCase();
  if (isLowSignalEvidenceForEvent(item)) return false;
  if (lane === "market-structure") {
    return isMarketStructureSpecificEvidence(item) && !isGenericLaneEvidenceLabel(item.label);
  }
  if (lane !== "onchain" && isFeeLikeEvidence(item)) return false;
  if (!isGenericLaneEvidenceLabel(item.label)) return true;
  if (lane === "macro") {
    return /(달러|금리|fed|ecb|cpi|inflation|dxy|usd|eur|treasury|채권|환율)/.test(normalized);
  }
  if (lane === "regulation") {
    return /(sec|cftc|court|lawsuit|policy|regulation|compliance|etf|법원|소송|당국|정책|규제|집행)/.test(normalized);
  }
  if (lane === "protocol") {
    return /(upgrade|validator|consensus|mainnet|testnet|rollup|firedancer|업그레이드|검증자|합의|메인넷|테스트넷)/.test(normalized);
  }
  if (lane === "ecosystem") {
    return /(wallet|developer|community|adoption|usage|app|지갑|개발자|커뮤니티|채택|사용)/.test(normalized);
  }
  if (lane === "onchain") {
    return /(address|whale|stablecoin|netflow|tvl|wallet|usage|activity|거래소|유입|주소|고래|스테이블|자금 흐름|순유입|지갑|사용|활동)/.test(
      normalized
    );
  }
  return false;
}

function countConcreteNarrativeEvidence(pair: OnchainEvidence[], lane: TrendLane): number {
  return pair.filter((item) => isConcreteNarrativeEvidence(item, lane)).length;
}

function pairIsTooGenericForLane(pair: OnchainEvidence[], lane: TrendLane): boolean {
  const concreteCount = countConcreteNarrativeEvidence(pair, lane);
  const laneConcreteCount = pair.filter((item) => item.lane === lane && isConcreteNarrativeEvidence(item, lane)).length;
  const semanticItemCount = pair.filter((item) => itemSupportsLaneSemantics(item, lane)).length;
  const concreteOnchainSupportCount = pair.filter(
    (item) =>
      item.source === "onchain" &&
      item.lane === "onchain" &&
      !isLowSignalEvidenceForEvent(item) &&
      !isGenericLaneEvidenceLabel(item.label)
  ).length;
  if (lane === "onchain") {
    return concreteCount < 1 || countPriceLikeEvidence(pair) >= 1;
  }
  const genericCount = pair.filter((item) => isGenericLaneEvidenceLabel(item.label)).length;
  const feeLikeCount = pair.filter((item) => isFeeLikeEvidence(item)).length;
  const laneSpecificCount = pair.filter((item) => item.lane === lane && !isGenericLaneEvidenceLabel(item.label)).length;
  const hasSpecificMarketStructureEvidence = pair.some(
    (item) => isMarketStructureSpecificEvidence(item) && !isGenericLaneEvidenceLabel(item.label)
  );

  if (lane === "market-structure") {
    if (concreteCount < 2) return true;
    if (!pair.some((item) => isMarketStructureSpecificEvidence(item))) return true;
    if (
      pair.some((item) => /(대기 자금 흐름|가격 반응|가격 움직임|가격 분위기|시장 반응)/.test(item.label)) &&
      !hasSpecificMarketStructureEvidence
    ) {
      return true;
    }
    return false;
  }

  if (lane === "protocol") {
    return (
      semanticItemCount < 1 ||
      (laneConcreteCount < 1 && concreteOnchainSupportCount === 0) ||
      (feeLikeCount >= 1 && genericCount >= 1 && laneSpecificCount === 0 && semanticItemCount < 2)
    );
  }
  if (lane === "ecosystem") {
    return (
      semanticItemCount < 1 ||
      (laneConcreteCount < 1 && concreteOnchainSupportCount === 0) ||
      (feeLikeCount >= 1 && genericCount >= 1 && laneSpecificCount === 0 && semanticItemCount < 2)
    );
  }
  if (lane === "regulation") {
    if (!pair.some((item) => item.lane === "regulation")) {
      return true;
    }
    return (
      semanticItemCount < 1 ||
      (laneConcreteCount < 1 && concreteOnchainSupportCount === 0) ||
      (feeLikeCount >= 1 && genericCount >= 1 && laneSpecificCount === 0 && semanticItemCount < 2) ||
      (genericCount >= 1 &&
        laneSpecificCount === 0 &&
        pair.some((item) => {
          const normalized = sanitizeTweetText(`${item.label} ${item.summary}`).toLowerCase();
          return item.lane === "protocol" || /(업그레이드|검증자|합의|테스트넷|메인넷|firedancer|rollup|protocol)/.test(normalized);
        })) ||
      pair.every((item) => {
        const normalized = sanitizeTweetText(`${item.label} ${item.summary}`).toLowerCase();
        return /(체인 사용|거래 대기|네트워크 수수료|멤풀|가격 반응|가격 움직임|대기 자금 흐름|etf 심사 흐름|규제 일정|규제 반응)/.test(
          normalized
        );
      })
    );
  }
  if (lane === "macro") {
    return (
      semanticItemCount < 1 ||
      (laneConcreteCount < 1 && concreteOnchainSupportCount === 0) ||
      (feeLikeCount >= 1 && genericCount >= 1 && laneSpecificCount === 0 && semanticItemCount < 2)
    );
  }

  return false;
}

function estimateEventEvidenceMismatchPenalty(event: TrendEvent, pair: OnchainEvidence[]): number {
  const localizedHeadline = containsKorean(event.headline)
    ? sanitizeTweetText(event.headline)
    : localizeTrendHeadline(event.headline, event.lane, event.summary || "");
  const eventTokens = new Set(
    [
      ...extractHeadlineTokens(localizedHeadline),
      ...extractHeadlineTokens(event.summary || ""),
      ...expandLocalizedEventTokens([...(event.keywords || []), ...extractHeadlineTokens(event.headline)]),
      ...buildLaneAnchorTokens(event.lane),
    ]
      .map((token) => sanitizeTweetText(String(token || "")).toLowerCase())
      .filter((token) => token.length >= 2)
  );

  let alignedEvidenceCount = 0;
  for (const item of pair) {
    const evidenceTokens = buildEvidenceAnchorTokens(item).map((token) => sanitizeTweetText(token).toLowerCase());
    if (evidenceTokens.some((token) => eventTokens.has(token))) {
      alignedEvidenceCount += 1;
    }
  }

  const hasWeakGenericOnchainSupport = pair.some((item) => {
    const normalized = sanitizeTweetText(`${item.label} ${item.value} ${item.summary}`).toLowerCase();
    return (
      item.source === "onchain" &&
      event.lane !== "onchain" &&
      event.lane !== "protocol" &&
      event.lane !== "market-structure" &&
      /(네트워크\s*수수료|체인\s*수수료|멤풀|대기\s*거래|mempool|network fee)/.test(normalized)
    );
  });

  const hasGenericExternalSupport = pair.some((item) => /(외부 뉴스 흐름|시장 반응)\b/.test(item.label));
  const hasProtocolSpecificSupport = pair.some((item) => {
    const normalized = sanitizeTweetText(`${item.label} ${item.summary}`).toLowerCase();
    return item.lane === "protocol" || /(업그레이드|검증자|합의|테스트넷|메인넷|firedancer|rollup|protocol)/.test(normalized);
  });
  const hasGenericRegulationSupport = pair.some((item) =>
    /(규제 일정|규제 반응|ETF 심사 흐름|SEC·CFTC 움직임|규제 쪽 실제 움직임)/.test(
      sanitizeTweetText(`${item.label} ${item.summary}`)
    )
  );
  const hasPriceSupportOutsidePriceLanes =
    event.lane !== "macro" &&
    event.lane !== "market-structure" &&
    countPriceLikeEvidence(pair) >= 1;

  let penalty = 0;
  if (alignedEvidenceCount === 0) {
    penalty += 0.18;
  } else if (alignedEvidenceCount === 1) {
    penalty += 0.05;
  }
  if (hasWeakGenericOnchainSupport) {
    penalty += 0.12;
  }
  if (hasGenericExternalSupport && alignedEvidenceCount < 2) {
    penalty += 0.08;
  }
  if (hasPriceSupportOutsidePriceLanes) {
    penalty += 0.06;
  }
  if (
    event.lane === "regulation" &&
    pair.some((item) => /(체인 사용|거래 대기|네트워크 수수료|멤풀)/.test(sanitizeTweetText(`${item.label} ${item.summary}`))) &&
    pair.some((item) => /(ETF 심사 흐름|규제 일정|규제 반응)/.test(sanitizeTweetText(`${item.label} ${item.summary}`)))
  ) {
    penalty += 0.08;
  }
  if (event.lane === "regulation" && hasProtocolSpecificSupport && hasGenericRegulationSupport) {
    penalty += 0.22;
  }
  if (
    event.lane === "market-structure" &&
    pair.every((item) => /(대기 자금 흐름|가격 반응|가격 움직임|먼저 달아오른 가격 분위기)/.test(item.label))
  ) {
    penalty += 0.12;
  }

  return clampNumber(penalty, 0, 0.42, 0.12);
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

function isBtcCentricHeadline(text: string): boolean {
  const normalized = sanitizeTweetText(text).toLowerCase();
  return /(^|\s)(\$?btc|bitcoin|비트코인)(\s|$)|fear\s*greed|fgi|공포\s*지수|극공포/.test(normalized);
}

export function isLowQualityTrendHeadline(headline: string, summary: string = ""): boolean {
  const normalized = sanitizeTweetText(`${headline} ${summary}`).toLowerCase();
  const rankingSpam =
    /(trending|트렌딩|실시간\s*인기|인기\s*코인|순위|top\s*\d+|top gainer|top loser|ranking|\b\d+\s*위\b)/.test(normalized);
  const predictionSpam =
    /(price prediction|could .* hit \$|will .* reach \$|is .* a buy|to the moon|100x|moonshot|매수\s*타이밍|지금\s*사야|얼마까지|상승\s*가능성)/.test(normalized);
  const farmSpam =
    /(airdrop|giveaway|tap to earn|mining app|referral|invite code|free mining)/.test(normalized);
  const snapshotSpam =
    /(crypto market cap|market cap|dominance|도미넌스|시총|24h 변동|24h change|fear greed|공포 지수|탐욕 지수)/.test(normalized);
  const lowSignalCoinSpam = /\bpi network\b|\bpi coin\b|\bmemecoin\b/.test(normalized);
  const hasStructuralAnchor =
    /(protocol|upgrade|validator|rollup|ecosystem|developer|regulation|policy|court|etf|compliance|liquidity|market structure|고래|온체인|업그레이드|규제|정책|생태계|개발자|유동성)/.test(
      normalized
    );

  if ((rankingSpam || predictionSpam || farmSpam || snapshotSpam) && !hasStructuralAnchor) return true;
  if (lowSignalCoinSpam && (rankingSpam || predictionSpam || farmSpam || snapshotSpam || !hasStructuralAnchor)) return true;
  return false;
}

function isLowSignalEvidenceForEvent(item: OnchainEvidence): boolean {
  const normalized = sanitizeTweetText(`${item.label} ${item.value} ${item.summary}`).toLowerCase();
  if (
    /(24h 변동|24h change|price|시세|시장가|market cap|crypto market cap|dominance|도미넌스|시총|fear greed|공포 지수|탐욕 지수|fgi)/.test(
      normalized
    )
  ) {
    return true;
  }
  return false;
}

function buildStructuralHeadlineFromEvidence(
  lane: TrendLane,
  primary: OnchainEvidence,
  secondary: OnchainEvidence
): string {
  const a = humanizeStructuralEvidenceLabel(primary.label);
  const b = humanizeStructuralEvidenceLabel(secondary.label);
  const pair = joinKoPair(a, b);
  const focus = resolvePlannerFocus(lane, [primary, secondary]);
  const seed = stableSeed(`${lane}|${a}|${b}|headline`);

  const focusPoolByLane: Partial<Record<TrendLane, Partial<Record<PlannerFocus, string[]>>>> = {
    ecosystem: {
      retention: [
        `${pair}를 보면 사람이 실제로 남는지 갈린다`,
        `${pair}가 엇갈리면 생태계 열기보다 잔류 쪽이 더 정확해진다`,
        `${pair}, 이 두 신호가 같이 버텨야 생태계 서사도 살아남는다`,
      ],
      builder: [
        `${pair}를 보면 개발 기세가 서사 대신 구조로 남는지 갈린다`,
        `${pair}, 이 두 신호가 같이 붙어야 생태계 기세도 실체를 얻는다`,
        `${pair}가 같이 남지 않으면 생태계 얘기도 금방 헐거워진다`,
      ],
      hype: [
        `${pair}를 보면 홍보 열기와 실제 사용이 갈라지는지 드러난다`,
        `${pair}, 이 두 신호가 엇갈리면 생태계 서사도 과열 쪽으로 기운다`,
        `${pair}가 같이 남지 않으면 큰 생태계 문장도 오래 못 간다`,
      ],
    },
    regulation: {
      execution: [
        `${pair}를 보면 정책 문장이 기사에서 끝나는지 갈린다`,
        `${pair}, 이 두 신호가 같이 남아야 규제 뉴스도 기사값을 벗어난다`,
        `${pair}가 엇갈리면 규제 해석보다 집행 빈칸이 더 크게 보인다`,
      ],
      court: [
        `${pair}를 보면 법원 기사와 실제 돈의 방향이 갈린다`,
        `${pair}, 이 두 신호가 같이 남아야 소송 뉴스도 기사값을 벗어난다`,
        `${pair}가 엇갈리면 판결 기사보다 자금 반응이 더 정확해진다`,
      ],
    },
    protocol: {
      durability: [
        `${pair}를 보면 업그레이드 얘기가 운영으로 내려오는지 갈린다`,
        `${pair}, 이 두 신호가 같이 버텨야 프로토콜 신뢰도 성립한다`,
        `${pair}가 엇갈리면 릴리스 노트보다 복구 기록이 더 크게 남는다`,
      ],
      launch: [
        `${pair}를 보면 메인넷 박수와 실제 복귀가 갈린다`,
        `${pair}, 이 두 신호가 같이 붙어야 출시 서사도 반쪽을 벗어난다`,
        `${pair}가 엇갈리면 메인넷 발표보다 복귀 자금이 더 정확해진다`,
      ],
    },
    onchain: {
      durability: [
        `${pair}를 보면 튄 숫자와 버틴 흔적이 갈린다`,
        `${pair}, 이 두 신호가 같이 남아야 온체인 숫자도 단서가 된다`,
        `${pair}가 엇갈리면 예쁜 수치보다 오래 남은 흔적이 더 정확하다`,
      ],
      flow: [
        `${pair}를 보면 주소 흔적과 자금 방향이 갈린다`,
        `${pair}, 이 두 신호가 같이 남아야 고래 움직임도 반쪽을 벗어난다`,
        `${pair}가 엇갈리면 주소 숫자보다 자금 방향이 더 정확해진다`,
      ],
    },
    "market-structure": {
      liquidity: [
        `${pair}를 보면 분위기와 실제 돈이 갈린다`,
        `${pair}, 이 두 신호가 같이 남아야 과열도 구조 변화가 된다`,
        `${pair}가 엇갈리면 화면 열기보다 체결 쪽이 더 정확해진다`,
      ],
      settlement: [
        `${pair}를 보면 거래량 숫자와 실제 깊이가 갈린다`,
        `${pair}, 이 두 신호가 같이 남아야 체결 반응도 구조가 된다`,
        `${pair}가 엇갈리면 숫자보다 호가 두께가 더 정확해진다`,
      ],
    },
  };
  const poolByLane: Record<TrendLane, string[]> = {
    protocol: [
      `${pair}를 보면 업그레이드 얘기가 운영으로 이어지는지 갈린다`,
      `${pair}, 이 두 신호가 같이 버텨야 프로토콜 얘기도 성립한다`,
    ],
    ecosystem: [
      `${pair}를 보면 생태계 서사가 실제 사용으로 이어지는지 갈린다`,
      `${pair}, 이 두 신호가 약하면 생태계 얘기도 더 밀지 않는다`,
    ],
    regulation: [
      `${pair}를 보면 규제 해석이 기사에서 끝나는지 갈린다`,
      `${pair}, 이 두 신호가 버티지 못하면 규제 해석도 오늘은 보류한다`,
    ],
    macro: [
      `${pair}를 보면 큰 뉴스가 실제 자금 습관을 바꾸는지 갈린다`,
      `${pair}, 이 두 신호가 약하면 거시 뉴스도 오늘 근거가 되지 못한다`,
    ],
    onchain: [
      `${pair}를 보면 체인 안쪽 흐름이 금방 식는지 갈린다`,
      `${pair}, 이 두 신호가 버티지 못하면 오늘 온체인 해석은 보류한다`,
    ],
    "market-structure": [
      `${pair}를 보면 분위기가 아니라 체결이 남는지 갈린다`,
      `${pair}, 이 두 신호가 비면 차트 얘기도 오늘은 보류해야 한다`,
    ],
  };
  const pool = focusPoolByLane[lane]?.[focus] || poolByLane[lane];
  return sanitizeTweetText(pool[seed % pool.length]).slice(0, 140);
}

function buildStructuralSummaryFromEvidence(
  lane: TrendLane,
  primary: OnchainEvidence,
  secondary: OnchainEvidence
): string {
  const a = humanizeStructuralEvidenceLabel(primary.label);
  const b = humanizeStructuralEvidenceLabel(secondary.label);
  const pair = joinKoPair(a, b);
  const focus = resolvePlannerFocus(lane, [primary, secondary]);
  const focusPoolByLane: Partial<Record<TrendLane, Partial<Record<PlannerFocus, string[]>>>> = {
    ecosystem: {
      builder: [`지금은 ${pair}, 이 조합이 사람과 코드, 자금까지 같이 남는지부터 본다.`],
      retention: [`지금은 ${pair}, 이 조합이 반응이 아니라 잔류로 이어지는지부터 본다.`],
      hype: [`지금은 ${pair}, 이 조합이 홍보 열기를 넘어 실제 사용까지 남는지부터 본다.`],
    },
    regulation: {
      court: [`지금은 ${pair}, 이 조합이 법원 뉴스가 아니라 실제 돈의 방향으로 번지는지부터 본다.`],
      execution: [`지금은 ${pair}, 이 조합이 기사 문장을 넘어 행동으로 이어지는지부터 본다.`],
    },
    protocol: {
      launch: [`지금은 ${pair}, 이 조합이 메인넷 박수를 넘어 실제 복귀로 이어지는지부터 본다.`],
      durability: [`지금은 ${pair}, 이 조합이 발표가 아니라 운영 기록으로 남는지부터 본다.`],
    },
    onchain: {
      flow: [`지금은 ${pair}, 이 조합이 주소 숫자가 아니라 자금 방향으로 이어지는지부터 본다.`],
      durability: [`지금은 ${pair}, 이 조합이 체인 안쪽에서 같이 버티는지부터 본다.`],
    },
    "market-structure": {
      settlement: [`지금은 ${pair}, 이 조합이 거래량 숫자가 아니라 실제 깊이로 남는지부터 본다.`],
      liquidity: [`지금은 ${pair}, 이 조합이 분위기가 아니라 실제 돈으로 남는지부터 본다.`],
    },
  };
  const poolByLane: Record<TrendLane, string[]> = {
    protocol: [`지금은 ${pair}, 이 조합이 실제 운영 반응으로 남는지부터 본다.`],
    ecosystem: [`지금은 ${pair}, 이 조합이 사람들의 실제 사용으로 이어지는지부터 본다.`],
    regulation: [`지금은 ${pair}, 이 조합이 기사 문장을 넘어 행동으로 이어지는지부터 본다.`],
    macro: [`지금은 ${pair}, 이 조합이 체인 안쪽 자금 습관까지 바꾸는지부터 본다.`],
    onchain: [`지금은 ${pair}, 이 조합이 체인 안쪽에서 같이 남는지부터 본다.`],
    "market-structure": [`지금은 ${pair}, 이 조합이 분위기가 아니라 실제 체결로 남는지부터 본다.`],
  };
  const pool = focusPoolByLane[lane]?.[focus] || poolByLane[lane];
  return sanitizeTweetText(pool[0]).slice(0, 180);
}

function humanizeStructuralEvidenceLabel(label: string): string {
  const normalized = sanitizeTweetText(label).trim();
  if (!normalized) return "남은 단서";

  const exactMap: Array<[RegExp, string]> = [
    [/^BTC 네트워크 수수료$/i, "체인 사용 압박"],
    [/^BTC 멤풀 대기열$/i, "거래 대기 압박"],
    [/^거래소 순유입 프록시$/i, "거래소 쪽 자금 흐름"],
    [/^고래\/대형주소 활동 프록시$/i, "큰손 움직임"],
    [/^스테이블코인 총공급 플로우$/i, "대기 자금 흐름"],
    [/^지갑 사용 흐름$/i, "지갑 재방문"],
    [/^실사용 실험$/i, "실사용 잔류"],
  ];

  for (const [pattern, replacement] of exactMap) {
    if (pattern.test(normalized)) {
      return replacement;
    }
  }

  return applyKoNarrativeLexicon(normalized)
    .replace(/프록시/g, "흐름")
    .replace(/총공급\s*플로우/g, "공급 흐름")
    .replace(/네트워크\s*수수료/g, "체인 사용 압박")
    .replace(/멤풀\s*대기열/g, "거래 대기 압박")
    .replace(/^\$?BTC\s*/i, "")
    .trim();
}

function selectEvidenceForLane(lane: TrendLane, evidence: OnchainEvidence[]): OnchainEvidence[] {
  const laneMatched = evidence.filter((item) => item.lane === lane);
  const onchainMatched = evidence.filter((item) => item.lane === "onchain" && item.lane !== lane);
  const others = evidence.filter((item) => item.lane !== lane && item.lane !== "onchain");
  return dedupEvidence([...laneMatched, ...onchainMatched, ...others]).sort((a, b) => {
    const aPenalty = estimatePriceEvidencePenalty([a], lane);
    const bPenalty = estimatePriceEvidencePenalty([b], lane);
    if (aPenalty !== bPenalty) return aPenalty - bPenalty;
    const aSpecificity = estimateEvidenceSpecificity(a, lane);
    const bSpecificity = estimateEvidenceSpecificity(b, lane);
    if (aSpecificity !== bSpecificity) return bSpecificity - aSpecificity;
    const aScore = (a.digestScore ?? 0.55) * a.trust * a.freshness;
    const bScore = (b.digestScore ?? 0.55) * b.trust * b.freshness;
    return bScore - aScore;
  });
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
      if (lane === "onchain" && pair.some((item) => item.source !== "onchain")) continue;
      const hasOnchainEvidence = pair.some((item) => item.source === "onchain");
      const sourceDiversity = new Set(pair.map((item) => item.source)).size;
      const hasCrossSourceEvidence = sourceDiversity >= 2;
      if (options.requireOnchainEvidence && !hasOnchainEvidence) continue;
      if (options.requireCrossSourceEvidence && lane !== "onchain" && !hasCrossSourceEvidence) continue;
      const semanticSupport = pairSupportsLaneSemantics(pair, lane);
      const laneMatchCount = pair.filter((item) => item.lane === lane).length;
      const baseScore = pair.reduce(
        (sum, item) => sum + (item.digestScore ?? 0.55) * item.trust * item.freshness,
        0
      );
      const specificityScore =
        pair.reduce((sum, item) => sum + estimateEvidenceSpecificity(item, lane), 0) / pair.length;
      const weakEvidencePenalty = estimateWeakEvidencePenalty(pair);
      const genericPairPenalty = estimateGenericEvidencePairPenalty(pair, lane);
      if (pairIsTooGenericForLane(pair, lane)) continue;
      if (lane === "market-structure" && !semanticSupport) continue;
      if (lane !== "onchain" && lane !== "market-structure" && !semanticSupport && genericPairPenalty >= 0.1) {
        continue;
      }
      if (lane !== "onchain" && lane !== "market-structure" && laneMatchCount === 0 && genericPairPenalty >= 0.2) {
        continue;
      }
      const score =
        baseScore +
        laneMatchCount * 0.18 +
        specificityScore * 0.36 +
        (hasOnchainEvidence ? 0.06 : 0) +
        (hasCrossSourceEvidence ? 0.04 : 0) -
        (semanticSupport ? 0 : 0.16) -
        estimatePriceEvidencePenalty(pair, lane) * 1.6 -
        weakEvidencePenalty -
        genericPairPenalty;
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

type NarrativeBucket =
  | "legal"
  | "capital"
  | "usage"
  | "retention"
  | "ops"
  | "execution"
  | "liquidity"
  | "durability"
  | "heat"
  | "whale"
  | "settlement"
  | "generic";

type PlannerFocus =
  | "retention"
  | "builder"
  | "hype"
  | "execution"
  | "court"
  | "launch"
  | "durability"
  | "flow"
  | "liquidity"
  | "settlement"
  | "general";

function classifyNarrativeBucket(item: OnchainEvidence): NarrativeBucket {
  const normalized = sanitizeTweetText(`${item.label} ${item.value} ${item.summary}`).toLowerCase();
  if (/(법원|소송|당국|정책|규제|etf|sec|cftc|심사|승인|집행|court|lawsuit|policy|regulation|compliance)/.test(normalized)) {
    return "legal";
  }
  if (/(스테이블|대기 자금|거래소 유입|거래소 이탈|netflow|exchange flow|자금 흐름|capital)/.test(normalized)) {
    return "capital";
  }
  if (/(고래|큰손|whale)/.test(normalized)) {
    return "whale";
  }
  if (/(재방문|잔류|돌아오|retention|returning|sticky)/.test(normalized)) {
    return "retention";
  }
  if (/(활성 지갑|사용 지갑|실사용|사용 흔적|usage|wallet|address activity|active address|tvl|잠긴 자금)/.test(normalized)) {
    return "usage";
  }
  if (/(예치 자금|현물 체결|호가 유동성|체결 유동성)/.test(normalized)) {
    return "settlement";
  }
  if (/(검증자|복구|업그레이드|메인넷|테스트넷|합의|firedancer|validator|recovery|consensus|rollup)/.test(normalized)) {
    return "ops";
  }
  if (/(주문|체결|호가|유동성|orderbook|liquidity|funding|open interest|현물 체결)/.test(normalized)) {
    return "liquidity";
  }
  if (/(멤풀|수수료|거래 대기|주소 이동|고래|durability|지속성)/.test(normalized)) {
    return "durability";
  }
  if (/(커뮤니티 열기|광고|홍보|가격 쏠림|가격 반응|과열|hype|heat|community)/.test(normalized)) {
    return "heat";
  }
  if (/(집행 흔적|현장 반응|행동)/.test(normalized)) {
    return "execution";
  }
  return "generic";
}

function resolvePlannerFocus(lane: TrendLane, pair: OnchainEvidence[]): PlannerFocus {
  const buckets = pair.map((item) => classifyNarrativeBucket(item));
  const has = (bucket: NarrativeBucket) => buckets.includes(bucket);
  const merged = sanitizeTweetText(pair.map((item) => `${item.label} ${item.summary}`).join(" | ")).toLowerCase();

  if (lane === "ecosystem") {
    if (/(개발자|빌드|예치 자금|tvl|잠긴 자금)/.test(merged) || (has("usage") && has("settlement"))) return "builder";
    if (has("retention")) return "retention";
    if (has("heat")) return "hype";
  }
  if (lane === "regulation") {
    if (/(법원|소송|판결|court|lawsuit)/.test(merged)) return "court";
    if (has("legal") && (has("execution") || has("capital"))) return "execution";
  }
  if (lane === "protocol") {
    if (/(메인넷|launch|준비도|복귀 자금|예치 자금)/.test(merged) || (has("ops") && (has("capital") || has("settlement")))) {
      return "launch";
    }
    if (has("ops")) return "durability";
  }
  if (lane === "onchain") {
    if (has("whale") || /(고래|거래소 자금|자금 방향)/.test(merged)) return "flow";
    if (has("durability")) return "durability";
  }
  if (lane === "market-structure") {
    if (has("settlement") || /(호가 유동성|현물 체결|깊이)/.test(merged)) return "settlement";
    if (has("liquidity")) return "liquidity";
  }

  return "general";
}

function estimateNarrativeBucketBonus(pair: OnchainEvidence[], lane: TrendLane): number {
  const buckets = pair.map((item) => classifyNarrativeBucket(item));
  const distinct = new Set(buckets).size;
  const focus = resolvePlannerFocus(lane, pair);
  let bonus = 0;

  if (distinct >= 2) bonus += 0.08;
  if (buckets.includes("generic")) bonus -= 0.08;

  const has = (bucket: NarrativeBucket) => buckets.includes(bucket);

  if (lane === "ecosystem") {
    if (has("retention") && has("usage")) bonus += 0.18;
    if (has("heat") && has("usage")) bonus += 0.1;
    if (has("retention") && has("capital")) bonus += 0.08;
    if (focus === "builder") bonus += 0.14;
    if (focus === "retention") bonus += 0.08;
    if (focus === "hype") bonus += 0.04;
    if (has("heat") && !has("usage") && !has("retention")) bonus -= 0.12;
    if (focus === "general") bonus -= 0.12;
  }
  if (lane === "regulation") {
    if (has("legal") && (has("capital") || has("execution") || has("usage"))) bonus += 0.18;
    if (has("legal") && has("whale")) bonus += 0.08;
    if (focus === "court") bonus += 0.12;
    if (focus === "execution") bonus += 0.06;
    if (has("legal") && has("generic")) bonus -= 0.1;
    if (focus === "general") bonus -= 0.1;
  }
  if (lane === "protocol") {
    if (has("ops") && (has("usage") || has("durability") || has("capital") || has("settlement"))) bonus += 0.16;
    if (focus === "launch") bonus += 0.12;
    if (focus === "durability") bonus += 0.06;
    if (has("ops") && has("generic")) bonus -= 0.08;
    if (focus === "general") bonus -= 0.1;
  }
  if (lane === "onchain") {
    if (has("durability") && (has("capital") || has("usage") || has("whale"))) bonus += 0.16;
    if (focus === "flow") bonus += 0.12;
    if (focus === "durability") bonus += 0.06;
    if (has("durability") && has("generic")) bonus -= 0.08;
    if (focus === "general") bonus -= 0.08;
  }
  if (lane === "market-structure") {
    if (has("liquidity") && (has("capital") || has("heat") || has("settlement"))) bonus += 0.16;
    if (focus === "settlement") bonus += 0.12;
    if (focus === "liquidity") bonus += 0.06;
    if (focus === "general") bonus -= 0.1;
  }
  if (lane === "macro") {
    if (has("capital") || has("usage")) bonus += 0.06;
  }

  return clampNumber(bonus, -0.2, 0.28, 0);
}
function pairSupportsLaneSemantics(pair: OnchainEvidence[], lane: TrendLane): boolean {
  if (lane === "onchain") return true;
  const merged = sanitizeTweetText(
    pair.map((item) => `${item.label} ${item.value} ${item.summary}`).join(" | ")
  ).toLowerCase();
  const byLane: Record<Exclude<TrendLane, "onchain">, RegExp> = {
    protocol:
      /(프로토콜|업그레이드|검증자|메인넷|테스트넷|합의|validator|mainnet|testnet|rollup|consensus|throughput|firedancer|fork)/,
    ecosystem:
      /(생태계|실사용|사용자|지갑|커뮤니티|개발자|앱|adoption|usage|user|wallet|community|developer|ecosystem|app)/,
    regulation:
      /(규제|정책|집행|당국|법원|소송|심사|승인|컴플라이언스|etf|sec|cftc|policy|regulation|compliance|court|lawsuit)/,
    macro:
      /(달러|환율|금리|인플레이션|거시|매크로|달러 쪽 반응|fed|ecb|rates|inflation|usd|eur|dxy|treasury)/,
    "market-structure":
      /(시장구조|거래소|유동성|호가|주문|체결|거래량|슬리피지|funding|orderbook|liquidity|execution|volume|exchange flow|거래소 유입)/,
  };
  return byLane[lane].test(merged);
}

function itemSupportsLaneSemantics(item: OnchainEvidence, lane: TrendLane): boolean {
  return pairSupportsLaneSemantics([item], lane);
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

function estimateGenericEvidencePairPenalty(pair: OnchainEvidence[], lane: TrendLane): number {
  const merged = pair.map((item) => sanitizeTweetText(`${item.label} ${item.value} ${item.summary}`)).join(" | ");
  const hasGenericOnchain =
    /체인\s*수수료|네트워크\s*수수료|밀린\s*거래|멤풀|mempool/i.test(merged);
  const hasGenericMarket =
    /시장\s*반응|가격\s*반응|알트\s*가격\s*반응|외부\s*뉴스\s*흐름/i.test(merged);
  const genericLabelCount = pair.filter((item) => isGenericLaneEvidenceLabel(item.label)).length;
  let penalty = 0;
  if (hasGenericOnchain && hasGenericMarket) {
    penalty += lane === "market-structure" ? 0.12 : lane === "onchain" ? 0.08 : 0.24;
  }
  if (genericLabelCount >= 2) penalty += 0.1;
  else if (genericLabelCount === 1) penalty += 0.04;
  return penalty;
}

function buildEvidenceAnchorTokens(evidence: OnchainEvidence): string[] {
  const merged = `${evidence.label} ${evidence.value} ${evidence.summary}`.toLowerCase();
  const tokens = merged.match(/\$[a-z]{2,10}\b|[a-z][a-z0-9-]{2,}|[가-힣]{2,}/g) || [];
  const aliases = new Set<string>();
  if (/(24h 변동|24h change|price|breakout|rally|surge|jump|fell|drop|sold off|selloff)/.test(merged)) {
    aliases.add("가격");
    aliases.add("변동");
    aliases.add("흔들");
    aliases.add("알트");
    aliases.add("시장");
    aliases.add("반응");
    aliases.add("시장");
    aliases.add("알트");
  }
  if (/(network fee|수수료|멤풀|mempool|address|고래|whale|stablecoin|유입)/.test(merged)) {
    aliases.add("체인");
    aliases.add("온체인");
    aliases.add("체인 사용");
    aliases.add("주소");
    aliases.add("유입");
    aliases.add("거래");
    aliases.add("거래 대기");
    aliases.add("활동");
    aliases.add("큰손");
    aliases.add("자금");
  }
  if (/(regulation|policy|sec|cftc|compliance|court|규제|정책|당국)/.test(merged)) {
    aliases.add("규제");
    aliases.add("정책");
    aliases.add("당국");
    aliases.add("집행");
    aliases.add("반응");
    aliases.add("공시");
  }
  if (/(usage|wallet|adoption|community|developer|ecosystem|실사용|사용|지갑|커뮤니티|생태계)/.test(merged)) {
    aliases.add("실사용");
    aliases.add("사용");
    aliases.add("지갑");
    aliases.add("커뮤니티");
    aliases.add("생태계");
    aliases.add("유저");
  }
  if (/(upgrade|mainnet|testnet|validator|consensus|rollup|firedancer|업그레이드|검증자|합의)/.test(merged)) {
    aliases.add("업그레이드");
    aliases.add("검증자");
    aliases.add("합의");
    aliases.add("운영");
    aliases.add("배포");
  }
  return [...new Set([...tokens, ...aliases])]
    .filter((token) => !EVIDENCE_TOKEN_STOP_WORDS.has(token))
    .slice(0, 12);
}

function formatEvidenceAnchor(evidence: OnchainEvidence | undefined, language: "ko" | "en"): string {
  if (!evidence) {
    return language === "ko" ? "데이터 확인 중" : "data pending";
  }
  const raw = sanitizeTweetText(`${evidence.label} ${evidence.value} ${evidence.summary}`).trim();
  if (language !== "ko") {
    return `${evidence.label} ${evidence.value}`.replace(/\s+/g, " ").trim().slice(0, 70);
  }

  const exactHumanized: Array<[RegExp, string]> = [
    [/^BTC 네트워크 수수료$/i, "체인 사용 압박"],
    [/^BTC 멤풀 대기열$/i, "거래 대기 압박"],
    [/^고래\/대형주소 활동 프록시$/i, "큰손 움직임"],
    [/^스테이블코인 총공급 플로우$/i, "대기 자금 흐름"],
    [/^거래소 순유입 프록시$/i, "거래소 쪽 자금 흐름"],
    [/^시장 반응$/i, "가격 반응"],
    [/^시장 반응 과열 가능성$/i, "먼저 달아오른 가격 반응"],
    [/^ETF 심사 흐름(?:\s*포착)?$/i, "ETF 심사 흐름"],
    [/^실사용 실험$/i, "실사용 잔류"],
    [/^규제 쪽 실제 움직임(?:\s*포착)?$/i, "규제 반응"],
    [/^프로토콜 변화 신호$/i, "업그레이드 반응"],
    [/^업계 스트레스 신호$/i, "업계 스트레스"],
    [/^외부 뉴스 흐름$/i, "외부 뉴스 반응"],
  ];
  for (const [pattern, replacement] of exactHumanized) {
    if (pattern.test(evidence.label)) {
      return sanitizeTweetText(replacement).slice(0, 70);
    }
  }

  if (/(24h 변동|24h change|sold off|selloff|rallied|surged|jumped|fell|dropped|price|breakout|broad move)/i.test(raw)) {
    if (/\b(xrp|sol|eth|altcoin|alts?)\b/i.test(raw)) return "알트 쪽 움직임";
    return "가격 움직임";
  }
  if (/(visa|ai agent|agentic|prediction market)/i.test(raw)) {
    return "실사용으로 번지는 반응";
  }
  if (/(sec|cftc|regulation|policy|compliance|lawsuit|court|bankruptcy|filing)/i.test(raw)) {
    return "규제 뉴스 뒤 실제 반응";
  }
  if (/(wallet|community|developer|adoption|ecosystem|network use|usage|app)/i.test(raw)) {
    return "사용으로 남는 흔적";
  }
  if (/(upgrade|mainnet|testnet|validator|consensus|rollup|firedancer|fork)/i.test(raw)) {
    return "업그레이드 뒤 실제 움직임";
  }
  if (/[A-Za-z]{6,}/.test(raw) && !/[가-힣]/.test(raw)) {
    return "외부 뉴스 반응";
  }

  const labelOnly = humanizeStructuralEvidenceLabel(evidence.label);
  const rawValue = sanitizeTweetText(evidence.value || "").trim();
  const keepValue =
    /^[-+]?[$€£₩]?\d/.test(rawValue) ||
    /%|sat\/?vB|gwei|tx|wallet|mempool|ETF|SEC|CFTC|court|volume|liquidity|TVL/i.test(rawValue);
  const fallback = [labelOnly, keepValue ? rawValue : ""]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return fallback.slice(0, 70);
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

function expandLocalizedEventTokens(tokens: string[]): string[] {
  const aliases = new Set<string>();
  const normalizedTokens = tokens.map((token) => sanitizeTweetText(token).toLowerCase()).filter(Boolean);
  for (const token of normalizedTokens) {
    if (/(sec|cftc|regulation|regulatory|policy|compliance|court|lawsuit|etf)/.test(token)) {
      aliases.add("규제");
      aliases.add("당국");
      aliases.add("정책");
    }
    if (/stablecoin/.test(token)) {
      aliases.add("스테이블");
      aliases.add("스테이블코인");
    }
    if (/(validator|consensus)/.test(token)) {
      aliases.add("검증자");
      aliases.add("합의");
    }
    if (/(upgrade|mainnet|testnet|fork|rollup|firedancer)/.test(token)) {
      aliases.add("업그레이드");
      aliases.add("테스트넷");
      aliases.add("메인넷");
    }
    if (/(wallet|adoption|community|ecosystem|developer|app)/.test(token)) {
      aliases.add("지갑");
      aliases.add("채택");
      aliases.add("커뮤니티");
      aliases.add("생태계");
      aliases.add("개발자");
    }
    if (/(whale|mempool|fee|gas|netflow|address|tvl)/.test(token)) {
      aliases.add("고래");
      aliases.add("멤풀");
      aliases.add("수수료");
      aliases.add("주소");
      aliases.add("유입");
    }
    if (/(exchange|liquidity|volume|funding|open-interest|openinterest|orderbook)/.test(token)) {
      aliases.add("거래소");
      aliases.add("유동성");
      aliases.add("거래량");
      aliases.add("호가");
    }
    if (/(fed|ecb|inflation|rates|rate|usd|eur|dxy|macro)/.test(token)) {
      aliases.add("매크로");
      aliases.add("달러");
      aliases.add("금리");
      aliases.add("물가");
    }
  }
  return [...aliases];
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
