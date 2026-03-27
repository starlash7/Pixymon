import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEventEvidenceFallbackPost,
  buildOnchainEvidence,
  buildStructuralFallbackEventsFromEvidence,
  buildTrendEvents,
  planEventEvidenceAct,
  validateEventEvidenceContract,
} from "../src/services/engagement/event-evidence.ts";
import {
  buildTrendNutrients,
  pickTrendFocus,
} from "../src/services/engagement/trend-context.ts";

test("pickTrendFocus prefers headline with lower overlap against recent posts", () => {
  const focus = pickTrendFocus(
    [
      "Bitcoin ETF flows stay flat as fear index drops",
      "Solana Firedancer upgrade testnet milestone reached",
    ],
    [
      {
        content: "Bitcoin ETF 유입이 둔화되고 공포 지수가 내려오는 구간을 추적 중.",
        timestamp: new Date().toISOString(),
      },
    ]
  );

  assert.equal(focus.headline, "Solana Firedancer upgrade testnet milestone reached");
  assert.equal(focus.reason, "novelty");
  assert.ok(focus.requiredTokens.length > 0);
});

test("pickTrendFocus returns fallback when headline list is empty", () => {
  const focus = pickTrendFocus([], []);
  assert.equal(typeof focus.headline, "string");
  assert.ok(focus.headline.length > 0);
  assert.equal(focus.reason, "fallback");
});

test("buildTrendNutrients normalizes market/news into nutrient packets", () => {
  const nutrients = buildTrendNutrients({
    createdAt: new Date().toISOString(),
    marketData: [
      { symbol: "BTC", name: "Bitcoin", price: 100000, change24h: 1.2 },
      { symbol: "ETH", name: "Ethereum", price: 4200, change24h: -0.8 },
    ],
    newsRows: [
      {
        item: {
          title: "ECB rate pause surprises markets",
          summary: "EUR volatility rises after ECB comments",
          source: "Reuters",
          category: "macro",
          importance: "high",
        },
        sourceKey: "news:reuters",
        trust: 0.74,
      },
    ],
  });

  assert.ok(nutrients.length >= 3);
  assert.ok(nutrients.some((item) => item.source === "market"));
  assert.ok(nutrients.some((item) => item.source === "news"));
});

test("pickTrendFocus downranks btc-centric headline when recent btc saturation is high", () => {
  const recent = Array.from({ length: 6 }).map(() => ({
    content: "극공포 구간에서 BTC 수수료와 멤풀, 스테이블 유입을 계속 추적 중.",
    timestamp: new Date().toISOString(),
  }));

  const focus = pickTrendFocus(
    [
      "Bitcoin fear index rebounds as ETF flow uncertainty persists",
      "Solana Firedancer client performance milestone update",
    ],
    recent
  );

  assert.equal(focus.headline, "Solana Firedancer client performance milestone update");
});

test("planEventEvidenceAct avoids onchain lane over-concentration when alternatives exist", () => {
  const createdAt = new Date().toISOString();
  const recentPosts = Array.from({ length: 7 }).map(() => ({
    content: "온체인 고래/스테이블 흐름과 BTC 멤풀 수수료를 추적 중.",
    timestamp: createdAt,
  }));

  const events = [
    {
      id: "event-onchain",
      lane: "onchain" as const,
      headline: "Whale transaction activity spikes on Bitcoin mempool",
      summary: "Large wallet movement rose with mempool backlog.",
      source: "news:chainwire",
      trust: 0.82,
      freshness: 0.9,
      capturedAt: createdAt,
      keywords: ["whale", "mempool"],
    },
    {
      id: "event-macro",
      lane: "macro" as const,
      headline: "ECB signals delayed rate cuts amid sticky inflation",
      summary: "Macro rate expectations shifted after ECB remarks.",
      source: "news:reuters",
      trust: 0.8,
      freshness: 0.88,
      capturedAt: createdAt,
      keywords: ["ecb", "inflation"],
    },
  ];

  const evidence = buildOnchainEvidence([
    {
      id: "n1",
      source: "onchain",
      category: "mempool",
      label: "BTC 멤풀 대기열",
      value: "42,000 tx",
      evidence: "BTC mempool backlog at 42k transactions",
      trust: 0.82,
      freshness: 0.93,
      capturedAt: createdAt,
      metadata: { digestScore: 0.72 },
    },
    {
      id: "n2",
      source: "news",
      category: "macro-news",
      label: "ECB rate path",
      value: "컷 기대 지연",
      evidence: "ECB officials reiterated inflation persistence.",
      trust: 0.78,
      freshness: 0.9,
      capturedAt: createdAt,
      metadata: { digestScore: 0.71 },
    },
    {
      id: "n3",
      source: "market",
      category: "price-action",
      label: "EUR/USD",
      value: "-0.7%",
      evidence: "EUR/USD fell after ECB comments",
      trust: 0.76,
      freshness: 0.87,
      capturedAt: createdAt,
      metadata: { digestScore: 0.69 },
    },
  ]);

  const plan = planEventEvidenceAct({
    events,
    evidence,
    recentPosts,
  });

  assert.ok(plan);
  assert.equal(plan?.lane, "macro");
});

test("planEventEvidenceAct deprioritizes btc price headlines when richer protocol event exists", () => {
  const createdAt = new Date().toISOString();
  const events = [
    {
      id: "event-btc-price",
      lane: "macro" as const,
      headline: "Bitcoin hovers just under $70k as risk appetite gets a bid",
      summary: "BTC price rises 3% as sentiment improves.",
      source: "news:markets",
      trust: 0.86,
      freshness: 0.92,
      capturedAt: createdAt,
      keywords: ["bitcoin", "$btc"],
    },
    {
      id: "event-protocol",
      lane: "protocol" as const,
      headline: "Firedancer testnet milestone sharpens validator upgrade path",
      summary: "Validator rollout and recovery design move back into focus.",
      source: "news:coindesk",
      trust: 0.79,
      freshness: 0.9,
      capturedAt: createdAt,
      keywords: ["firedancer", "validator", "upgrade"],
    },
  ];

  const evidence = buildOnchainEvidence([
    {
      id: "n1",
      source: "onchain",
      category: "validator",
      label: "검증자가 얼마나 남아 있는지",
      value: "안정",
      evidence: "Validator participation stayed stable through the upgrade window",
      trust: 0.83,
      freshness: 0.94,
      capturedAt: createdAt,
      metadata: { digestScore: 0.79 },
    },
    {
      id: "n2",
      source: "news",
      category: "protocol-news",
      label: "업그레이드 합의 과정",
      value: "정상화",
      evidence: "Operator rollout notes point to orderly upgrade coordination",
      trust: 0.8,
      freshness: 0.9,
      capturedAt: createdAt,
      metadata: { digestScore: 0.74 },
    },
    {
      id: "n3",
      source: "market",
      category: "price-action",
      label: "BTC 24h 변동",
      value: "+3.0%",
      evidence: "Bitcoin price gained 3.0% over 24h",
      trust: 0.74,
      freshness: 0.88,
      capturedAt: createdAt,
      metadata: { digestScore: 0.68 },
    },
  ]);

  const plan = planEventEvidenceAct({
    events,
    evidence,
    recentPosts: [],
  });

  assert.ok(plan);
  assert.equal(plan?.event.id, "event-protocol");
});

test("validateEventEvidenceContract enforces event + two evidence anchors", () => {
  const createdAt = new Date().toISOString();
  const plan = {
    lane: "protocol" as const,
    event: {
      id: "event-protocol",
      lane: "protocol" as const,
      headline: "Solana Firedancer client passes major testnet milestone",
      summary: "Validator performance improved in latest test cycle.",
      source: "news:coindesk",
      trust: 0.79,
      freshness: 0.91,
      capturedAt: createdAt,
      keywords: ["solana", "firedancer"],
    },
    evidence: [
      {
        id: "ev1",
        lane: "protocol" as const,
        nutrientId: "n1",
        source: "news" as const,
        label: "Firedancer TPS benchmark",
        value: "+18%",
        summary: "Benchmark throughput improved by 18%",
        trust: 0.78,
        freshness: 0.9,
        capturedAt: createdAt,
      },
      {
        id: "ev2",
        lane: "onchain" as const,
        nutrientId: "n2",
        source: "onchain" as const,
        label: "Validator queue",
        value: "정상화",
        summary: "Validator queue congestion normalized",
        trust: 0.74,
        freshness: 0.88,
        capturedAt: createdAt,
      },
    ],
    hasOnchainEvidence: true,
    hasCrossSourceEvidence: true,
    evidenceSourceDiversity: 2,
    focus: "general",
    plannerScore: 1,
    plannerWarnings: [],
    laneUsage: {
      totalPosts: 4,
      byLane: {
        protocol: 1,
        ecosystem: 1,
        regulation: 0,
        macro: 1,
        onchain: 1,
        "market-structure": 0,
      },
    },
    laneProjectedRatio: 0.4,
    laneQuotaLimited: false,
  };

  const ok = validateEventEvidenceContract(
    "Solana Firedancer 이슈가 핵심. 근거로 Firedancer TPS benchmark +18%와 Validator queue 정상화를 같이 본다.",
    plan
  );
  assert.equal(ok.ok, true);

  const bad = validateEventEvidenceContract("Solana 이벤트만 보고 있다.", plan);
  assert.equal(bad.ok, false);
  assert.equal(typeof bad.reason, "string");
});

test("structural fallback avoids raw fee/orderbook jargon in public headline", () => {
  const createdAt = new Date().toISOString();
  const evidence = buildOnchainEvidence([
    {
      id: "n1",
      source: "onchain",
      category: "fee",
      label: "BTC 네트워크 수수료",
      value: "6 sat/vB",
      evidence: "BTC network fee is 6 sat/vB",
      trust: 0.81,
      freshness: 0.92,
      capturedAt: createdAt,
      metadata: { digestScore: 0.76 },
    },
    {
      id: "n2",
      source: "market",
      category: "price-action",
      label: "시장 반응",
      value: "과열 가능성",
      evidence: "Altcoins rallied before broader confirmation",
      trust: 0.72,
      freshness: 0.88,
      capturedAt: createdAt,
      metadata: { digestScore: 0.68 },
    },
  ]);

  const events = buildStructuralFallbackEventsFromEvidence(evidence, createdAt, 3);
  assert.ok(events.length >= 1);
  const joined = events.map((item) => `${item.headline} ${item.summary}`).join(" ");
  assert.equal(/호가창|시간차|체인 수수료\s*6\s*sat\/vB/i.test(joined), false);
  assert.equal(/체인 사용 압박|대기 자금|큰손 움직임|가격 반응/i.test(joined), true);
});

test("fallback post humanizes raw evidence into pixymon-facing Korean", () => {
  const createdAt = new Date().toISOString();
  const plan = {
    lane: "market-structure" as const,
    event: {
      id: "event-1",
      lane: "market-structure" as const,
      headline: "외부 뉴스 흐름이 실제 주문까지 번지는지 본다",
      summary: "External news and market reaction diverged.",
      source: "evidence:structural-fallback",
      trust: 0.74,
      freshness: 0.91,
      capturedAt: createdAt,
      keywords: ["news", "order"],
    },
    evidence: [
      {
        id: "ev1",
        lane: "onchain" as const,
        nutrientId: "n1",
        source: "onchain" as const,
        label: "BTC 네트워크 수수료",
        value: "6 sat/vB",
        summary: "BTC network fee is 6 sat/vB",
        trust: 0.82,
        freshness: 0.93,
        digestScore: 0.77,
        capturedAt: createdAt,
      },
      {
        id: "ev2",
        lane: "market-structure" as const,
        nutrientId: "n2",
        source: "market" as const,
        label: "시장 반응",
        value: "과열 가능성",
        summary: "Altcoins rallied before broader confirmation",
        trust: 0.75,
        freshness: 0.89,
        digestScore: 0.69,
        capturedAt: createdAt,
      },
    ],
    hasOnchainEvidence: true,
    hasCrossSourceEvidence: true,
    evidenceSourceDiversity: 2,
    focus: "general",
    plannerScore: 1,
    plannerWarnings: [],
    laneUsage: { totalPosts: 0, byLane: { protocol: 0, ecosystem: 0, regulation: 0, macro: 0, onchain: 0, "market-structure": 0 } },
    laneProjectedRatio: 0.15,
    laneQuotaLimited: false,
  };

  const post = buildEventEvidenceFallbackPost(plan, "ko", 220, "identity-journal");
  assert.equal(/시간차|호가창|체인 수수료\s*6\s*sat\/vB/i.test(post), false);
  assert.equal(/체인 사용|가격 반응|규제 반응/i.test(post), true);
});

