import test from "node:test";
import assert from "node:assert/strict";
import { __providerAdapterTestV2, collectEditorialEvidenceV2 } from "../src/services/editorial-v2/provider-adapters.ts";
import { providerHealthFromOutcomeV2 } from "../src/services/editorial-v2/provider-health.ts";

const NOW = "2026-08-28T10:00:00.000Z";

function response(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

function quantityDrivenDetail(tvl: number, changePercent: number): unknown {
  const t1 = Date.parse(NOW) / 1_000;
  const t0 = t1 - 24 * 60 * 60;
  const prior = tvl / (1 + changePercent / 100);
  return {
    tokens: [
      { date: t0, tokens: { TOKEN: prior } },
      { date: t1, tokens: { TOKEN: tvl } },
    ],
    tokensInUsd: [
      { date: t0, tokens: { TOKEN: prior } },
      { date: t1, tokens: { TOKEN: tvl } },
    ],
    tvl: [
      { date: t0, totalLiquidityUSD: prior },
      { date: t1, totalLiquidityUSD: tvl },
    ],
  };
}

function healthyFetch(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === __providerAdapterTestV2.ENDPOINTS.defillama) return response([{ name: "Aave V3", slug: "aave-v3", category: "Lending", tvl: 50_000_000_000, change_1d: 4.2 }]);
    if (url === __providerAdapterTestV2.ENDPOINTS.defillamaProtocol("aave-v3")) return response(quantityDrivenDetail(50_000_000_000, 4.2));
    if (url === __providerAdapterTestV2.ENDPOINTS.mempool) return response({ fastestFee: 25 });
    if (url === __providerAdapterTestV2.ENDPOINTS.coingecko) return response([{ id: "bitcoin", name: "Bitcoin", current_price: 62_500, price_change_percentage_24h: 2 }]);
    if (url === __providerAdapterTestV2.ENDPOINTS.rss) return response("<rss><item><title>Aave governance update</title><link>https://example.com/aave</link><pubDate>Fri, 28 Aug 2026 09:00:00 GMT</pubDate></item></rss>");
    throw new Error(`unexpected URL ${url}`);
  }) as typeof fetch;
}

test("free provider adapters preserve Tier A numeric provenance and keep RSS discovery-only", async () => {
  const result = await collectEditorialEvidenceV2({ now: NOW, fetchImpl: healthyFetch(), cryptoCompareApiKey: "" });
  assert.equal(result.evidence.length, 3);
  assert.equal(result.evidence.every((card) => card.source.origin === "direct" && card.source.url.startsWith("https://")), true);
  assert.equal(result.discoveries.length, 1);
  assert.equal(result.evidence.find((card) => card.source.provider === "defillama")?.source.role, "primary");
  const defillama = result.evidence.find((card) => card.source.provider === "defillama");
  assert.equal(defillama?.followUp?.metric.name, "tvl-usd");
  assert.equal(defillama?.followUp?.metric.value, 50_000_000_000);
  assert.equal(defillama?.followUp?.comparator, "lte");
  assert.ok(Math.abs((defillama?.followUp?.threshold || 0) - 50_000_000_000 / 1.042) < 1);
  assert.equal(result.evidence.find((card) => card.source.provider === "mempool.space")?.source.role, "discovery");
  assert.equal(result.evidence.find((card) => card.source.provider === "coingecko")?.source.role, "discovery");
  assert.equal(result.providers.find((row) => row.outcome.provider === "cryptocompare")?.outcome.kind, "failure");
  const crypto = result.providers.find((row) => row.outcome.provider === "cryptocompare")?.outcome;
  if (!crypto || crypto.kind === "success") assert.fail("missing CryptoCompare failure");
  assert.equal(crypto.failure, "not-configured");
});

