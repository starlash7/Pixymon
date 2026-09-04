import assert from "node:assert/strict";
import {
  __providerAdapterTestV2,
  collectEditorialEvidenceV2,
} from "../src/services/editorial-v2/provider-adapters.js";
import type { EvidenceCardV2 } from "../src/services/editorial-v2/evidence.js";
import { planEditorialV2 } from "../src/services/editorial-v2/planner.js";

const NOW = "2026-08-28T10:00:00.000Z";
const HOUR_MS = 60 * 60 * 1000;

interface GoldenCase {
  name: string;
  run: () => void | Promise<void>;
}

export interface OfflineGoldenReportV2 {
  provider: { passed: number; total: 12 };
  planner: { passed: number; total: 36 };
  dispatch: { passed: number; total: 16; mockedLiveCreateCalls: number };
  total: { passed: number; total: 64 };
}

function response(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

function quantityDrivenDefiDetail(tvl: number, changePercent: number): unknown {
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

function healthyProviderFetch(options: { cryptoCompare?: boolean } = {}): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === __providerAdapterTestV2.ENDPOINTS.defillama) {
      return response([{ name: "Aave V3", slug: "aave-v3", category: "Lending", tvl: 50_000_000_000, change_1d: 4.2 }]);
    }
    if (url === __providerAdapterTestV2.ENDPOINTS.defillamaProtocol("aave-v3")) {
      return response(quantityDrivenDefiDetail(50_000_000_000, 4.2));
    }
    if (url === __providerAdapterTestV2.ENDPOINTS.mempool) {
      return response({ fastestFee: 25 });
    }
    if (url === __providerAdapterTestV2.ENDPOINTS.coingecko) {
      return response([
        {
          id: "bitcoin",
          name: "Bitcoin",
          current_price: 62_500,
          price_change_percentage_24h: 2,
        },
      ]);
    }
    if (url === __providerAdapterTestV2.ENDPOINTS.rss) {
      return response(
        "<rss><item><title>Aave governance update</title><link>https://example.invalid/aave</link><pubDate>Fri, 28 Aug 2026 09:00:00 GMT</pubDate></item></rss>"
      );
    }
    if (options.cryptoCompare && url.startsWith(__providerAdapterTestV2.ENDPOINTS.cryptocompare)) {
      return response({
        Response: "Success",
        Data: [
          {
            title: "Synthetic protocol update",
            url: "https://example.invalid/cryptocompare-item",
            published_on: Math.floor(Date.parse(NOW) / 1000),
          },
        ],
      });
    }
    throw new Error(`unexpected mocked provider URL: ${url}`);
  }) as typeof fetch;
}

