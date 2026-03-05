import test from "node:test";
import assert from "node:assert/strict";
import {
  enforceActionAndInvalidation,
  evaluatePostQuality,
  inferTopicTag,
  polishTweetText,
  resolveContentQualityRules,
  sanitizeTweetText,
  stripNarrativeControlTags,
  validateActionAndInvalidation,
} from "../src/services/engagement/quality.ts";
import { getDefaultAdaptivePolicy } from "../src/services/engagement/policy.ts";

test("sanitizeTweetText normalizes whitespace and quotes", () => {
  const text = '  BTC   “flow”   looks   stable   ';
  assert.equal(sanitizeTweetText(text), 'BTC "flow" looks stable');
});

test("polishTweetText fixes punctuation spacing and broken bracket joins", () => {
  const text = "BTC:0(+0.00%)|온체인로그,다시본다";
  assert.equal(polishTweetText(text, "ko"), "BTC: 0 (+0.00%) | 온체인로그, 다시본다");
});

test("polishTweetText keeps bracket ending with '다' 붙여쓰기", () => {
  const text = "기준선은 두 단서(검증자 합의 안정성, 커뮤니티 코호트 유지율) 다.";
  assert.equal(
    polishTweetText(text, "ko"),
    "기준선은 두 단서(검증자 합의 안정성, 커뮤니티 코호트 유지율)다."
  );
});

