import {
  NEWS_FRESHNESS_MS,
  SIGNAL_FRESHNESS_MS,
  evaluateEvidenceFreshnessV2,
  type EvidenceCardV2,
  type EvidenceLaneV2,
} from "./evidence.js";
import {
  providerFailureCodeFromHttpStatusV2,
  providerHealthFromOutcomeV2,
  type EvidenceProviderV2,
  type ProviderFailureCodeV2,
  type ProviderFetchOutcomeV2,
} from "./provider-health.js";
import {
  evaluateDefiLlamaPriceNeutralV2,
  type DefiLlamaPriceNeutralMetricsV2,
} from "./defillama-price-neutral.js";

export const PROVIDER_TIMEOUT_MS_V2 = 8_000;
export const SENSING_DEADLINE_MS_V2 = 15_000;
export const DEFILLAMA_DETAIL_CANDIDATE_LIMIT_V2 = 6;
export const DEFILLAMA_DETAIL_CONCURRENCY_V2 = 3;
export const DEFILLAMA_DETAIL_ROTATION_BUCKET_MS_V2 = SIGNAL_FRESHNESS_MS;
export const DEFILLAMA_DETAIL_RESPONSE_LIMIT_BYTES_V2 = 32 * 1024 * 1024;
export const DEFILLAMA_DETAIL_RUN_LIMIT_BYTES_V2 = 64 * 1024 * 1024;

const PROVIDER_RESPONSE_LIMIT_BYTES_V2 = {
  defillamaSummary: 16 * 1024 * 1024,
  mempool: 64 * 1024,
  coingecko: 1024 * 1024,
  rss: 4 * 1024 * 1024,
  cryptocompare: 4 * 1024 * 1024,
} as const;

const ENDPOINTS = {
  defillama: "https://api.llama.fi/protocols",
  defillamaProtocol: (subjectKey: string) =>
    `https://api.llama.fi/protocol/${encodeURIComponent(subjectKey)}`,
  mempool: "https://mempool.space/api/v1/fees/recommended",
  coingecko: "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=10&page=1&sparkline=false&price_change_percentage=24h",
  rss: "https://www.coindesk.com/arc/outboundfeeds/rss",
  cryptocompare: "https://min-api.cryptocompare.com/data/v2/news/?lang=EN&sortOrder=popular",
} as const;

export interface EditorialDiscoveryV2 {
  provider: "rss" | "cryptocompare";
  title: string;
  url: string;
  publishedAt: string | null;
  blockReason: "discovery-only";
}

export interface ProviderAdapterResultV2 {
  outcome: ProviderFetchOutcomeV2;
  evidence: EvidenceCardV2[];
  /** Fresh measurements requested for already-published follow-ups; never generic candidates. */
  observations: EvidenceCardV2[];
  discoveries: EditorialDiscoveryV2[];
  selectionGaps?: ProviderSelectionGapV2[];
  /** Anonymous class-level diagnostics used to decide whether pinned anchors waste supply. */
  selectionClassSummary?: ProviderSelectionClassSummaryV2[];
}

export type DefiLlamaSelectionClassV2 =
  | "anchor-absolute"
  | "anchor-relative"
  | "anchor-residual"
  | "rotation";

export interface ProviderSelectionClassSummaryV2 {
  selectionClass: DefiLlamaSelectionClassV2;
  attempted: number;
  qualified: number;
  gapSummary: readonly string[];
}

export interface ProviderSelectionGapV2 {
  subject: string;
  subjectKey?: string;
  reasons: readonly string[];
  latencyMs?: number;
  payloadBytes?: number;
}

export interface EditorialSensingResultV2 {
  evidence: EvidenceCardV2[];
  observations: EvidenceCardV2[];
  discoveries: EditorialDiscoveryV2[];
  providers: ProviderAdapterResultV2[];
}

export interface EditorialFollowUpTargetV2 {
  provider: EvidenceProviderV2;
  subject: string;
  subjectKey?: string;
  metricName: string;
  unit: string;
  period: string;
}

export interface EditorialProviderContextV2 {
  now: string;
  fetchImpl?: typeof fetch;
  perProviderTimeoutMs?: number;
  sensingDeadlineMs?: number;
  cryptoCompareApiKey?: string;
  followUpTargets?: readonly EditorialFollowUpTargetV2[];
  /** Follow-up/revalidation workers disable this to avoid unrelated detail fetches. */
  includeGenericCandidates?: boolean;
  /** Stable test/audit seed; production rotation otherwise uses a fixed namespace. */
  selectionSeed?: string;
}

type FetchResultV2 =
  | { ok: true; value: unknown; latencyMs: number; payloadBytes: number }
  | { ok: false; failure: ProviderFailureCodeV2; latencyMs: number; payloadBytes: number; statusCode?: number };

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defiLlamaDetailRequestLimitsV2(input: {
  elapsedMs: number;
  perProviderTimeoutMs: number;
  sensingDeadlineMs: number;
  cumulativePayloadBytes: number;
  payloadBudgetBytes?: number;
}): { timeoutMs: number; maxResponseBytes: number } {
  const payloadBudgetBytes = input.payloadBudgetBytes ?? DEFILLAMA_DETAIL_RUN_LIMIT_BYTES_V2;
  return {
    timeoutMs: Math.max(0, Math.min(
      input.perProviderTimeoutMs - input.elapsedMs,
      input.sensingDeadlineMs - input.elapsedMs
    )),
    maxResponseBytes: Math.max(0, Math.min(
      DEFILLAMA_DETAIL_RESPONSE_LIMIT_BYTES_V2,
      payloadBudgetBytes - input.cumulativePayloadBytes
    )),
  };
}

