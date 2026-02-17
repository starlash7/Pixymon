import test from "node:test";
import assert from "node:assert/strict";
import { inferTopicTag, resolveContentQualityRules, sanitizeTweetText } from "../src/services/engagement/quality.ts";

test("sanitizeTweetText normalizes whitespace and quotes", () => {
  const text = '  BTC   “flow”   looks   stable   ';
  assert.equal(sanitizeTweetText(text), 'BTC "flow" looks stable');
});

test("inferTopicTag classifies core topics", () => {
  assert.equal(inferTopicTag("$BTC spot flow divergence"), "bitcoin");
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
