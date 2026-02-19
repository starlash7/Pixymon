import test from "node:test";
import assert from "node:assert/strict";
import { digestNutrients, computeDigestScore, convertDigestToXp } from "../src/services/digest-engine.ts";
import { OnchainNutrient, NutrientLedgerEntry } from "../src/types/agent.ts";

function nutrient(overrides: Partial<OnchainNutrient>): OnchainNutrient {
  return {
    id: "n1",
    source: "onchain",
    category: "stablecoin-flow",
    label: "스테이블 유입",
    value: "+$120M",
    evidence: "스테이블 공급 증가",
    trust: 0.8,
    freshness: 0.9,
    consistencyHint: 0.7,
    capturedAt: new Date().toISOString(),
    ...overrides,
  };
}

test("computeDigestScore returns bounded weighted score", () => {
  const score = computeDigestScore(
    nutrient({ trust: 0.82, freshness: 0.92, consistencyHint: 0.76 }),
    []
  );
  assert.ok(score.total >= 0 && score.total <= 1);
  assert.ok(score.reasonCodes.length > 0);
});

test("convertDigestToXp rewards high quality onchain nutrients", () => {
  const xp = convertDigestToXp(
    {
      trust: 0.85,
      freshness: 0.88,
      consistency: 0.8,
      total: 0.84,
      reasonCodes: ["high-quality"],
    },
    nutrient({ metadata: { importance: "high" } })
  );
  assert.ok(xp >= 10);
});

test("digestNutrients applies threshold and deduplicates", () => {
  const now = new Date().toISOString();
  const entries: NutrientLedgerEntry[] = [
    {
      id: "l1",
      nutrientId: "prev1",
      source: "onchain",
      category: "stablecoin-flow",
      label: "스테이블 유입",
      digestScore: {
        trust: 0.7,
        freshness: 0.7,
        consistency: 0.75,
        total: 0.72,
        reasonCodes: ["medium-quality"],
      },
      xpGain: 8,
      accepted: true,
      capturedAt: now,
    },
  ];

  const result = digestNutrients(
    [
      nutrient({ id: "dup-a", label: "스테이블 유입", value: "+$120M" }),
      nutrient({ id: "dup-b", label: "스테이블 유입", value: "+$120M" }),
      nutrient({ id: "weak", source: "news", trust: 0.2, freshness: 0.3, label: "저신뢰 뉴스", category: "headline" }),
    ],
    entries,
    { minDigestScore: 0.55, maxItems: 8 }
  );

  assert.equal(result.intakeCount, 2);
  assert.ok(result.acceptedCount >= 1);
  assert.ok(result.records.some((item) => !item.accepted));
});
