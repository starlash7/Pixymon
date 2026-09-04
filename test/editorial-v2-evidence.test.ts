import test from "node:test";
import assert from "node:assert/strict";

import {
  NEWS_FRESHNESS_MS,
  SIGNAL_FRESHNESS_MS,
  assessTierAEligibilityV2,
  evidenceCardFromNewsItemV2,
  evidenceCardFromNutrientV2,
  evaluateEvidenceFreshnessV2,
  type EvidenceMetricV2,
} from "../src/services/editorial-v2/evidence.ts";
import { providerHealthFromOutcomeV2 } from "../src/services/editorial-v2/provider-health.ts";
import type { OnchainNutrient } from "../src/types/agent.ts";

const NOW = "2026-08-28T10:00:00.000Z";

function greenHealth(provider: "defillama" | "mempool.space" | "rss" | "blockchain.com") {
  return providerHealthFromOutcomeV2({
    kind: "success",
    provider,
    checkedAt: NOW,
    latencyMs: 20,
    itemCount: 1,
  });
}

function nutrient(overrides: Partial<OnchainNutrient> = {}): OnchainNutrient {
  return {
    id: "onchain:btc-fee-market:0",
    source: "onchain",
    category: "network-fee",
    label: "BTC 네트워크 수수료",
    value: "25 sat/vB",
    evidence: "BTC 네트워크 수수료: 25 sat/vB",
    trust: 0.84,
    freshness: 0.94,
    capturedAt: "2026-08-28T09:00:00.000Z",
    metadata: { source: "mempool.space" },
    ...overrides,
  };
}

test("freshness uses a two-hour signal window and six-hour news window", () => {
  const signalAtBoundary = evaluateEvidenceFreshnessV2({
    kind: "signal",
    observedAt: "2026-08-28T08:00:00.000Z",
    now: NOW,
  });
  const signalPastBoundary = evaluateEvidenceFreshnessV2({
    kind: "signal",
    observedAt: "2026-08-28T07:59:59.999Z",
    now: NOW,
  });
  const newsAtBoundary = evaluateEvidenceFreshnessV2({
    kind: "news",
    observedAt: NOW,
    publishedAt: "2026-08-28T04:00:00.000Z",
    now: NOW,
  });

  assert.equal(signalAtBoundary.maxAgeMs, SIGNAL_FRESHNESS_MS);
  assert.equal(signalAtBoundary.state, "fresh");
  assert.equal(signalPastBoundary.state, "stale");
  assert.equal(newsAtBoundary.maxAgeMs, NEWS_FRESHNESS_MS);
  assert.equal(newsAtBoundary.state, "fresh");
});

test("a fresh named direct nutrient with a raw numeric fact is Tier A", () => {
  const result = evidenceCardFromNutrientV2(nutrient(), {
    id: "evidence:btc-fee:1",
    lane: "onchain",
    subject: "Bitcoin",
    sourceUrl: "https://mempool.space/api/v1/fees/recommended",
    observedAt: "2026-08-28T09:00:00.000Z",
    now: NOW,
    providerHealth: greenHealth("mempool.space"),
  });
  if (!result.ok) assert.fail(`unexpected conversion failure: ${result.reasons.join(",")}`);

  assert.equal(result.card.metric.value, 25);
  assert.equal(result.card.metric.raw, "25 sat/vB");
  assert.equal(result.card.metric.unit, "sat/vB");
  assert.equal(result.card.metric.period, "snapshot");
  assert.equal(result.card.source.origin, "direct");
  assert.equal(assessTierAEligibilityV2(result.card, NOW).eligible, true);
});

test("system-neutral nutrients are excluded before evidence scoring", () => {
  const result = evidenceCardFromNutrientV2(
    nutrient({
      id: "onchain:fallback-neutral:0",
      label: "온체인 데이터",
      value: "중립",
      evidence: "수집 가능한 신호가 없음",
      metadata: { source: "system" },
    }),
    {
      id: "evidence:neutral",
      lane: "onchain",
      subject: "온체인 데이터",
      sourceUrl: "https://example.com/system",
      observedAt: NOW,
      now: NOW,
      providerHealth: greenHealth("mempool.space"),
    }
  );

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("system-neutral conversion unexpectedly succeeded");
  assert.deepEqual(result.reasons, ["system-neutral"]);
});

test("blockchain.com flow proxies remain derived even when direct is requested", () => {
  const result = evidenceCardFromNutrientV2(
    nutrient({
      id: "onchain:exchange-netflow-proxy:0",
      category: "exchange-flow",
      label: "거래소 순유입 프록시",
      value: "0.42x",
      evidence: "직접 순유입이 아닌 프록시",
      metadata: { source: "blockchain.com charts" },
    }),
    {
      id: "evidence:flow-proxy",
      lane: "onchain",
      subject: "Bitcoin",
      sourceUrl: "https://www.blockchain.com/explorer/charts/trade-volume",
      observedAt: "2026-08-28T09:30:00.000Z",
      now: NOW,
      providerHealth: greenHealth("blockchain.com"),
      origin: "direct",
    }
  );
  if (!result.ok) assert.fail(`unexpected conversion failure: ${result.reasons.join(",")}`);

  const eligibility = assessTierAEligibilityV2(result.card, NOW);
  assert.equal(result.card.source.origin, "derived");
  assert.equal(eligibility.eligible, false);
  assert.ok(eligibility.reasons.includes("not-direct"));
});

test("RSS articles remain discovery-only even with a complete metric", () => {
  const metric: EvidenceMetricV2 = {
    name: "tvl-change-24h",
    value: 8.4,
    raw: "+8.4%",
    unit: "%",
    period: "24h",
  };
  const result = evidenceCardFromNewsItemV2(
    {
      title: "Aave TVL rises 8.4 percent in a day",
      summary: "The protocol recorded a one-day increase.",
      source: "CoinDesk RSS",
      category: "news",
      importance: "high",
      url: "https://example.com/aave-tvl",
    },
    {
      id: "evidence:aave-rss",
      lane: "protocol",
      subject: "Aave",
      observedAt: "2026-08-28T09:30:00.000Z",
      publishedAt: "2026-08-28T09:00:00.000Z",
      now: NOW,
      providerHealth: greenHealth("rss"),
      metric,
      origin: "direct",
      role: "primary",
    }
  );
  if (!result.ok) assert.fail(`unexpected conversion failure: ${result.reasons.join(",")}`);

  const eligibility = assessTierAEligibilityV2(result.card, NOW);
  assert.equal(result.card.source.role, "discovery");
  assert.equal(eligibility.eligible, false);
  assert.ok(eligibility.reasons.includes("discovery-only"));
  assert.ok(eligibility.reasons.includes("rss-discovery-only"));
});

test("legacy records without an exact source URL are rejected", () => {
  const result = evidenceCardFromNutrientV2(nutrient(), {
    id: "evidence:missing-url",
    lane: "onchain",
    subject: "Bitcoin",
    observedAt: "2026-08-28T09:00:00.000Z",
    now: NOW,
    providerHealth: greenHealth("mempool.space"),
  });

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("conversion unexpectedly succeeded");
  assert.ok(result.reasons.includes("source-url-missing"));
});
