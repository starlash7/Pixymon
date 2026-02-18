import test from "node:test";
import assert from "node:assert/strict";
import {
  detectFearGreedEvent,
  parseFearGreedPointFromMarketContext,
} from "../src/services/engagement/fear-greed-policy.ts";

test("parseFearGreedPointFromMarketContext parses common formats", () => {
  const fromCanonical = parseFearGreedPointFromMarketContext("FearGreed 12 (Extreme Fear)");
  assert.deepEqual(fromCanonical, { value: 12, label: "Extreme Fear" });

  const fromFGI = parseFearGreedPointFromMarketContext("FGI: 65 | market context");
  assert.equal(fromFGI?.value, 65);

  const fromKorean = parseFearGreedPointFromMarketContext("공포 지수 21, 온체인 자금 유입");
  assert.equal(fromKorean?.value, 21);
});

test("detectFearGreedEvent treats first sample as event", () => {
  const decision = detectFearGreedEvent(
    { value: 18, label: "Extreme Fear" },
    null,
    { minDelta: 10, requireRegimeChange: true }
  );

  assert.equal(decision.isEvent, true);
  assert.equal(decision.reason, "first-sample");
});

test("detectFearGreedEvent supports delta mode without regime requirement", () => {
  const decision = detectFearGreedEvent(
    { value: 28, label: "Fear" },
    { value: 12, label: "Extreme Fear" },
    { minDelta: 10, requireRegimeChange: false }
  );

  assert.equal(decision.isEvent, true);
  assert.equal(decision.reason, "delta-change");
  assert.equal(decision.delta, 16);
});

test("detectFearGreedEvent blocks when regime change is required but absent", () => {
  const decision = detectFearGreedEvent(
    { value: 18, label: "Extreme Fear" },
    { value: 10, label: "Extreme Fear" },
    { minDelta: 5, requireRegimeChange: true }
  );

  assert.equal(decision.isEvent, false);
  assert.equal(decision.reason, "regime-required");
});
