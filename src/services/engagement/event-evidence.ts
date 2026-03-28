import { NarrativeMode, OnchainEvidence, OnchainNutrient, SignalDirection, TrendEvent, TrendLane } from "../../types/agent.js";
import { EventEvidencePlan, LaneUsageWindow, RecentPostRecord } from "./types.js";
import { NewsItem } from "../blockchain-news.js";
import { sanitizeTweetText } from "./quality.js";
import { applyKoNarrativeLexicon } from "../narrative-lexicon.js";
import { buildKoIdentityWriterCandidate, type WriterFocus } from "./identity-writer.js";

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

const WRITER_FOCUS_SET = new Set<WriterFocus>([
  "retention",
  "hype",
  "builder",
  "execution",
  "court",
  "liquidity",
  "settlement",
  "durability",
  "launch",
  "flow",
  "general",
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

    const pairCandidates = selectEvidencePairCandidatesForLane(
      lane,
      pool,
      {
        requireOnchainEvidence: lane === "onchain",
        requireCrossSourceEvidence: false,
      },
      6
    );
    if (!pairCandidates.length) return null;

    return pairCandidates
      .flatMap((pairCandidate, pairIndex) => {
        const [primary, secondary] = pairCandidate.evidence;
        if (!primary || !secondary) return [];

        const trust = clampNumber((primary.trust + secondary.trust) / 2, 0.18, 0.96, 0.68);
        const freshness = clampNumber((primary.freshness + secondary.freshness) / 2, 0.18, 0.98, 0.74);
        const keywords = [...extractHeadlineTokens(primary.label), ...extractHeadlineTokens(secondary.label)].slice(0, 6);
        const specificity =
          (estimateEvidenceSpecificity(primary, lane) + estimateEvidenceSpecificity(secondary, lane)) / 2;

        return [0, 1]
          .map((headlineVariant) => {
            const headline = buildStructuralHeadlineFromEvidence(lane, primary, secondary, headlineVariant);
            if (!headline || isLowQualityTrendHeadline(headline)) return null;
            const summary = buildStructuralSummaryFromEvidence(lane, primary, secondary, headlineVariant);
            const structuralSceneFamily = augmentSceneFamilyWithHeadline(
              pairCandidate.sceneFamily,
              headline,
              lane,
              pairCandidate.focus
            );
            return {
              id: `event:fallback:${lane}:${normalizeHeadlineKey(primary.label)}:${normalizeHeadlineKey(secondary.label)}:${pairCandidate.focus}:${structuralSceneFamily}:${pairIndex}:v${headlineVariant}:${createdAt}`,
              lane,
              headline,
              summary,
              source: "evidence:structural-fallback",
              trust,
              freshness,
              capturedAt: createdAt,
              keywords,
              focusHint: pairCandidate.focus,
              sceneFamilyHint: structuralSceneFamily,
              evidenceLabelHints: [primary.label, secondary.label],
              score:
                (primary.digestScore ?? 0.58) * primary.trust * primary.freshness +
                (secondary.digestScore ?? 0.58) * secondary.trust * secondary.freshness +
                specificity * 0.28 +
                (primary.source === "onchain" || secondary.source === "onchain" ? 0.08 : 0) +
                pairCandidate.score * 0.18 +
                estimateStructuralFallbackFamilyBias(
                  lane,
                  pairCandidate.focus,
                  structuralSceneFamily
                ) -
                headlineVariant * 0.01,
            };
          })
          .concat(
            [0, 1, 2, 3, 4]
              .map((derivedVariant) => {
                const diversifiedSceneFamily = diversifyDerivedSceneFamilyForVariant(
                  pairCandidate.sceneFamily,
                  lane,
                  pairCandidate.focus,
                  derivedVariant
                );
                const derivedHeadline = buildDerivedExplicitHeadlineFromEvidence(
                  lane,
                  pairCandidate.focus,
                  diversifiedSceneFamily,
                  primary,
                  secondary,
                  derivedVariant
                );
                if (!derivedHeadline || isLowQualityTrendHeadline(derivedHeadline)) return null;
                const derivedSummary = buildDerivedExplicitSummaryFromEvidence(
                  lane,
                  pairCandidate.focus,
                  diversifiedSceneFamily,
                  primary,
                  secondary,
                  derivedVariant
                );
                const derivedSceneFamily = augmentSceneFamilyWithHeadline(
                  diversifiedSceneFamily,
                  derivedHeadline,
                  lane,
                  pairCandidate.focus
                );
                return {
                  id: `event:derived:${lane}:${normalizeHeadlineKey(primary.label)}:${normalizeHeadlineKey(secondary.label)}:${pairCandidate.focus}:${derivedSceneFamily}:${pairIndex}:v${derivedVariant}:${createdAt}`,
                  lane,
                  headline: derivedHeadline,
                  summary: derivedSummary,
                  source: "analysis:sharp",
                  trust: clampNumber(trust + 0.02, 0.18, 0.98, 0.7),
                  freshness,
                  capturedAt: createdAt,
                  keywords,
                  focusHint: pairCandidate.focus,
                  sceneFamilyHint: derivedSceneFamily,
                  evidenceLabelHints: [primary.label, secondary.label],
                  score:
                    (primary.digestScore ?? 0.58) * primary.trust * primary.freshness +
                    (secondary.digestScore ?? 0.58) * secondary.trust * secondary.freshness +
                    specificity * 0.34 +
                    pairCandidate.score * 0.22 +
                    estimateStructuralFallbackFamilyBias(
                      lane,
                      pairCandidate.focus,
                      derivedSceneFamily
                    ) +
                    0.1,
                };
              })
              .filter((item): item is NonNullable<typeof item> => Boolean(item))
          )
          .filter((item): item is NonNullable<typeof item> => Boolean(item));
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
  })
    .flat()
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((a, b) => b.score - a.score)
    .filter((item, index, all) => {
      const key = `${item.lane}|${item.focusHint || "general"}|${item.sceneFamilyHint || "generic"}|${normalizeHeadlineKey(item.headline)}`;
      return (
        all.findIndex(
          (candidate) =>
            `${candidate.lane}|${candidate.focusHint || "general"}|${candidate.sceneFamilyHint || "generic"}|${normalizeHeadlineKey(candidate.headline)}` ===
            key
        ) === index
      );
    });

  const targetCount = Math.max(1, Math.min(8, maxItems));
  const primary: typeof candidates = [];
  const seenSceneFamilies = new Set<string>();
  for (const item of candidates) {
    const familyKey = `${item.lane}|${item.focusHint || "general"}|${item.sceneFamilyHint || "generic"}`;
    if (seenSceneFamilies.has(familyKey)) continue;
    primary.push(item);
    seenSceneFamilies.add(familyKey);
    if (primary.length >= targetCount) break;
  }

  const selected =
    primary.length >= targetCount
      ? primary
      : [
          ...primary,
          ...candidates.filter((item) => {
            const familyKey = `${item.lane}|${item.focusHint || "general"}|${item.sceneFamilyHint || "generic"}`;
            return !primary.some(
              (chosen) =>
                chosen.id === item.id ||
                `${chosen.lane}|${chosen.focusHint || "general"}|${chosen.sceneFamilyHint || "generic"}|${normalizeHeadlineKey(chosen.headline)}` ===
                  `${item.lane}|${item.focusHint || "general"}|${item.sceneFamilyHint || "generic"}|${normalizeHeadlineKey(item.headline)}`
            ) && seenSceneFamilies.has(familyKey);
          }),
        ].slice(0, targetCount);

  return selected.map(({ score: _score, ...event }) => event);
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
  recentNarrativeThreads?: Array<{ lane: TrendLane; focus?: string; sceneFamily?: string; headline?: string }>;
  laneUsage?: LaneUsageWindow;
  requireOnchainEvidence?: boolean;
  requireCrossSourceEvidence?: boolean;
  identityPressure?: {
    obsessionLine?: string;
    grudgeLine?: string;
    continuityLine?: string;
  };
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
      const recentNarrativeThreads = params.recentNarrativeThreads || [];
      let pairCandidates = selectEvidencePairCandidatesForLane(
        event.lane,
        evidence,
        {
          requireOnchainEvidence,
          requireCrossSourceEvidence,
        },
        6
      );
      const pairCandidateRows = pairCandidates.map((candidate) => {
        const repeatPenalty = estimateRecentNarrativeFocusPenalty(
          event.lane,
          candidate.focus,
          candidate.sceneFamily,
          recentNarrativeThreads
        );
        return {
          ...candidate,
          plannerPairScore: candidate.score - repeatPenalty * 0.7,
        };
      });
      let pair = null;
      if (
        event.source === "evidence:structural-fallback" &&
        (event.sceneFamilyHint || event.focusHint || (event.evidenceLabelHints && event.evidenceLabelHints.length))
      ) {
        const directLabelMatch =
          Array.isArray(event.evidenceLabelHints) && event.evidenceLabelHints.length >= 2
            ? event.evidenceLabelHints
                .map((label) =>
                  evidence.find((item) => normalizeHeadlineKey(item.label) === normalizeHeadlineKey(label))
                )
                .filter((item): item is OnchainEvidence => Boolean(item))
            : [];
        if (directLabelMatch.length >= 2) {
          const directPair = dedupEvidence(directLabelMatch).slice(0, 2);
          if (directPair.length >= 2) {
            const directFocus = resolvePlannerFocus(event.lane, directPair);
            const directSceneFamily = augmentSceneFamilyWithHeadline(
              resolvePlannerSceneFamily(event.lane, directFocus, directPair),
              event.headline,
              event.lane,
              directFocus
            );
            const directRepeatPenalty = estimateRecentNarrativeFocusPenalty(
              event.lane,
              directFocus,
              directSceneFamily,
              recentNarrativeThreads
            );
            pairCandidateRows.push({
              evidence: directPair,
              hasOnchainEvidence: directPair.some((item) => item.source === "onchain"),
              hasCrossSourceEvidence: new Set(directPair.map((item) => item.source)).size >= 2,
              evidenceSourceDiversity: new Set(directPair.map((item) => item.source)).size,
              score: 0.84,
              focus: directFocus,
              sceneFamily: directSceneFamily,
              plannerPairScore:
                0.84 -
                directRepeatPenalty * 0.7 +
                (event.sceneFamilyHint && sceneFamilyBase(event.sceneFamilyHint) === sceneFamilyBase(directSceneFamily) ? 0.08 : 0) +
                (event.focusHint === directFocus ? 0.05 : 0),
            });
          }
        }
        const hinted = pairCandidateRows.find((candidate) => {
          const sceneMatch = event.sceneFamilyHint
            ? sceneFamilyBase(candidate.sceneFamily) === sceneFamilyBase(event.sceneFamilyHint)
            : true;
          const focusMatch = event.focusHint ? candidate.focus === event.focusHint : true;
          const labelMatch =
            Array.isArray(event.evidenceLabelHints) && event.evidenceLabelHints.length > 0
              ? event.evidenceLabelHints.every((label) =>
                  candidate.evidence.some((item) => normalizeHeadlineKey(item.label) === normalizeHeadlineKey(label))
                )
              : true;
          return sceneMatch && focusMatch && labelMatch;
        });
        if (!pair && hinted) {
          pair = {
            evidence: hinted.evidence,
            hasOnchainEvidence: hinted.hasOnchainEvidence,
            hasCrossSourceEvidence: hinted.hasCrossSourceEvidence,
            evidenceSourceDiversity: hinted.evidenceSourceDiversity,
          };
        }
      }
      if (!pair && pairCandidateRows.length > 0) {
        pairCandidateRows.sort((a, b) => b.plannerPairScore - a.plannerPairScore);
        pair = {
          evidence: pairCandidateRows[0].evidence,
          hasOnchainEvidence: pairCandidateRows[0].hasOnchainEvidence,
          hasCrossSourceEvidence: pairCandidateRows[0].hasCrossSourceEvidence,
          evidenceSourceDiversity: pairCandidateRows[0].evidenceSourceDiversity,
        };
      }
      if (!pair && event.source === "evidence:structural-fallback" && event.lane === "onchain") {
        pair = selectEvidencePairForLane(event.lane, evidence, {
          requireOnchainEvidence,
          requireCrossSourceEvidence: false,
        });
      }
      if (!pair) {
        return null;
      }
      if (
        requireCrossSourceEvidence &&
        event.source === "evidence:structural-fallback" &&
        !pair.hasCrossSourceEvidence &&
        pair.evidenceSourceDiversity < 2
      ) {
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
      const focus = resolvePlannerFocus(event.lane, pair.evidence);
      const sceneFamily = augmentSceneFamilyWithHeadline(
        resolvePlannerSceneFamily(event.lane, focus, pair.evidence),
        event.headline,
        event.lane,
        focus
      );
      const narrativeTension = estimateNarrativeTension(pair.evidence, event.lane, focus, sceneFamily);
      const hasSharpExplicitAlternative = candidateEvents.some(
        (candidate) =>
          candidate.id !== event.id &&
          candidate.lane === event.lane &&
          candidate.source !== "evidence:structural-fallback" &&
          estimateHeadlineCommodityPenalty(candidate.headline, candidate.summary, candidate.lane) < 0.18
      );
      const hasFocusAlignedExplicitAlternative = candidateEvents.some(
        (candidate) =>
          candidate.id !== event.id &&
          candidate.lane === event.lane &&
          candidate.source !== "evidence:structural-fallback" &&
          estimateHeadlineCommodityPenalty(candidate.headline, candidate.summary, candidate.lane) < 0.18 &&
          estimateExplicitEventAlignmentBonus(candidate, pair.evidence, focus, sceneFamily) >= 0.12
      );
      const structuralSourcePenalty =
        event.source === "evidence:structural-fallback"
          ? hasFocusAlignedExplicitAlternative
            ? 0.56
            : hasSharpExplicitAlternative
              ? 0.34
              : 0.14
          : 0;
      const explicitSourceBonus =
        event.source !== "evidence:structural-fallback"
          ? 0.28 + estimateExplicitEventAlignmentBonus(event, pair.evidence, focus, sceneFamily)
          : 0;
      const recentFocusPenalty = estimateRecentNarrativeFocusPenalty(
        event.lane,
        focus,
        sceneFamily,
        params.recentNarrativeThreads || []
      );
      const sceneDiversificationBonus = estimateSceneDiversificationBonus(
        event.lane,
        focus,
        sceneFamily,
        params.recentNarrativeThreads || []
      );
      const recentHeadlinePenalty = estimateRecentHeadlineFamilyPenalty(
        event.headline,
        event.lane,
        focus,
        params.recentNarrativeThreads || []
      );
      const identityPressureBonus = estimateIdentityPressureBonus(
        event,
        pair.evidence,
        focus,
        sceneFamily,
        params.identityPressure
      );
      const sceneDominancePenalty = estimateSceneFamilyDominancePenalty(
        event.lane,
        focus,
        sceneFamily,
        params.recentNarrativeThreads || []
      );
      const sceneBasePenalty = estimateSceneFamilyBasePenalty(
        event.lane,
        focus,
        sceneFamily,
        params.recentNarrativeThreads || []
      );
      const explicitEscapeBonus = estimateExplicitEscapeBonus(
        event,
        event.lane,
        focus,
        sceneFamily,
        params.recentNarrativeThreads || []
      );
      const plannerWarnings = buildPlannerWarnings({
        event,
        pair: pair.evidence,
        focus,
        sceneFamily,
        hasCrossSourceEvidence: pair.hasCrossSourceEvidence,
        evidenceSourceDiversity: pair.evidenceSourceDiversity,
        recentNarrativeThreads: params.recentNarrativeThreads || [],
      });
      const repeatWarningPenalty =
        plannerWarnings.includes("scene-repeat") && event.source === "evidence:structural-fallback"
          ? 0.12
          : plannerWarnings.includes("focus-repeat") && event.source === "evidence:structural-fallback"
            ? 0.06
            : 0;
      const coldStartExplorationJitter = laneUsage.totalPosts === 0 ? (Math.random() - 0.5) * 0.16 : 0;
      const score =
        event.trust * 0.3 +
        event.freshness * 0.14 +
        novelty * 0.22 +
        evidenceStrength * 0.15 +
        narrativeRichness * 0.28 +
        narrativeTension +
        sceneDiversificationBonus * 1.45 +
        identityPressureBonus -
        sceneDominancePenalty +
        sceneBasePenalty * -1.05 +
        explicitEscapeBonus +
        laneScarcityBoost -
        headlineCommodityPenalty * 1.25 -
        structuralSourcePenalty +
        explicitSourceBonus -
        (quotaLimited ? 0.35 : 0) -
        laneRepeatPenalty -
        recentFocusPenalty * 1.15 -
        recentHeadlinePenalty * 1.1 -
        repeatWarningPenalty -
        priceEvidencePenalty * 1.15 +
        eventEvidenceMismatchPenalty * -1.35 +
        coldStartExplorationJitter;
      return {
        event,
        focus,
        sceneFamily,
        evidence: pair.evidence,
        hasOnchainEvidence: pair.hasOnchainEvidence,
        hasCrossSourceEvidence: pair.hasCrossSourceEvidence,
        evidenceSourceDiversity: pair.evidenceSourceDiversity,
        score,
        plannerWarnings,
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
  const preferred = pickPreferredPlanCandidate(explorationPool);
  return {
    lane: preferred.event.lane,
    focus: preferred.focus,
    sceneFamily: preferred.sceneFamily,
    event: preferred.event,
    evidence: preferred.evidence,
    hasOnchainEvidence: preferred.hasOnchainEvidence,
    hasCrossSourceEvidence: preferred.hasCrossSourceEvidence,
    evidenceSourceDiversity: preferred.evidenceSourceDiversity,
    plannerScore: Math.round(preferred.score * 1000) / 1000,
    plannerWarnings: preferred.plannerWarnings,
    laneUsage,
    laneProjectedRatio: Math.round(preferred.projectedRatio * 1000) / 1000,
    laneQuotaLimited: preferred.quotaLimited,
  };
}

function estimateRecentNarrativeFocusPenalty(
  lane: TrendLane,
  focus: PlannerFocus,
  sceneFamily: string,
  recentThreads: Array<{ lane: TrendLane; focus?: string; sceneFamily?: string; headline?: string }>
): number {
  if (!recentThreads.length) return 0;
  const recent = recentThreads.slice(0, 8);
  const exactFocusRepeats = recent.filter((item) => item.lane === lane && (item.focus || "general") === focus).length;
  const sameSceneFamilyRepeats = recent.filter(
    (item) => item.lane === lane && item.sceneFamily && item.sceneFamily === sceneFamily
  ).length;
  const sameLaneRepeats = recent.filter((item) => item.lane === lane).length;
  let penalty = 0;
  if (exactFocusRepeats >= 1) penalty += 0.14;
  if (exactFocusRepeats >= 2) penalty += 0.14;
  if (sameSceneFamilyRepeats >= 1) penalty += 0.38;
  if (sameSceneFamilyRepeats >= 2) penalty += 0.3;
  if (sameSceneFamilyRepeats >= 3) penalty += 0.12;
  if (sameLaneRepeats >= 3) penalty += 0.05;
  if (focus === "general") penalty += 0.06;
  return clampNumber(penalty, 0, 0.62, 0);
}

function estimateSceneDiversificationBonus(
  lane: TrendLane,
  focus: PlannerFocus,
  sceneFamily: string,
  recentThreads: Array<{ lane: TrendLane; focus?: string; sceneFamily?: string; headline?: string }>
): number {
  if (!recentThreads.length) return 0;
  const recent = recentThreads.slice(0, 8);
  const sameFocusRows = recent.filter((item) => item.lane === lane && (item.focus || "general") === focus);
  if (!sameFocusRows.length) return 0;
  const seenSceneFamilies = new Set(
    sameFocusRows
      .map((item) => (typeof item.sceneFamily === "string" ? item.sceneFamily.trim() : ""))
      .filter(Boolean)
  );
  if (seenSceneFamilies.has(sceneFamily)) return 0;

  let bonus = 0.1;
  if (sameFocusRows.length >= 2) bonus += 0.07;
  if (sameFocusRows.length >= 3) bonus += 0.08;
  return clampNumber(bonus, 0, 0.28, 0);
}

function estimateIdentityPressureBonus(
  event: TrendEvent,
  pair: OnchainEvidence[],
  focus: PlannerFocus,
  sceneFamily: string,
  pressure:
    | {
        obsessionLine?: string;
        grudgeLine?: string;
        continuityLine?: string;
      }
    | undefined
): number {
  if (!pressure) return 0;
  const merged = sanitizeTweetText(
    [
      event.headline,
      event.summary,
      sceneFamily,
      ...pair.map((item) => `${item.label} ${item.value} ${item.summary}`),
    ].join(" | ")
  ).toLowerCase();
  const obsession = sanitizeTweetText(pressure.obsessionLine || "").toLowerCase();
  const grudge = sanitizeTweetText(pressure.grudgeLine || "").toLowerCase();
  const continuity = sanitizeTweetText(pressure.continuityLine || "").toLowerCase();
  const tilt = sceneFamilyTilt(sceneFamily);

  let bonus = 0;
  const hasAny = (...tokens: string[]) => tokens.some((token) => merged.includes(token));

  if (focus === "builder" && (hasAny("개발자", "빌더", "코드", "예치 자금", "복귀 자금") || /(개발자|빌더)/.test(obsession))) {
    bonus += 0.1;
  }
  if (focus === "retention" && (hasAny("재방문", "잔류", "남은 사람", "지갑 재방문") || /(재방문|잔류)/.test(obsession))) {
    bonus += 0.1;
  }
  if ((focus === "court" || focus === "execution") && (hasAny("집행", "법원", "판결", "자금 방향", "대기 자금") || /(집행|규제 기사|판결 기사)/.test(grudge))) {
    bonus += 0.1;
  }
  if (focus === "launch" && (hasAny("복귀 자금", "메인넷", "출시", "런치") || /(복귀 자금|출시 박수)/.test(obsession))) {
    bonus += 0.1;
  }
  if (focus === "durability" && (hasAny("복구", "운영", "검증자", "릴리스", "운영 로그") || /(운영|릴리스|복구)/.test(grudge))) {
    bonus += 0.1;
  }
  if ((focus === "liquidity" || focus === "settlement") && (hasAny("체결", "호가", "깊이", "자금 쏠림", "큰 주문") || /(체결|화면|자신감)/.test(grudge))) {
    bonus += 0.1;
  }
  if (focus === "flow" && (hasAny("자금 방향", "고래", "주소", "거래소 자금") || /(자금 방향)/.test(obsession))) {
    bonus += 0.1;
  }
  if (tilt && /(lag|split|thin)/.test(tilt) && /(비는|늦|붙지|안 붙|빈칸|얇)/.test(grudge)) {
    bonus += 0.04;
  }
  if (tilt && /(holds)/.test(tilt) && /(끝까지|버티|남는|붙드는)/.test(obsession)) {
    bonus += 0.04;
  }
  if (continuity && merged.includes(normalizeHeadlineKey(continuity).slice(0, 8))) {
    bonus += 0.05;
  }

  return clampNumber(bonus, 0, 0.24, 0);
}

function estimateExplicitEventAlignmentBonus(
  event: TrendEvent,
  pair: OnchainEvidence[],
  focus: PlannerFocus,
  sceneFamily: string
): number {
  if (event.source === "evidence:structural-fallback") return 0;
  const localizedHeadline = containsKorean(event.headline)
    ? sanitizeTweetText(event.headline)
    : localizeTrendHeadline(event.headline, event.lane, event.summary || "");
  const merged = sanitizeTweetText(
    [localizedHeadline, event.summary, focus, sceneFamily, ...pair.map((item) => `${item.label} ${item.summary}`)].join(" | ")
  ).toLowerCase();
  let bonus = 0.06;
  if (focus === "builder" && /(개발자|빌더|예치 자금|복귀 자금|코드)/.test(merged)) bonus += 0.05;
  if (focus === "retention" && /(재방문|잔류|지갑|남은 사람)/.test(merged)) bonus += 0.05;
  if ((focus === "court" || focus === "execution") && /(판결|법원|집행|자금)/.test(merged)) bonus += 0.05;
  if (focus === "launch" && /(메인넷|출시|복귀 자금|준비도)/.test(merged)) bonus += 0.05;
  if (focus === "durability" && /(복구|운영|검증자|릴리스|배포)/.test(merged)) bonus += 0.05;
  if ((focus === "liquidity" || focus === "settlement") && /(호가|체결|깊이|유동성|주문)/.test(merged)) bonus += 0.05;
  if (focus === "flow" && /(고래|주소|거래소 자금|자금 방향)/.test(merged)) bonus += 0.05;
  return clampNumber(bonus, 0, 0.24, 0);
}

function deriveHeadlineFamilyKey(headline: string): string {
  return normalizeHeadlineKey(
    sanitizeTweetText(String(headline || ""))
      .replace(/오늘더크게남는[다]?/gu, "")
      .replace(/오늘더크게보인[다]?/gu, "")
      .replace(/에서결국.*$/u, "")
      .replace(/에서.*갈린다$/u, "")
      .replace(/구간이.*$/u, "구간")
      .replace(/장면이.*$/u, "장면")
      .replace(/^(오늘은|지금은|결국)/u, "")
      .trim()
  ).slice(0, 48);
}

function estimateRecentHeadlineFamilyPenalty(
  headline: string,
  lane: TrendLane,
  focus: PlannerFocus,
  recentThreads: Array<{ lane: TrendLane; focus?: string; sceneFamily?: string; headline?: string }>
): number {
  if (!recentThreads.length) return 0;
  const headlineFamily = deriveHeadlineFamilyKey(headline);
  if (!headlineFamily) return 0;
  const recent = recentThreads.slice(0, 8);
  const repeats = recent.filter(
    (item) =>
      item.lane === lane &&
      (item.focus || "general") === focus &&
      deriveHeadlineFamilyKey(item.headline || "") === headlineFamily
  ).length;
  let penalty = 0;
  if (repeats >= 1) penalty += 0.14;
  if (repeats >= 2) penalty += 0.16;
  if (repeats >= 3) penalty += 0.1;
  return clampNumber(penalty, 0, 0.34, 0);
}

function estimateSceneFamilyDominancePenalty(
  lane: TrendLane,
  focus: PlannerFocus,
  sceneFamily: string,
  recentThreads: Array<{ lane: TrendLane; focus?: string; sceneFamily?: string; headline?: string }>
): number {
  if (!recentThreads.length) return 0;
  const recent = recentThreads.slice(0, 8);
  const sameSceneFamilyCount = recent.filter(
    (item) => item.lane === lane && item.sceneFamily && item.sceneFamily === sceneFamily
  ).length;
  if (sameSceneFamilyCount <= 0) return 0;

  let penalty = sameSceneFamilyCount >= 1 ? 0.08 : 0;
  if (sameSceneFamilyCount >= 2) penalty += 0.08;
  if (sameSceneFamilyCount >= 3) penalty += 0.08;

  if (
    (lane === "ecosystem" && focus === "builder" && sceneFamilyMatches(sceneFamily, /builder\+capital$/)) ||
    (lane === "ecosystem" && focus === "retention" && sceneFamilyMatches(sceneFamily, /cohort\+wallet$/)) ||
    (lane === "protocol" && focus === "launch" && sceneFamilyMatches(sceneFamily, /(capital\+launch|return\+launch|return\+showcase)$/)) ||
    (lane === "regulation" && focus === "court" && sceneFamilyMatches(sceneFamily, /^regulation:court:court$/))
  ) {
    penalty += 0.06;
  }

  return clampNumber(penalty, 0, 0.28, 0);
}

function estimateSceneFamilyBasePenalty(
  lane: TrendLane,
  focus: PlannerFocus,
  sceneFamily: string,
  recentThreads: Array<{ lane: TrendLane; focus?: string; sceneFamily?: string; headline?: string }>
): number {
  if (!recentThreads.length) return 0;
  const base = sceneFamilyBase(sceneFamily);
  if (!base) return 0;
  const recent = recentThreads.slice(0, 8);
  const sameBaseCount = recent.filter(
    (item) =>
      item.lane === lane &&
      (item.focus || "general") === focus &&
      sceneFamilyBase(item.sceneFamily || "") === base
  ).length;
  if (sameBaseCount <= 0) return 0;

  let penalty = sameBaseCount >= 1 ? 0.06 : 0;
  if (sameBaseCount >= 2) penalty += 0.07;
  if (sameBaseCount >= 3) penalty += 0.08;

  if (
    (lane === "ecosystem" && focus === "builder" && /builder\+capital$/.test(base)) ||
    (lane === "ecosystem" && focus === "retention" && /(cohort\+wallet|retention\+cohort|wallet\+retention|retention\+usage|habit\+retention|return\+habit)$/.test(base)) ||
    (lane === "protocol" && focus === "launch" && /(capital\+launch|launch\+capital|return\+launch|return\+announcement|return\+ops|return\+showcase|launch\+showcase|launch\+treasury|launch\+ops|launch\+audience|return\+audience)$/.test(base)) ||
    (lane === "protocol" && focus === "durability" && /(rollout\+validator|recovery\+validator|recovery\+rollout|repair\+validator|ops\+validator|ops\+recovery|rollout|ops\+log|repair\+log)$/.test(base)) ||
    (lane === "regulation" && focus === "court" && /(capital\+execution|court\+execution|verdict\+execution|order\+capital|briefing|briefing\+execution)$/.test(base)) ||
    (lane === "market-structure" && focus === "settlement" && /(execution\+settlement|depth\+settlement|execution\+depth|volume\+depth|fill\+depth|fill\+book|volume\+book)$/.test(base))
  ) {
    if (lane === "market-structure" && focus === "settlement") {
      penalty += /execution\+depth$/.test(base) ? 0.16 : 0.12;
    } else if (lane === "ecosystem" && focus === "retention" && /retention\+usage$/.test(base)) {
      penalty += 0.1;
    } else if (lane === "regulation" && focus === "court" && /verdict\+execution$/.test(base)) {
      penalty += 0.1;
    } else if (lane === "regulation" && focus === "court" && /briefing$/.test(base)) {
      penalty += 0.1;
    } else if (lane === "protocol" && focus === "launch" && /return\+launch$/.test(base)) {
      penalty += 0.1;
    } else if (lane === "protocol" && focus === "durability" && /rollout$/.test(base)) {
      penalty += 0.1;
    } else if (lane === "protocol" && focus === "durability" && /ops\+validator$/.test(base)) {
      penalty += 0.08;
    } else if (lane === "protocol" && focus === "launch" && /launch\+ops$/.test(base)) {
      penalty += 0.1;
    } else {
      penalty += 0.08;
    }
  }

  return clampNumber(penalty, 0, 0.34, 0);
}

function estimateExplicitEscapeBonus(
  event: TrendEvent,
  lane: TrendLane,
  focus: PlannerFocus,
  sceneFamily: string,
  recentThreads: Array<{ lane: TrendLane; focus?: string; sceneFamily?: string; headline?: string }>
): number {
  if (!recentThreads.length) return 0;
  const base = sceneFamilyBase(sceneFamily);
  const recent = recentThreads.slice(0, 8);
  const sameBaseCount = recent.filter(
    (item) =>
      item.lane === lane &&
      (item.focus || "general") === focus &&
      sceneFamilyBase(item.sceneFamily || "") === base
  ).length;
  if (sameBaseCount <= 0) return 0;

  const concentratedBase =
    (lane === "ecosystem" && focus === "builder" && /builder\+return$/.test(base)) ||
    (lane === "ecosystem" && focus === "retention" && /(retention\+cohort|wallet\+retention|retention\+wallet|retention\+usage|habit\+retention|return\+habit|community\+retention)$/.test(base)) ||
    (lane === "protocol" && focus === "launch" && /(return\+announcement|return\+launch|launch\+showcase|launch\+treasury|launch\+ops|launch\+audience|return\+audience|return\+ops)$/.test(base)) ||
    (lane === "protocol" && focus === "durability" && /(recovery\+rollout|recovery\+validator|ops\+validator|ops\+recovery|rollout|rollout\+validator|ops\+log|repair\+log|validator\+log)$/.test(base)) ||
    (lane === "regulation" && focus === "court" && /(briefing\+execution|court\+execution|briefing|briefing\+capital|verdict\+execution|capital\+execution|order\+capital)$/.test(base)) ||
    (lane === "market-structure" && focus === "settlement" && /(execution\+depth|volume\+depth|fill\+depth|fill\+book|volume\+book|volume\+settlement|depth\+settlement)$/.test(base));

  if (event.source === "evidence:structural-fallback") {
    const penalty = concentratedBase ? 0.22 : 0.1;
    return -clampNumber(penalty + (sameBaseCount - 1) * 0.05, 0, 0.32, 0);
  }

  let bonus = concentratedBase ? 0.18 : 0.08;
  if (event.source === "analysis:sharp") bonus += 0.05;
  if (sameBaseCount >= 2) bonus += 0.04;
  if (sameBaseCount >= 3) bonus += 0.03;
  return clampNumber(bonus, 0, 0.3, 0);
}

function estimateStructuralFallbackFamilyBias(
  lane: TrendLane,
  focus: PlannerFocus,
  sceneFamily: string
): number {
  if (lane === "ecosystem" && focus === "builder") {
    if (sceneFamilyMatches(sceneFamily, /builder\+capital$/)) return -0.12;
    if (sceneFamilyMatches(sceneFamily, /builder\+return$/)) return 0.06;
    if (sceneFamilyMatches(sceneFamily, /builder\+inside$/)) return 0.04;
    if (sceneFamilyMatches(sceneFamily, /builder\+usage$/)) return 0.08;
    if (sceneFamilyMatches(sceneFamily, /builder\+treasury$/)) return 0.12;
  }
  if (lane === "ecosystem" && focus === "retention") {
    if (sceneFamilyMatches(sceneFamily, /cohort\+wallet$/)) return -0.1;
    if (
      sceneFamilyMatches(sceneFamily, /retention\+usage$/) ||
      sceneFamilyMatches(sceneFamily, /retention\+wallet$/) ||
      sceneFamilyMatches(sceneFamily, /wallet\+retention$/) ||
      sceneFamilyMatches(sceneFamily, /retention\+cohort$/) ||
      sceneFamilyMatches(sceneFamily, /habit\+retention$/) ||
      sceneFamilyMatches(sceneFamily, /return\+habit$/)
    ) return 0.02;
    if (sceneFamilyMatches(sceneFamily, /community\+retention$/)) return 0.12;
    if (sceneFamilyMatches(sceneFamily, /cohort\+usage$/) || sceneFamilyMatches(sceneFamily, /usage\+wallet$/)) return 0.1;
  }
  if (lane === "protocol" && focus === "launch") {
    if (sceneFamilyMatches(sceneFamily, /capital\+launch$/) || sceneFamilyMatches(sceneFamily, /launch\+capital$/)) return -0.12;
    if (sceneFamilyMatches(sceneFamily, /return\+launch$/) || sceneFamilyMatches(sceneFamily, /launch\+return$/)) return 0.1;
    if (sceneFamilyMatches(sceneFamily, /return\+announcement$/)) return 0.06;
    if (sceneFamilyMatches(sceneFamily, /return\+ops$/)) return 0.08;
    if (sceneFamilyMatches(sceneFamily, /return\+showcase$/) || sceneFamilyMatches(sceneFamily, /showcase\+return$/)) return 0.1;
    if (sceneFamilyMatches(sceneFamily, /return\+audience$/) || sceneFamilyMatches(sceneFamily, /audience\+return$/)) return 0.18;
    if (sceneFamilyMatches(sceneFamily, /launch\+showcase$/) || sceneFamilyMatches(sceneFamily, /showcase\+launch$/)) return 0.04;
    if (sceneFamilyMatches(sceneFamily, /launch\+audience$/) || sceneFamilyMatches(sceneFamily, /audience\+launch$/)) return 0.12;
    if (sceneFamilyMatches(sceneFamily, /launch\+ops$/) || sceneFamilyMatches(sceneFamily, /ops\+launch$/)) return 0.08;
    if (sceneFamilyMatches(sceneFamily, /launch\+treasury$/) || sceneFamilyMatches(sceneFamily, /treasury\+launch$/)) return 0.1;
    if (sceneFamilyMatches(sceneFamily, /capital\+rollout$/) || sceneFamilyMatches(sceneFamily, /launch\+rollout$/)) return 0.08;
  }
  if (lane === "regulation" && focus === "court") {
    if (sceneFamilyMatches(sceneFamily, /^regulation:court:court$/)) return -0.08;
    if (sceneFamilyMatches(sceneFamily, /verdict\+execution$/)) return 0.02;
    if (sceneFamilyMatches(sceneFamily, /briefing\+execution$/)) return 0.04;
    if (sceneFamilyMatches(sceneFamily, /court\+execution$/) || sceneFamilyMatches(sceneFamily, /capital\+execution$/)) return 0.08;
    if (sceneFamilyMatches(sceneFamily, /order\+capital$/)) return 0.16;
  }
  if (lane === "protocol" && focus === "durability") {
    if (sceneFamilyMatches(sceneFamily, /repair\+validator$/)) return 0.12;
    if (sceneFamilyMatches(sceneFamily, /repair\+ops$/)) return 0.1;
    if (sceneFamilyMatches(sceneFamily, /repair\+log$/)) return 0.14;
    if (sceneFamilyMatches(sceneFamily, /ops\+validator$/)) return 0.02;
    if (sceneFamilyMatches(sceneFamily, /ops\+log$/)) return 0.12;
    if (sceneFamilyMatches(sceneFamily, /ops\+recovery$/)) return 0.12;
    if (sceneFamilyMatches(sceneFamily, /rollout\+validator$/)) return 0.14;
  }
  if (lane === "market-structure" && focus === "settlement") {
    if (sceneFamilyMatches(sceneFamily, /execution\+depth$/)) return 0.02;
    if (sceneFamilyMatches(sceneFamily, /volume\+depth$/)) return 0.06;
    if (sceneFamilyMatches(sceneFamily, /fill\+depth$/)) return 0.16;
    if (sceneFamilyMatches(sceneFamily, /fill\+book$/)) return 0.14;
    if (sceneFamilyMatches(sceneFamily, /volume\+book$/)) return 0.14;
    if (sceneFamilyMatches(sceneFamily, /volume\+settlement$/)) return 0.18;
    if (sceneFamilyMatches(sceneFamily, /settlement\+heat$/)) return 0.08;
    if (sceneFamilyMatches(sceneFamily, /depth\+heat$/)) return 0.03;
    if (sceneFamilyMatches(sceneFamily, /depth\+settlement$/) || sceneFamilyMatches(sceneFamily, /execution\+settlement$/)) return 0.14;
  }
  return 0;
}

function buildPlannerWarnings(params: {
  event: TrendEvent;
  pair: OnchainEvidence[];
  focus: PlannerFocus;
  sceneFamily: string;
  hasCrossSourceEvidence: boolean;
  evidenceSourceDiversity: number;
  recentNarrativeThreads: Array<{ lane: TrendLane; focus?: string; sceneFamily?: string; headline?: string }>;
}): string[] {
  const warnings = new Set<string>();
  const { event, pair, focus, sceneFamily } = params;
  if (focus === "general") warnings.add("focus-general");
  if (pairIsTooGenericForLane(pair, event.lane)) warnings.add("generic-evidence");
  if (!pairSupportsLaneSemantics(pair, event.lane)) warnings.add("semantic-mismatch");
  if (event.source === "evidence:structural-fallback") warnings.add("structural-fallback");
  if (event.lane !== "onchain" && !params.hasCrossSourceEvidence) warnings.add("single-source");
  if (params.evidenceSourceDiversity < 2) warnings.add("low-diversity");
  if (
    params.recentNarrativeThreads.some(
      (item) => item.lane === event.lane && (item.focus || "general") === focus
    )
  ) {
    warnings.add("focus-repeat");
  }
  if (
    params.recentNarrativeThreads.some(
      (item) => item.lane === event.lane && item.sceneFamily && item.sceneFamily === sceneFamily
    )
  ) {
    warnings.add("scene-repeat");
  }
  return [...warnings];
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
  mode?: NarrativeMode,
  variant: number = 0
): string {
  const lengthBand =
    maxChars <= 110 ? "flash" : maxChars <= 155 ? "short" : maxChars <= 230 ? "standard" : maxChars <= 285 ? "long" : "essay";
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
    const rewriteVariant = (...pool: string[]): string =>
      pool[
        (
          stableSeed(
            `${plan.event.id}|${cleaned}|${plan.lane}|${plan.focus || "general"}|${plan.sceneFamily || "none"}|${lengthBand}|ko-event`
          ) + variant
        ) % pool.length
      ];
    const exactRewriteMap: Record<string, string[]> = {
      "달러가 흔들릴 때 내러티브의 수명이 먼저 길어진다": [
        "달러가 흔들리는 날엔 숫자보다 이야기가 더 오래 남는다",
        "달러 쪽이 출렁이면 가격보다 서사가 오래 버틴다",
      ],
      "메인넷 준비도는 오르는데 복귀 자금이 늦는 출시": [
        "메인넷 준비도는 오르는데 복귀 자금은 아직 느린 출시다",
        "출시 박수는 큰데 복귀 자금은 아직 따라오지 않는 장면이다",
        "메인넷 발표는 앞서는데 복귀 자금이 늦게 붙는 출시다",
        "런치 문장은 빠른데 돌아오는 돈은 아직 더딘 출시다",
        "메인넷 기대감은 큰데 복귀 자금이 늦게 붙는 장면이다",
        "준비도 설명은 앞서는데 실제 복귀는 늦은 출시다",
        "메인넷 문장은 빨랐는데 돌아오는 돈은 아직 주저하는 출시다",
        "출시 기대감은 큰데 실제 복귀 자금은 아직 뒤에 남아 있는 장면이다",
        "준비도는 앞서는데 자금 복귀는 한 박자 느린 출시다",
        "메인넷 설명은 충분한데 돌아오는 돈은 아직 몸을 사리는 출시다",
      ],
      "지갑 재방문은 남는데 커뮤니티 열기만 먼저 식는 구간": [
        "지갑은 돌아오는데 커뮤니티 열기만 먼저 식는 날이다",
        "사람은 다시 들어오는데 열기만 먼저 식는 장면이다",
        "재방문은 남는데 커뮤니티 열기만 먼저 꺼지는 구간이다",
        "돌아오는 지갑은 남는데 커뮤니티 온도만 먼저 빠지는 날이다",
        "재방문 흔적은 남는데 열기만 먼저 식는 구간이다",
        "다시 들어오는 사람은 있는데 커뮤니티 열기만 먼저 꺼지는 장면이다",
        "지갑은 돌아오는데 커뮤니티 열기만 먼저 얇아지는 구간이다",
        "다시 붙는 지갑은 남는데 커뮤니티 온도만 먼저 가라앉는 장면이다",
        "재방문 흔적은 버티는데 커뮤니티 열기만 먼저 빠지는 날이다",
        "사람은 다시 들어오는데 열기만 먼저 납작해지는 구간이다",
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
    if (/구간$/.test(cleaned)) {
      const stem = cleaned.replace(/\s*구간$/u, "").trim();
      const directRangeRewrite = stem
        .replace(/얕은$/u, "얕다")
        .replace(/얕아진$/u, "얕아진다")
        .replace(/늦은$/u, "늦다")
        .replace(/늦는$/u, "늦다")
        .replace(/느린$/u, "느리다")
        .replace(/조용한$/u, "조용하다")
        .replace(/큰$/u, "크다")
        .replace(/빈$/u, "비어 있다")
        .replace(/비는$/u, "빈다")
        .replace(/빠지는$/u, "빠진다")
        .replace(/머무는$/u, "머문다")
        .replace(/머뭇거리는$/u, "머뭇거린다")
        .replace(/미루는$/u, "미룬다")
        .replace(/뒤처지는$/u, "뒤처진다")
        .replace(/못 내려온$/u, "못 내려온다")
        .replace(/안 눕는$/u, "안 눕는다")
        .replace(/못 눕는$/u, "못 눕는다")
        .trim();
      if (/[가-힣)]다$/u.test(directRangeRewrite)) {
        return directRangeRewrite;
      }
      return rewriteVariant(
        `${stem}에서 빈칸이 먼저 드러난다`,
        `${stem}에서 늦게 붙는 쪽이 더 솔직해진다`
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
        `${cleaned}가 결국 구조로 남는지 갈린다`,
        `${cleaned}가 기사로 끝날지 현장까지 내려올지 여기서 갈린다`
      );
    }
    return cleaned;
  };
  const diversifyKoEventHeadlineByFocus = (text: string): string => {
    if (language !== "ko") return text;
    const focus = WRITER_FOCUS_SET.has(plan.focus as WriterFocus) ? (plan.focus as WriterFocus) : "general";
    const cleaned = sanitizeTweetText(text || "").replace(/[.!?]+$/g, "").trim();
    if (!cleaned) return text;
    const pickFocusVariant = (...pool: string[]) =>
      pool[
        (
          stableSeed(
            `${plan.event.id}|${cleaned}|${plan.lane}|${focus}|${plan.sceneFamily || "none"}|${(plan.event.evidenceLabelHints || []).join("|")}|${variant}`
          ) + variant
        ) % pool.length
      ];
    if (plan.event.source !== "evidence:structural-fallback") return text;
    if (plan.lane === "protocol" && focus === "durability") {
      return pickFocusVariant(
        "복구 기록이 늦게 붙는 자리에서 발표와 운영이 갈린다",
        "박수보다 복구 기록이 늦게 남는 날엔 운영 빈칸이 먼저 보인다",
        "좋은 업그레이드 발표도 복구 기록이 비면 금방 종이처럼 얇아진다",
        "운영 로그가 늦게 붙는 날일수록 업그레이드 발표의 본색이 드러난다",
        "복구 태도가 비는 순간 화려한 업그레이드 발표도 바로 시험대에 오른다",
        "배포 속도보다 늦게 남은 복구 기록이 결국 이 업그레이드의 본색을 드러낸다",
        "복구 로그가 느리게 붙는 날일수록 업그레이드 발표는 운영 앞에서 다시 시험받는다",
        "장애 뒤 기록이 늦게 붙는 순간 이 업그레이드 서사는 발표보다 운영 쪽으로 기운다",
        "롤아웃 박수보다 복구 흔적이 늦는 자리가 결국 발표의 무게를 다시 깎는다"
      );
    }
    if (plan.lane === "regulation" && focus === "court") {
      return pickFocusVariant(
        "판결 기사보다 돈의 방향이 늦게 진실을 말하는 날이 있다",
        "법원 문장과 자금 반응이 엇갈리는 자리에서 뉴스 값이 갈린다",
        "소송 일정은 커도 돈이 비면 그 판결 뉴스는 기사값으로 남는다",
        "판결 해설보다 자금 반응이 늦게 붙는 순간 이 뉴스의 무게가 갈린다",
        "법원 뉴스는 길어도 돈이 안 붙는 순간 기사값으로 다시 눌린다",
        "소송 문장보다 늦게 붙는 자금 반응이 결국 판결 뉴스의 본색을 드러낸다",
        "법원 일정은 길어도 자금 반응이 비는 자리에서 결국 기사 톤이 들통난다",
        "판결 문장보다 돈의 방향이 늦게 바뀌는 순간 이 뉴스의 무게도 다시 갈린다",
        "소송 뉴스는 결국 자금이 어느 쪽으로 눕는지 보여 줄 때만 기사값을 벗어난다"
      );
    }
    if (plan.lane === "market-structure" && focus === "liquidity") {
      return pickFocusVariant(
        "체결 없는 호가 열기는 결국 화면값으로 끝난다",
        "호가 두께가 살아도 큰 주문 소화가 비면 과열은 연출 쪽이다",
        "분위기보다 실제 체결이 늦게 남는 자리에서 구조와 연출이 갈린다",
        "호가 열기만 큰 장면은 결국 체결 자리에서 본색이 드러난다",
        "체결보다 호가가 먼저 커진 과열은 금방 화면 장면으로 눌린다",
        "실제 돈보다 호가 열기가 앞서는 순간 구조 변화는 바로 얇아진다"
      );
    }
    if (plan.lane === "ecosystem" && focus === "builder") {
      return pickFocusVariant(
        "코드가 남아도 자금 복귀가 비면 그 생태계 기세는 금방 헐거워진다",
        "개발 흔적과 복귀 자금이 엇갈리는 자리에서 생태계 서사의 밑단이 드러난다",
        "빌더는 남는데 돈이 안 돌아오면 그 생태계 얘기는 반쪽이다",
        "코드와 자금이 다른 말을 하기 시작하면 큰 생태계 서사는 빨리 낡는다",
        "개발자는 남는데 자금이 늦는 순간 생태계 기세의 허리가 먼저 꺾인다",
        "코드는 버티는데 돈이 안 눕는 자리에서 생태계 서사의 본색이 드러난다"
      );
    }
    if (plan.lane === "ecosystem" && focus === "retention") {
      return pickFocusVariant(
        "돌아오는 사람 수와 커뮤니티 열기가 다른 길을 가는 날이다",
        "남는 지갑과 식는 열기가 맞부딪히는 자리에서 생태계 서사의 허리가 드러난다",
        "재방문은 남는데 커뮤니티 온도만 먼저 빠지는 장면이다",
        "남는 사람 수는 버티는데 열기만 먼저 납작해지는 날이다",
        "다시 들어오는 흔적은 남는데 열기만 먼저 비어 가는 구간이다",
        "지갑은 돌아오는데 커뮤니티 열기만 먼저 얇아지는 자리다",
        "남은 사람과 식는 열기가 같은 화면에 겹치는 날이다",
        "재방문은 버티는데 열기만 먼저 가라앉는 장면이다",
        "생활 리듬은 남는데 커뮤니티 서사만 먼저 납작해지는 날이다",
        "다시 들어오는 사람은 남는데 바깥 열기만 먼저 허전해지는 장면이다",
        "남는 습관은 버티는데 커뮤니티 온도만 먼저 식어 가는 구간이다",
        "열기는 큰데 다음 날 다시 돌아오는 흔적이 먼저 빈 자리가 드러난다"
      );
    }
    if (plan.lane === "protocol" && focus === "launch") {
      return pickFocusVariant(
        "메인넷 박수보다 복귀 자금이 늦게 붙는 순간 출시의 체급이 드러난다",
        "준비도 설명과 돌아오는 돈의 속도가 어긋나는 날이다",
        "메인넷 기대감은 큰데 실제 복귀 자금은 아직 몸을 사리는 장면이다",
        "출시 기세는 뜨거운데 돌아오는 돈이 한 박자 늦는 자리다",
        "메인넷 문장보다 자금 복귀가 더디게 붙는 순간 이 런치의 본색이 드러난다",
        "준비도는 충분한데 돌아오는 자금이 늦게 움직이는 출시다",
        "출시 박수는 앞서는데 실제 복귀는 아직 뒤에 남아 있는 날이다",
        "메인넷 기대감과 복귀 자금 속도가 따로 노는 장면이다"
      );
    }
    return text;
  };

  const eventHeadlineRaw = sanitizeTweetText(plan.event.headline).replace(/\.$/, "");
  const baseNarrativeMode = resolveFallbackNarrativeMode(mode || inferNarrativeModeFromHeadline(eventHeadlineRaw));
  const narrativeMode = resolveVariantFallbackNarrativeMode(baseNarrativeMode, plan, variant);
  const intensifyKoEraHeadlineByFocus = (text: string): string => {
    if (language !== "ko" || narrativeMode !== "era-manifesto") return text;
    const focus = WRITER_FOCUS_SET.has(plan.focus as WriterFocus) ? (plan.focus as WriterFocus) : "general";
    const pickEraVariant = (...pool: string[]) =>
      pool[
        (
          stableSeed(
            `${plan.event.id}|${plan.lane}|${focus}|${plan.sceneFamily || "none"}|${(plan.event.evidenceLabelHints || []).join("|")}|${lengthBand}|era-headline|${variant}`
          ) + variant
        ) % pool.length
      ];
    if (plan.lane === "ecosystem" && focus === "retention") {
      if (/habit-gap|return\+habit/.test(plan.sceneFamily || "")) {
        return pickEraVariant(
          "이 국면은 커뮤니티 온도보다 남는 생활 습관의 밀도를 더 엄격하게 심문한다",
          "새 생태계의 질서는 결국 다시 이어지는 습관이 어디에 남는지에서 갈린다",
          "이번 사이클은 반응보다 다음 날에도 이어지는 습관 쪽에 더 비싼 값을 매긴다",
          "생태계의 다음 세대는 결국 남은 사람보다 남은 생활 리듬이 먼저 연다",
          "새 질서는 결국 커뮤니티 반응보다 다음 날에도 이어지는 생활 리듬에서 열린다",
          "이 생태계의 세대감은 결국 남는 열기보다 남는 습관이 먼저 정산한다",
          "이번 국면의 본색은 결국 박수보다 남겨진 생활 리듬이 다시 쓴다"
        );
      }
      if (/wallet-thins|wallet\+retention|cohort-thin/.test(plan.sceneFamily || "")) {
        return pickEraVariant(
          "이 국면은 커뮤니티 열기보다 남는 지갑과 사람 수의 간극을 더 차갑게 본다",
          "새 생태계의 체급은 결국 돌아오는 지갑보다 남는 사람 수가 다시 쓴다",
          "이번 사이클은 재방문 숫자보다 끝까지 남은 사람 수의 밀도로 값이 갈린다",
          "열기보다 남는 사람 수가 비는 순간 생태계의 시대감도 바로 바뀐다",
          "생태계의 체급은 결국 돌아온 지갑보다 끝까지 남은 사람 수가 정산한다",
          "이번 세대는 결국 커뮤니티 열기보다 남는 사람 수의 방향에서 다시 갈린다",
          "새 생태계의 질서는 결국 재방문 숫자보다 남겨진 사람 수가 다시 쓴다"
        );
      }
      return pickEraVariant(
        "이번 국면은 열기보다 남는 사람 수에 더 비싼 값을 매긴다",
        "이 사이클은 커뮤니티 온도보다 재방문 습관을 더 엄격하게 심문한다",
        "생태계의 시대감은 결국 다시 돌아오는 사람 수가 다시 쓴다",
        "지금 바뀌는 건 열기가 아니라 남는 습관의 질서다",
        "새 질서는 결국 커뮤니티 반응보다 남겨진 생활 습관이 먼저 연다",
        "이번 생태계 국면은 열기보다 남는 사람 수의 밀도에서 더 선명해진다"
      );
    }
    if (plan.lane === "ecosystem" && focus === "builder") {
      return pickEraVariant(
        "이 국면은 코드보다 돌아오는 돈의 태도를 더 오래 본다",
        "생태계의 체급은 결국 빌더와 자금이 같은 편에 서는지에서 갈린다",
        "이번 사이클은 개발 흔적보다 복귀 자금의 성격이 더 많은 걸 말한다",
        "생태계의 다음 세대는 결국 코드와 돈이 함께 버틴 자리에서 열린다",
        "새 생태계의 본색은 결국 코드보다 돈이 다시 눕는 자리에서 더 선명해진다",
        "이 세대의 체급은 결국 빌더의 잔류보다 복귀 자금이 어디에 붙는지에서 갈린다",
        "다음 생태계 질서는 결국 코드와 돈이 같이 버틴 시간에서 다시 적힌다"
      );
    }
    if (plan.lane === "regulation" && focus === "court") {
      if (/capital-lag|verdict-gap/.test(plan.sceneFamily || "")) {
        return pickEraVariant(
          "소송 국면의 무게는 결국 판결문보다 늦게 붙는 자금 쪽이 다시 쓴다",
          "법원 뉴스의 시대감은 결국 해설 길이보다 눕지 못한 돈의 자리에서 갈린다",
          "규제 뉴스의 체급은 결국 판결보다 자금이 어느 자리에서 멈추는지에서 정산된다",
          "판결 뉴스의 값은 결국 기사보다 늦게 붙는 돈의 방향이 다시 매긴다",
          "법원 문장의 무게는 결국 판결보다 돈이 끝내 비는 자리에서 다시 정산된다",
          "규제 국면의 값은 결국 해설보다 자금이 멈춰 선 자리에서 더 정확해진다",
          "소송 뉴스의 체급은 결국 기사보다 돈이 어느 자리에서 물러나는지에서 갈린다"
        );
      }
      if (/briefing-gap|briefing\+execution/.test(plan.sceneFamily || "")) {
        return pickEraVariant(
          "규제 국면의 체급은 결국 브리핑보다 집행이 붙는 속도에서 갈린다",
          "법원 해설의 무게는 결국 기사 길이보다 집행 빈칸이 다시 정산한다",
          "이 국면의 규제 뉴스는 결국 브리핑보다 현장 집행의 밀도로 값이 갈린다",
          "소송 뉴스의 세대감은 결국 판결보다 집행 흔적이 어디까지 내려오는지에서 열린다",
          "법원 브리핑의 값은 결국 기사 길이보다 집행이 비는 속도에서 다시 깎인다",
          "규제 뉴스의 질서는 결국 브리핑보다 현장 집행이 남긴 자리에서 다시 쓴다",
          "소송 해설의 체급은 결국 판결보다 집행이 어느 자리까지 내려오는지에서 갈린다"
        );
      }
      return pickEraVariant(
        "이번 국면에서 규제 뉴스의 무게는 판결보다 집행에 눕는다",
        "법원 문장이 아니라 돈이 실제로 어디에 눕는지가 규제의 시대감을 정한다",
        "규제의 체급은 결국 기사보다 집행과 자금이 다시 매긴다",
        "지금 바뀌는 건 판결 뉴스의 크기가 아니라 집행이 붙는 속도다",
        "소송 국면의 무게는 결국 판결문보다 집행과 자금이 같이 남는 자리에서 갈린다",
        "법원 해설의 체급은 결국 기사 길이보다 현장 집행이 버티는 시간에서 정산된다",
        "규제 뉴스의 시대감은 결국 판결보다 집행과 자금이 어디에 눕는지가 다시 쓴다"
      );
    }
    if (plan.lane === "protocol" && focus === "launch") {
      if (/showcase|audience-gap/.test(plan.sceneFamily || "")) {
        return pickEraVariant(
          "이번 런치의 값은 결국 무대보다 객석의 돈이 다시 쓴다",
          "메인넷의 시대감은 결국 쇼케이스보다 돌아오지 않은 돈의 자리에서 갈린다",
          "출시 국면의 체급은 결국 발표보다 객석 바깥으로 나온 돈의 속도에서 정산된다",
          "메인넷 무대는 뜨거워도 시대의 값은 결국 객석의 돈이 다시 매긴다"
        );
      }
      if (/ops-cold|return-lag/.test(plan.sceneFamily || "")) {
        return pickEraVariant(
          "이번 사이클은 메인넷 설명보다 늦게 붙는 운영과 복귀의 속도로 갈린다",
          "런치의 체급은 결국 발표보다 운영 반응과 자금 복귀가 같이 남는지에서 정산된다",
          "새 메인넷의 무게는 결국 준비도보다 복귀와 운영이 어느 자리에서 버티는지에서 갈린다",
          "출시 국면의 질서는 결국 박수보다 늦게 붙는 복귀와 운영 태도가 다시 쓴다"
        );
      }
      return pickEraVariant(
        "이번 사이클은 출시 박수보다 돌아오는 돈의 속도로 체급이 갈린다",
        "메인넷의 시대감은 결국 복귀 자금이 얼마나 늦게 붙는지에서 드러난다",
        "런치의 값은 발표보다 객석의 돈이 더 오래 다시 쓴다",
        "지금 시장은 준비도보다 복귀의 태도에 더 비싼 값을 매긴다",
        "출시 무대는 뜨거워도 시대의 값은 결국 돌아오는 돈이 다시 적는다",
        "메인넷 서사의 체급은 결국 객석 밖으로 나온 돈이 다시 매긴다",
        "이번 런치의 국면은 설명보다 복귀 자금이 얼마나 오래 머무는지에서 갈린다"
      );
    }
    if (plan.lane === "protocol" && focus === "durability") {
      return pickEraVariant(
        "새 프로토콜의 시대는 배포 속도보다 복구 태도가 결정한다",
        "업그레이드의 체급은 결국 운영 로그가 다시 쓴다",
        "이 국면은 릴리스 노트보다 장애 뒤 태도를 더 엄격하게 본다",
        "프로토콜의 질서는 결국 복구 기록이 늦게 선언한다",
        "이 개선의 세대감은 결국 장애 뒤 기록이 얼마나 오래 남는지에서 갈린다",
        "업그레이드의 시대는 결국 박수보다 복구 속도가 다시 정리한다",
        "새 프로토콜의 값은 결국 운영 로그가 어디서 버티는지에서 다시 매겨진다"
      );
    }
    if (plan.lane === "market-structure" && (focus === "settlement" || focus === "liquidity")) {
      if (/book-thin|execution-thin/.test(plan.sceneFamily || "")) {
        return pickEraVariant(
          "이 국면은 거래량보다 늦게 남는 호가 두께가 체급을 다시 쓴다",
          "시장 구조의 체급은 결국 숫자보다 호가 책이 어디서 비는지에서 갈린다",
          "새 장세의 값은 결국 체결보다 늦게 붙는 깊이 빈칸이 다시 정산한다",
          "정산의 시대감은 결국 거래량보다 호가 책의 빈칸이 어디서 남는지에서 드러난다",
          "이 장세의 무게는 결국 숫자보다 호가 책의 빈칸이 어디까지 버티는지에서 갈린다",
          "새 시장 질서는 결국 거래량보다 깊이의 빈칸이 먼저 선언한다",
          "시장 구조의 세대감은 결국 체결보다 호가 두께가 어디서 꺼지는지에서 정산된다"
        );
      }
      if (/size-only|settlement-lag/.test(plan.sceneFamily || "")) {
        return pickEraVariant(
          "이 국면은 숫자 크기보다 정산 깊이가 어디서 따라오지 못하는지에서 갈린다",
          "새 장세의 질서는 결국 거래량보다 정산 깊이의 지연이 다시 쓴다",
          "시장 구조의 값은 결국 숫자 반응보다 깊이가 늦게 눕는 자리에서 정산된다",
          "정산의 체급은 결국 거래량보다 늦게 따라온 깊이가 다시 매긴다",
          "이 장세의 본색은 결국 숫자보다 정산 깊이가 비는 자리에서 더 크게 남는다",
          "새 질서는 결국 거래량보다 늦게 눕는 깊이가 어디서 멈추는지에서 갈린다",
          "시장 국면의 체급은 결국 숫자보다 정산 깊이가 따라오지 못한 자리에서 정산된다"
        );
      }
      return pickEraVariant(
        "이 국면은 호가가 아니라 실제 돈이 시장의 질서를 다시 정한다",
        "새 장세는 체결이 얼마나 오래 남는지가 먼저 선언한다",
        "시장 구조의 체급은 결국 화면보다 돈이 어디에 눕는지가 다시 쓴다",
        "지금 바뀌는 건 분위기가 아니라 정산 깊이가 허락하는 행동의 폭이다",
        "한 장세의 무게는 결국 체결보다 늦게 남은 깊이가 어디까지 버티는지에서 갈린다",
        "시장 국면의 질서는 결국 화면 열기보다 정산 깊이가 남긴 행동의 폭에서 다시 정해진다",
        "새 구조는 결국 실제 돈이 어느 깊이까지 눕는지에서 먼저 선언된다"
      );
    }
    if (plan.lane === "onchain") {
      return pickEraVariant(
        "온체인의 시대감은 결국 하루를 버틴 흔적이 다시 쓴다",
        "새 장세는 튀는 숫자보다 남는 흔적의 권위가 먼저 선언한다",
        "이 국면은 예쁜 수치보다 버틴 주소와 자금의 습관에 더 엄격하다",
        "온체인의 질서는 결국 오래 남은 흔적 쪽으로 다시 기운다"
      );
    }
    if (plan.lane === "macro") {
      return pickEraVariant(
        "이 국면은 헤드라인보다 자금 습관이 시대의 방향을 더 빨리 말한다",
        "새 사이클은 해설보다 배치가 먼저 선언한다",
        "거시의 체급은 결국 설명이 아니라 돈의 습관이 다시 매긴다",
        "시대는 결국 해설보다 배치가 어디로 눕는지에서 갈린다"
      );
    }
    return text;
  };
  const eventHeadline =
    language === "ko"
      ? intensifyKoEraHeadlineByFocus(diversifyKoEventHeadlineByFocus(humanizeKoEventHeadline(eventHeadlineRaw)))
      : eventHeadlineRaw;
  const [koEvidenceA, koEvidenceB] = language === "ko" ? resolveDistinctKoEvidenceAnchors(plan) : ["", ""];
  const evidenceA = language === "ko" ? koEvidenceA : formatEvidenceAnchor(plan.evidence[0], language);
  const evidenceB = language === "ko" ? koEvidenceB : formatEvidenceAnchor(plan.evidence[1], language);
  const seed = stableSeed(`${plan.event.id}|${eventHeadline}|${evidenceA}|${evidenceB}|${narrativeMode}`);

  if (language === "ko") {
    const preferredFocus = WRITER_FOCUS_SET.has(plan.focus as WriterFocus)
      ? (plan.focus as WriterFocus)
      : undefined;
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
      sceneFamily: plan.sceneFamily,
      preferredFocus,
      mode: narrativeMode,
      worldviewHint: worldviewByLane[plan.lane],
      signatureBelief: signatureByLane[plan.lane],
      recentReflection: worldviewByLane[plan.lane],
      maxChars,
      seedHint: `${plan.event.id}|${plan.sceneFamily || "none"}|fallback|${narrativeMode}|${variant}`,
    }, variant);
  }

  const enTemplates: Record<NarrativeMode, string[]> = {
    "identity-journal": [
      `What I log today is ${eventHeadline}. Anchors are ${evidenceA} and ${evidenceB}. I verify this first and drop the thesis if opposite evidence persists.`,
      `One line from my journal: ${eventHeadline}. My anchors are ${evidenceA} and ${evidenceB}. I re-check next cycle and revise if the condition breaks.`,
    ],
    "era-manifesto": [
      `${eventHeadline}. This cycle is repricing behavior before narrative, and ${evidenceA} plus ${evidenceB} are where that repricing shows up first.`,
      `${eventHeadline}. When the era actually turns, it is ${evidenceA} and ${evidenceB} that redraw the rules before commentary catches up.`,
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
  if (mode === "era-manifesto") {
    return "era-manifesto";
  }
  if (mode === "philosophy-note") {
    return "meta-reflection";
  }
  return mode;
}

function inferNarrativeModeFromHeadline(headline: string): NarrativeMode {
  const lower = sanitizeTweetText(headline).toLowerCase();
  if (/시대|세대|질서|국면|체제|레짐|정당성|관성|습관|전환/.test(lower)) return "era-manifesto";
  if (/철학|philosophy|책|book|사상|worldview/.test(lower)) return "philosophy-note";
  if (/실험|experiment|미션|mission|커뮤니티/.test(lower)) return "interaction-experiment";
  if (/회고|reflection|실수|failure|오판/.test(lower)) return "meta-reflection";
  if (/우화|fable|에세이|essay|비유/.test(lower)) return "fable-essay";
  return "identity-journal";
}

function resolveVariantFallbackNarrativeMode(
  baseMode: NarrativeMode,
  plan: EventEvidencePlan,
  variant: number
): NarrativeMode {
  const focus = String(plan.focus || "general");
  const sceneFamily = String(plan.sceneFamily || "");
  const headline = sanitizeTweetText(plan.event.headline || "");
  const longFormVariant = variant % 5 === 3 || variant % 5 === 4;
  const eraEligible =
    /(retention|builder|court|launch|durability|settlement|liquidity|flow)/.test(focus) ||
    /(lag|thin|split|return|habit|execution|settlement|validator|court|usage|wallet|capital|depth)/.test(sceneFamily) ||
    /(시대|세대|질서|국면|체제|전환|정당성|습관)/.test(headline);
  const hardEraEligible =
    /(court|launch|durability|settlement|retention|builder)/.test(focus) ||
    /(verdict|execution|return|announcement|showcase|ops|validator|usage|cohort|wallet|depth|capital)/.test(sceneFamily);
  if ((hardEraEligible && longFormVariant) || (eraEligible && variant % 3 === 2)) {
    return "era-manifesto";
  }
  return baseMode;
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

function pickPreferredPlanCandidate<
  T extends {
    score: number;
    event: TrendEvent;
    plannerWarnings?: string[];
    focus?: string;
    sceneFamily?: string;
  }
>(items: T[]): T {
  if (items.length <= 1) return items[0];
  const sorted = [...items].sort((a, b) => b.score - a.score);
  const best = sorted[0];
  const structuralTop = best.event.source === "evidence:structural-fallback";
  if (!structuralTop) return pickWeightedPlanCandidate(sorted);

  const explicitCandidates = sorted.filter((item) => item.event.source !== "evidence:structural-fallback");
  if (!explicitCandidates.length) return pickWeightedPlanCandidate(sorted);

  const preferredExplicit = explicitCandidates.find((candidate) => {
    const scoreGap = best.score - candidate.score;
    const warningDelta =
      (best.plannerWarnings?.length || 0) - (candidate.plannerWarnings?.length || 0);
    const sceneSwitch = best.sceneFamily && candidate.sceneFamily && best.sceneFamily !== candidate.sceneFamily;
    const sameBase =
      best.sceneFamily &&
      candidate.sceneFamily &&
      sceneFamilyBase(best.sceneFamily) === sceneFamilyBase(candidate.sceneFamily);
    const structuralUnderPressure =
      (best.plannerWarnings || []).includes("scene-repeat") ||
      (best.plannerWarnings || []).includes("focus-repeat") ||
      (best.plannerWarnings || []).includes("structural-fallback");
    return (
      scoreGap <= (structuralUnderPressure ? 0.3 : 0.22) &&
      (
        warningDelta >= 1 ||
        scoreGap <= 0.12 ||
        sceneSwitch ||
        (structuralUnderPressure && !sameBase) ||
        (structuralUnderPressure && candidate.event.source === "analysis:sharp" && scoreGap <= 0.18)
      )
    );
  });

  return preferredExplicit || pickWeightedPlanCandidate(sorted);
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
          ? "쌓이는 밀린 거래 압박"
          : backlogDirection === "down"
            ? "풀리는 밀린 거래 압박"
            : "중립 거래 적체";
      return rewrite(
        label,
        "",
        backlogDirection === "up"
          ? "밀린 거래 압박이 실제 체결 지연으로 이어지는지 볼 장면이다."
          : backlogDirection === "down"
            ? "밀린 거래 압박이 빠르게 해소되는지 확인할 장면이다."
            : "밀린 거래 압박이 중립권에서 머무는지 확인할 장면이다."
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
          ? "관망 자금 유입"
          : direction === "down"
            ? "관망 자금 이탈"
            : "관망 자금 정체";
      return rewrite(
        label,
        "",
        direction === "up"
          ? "관망 자금이 실제 위험 선호로 번지는지 볼 장면이다."
          : direction === "down"
            ? "관망 자금이 빠지며 체인 안쪽 열기가 식는지 볼 장면이다."
            : "관망 자금이 아직 방향을 만들지 못한 채 머무는지 볼 장면이다."
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
  if (/ai agent|visa|prediction market|wallet|adoption|community|developer|builder|ecosystem|app|지갑|채택|커뮤니티|개발자|빌더|생태계|앱|실사용|사용/.test(normalized)) {
    if (/visa/.test(normalized)) {
      return rewrite("Visa 실사용", "", "결제 인프라 쪽 얘기가 실제 사용 흐름까지 번지는지 볼 장면이다.");
    }
    if (/prediction market/.test(normalized)) {
      return rewrite("예측시장 사용", "", "예측시장 쪽 사용 습관이 실제 거래 행동을 바꾸는지 볼 장면이다.");
    }
    if (/wallet|지갑/.test(normalized)) {
      return rewrite("지갑 재방문", "", "지갑 안쪽 사용 습관이 서사보다 먼저 바뀌는지 볼 장면이다.");
    }
    if (/developer|builder|개발자|빌더/.test(normalized)) {
      return rewrite("개발자 잔류", "", "개발자 쪽 움직임이 실제 생태계 습관으로 번지는지 볼 장면이다.");
    }
    if (/community|커뮤니티/.test(normalized)) {
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
  return /(네트워크\s*수수료|체인\s*수수료|체인\s*사용|멤풀|대기\s*거래|거래\s*대기|밀린\s*거래|거래\s*적체|mempool|network fee|backlog)/.test(
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
  const normalized = sanitizeTweetText(label);
  if (
    /^(사용자 재방문 흐름|지갑 재방문|개발자 잔류|예치 자금 복귀|복귀 자금|자금 쏠림 방향|집행 흔적|현장 반응|복구 속도|검증자 안정성)$/i.test(
      normalized
    )
  ) {
    return false;
  }
  if (
    /^(시장 반응|가격 반응|가격 움직임|알트 쪽 움직임|실사용 실험|실사용 흐름|실사용 흔적|실사용 잔류|사용으로 남는 흔적|규제 쪽 실제 움직임|규제 반응|규제 일정|규제 쪽 일정|규제 집행 일정|프로토콜 변화 신호|업그레이드 진행|업그레이드 운영 반응|외부 뉴스 흐름|외부 뉴스 반응|업계 스트레스 신호|업계 스트레스|업계 스트레스 확대|가격 분위기|체인 안쪽 사용|체인 사용|거래 대기|밀린 거래|거래 적체|큰손 움직임|대기 자금|대기 자금 흐름|관망 자금|관망 자금 흐름|거래소 쪽 자금 이동|지갑 안쪽 사용|개발자 반응|커뮤니티 반응|커뮤니티 잔류|실사용 잔류|검증자 반응|테스트넷·메인넷 흐름|금리 기대 변화|달러 흐름|거시 흐름 변화|거시 압력 변화|ETF 쪽 일정|SEC·CFTC 움직임|법원 쪽 일정|실사용 반응|재방문 흐름|체인 바깥 반응)$/i.test(
      normalized
    )
  ) {
    return true;
  }
  if (
    /(흐름|반응|일정|흔적|방향)$/.test(normalized) &&
    !/(개발자 잔류|예치 자금 복귀|현물 체결 재가동|거래소 자금 관망|고래 주소 재가동|법원 판결 일정|ETF 심사 흐름|호가 유동성 식음|검증자 안정성|복구 속도)/.test(
      normalized
    )
  ) {
    return true;
  }
  return false;
}

function estimateEvidenceSpecificity(item: OnchainEvidence, lane: TrendLane): number {
  const label = sanitizeTweetText(item.label || "");
  const merged = sanitizeTweetText(`${item.label} ${item.value} ${item.summary}`).toLowerCase();
  if (isLowSignalEvidenceForEvent(item)) return 0.05;

  let score = 0.42;

  if (isGenericLaneEvidenceLabel(label)) score -= 0.18;
  if (
    /(유입|이탈|확대|둔화|강세|약세|압박|정체|심사|승인|신청|소송|법원|집행|검증자|복구|재방문|잔류|체결|호가|유동성|대기 자금|관망 자금|거래소 쪽 자금|큰손 움직임|밀린 거래|거래 적체|복귀 자금|예치 자금 복귀|개발자 잔류|자금 쏠림 방향)/.test(
      label
    )
  ) {
    score += 0.24;
  }
  if (/(체인 안쪽 사용|실사용 흔적|대기 자금 흐름|관망 자금 흐름|거래소 쪽 자금 이동|규제 반응|규제 일정|업그레이드 진행|외부 뉴스 반응|가격 반응)/.test(label)) {
    score -= 0.12;
  }
  if (/(커뮤니티 잔류|실사용 잔류)/.test(label)) {
    score -= 0.1;
  }
  if (/(자금 쏠림 방향|재방문 흐름|집행 흔적|현장 반응|복귀 자금|예치 자금 복귀|개발자 잔류)/.test(label)) {
    score += 0.08;
  }
  if (item.value && !/^(?:포착|감지|정상화|안정|중립|과열 가능성|컷 기대 지연|이동 포착|observed)$/i.test(item.value.trim())) {
    score += 0.05;
  }

  const laneSpecificByLane: Record<TrendLane, RegExp> = {
    protocol: /(검증자|복구|메인넷|테스트넷|합의|firedancer|rollup|업그레이드)/,
    ecosystem: /(재방문|잔류|커뮤니티|개발자|지갑|실사용|사용|앱)/,
    regulation: /(규제|정책|법원|소송|당국|etf|심사|승인|집행)/,
    macro: /(달러|금리|물가|inflation|rates|dxy|usd|eur)/,
    onchain: /(체인 사용|거래 대기|밀린 거래|거래 적체|대기 자금|관망 자금|거래소 쪽 자금|큰손|주소|온체인|멤풀|스테이블)/,
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
      pair.some((item) => /(대기 자금 흐름|관망 자금 흐름|가격 반응|가격 움직임|가격 분위기|시장 반응)/.test(item.label)) &&
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
        return /(체인 사용|거래 대기|밀린 거래|거래 적체|네트워크 수수료|멤풀|가격 반응|가격 움직임|대기 자금 흐름|관망 자금 흐름|etf 심사 흐름|규제 일정|규제 반응)/.test(
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
  secondary: OnchainEvidence,
  variant: number = 0
): string {
  const a = humanizeStructuralEvidenceLabel(primary.label);
  const b = humanizeStructuralEvidenceLabel(secondary.label);
  const pair = joinKoPair(a, b);
  const focus = resolvePlannerFocus(lane, [primary, secondary]);
  const sceneFamily = resolvePlannerSceneFamily(lane, focus, [primary, secondary]);
  const tilt = sceneFamilyTilt(sceneFamily);
  const seed = stableSeed(`${lane}|${a}|${b}|headline|v${variant}`);

  const focusPoolByLane: Partial<Record<TrendLane, Partial<Record<PlannerFocus, string[]>>>> = {
    ecosystem: {
      retention: [
        `${pair}, 이 조합이 같이 버텨야 생태계 반응도 오래 간다`,
        `${pair}, 이 조합이 갈라지면 열기보다 잔류가 더 중요해진다`,
        `${pair}, 이 조합이 따로 놀면 큰 생태계 서사도 금방 얇아진다`,
      ],
      builder: [
        `${pair}, 이 조합이 같이 남아야 개발 기세도 구조로 남는다`,
        `${pair}, 이 조합이 따로 놀면 생태계 기세는 금방 헐거워진다`,
        `${pair}, 이 조합이 같이 붙지 않으면 큰 생태계 얘기도 오래 못 간다`,
      ],
      hype: [
        `${pair}, 이 조합이 갈라지면 생태계 서사는 과열 쪽으로 기운다`,
        `${pair}, 이 조합이 같이 남지 않으면 홍보 열기만 남는다`,
        `${pair}, 이 조합이 따로 놀면 큰 생태계 문장도 금방 광고처럼 보인다`,
      ],
    },
    regulation: {
      execution: [
        `${pair}, 이 조합이 같이 남아야 규제 뉴스도 기사값을 벗어난다`,
        `${pair}, 이 조합이 갈라지면 규제 해석보다 집행 빈칸이 더 크게 보인다`,
        `${pair}, 이 조합이 따로 놀면 그 규제 뉴스는 아직 기사 단계에 머문다`,
      ],
      court: [
        `${pair}, 이 조합이 같이 남아야 소송 뉴스도 기사값을 벗어난다`,
        `${pair}, 이 조합이 갈라지면 판결 기사보다 자금 반응이 더 중요해진다`,
        `${pair}, 이 조합이 따로 놀면 법원 뉴스는 기사 톤에서 못 벗어난다`,
      ],
    },
    protocol: {
      durability: [
        `${pair}, 이 조합이 같이 버텨야 프로토콜 신뢰가 성립한다`,
        `${pair}, 이 조합이 갈라지면 릴리스 노트보다 복구 기록이 더 중요해진다`,
        `${pair}, 이 조합이 따로 놀면 업그레이드 얘기는 운영까지 못 내려온다`,
      ],
      launch: [
        `${pair}, 이 조합이 같이 붙어야 출시 서사도 반쪽을 벗어난다`,
        `${pair}, 이 조합이 갈라지면 메인넷 발표보다 복귀 자금이 더 중요해진다`,
        `${pair}, 이 조합이 따로 놀면 런치 박수는 금방 얇아진다`,
      ],
    },
    onchain: {
      durability: [
        `${pair}, 이 조합이 같이 남아야 온체인 숫자도 단서가 된다`,
        `${pair}, 이 조합이 갈라지면 오래 남은 쪽만 근거가 된다`,
        `${pair}, 이 조합이 따로 놀면 예쁜 숫자도 오래 못 버틴다`,
      ],
      flow: [
        `${pair}, 이 조합이 같이 남아야 고래 움직임도 반쪽을 벗어난다`,
        `${pair}, 이 조합이 갈라지면 주소 숫자보다 자금 방향이 더 중요해진다`,
        `${pair}, 이 조합이 따로 놀면 주소 흔적은 아직 반쪽짜리다`,
      ],
    },
    "market-structure": {
      liquidity: [
        `${pair}, 이 조합이 같이 남아야 과열도 구조 변화가 된다`,
        `${pair}, 이 조합이 갈라지면 화면 열기보다 체결 쪽이 더 중요해진다`,
        `${pair}, 이 조합이 따로 놀면 그 과열은 실제 돈보다 분위기 쪽이다`,
      ],
      settlement: [
        `${pair}, 이 조합이 같이 남아야 체결 반응도 구조가 된다`,
        `${pair}, 이 조합이 갈라지면 숫자보다 호가 두께가 더 중요해진다`,
        `${pair}, 이 조합이 따로 놀면 거래량 반응은 아직 깊이를 못 만들었다`,
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
  if (lane === "protocol" && focus === "durability") {
    if (sceneFamilyMatches(sceneFamily, /rollout\+validator$/)) {
      const rolloutValidatorPool = [
        `검증자는 버티는데 배포 흔적이 비면 그 업그레이드는 운영보다 발표가 앞선 셈이다`,
        `배포 기세와 검증자 안정성이 갈라지면 사람들은 릴리스 박수보다 운영 태도를 더 본다`,
        `검증자 안정성만 남고 배포 흔적이 비면 그 개선 서사는 결국 발표 자료처럼 눕는다`,
        `배포 로그가 빈 자리에서 검증자 안정성만 강조되면 그 업그레이드는 반쪽 설명으로 보인다`,
        `검증자 숫자는 버티는데 배포 태도가 안 붙으면 그 발표는 운영보다 쇼케이스에 가깝다`,
        `배포 흔적이 늦는 순간 검증자 안정성도 좋은 발표용 숫자로 얇아진다`,
      ];
      return sanitizeTweetText(rolloutValidatorPool[seed % rolloutValidatorPool.length]).slice(0, 140);
    }
    if (sceneFamilyMatches(sceneFamily, /recovery\+validator$/)) {
      const recoveryPool = [
        `검증자 안정성은 버티는데 복구 기록이 비면 그 업그레이드는 결국 발표회에 가깝다`,
        `복구 기록과 검증자 안정성이 갈라지면 사람들은 박수보다 운영 빈칸부터 보게 된다`,
        `복구 기록과 검증자 안정성이 따로 놀면 그 개선 서사는 슬라이드 문장으로 돌아간다`,
        `검증자 안정성만 버티고 복구 기록이 늦으면 그 업그레이드는 운영보다 발표가 앞선 셈이다`,
        `장애 뒤 복구 로그가 비는 순간 검증자 안정성도 발표용 숫자로 보이기 시작한다`,
        `복구 기록이 늦게 붙는 날엔 검증자 안정성도 좋은 발표 자료 이상이 되지 못한다`,
      ];
      return sanitizeTweetText(recoveryPool[seed % recoveryPool.length]).slice(0, 140);
    }
    if (sceneFamilyMatches(sceneFamily, /recovery\+rollout$/)) {
      const rolloutPool = [
        `배포 기세와 복구 기록이 같이 남아야 업그레이드도 오래 버틴다`,
        `배포 기세와 복구 기록이 갈라지면 릴리스 노트가 먼저 얇아진다`,
        `배포 기세와 복구 기록이 따로 놀면 발표보다 운영 태도가 더 빨리 드러난다`,
        `롤아웃 속도는 살아도 복구 기록이 비면 그 개선 서사는 금방 납작해진다`,
        `배포 기세와 장애 뒤 기록이 다른 편에 서면 박수보다 빈칸이 더 오래 남는다`,
        `롤아웃 박수와 복구 기록이 엇갈리는 순간 업그레이드 얘기는 반쪽이 된다`,
      ];
      return sanitizeTweetText(rolloutPool[seed % rolloutPool.length]).slice(0, 140);
    }
  }
  if (lane === "protocol" && focus === "launch" && sceneFamilyMatches(sceneFamily, /launch\+rollout$/)) {
    const launchRolloutPool = [
      `런치 박수와 배포 속도가 같이 붙어야 출시 서사도 오래 버틴다`,
      `런치 박수와 배포 속도가 갈라지면 메인넷 기세부터 얇아진다`,
      `런치 박수와 배포 속도가 따로 놀면 발표보다 운영 빈칸이 먼저 드러난다`,
    ];
    return sanitizeTweetText(launchRolloutPool[seed % launchRolloutPool.length]).slice(0, 140);
  }
  if (lane === "protocol" && focus === "launch") {
    if (sceneFamilyMatches(sceneFamily, /return\+announcement$/)) {
      const returnAnnouncementPool = [
        `메인넷 발표는 큰데 돌아오는 돈은 아직 같은 말을 하지 않는 장면이다`,
        `설명은 앞서는데 복귀 자금은 아직 발표 바깥에 머무는 구간이다`,
        `뉴스는 뜨거운데 돈은 아직 발표를 실제 복귀로 인정하지 않은 장면이다`,
        `기대는 커졌는데 복귀 자금은 아직 발표값을 의심하는 메인넷 구간이다`,
      ];
      return sanitizeTweetText(returnAnnouncementPool[seed % returnAnnouncementPool.length]).slice(0, 140);
    }
    if (sceneFamilyMatches(sceneFamily, /return\+ops$/)) {
      const returnOpsPool = [
        `메인넷 설명은 살아도 운영 로그와 복귀 자금이 아직 같은 편에 서지 않은 장면이다`,
        `운영 흔적은 느리고 돈의 복귀도 늦어서 발표보다 빈칸이 먼저 보이는 구간이다`,
        `복귀 자금은 더디고 운영 로그도 얕아 이 런치가 아직 종이 밖으로 못 나온 장면이다`,
        `메인넷 뉴스는 큰데 운영과 복귀 자금이 함께 머뭇거리는 구간이다`,
      ];
      return sanitizeTweetText(returnOpsPool[seed % returnOpsPool.length]).slice(0, 140);
    }
    if (sceneFamilyMatches(sceneFamily, /return\+showcase$/) || sceneFamilyMatches(sceneFamily, /showcase\+return$/)) {
      const returnShowcasePool = [
        `메인넷 무대는 커졌는데 돈의 복귀는 아직 객석에서 계산기를 두드리는 장면이다`,
        `쇼케이스 열기는 선명한데 돌아오는 돈은 아직 무대 바깥에 남아 있는 구간이다`,
        `복귀 자금은 느린데 무대 연출이 앞서는 런치는 결국 발표 체급으로 눌린다`,
        `무대는 다 준비됐지만 돈이 아직 객석에서 몸을 사리는 메인넷 장면이다`,
      ];
      return sanitizeTweetText(returnShowcasePool[seed % returnShowcasePool.length]).slice(0, 140);
    }
    if (sceneFamilyMatches(sceneFamily, /return\+launch$/) || sceneFamilyMatches(sceneFamily, /launch\+return$/)) {
      const returnLaunchPool = [
        `메인넷 설명은 살아도 복귀 자금이 늦으면 그 출시는 아직 장부 밖에 있다`,
        `런치 박수보다 돈의 복귀가 늦는 장면에선 발표보다 빈칸이 먼저 커진다`,
        `복귀 자금이 안 눕는 메인넷 뉴스는 결국 무대보다 객석 쪽에 더 가깝다`,
        `메인넷 설명은 충분해도 돌아오는 돈이 비면 그 출시는 아직 사람들 장부에 못 내려왔다`,
        `복귀 자금이 더딘 런치는 기세보다 망설임이 먼저 남는다`,
        `메인넷 기대가 커도 돈이 돌아오지 않으면 그 장면은 아직 발표회에 묶여 있다`,
      ];
      return sanitizeTweetText(returnLaunchPool[seed % returnLaunchPool.length]).slice(0, 140);
    }
    if (sceneFamilyMatches(sceneFamily, /launch\+ops$/) || sceneFamilyMatches(sceneFamily, /ops\+launch$/)) {
      const launchOpsPool = [
        `메인넷 박수보다 늦게 남는 건 결국 운영 로그 쪽이다`,
        `런치 설명은 커도 운영 흔적이 늦으면 그 출시는 아직 무대 안에 갇혀 있다`,
        `메인넷 뉴스는 빨라도 운영 반응이 안 붙으면 그 장면은 발표보다 얇다`,
        `운영 로그가 따라오지 않는 런치는 메인넷보다 쇼케이스 쪽에 더 가깝다`,
      ];
      return sanitizeTweetText(launchOpsPool[seed % launchOpsPool.length]).slice(0, 140);
    }
    if (sceneFamilyMatches(sceneFamily, /launch\+showcase$/) || sceneFamilyMatches(sceneFamily, /showcase\+launch$/)) {
      const showcasePool = [
        `메인넷 무대는 뜨거운데 실제 복귀는 아직 객석에 남아 있는 장면이다`,
        `런치 쇼케이스가 커질수록 사람들 돈은 오히려 더 신중하게 눕는다`,
        `무대 위 런치는 화려한데 장부 안쪽 복귀는 아직 얕은 구간이다`,
        `쇼케이스가 앞서는 메인넷 뉴스는 늘 실제 복귀보다 크게 들린다`,
      ];
      return sanitizeTweetText(showcasePool[seed % showcasePool.length]).slice(0, 140);
    }
    if (sceneFamilyMatches(sceneFamily, /capital\+launch$/) || sceneFamilyMatches(sceneFamily, /launch\+capital$/)) {
      const launchCapitalPool =
        tilt === "launch-holds"
          ? [
              `메인넷 준비도는 살아 있는데 돈은 아직 마지막 서명을 미루는 장면이다`,
              `출시 설명은 충분한데 복귀 자금은 아직 고개를 덜 드는 구간이다`,
              `메인넷 문장은 탄탄한데 돈이 눕는 속도는 여전히 신중한 장면이다`,
            ]
          : [
              `메인넷 준비도는 올라가는데 복귀 자금이 비면 그 출시는 쇼케이스에 더 가깝다`,
              `메인넷 설명과 복귀 자금이 갈라지면 런치 박수는 바로 발표값으로 눌린다`,
              `메인넷 준비도만 앞서고 복귀 자금이 늦으면 그 출시는 아직 사람들 돈을 설득하지 못했다`,
              `메인넷 준비도는 살아도 복귀 자금이 비는 순간 이 런치는 무대 위 발표로 돌아간다`,
              `복귀 자금이 안 붙은 메인넷 발표는 결국 출시라기보다 데모에 가깝다`,
              `런치 준비도와 복귀 자금이 다른 편이면 메인넷 서사는 쇼케이스처럼 가벼워진다`,
            ];
      return sanitizeTweetText(launchCapitalPool[seed % launchCapitalPool.length]).slice(0, 140);
    }
    if (sceneFamilyMatches(sceneFamily, /capital\+rollout$/) || sceneFamilyMatches(sceneFamily, /rollout\+capital$/)) {
      const rolloutCapitalPool = [
        `배포 속도와 복귀 자금이 같이 붙어야 출시 기세도 운영으로 내려온다`,
        `배포 속도와 복귀 자금이 갈라지면 메인넷 서사는 발표보다 빈칸이 먼저 커진다`,
        `배포 속도와 복귀 자금이 따로 놀면 런치 기세는 금방 종이처럼 얇아진다`,
        `배포 속도는 앞서도 복귀 자금이 비면 그 런치는 아직 운영까지 못 닿았다`,
        `롤아웃 기세와 자금 복귀가 같은 편이어야 출시 박수도 오래 버틴다`,
        `배포 속도만 남고 복귀 자금이 늦으면 메인넷 서사는 금방 헐거워진다`,
      ];
      return sanitizeTweetText(rolloutCapitalPool[seed % rolloutCapitalPool.length]).slice(0, 140);
    }
  }
  if (lane === "regulation" && focus === "court") {
    if (sceneFamilyMatches(sceneFamily, /verdict\+execution$/)) {
      const verdictExecutionPool = [
        `판결문은 끝났는데 집행은 아직 반 박자 늦는 장면이다`,
        `평결은 선명한데 실제 집행은 아직 현장까지 못 내려온 구간이다`,
        `판결은 또렷해도 집행이 늦으면 그 뉴스는 아직 돈 바깥에 머문다`,
        `판결 뉴스는 컸지만 집행이 못 따라오면 결국 기사보다 브리핑처럼 남는다`,
      ];
      return sanitizeTweetText(verdictExecutionPool[seed % verdictExecutionPool.length]).slice(0, 140);
    }
    if (sceneFamilyMatches(sceneFamily, /briefing\+execution$/)) {
      const briefingExecutionPool = [
        `법원 브리핑은 요란한데 집행은 아직 장부까지 못 내려온 장면이다`,
        `기사 해설은 큰데 실제 집행은 아직 빈칸이 더 크게 보이는 구간이다`,
        `브리핑이 앞서고 집행이 늦는 장면에선 해설보다 빈칸이 먼저 남는다`,
        `뉴스 해설은 길지만 집행이 비는 순간 그 장면은 현장보다 방송에 가깝다`,
      ];
      return sanitizeTweetText(briefingExecutionPool[seed % briefingExecutionPool.length]).slice(0, 140);
    }
    if (sceneFamilyMatches(sceneFamily, /capital\+execution$/)) {
      const capitalExecutionPool =
        tilt === "execution-lag"
          ? [
              `집행 흔적이 늦게 붙는 날엔 판결 해설보다 빈칸이 먼저 커진다`,
              `돈보다 집행이 비는 순간 그 규제 뉴스는 아직 현장에 닿지 못했다`,
              `판결 문장보다 집행 속도가 늦는 구간에선 해설이 먼저 얇아진다`,
            ]
          : [
              `집행은 늦고 자금도 안 움직이면 그 규제 뉴스는 결국 해설 방송으로 남는다`,
              `집행 흔적과 자금 방향이 같이 비는 순간 판결 해설은 바로 기사값으로 눌린다`,
              `돈도 안 눕고 집행도 늦는 날엔 그 규제 뉴스가 현장에 닿지 못했다는 뜻이다`,
              `집행보다 해설이 앞서고 자금까지 비면 그 뉴스는 다시 법률 브리핑 자리로 밀린다`,
              `자금과 집행이 같이 안 붙는 규제 뉴스는 길어도 결국 기사 밖으로 못 나온다`,
              `집행 흔적과 자금 반응이 둘 다 늦으면 판결 해설은 업계 기사보다 더 가벼워진다`,
            ];
      return sanitizeTweetText(capitalExecutionPool[seed % capitalExecutionPool.length]).slice(0, 140);
    }
    if (sceneFamilyMatches(sceneFamily, /capital\+court$/)) {
      const courtCapitalPool = [
        `판결 기사만 크고 돈이 안 움직이면 그 뉴스는 법률 해설 방송에 가깝다`,
        `판결 기사와 자금 방향이 갈라지면 해설보다 돈 쪽이 훨씬 솔직해진다`,
        `법원 일정은 커도 자금 방향이 비면 그 뉴스는 업계 기사 무게를 못 넘긴다`,
        `판결 해설보다 자금 방향이 늦게 움직이는 날이 결국 이 뉴스의 본색을 드러낸다`,
        `소송 뉴스는 길어도 자금 방향이 안 붙는 순간 다시 기사 자리로 밀린다`,
        `돈이 안 눕는 판결 뉴스는 결국 법원 브리핑으로만 남는다`,
      ];
      return sanitizeTweetText(courtCapitalPool[seed % courtCapitalPool.length]).slice(0, 140);
    }
    if (sceneFamilyMatches(sceneFamily, /court\+execution$/)) {
      const courtExecutionPool = [
        `법원 일정과 집행 흔적이 같이 남아야 규제 뉴스도 현장으로 내려온다`,
        `법원 일정과 집행 흔적이 갈라지면 판결 해설은 반쪽으로 남는다`,
        `법원 일정과 집행 흔적이 따로 놀면 그 규제 뉴스는 기사보다 행동이 비어 있다`,
        `판결 기사와 집행 흔적이 같은 편에 서야 그 뉴스가 기사 톤을 벗어난다`,
        `법원 일정만 크고 집행 흔적이 늦으면 그 규제 뉴스는 결국 기사 쪽이다`,
        `소송 일정과 집행 흔적이 엇갈리는 순간 해설보다 빈칸이 먼저 커진다`,
      ];
      return sanitizeTweetText(courtExecutionPool[seed % courtExecutionPool.length]).slice(0, 140);
    }
  }
  if (lane === "ecosystem" && focus === "retention") {
    if (sceneFamilyMatches(sceneFamily, /cohort\+wallet$/)) {
      const retentionWalletPool =
        tilt === "retention-holds"
          ? [
              `다시 들어오는 지갑은 남는데 사람이 얼마나 눕는지가 아직 더 중요하다`,
              `복귀 숫자는 살아도 결국 남는 사람 수가 이 생태계 얘기의 체급을 다시 쓴다`,
              `지갑 복귀가 좋아 보여도 잔류가 얇으면 그 반응은 다음 날 바로 가벼워진다`,
            ]
          : [
              `지갑은 돌아오는데 사람이 안 남는 날엔 생태계 서사가 먼저 들통난다`,
              `지갑 복귀와 사람 복귀가 갈라지면 큰 반응은 커뮤니티 이벤트로 끝난다`,
              `지갑은 남는데 사람 흐름이 비는 순간 그 생태계 얘기는 포스터처럼 납작해진다`,
              `지갑 재방문과 사용자 복귀가 엇갈리면 반응보다 이탈의 속도가 더 정확하다`,
              `지갑은 다시 오는데 사람은 안 남는 날엔 생태계 기세가 바로 광고처럼 보인다`,
              `지갑 복귀만 남고 사람 흐름이 비면 그 서사는 사용자보다 숫자를 붙잡고 있는 셈이다`,
            ];
      return sanitizeTweetText(retentionWalletPool[seed % retentionWalletPool.length]).slice(0, 140);
    }
    if (sceneFamilyMatches(sceneFamily, /community\+retention$/)) {
      const retentionCommunityPool = [
        `재방문 흐름과 커뮤니티 열기가 같이 남아야 생태계 기세도 오래 버틴다`,
        `재방문 흐름과 커뮤니티 열기가 갈라지면 반응보다 잔류가 먼저 중요해진다`,
        `재방문 흐름과 커뮤니티 열기가 따로 놀면 큰 생태계 서사도 금방 포스터처럼 얇아진다`,
      ];
      return sanitizeTweetText(retentionCommunityPool[seed % retentionCommunityPool.length]).slice(0, 140);
    }
    if (sceneFamilyMatches(sceneFamily, /retention\+usage$/) || sceneFamilyMatches(sceneFamily, /retention\+usage/)) {
      const retentionUsagePool = [
        `재방문 흐름과 체인 안쪽 사용이 같이 남아야 잔류도 진짜가 된다`,
        `재방문 흐름과 체인 안쪽 사용이 갈라지면 열기보다 생활 흔적이 더 중요해진다`,
        `재방문 흐름과 체인 안쪽 사용이 따로 놀면 그 생태계 기세는 오래 못 간다`,
      ];
      return sanitizeTweetText(retentionUsagePool[seed % retentionUsagePool.length]).slice(0, 140);
    }
    if (
      sceneFamilyMatches(sceneFamily, /retention\+wallet$/) ||
      sceneFamilyMatches(sceneFamily, /wallet\+retention$/) ||
      sceneFamilyMatches(sceneFamily, /retention\+cohort$/) ||
      sceneFamilyMatches(sceneFamily, /cohort\+retention$/)
    ) {
      const retentionWalletDepthPool = [
        `지갑 재방문과 잔류 흐름이 같이 남아야 생태계 반응도 다음 날까지 버틴다`,
        `지갑 재방문과 잔류 흐름이 갈라지면 커뮤니티 열기보다 이탈이 먼저 보인다`,
        `지갑 재방문과 잔류 흐름이 따로 놀면 그 생태계 기세는 포스터처럼 납작해진다`,
        `지갑은 돌아오는데 잔류 흐름이 비면 그 반응은 생태계까지 못 이어진다`,
        `잔류와 지갑 복귀가 다른 편이면 생태계 열기보다 이탈의 속도가 더 정확하다`,
        `지갑 복귀와 잔류 흐름이 엇갈리는 순간 큰 반응도 다음 날이면 힘을 잃는다`,
      ];
      return sanitizeTweetText(retentionWalletDepthPool[seed % retentionWalletDepthPool.length]).slice(0, 140);
    }
  }
  if (lane === "market-structure" && focus === "liquidity") {
    if (sceneFamilyMatches(sceneFamily, /capital\+depth$/)) {
      const capitalDepthPool = [
        `자금 쏠림과 호가 두께가 같이 남아야 과열도 구조 변화로 읽힌다`,
        `자금 쏠림과 호가 두께가 갈라지면 화면 열기가 먼저 값이 빠진다`,
        `자금 쏠림과 호가 두께가 따로 놀면 그 자신감은 아직 호가 안에 갇혀 있다`,
      ];
      return sanitizeTweetText(capitalDepthPool[seed % capitalDepthPool.length]).slice(0, 140);
    }
    if (sceneFamilyMatches(sceneFamily, /depth\+execution$/)) {
      const depthExecutionPool = [
        `호가 두께와 큰 주문 소화가 같이 남아야 구조 변화라고 부를 수 있다`,
        `호가 두께와 큰 주문 소화가 갈라지면 체결보다 분위기가 먼저 과열된다`,
        `호가 두께와 큰 주문 소화가 따로 놀면 그 과열은 화면 장면으로 끝난다`,
      ];
      return sanitizeTweetText(depthExecutionPool[seed % depthExecutionPool.length]).slice(0, 140);
    }
  }
  if (lane === "ecosystem" && focus === "builder") {
    if (sceneFamilyMatches(sceneFamily, /builder\+capital$/)) {
      const builderCapitalPool =
        tilt === "builder-holds"
          ? [
              `개발자는 남는데 돈이 아직 끝까지 확신을 못 보태는 장면이다`,
              `코드의 체급은 살아 있는데 자금은 아직 마지막 합의를 미루는 구간이다`,
              `개발자 잔류는 견디는데 돈이 눕는 자리는 아직 더 늦게 열린다`,
            ]
          : [
              `코드는 남는데 돈이 안 돌아오면 그 생태계 서사는 개발자 일기장에 가깝다`,
              `개발자 잔류와 예치 자금 복귀가 갈라지면 그 생태계 기세는 금방 투자자용 포스터가 된다`,
              `코드만 버티고 자금이 비면 그 생태계 얘기는 빌더 안쪽에서만 도는 셈이다`,
              `개발자 잔류는 살아도 예치 자금 복귀가 비면 그 기세는 반쪽짜리 확신으로 남는다`,
              `코드가 살아도 돈이 안 붙는 순간 그 생태계 서사는 내부자 낙관으로 좁아진다`,
              `개발자가 남는다고 끝이 아니다. 자금이 비면 그 생태계 기세는 곧 헐거워진다`,
            ];
      return sanitizeTweetText(builderCapitalPool[seed % builderCapitalPool.length]).slice(0, 140);
    }
    if (sceneFamilyMatches(sceneFamily, /builder\+usage$/)) {
      const builderUsagePool = [
        `개발자 잔류와 체인 안쪽 사용이 같이 남아야 빌더 기세도 실사용으로 이어진다`,
        `개발자 잔류와 체인 안쪽 사용이 갈라지면 생태계 서사는 포스터처럼 얇아진다`,
        `개발자 잔류와 체인 안쪽 사용이 따로 놀면 그 기세는 아직 사람을 못 붙잡는다`,
      ];
      return sanitizeTweetText(builderUsagePool[seed % builderUsagePool.length]).slice(0, 140);
    }
    if (sceneFamilyMatches(sceneFamily, /builder\+return$/)) {
      const builderReturnPool = [
        `개발 흔적은 남는데 복귀 자금이 늦으면 그 생태계는 안쪽 확신부터 비싸진다`,
        `코드와 돈의 복귀가 다른 속도로 붙는 날엔 빌드 서사가 먼저 얇아진다`,
        `빌더는 버티는데 자금 복귀가 비면 그 기세는 구조보다 회의실 안쪽에 더 가깝다`,
        `개발자와 돈이 동시에 못 남는 생태계는 결국 발표보다 내부 낙관으로 눕는다`,
      ];
      return sanitizeTweetText(builderReturnPool[seed % builderReturnPool.length]).slice(0, 140);
    }
  }
  return sanitizeTweetText(pool[seed % pool.length]).slice(0, 140);
}

function buildStructuralSummaryFromEvidence(
  lane: TrendLane,
  primary: OnchainEvidence,
  secondary: OnchainEvidence,
  variant: number = 0
): string {
  const a = humanizeStructuralEvidenceLabel(primary.label);
  const b = humanizeStructuralEvidenceLabel(secondary.label);
  const pair = joinKoPair(a, b);
  const focus = resolvePlannerFocus(lane, [primary, secondary]);
  const sceneFamily = resolvePlannerSceneFamily(lane, focus, [primary, secondary]);
  const tilt = sceneFamilyTilt(sceneFamily);
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
    ecosystem: [`핵심은 ${pair}, 이 조합이 실제 사용과 잔류로 이어지는지다.`],
    regulation: [`핵심은 ${pair}, 이 조합이 기사 문장을 넘어 행동으로 이어지는지다.`],
    macro: [`지금은 ${pair}, 이 조합이 체인 안쪽 자금 습관까지 바꾸는지부터 본다.`],
    onchain: [`핵심은 ${pair}, 이 조합이 같이 남아서 하루를 넘기는지다.`],
    "market-structure": [`핵심은 ${pair}, 이 조합이 분위기가 아니라 실제 체결로 남는지다.`],
  };
  if (lane === "protocol" && focus === "durability" && sceneFamilyMatches(sceneFamily, /recovery\+validator$/)) {
    const recoveryPool = [
      `핵심은 ${pair}가 같이 남아서 발표가 아니라 복구 태도로 남는지다.`,
      `지금은 ${pair}, 이 조합이 박수보다 복구 기록으로 남는지부터 본다.`,
      `핵심은 ${pair}가 같이 남아야 이 개선이 슬라이드가 아니라 운영으로 남는다.`,
    ];
    return sanitizeTweetText(recoveryPool[stableSeed(`${pair}|${sceneFamily}|summary|v${variant}`) % recoveryPool.length]).slice(0, 180);
  }
  if (lane === "protocol" && focus === "durability" && sceneFamilyMatches(sceneFamily, /rollout\+validator$/)) {
    const rolloutValidatorPool = [
      `핵심은 ${pair}가 같이 남아서 검증자 숫자가 아니라 배포 태도로 남는지다.`,
      `지금은 ${pair}, 이 조합이 박수보다 운영 로그로 남는지부터 본다.`,
      `핵심은 ${pair}가 엇갈리면 이 업그레이드가 운영보다 발표 쪽으로 기운다는 뜻이다.`,
    ];
    return sanitizeTweetText(rolloutValidatorPool[stableSeed(`${pair}|${sceneFamily}|summary|v${variant}`) % rolloutValidatorPool.length]).slice(0, 180);
  }
  if (lane === "protocol" && focus === "launch" && sceneFamilyMatches(sceneFamily, /launch\+rollout$/)) {
    const launchPool = [
      `핵심은 ${pair}가 같이 남아서 메인넷 박수가 아니라 배포 속도로 남는지다.`,
      `지금은 ${pair}, 이 조합이 런치 기세보다 실제 배포 태도로 남는지부터 본다.`,
    ];
    return sanitizeTweetText(launchPool[stableSeed(`${pair}|${sceneFamily}|summary|v${variant}`) % launchPool.length]).slice(0, 180);
  }
  if (lane === "protocol" && focus === "launch") {
    if (sceneFamilyMatches(sceneFamily, /return\+announcement$/)) {
      const returnAnnouncementPool = [
        `핵심은 ${pair}가 같이 남더라도 발표와 복귀 자금이 같은 편에 서는지다.`,
        `지금은 ${pair}, 이 조합이 뉴스보다 돌아오는 돈의 태도로 남는지부터 본다.`,
        `핵심은 ${pair}가 엇갈리면 이 메인넷 장면은 발표값이 실제 복귀를 못 설득한 셈이다.`,
      ];
      return sanitizeTweetText(returnAnnouncementPool[stableSeed(`${pair}|${sceneFamily}|summary|v${variant}`) % returnAnnouncementPool.length]).slice(0, 180);
    }
    if (sceneFamilyMatches(sceneFamily, /return\+ops$/)) {
      const returnOpsPool = [
        `핵심은 ${pair}가 같이 남아서 메인넷 설명이 아니라 운영과 복귀 태도로 남는지다.`,
        `지금은 ${pair}, 이 조합이 발표보다 느린 운영 반응과 돌아오는 돈으로 남는지부터 본다.`,
        `핵심은 ${pair}가 엇갈리면 이 출시는 무대보다 운영 빈칸으로 더 오래 기억된다.`,
      ];
      return sanitizeTweetText(returnOpsPool[stableSeed(`${pair}|${sceneFamily}|summary|v${variant}`) % returnOpsPool.length]).slice(0, 180);
    }
    if (sceneFamilyMatches(sceneFamily, /return\+showcase$/) || sceneFamilyMatches(sceneFamily, /showcase\+return$/)) {
      const returnShowcasePool = [
        `핵심은 ${pair}가 같이 남더라도 무대와 돈의 태도가 같은 편에 서는지다.`,
        `지금은 ${pair}, 이 조합이 쇼케이스보다 복귀 자금으로 남는지부터 본다.`,
        `핵심은 ${pair}가 엇갈리면 이 메인넷 장면은 발표보다 객석의 망설임으로 남는다.`,
      ];
      return sanitizeTweetText(returnShowcasePool[stableSeed(`${pair}|${sceneFamily}|summary|v${variant}`) % returnShowcasePool.length]).slice(0, 180);
    }
    if (sceneFamilyMatches(sceneFamily, /return\+launch$/) || sceneFamilyMatches(sceneFamily, /launch\+return$/)) {
      const returnLaunchPool = [
        `핵심은 ${pair}가 같이 남아서 메인넷 설명이 아니라 복귀 자금으로 남는지다.`,
        `지금은 ${pair}, 이 조합이 박수보다 돌아오는 돈의 태도로 남는지부터 본다.`,
        `핵심은 ${pair}가 엇갈리면 이 런치가 무대보다 장부 바깥에 더 오래 머문다는 점이다.`,
      ];
      return sanitizeTweetText(returnLaunchPool[stableSeed(`${pair}|${sceneFamily}|summary|v${variant}`) % returnLaunchPool.length]).slice(0, 180);
    }
    if (sceneFamilyMatches(sceneFamily, /launch\+ops$/) || sceneFamilyMatches(sceneFamily, /ops\+launch$/)) {
      const launchOpsPool = [
        `핵심은 ${pair}가 같이 남아서 메인넷 설명이 아니라 운영 반응으로 남는지다.`,
        `지금은 ${pair}, 이 조합이 런치 박수보다 운영 로그로 남는지부터 본다.`,
        `핵심은 ${pair}가 엇갈리면 이 출시는 발표보다 운영 빈칸 쪽이 더 커진다는 점이다.`,
      ];
      return sanitizeTweetText(launchOpsPool[stableSeed(`${pair}|${sceneFamily}|summary|v${variant}`) % launchOpsPool.length]).slice(0, 180);
    }
    if (sceneFamilyMatches(sceneFamily, /launch\+showcase$/) || sceneFamilyMatches(sceneFamily, /showcase\+launch$/)) {
      const showcasePool = [
        `핵심은 ${pair}가 같이 남아도 결국 쇼케이스와 실제 복귀를 가르는 건 돈의 태도다.`,
        `지금은 ${pair}, 이 조합이 무대보다 장부 쪽으로 남는지부터 본다.`,
        `핵심은 ${pair}가 엇갈리면 이 메인넷 뉴스는 현장보다 쇼케이스에 더 가까워진다.`,
      ];
      return sanitizeTweetText(showcasePool[stableSeed(`${pair}|${sceneFamily}|summary|v${variant}`) % showcasePool.length]).slice(0, 180);
    }
    if (sceneFamilyMatches(sceneFamily, /capital\+launch$/) || sceneFamilyMatches(sceneFamily, /launch\+capital$/)) {
      const launchCapitalPool =
        tilt === "launch-holds"
          ? [
              `핵심은 ${pair}가 같이 남더라도 결국 마지막 판단은 복귀 자금이 한다.`,
              `지금은 ${pair}, 이 조합이 설명보다 돈의 태도로 남는지부터 본다.`,
              `핵심은 ${pair}가 남아도 돈이 늦으면 이 런치는 아직 사람들 장부에 못 내려왔다.`,
            ]
          : [
              `핵심은 ${pair}가 같이 남아서 메인넷 발표가 아니라 실제 복귀로 남는지다.`,
              `지금은 ${pair}, 이 조합이 준비도보다 복귀 자금으로 남는지부터 본다.`,
              `핵심은 ${pair}가 같이 붙지 않으면 이 런치는 쇼케이스에 머문다.`,
            ];
      return sanitizeTweetText(launchCapitalPool[stableSeed(`${pair}|${sceneFamily}|summary|v${variant}`) % launchCapitalPool.length]).slice(0, 180);
    }
    if (sceneFamilyMatches(sceneFamily, /capital\+rollout$/) || sceneFamilyMatches(sceneFamily, /rollout\+capital$/)) {
      const rolloutCapitalPool = [
        `핵심은 ${pair}가 같이 남아서 배포 기세가 아니라 운영 복귀로 남는지다.`,
        `지금은 ${pair}, 이 조합이 롤아웃 속도보다 복귀 자금으로 남는지부터 본다.`,
      ];
      return sanitizeTweetText(rolloutCapitalPool[stableSeed(`${pair}|${sceneFamily}|summary|v${variant}`) % rolloutCapitalPool.length]).slice(0, 180);
    }
  }
  if (lane === "ecosystem" && focus === "retention") {
    if (sceneFamilyMatches(sceneFamily, /cohort\+wallet$/)) {
      const retentionWalletPool =
        tilt === "retention-holds"
          ? [
              `핵심은 ${pair}가 같이 남더라도 결국 사람의 잔류가 이 반응의 체급을 다시 쓴다.`,
              `지금은 ${pair}, 이 조합이 숫자보다 다음 날 습관으로 남는지부터 본다.`,
              `핵심은 ${pair}가 살아도 사람이 얇아지면 이 생태계 서사는 절반짜리다.`,
            ]
          : [
              `핵심은 ${pair}가 같이 남아서 말이 아니라 실제 잔류로 남는지다.`,
              `지금은 ${pair}, 이 조합이 반응보다 다음 날 복귀로 남는지부터 본다.`,
              `핵심은 ${pair}가 엇갈리면 생태계 서사가 사람보다 숫자를 붙잡고 있는 셈이다.`,
            ];
      return sanitizeTweetText(retentionWalletPool[stableSeed(`${pair}|${sceneFamily}|summary|v${variant}`) % retentionWalletPool.length]).slice(0, 180);
    }
    if (sceneFamilyMatches(sceneFamily, /community\+retention$/)) {
      const retentionCommunityPool = [
        `핵심은 ${pair}가 같이 남아서 반응이 아니라 잔류 분위기로 남는지다.`,
        `지금은 ${pair}, 이 조합이 커뮤니티 열기보다 재방문으로 남는지부터 본다.`,
      ];
      return sanitizeTweetText(retentionCommunityPool[stableSeed(`${pair}|${sceneFamily}|summary|v${variant}`) % retentionCommunityPool.length]).slice(0, 180);
    }
    if (sceneFamilyMatches(sceneFamily, /retention\+usage$/) || sceneFamilyMatches(sceneFamily, /retention\+usage/)) {
      const retentionUsagePool = [
        `핵심은 ${pair}가 같이 남아서 잔류가 아니라 생활 흔적으로 남는지다.`,
        `지금은 ${pair}, 이 조합이 반응보다 체인 안쪽 사용으로 남는지부터 본다.`,
      ];
      return sanitizeTweetText(retentionUsagePool[stableSeed(`${pair}|${sceneFamily}|summary|v${variant}`) % retentionUsagePool.length]).slice(0, 180);
    }
    if (
      sceneFamilyMatches(sceneFamily, /retention\+wallet$/) ||
      sceneFamilyMatches(sceneFamily, /wallet\+retention$/) ||
      sceneFamilyMatches(sceneFamily, /retention\+cohort$/) ||
      sceneFamilyMatches(sceneFamily, /cohort\+retention$/)
    ) {
      const retentionWalletDepthPool = [
        `핵심은 ${pair}가 같이 남아서 열기가 아니라 복귀 습관으로 남는지다.`,
        `지금은 ${pair}, 이 조합이 커뮤니티 반응보다 지갑 복귀로 남는지부터 본다.`,
      ];
      return sanitizeTweetText(retentionWalletDepthPool[stableSeed(`${pair}|${sceneFamily}|summary|v${variant}`) % retentionWalletDepthPool.length]).slice(0, 180);
    }
  }
  if (lane === "regulation" && focus === "court" && sceneFamilyMatches(sceneFamily, /verdict\+execution$/)) {
    const verdictExecutionPool = [
      `핵심은 ${pair}가 같이 남아서 판결문이 아니라 집행 속도로 남는지다.`,
      `지금은 ${pair}, 이 조합이 평결보다 늦은 집행으로 남는지부터 본다.`,
      `핵심은 ${pair}가 엇갈리면 이 판결 뉴스는 기사보다 브리핑 쪽으로 기운다.`,
    ];
    return sanitizeTweetText(verdictExecutionPool[stableSeed(`${pair}|${sceneFamily}|summary|v${variant}`) % verdictExecutionPool.length]).slice(0, 180);
  }
  if (lane === "regulation" && focus === "court" && sceneFamilyMatches(sceneFamily, /briefing\+execution$/)) {
    const briefingExecutionPool = [
      `핵심은 ${pair}가 같이 남아서 브리핑이 아니라 집행 흔적으로 남는지다.`,
      `지금은 ${pair}, 이 조합이 해설보다 늦은 행동으로 남는지부터 본다.`,
      `핵심은 ${pair}가 엇갈리면 이 법원 뉴스는 현장보다 방송 톤으로 남는다.`,
    ];
    return sanitizeTweetText(briefingExecutionPool[stableSeed(`${pair}|${sceneFamily}|summary|v${variant}`) % briefingExecutionPool.length]).slice(0, 180);
  }
  if (lane === "regulation" && focus === "court" && sceneFamilyMatches(sceneFamily, /capital\+execution$/)) {
    const capitalExecutionPool =
      tilt === "execution-lag"
        ? [
            `핵심은 ${pair}가 같이 안 붙는 순간 판결 해설보다 집행 빈칸이 먼저 보인다는 점이다.`,
            `지금은 ${pair}, 이 조합이 기사보다 늦은 집행으로 남는지부터 본다.`,
            `핵심은 ${pair}가 비는 순간 이 규제 뉴스는 다시 법률 해설 자리로 밀린다.`,
          ]
        : [
            `핵심은 ${pair}가 같이 남아서 규제 뉴스가 해설이 아니라 현장 반응으로 남는지다.`,
            `지금은 ${pair}, 이 조합이 판결 해설보다 집행과 자금으로 남는지부터 본다.`,
            `핵심은 ${pair}가 같이 붙지 않으면 이 규제 뉴스는 다시 기사 자리로 밀린다.`,
          ];
    return sanitizeTweetText(capitalExecutionPool[stableSeed(`${pair}|${sceneFamily}|summary|v${variant}`) % capitalExecutionPool.length]).slice(0, 180);
  }
  if (lane === "regulation" && focus === "court" && sceneFamilyMatches(sceneFamily, /capital\+court$/)) {
    const courtPool = [
      `핵심은 ${pair}가 같이 남아서 법원 뉴스가 기사값을 벗어나는지다.`,
      `지금은 ${pair}, 이 조합이 판결 해설보다 자금 반응으로 남는지부터 본다.`,
      `핵심은 ${pair}가 같이 붙지 않으면 이 판결 뉴스는 해설 방송에 머문다.`,
    ];
    return sanitizeTweetText(courtPool[stableSeed(`${pair}|${sceneFamily}|summary|v${variant}`) % courtPool.length]).slice(0, 180);
  }
  if (lane === "market-structure" && focus === "liquidity" && sceneFamilyMatches(sceneFamily, /depth\+execution$/)) {
    const liquidityPool = [
      `핵심은 ${pair}가 같이 남아서 과열이 아니라 체결 구조로 남는지다.`,
      `지금은 ${pair}, 이 조합이 화면 열기를 넘어 실제 체결로 남는지부터 본다.`,
    ];
    return sanitizeTweetText(liquidityPool[stableSeed(`${pair}|${sceneFamily}|summary|v${variant}`) % liquidityPool.length]).slice(0, 180);
  }
  if (lane === "market-structure" && focus === "settlement" && sceneFamilyMatches(sceneFamily, /execution\+depth$/)) {
    const executionDepthPool = [
      `핵심은 ${pair}가 같이 남아서 숫자가 아니라 깊이 있는 체결로 남는지다.`,
      `지금은 ${pair}, 이 조합이 거래량보다 실제 깊이로 남는지부터 본다.`,
      `핵심은 ${pair}가 엇갈리면 이 반응은 체결보다 화면 쪽으로 기운다.`,
    ];
    return sanitizeTweetText(executionDepthPool[stableSeed(`${pair}|${sceneFamily}|summary|v${variant}`) % executionDepthPool.length]).slice(0, 180);
  }
  if (lane === "market-structure" && focus === "settlement" && sceneFamilyMatches(sceneFamily, /volume\+depth$/)) {
    const volumeDepthPool = [
      `핵심은 ${pair}가 같이 남아서 거래량 숫자가 아니라 체급으로 남는지다.`,
      `지금은 ${pair}, 이 조합이 볼륨보다 깊이로 남는지부터 본다.`,
      `핵심은 ${pair}가 엇갈리면 이 반응은 구조보다 연출 쪽으로 밀린다.`,
    ];
    return sanitizeTweetText(volumeDepthPool[stableSeed(`${pair}|${sceneFamily}|summary|v${variant}`) % volumeDepthPool.length]).slice(0, 180);
  }
  if (lane === "market-structure" && focus === "settlement" && sceneFamilyMatches(sceneFamily, /depth\+heat$/)) {
    const depthHeatPool = [
      `핵심은 ${pair}가 같이 남지 않으면 이 열기는 구조보다 화면으로 남는다는 점이다.`,
      `지금은 ${pair}, 이 조합이 과열보다 깊이로 남는지부터 본다.`,
      `핵심은 ${pair}가 엇갈리면 이 장면은 체급보다 분위기 쪽에 선다.`,
    ];
    return sanitizeTweetText(depthHeatPool[stableSeed(`${pair}|${sceneFamily}|summary|v${variant}`) % depthHeatPool.length]).slice(0, 180);
  }
  const pool = focusPoolByLane[lane]?.[focus] || poolByLane[lane];
  return sanitizeTweetText(pool[0]).slice(0, 180);
}

function buildDerivedExplicitHeadlineFromEvidence(
  lane: TrendLane,
  focus: PlannerFocus,
  sceneFamily: string,
  primary: OnchainEvidence,
  secondary: OnchainEvidence,
  variant: number = 0
): string {
  const pair = joinKoPair(
    humanizeStructuralEvidenceLabel(primary.label),
    humanizeStructuralEvidenceLabel(secondary.label)
  );
  const seed = stableSeed(`${lane}|${focus}|${sceneFamily}|${primary.label}|${secondary.label}|derived-headline|v${variant}`);

  if (lane === "ecosystem" && focus === "builder") {
    const pool =
      sceneFamilyMatches(sceneFamily, /builder\+treasury$/)
        ? [
            "예치 자금은 남는데 코드의 복귀가 늦는 생태계",
            "돈은 눕는데 빌더 복귀가 한 박자 늦는 장면",
            "예치 자금은 버티는데 개발 흔적이 늦게 따라오는 생태계",
            "돈은 돌아오는데 코드 온도는 아직 얕은 장면",
            "예치 자금은 두껍게 남는데 빌더 쪽 복귀는 아직 늦은 생태계",
            "돈은 눕는데 개발자 복귀가 아직 헐거운 장면",
          ]
        : sceneFamilyMatches(sceneFamily, /builder\+inside$/)
        ? [
            "코드는 남는데 돈은 아직 회의실 안쪽에 머문 생태계",
            "개발 흔적은 선명한데 돈은 아직 장부 바깥으로 안 나온 장면",
            "코드의 온도는 높은데 돈은 아직 내부자 낙관에서만 뜨거운 생태계",
            "빌더는 버티는데 돈은 아직 포스터 안쪽에 남은 장면",
            "개발 흔적은 남는데 돈은 아직 객석 뒤쪽에 머문 생태계",
            "코드는 살아 있는데 돈은 아직 안쪽 방에서만 도는 장면",
          ]
        : sceneFamilyMatches(sceneFamily, /builder\+capital$/) ||
          sceneFamilyMatches(sceneFamily, /builder\+return$/)
        ? [
            "개발자 잔류는 남는데 예치 자금 복귀가 늦는 구간",
            "코드는 버티는데 예치 자금은 늦게 돌아오는 장면",
            "개발 흔적보다 자금 복귀가 뒤처지는 생태계",
            "개발자와 돈의 복귀가 서로 다른 속도로 움직이는 구간",
            "빌더 기세는 버티는데 예치 자금은 아직 망설이는 장면",
            "코드의 온도와 자금 복귀가 엇갈리는 생태계",
            "코드는 남는데 돈은 아직 일기장 밖으로 안 나온 생태계",
            "개발자 잔류는 선명한데 자금 복귀는 아직 포스터 같은 장면",
            "빌더는 남는데 자금 복귀는 아직 객석에서 머뭇거리는 장면",
            "코드의 온도는 높은데 돈은 아직 회의실 바깥에 머문 구간",
          ]
        : [
            "개발자 잔류는 버티는데 체인 안쪽 사용이 뒤처지는 생태계",
            "빌더 기세는 남는데 실제 사용이 늦게 붙는 장면",
            "코드는 움직이는데 실사용이 아직 못 따라오는 구간",
            "개발 흔적은 진한데 실사용은 아직 묽은 생태계",
            "빌더의 속도와 사용자 흔적이 서로 다른 편에 선 장면",
            "코드가 앞서가는데 실제 사용은 아직 얇은 구간",
            "개발자는 남는데 생활 흔적이 다음 날까지 못 이어지는 생태계",
            "빌더 기세는 버티는데 사용 습관은 아직 납작한 장면",
          ];
    return sanitizeTweetText(pool[seed % pool.length]).slice(0, 140);
  }
  if (lane === "ecosystem" && focus === "retention") {
    const pool =
      sceneFamilyMatches(sceneFamily, /retention\+usage$/) ||
      sceneFamilyMatches(sceneFamily, /cohort\+usage$/) ||
      sceneFamilyMatches(sceneFamily, /usage\+wallet$/)
        ? [
            "사람은 돌아오는데 생활 흔적이 하루를 못 넘기는 생태계",
            "재방문은 붙는데 다음 날 체인 안쪽 습관이 바로 끊기는 장면",
            "사람 수는 남는데 생활 리듬이 하루를 못 버티는 생태계",
            "다시 들어오는 사람은 있는데 실사용이 다음 날 바로 식는 장면",
            "재방문은 살아도 생활 흔적이 다음 날까지 못 눕는 구간",
            "복귀한 지갑은 있는데 일상 사용은 아직 하루를 못 넘기는 생태계",
            "사람은 다시 오는데 체인 안쪽 리듬이 다음 날 바로 비는 장면",
            "재방문 숫자는 남는데 생활 흔적은 아직 하루를 못 버티는 구간",
          ]
        : sceneFamilyMatches(sceneFamily, /cohort\+wallet$/) ||
          sceneFamilyMatches(sceneFamily, /retention\+wallet$/) ||
          sceneFamilyMatches(sceneFamily, /wallet\+retention$/) ||
          sceneFamilyMatches(sceneFamily, /retention\+cohort$/) ||
          sceneFamilyMatches(sceneFamily, /cohort\+retention$/) ||
          sceneFamilyMatches(sceneFamily, /wallet\+usage$/)
        ? [
            "지갑은 돌아오는데 재방문은 얕은 구간",
            "복귀 흔적은 남는데 잔류가 얇은 생태계",
            "반응은 남는데 사람은 덜 남는 장면",
            "지갑은 움직이는데 다음 날 사람 수는 얇아진 구간",
            "복귀 신호는 남는데 잔류의 두께는 부족한 생태계",
            "다시 들어오는 흔적은 보이는데 사람은 오래 안 남는 장면",
            "재방문 흔적은 선명한데 남는 사람 수가 바로 얇아지는 구간",
            "지갑은 되돌아오는데 생태계 잔류는 금방 빠지는 장면",
            "복귀 숫자는 있는데 다음 날 사람 수가 못 눕는 생태계",
            "지갑 복귀는 보이는데 남는 사람은 아직 얇은 구간",
            "지갑 복귀는 버티는데 생활 흔적은 아직 다음 날까지 못 이어지는 구간",
            "사람은 다시 들어오는데 체인 사용은 아직 얇게 남는 생태계",
            "지갑은 돌아오는데 생활 습관은 아직 하루를 못 넘기는 장면",
            "복귀 흔적은 선명한데 일상 리듬은 아직 따라오지 못한 생태계",
          ]
        : [
            "재방문은 버티는데 체인 사용이 얕은 구간",
            "남는 사람은 있는데 생활 흔적이 아직 얇은 생태계",
            "잔류는 보이는데 실사용이 아직 못 따라오는 장면",
            "돌아오는 사람은 보이는데 생활 흔적은 아직 얕은 구간",
            "잔류는 남는데 체인 안쪽 습관은 아직 비는 생태계",
            "사람은 남는데 실제 사용은 아직 못 눕는 장면",
            "남는 사람은 보이는데 체인 안쪽 습관은 아직 덜 눕는 구간",
            "재방문은 버티는데 생활 흔적이 여전히 얇은 생태계",
            "사람은 남는데 체인 안쪽 사용이 다음 날까지 못 이어지는 장면",
            "복귀는 남는데 생활 흔적이 금방 납작해지는 생태계",
          ];
    return sanitizeTweetText(pool[seed % pool.length]).slice(0, 140);
  }
  if (lane === "regulation" && focus === "court") {
    const pool =
      sceneFamilyMatches(sceneFamily, /verdict\+execution$/)
        ? [
            "판결은 끝났는데 행동이 끝까지 안 눕는 규제 국면",
            "평결은 선명한데 실제 집행은 아직 기사 바깥으로 못 나온 장면",
            "판결 뉴스는 큰데 집행 속도는 아직 현장에 못 박힌 구간",
            "평결보다 행동이 늦게 도착해 판결값을 깎는 장면",
            "판결은 또렷한데 집행은 아직 현장 체급을 못 만든 구간",
            "법원 판단은 끝났는데 집행 빈칸이 뉴스보다 크게 남는 장면",
          ]
        : sceneFamilyMatches(sceneFamily, /briefing\+execution$/)
        ? [
            "브리핑은 큰데 집행은 늦는 구간",
            "법원 해설은 길지만 실제 집행은 아직 얕은 장면",
            "기사 해설이 앞서고 집행은 뒤처지는 구간",
            "브리핑은 뜨거운데 집행 빈칸이 더 크게 보이는 장면",
            "뉴스 해설은 큰데 행동은 아직 안 내려온 구간",
            "법원 브리핑은 선명한데 집행은 아직 한 템포 늦은 장면",
            "브리핑은 커졌는데 현장 집행은 아직 뒤에 남은 구간",
            "법원 뉴스는 앞서는데 행동은 아직 기사 밖으로 못 내려온 장면",
            "해설은 선명한데 집행은 여전히 빈칸으로 남는 구간",
            "브리핑은 긴데 행동은 아직 늦게 도착하는 장면",
            "브리핑은 큰데 자금과 집행은 아직 함께 못 내려온 구간",
            "법원 해설은 길지만 돈과 행동은 아직 빈칸으로 남는 장면",
          ]
        : sceneFamilyMatches(sceneFamily, /capital\+execution$/)
        ? [
            "대기 자금은 잡히는데 집행이 늦게 붙는 판결 구간",
            "돈의 방향은 보이는데 집행이 아직 얕은 법원 장면",
            "대기 자금과 집행 속도가 서로 어긋난 판결 구간",
            "매수 자리는 보이는데 집행이 늦게 도착하는 법원 장면",
            "대기 자금은 눕는데 집행 빈칸이 남는 판결 구간",
            "돈은 반응하는데 행동이 늦게 따라오는 법원 장면",
          ]
        : sceneFamilyMatches(sceneFamily, /court\+execution$/)
        ? [
            "법원 일정은 선명한데 집행이 아직 현장까지 못 내려온 구간",
            "판결문은 또렷한데 행동이 늦게 도착하는 법원 장면",
            "소송 일정은 길어도 집행이 얕게 남는 구간",
            "법원 문장은 선명한데 집행 속도는 아직 다른 편인 장면",
            "판결문은 나왔는데 행동이 늦게 붙는 법원 구간",
            "법원 일정과 집행 속도가 엇갈리는 장면",
          ]
        : sceneFamilyMatches(sceneFamily, /order\+capital$/)
        ? [
            "판결 뉴스는 큰데 ETF 대기 주문과 자금이 같이 늦는 구간",
            "법원 기사보다 매수 자리와 돈이 늦게 붙는 장면",
            "대기 주문은 커졌는데 실제 돈은 아직 안 눕는 판결 구간",
            "소송 해설은 긴데 주문과 자금이 같은 편에 못 선 장면",
            "법원 뉴스는 앞서는데 대기 주문과 자금은 아직 뒤처지는 구간",
            "판결 기사보다 주문과 자금의 엇갈림이 먼저 드러난 장면",
          ]
        : [
            "법원 뉴스는 큰데 자금 반응이 늦는 구간",
            "판결 기사보다 돈의 방향이 늦게 붙는 장면",
            "소송 해설은 큰데 자금이 아직 안 눕는 구간",
            "법원 일정은 긴데 돈이 머무는 자리는 늦게 보이는 구간",
            "판결 문장은 커졌는데 자금 반응은 한 박자 늦은 장면",
            "법원 해설은 길어도 돈이 눕는 자리는 아직 얕은 구간",
            "법원 기사보다 돈이 늦게 대답하는 장면",
            "판결 해설은 큰데 자금 쪽 대답이 빈 구간",
          ];
    return sanitizeTweetText(pool[seed % pool.length]).slice(0, 140);
  }
  if (lane === "protocol" && focus === "launch") {
    const pool =
      sceneFamilyMatches(sceneFamily, /return\+announcement$/)
        ? [
            "메인넷 발표는 큰데 돌아오는 돈은 아직 그 체급을 안 믿는 출시",
            "뉴스는 뜨거운데 복귀 자금은 아직 발표값을 접수하지 않는 장면",
            "설명은 앞서는데 돈은 아직 메인넷 박수에 서명하지 않는 구간",
            "기대는 큰데 돈은 아직 발표장 바깥에서 손을 안 드는 출시",
            "발표는 선명한데 돌아오는 돈은 아직 메인넷 설명을 보류하는 장면",
            "메인넷 뉴스는 컸지만 복귀 자금은 아직 발표장 밖에 서 있는 구간",
            "출시 설명은 앞서는데 돈은 아직 그 체급을 승인하지 않는 장면",
            "기대는 뜨거운데 복귀 자금은 아직 메인넷 박수를 거절하는 구간",
            "메인넷 발표는 큰데 운영과 돈은 아직 같은 편 문장에 안 서는 장면",
            "발표는 선명한데 복귀 자금과 운영 반응은 아직 출시를 보류하는 구간",
          ]
        : sceneFamilyMatches(sceneFamily, /return\+ops$/)
        ? [
            "메인넷 설명은 큰데 운영과 돈이 함께 출시를 보류하는 장면",
            "발표는 앞서는데 복귀 자금과 운영 로그는 아직 몸을 안 싣는 구간",
            "메인넷 뉴스는 뜨거운데 운영과 돈이 같이 승인 버튼을 안 누르는 장면",
            "출시 설명은 완성됐는데 운영과 복귀 자금은 아직 한 템포 뒤에서 버티는 구간",
            "메인넷 발표는 큰데 운영과 돈이 끝까지 같은 편 문장을 안 쓰는 장면",
            "런치 설명은 선명한데 복귀 자금과 운영 로그는 아직 출시를 인정하지 않는 구간",
          ]
        : sceneFamilyMatches(sceneFamily, /launch\+treasury$/) || sceneFamilyMatches(sceneFamily, /launch\+capital$/)
        ? [
            "메인넷 준비도는 높아도 복귀 자금이 아직 몸을 사리는 출시",
            "준비도 설명은 충분한데 돈은 아직 메인넷 장부 바깥에 남은 장면",
            "메인넷 기대는 뜨거운데 자금은 아직 객석 근처에서 머뭇거리는 출시",
            "준비도는 선명한데 복귀 자금은 아직 몸을 낮추는 메인넷 구간",
            "메인넷 설명은 앞서는데 돈은 아직 뒤에서 망설이는 장면",
            "출시 준비도는 충분한데 자금이 아직 주저앉지 않는 구간",
            "메인넷 기대는 앞서는데 돈은 아직 무대 아래에서 머뭇거리는 출시",
            "준비도 설명은 단단한데 복귀 자금은 아직 객석 쪽에서 머무는 장면",
          ]
        : sceneFamilyMatches(sceneFamily, /return\+showcase$/) || sceneFamilyMatches(sceneFamily, /showcase\+return$/) || sceneFamilyMatches(sceneFamily, /launch\+showcase$/)
        ? [
            "무대는 뜨거운데 복귀 자금은 아직 객석에 남은 출시",
            "쇼케이스는 선명한데 돌아오는 돈은 아직 한 박자 늦은 장면",
            "무대 연출은 큰데 돈은 아직 바깥에서 망설이는 메인넷 구간",
            "메인넷 쇼케이스는 완성됐는데 복귀 자금은 아직 객석에 머무는 장면",
            "무대 조명은 선명한데 돈은 아직 객석 끝에서 머무는 출시",
            "쇼케이스는 끝났는데 돌아오는 자금은 아직 발표장 밖을 맴도는 장면",
          ]
        : sceneFamilyMatches(sceneFamily, /return\+launch$/) || sceneFamilyMatches(sceneFamily, /launch\+return$/)
        ? [
            "메인넷 설명은 앞서는데 복귀 자금은 늦는 출시",
            "런치 박수보다 돈의 복귀가 늦게 눕는 장면",
            "메인넷 기대는 큰데 돌아오는 자금은 아직 얕은 구간",
            "출시 설명은 뜨거운데 복귀 자금은 아직 객석에 남은 장면",
            "메인넷 문장은 선명한데 돈은 아직 돌아오기를 미루는 구간",
            "런치 뉴스는 큰데 복귀 자금은 한 박자 늦는 장면",
          ]
        : sceneFamilyMatches(sceneFamily, /launch\+showcase$/) || sceneFamilyMatches(sceneFamily, /showcase\+launch$/)
        ? [
            "메인넷 무대는 뜨거운데 실제 복귀는 아직 객석에 남은 장면",
            "쇼케이스는 선명한데 돈은 아직 발표회 바깥에 머무는 구간",
            "런치 무대는 완성됐는데 복귀 자금은 아직 얕은 장면",
            "메인넷 쇼케이스는 큰데 사람들 돈은 아직 무대 밖에서 머뭇거리는 구간",
          ]
        : sceneFamilyMatches(sceneFamily, /launch\+ops$/) || sceneFamilyMatches(sceneFamily, /ops\+launch$/)
        ? [
            "메인넷 박수는 큰데 운영 로그는 늦는 출시",
            "런치 설명은 완성됐는데 운영 흔적은 아직 얕은 장면",
            "메인넷 뉴스는 뜨거운데 운영 태도는 뒤처지는 구간",
            "출시 무대는 끝났는데 운영 로그는 아직 비는 장면",
            "메인넷 기대는 큰데 운영 반응은 아직 못 눕는 출시",
            "출시 설명은 앞서는데 운영 로그는 아직 뒤에서 망설이는 장면",
            "메인넷 설명은 선명한데 운영 태도는 아직 객석에 남은 출시",
            "런치 무대는 뜨거운데 운영 로그는 아직 발표장 밖에서 더디게 붙는 장면",
          ]
        : sceneFamilyMatches(sceneFamily, /capital\+launch$/) || sceneFamilyMatches(sceneFamily, /launch\+capital$/)
        ? [
            "메인넷 준비도는 오르는데 복귀 자금이 늦는 출시",
            "런치 박수는 큰데 복귀 자금은 늦는 장면",
            "메인넷 설명보다 자금 복귀가 늦는 구간",
            "출시 준비는 탄탄한데 돈의 복귀는 아직 망설이는 장면",
            "런치 설명은 앞서는데 복귀 자금은 뒤처지는 구간",
            "메인넷 기대는 큰데 돈이 눕는 속도는 늦은 출시",
            "메인넷 무대는 준비됐는데 돈은 아직 객석에 남은 장면",
            "출시 설명은 완성됐는데 복귀 자금은 아직 쇼케이스 바깥에 있는 구간",
          ]
        : [
            "배포 기세는 큰데 복귀 자금은 늦는 출시",
            "메인넷 롤아웃은 빠른데 돈은 늦게 돌아오는 장면",
            "출시 속도보다 자금 복귀가 뒤처지는 구간",
            "배포 속도는 앞서는데 돈의 복귀는 한 박자 늦은 장면",
            "메인넷 롤아웃은 뜨거운데 복귀 자금은 아직 얕은 구간",
            "런치 기세는 큰데 돈이 다시 눕는 자리는 늦는 출시",
          ];
    return sanitizeTweetText(pool[seed % pool.length]).slice(0, 140);
  }
  if (lane === "protocol" && focus === "durability") {
    const pool =
      sceneFamilyMatches(sceneFamily, /ops\+validator$/) || sceneFamilyMatches(sceneFamily, /rollout\+validator$/)
        ? [
            "운영 로그는 비는데 검증자 숫자만 늦게 버티는 구간",
            "운영 기록은 얇은데 검증자 안정성만 남는 장면",
            "운영 태도는 늦는데 검증자 숫자만 버티는 구간",
            "로그는 비는데 검증자 회복만 선명한 장면",
            "운영 흔적은 늦는데 합의 숫자만 살아 있는 구간",
            "기록은 얇은데 검증자 쪽 숫자만 버티는 장면",
            "롤아웃은 끝났는데 검증자 숫자만 남고 운영 기록은 비는 구간",
            "배포 박수는 컸는데 합의 숫자만 버티고 운영 흔적은 늦는 장면",
          ]
        : sceneFamilyMatches(sceneFamily, /ops\+recovery$/) || sceneFamilyMatches(sceneFamily, /recovery\+ops$/)
        ? [
            "운영 로그와 복구 속도가 서로 다른 박자로 남는 구간",
            "복구는 시작됐는데 운영 기록은 아직 늦는 장면",
            "운영 태도와 복구 속도가 서로 다른 편에 선 구간",
            "로그는 비는데 복구 설명만 앞서가는 장면",
            "복구는 말하는데 운영 쪽 기록은 아직 얕은 구간",
            "복구 속도와 운영 흔적이 엇갈린 채 남는 장면",
            "장애는 정리되는데 운영 기록이 뒤에서 허둥대는 구간",
            "복구는 진행되는데 운영 흔적은 아직 한 템포 늦은 장면",
          ]
        : sceneFamilyMatches(sceneFamily, /repair\+validator$/)
        ? [
            "장애 기록은 진한데 검증자 회복이 늦게 붙는 장면",
            "복구 태도는 보이는데 검증자 회복이 한 박자 늦은 구간",
            "장애 뒤 기록은 쌓이는데 검증자 쪽 복귀가 늦는 장면",
            "복구는 시작됐는데 검증자 회복이 아직 얕은 구간",
            "장애 뒤 태도와 검증자 회복 속도가 엇갈리는 장면",
            "복구 흔적은 선명한데 검증자 숫자가 늦게 돌아오는 구간",
          ]
        : sceneFamilyMatches(sceneFamily, /repair\+ops$/)
        ? [
            "장애 복구는 말하는데 운영 로그가 늦게 붙는 구간",
            "복구 태도는 보이는데 운영 기록이 아직 비는 장면",
            "장애 뒤 기록은 진한데 운영 로그는 한 박자 늦은 구간",
            "복구는 시작됐는데 운영 쪽 증거가 아직 얕은 장면",
            "장애 뒤 태도와 운영 기록 속도가 엇갈리는 구간",
            "복구 흔적은 선명한데 운영 로그가 늦게 돌아오는 장면",
          ]
        : sceneFamilyMatches(sceneFamily, /recovery\+validator$/)
        ? [
            "업그레이드 박수는 큰데 복구 기록이 늦는 구간",
            "검증자 안정성은 버티는데 복구 태도는 늦는 장면",
            "발표는 앞서는데 장애 뒤 복구가 늦게 남는 구간",
            "검증자 안정성은 남는데 복구 로그가 뒤처지는 장면",
            "업그레이드 문장은 큰데 장애 뒤 태도는 늦는 구간",
            "발표보다 복구 기록이 한 박자 늦게 도착한 장면",
          ]
        : [
            "롤아웃 속도는 빠른데 운영 기록이 늦는 구간",
            "배포는 앞서는데 검증자와 운영 태도가 엇갈리는 장면",
            "릴리스 박수보다 운영 기록이 늦게 붙는 구간",
            "배포 기세는 뜨거운데 운영 로그가 늦게 남는 장면",
            "릴리스 설명은 앞서는데 운영 태도는 늦는 구간",
            "배포 속도와 운영 기록이 다른 박자로 움직이는 장면",
            "롤아웃 박수는 컸는데 운영 기록은 아직 한 템포 늦은 구간",
            "배포는 빠른데 복구 로그는 아직 운영 쪽에서 머뭇거리는 장면",
            "릴리스 설명은 선명한데 장애 뒤 기록은 아직 느린 구간",
            "배포 뉴스는 뜨거운데 운영 흔적은 늦게 도착하는 장면",
            "롤아웃은 빨랐는데 검증자와 복구 기록은 아직 다른 속도로 남는 장면",
            "배포 설명은 컸는데 검증자 안정성과 복구 태도는 아직 어긋난 구간",
            "릴리스 속도는 앞섰는데 운영 기록은 아직 복구보다 뒤에서 버벅이는 장면",
            "배포 무대는 끝났는데 운영 흔적은 아직 로그 바깥에서 늦게 들어오는 구간",
          ];
    return sanitizeTweetText(pool[seed % pool.length]).slice(0, 140);
  }
  if (lane === "market-structure" && focus === "liquidity") {
    const pool = [
      "호가는 두꺼운데 체결은 얇은 구간",
      "화면 열기는 큰데 실제 체결이 늦는 장면",
      "호가 두께보다 큰 주문 소화가 약한 구간",
    ];
    return sanitizeTweetText(pool[seed % pool.length]).slice(0, 140);
  }
  if (lane === "market-structure" && focus === "settlement") {
    if (sceneFamilyMatches(sceneFamily, /execution\+depth$/) || sceneFamilyMatches(sceneFamily, /fill\+depth$/)) {
      const executionDepthPool = [
        `체결은 살아도 깊이가 늦게 붙는 장면은 구조보다 긴장감만 크게 남긴다`,
        `현물 체결은 뜨거운데 호가 두께가 못 따라오면 그 반응은 아직 반쪽 흥분이다`,
        `체결 숫자는 보이는데 깊이가 비는 순간 그 장면은 체급 대신 연출로 남는다`,
        `현물 체결이 남아도 깊이가 비면 그 반응은 결국 화면 연출 쪽으로 눕는다`,
        `주문 소화는 버티는데 깊이가 늦게 눕는 장면은 숫자가 구조 흉내만 낸다`,
        `체결은 남는데 정산 깊이가 비면 그 반응은 결국 화면값으로 깎인다`,
        `큰 주문 소화는 보이는데 호가 두께가 비면 그 반응은 아직 숫자 놀이에 머문다`,
        `체결 흔적은 선명한데 깊이가 늦게 눕는 순간 그 장면은 구조 흉내를 못 벗어난다`,
        `현물 체결만 남고 깊이가 비는 장면은 결국 스크린 긴장만 크게 남긴다`,
        `주문 소화가 살아도 깊이가 안 버티면 그 반응은 체급보다 속도 자랑으로 남는다`,
      ];
      return sanitizeTweetText(executionDepthPool[seed % executionDepthPool.length]).slice(0, 140);
    }
    if (sceneFamilyMatches(sceneFamily, /volume\+depth$/) || sceneFamilyMatches(sceneFamily, /volume\+settlement$/)) {
      const volumeDepthPool = [
        `거래량은 큰데 깊이가 얕은 장면은 숫자가 구조를 못 이긴다`,
        `볼륨은 요란한데 호가 두께가 비면 그 열기는 체급까지 못 간다`,
        `거래량 숫자는 살아도 깊이가 안 눕는 장면은 결국 연출에 더 가깝다`,
        `볼륨이 커도 깊이가 늦는 순간 그 반응은 화면값으로 다시 깎인다`,
        `거래량은 선명한데 정산 깊이가 얇으면 그 장면은 숫자값으로 접힌다`,
        `볼륨이 앞서도 깊이가 못 눕는 날은 체급보다 속도만 남는다`,
        `거래량은 남는데 정산 깊이가 얕으면 그 반응은 숫자 체급에서 더 못 올라간다`,
        `볼륨은 분명한데 깊이가 비는 구간은 결국 차트보다 화면에 더 가깝다`,
        `숫자는 살아도 깊이가 늦으면 그 장면은 체결보다 연출이 먼저 기억에 남는다`,
        `거래량은 앞서는데 깊이가 비는 장면은 체급보다 조급함만 크게 남긴다`,
        `볼륨이 분주해도 정산 깊이가 못 버티면 그 반응은 구조보다 속도 자국으로 남는다`,
      ];
      return sanitizeTweetText(volumeDepthPool[seed % volumeDepthPool.length]).slice(0, 140);
    }
    if (sceneFamilyMatches(sceneFamily, /depth\+heat$/) || sceneFamilyMatches(sceneFamily, /settlement\+heat$/)) {
      const depthHeatPool = [
        `분위기는 뜨거운데 깊이가 비는 장면은 결국 화면만 남는다`,
        `과열은 커도 깊이가 안 붙으면 그 반응은 숫자보다 연출에 가깝다`,
        `화면 열기만 커지고 깊이가 얕으면 그 장면은 체급보다 기세로 남는다`,
        `체결 열기는 뜨거운데 깊이가 비면 그 장면은 결국 스크린 쪽으로 기운다`,
        `분위기만 앞서고 깊이가 못 눕는 순간 그 반응은 장면값으로 줄어든다`,
        `과열 분위기가 앞서도 깊이가 비는 장면은 결국 체결보다 화면이 더 오래 남는다`,
        `화면 열기만 커지고 정산 깊이가 얕으면 그 장면은 금세 장식값으로 줄어든다`,
      ];
      return sanitizeTweetText(depthHeatPool[seed % depthHeatPool.length]).slice(0, 140);
    }
    const pool = [
      "거래량은 뜨는데 깊이는 얕은 구간",
      "현물 체결은 보이는데 호가 두께가 비는 장면",
      "숫자는 큰데 깊이가 못 따라오는 구간",
      "현물 체결은 남는데 깊이는 아직 얕은 장면",
      "거래량만 커지고 실제 깊이는 못 눕는 구간",
      "체결 신호는 보이는데 호가 두께는 뒤처지는 장면",
      "깊이가 비는데 체결 숫자만 커지는 구간",
      "체결은 남는데 깊이가 대답을 미루는 장면",
      "화면 열기만 커지고 실제 돈은 아직 얕은 구간",
      "분위기는 뜨거운데 체급은 못 붙이는 장면",
      "거래량 숫자만 크고 깊이는 아직 대답을 미루는 구간",
      "정산은 얕은데 숫자만 먼저 커진 장면",
    ];
    return sanitizeTweetText(pool[seed % pool.length]).slice(0, 140);
  }
  if (lane === "onchain" && focus === "flow") {
    const pool = [
      "고래 흔적은 큰데 자금 방향은 늦는 구간",
      "주소 움직임은 화려한데 거래소 자금은 잠잠한 장면",
      "온체인 숫자는 큰데 자금 방향은 얕은 구간",
    ];
    return sanitizeTweetText(pool[seed % pool.length]).slice(0, 140);
  }
  if (lane === "onchain" && focus === "durability") {
    const pool = [
      "예쁘게 튄 숫자는 큰데 오래 남는 흔적은 얕은 구간",
      "온체인 반응은 화려한데 지속성은 약한 장면",
      "숫자는 튀는데 하루를 버티는 흔적은 얕은 구간",
    ];
    return sanitizeTweetText(pool[seed % pool.length]).slice(0, 140);
  }
  const fallbackPool = [
    `${pair}, 이 조합이 같이 남지 않으면 좋은 설명도 금방 얇아진다`,
    `${pair}, 결국 이 둘이 같은 편에 서야 장면도 구조로 남는다`,
    `${pair}, 이 둘이 갈라지는 순간 반응보다 빈칸이 더 크게 보인다`,
    `${pair}, 이 조합이 따로 놀면 그 서사는 오래 못 간다`,
  ];
  return sanitizeTweetText(fallbackPool[seed % fallbackPool.length]).slice(0, 140);
}

function buildDerivedExplicitSummaryFromEvidence(
  lane: TrendLane,
  focus: PlannerFocus,
  sceneFamily: string,
  primary: OnchainEvidence,
  secondary: OnchainEvidence,
  variant: number = 0
): string {
  const pair = joinKoPair(
    humanizeStructuralEvidenceLabel(primary.label),
    humanizeStructuralEvidenceLabel(secondary.label)
  );
  const seed = stableSeed(`${lane}|${focus}|${sceneFamily}|${primary.label}|${secondary.label}|derived-summary|v${variant}`);
  const pools: Record<string, string[]> = {
    builder: [
      `핵심은 ${pair}가 같이 붙어서 코드뿐 아니라 돈까지 돌아오는지다.`,
      `지금은 ${pair}의 시차가 생태계 기세보다 더 많은 걸 말한다.`,
      `핵심은 ${pair}가 같은 편에 서야 이 빌드 서사가 구조로 남는다는 점이다.`,
    ],
    retention: [
      `핵심은 ${pair}가 같이 남아서 반응이 아니라 잔류로 이어지는지다.`,
      `지금은 ${pair}의 온도 차가 생태계 서사의 본색을 더 잘 드러낸다.`,
      `핵심은 ${pair}가 같은 편에 서야 이 반응이 다음 날까지 버틴다는 점이다.`,
    ],
    court: [
      `핵심은 ${pair}가 같이 붙어서 판결 뉴스가 기사값을 벗어나는지다.`,
      `지금은 ${pair}의 시차가 법원 해설보다 더 솔직하다.`,
      `핵심은 ${pair}가 같은 편에 서야 이 뉴스가 해설이 아니라 행동으로 남는다는 점이다.`,
    ],
    launch: [
      `핵심은 ${pair}가 같이 붙어서 메인넷 박수가 실제 복귀로 이어지는지다.`,
      `지금은 ${pair}의 시차가 메인넷 설명보다 더 많은 걸 말한다.`,
      `핵심은 ${pair}가 같은 편에 서야 이 런치 서사가 운영으로 내려온다는 점이다.`,
    ],
    durability: [
      `핵심은 ${pair}가 같이 남아서 업그레이드 얘기가 발표를 넘어 운영으로 가는지다.`,
      `지금은 ${pair}의 시차가 좋은 발표보다 더 정확하다.`,
      `핵심은 ${pair}가 같은 편에 서야 이 개선이 릴리스 문장을 벗어난다는 점이다.`,
    ],
    liquidity: [
      `핵심은 ${pair}가 같이 남아서 화면 열기가 아니라 실제 돈으로 이어지는지다.`,
      `지금은 ${pair}의 시차가 차트보다 더 정확하다.`,
      `핵심은 ${pair}가 같은 편에 서야 이 과열이 구조로 남는다는 점이다.`,
    ],
    settlement: [
      `핵심은 ${pair}가 같이 남아서 거래량이 아니라 깊이로 이어지는지다.`,
      `지금은 ${pair}의 시차가 숫자보다 더 많은 걸 말한다.`,
      `핵심은 ${pair}가 같은 편에 서야 이 반응이 구조를 만든다는 점이다.`,
    ],
    flow: [
      `핵심은 ${pair}가 같이 남아서 주소 숫자가 아니라 자금 방향으로 이어지는지다.`,
      `지금은 ${pair}의 시차가 예쁜 숫자보다 더 정확하다.`,
      `핵심은 ${pair}가 같은 편에 서야 이 온체인 신호가 반쪽을 벗어난다는 점이다.`,
    ],
  };
  const pool = pools[focus] || pools.durability;
  return sanitizeTweetText(pool[seed % pool.length]).slice(0, 180);
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
  const best = selectEvidencePairCandidatesForLane(lane, evidence, options, 1)[0];
  if (!best) return null;
  return {
    evidence: best.evidence,
    hasOnchainEvidence: best.hasOnchainEvidence,
    hasCrossSourceEvidence: best.hasCrossSourceEvidence,
    evidenceSourceDiversity: best.evidenceSourceDiversity,
  };
}

function selectEvidencePairCandidatesForLane(
  lane: TrendLane,
  evidence: OnchainEvidence[],
  options: {
    requireOnchainEvidence: boolean;
    requireCrossSourceEvidence: boolean;
  },
  maxPairs: number = 3
): Array<{
  evidence: OnchainEvidence[];
  hasOnchainEvidence: boolean;
  hasCrossSourceEvidence: boolean;
  evidenceSourceDiversity: number;
  score: number;
  focus: PlannerFocus;
  sceneFamily: string;
}> {
  const ranked = selectEvidenceForLane(lane, evidence).slice(0, 10);
  if (ranked.length < 2) return [];

  const candidates: Array<{
    evidence: OnchainEvidence[];
    hasOnchainEvidence: boolean;
    hasCrossSourceEvidence: boolean;
    evidenceSourceDiversity: number;
    score: number;
    focus: PlannerFocus;
    sceneFamily: string;
  }> = [];

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
      const focus = resolvePlannerFocus(lane, pair);
      const sceneFamily = resolvePlannerSceneFamily(lane, focus, pair);
      const narrativeBucketBonus = estimateNarrativeBucketBonus(pair, lane);
      const sceneFamilyBonus = estimateSceneFamilyBonus(lane, focus, sceneFamily);
      const narrativeTension = estimateNarrativeTension(pair, lane, focus, sceneFamily);
      if (pairIsTooGenericForLane(pair, lane)) continue;
      if (lane === "market-structure" && !semanticSupport) continue;
      if (lane !== "onchain" && lane !== "market-structure" && !semanticSupport && genericPairPenalty >= 0.1) {
        continue;
      }
      if (lane !== "onchain" && lane !== "market-structure" && laneMatchCount === 0 && genericPairPenalty >= 0.2) {
        continue;
      }
      if (lane !== "macro" && focus === "general" && (genericPairPenalty >= 0.08 || specificityScore < 0.58)) {
        continue;
      }
      if (
        lane === "ecosystem" &&
        focus === "retention" &&
        pair.some((item) => /(커뮤니티 잔류|실사용 잔류|커뮤니티 반응|체인 안쪽 사용)/.test(item.label)) &&
        genericPairPenalty >= 0.08
      ) {
        continue;
      }
      const score =
        baseScore +
        laneMatchCount * 0.18 +
        specificityScore * 0.36 +
        narrativeBucketBonus +
        sceneFamilyBonus +
        narrativeTension +
        (hasOnchainEvidence ? 0.06 : 0) +
        (hasCrossSourceEvidence ? 0.04 : 0) -
        (semanticSupport ? 0 : 0.16) -
        estimatePriceEvidencePenalty(pair, lane) * 1.6 -
        weakEvidencePenalty -
        genericPairPenalty;
      candidates.push({
        evidence: pair,
        hasOnchainEvidence,
        hasCrossSourceEvidence,
        evidenceSourceDiversity: sourceDiversity,
        score,
        focus,
        sceneFamily,
      });
    }
  }

  if (!candidates.length) {
    if (options.requireOnchainEvidence || options.requireCrossSourceEvidence) {
      return [];
    }
    const fallback = ranked.slice(0, 2);
    if (fallback.length < 2 || pairIsTooGenericForLane(fallback, lane)) {
      return [];
    }
    const focus = resolvePlannerFocus(lane, fallback);
    return [
      {
        evidence: fallback,
        hasOnchainEvidence: fallback.some((item) => item.source === "onchain"),
        hasCrossSourceEvidence: new Set(fallback.map((item) => item.source)).size >= 2,
        evidenceSourceDiversity: new Set(fallback.map((item) => item.source)).size,
        score: 0.01,
        focus,
        sceneFamily: resolvePlannerSceneFamily(lane, focus, fallback),
      },
    ];
  }

  const familyCounts = new Map<string, number>();
  for (const candidate of candidates) {
    const familyKey = `${candidate.focus}|${candidate.sceneFamily}`;
    familyCounts.set(familyKey, (familyCounts.get(familyKey) || 0) + 1);
  }

  const seen = new Set<string>();
  return candidates
    .sort((a, b) => {
      const penaltyA = estimateSceneFamilyMonopolyPenalty(
        lane,
        a.focus,
        a.sceneFamily,
        familyCounts.get(`${a.focus}|${a.sceneFamily}`) || 1
      );
      const penaltyB = estimateSceneFamilyMonopolyPenalty(
        lane,
        b.focus,
        b.sceneFamily,
        familyCounts.get(`${b.focus}|${b.sceneFamily}`) || 1
      );
      return b.score - penaltyB - (a.score - penaltyA);
    })
    .filter((candidate) => {
      const pairKey = candidate.evidence
        .map((item) => `${normalizeHeadlineKey(item.label)}:${normalizeHeadlineKey(item.value)}`)
        .sort()
        .join("|");
      const dedupKey = `${candidate.focus}|${candidate.sceneFamily}|${pairKey}`;
      if (seen.has(dedupKey)) return false;
      seen.add(dedupKey);
      return true;
    })
    .slice(0, Math.max(1, Math.min(6, maxPairs)));
}

function estimateSceneFamilyBonus(lane: TrendLane, focus: PlannerFocus, sceneFamily: string): number {
  if (lane === "ecosystem" && focus === "retention") {
    if (sceneFamilyMatches(sceneFamily, /^ecosystem:retention:retention$/)) return -0.18;
    if (sceneFamilyMatches(sceneFamily, /cohort\+wallet$/)) return -0.24;
    if (sceneFamilyMatches(sceneFamily, /wallet\+usage$/)) return -0.18;
    if (sceneFamilyMatches(sceneFamily, /usage\+wallet$/) || sceneFamilyMatches(sceneFamily, /cohort\+usage$/)) return 0.32;
    if (sceneFamilyMatches(sceneFamily, /retention\+wallet$/) || sceneFamilyMatches(sceneFamily, /wallet\+retention$/)) return 0.24;
    if (sceneFamilyMatches(sceneFamily, /cohort\+retention$/) || sceneFamilyMatches(sceneFamily, /retention\+cohort$/)) return 0.18;
    if (sceneFamilyMatches(sceneFamily, /habit\+retention$/) || sceneFamilyMatches(sceneFamily, /return\+habit$/)) return 0.34;
    if (sceneFamilyMatches(sceneFamily, /retention\+usage$/) || sceneFamilyMatches(sceneFamily, /retention\+usage/)) return 0.08;
    if (sceneFamilyMatches(sceneFamily, /community\+retention$/)) return 0.3;
  }
  if (lane === "protocol" && focus === "launch") {
    if (sceneFamilyMatches(sceneFamily, /^protocol:launch:launch$/)) return -0.14;
    if (sceneFamilyMatches(sceneFamily, /capital\+launch$/) || sceneFamilyMatches(sceneFamily, /launch\+capital$/)) return -0.3;
    if (sceneFamilyMatches(sceneFamily, /return\+launch$/) || sceneFamilyMatches(sceneFamily, /launch\+return$/)) return 0.18;
    if (sceneFamilyMatches(sceneFamily, /return\+announcement$/)) return 0.24;
    if (sceneFamilyMatches(sceneFamily, /return\+ops$/)) return 0.18;
    if (sceneFamilyMatches(sceneFamily, /return\+showcase$/) || sceneFamilyMatches(sceneFamily, /showcase\+return$/)) return 0.38;
    if (sceneFamilyMatches(sceneFamily, /return\+audience$/) || sceneFamilyMatches(sceneFamily, /audience\+return$/)) return 0.34;
    if (sceneFamilyMatches(sceneFamily, /launch\+capital$/) || sceneFamilyMatches(sceneFamily, /capital\+launch$/)) return -0.18;
    if (sceneFamilyMatches(sceneFamily, /launch\+ops$/) || sceneFamilyMatches(sceneFamily, /ops\+launch$/)) return 0.22;
    if (sceneFamilyMatches(sceneFamily, /launch\+showcase$/) || sceneFamilyMatches(sceneFamily, /showcase\+launch$/)) return 0.32;
    if (sceneFamilyMatches(sceneFamily, /launch\+audience$/) || sceneFamilyMatches(sceneFamily, /audience\+launch$/)) return 0.3;
    if (sceneFamilyMatches(sceneFamily, /launch\+treasury$/)) return 0.06;
    if (sceneFamilyMatches(sceneFamily, /capital\+rollout$/) || sceneFamilyMatches(sceneFamily, /rollout\+capital$/)) return 0.3;
    if (sceneFamilyMatches(sceneFamily, /launch\+rollout$/)) return 0.28;
    if (sceneFamilyMatches(sceneFamily, /launch$/)) return 0.02;
  }
  if (lane === "regulation" && focus === "court") {
    if (sceneFamilyMatches(sceneFamily, /^regulation:court:court$/)) return -0.32;
    if (sceneFamilyMatches(sceneFamily, /verdict\+execution$/)) return 0.12;
    if (sceneFamilyMatches(sceneFamily, /briefing\+execution$/)) return 0.08;
    if (sceneFamilyMatches(sceneFamily, /briefing\+capital$/)) return -0.1;
    if (sceneFamilyMatches(sceneFamily, /court\+execution$/)) return 0.12;
    if (sceneFamilyMatches(sceneFamily, /capital\+court$/)) return 0.12;
    if (sceneFamilyMatches(sceneFamily, /capital\+execution$/)) return 0.24;
    if (sceneFamilyMatches(sceneFamily, /order\+capital$/)) return 0.34;
  }
  if (lane === "protocol" && focus === "durability") {
    if (sceneFamilyMatches(sceneFamily, /recovery\+rollout$/)) return 0.28;
    if (sceneFamilyMatches(sceneFamily, /recovery\+validator$/)) return -0.22;
    if (sceneFamilyMatches(sceneFamily, /rollout\+validator$/)) return 0.26;
    if (sceneFamilyMatches(sceneFamily, /ops\+recovery$/) || sceneFamilyMatches(sceneFamily, /recovery\+ops$/)) return 0.28;
    if (sceneFamilyMatches(sceneFamily, /ops\+validator$/)) return -0.04;
    if (sceneFamilyMatches(sceneFamily, /validator\+log$/) || sceneFamilyMatches(sceneFamily, /ops\+log$/)) return 0.32;
    if (sceneFamilyMatches(sceneFamily, /repair\+log$/)) return 0.34;
  }
  if (lane === "market-structure") {
    if (focus === "liquidity") {
      if (sceneFamilyMatches(sceneFamily, /capital\+depth$/)) return 0.08;
      if (sceneFamilyMatches(sceneFamily, /depth\+execution$/)) return 0.06;
    }
    if (focus === "settlement") {
      if (sceneFamilyMatches(sceneFamily, /execution\+depth$/)) return -0.04;
      if (sceneFamilyMatches(sceneFamily, /volume\+depth$/)) return -0.08;
      if (sceneFamilyMatches(sceneFamily, /fill\+depth$/) || sceneFamilyMatches(sceneFamily, /volume\+settlement$/)) return 0.18;
      if (sceneFamilyMatches(sceneFamily, /depth\+heat$/)) return 0.02;
      if (sceneFamilyMatches(sceneFamily, /depth\+settlement$/) || sceneFamilyMatches(sceneFamily, /execution\+settlement$/)) return 0.2;
      if (sceneFamilyMatches(sceneFamily, /fill\+book$/) || sceneFamilyMatches(sceneFamily, /volume\+book$/)) return 0.14;
    }
  }
  if (lane === "ecosystem" && focus === "builder") {
    if (sceneFamilyMatches(sceneFamily, /builder\+usage$/)) return 0.34;
    if (sceneFamilyMatches(sceneFamily, /builder\+return$/)) return 0.28;
    if (sceneFamilyMatches(sceneFamily, /builder\+inside$/)) return 0.12;
    if (sceneFamilyMatches(sceneFamily, /builder\+capital$/)) return -0.24;
  }
  return 0;
}

function estimateSceneFamilyMonopolyPenalty(
  lane: TrendLane,
  focus: PlannerFocus,
  sceneFamily: string,
  familyCount: number
): number {
  if (familyCount <= 1) return 0;
  let penalty = 0.05 * (familyCount - 1);
  if (
    (lane === "ecosystem" && focus === "retention" && sceneFamilyMatches(sceneFamily, /(cohort\+wallet|retention\+usage|wallet\+usage|return\+habit)$/)) ||
    (lane === "ecosystem" && focus === "builder" && sceneFamilyMatches(sceneFamily, /builder\+capital$/)) ||
    (lane === "protocol" && focus === "launch" && sceneFamilyMatches(sceneFamily, /(capital\+launch|launch\+capital|launch\+treasury|return\+launch|return\+announcement|return\+ops|return\+showcase|launch\+ops)$/)) ||
    (lane === "regulation" && focus === "court" && sceneFamilyMatches(sceneFamily, /^regulation:court:court$|briefing\+capital|briefing\+execution|verdict\+execution|court\+execution/)) ||
    (lane === "protocol" && focus === "durability" && sceneFamilyMatches(sceneFamily, /(recovery\+validator|ops\+validator|rollout\+validator|validator\+log)$/)) ||
    (lane === "market-structure" && focus === "settlement" && sceneFamilyMatches(sceneFamily, /(volume\+depth|execution\+depth|fill\+book)$/))
  ) {
    penalty += lane === "regulation" && focus === "court" ? 0.14 : 0.1;
  }
  return clampNumber(penalty, 0, 0.26, 0);
}

function estimateNarrativeTension(
  pair: OnchainEvidence[],
  lane: TrendLane,
  focus: PlannerFocus,
  sceneFamily: string
): number {
  const positive = /(유지|확대|증가|복귀|재가동|정상화|상승|회복|강화|안정)/;
  const negative = /(지연|둔화|정체|관망|이탈|비어|비면|빠지|식음|약화|하락|멈춤|없음|느림)/;
  const merged = sanitizeTweetText(pair.map((item) => `${item.label} ${item.value} ${item.summary}`).join(" | "));
  const positiveCount = pair.filter((item) => positive.test(`${item.value} ${item.summary}`)).length;
  const negativeCount = pair.filter((item) => negative.test(`${item.value} ${item.summary}`)).length;
  let tension = 0;
  if (positiveCount >= 1 && negativeCount >= 1) tension += 0.12;
  if (lane === "ecosystem" && focus === "retention" && /(wallet|retention|usage|community|cohort)/.test(sceneFamilyBase(sceneFamily))) {
    tension += 0.04;
  }
  if (lane === "regulation" && focus === "court" && /(court\+execution|capital\+court|verdict\+execution|briefing\+execution)/.test(sceneFamilyBase(sceneFamily))) {
    tension += 0.06;
  }
  if (lane === "protocol" && focus === "launch" && /(capital\+rollout|launch\+rollout|capital\+launch|return\+launch|launch\+ops|launch\+showcase)/.test(sceneFamilyBase(sceneFamily))) {
    tension += 0.06;
  }
  if (lane === "protocol" && focus === "durability" && /(recovery\+rollout|recovery\+validator)/.test(sceneFamilyBase(sceneFamily))) {
    tension += 0.04;
  }
  if (lane === "market-structure" && /(depth\+execution|capital\+depth|execution\+settlement|depth\+settlement|execution\+depth|volume\+depth|depth\+heat)/.test(sceneFamilyBase(sceneFamily))) {
    tension += 0.05;
  }
  if (/(따로 놀|엇갈|반쪽|허세|광고|기사값|발표값)/.test(merged)) {
    tension += 0.04;
  }
  return clampNumber(tension, 0, 0.24, 0);
}

type NarrativeBucket =
  | "legal"
  | "capital"
  | "builder"
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
  if (/(복귀 자금|예치 자금 복귀|스테이블|대기 자금|거래소 유입|거래소 이탈|netflow|exchange flow|자금 흐름|capital)/.test(normalized)) {
    return "capital";
  }
  if (/(개발자 잔류|빌더|builder|developer retention|developer activity)/.test(normalized)) {
    return "builder";
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
  if (/(체인 사용 압박|사용 압박|거래 대기 압박|밀린 거래 압박|거래 적체)/.test(normalized)) {
    return "durability";
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
  const facets = pair.map((item) => resolvePlannerSceneFacet(item, lane));
  const hasFacet = (facet: string) => facets.includes(facet);

  if (lane === "ecosystem") {
    if ((has("builder") || hasFacet("builder")) && (hasFacet("capital") || hasFacet("usage"))) return "builder";
    if (/(개발자|빌드)/.test(merged) && (has("builder") || hasFacet("builder"))) return "builder";
    if (has("retention") || hasFacet("retention") || hasFacet("wallet") || hasFacet("cohort")) return "retention";
    if (has("heat")) return "hype";
  }
  if (lane === "regulation") {
    if (hasFacet("court") || /(법원|소송|판결|court|lawsuit)/.test(merged)) return "court";
    if (has("legal") && (has("execution") || has("capital"))) return "execution";
  }
  if (lane === "protocol") {
    if (
      hasFacet("launch") ||
      /(메인넷|launch|준비도|출시|런치)/.test(merged) ||
      ((hasFacet("rollout") || /테스트넷|rollout|배포/.test(merged)) && (hasFacet("capital") || has("capital")))
    ) {
      return "launch";
    }
    if (has("ops") || hasFacet("recovery") || hasFacet("validator") || hasFacet("rollout")) return "durability";
  }
  if (lane === "onchain") {
    if (has("whale") || /(고래|거래소 자금|자금 방향)/.test(merged)) return "flow";
    if (has("durability")) return "durability";
    if (
      hasFacet("usage") ||
      hasFacet("congestion") ||
      ((hasFacet("capital") || has("capital")) &&
        (/(체인 사용 압박|밀린 거래 압박|거래 적체|체인 안쪽 사용|사용 지갑|지갑 재방문|관망 자금)/.test(merged) ||
          has("usage")))
    ) {
      return "durability";
    }
  }
  if (lane === "market-structure") {
    if (has("settlement") || /(호가 유동성|현물 체결|깊이)/.test(merged)) return "settlement";
    if (has("liquidity")) return "liquidity";
  }

  return "general";
}

function resolvePlannerSceneFacet(item: OnchainEvidence, lane: TrendLane): string {
  const normalized = sanitizeTweetText(`${item.label} ${item.value} ${item.summary}`).toLowerCase();
  if (lane === "ecosystem") {
    if (/(개발자|빌더|builder|developer)/.test(normalized)) return "builder";
    if (/(지갑\s*재방문|wallet\s*return|wallet\s*revisit|지갑\s*복귀)/.test(normalized)) return "wallet";
    if (/(사용자\s*재방문|유저\s*재방문|재방문\s*흐름|cohort|returning\s*user|사용자\s*복귀)/.test(normalized)) return "cohort";
    if (/(재방문|잔류|retention|returning|sticky)/.test(normalized)) return "retention";
    if (/(예치 자금 복귀|자금 복귀|복귀 자금|returning capital)/.test(normalized)) return "return";
    if (/(일기장|내부자|회의실|포스터)/.test(normalized)) return "inside";
    if (/(지갑|wallet|실사용|usage|사용 흔적)/.test(normalized)) return "usage";
    if (/(커뮤니티|community|열기|광고|홍보|hype)/.test(normalized)) return "community";
    if (/(예치 자금|자금 복귀|capital|tvl)/.test(normalized)) return "capital";
  }
  if (lane === "regulation") {
    if (/(집행|현장 반응|execution)/.test(normalized)) return "execution";
    if (/(브리핑|해설|기사|뉴스)/.test(normalized)) return "briefing";
    if (/(판결|평결|verdict)/.test(normalized)) return "verdict";
    if (/(법원|소송|판결|court|lawsuit)/.test(normalized)) return "court";
    if (/(etf\s*대기\s*주문|대기\s*주문|매수\s*자리|order)/.test(normalized)) return "order";
    if (/(etf|심사|승인|policy|regulation|당국|sec|cftc)/.test(normalized)) return "policy";
    if (/(대기 자금|자금 흐름|capital)/.test(normalized)) return "capital";
  }
  if (lane === "protocol") {
    if (/(배포 큐|배포|rollout|큐)/.test(normalized)) return "rollout";
    if (/(운영 로그|운영 반응|ops|log)/.test(normalized)) return "ops";
    if (/(쇼케이스|데모|무대|객석|포스터|발표회|showcase|demo|stage|audience)/.test(normalized)) return "showcase";
    if (/(복귀 자금|예치 자금|자금 복귀|returning capital)/.test(normalized)) return "return";
    if (/(복귀 자금|예치 자금|자금 복귀|capital)/.test(normalized)) return "capital";
    if (/(메인넷|launch|출시|준비도)/.test(normalized)) return "launch";
    if (/(검증자|validator|합의|consensus)/.test(normalized)) return "validator";
    if (/(복구|recovery|장애)/.test(normalized)) return "recovery";
    if (/(테스트넷|testnet|업그레이드|rollup|firedancer)/.test(normalized)) return "rollout";
  }
  if (lane === "onchain") {
    if (/(고래|큰손|whale|주소 이동|exchange flow|거래소 자금)/.test(normalized)) return "flow";
    if (/(수수료|멤풀|거래 대기|거래 적체|network fee|mempool)/.test(normalized)) return "congestion";
    if (/(체인 사용 압박|사용 압박|체인 안쪽 사용|사용 지갑|지갑 재방문|실사용 잔류|실사용 흔적)/.test(normalized)) {
      return "usage";
    }
    if (/(스테이블|대기 자금|관망 자금|stablecoin|capital)/.test(normalized)) return "capital";
    if (/(활성 지갑|address activity|사용 지갑|usage|tvl)/.test(normalized)) return "usage";
  }
  if (lane === "market-structure") {
    if (/(현물 체결|체결|settlement|spot)/.test(normalized)) return "execution";
    if (/(거래량|volume)/.test(normalized)) return "volume";
    if (/(호가|orderbook|깊이|depth|유동성|liquidity)/.test(normalized)) return "depth";
    if (/(자금 쏠림|capital|자금 흐름|funding)/.test(normalized)) return "capital";
    if (/(주문 소화|execution)/.test(normalized)) return "execution";
    if (/(화면|분위기|과열|heat)/.test(normalized)) return "heat";
  }
  if (lane === "macro") {
    if (/(달러|dxy|usd|eur)/.test(normalized)) return "fx";
    if (/(금리|fed|ecb|rates|treasury)/.test(normalized)) return "rates";
    if (/(물가|inflation|cpi)/.test(normalized)) return "inflation";
    if (/(자금 흐름|capital)/.test(normalized)) return "capital";
  }
  return classifyNarrativeBucket(item);
}

function sceneFamilyBase(sceneFamily: string): string {
  const parts = String(sceneFamily || "")
    .split(":")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length <= 3) return parts.join(":");
  return parts.slice(0, 3).join(":");
}

function sceneFamilyMatches(sceneFamily: string, regex: RegExp): boolean {
  return regex.test(sceneFamilyBase(sceneFamily));
}

function sceneFamilyTilt(sceneFamily: string): string {
  const parts = String(sceneFamily || "")
    .split(":")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length <= 3) return "";
  return parts.slice(3).join(":");
}

function rewriteSceneFamilyBase(sceneFamily: string, nextBase: string): string {
  const parts = String(sceneFamily || "")
    .split(":")
    .map((part) => part.trim())
    .filter(Boolean);
  const baseParts = nextBase
    .split(":")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!baseParts.length) return sceneFamily;
  const tail = parts.length > 3 ? parts.slice(3) : [];
  return [...baseParts, ...tail].join(":");
}

function augmentSceneFamilyBaseWithHeadline(
  sceneFamily: string,
  headline: string,
  lane: TrendLane,
  focus: PlannerFocus
): string {
  const normalized = sanitizeTweetText(headline).toLowerCase();
  const base = sceneFamilyBase(sceneFamily);
  if (!normalized || !base) return sceneFamily;

  if (lane === "protocol" && focus === "launch" && base === "protocol:launch:capital") {
    if (/(쇼케이스|데모|무대|객석|포스터|발표회)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "protocol:launch:launch+showcase");
    }
    if (/(운영|로그|복구)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "protocol:launch:launch+ops");
    }
    if (/(복귀 자금|자금 복귀|돌아오|돈이 눕|돈이 안 붙)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "protocol:launch:return+launch");
    }
    if (/(메인넷|launch|출시|준비도|런치)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "protocol:launch:capital+launch");
    }
  }
  if (lane === "protocol" && focus === "launch" && base === "protocol:launch:return+launch") {
    if (/(객석|무대|쇼케이스|포스터|데모|발표회)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "protocol:launch:return+showcase");
    }
    if (/(운영|로그|복구)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "protocol:launch:return+ops");
    }
    if (/(박수|발표|설명|기사|뉴스|기대)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "protocol:launch:return+announcement");
    }
  }
  if (lane === "protocol" && focus === "launch" && base === "protocol:launch:return+ops") {
    if (/(객석|무대|쇼케이스|포스터|데모|발표회)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "protocol:launch:return+showcase");
    }
    if (/(박수|발표|설명|기사|뉴스|기대|브리핑)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "protocol:launch:return+announcement");
    }
    if (/(메인넷|launch|출시|준비도|런치)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "protocol:launch:return+launch");
    }
  }
  if (lane === "protocol" && focus === "launch" && base === "protocol:launch:return+announcement") {
    if (/(객석|무대|쇼케이스|포스터|데모|발표회)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "protocol:launch:return+showcase");
    }
    if (/(운영|로그|복구|배포|롤아웃)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "protocol:launch:return+ops");
    }
    if (/(자금|돈|복귀 자금|자금 복귀|자금 흐름)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "protocol:launch:launch+treasury");
    }
  }
  if (lane === "protocol" && focus === "launch" && base === "protocol:launch:launch+ops") {
    if (/(쇼케이스|데모|무대|객석|포스터|발표회)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "protocol:launch:launch+showcase");
    }
    if (/(복귀 자금|자금 복귀|돌아오|복귀|돈이 눕|돈이 안 붙)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "protocol:launch:return+ops");
    }
    if (/(발표|박수|기사|뉴스|설명)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "protocol:launch:return+announcement");
    }
    if (/(메인넷|launch|출시|준비도|런치)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "protocol:launch:launch+capital");
    }
  }
  if (lane === "protocol" && focus === "launch" && base === "protocol:launch:launch+capital") {
    if (/(쇼케이스|데모|무대|객석|포스터|발표회)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "protocol:launch:launch+showcase");
    }
    if (/(운영|로그|복구)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "protocol:launch:launch+ops");
    }
    if (/(복귀 자금|자금 복귀|돌아오|복귀|돈이 눕|돈이 안 붙)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "protocol:launch:return+launch");
    }
  }
  if (lane === "protocol" && focus === "durability" && base === "protocol:durability:rollout") {
    if (/(운영|로그)/.test(normalized) && /(검증자|validator|합의)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "protocol:durability:validator+log");
    }
    if (/(복구|장애)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "protocol:durability:recovery+rollout");
    }
    if (/(검증자|validator|합의)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "protocol:durability:rollout+validator");
    }
    if (/(운영|로그)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "protocol:durability:repair+ops");
    }
  }
  if (lane === "protocol" && focus === "durability" && base === "protocol:durability:rollout+validator") {
    if (/(복구|장애)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "protocol:durability:recovery+validator");
    }
    if (/(운영|로그)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "protocol:durability:recovery+rollout");
    }
  }
  if (lane === "protocol" && focus === "durability" && base === "protocol:durability:recovery+rollout") {
    if (/(운영|로그)/.test(normalized) && /(검증자|validator|합의)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "protocol:durability:validator+log");
    }
    if (/(검증자|validator|합의)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "protocol:durability:recovery+validator");
    }
    if (/(운영|로그)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "protocol:durability:repair+ops");
    }
  }
  if (lane === "protocol" && focus === "durability" && base === "protocol:durability:recovery+validator") {
    if (/(복구|장애)/.test(normalized) && /(검증자|validator|합의)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "protocol:durability:repair+validator");
    }
    if (/(운영|로그)/.test(normalized) && /(검증자|validator|합의)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "protocol:durability:ops+validator");
    }
  }
  if (lane === "protocol" && focus === "durability" && base === "protocol:durability:validator+log") {
    if (/(복구|장애)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "protocol:durability:recovery+validator");
    }
    if (/(롤아웃|배포)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "protocol:durability:rollout+validator");
    }
    if (/(운영|로그)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "protocol:durability:ops+log");
    }
  }
  if (lane === "protocol" && focus === "durability" && base === "protocol:durability:repair+ops") {
    if (/(복구|장애)/.test(normalized) && /(운영|로그)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "protocol:durability:ops+recovery");
    }
  }
  if (lane === "protocol" && focus === "durability" && base === "protocol:durability:ops+log") {
    if (/(복구|장애)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "protocol:durability:ops+recovery");
    }
    if (/(검증자|validator|합의)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "protocol:durability:ops+validator");
    }
  }
  if (lane === "regulation" && focus === "court" && base === "regulation:court:capital+execution") {
    if (/(브리핑|해설|기사|뉴스)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "regulation:court:briefing+execution");
    }
    if (/(판결|평결|verdict)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "regulation:court:verdict+execution");
    }
    if (/(판결|법원|소송|court|lawsuit)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "regulation:court:court+execution");
    }
  }
  if (lane === "regulation" && focus === "court" && base === "regulation:court:briefing") {
    if (/(판결|평결|verdict)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "regulation:court:verdict+execution");
    }
    if (/(판결|법원|소송|court|lawsuit)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "regulation:court:court+execution");
    }
    if (/(주문|ETF|대기 주문|매수 자리)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "regulation:court:order+capital");
    }
    if (/(자금|돈|capital|대기 자금)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "regulation:court:capital+execution");
    }
    if (/집행/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "regulation:court:briefing+execution");
    }
  }
  if (lane === "regulation" && focus === "court" && base === "regulation:court:briefing+execution") {
    if (/(주문|ETF|대기 주문|매수 자리)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "regulation:court:order+capital");
    }
    if (/(자금|돈|capital|대기 자금)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "regulation:court:capital+execution");
    }
    if (/(판결|법원|소송|court|lawsuit)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "regulation:court:capital+court");
    }
  }
  if (lane === "regulation" && focus === "court" && base === "regulation:court:verdict+execution") {
    if (/(브리핑|해설|기사|뉴스)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "regulation:court:briefing+execution");
    }
    if (/(주문|ETF|대기 주문|매수 자리)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "regulation:court:order+capital");
    }
    if (/(자금|돈|capital|대기 자금)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "regulation:court:capital+execution");
    }
  }
  if (lane === "regulation" && focus === "court" && base === "regulation:court:briefing+capital") {
    if (/집행/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "regulation:court:briefing+execution");
    }
    if (/(판결|평결|verdict)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "regulation:court:verdict+execution");
    }
    if (/(법원|소송|court|lawsuit)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "regulation:court:court+execution");
    }
    if (/(주문|ETF|대기 주문|매수 자리)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "regulation:court:order+capital");
    }
  }
  if (lane === "regulation" && focus === "court" && base === "regulation:court:court+execution") {
    if (/(주문|ETF|대기 주문|매수 자리)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "regulation:court:order+capital");
    }
    if (/(자금|돈|capital|대기 자금)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "regulation:court:capital+court");
    }
    if (/(브리핑|해설|기사|뉴스)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "regulation:court:briefing+capital");
    }
  }
  if (lane === "ecosystem" && focus === "retention" && base === "ecosystem:retention:cohort+wallet") {
    if (/(실사용|생활 흔적|체인 사용)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "ecosystem:retention:cohort+usage");
    }
    if (/(지갑|wallet)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "ecosystem:retention:wallet+retention");
    }
    if (/(재방문|잔류|사람|다음 날)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "ecosystem:retention:retention+cohort");
    }
  }
  if (lane === "ecosystem" && focus === "retention" && base === "ecosystem:retention:retention+cohort") {
    if (/(실사용|생활 흔적|체인 사용|사용 흔적)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "ecosystem:retention:cohort+usage");
    }
    if (/(생활 리듬|습관|habits?)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "ecosystem:retention:habit+retention");
    }
    if (/(지갑|wallet)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "ecosystem:retention:wallet+retention");
    }
    if (/(다음 날|남는 사람|사람 수|잔류|재방문)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "ecosystem:retention:cohort+retention");
    }
  }
  if (lane === "ecosystem" && focus === "retention" && base === "ecosystem:retention:wallet+retention") {
    if (/(생활 흔적|실사용|체인 사용)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "ecosystem:retention:wallet+usage");
    }
    if (/(생활 리듬|습관|habits?)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "ecosystem:retention:return+habit");
    }
    if (/(사람|사용자|유저|다음 날|잔류)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "ecosystem:retention:retention+cohort");
    }
  }
  if (lane === "ecosystem" && focus === "retention" && base === "ecosystem:retention:habit+retention") {
    if (/(지갑|wallet|복귀 흔적)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "ecosystem:retention:return+habit");
    }
    if (/(다음 날|남는 사람|사람 수|잔류)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "ecosystem:retention:retention+cohort");
    }
  }
  if (lane === "ecosystem" && focus === "retention" && base === "ecosystem:retention:return+habit") {
    if (/(실사용|생활 흔적|체인 사용|사용 흔적)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "ecosystem:retention:community+retention");
    }
    if (/(다음 날|남는 사람|사람 수|잔류)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "ecosystem:retention:cohort+retention");
    }
  }
  if (lane === "ecosystem" && focus === "retention" && base === "ecosystem:retention:wallet+usage") {
    if (/(생활 리듬|습관|habits?)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "ecosystem:retention:return+habit");
    }
    if (/(다음 날|남는 사람|사람 수|잔류|재방문)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "ecosystem:retention:retention+cohort");
    }
    if (/(커뮤니티|열기|광고|홍보)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "ecosystem:retention:community+retention");
    }
  }
  if (lane === "ecosystem" && focus === "retention" && base === "ecosystem:retention:usage+wallet") {
    if (/(생활 리듬|습관|habits?)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "ecosystem:retention:habit+retention");
    }
    if (/(다음 날|남는 사람|사람 수|잔류|재방문)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "ecosystem:retention:cohort+retention");
    }
    if (/(커뮤니티|열기|광고|홍보)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "ecosystem:retention:community+retention");
    }
  }
  if (lane === "ecosystem" && focus === "builder" && base === "ecosystem:builder:builder+capital") {
    if (/(실사용|사용 흔적|사용자)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "ecosystem:builder:builder+usage");
    }
    if (/(복귀 자금|자금 복귀|돌아오|복귀)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "ecosystem:builder:builder+return");
    }
    if (/(일기장|내부자|회의실|포스터)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "ecosystem:builder:builder+inside");
    }
  }
  if (lane === "ecosystem" && focus === "builder" && base === "ecosystem:builder:builder+return") {
    if (/(실사용|사용 흔적|생활 흔적|사용자)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "ecosystem:builder:builder+usage");
    }
    if (/(일기장|내부자|회의실|포스터|객석)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "ecosystem:builder:builder+inside");
    }
    if (/(예치 자금|tvl|자금 복귀|복귀 자금|자금)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "ecosystem:builder:builder+treasury");
    }
  }
  if (lane === "market-structure" && focus === "settlement" && base === "market-structure:settlement:execution+settlement") {
    if (/(거래량|숫자|볼륨)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "market-structure:settlement:volume+settlement");
    }
    if (/(현물 체결|체결)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "market-structure:settlement:fill+depth");
    }
    if (/(화면|분위기|과열)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "market-structure:settlement:depth+heat");
    }
    if (/(호가|깊이)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "market-structure:settlement:depth+settlement");
    }
  }
  if (lane === "market-structure" && focus === "settlement" && base === "market-structure:settlement:execution+depth") {
    if (/(거래량|숫자|볼륨)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "market-structure:settlement:volume+settlement");
    }
    if (/(현물 체결|체결|주문 소화)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "market-structure:settlement:fill+depth");
    }
    if (/(화면|과열|분위기)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "market-structure:settlement:settlement+heat");
    }
    if (/(호가|깊이)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "market-structure:settlement:depth+settlement");
    }
  }
  if (lane === "market-structure" && focus === "settlement" && base === "market-structure:settlement:fill+depth") {
    if (/(호가|깊이|book)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "market-structure:settlement:fill+book");
    }
    if (/(거래량|숫자|볼륨|정산|settlement)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "market-structure:settlement:execution+settlement");
    }
  }
  if (lane === "market-structure" && focus === "settlement" && base === "market-structure:settlement:volume+depth") {
    if (/(호가|깊이|book)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "market-structure:settlement:volume+book");
    }
    if (/(정산|settlement)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "market-structure:settlement:volume+settlement");
    }
  }
  if (lane === "market-structure" && focus === "settlement" && base === "market-structure:settlement:execution") {
    if (/(거래량|숫자|볼륨)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "market-structure:settlement:volume+settlement");
    }
    if (/(현물 체결|체결|주문 소화)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "market-structure:settlement:execution+settlement");
    }
    if (/(화면|과열|분위기|호가|깊이)/.test(normalized)) {
      return rewriteSceneFamilyBase(sceneFamily, "market-structure:settlement:depth+heat");
    }
  }

  return sceneFamily;
}