test("inferTopicTag classifies core topics", () => {
  assert.equal(inferTopicTag("$BTC spot flow divergence"), "bitcoin");
  assert.equal(inferTopicTag("극공포(FGI 10)인데 심리는 과열"), "sentiment");
  assert.equal(inferTopicTag("Layer2 rollup mainnet update"), "protocol");
  assert.equal(inferTopicTag("오더북 슬리피지와 체결 깊이를 본다"), "market-structure");
  assert.equal(inferTopicTag("생태계 코호트 리텐션이 꺾였다"), "ecosystem");
  assert.equal(inferTopicTag("FOMC macro risk remains high"), "macro");
  assert.equal(inferTopicTag("규제 업데이트: policy compliance roadmap"), "regulation");
  assert.equal(inferTopicTag("철학 메모: 신뢰는 설계다"), "philosophy");
  assert.equal(inferTopicTag("오늘 커뮤니티 실험 미션을 던진다"), "interaction");
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
      {
        content: "극공포 구간인데 스테이블 유입이 다시 늘었다. 심리와 데이터 괴리를 어떻게 읽어야 할까?",
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
    {
      content: "스테이블 자금 유입이 이어지는데 가격 반응은 제한적이다.",
      timestamp: new Date().toISOString(),
    },
    {
      content: "스테이블코인 유입이 계속되는데 반응 속도는 느리다.",
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
  assert.match(String(result.reason || ""), /동일 시그널 레인 반복\(stable-flow\)/);
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

test("evaluatePostQuality rejects numeric-heavy ticker dump style", () => {
  const policy = getDefaultAdaptivePolicy();
  const text =
    "$BTC 66304.4 +2.5%, $ETH 1976.1 -2.1%, $SOL 145.6 +4.2%, TVL 98.3B, Dominance 56.2%, FGI 9, MVRV 1.82";

  const result = evaluatePostQuality(
    text,
    [{ symbol: "BTC", name: "Bitcoin", price: 66304.4, change24h: 2.5 }],
    [],
    policy,
    resolveContentQualityRules({
      topicBlockConsecutiveTag: false,
      topicMaxSameTag24h: 8,
    })
  );

  assert.equal(result.ok, false);
  assert.match(String(result.reason || ""), /숫자\/티커 과밀/);
});

test("evaluatePostQuality rejects malformed numeric/bracket format", () => {
  const policy = getDefaultAdaptivePolicy();
  const result = evaluatePostQuality(
    "관찰 노트: BTC:0(+0.000 (+0.00%) - SOL: $0 기준으로 확인한다.",
    [{ symbol: "BTC", name: "Bitcoin", price: 66304.4, change24h: 2.5 }],
    [],
    policy,
    resolveContentQualityRules({
      topicBlockConsecutiveTag: false,
      topicMaxSameTag24h: 8,
    })
  );

  assert.equal(result.ok, false);
  assert.match(String(result.reason || ""), /(비정상 숫자\/괄호 결합|수치 포맷 손상|괄호 짝 불일치|비정상 시세 포맷)/);
});

test("evaluatePostQuality rejects korean text with severe spacing issues", () => {
  const policy = getDefaultAdaptivePolicy();
  const result = evaluatePostQuality(
    "오늘체인로그를재확인했고반증조건이보이면즉시관점을바꾼다결론보다검증이먼저다",
    [{ symbol: "BTC", name: "Bitcoin", price: 70000, change24h: 1.1 }],
    [],
    policy,
    resolveContentQualityRules({
      topicBlockConsecutiveTag: false,
      topicMaxSameTag24h: 8,
    })
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "띄어쓰기 이상");
});

test("evaluatePostQuality rejects narrative label leakage text", () => {
  const policy = getDefaultAdaptivePolicy();
  const result = evaluatePostQuality(
    "상호작용 실험: 이 장면을 다시 확인하자.",
    [{ symbol: "BTC", name: "Bitcoin", price: 100000, change24h: 1.2 }],
    [],
    policy,
    resolveContentQualityRules({
      topicBlockConsecutiveTag: false,
      topicMaxSameTag24h: 8,
    })
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "내부 서사 라벨 노출");
});

test("evaluatePostQuality rejects bot-style lead opener", () => {
  const policy = getDefaultAdaptivePolicy();
  const result = evaluatePostQuality(
    "오늘의 미션은 온체인 흐름을 검증하는 것이다. 반증이 나오면 수정한다.",
    [{ symbol: "BTC", name: "Bitcoin", price: 100000, change24h: 1.2 }],
    [],
    policy,
    resolveContentQualityRules({
      topicBlockConsecutiveTag: false,
      topicMaxSameTag24h: 8,
    })
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "폼 기반 오프너 노출");
});

test("stripNarrativeControlTags removes control labels from generated text", () => {
  assert.equal(
    stripNarrativeControlTags("철학 메모: 프로토콜 변화는 행동을 바꾼다."),
    "프로토콜 변화는 행동을 바꾼다."
  );
  assert.equal(
    stripNarrativeControlTags("Meta reflection: Identity note: this should read naturally."),
    "this should read naturally."
  );
});

test("validateActionAndInvalidation enforces both action and invalidation", () => {
  const missingInvalidation = validateActionAndInvalidation(
    "먼저 체인 로그를 확인하고 다음 사이클에서 다시 점검한다.",
    "ko"
  );
  assert.equal(missingInvalidation.ok, false);

  const valid = validateActionAndInvalidation(
    "먼저 체인 로그를 확인하고, 반대 신호가 이어지면 이 가설을 접는다.",
    "ko"
  );
  assert.equal(valid.ok, true);
});

test("enforceActionAndInvalidation injects bridge when structure is missing", () => {
  const output = enforceActionAndInvalidation("온체인 단서를 모아본다.", "ko", 220);
  const check = validateActionAndInvalidation(output, "ko");
  assert.equal(check.ok, true);
});

test("evaluatePostQuality rejects when action/invalidation gate is required and absent", () => {
  const policy = getDefaultAdaptivePolicy();
  const result = evaluatePostQuality(
    "오늘 이벤트와 근거를 붙여서 해석한다.",
    [{ symbol: "BTC", name: "Bitcoin", price: 100000, change24h: 1.2 }],
    [],
    policy,
    resolveContentQualityRules({
      topicBlockConsecutiveTag: false,
      topicMaxSameTag24h: 8,
    }),
    {
      requireActionAndInvalidation: true,
      language: "ko",
    }
  );

  assert.equal(result.ok, false);
  assert.match(String(result.reason || ""), /(행동 계획 부재|반증\/무효화 조건 부재)/);
});

test("evaluatePostQuality rejects unclear lead issue when clarity gate is on", () => {
  const policy = getDefaultAdaptivePolicy();
  const result = evaluatePostQuality(
    "오늘은 그냥 느낌을 적어본다. 먼저 확인하고 틀리면 바꾼다.",
    [{ symbol: "BTC", name: "Bitcoin", price: 100000, change24h: 1.2 }],
    [],
    policy,
    resolveContentQualityRules({
      topicBlockConsecutiveTag: false,
      topicMaxSameTag24h: 8,
    }),
    {
      requireLeadIssueClarity: true,
      requireActionAndInvalidation: true,
      language: "ko",
    }
  );

  assert.equal(result.ok, false);
  assert.match(String(result.reason || ""), /(첫 문장|핵심 이슈|크립토 맥락)/);
});

test("evaluatePostQuality rejects when pixymon concept signal is missing", () => {
  const policy = getDefaultAdaptivePolicy();
  const result = evaluatePostQuality(
    "프로토콜 업그레이드 이슈에서 검증자 반응을 먼저 확인한다. 반대 신호가 이어지면 해석을 바꾼다.",
    [{ symbol: "ETH", name: "Ethereum", price: 3600, change24h: 1.1 }],
    [],
    policy,
    resolveContentQualityRules({
      topicBlockConsecutiveTag: false,
      topicMaxSameTag24h: 8,
    }),
    {
      requireLeadIssueClarity: true,
      requireActionAndInvalidation: true,
      requirePixymonConceptSignal: true,
      language: "ko",
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "픽시몬 컨셉 신호 부족(먹기/소화/진화)");
});