test("validateEventEvidenceContract accepts localized event anchor for english headline", () => {
  const createdAt = new Date().toISOString();
  const plan = {
    lane: "regulation" as const,
    event: {
      id: "event-reg",
      lane: "regulation" as const,
      headline: "The SEC and CFTC join hands to discuss stablecoin oversight",
      summary: "Regulators coordinated on stablecoin oversight next steps.",
      source: "news:rss",
      trust: 0.78,
      freshness: 0.89,
      capturedAt: createdAt,
      keywords: ["sec", "cftc", "stablecoin"],
    },
    evidence: [
      {
        id: "ev1",
        lane: "regulation" as const,
        nutrientId: "n1",
        source: "news" as const,
        label: "규제 쪽 실제 움직임",
        value: "포착",
        summary: "규제 해석보다 실제 집행과 반응의 간격이 먼저 보였다.",
        trust: 0.79,
        freshness: 0.9,
        capturedAt: createdAt,
      },
      {
        id: "ev2",
        lane: "onchain" as const,
        nutrientId: "n2",
        source: "onchain" as const,
        label: "스테이블 흐름",
        value: "확대",
        summary: "스테이블 유입이 규제 논의 구간에서도 이어졌다.",
        trust: 0.76,
        freshness: 0.88,
        capturedAt: createdAt,
      },
    ],
    hasOnchainEvidence: true,
    hasCrossSourceEvidence: true,
    evidenceSourceDiversity: 2,
    focus: "general",
    plannerScore: 1,
    plannerWarnings: [],
    laneUsage: {
      totalPosts: 2,
      byLane: {
        protocol: 0,
        ecosystem: 0,
        regulation: 1,
        macro: 0,
        onchain: 1,
        "market-structure": 0,
      },
    },
    laneProjectedRatio: 0.5,
    laneQuotaLimited: false,
  };

  const localized = validateEventEvidenceContract(
    "규제 문장과 실제 행동이 어디서 갈라지는지 먼저 본다. 규제 쪽 실제 움직임 포착, 스테이블 흐름 확대를 함께 놓고 본다.",
    plan
  );
  assert.equal(localized.ok, true);
});

test("buildOnchainEvidence humanizes english-heavy evidence before planning", () => {
  const createdAt = new Date().toISOString();
  const evidence = buildOnchainEvidence([
    {
      id: "n1",
      source: "news",
      category: "protocol-news",
      label: "AI agents are quietly rewriting prediction market trading",
      value: "observed",
      evidence: "AI agents are quietly rewriting prediction market trading behavior across retail wallets.",
      trust: 0.8,
      freshness: 0.9,
      capturedAt: createdAt,
      metadata: { digestScore: 0.72 },
    },
  ]);

  assert.equal(evidence[0]?.label, "예측시장 사용");
  assert.equal(evidence[0]?.value, "");
  assert.match(String(evidence[0]?.summary || ""), /예측시장/);
});

test("buildOnchainEvidence humanizes raw onchain fee evidence before planning", () => {
  const createdAt = new Date().toISOString();
  const evidence = buildOnchainEvidence([
    {
      id: "n1",
      source: "onchain",
      category: "fee",
      label: "BTC 네트워크 수수료",
      value: "6 sat/vB",
      evidence: "BTC network fee is 6 sat/vB",
      trust: 0.81,
      freshness: 0.9,
      capturedAt: createdAt,
      metadata: { digestScore: 0.71 },
    },
  ]);

  assert.equal(evidence[0]?.label, "낮아진 체인 사용 압박");
  assert.equal(String(evidence[0]?.value || ""), "");
  assert.equal(/sat\/vB/i.test(String(evidence[0]?.summary || "")), false);
});

test("buildOnchainEvidence keeps directional onchain evidence specific before planning", () => {
  const createdAt = new Date().toISOString();
  const evidence = buildOnchainEvidence([
    {
      id: "n1",
      source: "onchain",
      category: "stablecoin-flow",
      label: "스테이블코인 총공급 플로우",
      value: "+$220M (+0.8%)",
      evidence: "Stablecoin supply expanded through the session.",
      direction: "up",
      trust: 0.82,
      freshness: 0.91,
      capturedAt: createdAt,
      metadata: { digestScore: 0.79 },
    },
    {
      id: "n2",
      source: "onchain",
      category: "exchange-flow",
      label: "거래소 순유입 프록시",
      value: "0.84x (-11%)",
      evidence: "Exchange flow ratio fell as funds moved away from venues.",
      direction: "down",
      trust: 0.8,
      freshness: 0.9,
      capturedAt: createdAt,
      metadata: { digestScore: 0.76 },
    },
  ]);

  const labels = evidence.map((item) => item.label);
  assert.deepEqual(labels, ["대기 자금 유입", "거래소 쪽 자금 이탈"]);
});

test("buildTrendEvents reassigns lane after localized korean headline changes issue type", () => {
  const createdAt = new Date().toISOString();
  const events = buildTrendEvents({
    createdAt,
    newsRows: [
      {
        item: {
          title: "XRP wallets expand while SEC review drags on",
          summary: "Policy overhang still shapes the next move around XRP ecosystem headlines.",
          source: "CoinDesk",
          category: "ecosystem",
          importance: "high",
        },
        sourceKey: "news:coindesk",
        trust: 0.77,
      },
    ],
  });

  assert.equal(events.length, 1);
  assert.equal(events[0]?.lane, "regulation");
  assert.match(String(events[0]?.headline || ""), /규제|정책/);
});

test("planEventEvidenceAct avoids weak fee-only onchain support when better structural support exists", () => {
  const createdAt = new Date().toISOString();
  const plan = planEventEvidenceAct({
    events: [
      {
        id: "event-reg",
        lane: "regulation",
        headline: "규제 문장과 실제 반응이 어디서 갈라지는지 먼저 짚는다",
        summary: "Stablecoin oversight debate keeps widening into market behavior.",
        source: "news:rss",
        trust: 0.81,
        freshness: 0.9,
        capturedAt: createdAt,
        keywords: ["규제", "stablecoin", "oversight"],
      },
    ],
    evidence: buildOnchainEvidence([
      {
        id: "n1",
        source: "news",
        category: "regulation-news",
        label: "The SEC and CFTC join hands to discuss stablecoin oversight",
        value: "CoinDesk RSS",
        evidence: "Regulators coordinated on stablecoin oversight next steps.",
        trust: 0.79,
        freshness: 0.9,
        capturedAt: createdAt,
        metadata: { digestScore: 0.76 },
      },
      {
        id: "n2",
        source: "onchain",
        category: "fees",
        label: "BTC 네트워크 수수료",
        value: "2 sat/vB",
        evidence: "Network fee stayed low during the session.",
        trust: 0.78,
        freshness: 0.88,
        capturedAt: createdAt,
        metadata: { digestScore: 0.71 },
      },
      {
        id: "n3",
        source: "onchain",
        category: "stablecoin-flow",
        label: "스테이블코인 총공급 플로우",
        value: "+$180M",
        evidence: "Stablecoin supply expanded while the policy discussion kept dragging on.",
        trust: 0.82,
        freshness: 0.91,
        capturedAt: createdAt,
        metadata: { digestScore: 0.79 },
      },
    ]),
    recentPosts: [],
    requireOnchainEvidence: true,
    requireCrossSourceEvidence: true,
  });

  assert.ok(plan);
  assert.ok(plan?.evidence.some((item) => /대기 자금/.test(item.label)));
  assert.ok(!plan?.evidence.every((item) => /체인 사용/.test(item.label)));
});

test("buildEventEvidenceFallbackPost uses humanized anchors for raw english evidence", () => {
  const createdAt = new Date().toISOString();
  const fallback = buildEventEvidenceFallbackPost(
    {
      lane: "regulation",
      event: {
        id: "event-reg",
        lane: "regulation",
        headline: "규제 문장과 실제 반응이 어디서 갈라지는지 먼저 짚는다",
        summary: "Policy overhang widens into market behavior.",
        source: "news:rss",
        trust: 0.81,
        freshness: 0.9,
        capturedAt: createdAt,
        keywords: ["규제", "stablecoin", "oversight"],
      },
      evidence: [
        {
          id: "ev1",
          lane: "regulation",
          nutrientId: "n1",
          source: "news",
          label: "The SEC and CFTC join hands to discuss stablecoin oversight",
          value: "CoinDesk RSS",
          summary: "Regulators coordinated on stablecoin oversight next steps.",
          trust: 0.79,
          freshness: 0.9,
          capturedAt: createdAt,
        },
        {
          id: "ev2",
          lane: "onchain",
          nutrientId: "n2",
          source: "onchain",
          label: "BTC 네트워크 수수료",
          value: "2 sat/vB",
          summary: "Network fee stayed low during the session.",
          trust: 0.78,
          freshness: 0.88,
          capturedAt: createdAt,
        },
      ],
      hasOnchainEvidence: true,
      hasCrossSourceEvidence: true,
      evidenceSourceDiversity: 2,
      focus: "general",
      plannerScore: 1,
      plannerWarnings: [],
      laneUsage: {
        totalPosts: 0,
        byLane: {
          protocol: 0,
          ecosystem: 0,
          regulation: 0,
          macro: 0,
          onchain: 0,
          "market-structure": 0,
        },
      },
      laneProjectedRatio: 0,
      laneQuotaLimited: false,
    },
    "ko",
    220,
    "identity-journal"
  );

  assert.ok(fallback);
  assert.doesNotMatch(String(fallback), /SEC and CFTC|CoinDesk RSS/);
  assert.match(String(fallback), /규제|정책|체인 수수료|스테이블/);
});

test("planEventEvidenceAct blocks when onchain evidence is required but unavailable", () => {
  const createdAt = new Date().toISOString();
  const plan = planEventEvidenceAct({
    events: [
      {
        id: "event-macro",
        lane: "macro",
        headline: "ECB guidance shifts rate-cut expectations",
        summary: "Macro policy signal changed this session.",
        source: "news:reuters",
        trust: 0.8,
        freshness: 0.9,
        capturedAt: createdAt,
        keywords: ["ecb", "rate"],
      },
    ],
    evidence: buildOnchainEvidence([
      {
        id: "n-macro",
        source: "news",
        category: "macro-news",
        label: "ECB signal",
        value: "hawkish",
        evidence: "ECB held a hawkish tone in recent remarks.",
        trust: 0.78,
        freshness: 0.88,
        capturedAt: createdAt,
      },
      {
        id: "n-market",
        source: "market",
        category: "fx",
        label: "EUR/USD",
        value: "-0.5%",
        evidence: "EUR/USD dropped after the announcement.",
        trust: 0.74,
        freshness: 0.86,
        capturedAt: createdAt,
      },
    ]),
    recentPosts: [],
    requireOnchainEvidence: true,
    requireCrossSourceEvidence: true,
  });
  assert.equal(plan, null);
});

test("planEventEvidenceAct returns diversity metadata for selected evidence pair", () => {
  const createdAt = new Date().toISOString();
  const plan = planEventEvidenceAct({
    events: [
      {
        id: "event-eco",
        lane: "ecosystem",
        headline: "TON ecosystem gaming activity expands",
        summary: "User activity rose in consumer app clusters.",
        source: "news:cointelegraph",
        trust: 0.8,
        freshness: 0.89,
        capturedAt: createdAt,
        keywords: ["ton", "ecosystem", "gaming"],
      },
    ],
    evidence: buildOnchainEvidence([
      {
        id: "n-onchain",
        source: "onchain",
        category: "active-addresses",
        label: "TON active addresses",
        value: "+12%",
        evidence: "Active addresses increased 12% day over day.",
        trust: 0.82,
        freshness: 0.9,
        capturedAt: createdAt,
      },
      {
        id: "n-market",
        source: "market",
        category: "volume",
        label: "TON spot volume",
        value: "+18%",
        evidence: "Spot volume expanded in tandem with user activity.",
        trust: 0.76,
        freshness: 0.87,
        capturedAt: createdAt,
      },
    ]),
    recentPosts: [],
    requireOnchainEvidence: true,
    requireCrossSourceEvidence: true,
  });
  assert.ok(plan);
  assert.equal(plan?.hasOnchainEvidence, true);
  assert.equal(plan?.hasCrossSourceEvidence, true);
  assert.equal(plan?.evidenceSourceDiversity, 2);
});

test("buildEventEvidenceFallbackPost avoids label-style opener leakage", () => {
  const createdAt = new Date().toISOString();
  const fallback = buildEventEvidenceFallbackPost(
    {
      lane: "onchain",
      event: {
        id: "event-onchain",
        lane: "onchain",
        headline: "조용한 체인에서도 의도는 주소 이동에서 먼저 드러난다",
        summary: "Address flow structure signals intent before volume catches up.",
        source: "news:test",
        trust: 0.82,
        freshness: 0.9,
        capturedAt: createdAt,
        keywords: ["onchain", "address", "intent"],
      },
      evidence: [
        {
          id: "ev1",
          lane: "onchain",
          nutrientId: "n1",
          source: "onchain",
          label: "지갑 군집 변화",
          value: "확대",
          summary: "Wallet cluster dispersion expanded.",
          trust: 0.8,
          freshness: 0.9,
          capturedAt: createdAt,
        },
        {
          id: "ev2",
          lane: "macro",
          nutrientId: "n2",
          source: "news",
          label: "리스크 선호 전환",
          value: "지연",
          summary: "Risk appetite rotation still lagging.",
          trust: 0.76,
          freshness: 0.86,
          capturedAt: createdAt,
        },
      ],
      hasOnchainEvidence: true,
      hasCrossSourceEvidence: true,
      evidenceSourceDiversity: 2,
      focus: "general",
      plannerScore: 1,
      plannerWarnings: [],
      laneUsage: {
        totalPosts: 0,
        byLane: {
          protocol: 0,
          ecosystem: 0,
          regulation: 0,
          macro: 0,
          onchain: 0,
          "market-structure": 0,
        },
      },
      laneProjectedRatio: 0.2,
      laneQuotaLimited: false,
    },
    "ko",
    220,
    "identity-journal"
  );

  assert.equal(/(?:오늘 기록:|관찰 노트:|온체인에서 오늘 붙잡은 장면:)/.test(fallback), false);
  assert.ok(fallback.length >= 30);
});

