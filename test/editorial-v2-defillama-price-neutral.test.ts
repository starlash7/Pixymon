import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFILLAMA_PRICE_NEUTRAL_LIMITS_V2,
  evaluateDefiLlamaPriceNeutralV2,
} from "../src/services/editorial-v2/defillama-price-neutral.ts";

const DAY_SECONDS = 24 * 60 * 60;
const T1 = 1_800_000_000;
const T0 = T1 - DAY_SECONDS;

type TokenValues = Record<string, number>;

interface Point {
  date: number;
  quantities: TokenValues;
  prices: TokenValues;
  tvlScale?: number;
}

function usdValues(point: Point): TokenValues {
  return Object.fromEntries(
    Object.entries(point.quantities).map(([token, quantity]) => [token, quantity * point.prices[token]])
  );
}

function payload(points: Point[]): unknown {
  return {
    tokens: points.map((point) => ({ date: point.date, tokens: point.quantities })),
    tokensInUsd: points.map((point) => ({ date: point.date, tokens: usdValues(point) })),
    tvl: points.map((point) => ({
      date: point.date,
      totalLiquidityUSD:
        Object.values(usdValues(point)).reduce((sum, value) => sum + value, 0) /
        (point.tvlScale ?? 1),
    })),
  };
}

function evaluate(points: Point[], summaryChangePercent: number) {
  const latest = points.reduce((current, point) => point.date > current.date ? point : current);
  const summaryTvlUsd = Object.values(usdValues(latest)).reduce((sum, value) => sum + value, 0) /
    (latest.tvlScale ?? 1);
  return evaluateDefiLlamaPriceNeutralV2({
    payload: payload(points),
    summaryTvlUsd,
    summaryChangePercent,
    now: new Date(T1 * 1_000).toISOString(),
  });
}

test("Lido-like price repricing is rejected as price dominated", () => {
  const result = evaluate([
    { date: T0, quantities: { WETH: 1_000_000 }, prices: { WETH: 2_000 } },
    { date: T1, quantities: { WETH: 1_000_000 }, prices: { WETH: 2_106.4 } },
  ], 5.25);

  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes("quantity-change-below-threshold"));
  assert.ok(result.reasons.includes("quantity-move-below-threshold"));
  assert.ok(result.reasons.includes("quantity-share-below-threshold"));
  assert.ok(result.metrics);
  assert.ok(Math.abs(result.metrics.quantityChangePercent) < 1e-9);
  assert.ok(Math.abs(result.metrics.priceChangePercent - 5.32) < 1e-9);
  assert.equal(result.metrics.quantityShare, 0);
});

test("quantity-driven TVL change passes every hard gate", () => {
  const result = evaluate([
    { date: T0, quantities: { WETH: 1_000_000 }, prices: { WETH: 2_000 } },
    { date: T1, quantities: { WETH: 1_080_000 }, prices: { WETH: 2_100 } },
  ], 13.4);

  assert.deepEqual(result.reasons, []);
  assert.equal(result.eligible, true);
  assert.ok(result.metrics);
  assert.ok(Math.abs(result.metrics.quantityChangePercent - 8) < 1e-9);
  assert.ok(Math.abs(result.metrics.priceChangePercent - 5) < 1e-9);
  assert.ok(result.metrics.quantityShare > 0.5);
  assert.equal(result.metrics.quantityMoveUsd, 160_000_000);
});