function defiLlamaDetailLaneQuotasV2(
  laneCount = DEFILLAMA_DETAIL_CONCURRENCY_V2
): number[] {
  if (!Number.isInteger(laneCount) || laneCount < 1 || laneCount > DEFILLAMA_DETAIL_CONCURRENCY_V2) {
    throw new Error("DefiLlama detail lane count is invalid");
  }
  const base = Math.floor(
    DEFILLAMA_DETAIL_RUN_LIMIT_BYTES_V2 / laneCount
  );
  const remainder = DEFILLAMA_DETAIL_RUN_LIMIT_BYTES_V2 % laneCount;
  return Array.from(
    { length: laneCount },
    (_, index) => base + (index < remainder ? 1 : 0)
  );
}

function validInstant(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9가-힣]+/gu, "-").replace(/^-|-$/g, "").slice(0, 80);
}

function formatUsd(value: number): string {
  if (Math.abs(value) >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

function defiAbsoluteTvlMove(tvl: number, changePercent: number): number {
  const prior = tvl / (1 + changePercent / 100);
  return Math.abs(tvl - prior);
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

interface DefiLlamaSummaryRowV2 {
  name: string;
  slug?: string;
  category?: string;
  tvl: number;
  change_1d: number;
}

interface DefiLlamaShortlistCandidateV2 {
  row: DefiLlamaSummaryRowV2;
  selectionClasses: DefiLlamaSelectionClassV2[];
}

function defiRowKey(row: DefiLlamaSummaryRowV2): string {
  return row.slug?.trim() || slug(row.name);
}

function stableHashV2(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function shortlistDefiLlamaCandidatesV2(
  rows: readonly DefiLlamaSummaryRowV2[],
  benchmarkChangePercent: number,
  now: string,
  selectionSeed: string
): DefiLlamaShortlistCandidateV2[] {
  const byAbsoluteMove = [...rows].sort((left, right) =>
    defiAbsoluteTvlMove(right.tvl, right.change_1d) -
      defiAbsoluteTvlMove(left.tvl, left.change_1d) ||
    defiRowKey(left).localeCompare(defiRowKey(right))
  );
  const byRelativeMove = [...rows].sort((left, right) =>
    Math.abs(right.change_1d) - Math.abs(left.change_1d) ||
    defiRowKey(left).localeCompare(defiRowKey(right))
  );
  const byResidual = [...rows].sort((left, right) =>
    Math.abs(right.change_1d - benchmarkChangePercent) -
      Math.abs(left.change_1d - benchmarkChangePercent) ||
    defiRowKey(left).localeCompare(defiRowKey(right))
  );
  // Protect the strongest signal on each axis; rotate only the remaining request budget.
  const selected = new Map<string, DefiLlamaShortlistCandidateV2>();
  const anchors: Array<{
    row: DefiLlamaSummaryRowV2 | undefined;
    selectionClass: DefiLlamaSelectionClassV2;
  }> = [
    { row: byAbsoluteMove[0], selectionClass: "anchor-absolute" },
    { row: byRelativeMove[0], selectionClass: "anchor-relative" },
    { row: byResidual[0], selectionClass: "anchor-residual" },
  ];
  for (const { row, selectionClass } of anchors) {
    if (!row) continue;
    const key = defiRowKey(row);
    const existing = selected.get(key);
    if (existing) {
      existing.selectionClasses.push(selectionClass);
    } else {
      selected.set(key, { row, selectionClasses: [selectionClass] });
    }
  }

  const remainingByKey = new Map<string, DefiLlamaSummaryRowV2>();
  for (const row of rows) {
    const key = defiRowKey(row);
    if (!selected.has(key) && !remainingByKey.has(key)) remainingByKey.set(key, row);
  }
  const remaining = [...remainingByKey.values()]
    .sort((left, right) => defiRowKey(left).localeCompare(defiRowKey(right)));
  const rotationSlots = DEFILLAMA_DETAIL_CANDIDATE_LIMIT_V2 - selected.size;
  if (rotationSlots > 0 && remaining.length > 0) {
    const bucket = Math.floor(Date.parse(now) / DEFILLAMA_DETAIL_ROTATION_BUCKET_MS_V2);
    const rawOffset = (stableHashV2(selectionSeed) + bucket * rotationSlots) % remaining.length;
    const offset = (rawOffset + remaining.length) % remaining.length;
    for (let index = 0; index < Math.min(rotationSlots, remaining.length); index += 1) {
      const row = remaining[(offset + index) % remaining.length];
      selected.set(defiRowKey(row), { row, selectionClasses: ["rotation"] });
    }
  }
  return [...selected.values()];
}

function shortlistDefiLlamaRowsV2(
  rows: readonly DefiLlamaSummaryRowV2[],
  benchmarkChangePercent: number,
  now: string,
  selectionSeed: string
): DefiLlamaSummaryRowV2[] {
  return shortlistDefiLlamaCandidatesV2(
    rows,
    benchmarkChangePercent,
    now,
    selectionSeed
  ).map((candidate) => candidate.row);
}

function failureResult(
  provider: EvidenceProviderV2,
  checkedAt: string,
  failure: ProviderFailureCodeV2,
  latencyMs = 0,
  statusCode?: number
): ProviderAdapterResultV2 {
  return {
    outcome: { kind: "failure", provider, checkedAt, latencyMs, failure, statusCode },
    evidence: [],
    observations: [],
    discoveries: [],
  };
}

async function fetchPayloadV2(input: {
  provider: EvidenceProviderV2;
  url: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  accept?: string;
  maxResponseBytes?: number;
  maxCacheAgeMs?: number;
}): Promise<FetchResultV2> {
  const startedAt = Date.now();
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(Object.assign(new Error("provider deadline exceeded"), { name: "AbortError" }));
    }, Math.max(1, input.timeoutMs));
  });
  let payloadBytes = 0;
  let response: Response | undefined;
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    response = await Promise.race([
      input.fetchImpl(input.url, {
        signal: controller.signal,
        headers: input.accept ? { accept: input.accept } : undefined,
      }),
      deadline,
    ]);
    const latencyMs = Date.now() - startedAt;
    const contentLength = response.headers.get("content-length")?.trim() ?? "";
    const parsedContentLength = /^\d+$/.test(contentLength) ? Number(contentLength) : null;
    const declaredBytes = parsedContentLength === null
      ? null
      : Number.isSafeInteger(parsedContentLength)
        ? parsedContentLength
        : Number.MAX_SAFE_INTEGER;
    if (!response.ok) {
      // Error bodies are never useful evidence. Cancel the stream immediately,
      // but conservatively charge a declared body to the shared run budget.
      void response.body?.cancel().catch(() => undefined);
      return {
        ok: false,
        failure: providerFailureCodeFromHttpStatusV2(response.status),
        statusCode: response.status,
        latencyMs,
        payloadBytes: declaredBytes ?? payloadBytes,
      };
    }
    const cacheStatus = String(response.headers.get("cf-cache-status") || "").trim().toUpperCase();
    const warning = String(response.headers.get("warning") || "");
    const ageHeader = response.headers.get("age")?.trim() || "";
    const ageSeconds = /^\d+$/.test(ageHeader) ? Number(ageHeader) : null;
    const explicitlyStale =
      cacheStatus === "STALE" ||
      cacheStatus === "UPDATING" ||
      /(?:^|,)\s*110(?:\s|$)/u.test(warning) ||
      (
        input.maxCacheAgeMs !== undefined &&
        ageSeconds !== null &&
        Number.isFinite(ageSeconds) &&
        ageSeconds * 1_000 > input.maxCacheAgeMs
      );
    if (explicitlyStale) {
      void response.body?.cancel().catch(() => undefined);
      return {
        ok: false,
        failure: "stale-cache",
        latencyMs,
        payloadBytes: declaredBytes ?? payloadBytes,
      };
    }
    if (
      input.maxResponseBytes !== undefined &&
      declaredBytes !== null &&
      declaredBytes > input.maxResponseBytes
    ) {
      void response.body?.cancel().catch(() => undefined);
      return { ok: false, failure: "payload-too-large", latencyMs, payloadBytes: declaredBytes };
    }
    let raw = "";
    if (input.maxResponseBytes !== undefined && response.body) {
      const reader = response.body.getReader();
      activeReader = reader;
      const decoder = new TextDecoder();
      while (true) {
        const chunk = await Promise.race([reader.read(), deadline]);
        if (chunk.done) break;
        payloadBytes += chunk.value.byteLength;
        if (payloadBytes > input.maxResponseBytes) {
          void reader.cancel().catch(() => undefined);
          return { ok: false, failure: "payload-too-large", latencyMs: Date.now() - startedAt, payloadBytes };
        }
        raw += decoder.decode(chunk.value, { stream: true });
      }
      raw += decoder.decode();
    } else {
      raw = await Promise.race([response.text(), deadline]);
      payloadBytes = new TextEncoder().encode(raw).byteLength;
      if (input.maxResponseBytes !== undefined && payloadBytes > input.maxResponseBytes) {
        return { ok: false, failure: "payload-too-large", latencyMs: Date.now() - startedAt, payloadBytes };
      }
    }
    const completedLatencyMs = Date.now() - startedAt;
    if (!raw.trim()) return { ok: false, failure: "empty", latencyMs: completedLatencyMs, payloadBytes };
    if (input.accept?.includes("xml")) {
      return { ok: true, value: raw, latencyMs: completedLatencyMs, payloadBytes };
    }
    try {
      return { ok: true, value: JSON.parse(raw), latencyMs: completedLatencyMs, payloadBytes };
    } catch {
      return { ok: false, failure: "parse-error", latencyMs: completedLatencyMs, payloadBytes };
    }
  } catch (error) {
    void activeReader?.cancel().catch(() => undefined);
    if (!activeReader) void response?.body?.cancel().catch(() => undefined);
    const latencyMs = Date.now() - startedAt;
    const name = error && typeof error === "object" ? String((error as { name?: string }).name || "") : "";
    return { ok: false, failure: name === "AbortError" ? "timeout" : "network-error", latencyMs, payloadBytes };
  } finally {
    clearTimeout(timeout!);
  }
}

