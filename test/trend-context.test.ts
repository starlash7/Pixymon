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
  assert.equal(/체인 안쪽의 조용함|먼저 달아오른 표정|화면 분위기/i.test(joined), true);
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
  assert.equal(evidence[0]?.value, "포착");
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

  assert.equal(evidence[0]?.label, "체인 안쪽 사용");
  assert.ok(/흐름/.test(String(evidence[0]?.value || "")));
  assert.equal(/sat\/vB/i.test(String(evidence[0]?.summary || "")), false);
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
  assert.match(events[0].headline, /큰손 움직임|대기 자금 흐름/);
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

test("planEventEvidenceAct keeps onchain structural fallback on onchain evidence pair", () => {
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

  assert.ok(plan);
  assert.equal(plan?.lane, "onchain");
  assert.equal(plan?.hasCrossSourceEvidence, false);
  assert.deepEqual(
    plan?.evidence.map((item) => item.label),
    ["체인 안쪽 사용", "밀린 거래"]
  );
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
    plan?.evidence.map((item) => item.label),
    ["체인 안쪽 사용", "밀린 거래"]
  );
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
  assert.deepEqual(labels[0], "큰손 움직임");
  assert.equal(labels.includes("ETH 24h 변동"), false);
  assert.equal(labels.includes("실사용 흐름") || labels.includes("개발자 커뮤니티 반응") || labels.includes("개발자 반응"), true);
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
  assert.equal(labels.includes("규제 쪽 일정") || labels.includes("현장으로 번지는 규제 반응"), true);
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
      label: "규제 일정",
      value: "포착",
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
      label: "Firedancer 테스트 흐름",
      value: "포착",
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
      label: "지갑 안쪽 사용",
      value: "유지",
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
  assert.match(headline, /갈린다|달렸다|성립한다/);
  assert.doesNotMatch(headline, /뒤에|살핀다|짚는다|장면/);
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