test("buildEventEvidenceFallbackPost uses stronger pixymon cue and drops old fallback boilerplate", () => {
  const createdAt = new Date().toISOString();
  const fallback = buildEventEvidenceFallbackPost(
    {
      lane: "ecosystem",
      event: {
        id: "event-eco",
        lane: "ecosystem",
        headline: "말만 커지는 날이 아닌지, 실제로 다시 돌아오는 사람이 있는지 본다",
        summary: "Usage retention matters more than loud narrative.",
        source: "news:test",
        trust: 0.82,
        freshness: 0.9,
        capturedAt: createdAt,
        keywords: ["실사용", "리텐션"],
      },
      evidence: [
        {
          id: "ev1",
          lane: "ecosystem",
          nutrientId: "n1",
          source: "news",
          label: "실사용 흐름",
          value: "포착",
          summary: "People actually returned to use the product again.",
          trust: 0.8,
          freshness: 0.9,
          capturedAt: createdAt,
        },
        {
          id: "ev2",
          lane: "onchain",
          nutrientId: "n2",
          source: "onchain",
          label: "체인 사용",
          value: "살아남",
          summary: "Chain activity did not fade immediately.",
          trust: 0.78,
          freshness: 0.87,
          capturedAt: createdAt,
        },
      ],
      hasOnchainEvidence: true,
      hasCrossSourceEvidence: true,
      evidenceSourceDiversity: 2,
      focus: "general",
      plannerScore: 1,
      plannerWarnings: [],
      laneUsage: {
        totalPosts: 0,
        byLane: {
          protocol: 0,
          ecosystem: 0,
          regulation: 0,
          macro: 0,
          onchain: 0,
          "market-structure": 0,
        },
      },
      laneProjectedRatio: 0.2,
      laneQuotaLimited: false,
    },
    "ko",
    220,
    "identity-journal"
  );

  assert.doesNotMatch(fallback, /오늘 손에 남은 건|뭐가 먼저 식는지만 따라간다|끝까지 버틴 쪽만 오늘 메모에 남긴다/);
  assert.doesNotMatch(fallback, /근거는|지금 보는 근거는|내가 먼저 확인할 건/);
  assert.match(fallback, /광고|사람을 못 붙잡|실사용|재방문|사용 흔적/);
  assert.doesNotMatch(fallback, /살아남/);
});

test("buildTrendEvents maps news rows into lane-tagged events", () => {
  const events = buildTrendEvents({
    createdAt: new Date().toISOString(),
    newsRows: [
      {
        item: {
          title: "SEC opens new review process for spot crypto ETF filings",
          summary: "Regulatory review timeline shifted this week.",
          source: "Reuters",
          category: "regulatory",
        },
        sourceKey: "news:reuters",
        trust: 0.76,
      },
    ],
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].lane, "regulation");
  assert.match(events[0].headline, /규제|정책|반응/);
});

test("buildTrendEvents strips public korean lane labels from headlines", () => {
  const events = buildTrendEvents({
    createdAt: new Date().toISOString(),
    newsRows: [
      {
        item: {
          title: "생태계 포인트: 리텐션은 보상보다 관계 설계에서 먼저 결정된다",
          summary: "Community retention depends on relationship design first.",
          source: "CoinDesk RSS",
          category: "ecosystem",
        },
        sourceKey: "news:coindesk-rss",
        trust: 0.76,
      },
    ],
  });

  assert.equal(events.length, 1);
  assert.doesNotMatch(events[0].headline, /^생태계 포인트[:：]/);
  assert.match(events[0].headline, /리텐션|관계 설계/);
});

test("buildTrendEvents filters low-quality ranking and prediction headlines", () => {
  const events = buildTrendEvents({
    createdAt: new Date().toISOString(),
    newsRows: [
      {
        item: {
          title: "Artificial Superintelligence Alliance (FET) 트렌딩 4위, 지금이 매수 타이밍인가?",
          summary: "Price prediction and ranking style headline with no structural signal.",
          source: "Unknown",
          category: "markets",
        },
        sourceKey: "news:unknown",
        trust: 0.6,
      },
      {
        item: {
          title: "Validator upgrade coordination sharpens ahead of Firedancer rollout",
          summary: "Protocol operators aligned on upgrade path and recovery plan.",
          source: "CoinDesk",
          category: "protocol",
        },
        sourceKey: "news:coindesk",
        trust: 0.74,
      },
    ],
  });

  assert.equal(events.length, 1);
  assert.match(events[0].headline, /업그레이드|프로토콜|코드 변경|사용 흔적|살핀다|확인한다|짚는다/);
});

test("buildTrendEvents filters market snapshot headlines without structural signal", () => {
  const events = buildTrendEvents({
    createdAt: new Date().toISOString(),
    newsRows: [
      {
        item: {
          title: "크립토 시총 $2.51T | BTC 도미넌스 56.8%",
          summary: "24h change snapshot without a distinct event.",
          source: "Unknown",
          category: "markets",
        },
        sourceKey: "news:unknown",
        trust: 0.6,
      },
      {
        item: {
          title: "Court filing sharpens ETF review timeline for crypto issuers",
          summary: "Regulatory path changed after a new filing update.",
          source: "Reuters",
          category: "regulatory",
        },
        sourceKey: "news:reuters",
        trust: 0.76,
      },
    ],
  });

  assert.equal(events.length, 1);
  assert.match(events[0].headline, /규제|정책|반응/);
});

test("buildTrendEvents localizes english-only ecosystem headlines into korean scene text", () => {
  const events = buildTrendEvents({
    createdAt: new Date().toISOString(),
    newsRows: [
      {
        item: {
          title: "A huge gap between network use and token value is the most important thing happening in XRP right now",
          summary: "Network use and token value are diverging in XRP.",
          source: "CoinDesk RSS",
          category: "ecosystem",
        },
        sourceKey: "news:coindesk-rss",
        trust: 0.74,
      },
    ],
  });

  assert.equal(events.length, 1);
  assert.doesNotMatch(events[0].headline, /A huge gap between/i);
  assert.match(events[0].headline, /실제 사용 흔적|토큰 가격 서사|다시 본다/);
});

test("validateEventEvidenceContract accepts lane anchor when evidence anchors are present", () => {
  const createdAt = new Date().toISOString();
  const plan = {
    lane: "regulation" as const,
    event: {
      id: "event-regulation",
      lane: "regulation" as const,
      headline: "The SEC and CFTC join hands: State of Crypto",
      summary: "Regulators aligned their messaging around crypto oversight.",
      source: "news:rss",
      trust: 0.78,
      freshness: 0.9,
      capturedAt: createdAt,
      keywords: ["sec", "cftc", "regulation"],
    },
    evidence: [
      {
        id: "ev1",
        lane: "regulation" as const,
        nutrientId: "n1",
        source: "news" as const,
        label: "규제 쪽 실제 움직임",
        value: "포착",
        summary: "Regulatory move picked up in official messaging.",
        trust: 0.76,
        freshness: 0.87,
        capturedAt: createdAt,
      },
      {
        id: "ev2",
        lane: "onchain" as const,
        nutrientId: "n2",
        source: "onchain" as const,
        label: "BTC 네트워크 수수료",
        value: "2 sat/vB",
        summary: "Fees stayed low near 2 sat/vB.",
        trust: 0.8,
        freshness: 0.9,
        capturedAt: createdAt,
      },
    ],
    hasOnchainEvidence: true,
    hasCrossSourceEvidence: true,
    evidenceSourceDiversity: 2,
    focus: "general",
    plannerScore: 1,
    plannerWarnings: [],
    laneUsage: {
      totalPosts: 0,
      byLane: {
        protocol: 0,
        ecosystem: 0,
        regulation: 0,
        macro: 0,
        onchain: 0,
        "market-structure": 0,
      },
    },
    laneProjectedRatio: 0.1,
    laneQuotaLimited: false,
  };

  const contract = validateEventEvidenceContract(
    "규제 말과 실제 반응이 어디서 갈라지는지 본다. 규제 쪽 실제 움직임과 BTC 네트워크 수수료 2 sat/vB를 같이 둔다.",
    plan as any
  );

  assert.equal(contract.ok, true);
});

test("validateEventEvidenceContract accepts paraphrased price evidence aliases", () => {
  const createdAt = new Date().toISOString();
  const plan = {
    lane: "ecosystem" as const,
    event: {
      id: "event-ecosystem",
      lane: "ecosystem" as const,
      headline: "생태계가 살아 있다는 말이 정말 사용 흔적으로 이어지는지 확인한다",
      summary: "Usage narrative needs to survive beyond price action.",
      source: "news:test",
      trust: 0.78,
      freshness: 0.9,
      capturedAt: createdAt,
      keywords: ["생태계", "사용", "흔적"],
    },
    evidence: [
      {
        id: "ev1",
        lane: "onchain" as const,
        nutrientId: "n1",
        source: "onchain" as const,
        label: "BTC 네트워크 수수료",
        value: "2 sat/vB",
        summary: "Fees stayed near 2 sat/vB.",
        trust: 0.8,
        freshness: 0.9,
        capturedAt: createdAt,
      },
      {
        id: "ev2",
        lane: "ecosystem" as const,
        nutrientId: "n2",
        source: "market" as const,
        label: "ETH 24h 변동",
        value: "+8.78%",
        summary: "ETH price moved sharply over 24h.",
        trust: 0.74,
        freshness: 0.87,
        capturedAt: createdAt,
      },
    ],
    hasOnchainEvidence: true,
    hasCrossSourceEvidence: true,
    evidenceSourceDiversity: 2,
    focus: "general",
    plannerScore: 1,
    plannerWarnings: [],
    laneUsage: {
      totalPosts: 0,
      byLane: {
        protocol: 0,
        ecosystem: 0,
        regulation: 0,
        macro: 0,
        onchain: 0,
        "market-structure": 0,
      },
    },
    laneProjectedRatio: 0.1,
    laneQuotaLimited: false,
  };

  const contract = validateEventEvidenceContract(
    "생태계 서사가 실제 사용 흔적으로 이어지는지 본다. 체인 안쪽의 조용함과 알트 쪽에서 먼저 번진 열기를 같은 화면에 붙여 둔다.",
    plan as any
  );

  assert.equal(contract.ok, true);
});

test("buildStructuralFallbackEventsFromEvidence builds structural events from onchain evidence", () => {
  const createdAt = new Date().toISOString();
  const evidence = buildOnchainEvidence([
    {
      id: "n1",
      source: "onchain",
      category: "whale-flow",
      label: "고래/대형주소 활동 프록시",
      value: "+18%",
      evidence: "Large-holder activity picked up across major wallets.",
      trust: 0.82,
      freshness: 0.93,
      capturedAt: createdAt,
      metadata: { digestScore: 0.79 },
    },
    {
      id: "n2",
      source: "onchain",
      category: "stablecoin-flow",
      label: "스테이블코인 총공급 플로우",
      value: "+$240M",
      evidence: "Stablecoin supply expanded through the session.",
      trust: 0.84,
      freshness: 0.91,
      capturedAt: createdAt,
      metadata: { digestScore: 0.81 },
    },
    {
      id: "n3",
      source: "market",
      category: "price-action",
      label: "BTC 24h 변동",
      value: "+1.1%",
      evidence: "BTC price moved 1.1% in the last 24 hours.",
      trust: 0.7,
      freshness: 0.9,
      capturedAt: createdAt,
      metadata: { digestScore: 0.62 },
    },
  ]);

  const events = buildStructuralFallbackEventsFromEvidence(evidence, createdAt);

  assert.ok(events.length >= 1);
  assert.match(events[0].headline, /큰손 움직임 확대|대기 자금 유입/);
  assert.doesNotMatch(events[0].headline, /24h 변동|도미넌스|시총|공포 지수/i);
});

test("buildStructuralFallbackEventsFromEvidence skips pure price snapshot evidence", () => {
  const createdAt = new Date().toISOString();
  const evidence = buildOnchainEvidence([
    {
      id: "n1",
      source: "market",
      category: "price-action",
      label: "BTC 24h 변동",
      value: "+2.1%",
      evidence: "BTC price gained 2.1% in the last 24 hours.",
      trust: 0.72,
      freshness: 0.9,
      capturedAt: createdAt,
      metadata: { digestScore: 0.63 },
    },
    {
      id: "n2",
      source: "market",
      category: "market-snapshot",
      label: "BTC 도미넌스",
      value: "56.8%",
      evidence: "BTC dominance stayed near 56.8%.",
      trust: 0.7,
      freshness: 0.88,
      capturedAt: createdAt,
      metadata: { digestScore: 0.61 },
    },
  ]);

  const events = buildStructuralFallbackEventsFromEvidence(evidence, createdAt);
  assert.equal(events.length, 0);
});