function providerCases(): GoldenCase[] {
  return [
    {
      name: "DefiLlama yields direct numeric evidence",
      run: async () => {
        const result = await collectEditorialEvidenceV2({
          now: NOW,
          fetchImpl: healthyProviderFetch(),
          cryptoCompareApiKey: "",
        });
        const row = result.evidence.find((card) => card.source.provider === "defillama");
        assert.equal(row?.subject, "Aave V3");
        assert.equal(row?.metric.raw, "+4.20%");
        assert.equal(row?.source.origin, "direct");
        assert.equal(row?.source.role, "primary");
      },
    },
    {
      name: "mempool.space yields a sat/vB fact",
      run: async () => {
        const result = await collectEditorialEvidenceV2({
          now: NOW,
          fetchImpl: healthyProviderFetch(),
          cryptoCompareApiKey: "",
        });
        const row = result.evidence.find((card) => card.source.provider === "mempool.space");
        assert.equal(row?.metric.raw, "25 sat/vB");
        assert.equal(row?.lane, "onchain");
        assert.equal(row?.source.role, "discovery");
      },
    },
    {
      name: "CoinGecko yields a named USD fact",
      run: async () => {
        const result = await collectEditorialEvidenceV2({
          now: NOW,
          fetchImpl: healthyProviderFetch(),
          cryptoCompareApiKey: "",
        });
        const row = result.evidence.find((card) => card.source.provider === "coingecko");
        assert.equal(row?.subject, "Bitcoin");
        assert.equal(row?.metric.raw, "$62,500");
        assert.equal(row?.source.role, "discovery");
      },
    },
    {
      name: "RSS remains discovery-only",
      run: async () => {
        const result = await collectEditorialEvidenceV2({
          now: NOW,
          fetchImpl: healthyProviderFetch(),
          cryptoCompareApiKey: "",
        });
        assert.equal(result.evidence.some((card) => card.source.provider === "rss"), false);
        assert.equal(result.discoveries.filter((row) => row.provider === "rss").length, 1);
      },
    },
    {
      name: "unconfigured CryptoCompare is explicit",
      run: async () => {
        const result = await collectEditorialEvidenceV2({
          now: NOW,
          fetchImpl: healthyProviderFetch(),
          cryptoCompareApiKey: "",
        });
        const row = result.providers.find((provider) => provider.outcome.provider === "cryptocompare");
        assert.ok(row && row.outcome.kind === "failure");
        if (row.outcome.kind === "failure") assert.equal(row.outcome.failure, "not-configured");
      },
    },
    {
      name: "configured CryptoCompare remains discovery-only",
      run: async () => {
        const result = await collectEditorialEvidenceV2({
          now: NOW,
          fetchImpl: healthyProviderFetch({ cryptoCompare: true }),
          cryptoCompareApiKey: "fixture-key",
        });
        assert.equal(result.evidence.some((card) => card.source.provider === "cryptocompare"), false);
        assert.equal(result.discoveries.filter((row) => row.provider === "cryptocompare").length, 1);
      },
    },
    {
      name: "401 is classified as unauthorized",
      run: async () => {
        const fetchImpl = (async () => response({}, 401)) as typeof fetch;
        const result = await collectEditorialEvidenceV2({
          now: NOW,
          fetchImpl,
          cryptoCompareApiKey: "fixture-key",
        });
        assert.equal(
          result.providers.every(
            (row) => row.outcome.kind === "failure" && row.outcome.failure === "unauthorized"
          ),
          true
        );
      },
    },
    {
      name: "429 is classified as rate-limited",
      run: async () => {
        const fetchImpl = (async () => response({}, 429)) as typeof fetch;
        const result = await collectEditorialEvidenceV2({
          now: NOW,
          fetchImpl,
          cryptoCompareApiKey: "fixture-key",
        });
        assert.equal(
          result.providers.every(
            (row) => row.outcome.kind === "failure" && row.outcome.failure === "rate-limited"
          ),
          true
        );
      },
    },
    {
      name: "malformed JSON is a parse error",
      run: async () => {
        const fetchImpl = (async (input: string | URL | Request) =>
          String(input).includes("coindesk") ? response("<rss></rss>") : response("not-json")) as typeof fetch;
        const result = await collectEditorialEvidenceV2({
          now: NOW,
          fetchImpl,
          cryptoCompareApiKey: "fixture-key",
        });
        const row = result.providers.find((provider) => provider.outcome.provider === "defillama");
        assert.ok(row && row.outcome.kind === "failure");
        if (row.outcome.kind === "failure") assert.equal(row.outcome.failure, "parse-error");
      },
    },
    {
      name: "empty payload is not neutral evidence",
      run: async () => {
        const fetchImpl = (async () => response("")) as typeof fetch;
        const result = await collectEditorialEvidenceV2({
          now: NOW,
          fetchImpl,
          cryptoCompareApiKey: "fixture-key",
        });
        assert.equal(result.evidence.length, 0);
        assert.equal(
          result.providers.every(
            (row) => row.outcome.kind === "failure" && row.outcome.failure === "empty"
          ),
          true
        );
      },
    },
    {
      name: "network error remains distinct",
      run: async () => {
        const fetchImpl = (async () => {
          throw new TypeError("fixture network failure");
        }) as typeof fetch;
        const result = await collectEditorialEvidenceV2({
          now: NOW,
          fetchImpl,
          cryptoCompareApiKey: "fixture-key",
        });
        assert.equal(
          result.providers.every(
            (row) => row.outcome.kind === "failure" && row.outcome.failure === "network-error"
          ),
          true
        );
      },
    },
    {
      name: "timeout remains distinct",
      run: async () => {
        const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(Object.assign(new Error("fixture timeout"), { name: "AbortError" }));
            });
          })) as typeof fetch;
        const result = await collectEditorialEvidenceV2({
          now: NOW,
          fetchImpl,
          cryptoCompareApiKey: "fixture-key",
          perProviderTimeoutMs: 2,
        });
        assert.equal(
          result.providers.every(
            (row) => row.outcome.kind === "failure" && row.outcome.failure === "timeout"
          ),
          true
        );
      },
    },
  ];
}

