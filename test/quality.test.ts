import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateReplyQuality,
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

test("evaluatePostQuality rejects repeated template even when numbers differ", () => {
  const policy = getDefaultAdaptivePolicy();
  const recentPosts = [
    {
      content:
        "온체인 유동성은 늘었는데 가격은 둔하다. 고래와 스테이블 흐름이 엇갈리는지 추가 확인이 필요하다.",
      timestamp: new Date().toISOString(),
    },
  ];

  const result = evaluatePostQuality(
    "온체인 유동성은 증가했지만 가격 반응은 제한적이다. 고래와 스테이블 흐름이 엇갈리는지 더 확인한다.",
    [{ symbol: "BTC", name: "Bitcoin", price: 100000, change24h: 1.2 }],
    recentPosts,
    policy,
    resolveContentQualityRules({
      topicBlockConsecutiveTag: false,
      topicMaxSameTag24h: 8,
    })
  );

  assert.equal(result.ok, false);
  assert.match(String(result.reason), /템플릿 반복|모티프 반복|중복/);
});

test("evaluatePostQuality blocks btc-centric post when 24h btc saturation is high", () => {
  const policy = getDefaultAdaptivePolicy();
  const now = new Date().toISOString();
  const recentPosts = [
    { content: "BTC 네트워크 수수료는 낮고 멤풀은 조용한 편이다.", timestamp: now },
    { content: "비트코인 가격은 좁은 박스권에서 횡보 중이다.", timestamp: now },
    { content: "BTC 관련 온체인 주소 활동은 늘었지만 속도는 완만하다.", timestamp: now },
    { content: "비트코인 거래량은 유지되지만 변동성은 제한적이다.", timestamp: now },
    { content: "BTC 네트워크 혼잡은 완화됐고 거래 체결은 안정적이다.", timestamp: now },
    { content: "비트코인 시장 반응은 느리지만 방향성 힌트는 누적된다.", timestamp: now },
  ];

  const result = evaluatePostQuality(
    "비트코인 중심 신호만으로 결론을 내리기엔 아직 이르고, 추가 확인이 필요할까?",
    [{ symbol: "BTC", name: "Bitcoin", price: 100000, change24h: 1.2 }],
    recentPosts,
    policy,
    resolveContentQualityRules({
      topicBlockConsecutiveTag: false,
      topicMaxSameTag24h: 8,
    })
  );

  assert.equal(result.ok, false);
  assert.match(String(result.reason), /^BTC 편중 완화 필요|동일 시그널 레인 반복/);
});

test("evaluateReplyQuality rejects repeated reply topic streak", () => {
  const policy = getDefaultAdaptivePolicy();
  const recentReplies = [
    "극공포 구간이라도 바로 확신하기보다 거래량 확인이 필요해요.",
    "극공포일수록 반등 단정은 이르니 거래량 확증부터 보는 편입니다.",
    "극공포 신호만으로 방향을 확정하기보다 온체인 확인이 우선입니다.",
  ];

  const result = evaluateReplyQuality(
    "극공포라고 바로 결론내리기보다 거래량 확증을 먼저 보겠습니다.",
    [{ symbol: "BTC", name: "Bitcoin", price: 100000, change24h: 1.2 }],
    recentReplies,
    policy
  );

  assert.equal(result.ok, false);
  assert.match(String(result.reason), /댓글 주제 연속 반복|댓글 주제 편중|템플릿 반복/);
});