test("buildStructuralFallbackEventsFromEvidence prefers specific directional evidence labels", () => {
  const createdAt = new Date().toISOString();
  const evidence = buildOnchainEvidence([
    {
      id: "n1",
      source: "onchain",
      category: "stablecoin-flow",
      label: "스테이블코인 총공급 플로우",
      value: "+$240M",
      evidence: "Stablecoin supply expanded through the session.",
      direction: "up",
      trust: 0.84,
      freshness: 0.91,
      capturedAt: createdAt,
      metadata: { digestScore: 0.81 },
    },
    {
      id: "n2",
      source: "onchain",
      category: "exchange-flow",
      label: "거래소 순유입 프록시",
      value: "0.82x (-12%)",
      evidence: "Exchange flow ratio fell as funds moved away from venues.",
      direction: "down",
      trust: 0.82,
      freshness: 0.9,
      capturedAt: createdAt,
      metadata: { digestScore: 0.79 },
    },
  ]);

  const events = buildStructuralFallbackEventsFromEvidence(evidence, createdAt, 2);
  assert.ok(events.length >= 1);
  assert.match(events[0].headline, /대기 자금 유입|거래소 쪽 자금 이탈/);
  assert.doesNotMatch(events[0].headline, /대기 자금 흐름|거래소 쪽 자금 이동/);
});

test("buildStructuralFallbackEventsFromEvidence uses builder-specific ecosystem headlines", () => {
  const createdAt = new Date().toISOString();
  const evidence = buildOnchainEvidence([
    {
      id: "n1",
      source: "news",
      category: "ecosystem",
      label: "개발자 커뮤니티 반응",
      value: "증가",
      evidence: "Developer participation kept climbing across consumer apps.",
      trust: 0.81,
      freshness: 0.9,
      capturedAt: createdAt,
      metadata: { digestScore: 0.79 },
    },
    {
      id: "n2",
      source: "onchain",
      category: "tvl",
      label: "TVL 유입",
      value: "+$220M",
      evidence: "Locked capital returned alongside the developer push.",
      trust: 0.84,
      freshness: 0.92,
      capturedAt: createdAt,
      metadata: { digestScore: 0.82 },
    },
  ]);

  const events = buildStructuralFallbackEventsFromEvidence(evidence, createdAt, 2);
  const ecosystemEvent = events.find((event) => event.lane === "ecosystem");
  assert.ok(ecosystemEvent);
  assert.match(ecosystemEvent.headline, /개발 기세|예치 자금|생태계 기세|실체/);
  assert.doesNotMatch(ecosystemEvent.headline, /생태계 판단은|생태계 서사가 실제 사용으로 이어지는지/);
});

test("buildStructuralFallbackEventsFromEvidence emits multiple protocol structural families when sharp pairs exist", () => {
  const createdAt = new Date().toISOString();
  const evidence = buildOnchainEvidence([
    {
      id: "p1",
      source: "protocol",
      category: "validator",
      label: "검증자 안정성",
      value: "유지",
      evidence: "Validator stability held across the rollout.",
      trust: 0.84,
      freshness: 0.9,
      capturedAt: createdAt,
      metadata: { digestScore: 0.81 },
    },
    {
      id: "p2",
      source: "protocol",
      category: "recovery",
      label: "복구 속도",
      value: "둔화",
      evidence: "Recovery lagged the celebratory release narrative.",
      trust: 0.82,
      freshness: 0.88,
      capturedAt: createdAt,
      metadata: { digestScore: 0.78 },
    },
    {
      id: "p3",
      source: "protocol",
      category: "launch",
      label: "메인넷 준비도",
      value: "상승",
      evidence: "Launch readiness strengthened across operator notes.",
      trust: 0.8,
      freshness: 0.89,
      capturedAt: createdAt,
      metadata: { digestScore: 0.76 },
    },
    {
      id: "p4",
      source: "market",
      category: "capital",
      label: "복귀 자금",
      value: "지연",
      evidence: "Returning capital lagged the launch applause.",
      trust: 0.79,
      freshness: 0.87,
      capturedAt: createdAt,
      metadata: { digestScore: 0.74 },
    },
  ]);

  const events = buildStructuralFallbackEventsFromEvidence(evidence, createdAt, 4).filter((event) => event.lane === "protocol");
  assert.ok(events.length >= 2);
  assert.notEqual(events[0].headline, events[1].headline);
  assert.ok(events.some((event) => /복구 기록|복구 태도|검증자/.test(event.headline)));
  assert.ok(events.some((event) => /메인넷|복귀 자금|런치|출시/.test(event.headline)));
});

test("buildStructuralFallbackEventsFromEvidence keeps rollout-validator durability family alive when evidence allows it", () => {
  const createdAt = new Date().toISOString();
  const evidence = [
    {
      id: "dur-rollout-a",
      lane: "protocol" as const,
      nutrientId: "n-dur-rollout-a",
      source: "protocol" as const,
      label: "검증자 안정성",
      value: "유지",
      summary: "Validator stability held across the rollout window.",
      trust: 0.84,
      freshness: 0.9,
      digestScore: 0.8,
      capturedAt: createdAt,
    },
    {
      id: "dur-rollout-b",
      lane: "protocol" as const,
      nutrientId: "n-dur-rollout-b",
      source: "news" as const,
      label: "업그레이드 배포",
      value: "지연",
      summary: "Rollout logs lagged the initial release applause.",
      trust: 0.81,
      freshness: 0.88,
      digestScore: 0.76,
      capturedAt: createdAt,
    },
    {
      id: "dur-rollout-c",
      lane: "protocol" as const,
      nutrientId: "n-dur-rollout-c",
      source: "news" as const,
      label: "복구 속도",
      value: "둔화",
      summary: "Recovery speed slowed after the celebratory release narrative.",
      trust: 0.8,
      freshness: 0.87,
      digestScore: 0.74,
      capturedAt: createdAt,
    },
  ];

  const events = buildStructuralFallbackEventsFromEvidence(evidence, createdAt, 6).filter((event) => event.lane === "protocol");
  const families = new Set(events.map((item) => `${item.focusHint || "general"}:${item.sceneFamilyHint || "generic"}`));
  assert.ok([...families].some((family) => family.startsWith("durability:protocol:durability:rollout+validator")));
});

test("buildStructuralFallbackEventsFromEvidence keeps alternative court and liquidity scene families when evidence allows it", () => {
  const createdAt = new Date().toISOString();
  const evidence = [
    {
      id: "reg-court-a",
      lane: "regulation" as const,
      nutrientId: "n-reg-court-a",
      source: "news" as const,
      label: "법원 일정",
      value: "집중",
      summary: "Court calendar coverage dominated the cycle.",
      trust: 0.83,
      freshness: 0.91,
      digestScore: 0.75,
      capturedAt: createdAt,
    },
    {
      id: "reg-court-b",
      lane: "regulation" as const,
      nutrientId: "n-reg-court-b",
      source: "onchain" as const,
      label: "대기 자금 흐름",
      value: "관망",
      summary: "Waiting capital stayed cautious after the ruling hype.",
      trust: 0.82,
      freshness: 0.9,
      digestScore: 0.74,
      capturedAt: createdAt,
    },
    {
      id: "reg-court-c",
      lane: "regulation" as const,
      nutrientId: "n-reg-court-c",
      source: "news" as const,
      label: "집행 흔적",
      value: "지연",
      summary: "Actual enforcement traces lagged behind the court narrative.",
      trust: 0.8,
      freshness: 0.88,
      digestScore: 0.72,
      capturedAt: createdAt,
    },
    {
      id: "market-liquidity-a",
      lane: "market-structure" as const,
      nutrientId: "n-market-liquidity-a",
      source: "onchain" as const,
      label: "큰 주문 소화",
      value: "둔화",
      summary: "Large order absorption slowed beneath the heat.",
      trust: 0.84,
      freshness: 0.92,
      digestScore: 0.77,
      capturedAt: createdAt,
    },
    {
      id: "market-liquidity-b",
      lane: "market-structure" as const,
      nutrientId: "n-market-liquidity-b",
      source: "market" as const,
      label: "자금 쏠림 방향",
      value: "분산",
      summary: "Capital concentration stayed scattered.",
      trust: 0.82,
      freshness: 0.9,
      digestScore: 0.75,
      capturedAt: createdAt,
    },
    {
      id: "market-liquidity-c",
      lane: "market-structure" as const,
      nutrientId: "n-market-liquidity-c",
      source: "market" as const,
      label: "호가 두께",
      value: "약화",
      summary: "Orderbook depth thinned despite louder reaction.",
      trust: 0.81,
      freshness: 0.89,
      digestScore: 0.73,
      capturedAt: createdAt,
    },
    {
      id: "market-liquidity-d",
      lane: "market-structure" as const,
      nutrientId: "n-market-liquidity-d",
      source: "market" as const,
      label: "현물 체결",
      value: "지연",
      summary: "Spot settlement stayed slow as heat expanded.",
      trust: 0.82,
      freshness: 0.9,
      digestScore: 0.74,
      capturedAt: createdAt,
    },
  ];

  const events = buildStructuralFallbackEventsFromEvidence(evidence, createdAt, 8);
  const families = new Set(
    events
      .map((item) => `${item.lane}:${item.focusHint || "general"}:${item.sceneFamilyHint || "generic"}`)
      .filter(Boolean)
  );

  assert.ok([...families].some((family) => family.startsWith("regulation:court:capital+court")));
  assert.ok([...families].some((family) => family.startsWith("regulation:court:court+execution")));
  assert.ok([...families].some((family) => family.startsWith("regulation:court:capital+execution")));
  assert.ok(
    [...families].some((family) => family.startsWith("market-structure:liquidity:capital+depth")) ||
      [...families].some((family) => family.startsWith("market-structure:settlement:depth+settlement")) ||
      [...families].some((family) => family.startsWith("market-structure:settlement:execution+settlement"))
  );
});

test("buildStructuralFallbackEventsFromEvidence emits launch capital and retention wallet families when evidence allows it", () => {
  const createdAt = new Date().toISOString();
  const evidence = [
    {
      id: "launch-a",
      lane: "protocol" as const,
      nutrientId: "n-launch-a",
      source: "news" as const,
      label: "메인넷 준비도",
      value: "상승",
      summary: "Mainnet readiness climbed into the release window.",
      trust: 0.82,
      freshness: 0.9,
      digestScore: 0.78,
      capturedAt: createdAt,
    },
    {
      id: "launch-b",
      lane: "protocol" as const,
      nutrientId: "n-launch-b",
      source: "market" as const,
      label: "복귀 자금",
      value: "지연",
      summary: "Returning capital lagged the launch narrative.",
      trust: 0.8,
      freshness: 0.88,
      digestScore: 0.75,
      capturedAt: createdAt,
    },
    {
      id: "retention-a",
      lane: "ecosystem" as const,
      nutrientId: "n-retention-a",
      source: "onchain" as const,
      label: "지갑 재방문",
      value: "확대",
      summary: "Wallet return kept showing up after the initial burst.",
      trust: 0.81,
      freshness: 0.9,
      digestScore: 0.76,
      capturedAt: createdAt,
    },
    {
      id: "retention-b",
      lane: "ecosystem" as const,
      nutrientId: "n-retention-b",
      source: "news" as const,
      label: "사용자 재방문 흐름",
      value: "확대",
      summary: "Returning users kept showing up after the headline cycle cooled.",
      trust: 0.8,
      freshness: 0.89,
      digestScore: 0.75,
      capturedAt: createdAt,
    },
  ];

  const events = buildStructuralFallbackEventsFromEvidence(evidence, createdAt, 8);
  const families = new Set(
    events
      .map((item) => `${item.lane}:${item.focusHint || "general"}:${item.sceneFamilyHint || "generic"}`)
      .filter(Boolean)
  );

  assert.ok(
    [...families].some((family) => family.startsWith("protocol:launch:capital+launch")) ||
      [...families].some((family) => family.startsWith("protocol:launch:return+launch")) ||
      [...families].some((family) => family.startsWith("protocol:launch:launch+showcase"))
  );
  assert.ok(
    [...families].some((family) => family.startsWith("ecosystem:retention:cohort+wallet")) ||
      [...families].some((family) => family.startsWith("ecosystem:retention:wallet+retention")) ||
      [...families].some((family) => family.startsWith("ecosystem:retention:retention+cohort"))
  );
  assert.ok(![...families].some((family) => family.startsWith("ecosystem:retention:return+wallet")));
});