function resolveEventSceneNudge(headline: string, lane: TrendLane, focus: PlannerFocus): string {
  const normalized = sanitizeTweetText(headline).toLowerCase();
  if (!normalized) return "";
  if (lane === "ecosystem" && focus === "builder") {
    if (/(일기장|내부자|회의실|포스터)/.test(normalized)) return "inside-gap";
    if (/(엇갈|다른 속도|갈라|서로 다른|낙관|헐거워)/.test(normalized)) return "split";
    if (/(복귀 자금|자금 복귀|안 돌아|돌아오지|객석)/.test(normalized)) return "return-lag";
    if (/(예치 자금|tvl|자금|돈)/.test(normalized)) return "treasury-lag";
    if (/(실사용|사용|얇|묽)/.test(normalized)) return "usage-thin";
  }
  if (lane === "ecosystem" && focus === "retention") {
    if (/(생활 리듬|습관|habits?)/.test(normalized)) return "habit-gap";
    if (/(지갑|다시 들어오|복귀 흔적)/.test(normalized)) return "wallet-thins";
    if (/(사람|잔류|재방문|다음 날)/.test(normalized)) return "cohort-thin";
    if (/(생활 흔적|실사용|체인 사용)/.test(normalized)) return "usage-gap";
    if (/(열기|커뮤니티)/.test(normalized)) return "heat-gap";
  }
  if (lane === "regulation" && focus === "court") {
    if (/(브리핑|해설)/.test(normalized)) return "briefing-gap";
    if (/(기사|뉴스)/.test(normalized)) return "headline-gap";
    if (/(판결|법원|소송)/.test(normalized)) return "verdict-gap";
    if (/집행/.test(normalized)) return "execution-lag";
    if (/(자금|돈)/.test(normalized)) return "capital-lag";
  }
  if (lane === "protocol" && focus === "launch") {
    if (/(객석|무대)/.test(normalized)) return "audience-gap";
    if (/(발표회|브리핑)/.test(normalized)) return "briefing-gap";
    if (/(쇼케이스|데모|발표|무대|반쪽|얇아진|얇은)/.test(normalized)) return "showcase";
    if (/(발표회|객석|종이|무대)/.test(normalized)) return "stage-gap";
    if (/(복귀 자금|돈)/.test(normalized)) return "return-lag";
    if (/(운영|로그)/.test(normalized)) return "ops-cold";
    if (/(롤아웃|배포)/.test(normalized)) return "rollout-lag";
  }
  if (lane === "protocol" && focus === "durability") {
    if (/(로그|기록)/.test(normalized)) return "log-gap";
    if (/(박수|발표|쇼케이스)/.test(normalized)) return "applause-gap";
    if (/(복구|장애)/.test(normalized)) return "repair-gap";
    if (/(운영|로그)/.test(normalized)) return "ops-gap";
    if (/(검증자|합의)/.test(normalized)) return "validator-gap";
    if (/(배포|롤아웃)/.test(normalized)) return "rollout-lag";
  }
  if (lane === "market-structure" && focus === "settlement") {
    if (/거래량|숫자/.test(normalized)) return "size-only";
    if (/(정산|settlement)/.test(normalized)) return "settlement-lag";
    if (/(호가|깊이)/.test(normalized)) return "book-thin";
    if (/(체결|주문 소화)/.test(normalized)) return "fill-thin";
    if (/(화면|과열|분위기)/.test(normalized)) return "screen-heat";
  }
  return "";
}