function directCard(input: {
  id: string;
  lane: EvidenceLaneV2;
  subject: string;
  subjectKey?: string;
  metricName: string;
  value: number;
  raw: string;
  unit: string;
  period: string;
  provider: EvidenceProviderV2;
  url: string;
  now: string;
  health: ReturnType<typeof providerHealthFromOutcomeV2>;
  role?: "primary" | "discovery";
  followUp?: EvidenceCardV2["followUp"];
  selection?: EvidenceCardV2["selection"];
}): EvidenceCardV2 {
  return {
    schemaVersion: 2,
    id: input.id,
    lane: input.lane,
    kind: "signal",
    subject: input.subject,
    subjectKey: input.subjectKey,
    metric: {
      name: input.metricName,
      value: input.value,
      raw: input.raw,
      unit: input.unit,
      period: input.period,
    },
    followUp: input.followUp
      ? { ...input.followUp, metric: { ...input.followUp.metric } }
      : undefined,
    selection: input.selection ? { ...input.selection } : undefined,
    source: {
      provider: input.provider,
      url: input.url,
      publishedAt: null,
      observedAt: input.now,
      origin: "direct",
      role: input.role ?? "primary",
    },
    freshness: evaluateEvidenceFreshnessV2({ kind: "signal", observedAt: input.now, now: input.now }),
    providerHealth: input.health,
    provenance: { kind: "onchain-nutrient", sourceId: input.id },
  };
}

