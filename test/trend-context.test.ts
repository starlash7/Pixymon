import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEventEvidenceFallbackPost,
  buildOnchainEvidence,
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
});

test("buildTrendEvents filters low-quality ranking and prediction headlines", () => {
  const events = buildTrendEvents({
    createdAt: new Date().toISOString(),
    newsRows: [
      {
        item: {
          title: "Pi Network (PI) 트렌딩 1위, 지금이 매수 타이밍인가?",
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
  assert.match(events[0].headline, /Validator upgrade coordination/i);
});