test("DefiLlama keeps a tracked follow-up observable after it drops out of the top candidates", async () => {
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === __providerAdapterTestV2.ENDPOINTS.defillama) {
      return response([
        ...[12, 11, 10, 9, 8, 7].map((change, index) => ({
          name: `Protocol ${index}`,
          category: "Lending",
          tvl: 1_000_000_000,
          change_1d: change,
        })),
        { name: "Tracked Protocol", category: "Lending", tvl: 90_000_000, change_1d: 0.2 },
      ]);
    }
    if (url === __providerAdapterTestV2.ENDPOINTS.mempool) return response({ fastestFee: 25 });
    if (url === __providerAdapterTestV2.ENDPOINTS.coingecko) return response([{ id: "bitcoin", name: "Bitcoin", current_price: 62_500 }]);
    if (url === __providerAdapterTestV2.ENDPOINTS.rss) return response("<rss><item><title>Update</title><link>https://example.com/update</link></item></rss>");
    throw new Error(`unexpected URL ${url}`);
  }) as typeof fetch;

  const result = await collectEditorialEvidenceV2({
    now: NOW,
    fetchImpl,
    cryptoCompareApiKey: "",
    followUpTargets: [{
      provider: "defillama",
      subject: "Tracked Protocol",
      metricName: "tvl-change-24h",
      unit: "%",
      period: "24h",
    }],
    includeGenericCandidates: false,
  });

  assert.equal(result.evidence.filter((card) => card.source.provider === "defillama").length, 0);
  assert.equal(result.evidence.some((card) => card.subject === "Tracked Protocol"), false);
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].subject, "Tracked Protocol");
  assert.equal(result.observations[0].metric.raw, "+0.20%");
});

test("explicitly stale DefiLlama cache cannot satisfy follow-up or publish revalidation", async () => {
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === __providerAdapterTestV2.ENDPOINTS.defillama) {
      return new Response(JSON.stringify([
        { name: "Tracked Protocol", slug: "tracked-protocol", category: "Lending", tvl: 80_000_000, change_1d: -20 },
      ]), {
        headers: {
          age: String(3 * 60 * 60),
          date: "Thu, 27 Aug 2026 10:00:00 GMT",
          "last-modified": "Thu, 27 Aug 2026 09:00:00 GMT",
        },
      });
    }
    if (url === __providerAdapterTestV2.ENDPOINTS.mempool) return response({ fastestFee: 25 });
    if (url === __providerAdapterTestV2.ENDPOINTS.coingecko) return response([{ id: "bitcoin", name: "Bitcoin", current_price: 62_500 }]);
    if (url === __providerAdapterTestV2.ENDPOINTS.rss) return response("<rss><item><title>Update</title><link>https://example.com/update</link></item></rss>");
    throw new Error(`unexpected URL ${url}`);
  }) as typeof fetch;

  const result = await collectEditorialEvidenceV2({
    now: NOW,
    fetchImpl,
    cryptoCompareApiKey: "",
    includeGenericCandidates: false,
    followUpTargets: [{
      provider: "defillama",
      subject: "Tracked Protocol",
      subjectKey: "tracked-protocol",
      metricName: "tvl-usd",
      unit: "USD",
      period: "snapshot",
    }],
  });
  const provider = result.providers.find((row) => row.outcome.provider === "defillama");
  assert.ok(provider);
  assert.equal(provider.outcome.kind, "failure");
  if (provider.outcome.kind === "success") assert.fail("stale cache unexpectedly succeeded");
  assert.equal(provider.outcome.failure, "stale-cache");
  assert.notEqual(providerHealthFromOutcomeV2(provider.outcome).state, "green");
  assert.equal(result.observations.some((card) => card.source.provider === "defillama"), false);
});

test("DefiLlama cache age is inclusive at the freshness boundary and explicit stale status blocks", async () => {
  const atBoundary = await __providerAdapterTestV2.fetchPayloadV2({
    provider: "defillama",
    url: "https://example.com/cache-boundary",
    fetchImpl: (async () => new Response("{}", { headers: { age: String(2 * 60 * 60) } })) as typeof fetch,
    timeoutMs: 100,
    maxCacheAgeMs: 2 * 60 * 60 * 1_000,
  });
  assert.equal(atBoundary.ok, true);

  const explicitlyStale = await __providerAdapterTestV2.fetchPayloadV2({
    provider: "defillama",
    url: "https://example.com/cache-stale",
    fetchImpl: (async () => new Response("{}", { headers: { "cf-cache-status": "STALE" } })) as typeof fetch,
    timeoutMs: 100,
    maxCacheAgeMs: 2 * 60 * 60 * 1_000,
  });
  assert.equal(explicitlyStale.ok, false);
  if (explicitlyStale.ok) assert.fail("explicitly stale cache unexpectedly succeeded");
  assert.equal(explicitlyStale.failure, "stale-cache");
});

