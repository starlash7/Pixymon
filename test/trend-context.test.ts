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

  assert.equal(evidence[0]?.label, "실사용 실험");
  assert.equal(evidence[0]?.value, "확대");
  assert.match(String(evidence[0]?.summary || ""), /사람이 실제로 쓰는 흐름/);
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
  assert.match(events[0].headline, /규제|정책|반응/);
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
    "생태계 서사가 실제 사용 흔적으로 이어지는지 본다. 체인 수수료 2 sat/vB와 알트 쪽이 먼저 들뜨는지를 같은 화면에 붙여 둔다.",
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
  assert.match(events[0].headline, /큰손들이 실제로 움직이는지|대기 중인 유동성이 늘어나는지/);
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
    ["BTC 네트워크 수수료", "BTC 멤풀 대기열"]
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
    ["BTC 네트워크 수수료", "BTC 멤풀 대기열"]
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
  assert.deepEqual(labels[0], "고래/대형주소 활동 프록시");
  assert.equal(labels.includes("ETH 24h 변동"), false);
  assert.equal(labels.includes("실사용 실험") || labels.includes("개발자 커뮤니티 반응"), true);
});
