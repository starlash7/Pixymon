const DAY_SECONDS = 24 * 60 * 60;
const MAX_CURRENT_AGE_SECONDS = 2 * 60 * 60;
const MAX_FUTURE_SKEW_SECONDS = 5 * 60;
const MAX_EPOCH_SECONDS = 10_000_000_000;
const COMPARISON_EPSILON = 1e-12;
const USD_COMPARISON_EPSILON = 0.01;

export const DEFILLAMA_PRICE_NEUTRAL_LIMITS_V2 = {
  maximumInterpolationSpanSeconds: 26 * 60 * 60,
  minimumCommonCoverage: 0.95,
  maximumReconciliationError: 0.02,
  minimumQuantityChange: 0.02,
  minimumQuantityMoveUsd: 10_000_000,
  minimumQuantityShare: 0.5,
  maximumGrossMismatch: 0.02,
} as const;

export type DefiLlamaPriceNeutralReasonV2 =
  | "summary-invalid"
  | "payload-invalid"
  | "joined-snapshot-missing"
  | "current-snapshot-stale"
  | "current-snapshot-future"
  | "24h-bracket-missing"
  | "interpolation-span-too-wide"
  | "common-coverage-low"
  | "tvl-reconciliation-failed"
  | "summary-tvl-mismatch"
  | "gross-change-direction-mismatch"
  | "gross-change-mismatch"
  | "quantity-direction-mismatch"
  | "quantity-change-below-threshold"
  | "quantity-move-below-threshold"
  | "quantity-share-below-threshold"
  | "derived-metric-invalid";

export interface DefiLlamaPriceNeutralInputV2 {
  payload: unknown;
  summaryTvlUsd: number;
  summaryChangePercent: number;
  now: string;
}

export interface DefiLlamaPriceNeutralMetricsV2 {
  t0: number;
  t1: number;
  interpolatedT0: boolean;
  interpolationSpanSeconds: number;
  matchedTokenCount: number;
  coverageAtT0: number;
  coverageAtT1: number;
  reconciliationErrorAtT0: number;
  reconciliationErrorAtT1: number;
  summaryTvlMismatch: number;
  grossChangePercent: number;
  grossMismatchPercentagePoints: number;
  quantityChangePercent: number;
  priceChangePercent: number;
  quantityMoveUsd: number;
  quantityShare: number;
}

export interface DefiLlamaPriceNeutralDecisionV2 {
  eligible: boolean;
  reasons: DefiLlamaPriceNeutralReasonV2[];
  metrics: DefiLlamaPriceNeutralMetricsV2 | null;
}

type UnknownRecord = Record<string, unknown>;
type TokenRecord = Record<string, unknown>;

interface ParsedPayloadV2 {
  quantitiesByDate: Map<number, TokenRecord>;
  usdByDate: Map<number, TokenRecord>;
  tvlByDate: Map<number, number>;
}

interface JoinedSnapshotV2 {
  date: number;
  quantities: TokenRecord;
  usd: TokenRecord;
  tvlUsd: number;
}

interface NumericSnapshotV2 {
  quantities: Map<string, number>;
  usd: Map<string, number>;
  totalUsd: number;
  tvlUsd: number;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validDate(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value > 0 &&
    value < MAX_EPOCH_SECONDS
  );
}

function parseTokenSeries(value: unknown): Map<number, TokenRecord> | null {
  if (!Array.isArray(value)) return null;
  const rows = new Map<number, TokenRecord>();
  for (const candidate of value) {
    if (!isRecord(candidate) || !validDate(candidate.date) || !isRecord(candidate.tokens)) return null;
    if (rows.has(candidate.date)) return null;
    rows.set(candidate.date, candidate.tokens);
  }
  return rows.size > 0 ? rows : null;
}

function parseTvlSeries(value: unknown): Map<number, number> | null {
  if (!Array.isArray(value)) return null;
  const rows = new Map<number, number>();
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      !validDate(candidate.date) ||
      typeof candidate.totalLiquidityUSD !== "number" ||
      !Number.isFinite(candidate.totalLiquidityUSD) ||
      candidate.totalLiquidityUSD < 0
    ) {
      return null;
    }
    if (rows.has(candidate.date)) return null;
    rows.set(candidate.date, candidate.totalLiquidityUSD);
  }
  return rows.size > 0 ? rows : null;
}