test("malformed DefiLlama slugs fail closed without rejecting the provider fanout", async () => {
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === __providerAdapterTestV2.ENDPOINTS.defillama) {
      return response([null, { name: "Broken", slug: 7, category: "Lending", tvl: 1_000_000_000, change_1d: 5 }]);
    }
    if (url === __providerAdapterTestV2.ENDPOINTS.mempool) return response({ fastestFee: 25 });
    if (url === __providerAdapterTestV2.ENDPOINTS.coingecko) return response([{ id: "bitcoin", name: "Bitcoin", current_price: 62_500 }]);
    if (url === __providerAdapterTestV2.ENDPOINTS.rss) return response("<rss><item><title>Update</title><link>https://example.com/update</link></item></rss>");
    throw new Error(`unexpected URL ${url}`);
  }) as typeof fetch;

  const result = await collectEditorialEvidenceV2({ now: NOW, fetchImpl, cryptoCompareApiKey: "" });
  const provider = result.providers.find((row) => row.outcome.provider === "defillama");
  assert.ok(provider);
  assert.equal(provider.outcome.kind, "failure");
  if (provider.outcome.kind === "success") assert.fail("malformed summary unexpectedly succeeded");
  assert.equal(provider.outcome.failure, "parse-error");
  assert.equal(result.providers.some((row) => row.outcome.provider === "mempool.space" && row.outcome.kind === "success"), true);
  assert.equal(result.evidence.some((card) => card.source.provider === "defillama"), false);
});

test("provider cache ages use two-hour signal and six-hour news contracts", async () => {
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === __providerAdapterTestV2.ENDPOINTS.defillama) {
      return response([{ name: "Tracked", slug: "tracked", category: "Lending", tvl: 1_000_000_000, change_1d: 0 }]);
    }
    if (url === __providerAdapterTestV2.ENDPOINTS.mempool) {
      return new Response(JSON.stringify({ fastestFee: 25 }), { headers: { age: String(2 * 60 * 60 + 1) } });
    }
    if (url === __providerAdapterTestV2.ENDPOINTS.coingecko) {
      return new Response(JSON.stringify([{ id: "bitcoin", name: "Bitcoin", current_price: 62_500 }]), {
        headers: { age: String(2 * 60 * 60 + 1) },
      });
    }
    if (url === __providerAdapterTestV2.ENDPOINTS.rss) {
      return new Response("<rss><item><title>Update</title><link>https://example.com/update</link></item></rss>", {
        headers: { age: String(2 * 60 * 60 + 1) },
      });
    }
    if (url.startsWith(__providerAdapterTestV2.ENDPOINTS.cryptocompare)) {
      return new Response(JSON.stringify({ Response: "Success", Data: [{ title: "Update", url: "https://example.com/crypto" }] }), {
        headers: { age: String(6 * 60 * 60 + 1) },
      });
    }
    throw new Error(`unexpected URL ${url}`);
  }) as typeof fetch;

  const result = await collectEditorialEvidenceV2({
    now: NOW,
    fetchImpl,
    cryptoCompareApiKey: "configured",
    includeGenericCandidates: false,
  });
  const outcomes = Object.fromEntries(result.providers.map((row) => [
    row.outcome.provider,
    row.outcome.kind === "failure" ? row.outcome.failure : "ok",
  ]));
  assert.deepEqual(outcomes, {
    defillama: "ok",
    "mempool.space": "stale-cache",
    coingecko: "stale-cache",
    rss: "ok",
    cryptocompare: "stale-cache",
  });
});