test("buildStructuralFallbackEventsFromEvidence can split launch and settlement families into sharper bases", () => {
  const createdAt = new Date().toISOString();
  const evidence = [
    {
      id: "launch-a",
      lane: "protocol" as const,
      nutrientId: "n-launch-a",
      source: "news" as const,
      label: "메인넷 준비도",
      value: "상승",
      summary: "쇼케이스는 뜨거운데 실제 복귀는 아직 객석에 남은 장면",
      trust: 0.82,
      freshness: 0.9,
      digestScore: 0.78,
      capturedAt: createdAt,
    },
    {
      id: "launch-b",
      lane: "protocol" as const,
      nutrientId: "n-launch-b",
      source: "market" as const,
      label: "복귀 자금",
      value: "지연",
      summary: "Returning capital lagged the launch narrative.",
      trust: 0.8,
      freshness: 0.88,
      digestScore: 0.75,
      capturedAt: createdAt,
    },
    {
      id: "settle-a",
      lane: "market-structure" as const,
      nutrientId: "n-settle-a",
      source: "market" as const,
      label: "현물 체결",
      value: "재가동",
      summary: "현물 체결은 남는데 깊이는 아직 얕은 장면",
      trust: 0.83,
      freshness: 0.9,
      digestScore: 0.76,
      capturedAt: createdAt,
    },
    {
      id: "settle-b",
      lane: "market-structure" as const,
      nutrientId: "n-settle-b",
      source: "market" as const,
      label: "호가 두께",
      value: "식음",
      summary: "Orderbook depth stayed thin after the first move.",
      trust: 0.82,
      freshness: 0.89,
      digestScore: 0.75,
      capturedAt: createdAt,
    },
  ];

  const events = buildStructuralFallbackEventsFromEvidence(evidence, createdAt, 8);
  const families = new Set(
    events
      .map((item) => `${item.lane}:${item.focusHint || "general"}:${item.sceneFamilyHint || "generic"}`)
      .filter(Boolean)
  );

  assert.ok(
    [...families].some((family) => family.startsWith("protocol:launch:launch+showcase")) ||
      [...families].some((family) => family.startsWith("protocol:launch:return+announcement")) ||
      [...families].some((family) => family.startsWith("protocol:launch:return+showcase")) ||
      [...families].some((family) => family.startsWith("protocol:launch:return+launch"))
  );
  assert.ok(
    [...families].some((family) => family.startsWith("market-structure:settlement:execution+depth")) ||
      [...families].some((family) => family.startsWith("market-structure:settlement:volume+depth")) ||
      [...families].some((family) => family.startsWith("market-structure:settlement:depth+heat"))
  );
});

test("buildStructuralFallbackEventsFromEvidence can surface court-order and durability-ops families", () => {
  const createdAt = new Date().toISOString();
  const evidence = [
    {
      id: "court-order-a",
      lane: "regulation" as const,
      nutrientId: "n-court-order-a",
      source: "market" as const,
      label: "ETF 대기 주문",
      value: "지연",
      summary: "ETF bid placement still lagged the court narrative.",
      trust: 0.79,
      freshness: 0.88,
      digestScore: 0.74,
      capturedAt: createdAt,
    },
    {
      id: "court-order-b",
      lane: "regulation" as const,
      nutrientId: "n-court-order-b",
      source: "news" as const,
      label: "법원 일정",
      value: "집중",
      summary: "Court scheduling dominated coverage despite thinner real demand.",
      trust: 0.81,
      freshness: 0.89,
      digestScore: 0.76,
      capturedAt: createdAt,
    },
    {
      id: "durability-ops-a",
      lane: "protocol" as const,
      nutrientId: "n-durability-ops-a",
      source: "market" as const,
      label: "운영 로그",
      value: "지연",
      summary: "Operational logs arrived later than the recovery narrative.",
      trust: 0.8,
      freshness: 0.88,
      digestScore: 0.75,
      capturedAt: createdAt,
    },
    {
      id: "durability-ops-b",
      lane: "protocol" as const,
      nutrientId: "n-durability-ops-b",
      source: "news" as const,
      label: "복구 속도",
      value: "둔화",
      summary: "Recovery speed slowed beneath the operator applause.",
      trust: 0.8,
      freshness: 0.87,
      digestScore: 0.74,
      capturedAt: createdAt,
    },
    {
      id: "durability-ops-c",
      lane: "protocol" as const,
      nutrientId: "n-durability-ops-c",
      source: "onchain" as const,
      label: "검증자 안정성",
      value: "유지",
      summary: "Validator stability held despite the lagging ops record.",
      trust: 0.81,
      freshness: 0.88,
      digestScore: 0.75,
      capturedAt: createdAt,
    },
  ];

  const events = buildStructuralFallbackEventsFromEvidence(evidence, createdAt, 10);
  const families = new Set(
    events
      .map((item) => `${item.lane}:${item.focusHint || "general"}:${item.sceneFamilyHint || "generic"}`)
      .filter(Boolean)
  );

  assert.ok(
    [...families].some((family) => family.startsWith("regulation:court:order+capital")) ||
      [...families].some((family) => family.startsWith("regulation:court:capital+execution"))
  );
  assert.ok(
    [...families].some((family) => family.startsWith("protocol:durability:ops+recovery")) ||
      [...families].some((family) => family.startsWith("protocol:durability:ops+validator")) ||
      [...families].some((family) => family.startsWith("protocol:durability:repair+ops"))
  );
});

test("buildStructuralFallbackEventsFromEvidence can split retention and launch families with headline cues", () => {
  const createdAt = new Date().toISOString();
  const evidence = [
    {
      id: "retention-scene-a",
      lane: "ecosystem" as const,
      nutrientId: "n-retention-scene-a",
      source: "onchain" as const,
      label: "지갑 재방문",
      value: "확대",
      summary: "지갑은 돌아오는데 다음 날 사람 수는 얇아진 장면",
      trust: 0.81,
      freshness: 0.9,
      digestScore: 0.76,
      capturedAt: createdAt,
    },
    {
      id: "retention-scene-b",
      lane: "ecosystem" as const,
      nutrientId: "n-retention-scene-b",
      source: "news" as const,
      label: "사용자 재방문 흐름",
      value: "둔화",
      summary: "Returning users kept thinning after the headline cycle cooled.",
      trust: 0.8,
      freshness: 0.89,
      digestScore: 0.75,
      capturedAt: createdAt,
    },
    {
      id: "launch-scene-a",
      lane: "protocol" as const,
      nutrientId: "n-launch-scene-a",
      source: "news" as const,
      label: "메인넷 준비도",
      value: "상승",
      summary: "메인넷 발표는 컸지만 뉴스 열기가 먼저 돈 장면",
      trust: 0.82,
      freshness: 0.9,
      digestScore: 0.78,
      capturedAt: createdAt,
    },
    {
      id: "launch-scene-b",
      lane: "protocol" as const,
      nutrientId: "n-launch-scene-b",
      source: "market" as const,
      label: "복귀 자금",
      value: "지연",
      summary: "Returning capital stayed cautious after the announcement.",
      trust: 0.8,
      freshness: 0.88,
      digestScore: 0.75,
      capturedAt: createdAt,
    },
  ];

  const events = buildStructuralFallbackEventsFromEvidence(evidence, createdAt, 8);
  const families = new Set(
    events
      .map((item) => `${item.lane}:${item.focusHint || "general"}:${item.sceneFamilyHint || "generic"}`)
      .filter(Boolean)
  );

  assert.ok(
    [...families].some((family) => family.startsWith("ecosystem:retention:retention+cohort")) ||
      [...families].some((family) => family.startsWith("ecosystem:retention:wallet+retention"))
  );
  assert.ok(
    [...families].some((family) => family.startsWith("protocol:launch:return+announcement")) ||
      [...families].some((family) => family.startsWith("protocol:launch:return+launch"))
  );
});

test("buildStructuralFallbackEventsFromEvidence prefers execution/depth facets over generic heat base", () => {
  const createdAt = new Date().toISOString();
  const evidence = [
    {
      id: "settle-heat-a",
      lane: "market-structure" as const,
      nutrientId: "n-settle-heat-a",
      source: "market" as const,
      label: "현물 체결",
      value: "재가동",
      summary: "분위기는 뜨거운데 실제 체결은 남는 장면",
      trust: 0.83,
      freshness: 0.9,
      digestScore: 0.76,
      capturedAt: createdAt,
    },
    {
      id: "settle-heat-b",
      lane: "market-structure" as const,
      nutrientId: "n-settle-heat-b",
      source: "market" as const,
      label: "호가 두께",
      value: "약화",
      summary: "화면은 과열됐지만 호가 두께는 얕아진 상태",
      trust: 0.82,
      freshness: 0.89,
      digestScore: 0.75,
      capturedAt: createdAt,
    },
  ];

  const events = buildStructuralFallbackEventsFromEvidence(evidence, createdAt, 8);
  const families = new Set(
    events
      .map((item) => `${item.lane}:${item.focusHint || "general"}:${item.sceneFamilyHint || "generic"}`)
      .filter(Boolean)
  );

  assert.ok([...families].some((family) => family.startsWith("market-structure:settlement:execution+depth")));
  assert.ok(![...families].some((family) => family.startsWith("market-structure:settlement:heat")));
});

test("planEventEvidenceAct prefers builder ecosystem pair over generic community pair", () => {
  const createdAt = new Date().toISOString();
  const plan = planEventEvidenceAct({
    events: [
      {
        id: "event:ecosystem:builder",
        lane: "ecosystem",
        headline: "생태계 기세가 실제 구조로 남는지 본다",
        summary: "개발 기세와 예치 자금이 함께 남는지 본다.",
        source: "news:coindesk-rss",
        trust: 0.76,
        freshness: 0.9,
        capturedAt: createdAt,
        keywords: ["생태계", "개발", "예치"],
      },
    ],
    evidence: buildOnchainEvidence([
      {
      id: "n1",
      source: "news",
      category: "ecosystem",
      label: "개발자 커뮤니티 반응",
      value: "증가",
      evidence: "Developer participation kept climbing across consumer apps.",
        trust: 0.83,
        freshness: 0.92,
        capturedAt: createdAt,
        metadata: { digestScore: 0.8 },
      },
      {
        id: "n2",
        source: "onchain",
        category: "tvl",
        label: "TVL 유입",
        value: "+$180M",
        evidence: "Locked capital returned as builders kept shipping.",
        trust: 0.82,
        freshness: 0.91,
        capturedAt: createdAt,
        metadata: { digestScore: 0.79 },
      },
      {
        id: "n3",
        source: "news",
        category: "ecosystem",
        label: "커뮤니티 반응",
        value: "과열",
        evidence: "Community chatter grew faster than actual onchain follow-through.",
        trust: 0.8,
        freshness: 0.9,
        capturedAt: createdAt,
        metadata: { digestScore: 0.7 },
      },
    ]),
    recentPosts: [],
    requireOnchainEvidence: true,
    requireCrossSourceEvidence: true,
  });

  assert.ok(plan);
  const labels = plan?.evidence.map((item) => item.label) || [];
  assert.ok(labels.includes("개발자 잔류"));
  assert.ok(labels.includes("예치 자금 복귀"));
  assert.equal(labels.includes("커뮤니티 반응"), false);
});

test("planEventEvidenceAct rejects generic ecosystem bridge pair when sharper builder pair exists", () => {
  const createdAt = new Date().toISOString();
  const plan = planEventEvidenceAct({
    events: [
      {
        id: "event:ecosystem:builder",
        lane: "ecosystem",
        headline: "개발자 잔류와 자금 복귀가 같이 남는 쪽을 본다",
        summary: "생태계가 기사보다 구조로 남는지 가르는 장면이다.",
        source: "news:rss",
        trust: 0.81,
        freshness: 0.92,
        capturedAt: createdAt,
        keywords: ["builder", "developer", "capital"],
      },
    ],
    evidence: buildOnchainEvidence([
      {
        id: "n1",
        source: "news",
        category: "ecosystem",
        label: "커뮤니티 반응",
        value: "확대",
        evidence: "Community reaction expanded before durable usage showed up.",
        trust: 0.79,
        freshness: 0.9,
        capturedAt: createdAt,
        metadata: { digestScore: 0.72 },
      },
      {
        id: "n2",
        source: "onchain",
        category: "usage",
        label: "체인 안쪽 사용",
        value: "확대",
        evidence: "Usage expanded, but the label is still generic and weak.",
        trust: 0.8,
        freshness: 0.9,
        capturedAt: createdAt,
        metadata: { digestScore: 0.73 },
      },
      {
        id: "n3",
        source: "news",
        category: "ecosystem",
        label: "개발자 잔류",
        value: "유지",
        evidence: "Core builders stayed active after the initial narrative wave.",
        trust: 0.84,
        freshness: 0.94,
        capturedAt: createdAt,
        metadata: { digestScore: 0.81 },
      },
      {
        id: "n4",
        source: "onchain",
        category: "tvl",
        label: "예치 자금 복귀",
        value: "복귀",
        evidence: "Deposited capital returned alongside continued builder activity.",
        trust: 0.85,
        freshness: 0.95,
        capturedAt: createdAt,
        metadata: { digestScore: 0.82 },
      },
    ]),
    recentPosts: [],
    requireOnchainEvidence: true,
    requireCrossSourceEvidence: true,
  });

  assert.ok(plan);
  const labels = plan?.evidence.map((item) => item.label) || [];
  assert.deepEqual(labels, ["개발자 잔류", "예치 자금 복귀"]);
});