function card(overrides: Partial<EvidenceCardV2> = {}): EvidenceCardV2 {
  const base: EvidenceCardV2 = {
    schemaVersion: 2,
    id: "fact:ethereum:tvl",
    lane: "protocol",
    kind: "signal",
    subject: "Ethereum",
    metric: {
      name: "tvl-change-24h",
      value: 8.4,
      raw: "+8.4%",
      unit: "%",
      period: "24h",
    },
    source: {
      provider: "defillama",
      url: "https://api.llama.fi/v2/chains",
      publishedAt: null,
      observedAt: "2026-08-28T09:30:00.000Z",
      origin: "direct",
      role: "primary",
    },
    freshness: {
      kind: "signal",
      measuredAt: "2026-08-28T09:30:00.000Z",
      maxAgeMs: 2 * HOUR_MS,
      ageMs: 30 * 60 * 1000,
      state: "fresh",
    },
    providerHealth: {
      provider: "defillama",
      state: "green",
      reason: "ok",
      checkedAt: NOW,
      latencyMs: 10,
      itemCount: 1,
    },
    provenance: { kind: "onchain-nutrient", sourceId: "ethereum:tvl" },
  };
  return { ...base, ...overrides };
}

function assertBlocked(
  result: ReturnType<typeof planEditorialV2>,
  stage: "eligibility" | "followup" | "novelty",
  reason: "no-tier-a-evidence" | "followup-no-change" | "subject-repeat-without-delta",
  blockReason?: string
): void {
  assert.equal(result.status, "blocked");
  assert.equal(result.stage, stage);
  assert.equal(result.reason, reason);
  if (blockReason) assert.ok(result.blockReasons.includes(blockReason));
}