test("explicit stale cache signals block both market and news providers", async () => {
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === __providerAdapterTestV2.ENDPOINTS.defillama) {
      return response([{ name: "Tracked", slug: "tracked", category: "Lending", tvl: 1_000_000_000, change_1d: 0 }]);
    }
    if (url === __providerAdapterTestV2.ENDPOINTS.mempool) return response({ fastestFee: 25 });
    if (url === __providerAdapterTestV2.ENDPOINTS.coingecko) {
      return new Response(JSON.stringify([{ id: "bitcoin", name: "Bitcoin", current_price: 62_500 }]), {
        headers: { "cf-cache-status": "UPDATING" },
      });
    }
    if (url === __providerAdapterTestV2.ENDPOINTS.rss) {
      return new Response("<rss><item><title>Update</title><link>https://example.com/update</link></item></rss>", {
        headers: { warning: '110 - "Response is stale"' },
      });
    }
    if (url.startsWith(__providerAdapterTestV2.ENDPOINTS.cryptocompare)) {
      return response({ Response: "Success", Data: [{ title: "Update", url: "https://example.com/crypto" }] });
    }
    throw new Error(`unexpected URL ${url}`);
  }) as typeof fetch;

  const result = await collectEditorialEvidenceV2({
    now: NOW,
    fetchImpl,
    cryptoCompareApiKey: "configured",
    includeGenericCandidates: false,
  });
  const outcomes = Object.fromEntries(result.providers.map((row) => [
    row.outcome.provider,
    row.outcome.kind === "failure" ? row.outcome.failure : "ok",
  ]));
  assert.equal(outcomes.coingecko, "stale-cache");
  assert.equal(outcomes.rss, "stale-cache");
  assert.equal(outcomes["mempool.space"], "ok");
  assert.equal(outcomes.cryptocompare, "ok");
});

test("malformed CoinGecko and CryptoCompare rows fail closed without rejecting provider fanout", async () => {
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === __providerAdapterTestV2.ENDPOINTS.defillama) {
      return response([{ name: "Tracked", slug: "tracked", category: "Lending", tvl: 1_000_000_000, change_1d: 0 }]);
    }
    if (url === __providerAdapterTestV2.ENDPOINTS.mempool) return response({ fastestFee: 25 });
    if (url === __providerAdapterTestV2.ENDPOINTS.coingecko) return response([null, 7, "broken"]);
    if (url === __providerAdapterTestV2.ENDPOINTS.rss) return response("<rss><item><title>Update</title><link>https://example.com/update</link></item></rss>");
    if (url.startsWith(__providerAdapterTestV2.ENDPOINTS.cryptocompare)) {
      return response({ Response: "Success", Data: [null, 7, "broken"] });
    }
    throw new Error(`unexpected URL ${url}`);
  }) as typeof fetch;

  const result = await collectEditorialEvidenceV2({
    now: NOW,
    fetchImpl,
    cryptoCompareApiKey: "configured",
    includeGenericCandidates: false,
  });
  const outcomes = Object.fromEntries(result.providers.map((row) => [
    row.outcome.provider,
    row.outcome.kind === "failure" ? row.outcome.failure : "ok",
  ]));
  assert.deepEqual(outcomes, {
    defillama: "ok",
    "mempool.space": "ok",
    coingecko: "parse-error",
    rss: "ok",
    cryptocompare: "parse-error",
  });
});

