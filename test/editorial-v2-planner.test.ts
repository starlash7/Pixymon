import test from "node:test";
import assert from "node:assert/strict";
import { planEditorialV2 } from "../src/services/editorial-v2/planner.ts";
import type { EvidenceCardV2 } from "../src/services/editorial-v2/evidence.ts";

const NOW = "2026-08-28T10:00:00.000Z";

function card(overrides: Partial<EvidenceCardV2> = {}): EvidenceCardV2 {
  return {
    schemaVersion: 2,
    id: "fact:ethereum:tvl",
    lane: "protocol",
    kind: "signal",
    subject: "Ethereum",
    metric: { name: "tvl-change-24h", value: 8.4, raw: "+8.4%", unit: "%", period: "24h" },
    source: {
      provider: "defillama",
      url: "https://api.llama.fi/v2/chains",
      publishedAt: null,
      observedAt: "2026-08-28T09:30:00.000Z",
      origin: "direct",
      role: "primary",
    },
    freshness: { kind: "signal", measuredAt: "2026-08-28T09:30:00.000Z", maxAgeMs: 7_200_000, ageMs: 1_800_000, state: "fresh" },
    providerHealth: { provider: "defillama", state: "green", reason: "ok", checkedAt: NOW, latencyMs: 10, itemCount: 1 },
    provenance: { kind: "onchain-nutrient", sourceId: "ethereum:tvl" },
    ...overrides,
  };
}

test("planner is deterministic for the same fixture and seed", () => {
  const input = { evidence: [card(), card({ id: "fact:solana:tvl", subject: "Solana" })], now: NOW, selectionSeed: "seed-1" };
  const first = planEditorialV2(input);
  for (let index = 0; index < 100; index += 1) assert.deepEqual(planEditorialV2(input), first);
});

test("hard Tier A failure records a stage and reason", () => {
  const result = planEditorialV2({
    evidence: [card({ source: { ...card().source, origin: "derived" } })],
    now: NOW,
  });
  assert.equal(result.status, "blocked");
  if (result.status === "planned") assert.fail("unexpected plan");
  assert.equal(result.stage, "eligibility");
  assert.equal(result.reason, "no-tier-a-evidence");
  assert.ok(result.blockReasons.includes("not-direct"));
});

test("due revisit wins and 24h unchanged evidence stays silent", () => {
  const changed = card({ metric: { ...card().metric, value: 6.1, raw: "+6.1%" } });
  const due = [{ draftId: "draft-1", subject: "Ethereum", metricName: "tvl-change-24h", baselineValue: 8.4, dueAt: "2026-08-28T09:00:00.000Z", checkpoint: "24h" as const }];
  const result = planEditorialV2({ evidence: [], followUpEvidence: [changed], dueRevisits: due, now: NOW });
  assert.equal(result.status, "planned");
  if (result.status === "blocked") assert.fail(result.reason);
  assert.equal(result.plan.format, "revisit");
  assert.equal(result.plan.continuityThread, "draft-1:24h");

  const unchanged = planEditorialV2({ evidence: [card()], followUpEvidence: [card()], dueRevisits: due, now: NOW });
  assert.equal(unchanged.status, "blocked");
  if (unchanged.status === "blocked") assert.equal(unchanged.reason, "followup-no-change");
});

test("planner preserves event significance before using the seed as a tie-break", () => {
  const large = card({ id: "large", subject: "Large Move", metric: { ...card().metric, value: 50, raw: "+50%" } });
  const small = card({ id: "small", subject: "Small Move", metric: { ...card().metric, value: 2, raw: "+2%" } });
  for (let index = 0; index < 20; index += 1) {
    const result = planEditorialV2({ evidence: [small, large], now: NOW, selectionSeed: `seed-${index}` });
    assert.equal(result.status, "planned");
    if (result.status === "planned") assert.equal(result.evidence.id, "large");
  }
});