async function collectDefiLlamaV2(
  context: Required<Pick<EditorialProviderContextV2, "now" | "fetchImpl" | "perProviderTimeoutMs" | "sensingDeadlineMs" | "followUpTargets" | "includeGenericCandidates" | "selectionSeed">>
): Promise<ProviderAdapterResultV2> {
  const startedAt = Date.now();
  const fetched = await fetchPayloadV2({
    provider: "defillama",
    url: ENDPOINTS.defillama,
    fetchImpl: context.fetchImpl,
    timeoutMs: Math.min(context.perProviderTimeoutMs, context.sensingDeadlineMs),
    maxResponseBytes: PROVIDER_RESPONSE_LIMIT_BYTES_V2.defillamaSummary,
    maxCacheAgeMs: SIGNAL_FRESHNESS_MS,
  });
  if (fetched.ok === false) return failureResult("defillama", context.now, fetched.failure, fetched.latencyMs, fetched.statusCode);
  if (!Array.isArray(fetched.value)) return failureResult("defillama", context.now, "parse-error", fetched.latencyMs);
  const parsedRows = fetched.value.flatMap((value): DefiLlamaSummaryRowV2[] => {
    if (!isRecord(value)) return [];
    const row = value as { name?: unknown; slug?: unknown; category?: unknown; tvl?: unknown; change_1d?: unknown };
    if (
      typeof row.name !== "string" ||
      (row.slug !== undefined && typeof row.slug !== "string") ||
      (row.category !== undefined && typeof row.category !== "string") ||
      typeof row.tvl !== "number" ||
      !Number.isFinite(row.tvl) || row.tvl <= 0 ||
      typeof row.change_1d !== "number" ||
      !Number.isFinite(row.change_1d) || row.change_1d <= -99
    ) {
      return [];
    }
    return [{
      name: row.name,
      slug: row.slug,
      category: row.category,
      tvl: row.tvl,
      change_1d: row.change_1d,
    }];
  });
  if (parsedRows.length === 0) {
    return failureResult("defillama", context.now, fetched.value.length === 0 ? "empty" : "parse-error", fetched.latencyMs);
  }
  const benchmarkRows = parsedRows.filter(
    (row) => row.category !== "CEX" && Number(row.tvl) >= 100_000_000
  );
  const benchmarkChangePercent = benchmarkRows.length >= 20
    ? median(benchmarkRows.map((row) => Number(row.change_1d)))
    : 0;
  const coarseRows = benchmarkRows
    .filter(
      (row) =>
        Math.abs(Number(row.change_1d)) >= 2 &&
        Math.abs(Number(row.change_1d) - benchmarkChangePercent) >= 2 &&
        defiAbsoluteTvlMove(Number(row.tvl), Number(row.change_1d)) >= 10_000_000
    );
  const rowKey = (row: DefiLlamaSummaryRowV2): string => defiRowKey(row);
  const toChangeCard = (
    row: DefiLlamaSummaryRowV2,
    health: ReturnType<typeof providerHealthFromOutcomeV2>,
    priceNeutral?: DefiLlamaPriceNeutralMetricsV2
  ): EvidenceCardV2 => {
    const name = String(row.name);
    const subjectKey = rowKey(row);
    const change = Number(row.change_1d);
    const tvl = Number(row.tvl);
    const priorTvl = tvl / (1 + change / 100);
    const raw = `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`;
    return directCard({
      id: `defillama:${subjectKey}:tvl-change-24h:${context.now}`,
      lane: "protocol",
      subject: name,
      subjectKey,
      metricName: "tvl-change-24h",
      value: change,
      raw,
      unit: "%",
      period: "24h",
      provider: "defillama",
      url: ENDPOINTS.defillama,
      now: context.now,
      health,
      followUp: {
        metric: { name: "tvl-usd", value: tvl, raw: formatUsd(tvl), unit: "USD", period: "snapshot" },
        comparator: change >= 0 ? "lte" : "gte",
        threshold: priorTvl,
      },
      selection: {
        kind: "tvl-outlier",
        absoluteMoveUsd: defiAbsoluteTvlMove(tvl, change),
        benchmarkChangePercent,
        residualPercentagePoints: change - benchmarkChangePercent,
        priceNeutral: priceNeutral
          ? {
              quantityChangePercent: priceNeutral.quantityChangePercent,
              priceChangePercent: priceNeutral.priceChangePercent,
              quantityMoveUsd: priceNeutral.quantityMoveUsd,
              quantityShare: priceNeutral.quantityShare,
              coverageAtT0: priceNeutral.coverageAtT0,
              coverageAtT1: priceNeutral.coverageAtT1,
              t0: priceNeutral.t0,
              t1: priceNeutral.t1,
              interpolatedT0: priceNeutral.interpolatedT0,
            }
          : undefined,
      },
    });
  };
  const toTvlCard = (
    row: DefiLlamaSummaryRowV2,
    health: ReturnType<typeof providerHealthFromOutcomeV2>
  ): EvidenceCardV2 => {
    const name = String(row.name);
    const subjectKey = rowKey(row);
    const tvl = Number(row.tvl);
    return directCard({
      id: `defillama:${subjectKey}:tvl-usd:${context.now}`,
      lane: "protocol",
      subject: name,
      subjectKey,
      metricName: "tvl-usd",
      value: tvl,
      raw: formatUsd(tvl),
      unit: "USD",
      period: "snapshot",
      provider: "defillama",
      url: ENDPOINTS.defillama,
      now: context.now,
      health,
    });
  };
  const selectionGaps: ProviderSelectionGapV2[] = [];
  const qualifiedRows: Array<{
    row: DefiLlamaSummaryRowV2;
    metrics: DefiLlamaPriceNeutralMetricsV2;
  }> = [];
  const selectionAttemptCounts = new Map<DefiLlamaSelectionClassV2, number>();
  const selectionQualifiedCounts = new Map<DefiLlamaSelectionClassV2, number>();
  const selectionGapCounts = new Map<DefiLlamaSelectionClassV2, Map<string, number>>();
  const recordSelectionOutcome = (
    selectionClasses: readonly DefiLlamaSelectionClassV2[],
    reasons: readonly string[],
    qualified: boolean
  ): void => {
    for (const selectionClass of selectionClasses) {
      selectionAttemptCounts.set(
        selectionClass,
        (selectionAttemptCounts.get(selectionClass) ?? 0) + 1
      );
      if (qualified) {
        selectionQualifiedCounts.set(
          selectionClass,
          (selectionQualifiedCounts.get(selectionClass) ?? 0) + 1
        );
      }
      const gapCounts = selectionGapCounts.get(selectionClass) ?? new Map<string, number>();
      for (const reason of reasons) {
        gapCounts.set(reason, (gapCounts.get(reason) ?? 0) + 1);
      }
      selectionGapCounts.set(selectionClass, gapCounts);
    }
  };
  if (context.includeGenericCandidates) {
    const shortlistCandidates = shortlistDefiLlamaCandidatesV2(
      coarseRows,
      benchmarkChangePercent,
      context.now,
      context.selectionSeed
    );
    const shortlist = shortlistCandidates.map((candidate) => candidate.row);
    const shortlistedKeys = new Set(shortlist.map(rowKey));
    selectionGaps.push(...coarseRows
      .filter((row) => !shortlistedKeys.has(rowKey(row)))
      .map((row) => ({
        subject: row.name,
        subjectKey: rowKey(row),
        reasons: ["detail-rotation-deferred"],
      })));
    type DetailAttempt =
      | { kind: "gap"; reason: "detail-deadline-exhausted" | "detail-run-payload-budget-exhausted" }
      | { kind: "fetched"; detail: FetchResultV2; maxResponseBytes: number };
    const attempts: Array<DetailAttempt | undefined> = Array(shortlist.length);
    const activeLaneCount = Math.min(
      DEFILLAMA_DETAIL_CONCURRENCY_V2,
      shortlist.length
    );
    const laneQuotas = activeLaneCount > 0
      ? defiLlamaDetailLaneQuotasV2(activeLaneCount)
      : [];

    // Three fixed lanes keep request order and byte allocation deterministic.
    // Each lane processes at most two details sequentially, so one hung request
    // cannot consume the whole provider deadline or starve every later candidate.
    await Promise.all(laneQuotas.map(async (laneQuota, laneIndex) => {
      let lanePayloadBytes = 0;
      for (
        let index = laneIndex;
        index < shortlist.length;
        index += activeLaneCount
      ) {
        const requestLimits = defiLlamaDetailRequestLimitsV2({
          elapsedMs: Date.now() - startedAt,
          perProviderTimeoutMs: context.perProviderTimeoutMs,
          sensingDeadlineMs: context.sensingDeadlineMs,
          cumulativePayloadBytes: lanePayloadBytes,
          payloadBudgetBytes: laneQuota,
        });
        if (requestLimits.timeoutMs <= 0) {
          attempts[index] = { kind: "gap", reason: "detail-deadline-exhausted" };
          continue;
        }
        if (requestLimits.maxResponseBytes <= 0) {
          attempts[index] = { kind: "gap", reason: "detail-run-payload-budget-exhausted" };
          continue;
        }
        const row = shortlist[index];
        const detail = await fetchPayloadV2({
          provider: "defillama",
          url: ENDPOINTS.defillamaProtocol(rowKey(row)),
          fetchImpl: context.fetchImpl,
          timeoutMs: requestLimits.timeoutMs,
          maxResponseBytes: requestLimits.maxResponseBytes,
          maxCacheAgeMs: SIGNAL_FRESHNESS_MS,
        });
        // A declared or final stream chunk can be larger than the remaining
        // quota. Keep the diagnostic byte count, but never let accounting cross
        // the fixed lane reservation that makes the 64 MiB run cap deterministic.
        lanePayloadBytes += Math.min(
          detail.payloadBytes,
          Math.max(0, laneQuota - lanePayloadBytes)
        );
        attempts[index] = {
          kind: "fetched",
          detail,
          maxResponseBytes: requestLimits.maxResponseBytes,
        };
      }
    }));

    for (let index = 0; index < shortlist.length; index += 1) {
      const row = shortlist[index];
      const selectionClasses = shortlistCandidates[index].selectionClasses;
      const attempt = attempts[index];
      if (!attempt) throw new Error(`missing DefiLlama detail attempt at ${index}`);
      if (attempt.kind === "gap") {
        recordSelectionOutcome(selectionClasses, [attempt.reason], false);
        selectionGaps.push({
          subject: row.name,
          subjectKey: rowKey(row),
          reasons: [attempt.reason],
        });
        continue;
      }
      const { detail, maxResponseBytes } = attempt;
      if (!detail.ok) {
        const exceedsHardResponseLimit =
          detail.failure === "payload-too-large" &&
          detail.payloadBytes > DEFILLAMA_DETAIL_RESPONSE_LIMIT_BYTES_V2;
        const budgetLimited =
          detail.failure === "payload-too-large" &&
          !exceedsHardResponseLimit &&
          maxResponseBytes < DEFILLAMA_DETAIL_RESPONSE_LIMIT_BYTES_V2;
        const reasons = [budgetLimited
          ? "detail-run-payload-budget-exhausted"
          : `detail-${detail.failure}`];
        recordSelectionOutcome(selectionClasses, reasons, false);
        selectionGaps.push({
          subject: row.name,
          subjectKey: rowKey(row),
          reasons,
          latencyMs: detail.latencyMs,
          payloadBytes: detail.payloadBytes,
        });
        continue;
      }
      const decision = evaluateDefiLlamaPriceNeutralV2({
        payload: detail.value,
        summaryTvlUsd: row.tvl,
        summaryChangePercent: row.change_1d,
        now: context.now,
      });
      if (!decision.eligible || !decision.metrics) {
        const reasons = decision.reasons.map((reason) => `price-neutral-${reason}`);
        recordSelectionOutcome(selectionClasses, reasons, false);
        selectionGaps.push({
          subject: row.name,
          subjectKey: rowKey(row),
          reasons,
          latencyMs: detail.latencyMs,
          payloadBytes: detail.payloadBytes,
        });
        continue;
      }
      recordSelectionOutcome(selectionClasses, [], true);
      qualifiedRows.push({ row, metrics: decision.metrics });
    }
  }

  qualifiedRows.sort((left, right) =>
    Math.abs(right.metrics.quantityMoveUsd) - Math.abs(left.metrics.quantityMoveUsd) ||
    Math.abs(right.metrics.quantityChangePercent) - Math.abs(left.metrics.quantityChangePercent) ||
    rowKey(left.row).localeCompare(rowKey(right.row))
  );
  const outcome: ProviderFetchOutcomeV2 = {
    kind: "success",
    provider: "defillama",
    checkedAt: context.now,
    latencyMs: Date.now() - startedAt,
    itemCount: parsedRows.length,
  };
  const health = providerHealthFromOutcomeV2(outcome);
  const observations = context.followUpTargets.flatMap((target) => {
    if (target.provider !== "defillama") return [];
    const row = parsedRows.find((candidate) => {
      if (target.subjectKey) return rowKey(candidate) === target.subjectKey;
      return String(candidate.name).trim().toLowerCase() === target.subject.trim().toLowerCase();
    });
    if (!row) return [];
    const card = target.metricName === "tvl-usd"
      ? toTvlCard(row, health)
      : target.metricName === "tvl-change-24h"
        ? toChangeCard(row, health)
        : null;
    if (!card || card.metric.unit !== target.unit || card.metric.period !== target.period) return [];
    return [card];
  });
  return {
    outcome,
    evidence: qualifiedRows.slice(0, 5).map(({ row, metrics }) =>
      toChangeCard(row, health, metrics)
    ),
    observations: [...new Map(observations.map((card) => [card.id, card])).values()],
    discoveries: [],
    selectionGaps,
    selectionClassSummary: [...selectionAttemptCounts.keys()]
      .sort((left, right) => left.localeCompare(right))
      .map((selectionClass) => ({
        selectionClass,
        attempted: selectionAttemptCounts.get(selectionClass) ?? 0,
        qualified: selectionQualifiedCounts.get(selectionClass) ?? 0,
        gapSummary: [...(selectionGapCounts.get(selectionClass) ?? new Map())]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([reason, count]) => `${reason}=${count}`),
      })),
  };
}