test("planEventEvidenceAct rejects cross-source-missing onchain structural fallback when cross-source is required", () => {
  const createdAt = new Date().toISOString();
  const plan = planEventEvidenceAct({
    events: [
      {
        id: "event:fallback:onchain:fees:mempool",
        lane: "onchain",
        headline: "체인 위가 실제로 붐비는지와 대기 거래가 얼마나 쌓이는지가 같은 방향으로 붙는지부터 가린다",
        summary: "가격 스냅샷보다 체인 혼잡 신호를 먼저 확인한다.",
        source: "evidence:structural-fallback",
        trust: 0.78,
        freshness: 0.9,
        capturedAt: createdAt,
        keywords: ["수수료", "멤풀"],
      },
    ],
    evidence: buildOnchainEvidence([
      {
        id: "n1",
        source: "onchain",
        category: "network-fee",
        label: "BTC 네트워크 수수료",
        value: "1 sat/vB",
        evidence: "BTC network fees stayed low near 1 sat/vB",
        trust: 0.83,
        freshness: 0.94,
        capturedAt: createdAt,
        metadata: { digestScore: 0.8 },
      },
      {
        id: "n2",
        source: "onchain",
        category: "mempool",
        label: "BTC 멤풀 대기열",
        value: "38,000 tx",
        evidence: "Mempool backlog stayed near 38k transactions",
        trust: 0.81,
        freshness: 0.92,
        capturedAt: createdAt,
        metadata: { digestScore: 0.78 },
      },
      {
        id: "n3",
        source: "market",
        category: "price-action",
        label: "ETH 24h 변동",
        value: "+4.3%",
        evidence: "ETH moved 4.3% over 24 hours",
        trust: 0.72,
        freshness: 0.9,
        capturedAt: createdAt,
        metadata: { digestScore: 0.64 },
      },
    ]),
    recentPosts: [],
    requireOnchainEvidence: true,
    requireCrossSourceEvidence: true,
  });

  assert.equal(plan, null);
});

test("planEventEvidenceAct keeps generic onchain event on non-price evidence pair", () => {
  const createdAt = new Date().toISOString();
  const plan = planEventEvidenceAct({
    events: [
      {
        id: "event:onchain:1",
        lane: "onchain",
        headline: "체인 위에서 먼저 달라지는 흔적이 어디인지 짚는다",
        summary: "온체인 흐름을 가격보다 먼저 확인한다.",
        source: "news:coindesk-rss",
        trust: 0.74,
        freshness: 0.88,
        capturedAt: createdAt,
        keywords: ["온체인", "흐름"],
      },
    ],
    evidence: buildOnchainEvidence([
      {
        id: "n1",
        source: "onchain",
        category: "network-fee",
        label: "BTC 네트워크 수수료",
        value: "1 sat/vB",
        evidence: "BTC network fees stayed low near 1 sat/vB",
        trust: 0.83,
        freshness: 0.94,
        capturedAt: createdAt,
        metadata: { digestScore: 0.8 },
      },
      {
        id: "n2",
        source: "onchain",
        category: "mempool",
        label: "BTC 멤풀 대기열",
        value: "38,000 tx",
        evidence: "Mempool backlog stayed near 38k transactions",
        trust: 0.81,
        freshness: 0.92,
        capturedAt: createdAt,
        metadata: { digestScore: 0.78 },
      },
      {
        id: "n3",
        source: "market",
        category: "price-action",
        label: "BTC 24h 변동",
        value: "+0.41%",
        evidence: "BTC moved 0.41% over 24 hours",
        trust: 0.72,
        freshness: 0.9,
        capturedAt: createdAt,
        metadata: { digestScore: 0.64 },
      },
    ]),
    recentPosts: [],
    requireOnchainEvidence: true,
    requireCrossSourceEvidence: true,
  });

  assert.ok(plan);
  assert.deepEqual(
    [...(plan?.evidence.map((item) => item.label) || [])].sort(),
    ["낮아진 체인 사용 압박", "풀리는 밀린 거래 압박"].sort()
  );
  assert.equal(plan?.focus, "durability");
  assert.ok(!plan?.plannerWarnings?.includes("focus-general"));
});

test("planEventEvidenceAct promotes onchain usage and capital pair out of general focus", () => {
  const createdAt = new Date().toISOString();
  const plan = planEventEvidenceAct({
    events: [
      {
        id: "event:onchain:capital-usage",
        lane: "onchain",
        headline: "체인 안쪽 사용과 대기 자금이 같이 움직이는지 짚는다",
        summary: "온체인 사용 압박과 관망 자금 유입을 같이 본다.",
        source: "news:coindesk-rss",
        trust: 0.76,
        freshness: 0.89,
        capturedAt: createdAt,
        keywords: ["온체인", "자금"],
      },
    ],
    evidence: buildOnchainEvidence([
      {
        id: "n1",
        source: "onchain",
        category: "network-fee",
        label: "BTC 네트워크 수수료",
        value: "4 sat/vB",
        evidence: "BTC network fees stayed subdued near 4 sat/vB",
        trust: 0.82,
        freshness: 0.93,
        capturedAt: createdAt,
        metadata: { digestScore: 0.79 },
      },
      {
        id: "n2",
        source: "onchain",
        category: "stable-supply",
        label: "스테이블코인 총공급",
        value: "+$210M",
        evidence: "Stablecoin supply expanded by $210M over the last day.",
        trust: 0.84,
        freshness: 0.94,
        capturedAt: createdAt,
        metadata: { digestScore: 0.81 },
      },
      {
        id: "n3",
        source: "market",
        category: "price-action",
        label: "BTC 24h 변동",
        value: "+0.8%",
        evidence: "BTC moved 0.8% over 24 hours",
        trust: 0.72,
        freshness: 0.88,
        capturedAt: createdAt,
        metadata: { digestScore: 0.63 },
      },
    ]),
    recentPosts: [],
    requireOnchainEvidence: true,
    requireCrossSourceEvidence: true,
  });

  assert.ok(plan);
  assert.deepEqual(
    [...(plan?.evidence.map((item) => item.label) || [])].sort(),
    ["낮아진 체인 사용 압박", "관망 자금 유입"].sort()
  );
  assert.equal(plan?.focus, "durability");
  assert.ok(!plan?.plannerWarnings?.includes("focus-general"));
});

test("planEventEvidenceAct avoids price-like evidence for ecosystem lane when structural pair exists", () => {
  const createdAt = new Date().toISOString();
  const plan = planEventEvidenceAct({
    events: [
      {
        id: "event:ecosystem:1",
        lane: "ecosystem",
        headline: "생태계가 살아 있다는 말이 정말 사용 흔적으로 이어지는지 확인한다",
        summary: "사용성 변화와 참여 흐름을 구조적으로 본다.",
        source: "news:coindesk-rss",
        trust: 0.72,
        freshness: 0.88,
        capturedAt: createdAt,
        keywords: ["생태계", "사용"],
      },
    ],
    evidence: buildOnchainEvidence([
      {
        id: "n1",
        source: "onchain",
        category: "whale-flow",
        label: "고래/대형주소 활동 프록시",
        value: "+12%",
        evidence: "Large-holder activity picked up across major wallets.",
        trust: 0.84,
        freshness: 0.93,
        capturedAt: createdAt,
        metadata: { digestScore: 0.8 },
      },
      {
        id: "n2",
        source: "news",
        category: "ecosystem",
        label: "개발자 커뮤니티 반응",
        value: "증가",
        evidence: "Developer chatter rose around the ecosystem update.",
        trust: 0.8,
        freshness: 0.91,
        capturedAt: createdAt,
        metadata: { digestScore: 0.76 },
      },
      {
        id: "n3",
        source: "market",
        category: "price-action",
        label: "ETH 24h 변동",
        value: "-0.64%",
        evidence: "ETH moved lower over the last 24 hours.",
        trust: 0.74,
        freshness: 0.9,
        capturedAt: createdAt,
        metadata: { digestScore: 0.63 },
      },
    ]),
    recentPosts: [],
    requireOnchainEvidence: true,
    requireCrossSourceEvidence: true,
  });

  assert.ok(plan);
  const labels = plan?.evidence.map((item) => item.label) || [];
  assert.equal(labels.includes("ETH 24h 변동"), false);
  assert.equal(labels.includes("개발자 잔류") || labels.includes("실사용 잔류"), true);
  assert.equal(labels.includes("큰손 움직임 확대") || labels.includes("큰손 움직임 둔화") || labels.includes("큰손 움직임 정체"), true);
});

test("planEventEvidenceAct avoids generic market reaction plus fee pair when lane-specific regulation evidence exists", () => {
  const createdAt = new Date().toISOString();
  const plan = planEventEvidenceAct({
    events: [
      {
        id: "event:regulation:1",
        lane: "regulation",
        headline: "규제 뉴스 뒤 실제 반응이 갈리는지 본다",
        summary: "정책 발표 뒤 집행과 사용자 반응이 어떻게 갈리는지 본다.",
        source: "news:coindesk-rss",
        trust: 0.74,
        freshness: 0.9,
        capturedAt: createdAt,
        keywords: ["규제", "정책", "집행"],
      },
    ],
    evidence: buildOnchainEvidence([
      {
        id: "n1",
        source: "news",
        category: "regulation",
        label: "규제 쪽 실제 움직임",
        value: "포착",
        evidence: "Regulatory response started to diverge across venues.",
        trust: 0.82,
        freshness: 0.92,
        capturedAt: createdAt,
        metadata: { digestScore: 0.8 },
      },
      {
        id: "n2",
        source: "onchain",
        category: "stable-flow",
        label: "스테이블코인 총공급 플로우",
        value: "+$180M",
        evidence: "Stablecoin supply expanded across major chains.",
        trust: 0.81,
        freshness: 0.91,
        capturedAt: createdAt,
        metadata: { digestScore: 0.77 },
      },
      {
        id: "n3",
        source: "market",
        category: "price-action",
        label: "시장 반응",
        value: "과열 가능성",
        evidence: "Price reacted faster than follow-through volume.",
        trust: 0.75,
        freshness: 0.89,
        capturedAt: createdAt,
        metadata: { digestScore: 0.65 },
      },
      {
        id: "n4",
        source: "onchain",
        category: "network-fee",
        label: "BTC 네트워크 수수료",
        value: "2 sat/vB",
        evidence: "BTC network fees stayed near 2 sat/vB.",
        trust: 0.8,
        freshness: 0.9,
        capturedAt: createdAt,
        metadata: { digestScore: 0.74 },
      },
    ]),
    recentPosts: [],
    requireOnchainEvidence: true,
    requireCrossSourceEvidence: true,
  });

  assert.ok(plan);
  const labels = plan?.evidence.map((item) => item.label) || [];
  assert.equal(labels.includes("규제 집행 일정") || labels.includes("당국 공조 신호"), true);
  assert.equal(labels.includes("먼저 달아오른 가격 분위기") && labels.includes("BTC 네트워크 수수료"), false);
});

test("planEventEvidenceAct rejects market-structure lane when evidence is only generic mood plus fee", () => {
  const createdAt = new Date().toISOString();
  const plan = planEventEvidenceAct({
    events: [
      {
        id: "event:market-structure:1",
        lane: "market-structure",
        headline: "가격보다 실제 주문이 받쳐주는지 본다",
        summary: "시장 분위기와 주문 흐름이 어긋나는지 본다.",
        source: "news:coindesk-rss",
        trust: 0.71,
        freshness: 0.9,
        capturedAt: createdAt,
        keywords: ["주문", "체결"],
      },
      {
        id: "event:ecosystem:1",
        lane: "ecosystem",
        headline: "사람들이 실제로 머무는 체인과 밖에서 도는 서사가 맞물리는지 살핀다",
        summary: "실사용과 서사가 같은 방향인지 본다.",
        source: "news:coindesk-rss",
        trust: 0.72,
        freshness: 0.9,
        capturedAt: createdAt,
        keywords: ["실사용", "체인"],
      },
    ],
    evidence: buildOnchainEvidence([
      {
        id: "n1",
        source: "market",
        category: "price-action",
        label: "시장 반응",
        value: "과열 가능성",
        evidence: "Price reacted faster than follow-through volume.",
        trust: 0.73,
        freshness: 0.88,
        capturedAt: createdAt,
        metadata: { digestScore: 0.66 },
      },
      {
        id: "n2",
        source: "onchain",
        category: "network-fee",
        label: "BTC 네트워크 수수료",
        value: "6 sat/vB",
        evidence: "BTC network fees stayed near 6 sat/vB.",
        trust: 0.79,
        freshness: 0.9,
        capturedAt: createdAt,
        metadata: { digestScore: 0.74 },
      },
      {
        id: "n3",
        source: "news",
        category: "ecosystem",
        label: "실사용 실험",
        value: "확대",
        evidence: "Usage and wallet activity kept rising after the initial narrative burst.",
        trust: 0.8,
        freshness: 0.91,
        capturedAt: createdAt,
        metadata: { digestScore: 0.78 },
      },
    ]),
    recentPosts: [],
    requireOnchainEvidence: true,
    requireCrossSourceEvidence: true,
  });

  assert.ok(plan);
  assert.notEqual(plan?.lane, "market-structure");
  assert.equal(plan?.lane, "ecosystem");
});