function parsePayload(payload: unknown): ParsedPayloadV2 | null {
  if (!isRecord(payload)) return null;
  const quantitiesByDate = parseTokenSeries(payload.tokens);
  const usdByDate = parseTokenSeries(payload.tokensInUsd);
  const tvlByDate = parseTvlSeries(payload.tvl);
  if (!quantitiesByDate || !usdByDate || !tvlByDate) return null;
  return { quantitiesByDate, usdByDate, tvlByDate };
}

function joinedSnapshots(payload: ParsedPayloadV2): JoinedSnapshotV2[] {
  return [...payload.quantitiesByDate.entries()]
    .flatMap(([date, quantities]) => {
      const usd = payload.usdByDate.get(date);
      const tvlUsd = payload.tvlByDate.get(date);
      if (!usd || tvlUsd === undefined) return [];
      return [{ date, quantities, usd, tvlUsd }];
    })
    .sort((left, right) => left.date - right.date);
}

function numericUsd(record: TokenRecord): Map<string, number> | null {
  const result = new Map<string, number>();
  for (const [token, value] of Object.entries(record)) {
    if (!token.trim() || typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
    result.set(token, value);
  }
  return result.size > 0 ? result : null;
}

function positiveQuantities(record: TokenRecord): Map<string, number> {
  const result = new Map<string, number>();
  for (const [token, value] of Object.entries(record)) {
    if (token.trim() && typeof value === "number" && Number.isFinite(value) && value > 0) {
      result.set(token, value);
    }
  }
  return result;
}

function sum(values: Iterable<number>): number {
  let result = 0;
  for (const value of values) result += value;
  return result;
}

function numericSnapshot(snapshot: JoinedSnapshotV2): NumericSnapshotV2 | null {
  const usd = numericUsd(snapshot.usd);
  if (!usd || !Number.isFinite(snapshot.tvlUsd) || snapshot.tvlUsd <= 0) return null;
  const totalUsd = sum(usd.values());
  if (!Number.isFinite(totalUsd) || totalUsd <= 0) return null;
  return {
    quantities: positiveQuantities(snapshot.quantities),
    usd,
    totalUsd,
    tvlUsd: snapshot.tvlUsd,
  };
}

function interpolateMap(
  left: Map<string, number>,
  right: Map<string, number>,
  fraction: number
): Map<string, number> {
  const result = new Map<string, number>();
  for (const [token, leftValue] of left) {
    const rightValue = right.get(token);
    if (rightValue === undefined) continue;
    result.set(token, leftValue + (rightValue - leftValue) * fraction);
  }
  return result;
}

function interpolateSnapshot(
  left: JoinedSnapshotV2,
  right: JoinedSnapshotV2,
  target: number
): NumericSnapshotV2 | null {
  if (left.date === right.date) return numericSnapshot(left);
  const leftNumeric = numericSnapshot(left);
  const rightNumeric = numericSnapshot(right);
  if (!leftNumeric || !rightNumeric) return null;
  const fraction = (target - left.date) / (right.date - left.date);
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) return null;
  return {
    quantities: interpolateMap(leftNumeric.quantities, rightNumeric.quantities, fraction),
    usd: interpolateMap(leftNumeric.usd, rightNumeric.usd, fraction),
    totalUsd: leftNumeric.totalUsd + (rightNumeric.totalUsd - leftNumeric.totalUsd) * fraction,
    tvlUsd: leftNumeric.tvlUsd + (rightNumeric.tvlUsd - leftNumeric.tvlUsd) * fraction,
  };
}

function relativeError(actual: number, expected: number): number {
  return Math.abs(actual - expected) / Math.max(Math.abs(expected), 1);
}

function direction(value: number): -1 | 0 | 1 {
  if (value > COMPARISON_EPSILON) return 1;
  if (value < -COMPARISON_EPSILON) return -1;
  return 0;
}

function rejected(reason: DefiLlamaPriceNeutralReasonV2): DefiLlamaPriceNeutralDecisionV2 {
  return { eligible: false, reasons: [reason], metrics: null };
}

/**
 * Decomposes a protocol's 24h USD TVL move into balance and price components.
 * The result is a selection gate only: token balance changes are not proof of
 * deposits because rebases, rewards, and adapter methodology can also move them.
 */