async function collectMempoolV2(context: Required<Pick<EditorialProviderContextV2, "now" | "fetchImpl" | "perProviderTimeoutMs">>): Promise<ProviderAdapterResultV2> {
  const fetched = await fetchPayloadV2({ provider: "mempool.space", url: ENDPOINTS.mempool, fetchImpl: context.fetchImpl, timeoutMs: context.perProviderTimeoutMs, maxResponseBytes: PROVIDER_RESPONSE_LIMIT_BYTES_V2.mempool, maxCacheAgeMs: SIGNAL_FRESHNESS_MS });
  if (fetched.ok === false) return failureResult("mempool.space", context.now, fetched.failure, fetched.latencyMs, fetched.statusCode);
  const row = fetched.value as { fastestFee?: unknown };
  if (typeof row?.fastestFee !== "number" || !Number.isFinite(row.fastestFee)) return failureResult("mempool.space", context.now, "parse-error", fetched.latencyMs);
  const outcome: ProviderFetchOutcomeV2 = { kind: "success", provider: "mempool.space", checkedAt: context.now, latencyMs: fetched.latencyMs, itemCount: 1 };
  const health = providerHealthFromOutcomeV2(outcome);
  return {
    outcome,
    evidence: [directCard({ id: `mempool:bitcoin:fastest-fee:${context.now}`, lane: "onchain", subject: "Bitcoin", metricName: "fastest-fee", value: row.fastestFee, raw: `${row.fastestFee} sat/vB`, unit: "sat/vB", period: "snapshot", provider: "mempool.space", url: ENDPOINTS.mempool, now: context.now, health, role: "discovery" })],
    observations: [],
    discoveries: [],
  };
}