test("absolute TVL moved outranks a noisier percentage on a tiny base", () => {
  const noisySmall = card({
    id: "noisy-small",
    subject: "Noisy Small",
    metric: { ...card().metric, value: 30, raw: "+30%" },
    followUp: {
      metric: { name: "tvl-usd", value: 130_000_000, raw: "$130.00M", unit: "USD", period: "snapshot" },
      comparator: "lt",
      threshold: 100_000_000,
    },
  });
  const broadMove = card({
    id: "broad-move",
    subject: "Broad Move",
    metric: { ...card().metric, value: 5, raw: "+5%" },
    followUp: {
      metric: { name: "tvl-usd", value: 10_500_000_000, raw: "$10.50B", unit: "USD", period: "snapshot" },
      comparator: "lt",
      threshold: 10_000_000_000,
    },
  });
  const result = planEditorialV2({ evidence: [noisySmall, broadMove], now: NOW, selectionSeed: "any" });
  assert.equal(result.status, "planned");
  if (result.status === "planned") assert.equal(result.evidence.id, "broad-move");
});

test("Bite and Withhold reflect evidence materiality instead of bullish direction", () => {
  const moderatePositive = planEditorialV2({ evidence: [card()], now: NOW });
  assert.equal(moderatePositive.status, "planned");
  if (moderatePositive.status === "planned") {
    assert.equal(moderatePositive.plan.format, "withhold");
    assert.equal(moderatePositive.plan.verdict, "digesting");
  }

  const materialNegative = planEditorialV2({
    evidence: [card({ metric: { ...card().metric, value: -12, raw: "-12%" } })],
    now: NOW,
  });
  assert.equal(materialNegative.status, "planned");
  if (materialNegative.status === "planned") {
    assert.equal(materialNegative.plan.format, "bite");
    assert.equal(materialNegative.plan.verdict, "reject");
  }
});

test("planner falsifies a rolling TVL event against its absolute TVL baseline", () => {
  const result = planEditorialV2({
    evidence: [card({
      followUp: {
        metric: { name: "tvl-usd", value: 108_000_000, raw: "$108.00M", unit: "USD", period: "snapshot" },
        comparator: "lt",
        threshold: 100_000_000,
      },
    })],
    now: NOW,
  });
  assert.equal(result.status, "planned");
  if (result.status === "planned") {
    assert.equal(result.plan.falsifier.metric, "tvl-usd");
    assert.equal(result.plan.falsifier.threshold, 100_000_000);
    assert.equal(result.plan.followUpAt.due72h, "2026-08-31T10:00:00.000Z");
    assert.doesNotMatch(result.plan.thesis, /72시간|다음|재검증|확인한다/);
    assert.match(result.plan.thesis, /더 큰 서사는 승인하지 않는다/);
  }
});

test("same subject inside 24h needs a new numeric value", () => {
  const history = [{ subject: "Ethereum", metricName: "tvl-change-24h", metricValue: 8.4, factId: "old", publishedAt: "2026-08-28T01:00:00.000Z" }];
  const blocked = planEditorialV2({ evidence: [card()], history, now: NOW });
  assert.equal(blocked.status, "blocked");
  if (blocked.status === "blocked") assert.equal(blocked.reason, "subject-repeat-without-delta");

  const planned = planEditorialV2({ evidence: [card({ metric: { ...card().metric, value: 9.1, raw: "+9.1%" } })], history, now: NOW });
  assert.equal(planned.status, "planned");

  const noise = planEditorialV2({ evidence: [card({ metric: { ...card().metric, value: 8.41, raw: "+8.41%" } })], history, now: NOW });
  assert.equal(noise.status, "blocked");
  if (noise.status === "blocked") assert.equal(noise.reason, "subject-repeat-without-delta");
});

test("subject novelty follows a provider-stable key across display-name changes", () => {
  const current = card({ subject: "Aave V3", subjectKey: "aave-v3" });
  const history = [{
    subject: "Aave v3 old label",
    subjectKey: "aave-v3",
    provider: "defillama",
    metricName: "tvl-change-24h",
    metricValue: 8.4,
    factId: "old",
    publishedAt: "2026-08-28T01:00:00.000Z",
  }];

  const result = planEditorialV2({ evidence: [current], history, now: NOW });
  assert.equal(result.status, "blocked");
  if (result.status === "blocked") assert.equal(result.reason, "subject-repeat-without-delta");
});