function augmentSceneFamilyWithHeadline(
  sceneFamily: string,
  headline: string,
  lane: TrendLane,
  focus: PlannerFocus
): string {
  const baseAdjusted = augmentSceneFamilyBaseWithHeadline(sceneFamily, headline, lane, focus);
  const nudge = resolveEventSceneNudge(headline, lane, focus);
  if (!nudge) return baseAdjusted;
  const parts = baseAdjusted.split(":").filter(Boolean);
  if (parts.slice(3).includes(nudge)) return baseAdjusted;
  return `${baseAdjusted}:${nudge}`;
}

function diversifyDerivedSceneFamilyForVariant(
  sceneFamily: string,
  lane: TrendLane,
  focus: PlannerFocus,
  variant: number
): string {
  const index = Math.abs(variant) % 8;
  const base = sceneFamilyBase(sceneFamily);
  if (!base) return sceneFamily;

  if (lane === "ecosystem" && focus === "builder" && base === "ecosystem:builder:builder+return") {
    const rotated = [
      "ecosystem:builder:builder+return",
      "ecosystem:builder:builder+inside",
      "ecosystem:builder:builder+usage",
      "ecosystem:builder:builder+treasury",
      "ecosystem:builder:builder+usage",
      "ecosystem:builder:builder+inside",
      "ecosystem:builder:builder+treasury",
      "ecosystem:builder:builder+return",
    ][index];
    return rewriteSceneFamilyBase(sceneFamily, rotated);
  }
  if (
    lane === "ecosystem" &&
    focus === "retention" &&
    /(ecosystem:retention:wallet\+retention|ecosystem:retention:retention\+cohort|ecosystem:retention:retention\+usage|ecosystem:retention:usage\+wallet|ecosystem:retention:cohort\+usage|ecosystem:retention:retention\+wallet|ecosystem:retention:cohort\+retention|ecosystem:retention:wallet\+usage|ecosystem:retention:habit\+retention|ecosystem:retention:return\+habit)/.test(base)
  ) {
    const rotated = [
      "ecosystem:retention:community+retention",
      "ecosystem:retention:cohort+retention",
      "ecosystem:retention:wallet+retention",
      "ecosystem:retention:cohort+usage",
      "ecosystem:retention:usage+wallet",
      "ecosystem:retention:habit+retention",
      "ecosystem:retention:return+habit",
      "ecosystem:retention:community+retention",
    ][index];
    return rewriteSceneFamilyBase(sceneFamily, rotated);
  }
  if (
    lane === "regulation" &&
    focus === "court" &&
    /(regulation:court:briefing\+execution|regulation:court:briefing\+capital|regulation:court:capital\+execution|regulation:court:court\+execution|regulation:court:order\+capital|regulation:court:verdict\+execution)/.test(base)
  ) {
    const rotated = [
      "regulation:court:order+capital",
      "regulation:court:order+capital",
      "regulation:court:capital+execution",
      "regulation:court:briefing+capital",
      "regulation:court:briefing+execution",
      "regulation:court:verdict+execution",
      "regulation:court:capital+court",
      "regulation:court:capital+execution",
    ][index];
    return rewriteSceneFamilyBase(sceneFamily, rotated);
  }
  if (
    lane === "protocol" &&
    focus === "launch" &&
    /(protocol:launch:return\+announcement|protocol:launch:return\+launch|protocol:launch:return\+showcase|protocol:launch:return\+ops|protocol:launch:launch\+treasury|protocol:launch:launch\+ops|protocol:launch:launch\+capital|protocol:launch:launch\+showcase|protocol:launch:launch\+audience|protocol:launch:return\+audience)/.test(base)
  ) {
    const rotated = [
      "protocol:launch:return+audience",
      "protocol:launch:launch+showcase",
      "protocol:launch:return+announcement",
      "protocol:launch:launch+rollout",
      "protocol:launch:launch+audience",
      "protocol:launch:launch+audience",
      "protocol:launch:capital+rollout",
      "protocol:launch:return+showcase",
    ][index];
    return rewriteSceneFamilyBase(sceneFamily, rotated);
  }
  if (
    lane === "protocol" &&
    focus === "durability" &&
    /(protocol:durability:recovery\+validator|protocol:durability:recovery\+rollout|protocol:durability:repair\+validator|protocol:durability:repair\+ops|protocol:durability:ops\+validator|protocol:durability:ops\+recovery|protocol:durability:rollout\+validator|protocol:durability:recovery\+ops|protocol:durability:ops\+log|protocol:durability:repair\+log|protocol:durability:validator\+log)/.test(base)
  ) {
    const rotated = [
      "protocol:durability:validator+log",
      "protocol:durability:repair+ops",
      "protocol:durability:repair+log",
      "protocol:durability:recovery+ops",
      "protocol:durability:recovery+ops",
      "protocol:durability:ops+log",
      "protocol:durability:rollout+validator",
      "protocol:durability:repair+log",
    ][index];
    return rewriteSceneFamilyBase(sceneFamily, rotated);
  }
  if (
    lane === "market-structure" &&
    focus === "settlement" &&
    /(market-structure:settlement:execution\+depth|market-structure:settlement:volume\+depth|market-structure:settlement:depth\+settlement|market-structure:settlement:depth\+heat|market-structure:settlement:execution\+settlement|market-structure:settlement:volume\+settlement|market-structure:settlement:fill\+depth|market-structure:settlement:settlement\+heat|market-structure:settlement:fill\+book|market-structure:settlement:volume\+book)/.test(base)
  ) {
    const rotated = [
      "market-structure:settlement:execution+settlement",
      "market-structure:settlement:volume+book",
      "market-structure:settlement:depth+settlement",
      "market-structure:settlement:volume+settlement",
      "market-structure:settlement:execution+settlement",
      "market-structure:settlement:depth+heat",
      "market-structure:settlement:fill+depth",
      "market-structure:settlement:volume+book",
    ][index];
    return rewriteSceneFamilyBase(sceneFamily, rotated);
  }
  return sceneFamily;
}