async function collectCoinGeckoV2(context: Required<Pick<EditorialProviderContextV2, "now" | "fetchImpl" | "perProviderTimeoutMs">>): Promise<ProviderAdapterResultV2> {
  const fetched = await fetchPayloadV2({ provider: "coingecko", url: ENDPOINTS.coingecko, fetchImpl: context.fetchImpl, timeoutMs: context.perProviderTimeoutMs, maxResponseBytes: PROVIDER_RESPONSE_LIMIT_BYTES_V2.coingecko, maxCacheAgeMs: SIGNAL_FRESHNESS_MS });
  if (fetched.ok === false) return failureResult("coingecko", context.now, fetched.failure, fetched.latencyMs, fetched.statusCode);
  if (!Array.isArray(fetched.value)) return failureResult("coingecko", context.now, "parse-error", fetched.latencyMs);
  const rows = fetched.value.flatMap((value): Array<{ id: string; name: string; current_price: number }> => {
    if (!isRecord(value)) return [];
    if (
      typeof value.id !== "string" ||
      typeof value.name !== "string" ||
      typeof value.current_price !== "number" ||
      !Number.isFinite(value.current_price)
    ) {
      return [];
    }
    return [{ id: value.id, name: value.name, current_price: value.current_price }];
  }).slice(0, 5);
  if (rows.length === 0) {
    return failureResult("coingecko", context.now, fetched.value.length === 0 ? "empty" : "parse-error", fetched.latencyMs);
  }
  const outcome: ProviderFetchOutcomeV2 = { kind: "success", provider: "coingecko", checkedAt: context.now, latencyMs: fetched.latencyMs, itemCount: rows.length };
  const health = providerHealthFromOutcomeV2(outcome);
  return {
    outcome,
    evidence: rows.map((row) => {
      const price = Number(row.current_price);
      const name = String(row.name);
      const formatted = price >= 1 ? `$${price.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : `$${price.toPrecision(4)}`;
      return directCard({ id: `coingecko:${slug(String(row.id))}:price:${context.now}`, lane: "ecosystem", subject: name, metricName: "usd-price", value: price, raw: formatted, unit: "USD", period: "snapshot", provider: "coingecko", url: ENDPOINTS.coingecko, now: context.now, health, role: "discovery" });
    }),
    observations: [],
    discoveries: [],
  };
}

function decodeXmlText(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (entity, code: string) => {
      const radix = code.toLowerCase().startsWith("x") ? 16 : 10;
      const value = Number.parseInt(radix === 16 ? code.slice(1) : code, radix);
      return Number.isFinite(value) && value >= 0 && value <= 0x10ffff
        ? String.fromCodePoint(value)
        : entity;
    })
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function rssDiscoveries(xml: string): EditorialDiscoveryV2[] {
  return [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].slice(0, 10).flatMap((match) => {
    const block = match[0];
    const title = decodeXmlText(
      block.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ""
    );
    const url = decodeXmlText(
      block.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1] || ""
    );
    const published = decodeXmlText(
      block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i)?.[1] || ""
    );
    if (!title || !/^https?:\/\//i.test(url)) return [];
    return [{ provider: "rss" as const, title, url, publishedAt: validInstant(published) ? new Date(published).toISOString() : null, blockReason: "discovery-only" as const }];
  });
}

async function collectRssV2(context: Required<Pick<EditorialProviderContextV2, "now" | "fetchImpl" | "perProviderTimeoutMs">>): Promise<ProviderAdapterResultV2> {
  const fetched = await fetchPayloadV2({ provider: "rss", url: ENDPOINTS.rss, fetchImpl: context.fetchImpl, timeoutMs: context.perProviderTimeoutMs, accept: "application/rss+xml, application/xml", maxResponseBytes: PROVIDER_RESPONSE_LIMIT_BYTES_V2.rss, maxCacheAgeMs: NEWS_FRESHNESS_MS });
  if (fetched.ok === false) return failureResult("rss", context.now, fetched.failure, fetched.latencyMs, fetched.statusCode);
  const discoveries = rssDiscoveries(String(fetched.value));
  if (discoveries.length === 0) return failureResult("rss", context.now, "empty", fetched.latencyMs);
  return { outcome: { kind: "success", provider: "rss", checkedAt: context.now, latencyMs: fetched.latencyMs, itemCount: discoveries.length }, evidence: [], observations: [], discoveries };
}

async function collectCryptoCompareV2(context: Required<Pick<EditorialProviderContextV2, "now" | "fetchImpl" | "perProviderTimeoutMs">> & { apiKey: string }): Promise<ProviderAdapterResultV2> {
  if (!context.apiKey) return failureResult("cryptocompare", context.now, "not-configured");
  const url = `${ENDPOINTS.cryptocompare}&api_key=${encodeURIComponent(context.apiKey)}`;
  const fetched = await fetchPayloadV2({ provider: "cryptocompare", url, fetchImpl: context.fetchImpl, timeoutMs: context.perProviderTimeoutMs, maxResponseBytes: PROVIDER_RESPONSE_LIMIT_BYTES_V2.cryptocompare, maxCacheAgeMs: NEWS_FRESHNESS_MS });
  if (fetched.ok === false) return failureResult("cryptocompare", context.now, fetched.failure, fetched.latencyMs, fetched.statusCode);
  if (!isRecord(fetched.value)) return failureResult("cryptocompare", context.now, "parse-error", fetched.latencyMs);
  const payload = fetched.value;
  if (String(payload.Response || "").toLowerCase() === "error") {
    const failure = /auth|api.?key|permission/i.test(String(payload.Message || "")) ? "unauthorized" : "http-error";
    return failureResult("cryptocompare", context.now, failure, fetched.latencyMs);
  }
  if (!Array.isArray(payload.Data) || payload.Data.length === 0) return failureResult("cryptocompare", context.now, "empty", fetched.latencyMs);
  const discoveries = payload.Data.slice(0, 10).flatMap((value) => {
    if (!isRecord(value)) return [];
    if (typeof value.title !== "string" || typeof value.url !== "string" || !/^https?:\/\//i.test(value.url)) return [];
    const publishedDate = typeof value.published_on === "number"
      ? new Date(value.published_on * 1_000)
      : null;
    const publishedAt = publishedDate && Number.isFinite(publishedDate.getTime())
      ? publishedDate.toISOString()
      : null;
    return [{ provider: "cryptocompare" as const, title: value.title, url: value.url, publishedAt, blockReason: "discovery-only" as const }];
  });
  if (discoveries.length === 0) return failureResult("cryptocompare", context.now, "parse-error", fetched.latencyMs);
  return { outcome: { kind: "success", provider: "cryptocompare", checkedAt: context.now, latencyMs: fetched.latencyMs, itemCount: discoveries.length }, evidence: [], observations: [], discoveries };
}

export async function collectEditorialEvidenceV2(context: EditorialProviderContextV2): Promise<EditorialSensingResultV2> {
  if (!validInstant(context.now)) throw new Error("editorial sensing now must be a valid instant");
  const fetchImpl = context.fetchImpl ?? fetch;
  const sensingDeadlineMs = context.sensingDeadlineMs ?? SENSING_DEADLINE_MS_V2;
  const perProviderTimeoutMs = Math.min(context.perProviderTimeoutMs ?? PROVIDER_TIMEOUT_MS_V2, sensingDeadlineMs);
  const shared = {
    now: context.now,
    fetchImpl,
    perProviderTimeoutMs,
    sensingDeadlineMs,
    followUpTargets: context.followUpTargets ?? [],
    includeGenericCandidates: context.includeGenericCandidates ?? true,
    selectionSeed: context.selectionSeed ?? "defillama-detail-v2",
  };
  const targetedProviders = new Set(shared.followUpTargets.map((target) => target.provider));
  const collectAllProviders = shared.includeGenericCandidates || targetedProviders.size === 0;
  const shouldCollect = (provider: EvidenceProviderV2): boolean =>
    collectAllProviders || targetedProviders.has(provider);
  const collectors: Array<Promise<ProviderAdapterResultV2>> = [];
  if (shouldCollect("defillama")) collectors.push(collectDefiLlamaV2(shared));
  if (shouldCollect("mempool.space")) collectors.push(collectMempoolV2(shared));
  if (shouldCollect("coingecko")) collectors.push(collectCoinGeckoV2(shared));
  if (shouldCollect("rss")) collectors.push(collectRssV2(shared));
  if (shouldCollect("cryptocompare")) {
    collectors.push(collectCryptoCompareV2({
      ...shared,
      apiKey: context.cryptoCompareApiKey ?? String(process.env.CRYPTOCOMPARE_API_KEY || "").trim(),
    }));
  }
  const providers = await Promise.all(collectors);
  return {
    evidence: providers.flatMap((provider) => provider.evidence),
    observations: providers.flatMap((provider) => provider.observations),
    discoveries: providers.flatMap((provider) => provider.discoveries),
    providers,
  };
}

export const __providerAdapterTestV2 = {
  ENDPOINTS,
  PROVIDER_RESPONSE_LIMIT_BYTES_V2,
  defiLlamaDetailRequestLimitsV2,
  defiLlamaDetailLaneQuotasV2,
  shortlistDefiLlamaRowsV2,
  fetchPayloadV2,
};