test("planEventEvidenceAct rejects regulation lane when evidence collapses to generic regulation plus fee", () => {
  const createdAt = new Date().toISOString();
  const events = [
    {
      id: "event-reg",
      lane: "regulation" as const,
      headline: "SEC and CFTC policy update sharpens crypto compliance focus",
      summary: "Regulatory coordination discussion moved back into focus.",
      source: "news:rss",
      trust: 0.8,
      freshness: 0.9,
      capturedAt: createdAt,
      keywords: ["sec", "cftc", "policy"],
    },
    {
      id: "event-protocol",
      lane: "protocol" as const,
      headline: "Firedancer testnet milestone sharpens validator rollout path",
      summary: "Validator rollout and recovery design moved into focus.",
      source: "news:rss",
      trust: 0.78,
      freshness: 0.88,
      capturedAt: createdAt,
      keywords: ["firedancer", "validator", "upgrade"],
    },
  ];

  const evidence = [
    {
      id: "ev-reg-generic",
      lane: "regulation" as const,
      nutrientId: "n-reg",
      source: "news" as const,
      label: "규제 집행 일정",
      value: "",
      summary: "규제 해석보다 실제 집행 일정과 시장 반응의 간격을 볼 장면이다.",
      trust: 0.76,
      freshness: 0.88,
      capturedAt: createdAt,
      digestScore: 0.74,
    },
    {
      id: "ev-fee",
      lane: "onchain" as const,
      nutrientId: "n-fee",
      source: "onchain" as const,
      label: "검증자 참여율 변화",
      value: "유지",
      summary: "검증자 참여율이 업그레이드 직후에도 유지되는지 볼 장면이다.",
      trust: 0.81,
      freshness: 0.92,
      capturedAt: createdAt,
      digestScore: 0.77,
    },
    {
      id: "ev-protocol",
      lane: "protocol" as const,
      nutrientId: "n-protocol",
      source: "news" as const,
      label: "Firedancer 검증자 반응",
      value: "",
      summary: "검증자 쪽 기대가 실제 운영 반응으로 이어지는지 볼 장면이다.",
      trust: 0.79,
      freshness: 0.9,
      capturedAt: createdAt,
      digestScore: 0.75,
    },
  ];

  const plan = planEventEvidenceAct({
    events,
    evidence,
    recentPosts: [],
  });

  assert.ok(plan);
  assert.equal(plan?.event.id, "event-protocol");
});

test("buildStructuralFallbackEventsFromEvidence writes direct structural headlines instead of templated scene language", () => {
  const createdAt = new Date().toISOString();
  const evidence = [
    {
      id: "ev1",
      lane: "onchain" as const,
      nutrientId: "n1",
      source: "onchain" as const,
      label: "지갑 재방문",
      value: "",
      summary: "실사용 흔적이 초기 서사 뒤에도 남아 있는지 보는 단서다.",
      trust: 0.82,
      freshness: 0.91,
      capturedAt: createdAt,
      digestScore: 0.79,
    },
    {
      id: "ev2",
      lane: "ecosystem" as const,
      nutrientId: "n2",
      source: "news" as const,
      label: "사용자 재방문 흐름",
      value: "확대",
      summary: "서사 이후에도 다시 돌아오는 사용자가 실제로 늘었는지 보는 단서다.",
      trust: 0.8,
      freshness: 0.89,
      capturedAt: createdAt,
      digestScore: 0.77,
    },
  ];

  const events = buildStructuralFallbackEventsFromEvidence(evidence, createdAt, 2);
  assert.ok(events.length >= 1);
  const headline = events[0].headline;
  assert.match(headline, /갈린다|성립한다|얇아진다|오래 간다|못 간다|중요해진다/);
  assert.doesNotMatch(headline, /를 보면|뒤에|살핀다|짚는다|장면/);
});

test("buildEventEvidenceFallbackPost keeps korean fallback direct and free of raw fragments", () => {
  const createdAt = new Date().toISOString();
  const plan = {
    lane: "regulation" as const,
    event: {
      id: "event-reg",
      lane: "regulation" as const,
      headline: "SEC and CFTC policy update sharpens crypto compliance focus",
      summary: "Regulatory coordination discussion moved back into focus.",
      source: "news:rss",
      trust: 0.8,
      freshness: 0.9,
      capturedAt: createdAt,
      keywords: ["sec", "cftc", "policy"],
    },
    evidence: [
      {
        id: "ev-reg",
        lane: "regulation" as const,
        nutrientId: "n-reg",
        source: "news" as const,
        label: "규제 쪽 실제 움직임",
        value: "포착",
        summary: "규제 해석보다 실제 집행 반응을 먼저 봐야 하는 구간이다.",
        trust: 0.79,
        freshness: 0.88,
        capturedAt: createdAt,
      },
      {
        id: "ev-onchain",
        lane: "onchain" as const,
        nutrientId: "n-onchain",
        source: "onchain" as const,
        label: "스테이블코인 총공급 플로우",
        value: "+$180M",
        summary: "Stablecoin balances continued to expand across major venues.",
        trust: 0.81,
        freshness: 0.9,
        capturedAt: createdAt,
      },
    ],
    hasOnchainEvidence: true,
    hasCrossSourceEvidence: true,
    evidenceSourceDiversity: 2,
    focus: "general",
    plannerScore: 1,
    plannerWarnings: [],
    laneUsage: {
      totalPosts: 0,
      byLane: {
        protocol: 0,
        ecosystem: 0,
        regulation: 0,
        macro: 0,
        onchain: 0,
        "market-structure": 0,
      },
    },
    laneProjectedRatio: 0.1,
    laneQuotaLimited: false,
  };

  const text = buildEventEvidenceFallbackPost(plan, "ko", 220, "identity-journal");
  assert.doesNotMatch(text, /근거는|지금 보는 근거는|내가 먼저 확인할 건/);
  assert.match(text, /기사|반쪽|집행|현장/);
  assert.doesNotMatch(text, /오늘은 이 장면부터|시간차부터 잰다|같은 화면에 둔다|sat\/vB|SEC and CFTC/);
});

test("buildEventEvidenceFallbackPost rewrites korean 구간 headline into direct scene prose", () => {
  const createdAt = new Date().toISOString();
  const plan = {
    lane: "market-structure" as const,
    event: {
      id: "event-market-liquidity",
      lane: "market-structure" as const,
      headline: "호가 열기보다 체결이 늦게 남은 구간",
      summary: "Orderbook heat outruns actual settlement.",
      source: "evidence:structural-fallback",
      trust: 0.81,
      freshness: 0.9,
      capturedAt: createdAt,
      keywords: ["호가", "체결"],
    },
    evidence: [
      {
        id: "ev-liquidity",
        lane: "market-structure" as const,
        nutrientId: "n-liquidity",
        source: "onchain" as const,
        label: "큰 주문 소화",
        value: "둔화",
        summary: "큰 주문이 깔끔하게 소화되지 못하고 남는지 보는 단서다.",
        trust: 0.8,
        freshness: 0.89,
        capturedAt: createdAt,
      },
      {
        id: "ev-capital",
        lane: "market-structure" as const,
        nutrientId: "n-capital",
        source: "market" as const,
        label: "자금 쏠림 방향",
        value: "분산",
        summary: "자금이 끝까지 한쪽으로 붙는지 보는 단서다.",
        trust: 0.79,
        freshness: 0.88,
        capturedAt: createdAt,
      },
    ],
    hasOnchainEvidence: true,
    hasCrossSourceEvidence: true,
    evidenceSourceDiversity: 2,
    plannerScore: 0.64,
    plannerWarnings: ["structural-fallback"],
    laneUsage: {
      totalPosts: 0,
      byLane: {
        protocol: 0,
        ecosystem: 0,
        regulation: 0,
        macro: 0,
        onchain: 0,
        "market-structure": 0,
      },
    },
    laneProjectedRatio: 1,
    laneQuotaLimited: true,
  };

  const text = buildEventEvidenceFallbackPost(plan, "ko", 220, "philosophy-note");
  assert.doesNotMatch(text, /실제로 이어지는지 다시|말에서 끝나는지 행동으로 이어지는지 다시|다시\.$|구간은 결국|구간에선 늦게/);
  assert.match(text, /(얕다|빈칸이 먼저 드러난다|구조보다 연출 쪽이다|호가|체결)/);
});

test("planEventEvidenceAct surfaces planner focus and repeat warning for same lane thread family", () => {
  const createdAt = new Date().toISOString();
  const events = [
    {
      id: "event-builder",
      lane: "ecosystem" as const,
      headline: "개발자 잔류와 예치 자금 복귀가 같이 버티는지 본다",
      summary: "Builder momentum needs both returning developers and returning capital.",
      source: "evidence:structural-fallback",
      trust: 0.81,
      freshness: 0.9,
      capturedAt: createdAt,
      keywords: ["개발자", "예치", "복귀"],
    },
  ];
  const evidence = [
    {
      id: "ev-builder",
      lane: "ecosystem" as const,
      nutrientId: "n-builder",
      source: "news" as const,
      label: "개발자 잔류",
      value: "유지",
      summary: "빌드 열기가 지나도 개발자가 계속 남는지 보는 단서다.",
      trust: 0.82,
      freshness: 0.91,
      capturedAt: createdAt,
      digestScore: 0.8,
    },
    {
      id: "ev-settlement",
      lane: "market-structure" as const,
      nutrientId: "n-settlement",
      source: "onchain" as const,
      label: "예치 자금 복귀",
      value: "확대",
      summary: "행사가 끝난 뒤에도 자금이 다시 붙는지 보는 단서다.",
      trust: 0.79,
      freshness: 0.88,
      capturedAt: createdAt,
      digestScore: 0.77,
    },
  ];

  const plan = planEventEvidenceAct({
    events,
    evidence,
    recentPosts: [],
    recentNarrativeThreads: [
      {
        lane: "ecosystem",
        focus: "builder",
        sceneFamily: "ecosystem:builder:builder+settlement",
        headline: "직전에도 빌더 잔류를 물고 있었다",
      },
    ],
  });

  assert.ok(plan);
  assert.equal(plan?.focus, "builder");
  assert.match(String(plan?.plannerWarnings.join("|")), /focus-repeat|scene-repeat|structural-fallback/);
  assert.match(String(plan?.sceneFamily || ""), /^ecosystem:builder:/);
  assert.ok((plan?.plannerScore || 0) > 0);
});

test("planEventEvidenceAct avoids general focus when sharper builder pair exists", () => {
  const createdAt = new Date().toISOString();
  const events = [
    {
      id: "event-ecosystem",
      lane: "ecosystem" as const,
      headline: "생태계 서사가 실제 잔류로 이어지는지 본다",
      summary: "Retention and builder proof matter more than generic community heat.",
      source: "evidence:structural-fallback",
      trust: 0.8,
      freshness: 0.9,
      capturedAt: createdAt,
      keywords: ["생태계", "잔류"],
    },
  ];
  const evidence = [
    {
      id: "ev-builder",
      lane: "ecosystem" as const,
      nutrientId: "n-builder",
      source: "news" as const,
      label: "개발자 잔류",
      value: "유지",
      summary: "빌드 열기가 지나도 개발자가 계속 남는지 보는 단서다.",
      trust: 0.82,
      freshness: 0.91,
      capturedAt: createdAt,
      digestScore: 0.8,
    },
    {
      id: "ev-capital",
      lane: "market-structure" as const,
      nutrientId: "n-capital",
      source: "onchain" as const,
      label: "예치 자금 복귀",
      value: "확대",
      summary: "행사가 끝난 뒤에도 자금이 다시 붙는지 보는 단서다.",
      trust: 0.79,
      freshness: 0.88,
      capturedAt: createdAt,
      digestScore: 0.77,
    },
    {
      id: "ev-generic",
      lane: "ecosystem" as const,
      nutrientId: "n-generic",
      source: "news" as const,
      label: "커뮤니티 반응",
      value: "과열",
      summary: "커뮤니티 반응만 뜨거워진 구간이다.",
      trust: 0.68,
      freshness: 0.8,
      capturedAt: createdAt,
      digestScore: 0.55,
    },
  ];

  const plan = planEventEvidenceAct({
    events,
    evidence,
    recentPosts: [],
  });

  assert.ok(plan);
  assert.notEqual(plan?.focus, "general");
  assert.equal(plan?.focus, "builder");
});

test("planEventEvidenceAct rotates away from recently used builder scene family when another sharp family exists", () => {
  const createdAt = new Date().toISOString();
  const events = [
    {
      id: "event-ecosystem-builder",
      lane: "ecosystem" as const,
      headline: "개발자 잔류가 실제 사용으로 번지는지 본다",
      summary: "Builder momentum should survive beyond the first headline.",
      source: "evidence:structural-fallback",
      trust: 0.82,
      freshness: 0.91,
      capturedAt: createdAt,
      keywords: ["개발자", "실사용"],
    },
  ];
  const evidence = [
    {
      id: "ev-builder",
      lane: "ecosystem" as const,
      nutrientId: "n-builder",
      source: "news" as const,
      label: "개발자 잔류",
      value: "유지",
      summary: "행사가 지나도 개발자가 계속 남는지 보는 단서다.",
      trust: 0.84,
      freshness: 0.92,
      capturedAt: createdAt,
      digestScore: 0.82,
    },
    {
      id: "ev-capital",
      lane: "market-structure" as const,
      nutrientId: "n-capital",
      source: "onchain" as const,
      label: "예치 자금 복귀",
      value: "확대",
      summary: "행사가 끝난 뒤에도 자금이 다시 붙는지 보는 단서다.",
      trust: 0.82,
      freshness: 0.9,
      capturedAt: createdAt,
      digestScore: 0.8,
    },
    {
      id: "ev-usage",
      lane: "ecosystem" as const,
      nutrientId: "n-usage",
      source: "onchain" as const,
      label: "체인 안쪽 사용",
      value: "유지",
      summary: "실사용이 한 주 뒤에도 남는지 보는 단서다.",
      trust: 0.85,
      freshness: 0.93,
      capturedAt: createdAt,
      digestScore: 0.84,
    },
  ];

  const plan = planEventEvidenceAct({
    events,
    evidence,
    recentPosts: [],
    recentNarrativeThreads: [
      {
        lane: "ecosystem",
        focus: "builder",
        sceneFamily: "ecosystem:builder:builder+settlement",
        headline: "직전에는 개발자 잔류와 예치 자금 복귀를 같이 물고 있었다",
      },
    ],
  });

  assert.ok(plan);
  assert.equal(plan?.focus, "builder");
  assert.notEqual(plan?.sceneFamily, "ecosystem:builder:builder+settlement");
  assert.match(String(plan?.sceneFamily || ""), /^ecosystem:builder:/);
});