function resolvePlannerSceneTilt(
  lane: TrendLane,
  focus: PlannerFocus,
  pair: OnchainEvidence[],
  facets: string[]
): string {
  const lagPattern = /(지연|둔화|관망|정체|비어|비면|늦|얕|약화|멈춤|없음|느림|식음|뒤처|빠지)/;
  const holdPattern = /(유지|확대|증가|복귀|재가동|정상화|상승|회복|강화|안정|버티|남)/;
  const mergedText = sanitizeTweetText(pair.map((item) => `${item.label} ${item.value} ${item.summary}`).join(" | ")).toLowerCase();
  const rows = pair.map((item) => {
    const text = sanitizeTweetText(`${item.label} ${item.value} ${item.summary}`).toLowerCase();
    return {
      facet: resolvePlannerSceneFacet(item, lane),
      lag: lagPattern.test(text),
      hold: holdPattern.test(text),
      text,
    };
  });
  const facetLag = (...targets: string[]) => rows.some((row) => targets.includes(row.facet) && row.lag);
  const facetHold = (...targets: string[]) => rows.some((row) => targets.includes(row.facet) && row.hold);
  const hasFacet = (...targets: string[]) => facets.some((facet) => targets.includes(facet));
  const scoreCandidates = new Map<string, number>();
  const addScore = (tilt: string, score: number, condition: boolean = true) => {
    if (!condition || !tilt || score <= 0) return;
    scoreCandidates.set(tilt, (scoreCandidates.get(tilt) || 0) + score);
  };
  const pickTilt = (fallback: string = ""): string => {
    if (scoreCandidates.size === 0) return fallback;
    const ranked = [...scoreCandidates.entries()].sort((a, b) => b[1] - a[1]);
    const topScore = ranked[0][1];
    const finalists = ranked.filter((item) => topScore - item[1] <= 0.08).map((item) => item[0]);
    if (finalists.length === 1) return finalists[0];
    const seed = stableSeed(`${lane}|${focus}|${mergedText}|${facets.join("+")}|tilt`);
    return finalists[Math.abs(seed) % finalists.length];
  };

  if (lane === "ecosystem" && focus === "builder") {
    addScore("capital-lag", 0.74, hasFacet("capital") && facetLag("capital"));
    addScore("usage-gap", 0.72, hasFacet("usage") && facetLag("usage"));
    addScore("builder-holds", 0.66, facetHold("builder") && facetHold("capital"));
    addScore("builder-holds", 0.12, /(복귀|재가동|버티)/.test(mergedText));
    addScore("builder-split", 0.42, true);
    return pickTilt("builder-split");
  }
  if (lane === "ecosystem" && focus === "retention") {
    addScore("usage-gap", 0.74, hasFacet("usage") && facetLag("usage"));
    addScore("habit-gap", 0.82, /(생활|습관|다음 날|리듬)/.test(mergedText));
    addScore("wallet-thins", 0.72, hasFacet("wallet") && facetLag("wallet"));
    addScore("cohort-thins", 0.72, hasFacet("cohort", "retention") && facetLag("cohort", "retention"));
    addScore("heat-gap", 0.68, /(열기|커뮤니티|광고|포스터)/.test(mergedText));
    addScore("retention-holds", 0.64, facetHold("wallet", "cohort", "retention"));
    addScore("retention-split", 0.4, true);
    return pickTilt("retention-split");
  }
  if (lane === "regulation" && focus === "court") {
    addScore("order-lag", 0.8, hasFacet("order") && facetLag("order"));
    addScore("execution-lag", 0.74, hasFacet("execution") && facetLag("execution"));
    addScore("capital-lag", 0.72, hasFacet("capital") && facetLag("capital"));
    addScore("headline-gap", 0.7, /(브리핑|해설|기사|뉴스)/.test(mergedText));
    addScore("verdict-gap", 0.7, /(판결|평결|법원|소송|court)/.test(mergedText));
    addScore("order-holds", 0.66, facetHold("order", "capital"));
    addScore("court-holds", 0.62, facetHold("court", "execution"));
    addScore("court-split", 0.4, true);
    return pickTilt("court-split");
  }
  if (lane === "regulation" && focus === "execution") {
    addScore("capital-lag", 0.72, hasFacet("capital") && facetLag("capital"));
    addScore("execution-holds", 0.62, facetHold("execution"));
    addScore("execution-split", 0.42, true);
    return pickTilt("execution-split");
  }
  if (lane === "protocol" && focus === "launch") {
    addScore("return-lag", 0.76, hasFacet("return") && facetLag("return"));
    addScore("audience-gap", 0.74, /(객석|무대|쇼케이스|발표회|브리핑|포스터|데모)/.test(mergedText));
    addScore("ops-lag", 0.72, hasFacet("ops") && facetLag("ops"));
    addScore("rollout-lag", 0.72, hasFacet("rollout") && facetLag("rollout"));
    addScore("capital-lag", 0.68, hasFacet("capital") && facetLag("capital"));
    addScore("ops-holds", 0.62, facetHold("ops", "rollout"));
    addScore("launch-holds", 0.6, facetHold("launch", "return", "capital"));
    addScore("launch-split", 0.38, true);
    return pickTilt("launch-split");
  }
  if (lane === "protocol" && focus === "durability") {
    addScore("log-gap", 0.82, /(로그|기록|운영 로그)/.test(mergedText));
    addScore("applause-gap", 0.72, /(박수|발표|쇼케이스|무대|객석)/.test(mergedText));
    addScore("ops-lag", 0.74, hasFacet("ops") && facetLag("ops"));
    addScore("validator-lag", 0.74, hasFacet("validator") && facetLag("validator"));
    addScore("recovery-lag", 0.76, hasFacet("recovery") && facetLag("recovery"));
    addScore("rollout-lag", 0.68, hasFacet("rollout") && facetLag("rollout"));
    addScore("ops-holds", 0.62, facetHold("ops", "recovery"));
    addScore("durability-holds", 0.6, facetHold("validator", "recovery", "rollout"));
    addScore("durability-split", 0.38, true);
    return pickTilt("durability-split");
  }
  if (lane === "market-structure" && focus === "settlement") {
    addScore("size-only", 0.74, hasFacet("volume") && facetLag("volume"));
    addScore("execution-thin", 0.76, hasFacet("execution") && facetLag("execution"));
    addScore("depth-thin", 0.74, hasFacet("depth") && facetLag("depth"));
    addScore("settlement-lag", 0.72, /(정산|settlement|호가 책|깊이)/.test(mergedText));
    addScore("book-thin", 0.72, /(호가 책|호가|book)/.test(mergedText));
    addScore("settlement-holds", 0.62, facetHold("volume", "depth") || facetHold("settlement", "execution"));
    addScore("settlement-split", 0.38, true);
    return pickTilt("settlement-split");
  }
  if (lane === "market-structure" && focus === "liquidity") {
    addScore("depth-thin", 0.76, hasFacet("depth") && facetLag("depth"));
    addScore("capital-thin", 0.72, hasFacet("capital") && facetLag("capital"));
    addScore("liquidity-holds", 0.62, facetHold("execution", "depth"));
    addScore("liquidity-split", 0.38, true);
    return pickTilt("liquidity-split");
  }
  if (lane === "onchain" && focus === "durability") {
    addScore("congestion-lag", 0.74, hasFacet("congestion") && facetLag("congestion"));
    addScore("capital-lag", 0.72, hasFacet("capital") && facetLag("capital"));
    addScore("durability-holds", 0.62, facetHold("usage", "congestion", "capital"));
    addScore("durability-split", 0.38, true);
    return pickTilt("durability-split");
  }
  if (lane === "onchain" && focus === "flow") {
    addScore("capital-lag", 0.74, hasFacet("capital") && facetLag("capital"));
    addScore("flow-lag", 0.74, hasFacet("flow") && facetLag("flow"));
    addScore("flow-holds", 0.62, facetHold("flow", "capital"));
    addScore("flow-split", 0.38, true);
    return pickTilt("flow-split");
  }
  return "";
}

