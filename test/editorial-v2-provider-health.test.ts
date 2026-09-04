import test from "node:test";
import assert from "node:assert/strict";

import {
  providerFailureCodeFromHttpStatusV2,
  providerHealthFromOutcomeV2,
  type ProviderFailureCodeV2,
  type ProviderHealthStateV2,
} from "../src/services/editorial-v2/provider-health.ts";

const CHECKED_AT = "2026-08-28T00:00:00.000Z";

test("successful provider outcome is green and preserves measurements", () => {
  const health = providerHealthFromOutcomeV2({
    kind: "success",
    provider: "defillama",
    checkedAt: CHECKED_AT,
    latencyMs: 125,
    itemCount: 3,
  });

  assert.equal(health.state, "green");
  assert.equal(health.reason, "ok");
  assert.equal(health.itemCount, 3);
  assert.equal(health.latencyMs, 125);
});

test("a nominal success with no items is degraded instead of green", () => {
  const health = providerHealthFromOutcomeV2({
    kind: "success",
    provider: "coingecko",
    checkedAt: CHECKED_AT,
    latencyMs: 80,
    itemCount: 0,
  });

  assert.equal(health.state, "yellow");
  assert.equal(health.reason, "empty");
});

test("provider failures retain distinct causes instead of becoming a generic fallback", () => {
  const cases: Array<[ProviderFailureCodeV2, ProviderHealthStateV2]> = [
    ["not-configured", "red"],
    ["unauthorized", "red"],
    ["timeout", "yellow"],
    ["rate-limited", "yellow"],
    ["parse-error", "red"],
    ["stale-cache", "yellow"],
  ];

  for (const [failure, expectedState] of cases) {
    const health = providerHealthFromOutcomeV2({
      kind: "failure",
      provider: "cryptocompare",
      checkedAt: CHECKED_AT,
      latencyMs: 8000,
      failure,
      statusCode: failure === "unauthorized" ? 401 : failure === "rate-limited" ? 429 : undefined,
    });
    assert.equal(health.reason, failure, failure);
    assert.equal(health.state, expectedState, failure);
    assert.equal(health.itemCount, 0, failure);
  }
});

test("HTTP status classification distinguishes auth and rate limiting", () => {
  assert.equal(providerFailureCodeFromHttpStatusV2(401), "unauthorized");
  assert.equal(providerFailureCodeFromHttpStatusV2(403), "unauthorized");
  assert.equal(providerFailureCodeFromHttpStatusV2(429), "rate-limited");
  assert.equal(providerFailureCodeFromHttpStatusV2(503), "http-error");
});
