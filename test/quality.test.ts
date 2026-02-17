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
    topicBlockConsecutiveTag: false,
  });

  assert.equal(rules.minPostLength, 10);
  assert.equal(rules.topicMaxSameTag24h, 8);
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