function resolvePlannerSceneFamily(lane: TrendLane, focus: PlannerFocus, pair: OnchainEvidence[]): string {
  const facets = [...new Set(pair.map((item) => resolvePlannerSceneFacet(item, lane)).filter(Boolean))].sort().slice(0, 3);
  const merged = sanitizeTweetText(pair.map((item) => `${item.label} ${item.value} ${item.summary}`).join(" | ")).toLowerCase();
  let facetKey = facets.length > 0 ? facets.join("+") : "generic";

  if (lane === "ecosystem" && focus === "builder") {
    if (facets.includes("builder") && facets.includes("inside")) {
      facetKey = "builder+inside";
    } else if (facets.includes("builder") && facets.includes("return")) {
      facetKey = "builder+return";
    } else if (facets.includes("builder") && facets.includes("usage")) {
      facetKey = "builder+usage";
    } else if (facets.includes("builder") && facets.includes("capital")) {
      facetKey = /(예치 자금|tvl|자금)/.test(merged) ? "builder+capital" : "builder";
    } else if (facets.includes("builder")) {
      facetKey = "builder";
    }
  }

  if (lane === "ecosystem" && focus === "retention") {
    if (/(생활|습관|리듬|다음 날)/.test(merged)) {
      facetKey = facets.includes("wallet") ? "return+habit" : "habit+retention";
    } else if (/(실사용|생활 흔적|사용 흔적|체인 안쪽 사용)/.test(merged) && facets.includes("usage")) {
      facetKey = facets.includes("wallet") ? "usage+wallet" : facets.includes("cohort") ? "cohort+usage" : "retention+usage";
    } else if (/(커뮤니티|열기|광고|홍보|포스터)/.test(merged)) {
      facetKey = "community+retention";
    } else if (facets.includes("wallet") && (facets.includes("cohort") || facets.includes("retention"))) {
      facetKey = "wallet+retention";
    } else if (facets.includes("retention") && facets.includes("usage")) {
      facetKey = facets.includes("cohort") ? "cohort+usage" : "retention+usage";
    } else if (facets.includes("cohort") && facets.includes("retention")) {
      facetKey = "retention+cohort";
    } else if (facets.includes("community") && facets.includes("retention")) {
      facetKey = "community+retention";
    } else if (facets.includes("wallet")) {
      facetKey = "wallet+retention";
    }
  }

  if (lane === "protocol" && focus === "launch") {
    if (/(쇼케이스|데모|무대|객석|발표회|포스터)/.test(merged) && facets.includes("return")) {
      facetKey = "return+showcase";
    } else if (/(박수|발표|브리핑|기사|뉴스|기대)/.test(merged) && facets.includes("return")) {
      facetKey = "return+announcement";
    } else if (/(운영|로그|복구|배포|롤아웃)/.test(merged) && facets.includes("return")) {
      facetKey = "return+ops";
    } else if (/(자금|돈|treasury|예치 자금|복귀 자금)/.test(merged) && facets.includes("launch")) {
      facetKey = /(롤아웃|배포|운영)/.test(merged) ? "capital+rollout" : "capital+launch";
    } else if (facets.includes("showcase") && facets.includes("return")) {
      facetKey = "return+showcase";
    } else if (facets.includes("showcase") && facets.includes("launch")) {
      facetKey = "launch+showcase";
    } else if (facets.includes("ops") && (facets.includes("launch") || facets.includes("return"))) {
      facetKey = "launch+ops";
    } else if (facets.includes("return") && (facets.includes("launch") || facets.includes("capital"))) {
      facetKey = "return+launch";
    } else if (facets.includes("capital") && facets.includes("launch")) {
      facetKey = "capital+launch";
    } else if (facets.includes("capital") && facets.includes("rollout")) {
      facetKey = "capital+rollout";
    }
  }

  if (lane === "market-structure" && focus === "settlement") {
    if (/(호가 책|호가|book)/.test(merged) && facets.includes("execution")) {
      facetKey = "fill+book";
    } else if (/(거래량|숫자|볼륨)/.test(merged) && /(호가|깊이|book)/.test(merged) && facets.includes("depth")) {
      facetKey = /(현물 체결|체결|주문 소화)/.test(merged) ? "fill+book" : "volume+book";
    } else if (/(거래량|숫자|볼륨)/.test(merged) && /(정산|settlement)/.test(merged) && facets.includes("depth")) {
      facetKey = "volume+settlement";
    } else if (/(거래량|숫자|볼륨)/.test(merged) && facets.includes("depth")) {
      facetKey = /(현물 체결|체결|주문 소화)/.test(merged) ? "execution+settlement" : "volume+book";
    } else if (/(정산|settlement)/.test(merged) && facets.includes("depth")) {
      facetKey = "depth+settlement";
    } else if (facets.includes("execution") && facets.includes("depth")) {
      facetKey = /(정산|settlement)/.test(merged) ? "execution+settlement" : "fill+depth";
    } else if (facets.includes("volume") && facets.includes("depth")) {
      facetKey = "volume+settlement";
    } else if (facets.includes("depth") && facets.includes("heat")) {
      facetKey = "depth+heat";
    } else if (facets.includes("depth")) {
      facetKey = "depth+settlement";
    }
  }

  const tilt = resolvePlannerSceneTilt(lane, focus, pair, facets);
  return tilt ? `${lane}:${focus}:${facetKey}:${tilt}` : `${lane}:${focus}:${facetKey}`;
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
    if (has("builder") && (has("capital") || has("usage") || has("settlement"))) bonus += 0.2;
    if (focus === "builder") bonus += 0.18;
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
    if (focus === "launch") bonus += 0.14;
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
  if (genericLabelCount >= 2) penalty += 0.14;
  else if (genericLabelCount === 1) penalty += 0.08;
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
    [/^법원 일정$/i, "법원 일정"],
    [/^집행 흔적$/i, "집행 흔적"],
    [/^대기 자금 흐름$/i, "대기 자금 흐름"],
    [/^ETF 대기 주문$/i, "ETF 대기 주문"],
    [/^프로토콜 변화 신호$/i, "업그레이드 반응"],
    [/^검증자 안정성$/i, "검증자 안정성"],
    [/^복구 속도$/i, "복구 속도"],
    [/^메인넷 준비도$/i, "메인넷 준비도"],
    [/^복귀 자금$/i, "복귀 자금"],
    [/^업그레이드 배포 큐$/i, "배포 큐"],
    [/^개발자 잔류$/i, "개발자 잔류"],
    [/^예치 자금 복귀$/i, "예치 자금 복귀"],
    [/^지갑 재방문$/i, "지갑 재방문"],
    [/^사용자 재방문 흐름$/i, "사용자 재방문 흐름"],
    [/^큰 주문 소화$/i, "큰 주문 소화"],
    [/^자금 쏠림 방향$/i, "자금 쏠림 방향"],
    [/^호가 두께$/i, "호가 두께"],
    [/^현물 체결$/i, "현물 체결"],
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

function resolveDistinctKoEvidenceAnchors(plan: EventEvidencePlan): [string, string] {
  const primary = formatEvidenceAnchor(plan.evidence[0], "ko");
  const secondary = formatEvidenceAnchor(plan.evidence[1], "ko");
  if (!primary || !secondary || primary !== secondary) {
    return [primary, secondary];
  }

  const primaryLabel = humanizeStructuralEvidenceLabel(plan.evidence[0]?.label || "");
  const secondaryLabel = humanizeStructuralEvidenceLabel(plan.evidence[1]?.label || "");
  if (primaryLabel && secondaryLabel && primaryLabel !== secondaryLabel) {
    return [primaryLabel.slice(0, 70), secondaryLabel.slice(0, 70)];
  }

  const primaryValue = sanitizeTweetText(plan.evidence[0]?.value || "").trim();
  const secondaryValue = sanitizeTweetText(plan.evidence[1]?.value || "").trim();
  const a = primaryValue && primaryValue !== primary ? `${primary} ${primaryValue}` : primary;
  const b = secondaryValue && secondaryValue !== secondary ? `${secondary} ${secondaryValue}` : secondary;
  return [sanitizeTweetText(a).slice(0, 70), sanitizeTweetText(b).slice(0, 70)];
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