function plannerCases(): GoldenCase[] {
  const recentHistory = [
    {
      subject: "Ethereum",
      metricName: "tvl-change-24h",
      metricValue: 8.4,
      factId: "old-fact",
      publishedAt: "2026-08-28T01:00:00.000Z",
    },
  ];
  const due24 = [
    {
      draftId: "draft-24",
      subject: "Ethereum",
      metricName: "tvl-change-24h",
      baselineValue: 8.4,
      dueAt: "2026-08-28T09:00:00.000Z",
      checkpoint: "24h" as const,
    },
  ];
  const due72 = [{ ...due24[0], draftId: "draft-72", checkpoint: "72h" as const }];

  return [
    {
      name: "moderate Tier A fact plans a Withhold",
      run: () => {
        const result = planEditorialV2({ evidence: [card()], now: NOW });
        assert.equal(result.status, "planned");
        if (result.status === "planned") assert.equal(result.plan.format, "withhold");
      },
    },
    {
      name: "negative fact plans a Withhold",
      run: () => {
        const result = planEditorialV2({
          evidence: [card({ metric: { ...card().metric, value: -2.1, raw: "-2.1%" } })],
          now: NOW,
        });
        assert.equal(result.status, "planned");
        if (result.status === "planned") {
          assert.equal(result.plan.format, "withhold");
          assert.equal(result.plan.voiceState, "skeptical");
        }
      },
    },
    {
      name: "large fact uses energized voice",
      run: () => {
        const result = planEditorialV2({
          evidence: [card({ metric: { ...card().metric, value: 12.5, raw: "+12.5%" } })],
          now: NOW,
        });
        assert.equal(result.status, "planned");
        if (result.status === "planned") assert.equal(result.plan.voiceState, "energized");
      },
    },
    {
      name: "small positive fact uses curious voice",
      run: () => {
        const result = planEditorialV2({
          evidence: [card({ metric: { ...card().metric, value: 1.5, raw: "+1.5%" } })],
          now: NOW,
        });
        assert.equal(result.status, "planned");
        if (result.status === "planned") assert.equal(result.plan.voiceState, "curious");
      },
    },
    {
      name: "fresher evidence wins",
      run: () => {
        const older = card({ id: "older" });
        const fresher = card({
          id: "fresher",
          subject: "Solana",
          source: { ...card().source, observedAt: "2026-08-28T09:55:00.000Z" },
        });
        const result = planEditorialV2({ evidence: [older, fresher], now: NOW, selectionSeed: "fixed" });
        assert.equal(result.status, "planned");
        if (result.status === "planned") assert.equal(result.evidence.id, "fresher");
      },
    },
    {
      name: "seeded tie is deterministic for 100 runs",
      run: () => {
        const input = {
          evidence: [card(), card({ id: "fact:solana:tvl", subject: "Solana" })],
          now: NOW,
          selectionSeed: "fixed-seed",
        };
        const expected = planEditorialV2(input);
        for (let index = 0; index < 100; index += 1) {
          assert.deepEqual(planEditorialV2(input), expected);
        }
      },
    },
    {
      name: "changed 24h revisit takes priority",
      run: () => {
        const changed = card({ metric: { ...card().metric, value: 6.1, raw: "+6.1%" } });
        const result = planEditorialV2({ evidence: [changed], followUpEvidence: [changed], dueRevisits: due24, now: NOW });
        assert.equal(result.status, "planned");
        if (result.status === "planned") {
          assert.equal(result.plan.format, "revisit");
          assert.equal(result.plan.continuityThread, "draft-24:24h");
        }
      },
    },
    {
      name: "72h revisit closes even without a delta",
      run: () => {
        const result = planEditorialV2({ evidence: [card()], followUpEvidence: [card()], dueRevisits: due72, now: NOW });
        assert.equal(result.status, "planned");
        if (result.status === "planned") assert.equal(result.plan.format, "revisit");
      },
    },
    {
      name: "unchanged 24h revisit stays silent",
      run: () => assertBlocked(
        planEditorialV2({ evidence: [card()], followUpEvidence: [card()], dueRevisits: due24, now: NOW }),
        "followup",
        "followup-no-change",
        "24h-no-meaningful-change"
      ),
    },
    {
      name: "same subject and value within 24h is blocked",
      run: () => assertBlocked(
        planEditorialV2({ evidence: [card()], history: recentHistory, now: NOW }),
        "novelty",
        "subject-repeat-without-delta",
        "numeric-delta-missing"
      ),
    },
    {
      name: "same subject with a new value is allowed",
      run: () => {
        const result = planEditorialV2({
          evidence: [card({ metric: { ...card().metric, value: 9.1, raw: "+9.1%" } })],
          history: recentHistory,
          now: NOW,
        });
        assert.equal(result.status, "planned");
      },
    },
    {
      name: "history outside 24h does not block",
      run: () => {
        const history = [{ ...recentHistory[0], publishedAt: "2026-08-27T09:59:59.000Z" }];
        assert.equal(planEditorialV2({ evidence: [card()], history, now: NOW }).status, "planned");
      },
    },
    {
      name: "derived evidence hard-fails",
      run: () => assertBlocked(
        planEditorialV2({ evidence: [card({ source: { ...card().source, origin: "derived" } })], now: NOW }),
        "eligibility",
        "no-tier-a-evidence",
        "not-direct"
      ),
    },
    {
      name: "discovery evidence hard-fails",
      run: () => assertBlocked(
        planEditorialV2({ evidence: [card({ source: { ...card().source, role: "discovery" } })], now: NOW }),
        "eligibility",
        "no-tier-a-evidence",
        "discovery-only"
      ),
    },
    {
      name: "RSS evidence hard-fails",
      run: () => {
        const source = { ...card().source, provider: "rss" as const, role: "discovery" as const };
        const providerHealth = { ...card().providerHealth, provider: "rss" as const };
        assertBlocked(
          planEditorialV2({ evidence: [card({ source, providerHealth })], now: NOW }),
          "eligibility",
          "no-tier-a-evidence",
          "rss-discovery-only"
        );
      },
    },
    {
      name: "yellow provider hard-fails",
      run: () => assertBlocked(
        planEditorialV2({
          evidence: [card({ providerHealth: { ...card().providerHealth, state: "yellow", reason: "timeout" } })],
          now: NOW,
        }),
        "eligibility",
        "no-tier-a-evidence",
        "provider-not-green"
      ),
    },
    {
      name: "red provider hard-fails",
      run: () => assertBlocked(
        planEditorialV2({
          evidence: [card({ providerHealth: { ...card().providerHealth, state: "red", reason: "parse-error" } })],
          now: NOW,
        }),
        "eligibility",
        "no-tier-a-evidence",
        "provider-not-green"
      ),
    },
    {
      name: "generic subject hard-fails",
      run: () => assertBlocked(
        planEditorialV2({ evidence: [card({ subject: "시장" })], now: NOW }),
        "eligibility",
        "no-tier-a-evidence",
        "subject-not-named"
      ),
    },
    {
      name: "invalid source URL hard-fails",
      run: () => assertBlocked(
        planEditorialV2({ evidence: [card({ source: { ...card().source, url: "not-a-url" } })], now: NOW }),
        "eligibility",
        "no-tier-a-evidence",
        "source-url-invalid"
      ),
    },
    {
      name: "stale signal hard-fails",
      run: () => assertBlocked(
        planEditorialV2({
          evidence: [card({ source: { ...card().source, observedAt: "2026-08-28T07:59:59.000Z" } })],
          now: NOW,
        }),
        "eligibility",
        "no-tier-a-evidence",
        "stale"
      ),
    },
    {
      name: "future signal hard-fails",
      run: () => assertBlocked(
        planEditorialV2({
          evidence: [card({ source: { ...card().source, observedAt: "2026-08-28T10:00:01.000Z" } })],
          now: NOW,
        }),
        "eligibility",
        "no-tier-a-evidence",
        "future-timestamp"
      ),
    },
    {
      name: "missing metric name hard-fails",
      run: () => assertBlocked(
        planEditorialV2({ evidence: [card({ metric: { ...card().metric, name: "" } })], now: NOW }),
        "eligibility",
        "no-tier-a-evidence",
        "metric-metadata-missing"
      ),
    },
    {
      name: "raw fact without a digit hard-fails",
      run: () => assertBlocked(
        planEditorialV2({ evidence: [card({ metric: { ...card().metric, raw: "상승" } })], now: NOW }),
        "eligibility",
        "no-tier-a-evidence",
        "numeric-fact-missing"
      ),
    },
    {
      name: "invalid observed time hard-fails",
      run: () => assertBlocked(
        planEditorialV2({ evidence: [card({ source: { ...card().source, observedAt: "invalid" } })], now: NOW }),
        "eligibility",
        "no-tier-a-evidence",
        "source-time-invalid"
      ),
    },
    {
      name: "provider-health mismatch hard-fails",
      run: () => assertBlocked(
        planEditorialV2({
          evidence: [card({ providerHealth: { ...card().providerHealth, provider: "coingecko" } })],
          now: NOW,
        }),
        "eligibility",
        "no-tier-a-evidence",
        "provider-health-mismatch"
      ),
    },
    {
      name: "news without publishedAt hard-fails",
      run: () => assertBlocked(
        planEditorialV2({ evidence: [card({ kind: "news" })], now: NOW }),
        "eligibility",
        "no-tier-a-evidence",
        "source-time-invalid"
      ),
    },
    {
      name: "stale news hard-fails at six hours",
      run: () => assertBlocked(
        planEditorialV2({
          evidence: [card({
            kind: "news",
            source: {
              ...card().source,
              publishedAt: "2026-08-28T03:59:59.000Z",
              observedAt: "2026-08-28T09:30:00.000Z",
            },
          })],
          now: NOW,
        }),
        "eligibility",
        "no-tier-a-evidence",
        "stale"
      ),
    },
    {
      name: "fresh direct news can plan",
      run: () => {
        const result = planEditorialV2({
          evidence: [card({
            kind: "news",
            source: { ...card().source, publishedAt: "2026-08-28T05:00:00.000Z" },
          })],
          now: NOW,
        });
        assert.equal(result.status, "planned");
      },
    },
    {
      name: "empty evidence records an eligibility no-post",
      run: () => assertBlocked(
        planEditorialV2({ evidence: [], now: NOW }),
        "eligibility",
        "no-tier-a-evidence"
      ),
    },
    {
      name: "future revisit does not preempt a fresh post",
      run: () => {
        const future = [{ ...due24[0], dueAt: "2026-08-28T11:00:00.000Z" }];
        const result = planEditorialV2({ evidence: [card()], dueRevisits: future, now: NOW });
        assert.equal(result.status, "planned");
        if (result.status === "planned") assert.equal(result.plan.format, "withhold");
      },
    },
    {
      name: "unmatched revisit does not preempt a fresh post",
      run: () => {
        const unmatched = [{ ...due24[0], subject: "Solana" }];
        const result = planEditorialV2({ evidence: [card()], dueRevisits: unmatched, now: NOW });
        assert.equal(result.status, "planned");
        if (result.status === "planned") assert.equal(result.plan.format, "withhold");
      },
    },
    {
      name: "earliest matching revisit wins",
      run: () => {
        const solana = card({
          id: "solana",
          subject: "Solana",
          metric: { ...card().metric, value: 7.9, raw: "+7.9%" },
        });
        const ethereumChanged = card({ metric: { ...card().metric, value: 9.2, raw: "+9.2%" } });
        const due = [
          { ...due24[0], draftId: "later", dueAt: "2026-08-28T09:30:00.000Z" },
          { ...due24[0], draftId: "earlier", subject: "Solana", dueAt: "2026-08-28T08:30:00.000Z" },
        ];
        const result = planEditorialV2({ evidence: [ethereumChanged, solana], followUpEvidence: [ethereumChanged, solana], dueRevisits: due, now: NOW });
        assert.equal(result.status, "planned");
        if (result.status === "planned") assert.equal(result.plan.continuityThread, "earlier:24h");
      },
    },
    {
      name: "freshness outranks seeded tie breaking",
      run: () => {
        const first = card({ id: "first", subject: "FirstChain" });
        const fresh = card({
          id: "fresh",
          subject: "FreshChain",
          source: { ...card().source, observedAt: "2026-08-28T09:59:00.000Z" },
        });
        for (const seed of ["a", "b", "c", "d"]) {
          const result = planEditorialV2({ evidence: [first, fresh], now: NOW, selectionSeed: seed });
          assert.equal(result.status, "planned");
          if (result.status === "planned") assert.equal(result.evidence.id, "fresh");
        }
      },
    },
    {
      name: "same subject with a different metric is novel",
      run: () => {
        const changedMetric = card({
          id: "fact:ethereum:fees",
          metric: { name: "median-fee", value: 8.4, raw: "8.4 gwei", unit: "gwei", period: "snapshot" },
        });
        assert.equal(
          planEditorialV2({ evidence: [changedMetric], history: recentHistory, now: NOW }).status,
          "planned"
        );
      },
    },
    {
      name: "new fact ID alone is not a numeric delta",
      run: () => assertBlocked(
        planEditorialV2({ evidence: [card({ id: "new-id" })], history: recentHistory, now: NOW }),
        "novelty",
        "subject-repeat-without-delta"
      ),
    },
    {
      name: "zero metric has an equality falsifier",
      run: () => {
        const result = planEditorialV2({
          evidence: [card({ metric: { ...card().metric, value: 0, raw: "0.0%" } })],
          now: NOW,
        });
        assert.equal(result.status, "planned");
        if (result.status === "planned") {
          assert.equal(result.plan.format, "withhold");
          assert.equal(result.plan.falsifier.comparator, "eq");
        }
      },
    },
  ];
}

