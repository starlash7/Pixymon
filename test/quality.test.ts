import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluatePostQuality,
  inferTopicTag,
  resolveContentQualityRules,
  sanitizeTweetText,
} from "../src/services/engagement/quality.ts";
import { getDefaultAdaptivePolicy } from "../src/services/engagement/policy.ts";

test("sanitizeTweetText normalizes whitespace and quotes", () => {
  const text = '  BTC   “flow”   looks   stable   ';
  assert.equal(sanitizeTweetText(text), 'BTC "flow" looks stable');
});

test("inferTopicTag classifies core topics", () => {
  assert.equal(inferTopicTag("$BTC spot flow divergence"), "bitcoin");
  assert.equal(inferTopicTag("극공포(FGI 10)인데 심리는 과열"), "sentiment");
  assert.equal(inferTopicTag("Layer2 rollup mainnet update"), "tech");
  assert.equal(inferTopicTag("FOMC macro risk remains high"), "macro");
});

test("resolveContentQualityRules clamps out-of-range values", () => {
  const rules = resolveContentQualityRules({
    minPostLength: 2,
    topicMaxSameTag24h: 99,
    sentimentMaxRatio24h: 10,
    topicBlockConsecutiveTag: false,
  });

  assert.equal(rules.minPostLength, 10);
  assert.equal(rules.topicMaxSameTag24h, 8);
  assert.equal(rules.sentimentMaxRatio24h, 1);
  assert.equal(rules.topicBlockConsecutiveTag, false);
});

test("evaluatePostQuality rejects repeated structure patterns", () => {
  const policy = getDefaultAdaptivePolicy();
  const result = evaluatePostQuality(
    "극공포 지수 10인데 스테이블 유입이 커졌다. 심리와 데이터 괴리를 어떻게 읽어야 할까?",
    [{ symbol: "BTC", name: "Bitcoin", price: 100000, change24h: 1.2 }],
    [
      {
        content: "극공포 구간인데 스테이블 유입이 증가했다. 심리와 데이터 괴리를 어떻게 읽어야 할까?",
        timestamp: new Date().toISOString(),
      },
    ],
    policy,
    resolveContentQualityRules({
      topicBlockConsecutiveTag: false,
      topicMaxSameTag24h: 8,
    })
  );

  assert.equal(result.ok, false);
  assert.match(String(result.reason || ""), /(서두 구조 반복|마무리 패턴 반복|모티프 반복|중복)/);
});

test("evaluatePostQuality requires trend focus token when configured", () => {
  const policy = getDefaultAdaptivePolicy();
  const recentPosts: Array<{ content: string; timestamp: string }> = [
    {
      content: "L2 수수료가 낮아지고 거래량이 늘어나는지 관찰 중.",
      timestamp: new Date().toISOString(),
    },
  ];

  const missingFocus = evaluatePostQuality(
    "오늘 온체인 유동성은 증가했지만 가격 반응은 제한적이다.",
    [{ symbol: "BTC", name: "Bitcoin", price: 100000, change24h: 1.2 }],
    recentPosts,
    policy,
    resolveContentQualityRules({
      topicBlockConsecutiveTag: false,
      topicMaxSameTag24h: 8,
    }),
    { requiredTrendTokens: ["rocket", "pool"] }
  );

  assert.equal(missingFocus.ok, false);
  assert.equal(missingFocus.reason, "트렌드 포커스 키워드 미반영");

  const withFocus = evaluatePostQuality(
    "Rocket Pool 트렌딩이 다시 올라오면서 온체인 유동성 해석이 갈린다.",
    [{ symbol: "BTC", name: "Bitcoin", price: 100000, change24h: 1.2 }],
    recentPosts,
    policy,
    resolveContentQualityRules({
      topicBlockConsecutiveTag: false,
      topicMaxSameTag24h: 8,
    }),
    { requiredTrendTokens: ["rocket", "pool"] }
  );

  assert.equal(withFocus.ok, true);
});

test("evaluatePostQuality rejects same signal lane even with short phrasing", () => {
  const policy = getDefaultAdaptivePolicy();
  const recentPosts: Array<{ content: string; timestamp: string }> = [
    {
      content: "스테이블코인 유입이 꾸준히 늘고 있는 구간이다.",
      timestamp: new Date().toISOString(),
    },
  ];

  const result = evaluatePostQuality(
    "스테이블 자금이 계속 들어오면서 단기 반응이 제한되는 모습이다.",
    [{ symbol: "BTC", name: "Bitcoin", price: 100000, change24h: 1.2 }],
    recentPosts,
    policy,
    resolveContentQualityRules({
      topicBlockConsecutiveTag: false,
      topicMaxSameTag24h: 8,
    })
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "동일 시그널 레인 반복(stable-flow|observation-ending)");
});

test("evaluatePostQuality rejects sentiment when fear-greed event is required but missing", () => {
  const policy = getDefaultAdaptivePolicy();
  const result = evaluatePostQuality(
    "극공포 구간에서 심리와 온체인 괴리가 커지고 있는데, 이번엔 어떤 쪽이 맞을까?",
    [{ symbol: "BTC", name: "Bitcoin", price: 100000, change24h: 1.2 }],
    [],
    policy,
    resolveContentQualityRules({
      topicBlockConsecutiveTag: false,
      topicMaxSameTag24h: 8,
      sentimentMaxRatio24h: 1,
    }),
    {
      fearGreedEvent: {
        required: true,
        isEvent: false,
      },
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "FGI 이벤트 없음(sentiment 서사 제한)");
});

test("evaluatePostQuality enforces sentiment ratio budget", () => {
  const policy = getDefaultAdaptivePolicy();
  const now = new Date().toISOString();
  const recentPosts: Array<{ content: string; timestamp: string }> = [
    {
      content: "거래소 순유입은 줄고 네트워크 수수료는 안정권에 머무는 중.",
      timestamp: now,
    },
    {
      content: "탐욕 지수 신호가 확대되지만 거래량 확증은 아직 부족해 보인다.",
      timestamp: now,
    },
    {
      content: "FOMC 경계감으로 달러 인덱스가 흔들리며 위험자산이 눈치 보는 흐름.",
      timestamp: now,
    },
  ];

  const result = evaluatePostQuality(
    "극공포 지표는 유지되는데 자금은 버티는 모습이라 이 괴리를 더 봐야 한다.",
    [{ symbol: "BTC", name: "Bitcoin", price: 100000, change24h: 1.2 }],
    recentPosts,
    policy,
    resolveContentQualityRules({
      topicBlockConsecutiveTag: false,
      topicMaxSameTag24h: 8,
      sentimentMaxRatio24h: 0.25,
    })
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "sentiment 비중 초과(50%)");
});