test("DefiLlama suppresses broad market repricing and keeps cross-sectional TVL outliers", async () => {
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === __providerAdapterTestV2.ENDPOINTS.defillama) {
      return response([
        ...Array.from({ length: 20 }, (_, index) => ({ name: `Common ${index}`, slug: `common-${index}`, category: "Lending", tvl: 1_000_000_000, change_1d: 4 })),
        { name: "Near Market", slug: "near-market", category: "Lending", tvl: 5_000_000_000, change_1d: 5 },
        { name: "True Outlier", slug: "true-outlier", category: "Lending", tvl: 2_000_000_000, change_1d: 8 },
      ]);
    }
    if (url === __providerAdapterTestV2.ENDPOINTS.defillamaProtocol("true-outlier")) {
      return response(quantityDrivenDetail(2_000_000_000, 8));
    }
    if (url === __providerAdapterTestV2.ENDPOINTS.mempool) return response({ fastestFee: 25 });
    if (url === __providerAdapterTestV2.ENDPOINTS.coingecko) return response([{ id: "bitcoin", name: "Bitcoin", current_price: 62_500 }]);
    if (url === __providerAdapterTestV2.ENDPOINTS.rss) return response("<rss><item><title>Update</title><link>https://example.com/update</link></item></rss>");
    throw new Error(`unexpected URL ${url}`);
  }) as typeof fetch;
  const result = await collectEditorialEvidenceV2({ now: NOW, fetchImpl, cryptoCompareApiKey: "" });
  const candidates = result.evidence.filter((card) => card.source.provider === "defillama");
  assert.deepEqual(candidates.map((card) => card.subject), ["True Outlier"]);
  assert.equal(candidates[0].selection?.benchmarkChangePercent, 4);
  assert.equal(candidates[0].selection?.residualPercentagePoints, 4);
  assert.ok((candidates[0].selection?.priceNeutral?.quantityChangePercent || 0) >= 2);
  assert.ok((candidates[0].selection?.priceNeutral?.quantityShare || 0) >= 0.5);
});

test("DefiLlama rejects an apparent TVL move explained by token price alone", async () => {
  const currentTvl = 2_106_400_000;
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === __providerAdapterTestV2.ENDPOINTS.defillama) {
      return response([{ name: "Lido-like", slug: "lido-like", category: "Liquid Staking", tvl: currentTvl, change_1d: 5.32 }]);
    }
    if (url === __providerAdapterTestV2.ENDPOINTS.defillamaProtocol("lido-like")) {
      const t1 = Date.parse(NOW) / 1_000;
      const t0 = t1 - 24 * 60 * 60;
      return response({
        tokens: [
          { date: t0, tokens: { WETH: 1_000_000 } },
          { date: t1, tokens: { WETH: 1_000_000 } },
        ],
        tokensInUsd: [
          { date: t0, tokens: { WETH: 2_000_000_000 } },
          { date: t1, tokens: { WETH: currentTvl } },
        ],
        tvl: [
          { date: t0, totalLiquidityUSD: 2_000_000_000 },
          { date: t1, totalLiquidityUSD: currentTvl },
        ],
      });
    }
    if (url === __providerAdapterTestV2.ENDPOINTS.mempool) return response({ fastestFee: 25 });
    if (url === __providerAdapterTestV2.ENDPOINTS.coingecko) return response([{ id: "bitcoin", name: "Bitcoin", current_price: 62_500 }]);
    if (url === __providerAdapterTestV2.ENDPOINTS.rss) return response("<rss><item><title>Update</title><link>https://example.com/update</link></item></rss>");
    throw new Error(`unexpected URL ${url}`);
  }) as typeof fetch;

  const result = await collectEditorialEvidenceV2({ now: NOW, fetchImpl, cryptoCompareApiKey: "" });
  const provider = result.providers.find((row) => row.outcome.provider === "defillama");
  assert.equal(result.evidence.some((card) => card.subject === "Lido-like"), false);
  assert.ok(provider?.selectionGaps?.some((gap) =>
    gap.subject === "Lido-like" && gap.reasons.includes("price-neutral-quantity-change-below-threshold")
  ));
});