function dispatchCases(
  dispatchXWrite: (
    kind: string,
    liveCreate: () => Promise<string | null>
  ) => Promise<{ mode: string; id: string | null; simulated: boolean }>,
  onMockedLiveCreate: () => void
): GoldenCase[] {
  const surfaces = ["post", "quote", "reply", "revisit-post"] as const;
  const modes = ["observe", "paper", "live", "unexpected"] as const;
  return surfaces.flatMap((surface) =>
    modes.map((mode) => ({
      name: `${surface} obeys ${mode} mode`,
      run: async () => {
        const previous = process.env.ACTION_MODE;
        process.env.ACTION_MODE = mode;
        let localCalls = 0;
        const originalLog = console.log;
        console.log = () => undefined;
        try {
          const result = await dispatchXWrite(surface, async () => {
            localCalls += 1;
            onMockedLiveCreate();
            return `mock-${surface}`;
          });
          if (mode === "live") {
            assert.deepEqual(result, {
              mode: "live",
              id: `mock-${surface}`,
              simulated: false,
            });
            assert.equal(localCalls, 1);
          } else if (mode === "paper") {
            assert.equal(result.mode, "paper");
            assert.equal(result.simulated, true);
            assert.match(String(result.id), /^paper_\d+$/);
            assert.equal(localCalls, 0);
          } else {
            assert.deepEqual(result, { mode: "observe", id: null, simulated: false });
            assert.equal(localCalls, 0);
          }
        } finally {
          console.log = originalLog;
          if (typeof previous === "undefined") delete process.env.ACTION_MODE;
          else process.env.ACTION_MODE = previous;
        }
      },
    }))
  );
}