test("date join is order-independent and interpolates the exact 24h target", () => {
  const left = T0 - 6 * 60 * 60;
  const right = T0 + 18 * 60 * 60;
  const points = [
    { date: left, quantities: { ETH: 100_000_000 }, prices: { ETH: 2 } },
    { date: right, quantities: { ETH: 124_000_000 }, prices: { ETH: 2 } },
    { date: T1, quantities: { ETH: 111_300_000 }, prices: { ETH: 2 } },
  ];
  const built = payload(points) as {
    tokens: unknown[];
    tokensInUsd: unknown[];
    tvl: unknown[];
  };
  built.tokens = [built.tokens[2], built.tokens[0], built.tokens[1]];
  built.tokensInUsd = [built.tokensInUsd[1], built.tokensInUsd[2], built.tokensInUsd[0]];
  built.tvl = [{ date: T1 + 60, totalLiquidityUSD: 999 }, built.tvl[2], built.tvl[0], built.tvl[1]];

  const result = evaluateDefiLlamaPriceNeutralV2({
    payload: built,
    summaryTvlUsd: 222_600_000,
    summaryChangePercent: 5,
    now: new Date(T1 * 1_000).toISOString(),
  });

  assert.equal(result.eligible, true);
  assert.ok(result.metrics);
  assert.equal(result.metrics.t0, T0);
  assert.equal(result.metrics.t1, T1);
  assert.equal(result.metrics.interpolatedT0, true);
  assert.equal(result.metrics.interpolationSpanSeconds, DAY_SECONDS);
  assert.ok(Math.abs(result.metrics.quantityChangePercent - 5) < 1e-9);
  assert.equal(result.metrics.quantityMoveUsd, 10_600_000);
});

test("common-token coverage is inclusive at 95% and fails immediately below it", () => {
  function coveragePayload(commonStart: number, unmatchedStart: number): unknown {
    const commonEnd = commonStart * 1.03;
    const unmatchedEnd = unmatchedStart * 1.03;
    return {
      tokens: [
        { date: T0, tokens: { COMMON: commonStart } },
        { date: T1, tokens: { COMMON: commonEnd } },
      ],
      tokensInUsd: [
        { date: T0, tokens: { COMMON: commonStart, UNMATCHED: unmatchedStart } },
        { date: T1, tokens: { COMMON: commonEnd, UNMATCHED: unmatchedEnd } },
      ],
      tvl: [
        { date: T0, totalLiquidityUSD: commonStart + unmatchedStart },
        { date: T1, totalLiquidityUSD: commonEnd + unmatchedEnd },
      ],
    };
  }

  const atBoundary = evaluateDefiLlamaPriceNeutralV2({
    payload: coveragePayload(950_000_000, 50_000_000),
    summaryTvlUsd: 1_030_000_000,
    summaryChangePercent: 3,
    now: new Date(T1 * 1_000).toISOString(),
  });
  assert.equal(atBoundary.reasons.includes("common-coverage-low"), false);
  assert.equal(atBoundary.eligible, true);

  const belowCommon = 949_900_000;
  const belowUnmatched = 1_000_000_000 - belowCommon;
  const belowBoundary = evaluateDefiLlamaPriceNeutralV2({
    payload: coveragePayload(belowCommon, belowUnmatched),
    summaryTvlUsd: 1_030_000_000,
    summaryChangePercent: 3,
    now: new Date(T1 * 1_000).toISOString(),
  });
  assert.equal(belowBoundary.eligible, false);
  assert.ok(belowBoundary.reasons.includes("common-coverage-low"));
});

test("reconciliation error is inclusive at 2% and blocks above it", () => {
  const base = [
    { date: T0, quantities: { ETH: 500_000_000 }, prices: { ETH: 1 }, tvlScale: 1.02 },
    { date: T1, quantities: { ETH: 515_000_000 }, prices: { ETH: 1 }, tvlScale: 1.02 },
  ];
  const atBoundary = evaluate(base, 3);
  assert.equal(atBoundary.reasons.includes("tvl-reconciliation-failed"), false);

  const overBoundary = evaluate(base.map((point) => ({ ...point, tvlScale: 1.0201 })), 3);
  assert.ok(overBoundary.reasons.includes("tvl-reconciliation-failed"));
});