test("DefiLlama detail qualification is bounded to six deterministic candidates", async () => {
  let defillamaCalls = 0;
  const coarse = Array.from({ length: 20 }, (_, index) => ({
    name: `Candidate ${index}`,
    slug: `candidate-${index}`,
    category: "Lending",
    tvl: 1_000_000_000 + index * 20_000_000,
    change_1d: 5 + index / 10,
  }));
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("https://api.llama.fi/")) defillamaCalls += 1;
    if (url === __providerAdapterTestV2.ENDPOINTS.defillama) {
      return response([
        ...Array.from({ length: 30 }, (_, index) => ({ name: `Common ${index}`, slug: `common-${index}`, category: "Lending", tvl: 500_000_000, change_1d: 0 })),
        ...coarse,
      ]);
    }
    const detailRow = coarse.find((row) => url === __providerAdapterTestV2.ENDPOINTS.defillamaProtocol(row.slug));
    if (detailRow) return response(quantityDrivenDetail(detailRow.tvl, detailRow.change_1d));
    if (url === __providerAdapterTestV2.ENDPOINTS.mempool) return response({ fastestFee: 25 });
    if (url === __providerAdapterTestV2.ENDPOINTS.coingecko) return response([{ id: "bitcoin", name: "Bitcoin", current_price: 62_500 }]);
    if (url === __providerAdapterTestV2.ENDPOINTS.rss) return response("<rss><item><title>Update</title><link>https://example.com/update</link></item></rss>");
    throw new Error(`unexpected URL ${url}`);
  }) as typeof fetch;

  const result = await collectEditorialEvidenceV2({ now: NOW, fetchImpl, cryptoCompareApiKey: "" });
  assert.equal(defillamaCalls, 1 + 6);
  assert.ok(result.evidence.filter((card) => card.source.provider === "defillama").length <= 5);
  const provider = result.providers.find((row) => row.outcome.provider === "defillama");
  assert.equal(provider?.selectionGaps?.filter((gap) => gap.reasons.includes("detail-budget-exhausted")).length, 14);
});

test("DefiLlama detail request limits preserve provider, sensing, and byte boundaries", () => {
  assert.deepEqual(__providerAdapterTestV2.defiLlamaDetailRequestLimitsV2({
    elapsedMs: 7_500,
    perProviderTimeoutMs: 8_000,
    sensingDeadlineMs: 15_000,
    cumulativePayloadBytes: 64 * 1024 * 1024 - 1_024,
  }), {
    timeoutMs: 500,
    maxResponseBytes: 1_024,
  });
  assert.deepEqual(__providerAdapterTestV2.defiLlamaDetailRequestLimitsV2({
    elapsedMs: 8_000,
    perProviderTimeoutMs: 8_000,
    sensingDeadlineMs: 15_000,
    cumulativePayloadBytes: 64 * 1024 * 1024,
  }), {
    timeoutMs: 0,
    maxResponseBytes: 0,
  });
});

test("DefiLlama detail timeout uses the remaining aggregate provider budget", async () => {
  let detailStartedAt = 0;
  let detailAbortedAt = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === __providerAdapterTestV2.ENDPOINTS.defillama) {
      await new Promise((resolve) => setTimeout(resolve, 160));
      return response([{ name: "Slow Detail", slug: "slow-detail", category: "Lending", tvl: 1_000_000_000, change_1d: 5 }]);
    }
    if (url === __providerAdapterTestV2.ENDPOINTS.defillamaProtocol("slow-detail")) {
      detailStartedAt = Date.now();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          detailAbortedAt = Date.now();
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    }
    if (url === __providerAdapterTestV2.ENDPOINTS.mempool) return response({ fastestFee: 25 });
    if (url === __providerAdapterTestV2.ENDPOINTS.coingecko) return response([{ id: "bitcoin", name: "Bitcoin", current_price: 62_500 }]);
    if (url === __providerAdapterTestV2.ENDPOINTS.rss) return response("<rss><item><title>Update</title><link>https://example.com/update</link></item></rss>");
    throw new Error(`unexpected URL ${url}`);
  }) as typeof fetch;

  const result = await collectEditorialEvidenceV2({
    now: NOW,
    fetchImpl,
    perProviderTimeoutMs: 220,
    sensingDeadlineMs: 1_000,
    cryptoCompareApiKey: "",
  });
  const provider = result.providers.find((row) => row.outcome.provider === "defillama");
  assert.equal(provider?.outcome.kind, "success");
  assert.ok(provider?.selectionGaps?.some((gap) =>
    gap.subject === "Slow Detail" && gap.reasons.includes("detail-timeout")
  ));
  assert.ok(detailStartedAt > 0 && detailAbortedAt >= detailStartedAt);
  assert.ok(detailAbortedAt - detailStartedAt < 140);
});