test("planEventEvidenceAct prefers explicit sharp launch event over structural fallback when both are available", () => {
  const createdAt = new Date().toISOString();
  const plan = planEventEvidenceAct({
    events: [
      {
        id: "launch-explicit",
        lane: "protocol" as const,
        headline: "메인넷 준비도는 오르는데 복귀 자금이 늦는 출시",
        summary: "Launch confidence rose while returning capital still lagged.",
        source: "analysis:sharp",
        trust: 0.86,
        freshness: 0.91,
        capturedAt: createdAt,
        keywords: ["메인넷", "복귀", "출시"],
      },
      {
        id: "launch-structural",
        lane: "protocol" as const,
        headline: "메인넷 발표보다 늦게 붙는 건 복귀 자금이다",
        summary: "Mainnet applause still outruns capital return.",
        source: "evidence:structural-fallback",
        trust: 0.82,
        freshness: 0.9,
        capturedAt: createdAt,
        keywords: ["메인넷", "복귀"],
        focusHint: "launch",
        sceneFamilyHint: "protocol:launch:capital+launch",
        evidenceLabelHints: ["메인넷 준비도", "복귀 자금"],
      },
    ],
    evidence: buildOnchainEvidence([
      {
        id: "launch-n1",
        source: "news",
        category: "protocol-news",
        label: "메인넷 준비도",
        value: "상승",
        evidence: "Mainnet readiness rose into the release window.",
        trust: 0.82,
        freshness: 0.9,
        capturedAt: createdAt,
        metadata: { digestScore: 0.78 },
      },
      {
        id: "launch-n2",
        source: "market",
        category: "capital-flow",
        label: "복귀 자금",
        value: "지연",
        evidence: "Returning capital still lagged the launch narrative.",
        trust: 0.8,
        freshness: 0.88,
        capturedAt: createdAt,
        metadata: { digestScore: 0.75 },
      },
      {
        id: "launch-n3",
        source: "news",
        category: "protocol-rollout",
        label: "업그레이드 배포 큐",
        value: "증가",
        evidence: "Deployment queue activity rose ahead of capital return.",
        trust: 0.78,
        freshness: 0.86,
        capturedAt: createdAt,
        metadata: { digestScore: 0.72 },
      },
    ]),
    recentPosts: [],
  });

  assert.ok(plan);
  assert.equal(plan?.event.id, "launch-explicit");
});

test("planEventEvidenceAct promotes explicit builder event over structural fallback when score gap is small", () => {
  const createdAt = new Date().toISOString();
  const events = [
    {
      id: "builder-explicit",
      lane: "ecosystem" as const,
      headline: "개발자 잔류는 남는데 예치 자금 복귀가 늦는 구간",
      summary: "Builder retention holds while capital return lags.",
      source: "analysis:sharp",
      trust: 0.82,
      freshness: 0.9,
      capturedAt: createdAt,
      keywords: ["개발자", "예치 자금", "복귀"],
    },
    {
      id: "builder-fallback",
      lane: "ecosystem" as const,
      headline: "코드는 남는데 자금이 안 돌아오면 그 생태계 얘기는 오래 못 간다",
      summary: "Code stays active while capital return stays thin.",
      source: "evidence:structural-fallback",
      trust: 0.8,
      freshness: 0.9,
      capturedAt: createdAt,
      keywords: ["개발자", "자금"],
      focusHint: "builder",
      sceneFamilyHint: "ecosystem:builder:builder+capital",
      evidenceLabelHints: ["개발자 잔류", "예치 자금 복귀"],
    } as any,
  ];

  const evidence = [
    {
      id: "builder-a",
      lane: "ecosystem" as const,
      nutrientId: "n:builder-a",
      source: "onchain" as const,
      label: "개발자 잔류",
      value: "유지",
      summary: "Developer retention stayed firm after the release cycle.",
      trust: 0.84,
      freshness: 0.92,
      digestScore: 0.8,
      capturedAt: createdAt,
    },
    {
      id: "builder-b",
      lane: "ecosystem" as const,
      nutrientId: "n:builder-b",
      source: "market" as const,
      label: "예치 자금 복귀",
      value: "지연",
      summary: "Deposited capital returned slower than expected.",
      trust: 0.8,
      freshness: 0.9,
      digestScore: 0.76,
      capturedAt: createdAt,
    },
    {
      id: "builder-c",
      lane: "ecosystem" as const,
      nutrientId: "n:builder-c",
      source: "news" as const,
      label: "빌더 업데이트",
      value: "지속",
      summary: "Builder update cadence stayed active.",
      trust: 0.76,
      freshness: 0.87,
      digestScore: 0.71,
      capturedAt: createdAt,
    },
  ];

  const plan = planEventEvidenceAct({
    events,
    evidence,
    recentPosts: [],
    identityPressure: {
      obsessionLine: "지금 픽시몬이 끝까지 붙드는 건 코드보다 자금 복귀다.",
      grudgeLine: "개발은 남는데 돈이 안 돌아오는 생태계 서사를 제일 싫어한다.",
      continuityLine: "지난번에도 개발자 잔류보다 예치 자금 복귀 쪽이 더 늦게 붙었다.",
    },
  });

  assert.ok(plan);
  assert.equal(plan?.event.id, "builder-explicit");
});

test("planEventEvidenceAct escapes concentrated structural scene bases in favor of explicit court events", () => {
  const createdAt = new Date().toISOString();
  const plan = planEventEvidenceAct({
    events: [
      {
        id: "court-explicit",
        lane: "regulation" as const,
        headline: "브리핑은 커졌는데 현장 집행은 아직 뒤에 남은 구간",
        summary: "Legal briefing grew louder while actual execution stayed behind it.",
        source: "analysis:sharp",
        trust: 0.84,
        freshness: 0.9,
        capturedAt: createdAt,
        keywords: ["브리핑", "집행", "법원"],
      },
      {
        id: "court-fallback",
        lane: "regulation" as const,
        headline: "브리핑은 큰데 집행은 늦는 구간",
        summary: "Briefing stays large while execution lags.",
        source: "evidence:structural-fallback",
        trust: 0.82,
        freshness: 0.89,
        capturedAt: createdAt,
        keywords: ["브리핑", "집행"],
        focusHint: "court",
        sceneFamilyHint: "regulation:court:briefing+execution",
        evidenceLabelHints: ["법원 일정", "집행 흔적"],
      } as any,
    ],
    evidence: [
      {
        id: "court-a",
        lane: "regulation" as const,
        nutrientId: "n:court-a",
        source: "news" as const,
        label: "법원 일정",
        value: "집중",
        summary: "Court calendar coverage dominated the cycle.",
        trust: 0.83,
        freshness: 0.9,
        digestScore: 0.79,
        capturedAt: createdAt,
      },
      {
        id: "court-b",
        lane: "regulation" as const,
        nutrientId: "n:court-b",
        source: "news" as const,
        label: "집행 흔적",
        value: "지연",
        summary: "Execution traces stayed behind the legal narrative.",
        trust: 0.82,
        freshness: 0.88,
        digestScore: 0.77,
        capturedAt: createdAt,
      },
      {
        id: "court-c",
        lane: "regulation" as const,
        nutrientId: "n:court-c",
        source: "onchain" as const,
        label: "대기 자금 흐름",
        value: "관망",
        summary: "Waiting capital stayed cautious despite the briefing tone.",
        trust: 0.79,
        freshness: 0.86,
        digestScore: 0.74,
        capturedAt: createdAt,
      },
    ],
    recentPosts: [],
    recentNarrativeThreads: [
      {
        lane: "regulation",
        focus: "court",
        sceneFamily: "regulation:court:briefing+execution",
        headline: "직전에도 브리핑과 집행의 빈칸을 물고 있었다",
      },
      {
        lane: "regulation",
        focus: "court",
        sceneFamily: "regulation:court:briefing+execution:execution-lag:briefing-gap",
        headline: "브리핑 톤보다 집행 빈칸이 크게 남았다",
      },
    ],
    identityPressure: {
      obsessionLine: "지금 픽시몬이 끝까지 붙드는 건 기사보다 집행 흔적이다.",
      grudgeLine: "집행은 없는데 기사만 큰 규제 해설을 제일 싫어한다.",
      continuityLine: "지난번에도 브리핑보다 집행 빈칸이 더 크게 남았다.",
    },
  });

  assert.ok(plan);
  assert.equal(plan?.event.id, "court-explicit");
});

test("buildEventEvidenceFallbackPost avoids analytic generic loop phrasing for korean synthetic headline", () => {
  const createdAt = new Date().toISOString();
  const text = buildEventEvidenceFallbackPost(
    {
      lane: "market-structure",
      focus: "settlement",
      event: {
        id: "generic-loop",
        lane: "market-structure",
        headline: "체결은 남는데 깊이가 대답을 미루는 장면이 실제로 이어지는지 다시 본다",
        summary: "Settlement stays loud while depth remains thin.",
        source: "analysis:sharp",
        trust: 0.82,
        freshness: 0.9,
        capturedAt: createdAt,
        keywords: ["체결", "깊이"],
      },
      evidence: [
        {
          id: "settlement-a",
          lane: "market-structure",
          nutrientId: "n:settlement-a",
          source: "market",
          label: "현물 체결",
          value: "증가",
          summary: "Spot fills picked up.",
          trust: 0.82,
          freshness: 0.9,
          digestScore: 0.76,
          capturedAt: createdAt,
        },
        {
          id: "settlement-b",
          lane: "market-structure",
          nutrientId: "n:settlement-b",
          source: "market",
          label: "호가 두께",
          value: "약화",
          summary: "Depth stayed shallow.",
          trust: 0.8,
          freshness: 0.9,
          digestScore: 0.74,
          capturedAt: createdAt,
        },
      ],
      mode: "philosophy-note",
      variant: 1,
      identityPressure: {
        obsessionLine: "지금 픽시몬이 끝까지 붙드는 건 깊이다.",
        grudgeLine: "깊이 없는 거래량을 제일 싫어한다.",
        continuityLine: "지난번에도 체결보다 깊이가 더 늦게 붙었다.",
      },
    },
    "ko",
    260,
    "philosophy-note",
    1
  );

  assert.doesNotMatch(text, /실제로 이어지는지 다시|행동으로 이어지는지 다시|다시 본다/u);
});

test("buildEventEvidenceFallbackPost can produce era-manifesto fallback without raw headline leakage", () => {
  const createdAt = new Date().toISOString();
  const text = buildEventEvidenceFallbackPost(
    {
      lane: "regulation",
      focus: "court",
      sceneFamily: "regulation:court:briefing+execution:court-lag",
      event: {
        id: "court-era",
        lane: "regulation",
        headline: "이번 국면은 판결보다 집행이 규제의 체급을 다시 정하는 시기다",
        summary: "Court headlines are loud, but enforcement and capital reaction define the actual regime.",
        source: "analysis:sharp",
        trust: 0.84,
        freshness: 0.9,
        capturedAt: createdAt,
        keywords: ["판결", "집행", "국면"],
      },
      evidence: [
        {
          id: "court-era-a",
          lane: "regulation",
          nutrientId: "n:court-era-a",
          source: "news",
          label: "법원 일정",
          value: "집중",
          summary: "법원 일정은 크게 회자되지만 집행은 아직 더 늦게 붙는 장면이다.",
          trust: 0.82,
          freshness: 0.89,
          digestScore: 0.76,
          capturedAt: createdAt,
        },
        {
          id: "court-era-b",
          lane: "regulation",
          nutrientId: "n:court-era-b",
          source: "market",
          label: "대기 자금 흐름",
          value: "관망",
          summary: "자금은 판결 기사보다 훨씬 늦게 몸을 싣고 있다.",
          trust: 0.8,
          freshness: 0.88,
          digestScore: 0.73,
          capturedAt: createdAt,
        },
      ],
      hasOnchainEvidence: false,
      hasCrossSourceEvidence: true,
      evidenceSourceDiversity: 2,
      plannerScore: 0.86,
      plannerWarnings: [],
      laneUsage: {
        totalPosts: 0,
        byLane: {
          protocol: 0,
          ecosystem: 0,
          regulation: 0,
          macro: 0,
          onchain: 0,
          "market-structure": 0,
        },
      },
      laneProjectedRatio: 0,
      laneQuotaLimited: false,
    },
    "ko",
    300,
    "era-manifesto",
    2
  );

  assert.match(text, /(국면|질서|체급|사이클|시대)/);
  assert.match(text, /(집행|판결|자금)/);
  assert.doesNotMatch(text, /같은 화면에 둔다|시간차부터 잰다|court headlines/i);
});