test("gross mismatch tolerance is inclusive and direction is checked separately", () => {
  const eighteenPercent = [
    { date: T0, quantities: { ETH: 500_000_000 }, prices: { ETH: 1 } },
    { date: T1, quantities: { ETH: 590_000_000 }, prices: { ETH: 1 } },
  ];
  const atBoundary = evaluate(eighteenPercent, 20);
  assert.equal(atBoundary.reasons.includes("gross-change-mismatch"), false);

  const overBoundary = evaluate([
    eighteenPercent[0],
    { date: T1, quantities: { ETH: 589_950_000 }, prices: { ETH: 1 } },
  ], 20);
  assert.ok(overBoundary.reasons.includes("gross-change-mismatch"));

  const tenPercent = evaluate([
    eighteenPercent[0],
    { date: T1, quantities: { ETH: 550_000_000 }, prices: { ETH: 1 } },
  ], 20);
  assert.ok(tenPercent.reasons.includes("gross-change-mismatch"));

  const oppositeQuantity = evaluate([
    { date: T0, quantities: { ETH: 500_000_000 }, prices: { ETH: 1 } },
    { date: T1, quantities: { ETH: 485_000_000 }, prices: { ETH: 1.1 } },
  ], 6.7);
  assert.ok(oppositeQuantity.reasons.includes("quantity-direction-mismatch"));
});

test("2%, $10m, and 50% quantity-share thresholds are inclusive", () => {
  const atBoundary = evaluate([
    { date: T0, quantities: { ETH: 500_000_000 }, prices: { ETH: 1 } },
    { date: T1, quantities: { ETH: 510_000_000 }, prices: { ETH: 1.02 } },
  ], 4.04);
  assert.equal(atBoundary.eligible, true);
  assert.deepEqual(atBoundary.reasons, []);
  assert.ok(atBoundary.metrics);
  assert.ok(Math.abs(atBoundary.metrics.quantityShare - DEFILLAMA_PRICE_NEUTRAL_LIMITS_V2.minimumQuantityShare) < 1e-12);

  const belowMove = evaluate([
    { date: T0, quantities: { ETH: 499_000_000 }, prices: { ETH: 1 } },
    { date: T1, quantities: { ETH: 508_980_000 }, prices: { ETH: 1.02 } },
  ], 4.04);
  assert.ok(belowMove.reasons.includes("quantity-move-below-threshold"));

  const belowShare = evaluate([
    { date: T0, quantities: { ETH: 500_000_000 }, prices: { ETH: 1 } },
    { date: T1, quantities: { ETH: 510_000_000 }, prices: { ETH: 1.0201 } },
  ], 4.0502);
  assert.ok(belowShare.reasons.includes("quantity-share-below-threshold"));

  const belowPercent = evaluate([
    { date: T0, quantities: { ETH: 1_000_000_000 }, prices: { ETH: 1 } },
    { date: T1, quantities: { ETH: 1_019_990_000 }, prices: { ETH: 1 } },
  ], 1.999);
  assert.ok(belowPercent.reasons.includes("quantity-change-below-threshold"));
});

test("missing 24h bracket and malformed payload fail closed with stable reasons", () => {
  const noBracket = evaluate([
    { date: T1 - 12 * 60 * 60, quantities: { ETH: 500_000_000 }, prices: { ETH: 1 } },
    { date: T1, quantities: { ETH: 515_000_000 }, prices: { ETH: 1 } },
  ], 3);
  assert.deepEqual(noBracket.reasons, ["24h-bracket-missing"]);
  assert.equal(noBracket.metrics, null);

  const malformed = evaluateDefiLlamaPriceNeutralV2({
    payload: { tokens: [], tokensInUsd: "not-an-array", tvl: [] },
    summaryTvlUsd: 1_000_000_000,
    summaryChangePercent: 3,
    now: new Date(T1 * 1_000).toISOString(),
  });
  assert.deepEqual(malformed.reasons, ["payload-invalid"]);
  assert.equal(malformed.metrics, null);
});