async function runCases(cases: GoldenCase[]): Promise<number> {
  let passed = 0;
  for (const fixture of cases) {
    try {
      await fixture.run();
      passed += 1;
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      throw new Error(`golden fixture failed: ${fixture.name}: ${cause}`, { cause: error });
    }
  }
  return passed;
}

export async function runOfflineGoldenV2(): Promise<OfflineGoldenReportV2> {
  const provider = providerCases();
  const planner = plannerCases();
  assert.equal(provider.length, 12, "provider golden count drifted");
  assert.equal(planner.length, 36, "planner golden count drifted");

  const providerPassed = await runCases(provider);
  const plannerPassed = await runCases(planner);

  const { dispatchXWrite } = await import("../src/services/twitter.js");
  let mockedLiveCreateCalls = 0;
  const dispatch = dispatchCases(dispatchXWrite, () => {
    mockedLiveCreateCalls += 1;
  });
  assert.equal(dispatch.length, 16, "dispatch golden count drifted");
  const dispatchPassed = await runCases(dispatch);

  const passed = providerPassed + plannerPassed + dispatchPassed;
  assert.equal(passed, 64);
  assert.equal(mockedLiveCreateCalls, 4, "only four live-mode callbacks should run");
  return {
    provider: { passed: providerPassed, total: 12 },
    planner: { passed: plannerPassed, total: 36 },
    dispatch: { passed: dispatchPassed, total: 16, mockedLiveCreateCalls },
    total: { passed, total: 64 },
  };
}