test("bodyless responses still enforce the decoded payload cap", async () => {
  const fetchImpl = (async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    body: null,
    text: async () => "12345",
  }) as Response) as typeof fetch;
  const result = await __providerAdapterTestV2.fetchPayloadV2({
    provider: "defillama",
    url: "https://example.com/bodyless",
    fetchImpl,
    timeoutMs: 100,
    maxResponseBytes: 4,
  });
  assert.equal(result.ok, false);
  if (result.ok) assert.fail("oversized bodyless response unexpectedly succeeded");
  assert.equal(result.failure, "payload-too-large");
  assert.equal(result.payloadBytes, 5);
});

test("one oversized DefiLlama detail blocks only that candidate", async () => {
  let oversizedBodyCancelled = false;
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === __providerAdapterTestV2.ENDPOINTS.defillama) {
      return response([
        { name: "Oversized", slug: "oversized", category: "Lending", tvl: 2_000_000_000, change_1d: 8 },
        { name: "Healthy", slug: "healthy", category: "Lending", tvl: 1_000_000_000, change_1d: 6 },
      ]);
    }
    if (url === __providerAdapterTestV2.ENDPOINTS.defillamaProtocol("oversized")) {
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{}"));
        },
        cancel() {
          oversizedBodyCancelled = true;
        },
      }), {
        status: 200,
        headers: { "content-length": String(33 * 1024 * 1024) },
      });
    }
    if (url === __providerAdapterTestV2.ENDPOINTS.defillamaProtocol("healthy")) {
      return response(quantityDrivenDetail(1_000_000_000, 6));
    }
    if (url === __providerAdapterTestV2.ENDPOINTS.mempool) return response({ fastestFee: 25 });
    if (url === __providerAdapterTestV2.ENDPOINTS.coingecko) return response([{ id: "bitcoin", name: "Bitcoin", current_price: 62_500 }]);
    if (url === __providerAdapterTestV2.ENDPOINTS.rss) return response("<rss><item><title>Update</title><link>https://example.com/update</link></item></rss>");
    throw new Error(`unexpected URL ${url}`);
  }) as typeof fetch;

  const result = await collectEditorialEvidenceV2({ now: NOW, fetchImpl, cryptoCompareApiKey: "" });
  const provider = result.providers.find((row) => row.outcome.provider === "defillama");
  assert.equal(provider?.outcome.kind, "success");
  assert.deepEqual(
    result.evidence.filter((card) => card.source.provider === "defillama").map((card) => card.subject),
    ["Healthy"]
  );
  assert.ok(provider?.selectionGaps?.some((gap) =>
    gap.subject === "Oversized" && gap.reasons.includes("detail-payload-too-large")
  ));
  assert.equal(oversizedBodyCancelled, true);
});

test("401, 429, empty and parse failures remain distinct", async () => {
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("llama")) return response("nope");
    if (url.includes("mempool")) return response({}, 429);
    if (url.includes("coingecko")) return response([], 200);
    if (url.includes("coindesk")) return response("", 200);
    if (url.includes("cryptocompare")) return response({}, 401);
    throw new Error("unexpected");
  }) as typeof fetch;
  const result = await collectEditorialEvidenceV2({ now: NOW, fetchImpl, cryptoCompareApiKey: "configured" });
  const failures = Object.fromEntries(result.providers.map((row) => [row.outcome.provider, row.outcome.kind === "failure" ? row.outcome.failure : "ok"]));
  assert.deepEqual(failures, { defillama: "parse-error", "mempool.space": "rate-limited", coingecko: "empty", rss: "empty", cryptocompare: "unauthorized" });
  assert.equal(result.evidence.length, 0);
});

test("provider timeout is classified and does not become neutral evidence", async () => {
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  })) as typeof fetch;
  const result = await collectEditorialEvidenceV2({ now: NOW, fetchImpl, perProviderTimeoutMs: 5, cryptoCompareApiKey: "" });
  assert.equal(result.evidence.length, 0);
  assert.equal(result.providers.filter((row) => row.outcome.kind === "failure" && row.outcome.failure === "timeout").length, 4);
});