test("wide interpolation, shifted joins, and millisecond timestamps fail closed", () => {
  const wideInterpolation = evaluate([
    { date: T0 - 14 * 60 * 60, quantities: { ETH: 500_000_000 }, prices: { ETH: 1 } },
    { date: T0 + 14 * 60 * 60, quantities: { ETH: 510_000_000 }, prices: { ETH: 1 } },
    { date: T1, quantities: { ETH: 520_000_000 }, prices: { ETH: 1 } },
  ], 4);
  assert.deepEqual(wideInterpolation.reasons, ["interpolation-span-too-wide"]);

  const shifted = payload([
    { date: T0, quantities: { ETH: 500_000_000 }, prices: { ETH: 1 } },
    { date: T1, quantities: { ETH: 515_000_000 }, prices: { ETH: 1 } },
  ]) as { tokens: Array<{ date: number }>; tokensInUsd: Array<{ date: number }>; tvl: unknown[] };
  shifted.tokensInUsd[1].date += 1;
  const shiftedResult = evaluateDefiLlamaPriceNeutralV2({
    payload: shifted,
    summaryTvlUsd: 515_000_000,
    summaryChangePercent: 3,
    now: new Date(T1 * 1_000).toISOString(),
  });
  assert.deepEqual(shiftedResult.reasons, ["current-snapshot-stale"]);

  const milliseconds = payload([
    { date: T0 * 1_000, quantities: { ETH: 500_000_000 }, prices: { ETH: 1 } },
    { date: T1 * 1_000, quantities: { ETH: 515_000_000 }, prices: { ETH: 1 } },
  ]);
  const millisecondResult = evaluateDefiLlamaPriceNeutralV2({
    payload: milliseconds,
    summaryTvlUsd: 515_000_000,
    summaryChangePercent: 3,
    now: new Date(T1 * 1_000).toISOString(),
  });
  assert.deepEqual(millisecondResult.reasons, ["payload-invalid"]);
});

test("latest joined detail snapshot must be current", () => {
  const points = [
    { date: T0, quantities: { ETH: 500_000_000 }, prices: { ETH: 1 } },
    { date: T1, quantities: { ETH: 515_000_000 }, prices: { ETH: 1 } },
  ];
  const stale = evaluateDefiLlamaPriceNeutralV2({
    payload: payload(points),
    summaryTvlUsd: 515_000_000,
    summaryChangePercent: 3,
    now: new Date((T1 + 2 * 60 * 60 + 1) * 1_000).toISOString(),
  });
  assert.deepEqual(stale.reasons, ["current-snapshot-stale"]);

  const future = evaluateDefiLlamaPriceNeutralV2({
    payload: payload(points),
    summaryTvlUsd: 515_000_000,
    summaryChangePercent: 3,
    now: new Date((T1 - 5 * 60 - 1) * 1_000).toISOString(),
  });
  assert.deepEqual(future.reasons, ["current-snapshot-future"]);
});

test("non-finite derived ratios fail closed", () => {
  const result = evaluateDefiLlamaPriceNeutralV2({
    payload: {
      tokens: [
        { date: T0, tokens: { EXTREME: 1 } },
        { date: T1, tokens: { EXTREME: Number.MAX_VALUE } },
      ],
      tokensInUsd: [
        { date: T0, tokens: { EXTREME: Number.MIN_VALUE } },
        { date: T1, tokens: { EXTREME: 1 } },
      ],
      tvl: [
        { date: T0, totalLiquidityUSD: Number.MIN_VALUE },
        { date: T1, totalLiquidityUSD: 1 },
      ],
    },
    summaryTvlUsd: 1,
    summaryChangePercent: 3,
    now: new Date(T1 * 1_000).toISOString(),
  });
  assert.deepEqual(result.reasons, ["derived-metric-invalid"]);
  assert.equal(result.metrics, null);
});