export function evaluateDefiLlamaPriceNeutralV2(
  input: DefiLlamaPriceNeutralInputV2
): DefiLlamaPriceNeutralDecisionV2 {
  if (
    !Number.isFinite(input.summaryTvlUsd) ||
    input.summaryTvlUsd <= 0 ||
    !Number.isFinite(input.summaryChangePercent) ||
    input.summaryChangePercent <= -100 ||
    !Number.isFinite(Date.parse(input.now))
  ) {
    return rejected("summary-invalid");
  }

  const parsed = parsePayload(input.payload);
  if (!parsed) return rejected("payload-invalid");
  const snapshots = joinedSnapshots(parsed);
  if (snapshots.length === 0) return rejected("joined-snapshot-missing");

  const t1Snapshot = snapshots[snapshots.length - 1];
  const nowSeconds = Date.parse(input.now) / 1_000;
  if (t1Snapshot.date < nowSeconds - MAX_CURRENT_AGE_SECONDS) {
    return rejected("current-snapshot-stale");
  }
  if (t1Snapshot.date > nowSeconds + MAX_FUTURE_SKEW_SECONDS) {
    return rejected("current-snapshot-future");
  }
  const targetT0 = t1Snapshot.date - DAY_SECONDS;
  const exactT0 = snapshots.find((snapshot) => snapshot.date === targetT0);
  const left = exactT0 || [...snapshots].reverse().find((snapshot) => snapshot.date < targetT0);
  const right = exactT0 || snapshots.find((snapshot) => snapshot.date > targetT0);
  if (!left || !right) return rejected("24h-bracket-missing");

  const interpolationSpanSeconds = right.date - left.date;
  if (
    !exactT0 &&
    interpolationSpanSeconds > DEFILLAMA_PRICE_NEUTRAL_LIMITS_V2.maximumInterpolationSpanSeconds
  ) {
    return rejected("interpolation-span-too-wide");
  }

  const t0 = interpolateSnapshot(left, right, targetT0);
  const t1 = numericSnapshot(t1Snapshot);
  if (!t0 || !t1) return rejected("payload-invalid");

  let commonUsdAtT0 = 0;
  let commonUsdAtT1 = 0;
  let valueAtT1UsingT0Prices = 0;
  let matchedTokenCount = 0;
  for (const [token, quantityAtT0] of t0.quantities) {
    const quantityAtT1 = t1.quantities.get(token);
    const usdAtT0 = t0.usd.get(token);
    const usdAtT1 = t1.usd.get(token);
    if (
      quantityAtT1 === undefined ||
      usdAtT0 === undefined ||
      usdAtT1 === undefined ||
      usdAtT0 <= 0 ||
      usdAtT1 <= 0
    ) {
      continue;
    }
    const priceAtT0 = usdAtT0 / quantityAtT0;
    if (!Number.isFinite(priceAtT0) || priceAtT0 <= 0) continue;
    commonUsdAtT0 += usdAtT0;
    commonUsdAtT1 += usdAtT1;
    valueAtT1UsingT0Prices += quantityAtT1 * priceAtT0;
    matchedTokenCount += 1;
  }

  if (
    matchedTokenCount === 0 ||
    !Number.isFinite(commonUsdAtT0) ||
    !Number.isFinite(commonUsdAtT1) ||
    !Number.isFinite(valueAtT1UsingT0Prices) ||
    commonUsdAtT0 <= 0 ||
    commonUsdAtT1 <= 0 ||
    valueAtT1UsingT0Prices <= 0
  ) {
    return rejected("common-coverage-low");
  }

  const coverageAtT0 = commonUsdAtT0 / t0.totalUsd;
  const coverageAtT1 = commonUsdAtT1 / t1.totalUsd;
  const reconciliationErrorAtT0 = relativeError(t0.totalUsd, t0.tvlUsd);
  const reconciliationErrorAtT1 = relativeError(t1.totalUsd, t1.tvlUsd);
  const summaryTvlMismatch = relativeError(t1.tvlUsd, input.summaryTvlUsd);
  const grossReturn = t1.totalUsd / t0.totalUsd - 1;
  const summaryReturn = input.summaryChangePercent / 100;
  const grossMismatch = Math.abs(grossReturn - summaryReturn);
  const quantityGross = valueAtT1UsingT0Prices / commonUsdAtT0;
  const priceGross = commonUsdAtT1 / valueAtT1UsingT0Prices;
  const quantityReturn = quantityGross - 1;
  const priceReturn = priceGross - 1;
  const quantityMoveUsd = valueAtT1UsingT0Prices - commonUsdAtT0;
  const absoluteQuantityLog = Math.abs(Math.log(quantityGross));
  const absolutePriceLog = Math.abs(Math.log(priceGross));
  const logTotal = absoluteQuantityLog + absolutePriceLog;
  const quantityShare = logTotal > COMPARISON_EPSILON ? absoluteQuantityLog / logTotal : 0;

  if (![
    coverageAtT0,
    coverageAtT1,
    reconciliationErrorAtT0,
    reconciliationErrorAtT1,
    summaryTvlMismatch,
    grossReturn,
    grossMismatch,
    quantityReturn,
    priceReturn,
    quantityMoveUsd,
    quantityShare,
  ].every(Number.isFinite)) {
    return rejected("derived-metric-invalid");
  }

  const metrics: DefiLlamaPriceNeutralMetricsV2 = {
    t0: targetT0,
    t1: t1Snapshot.date,
    interpolatedT0: !exactT0,
    interpolationSpanSeconds,
    matchedTokenCount,
    coverageAtT0,
    coverageAtT1,
    reconciliationErrorAtT0,
    reconciliationErrorAtT1,
    summaryTvlMismatch,
    grossChangePercent: grossReturn * 100,
    grossMismatchPercentagePoints: grossMismatch * 100,
    quantityChangePercent: quantityReturn * 100,
    priceChangePercent: priceReturn * 100,
    quantityMoveUsd,
    quantityShare,
  };

  const reasons: DefiLlamaPriceNeutralReasonV2[] = [];
  if (
    coverageAtT0 + COMPARISON_EPSILON < DEFILLAMA_PRICE_NEUTRAL_LIMITS_V2.minimumCommonCoverage ||
    coverageAtT1 + COMPARISON_EPSILON < DEFILLAMA_PRICE_NEUTRAL_LIMITS_V2.minimumCommonCoverage
  ) {
    reasons.push("common-coverage-low");
  }
  if (
    reconciliationErrorAtT0 > DEFILLAMA_PRICE_NEUTRAL_LIMITS_V2.maximumReconciliationError + COMPARISON_EPSILON ||
    reconciliationErrorAtT1 > DEFILLAMA_PRICE_NEUTRAL_LIMITS_V2.maximumReconciliationError + COMPARISON_EPSILON
  ) {
    reasons.push("tvl-reconciliation-failed");
  }
  if (
    summaryTvlMismatch > DEFILLAMA_PRICE_NEUTRAL_LIMITS_V2.maximumReconciliationError + COMPARISON_EPSILON
  ) {
    reasons.push("summary-tvl-mismatch");
  }
  if (direction(grossReturn) !== direction(summaryReturn)) {
    reasons.push("gross-change-direction-mismatch");
  }
  if (
    grossMismatch >
    DEFILLAMA_PRICE_NEUTRAL_LIMITS_V2.maximumGrossMismatch + COMPARISON_EPSILON
  ) {
    reasons.push("gross-change-mismatch");
  }
  if (direction(quantityReturn) !== direction(summaryReturn)) {
    reasons.push("quantity-direction-mismatch");
  }
  if (
    Math.abs(quantityReturn) + COMPARISON_EPSILON <
    DEFILLAMA_PRICE_NEUTRAL_LIMITS_V2.minimumQuantityChange
  ) {
    reasons.push("quantity-change-below-threshold");
  }
  if (
    Math.abs(quantityMoveUsd) + USD_COMPARISON_EPSILON <
    DEFILLAMA_PRICE_NEUTRAL_LIMITS_V2.minimumQuantityMoveUsd
  ) {
    reasons.push("quantity-move-below-threshold");
  }
  if (
    quantityShare + COMPARISON_EPSILON < DEFILLAMA_PRICE_NEUTRAL_LIMITS_V2.minimumQuantityShare
  ) {
    reasons.push("quantity-share-below-threshold");
  }

  return { eligible: reasons.length === 0, reasons, metrics };
}
