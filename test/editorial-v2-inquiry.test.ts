import assert from "node:assert/strict";
import test from "node:test";
import { applyEditorialInquiryV2, reasonEditorialInquiryV2, validateEditorialInquiryV2 } from "../src/services/editorial-v2/inquiry.ts";
import { planEditorialV2 } from "../src/services/editorial-v2/planner.ts";
import type { EvidenceCardV2 } from "../src/services/editorial-v2/evidence.ts";
import { inquiryFixture } from "./helpers/editorial-inquiry.ts";
import { resolve72HourFollowUpV2 } from "../src/services/editorial-v2/follow-ups.ts";

const NOW = "2026-09-05T10:00:00.000Z";
const card: EvidenceCardV2 = {
  schemaVersion: 2, id: "fact:aave", subject: "Aave", lane: "protocol", kind: "signal",
  metric: { name: "tvl-change-24h", value: 8, raw: "+8%", unit: "%", period: "24h" },
  followUp: { metric: { name: "tvl-usd", value: 108, raw: "$108", unit: "USD", period: "snapshot" }, comparator: "lte", threshold: 100 },
  source: { provider: "defillama", url: "https://api.llama.fi/protocols", publishedAt: null, observedAt: NOW, origin: "direct", role: "primary" },
  freshness: { kind: "signal", measuredAt: NOW, maxAgeMs: 7_200_000, ageMs: 0, state: "fresh" },
  providerHealth: { provider: "defillama", state: "green", reason: "ok", checkedAt: NOW, latencyMs: 1, itemCount: 1 },
  provenance: { kind: "onchain-nutrient", sourceId: "aave" },
};
function plan() {
  const result = planEditorialV2({ evidence: [card], now: NOW });
  assert.equal(result.status, "planned");
  if (result.status !== "planned") throw new Error(result.reason);
  return result.plan;
}
const context = { factIds: [card.id], revisit: false, levelTest: true };

test("inquiry retries malformed reasoning once and passes its explanation to the plan", async () => {
  const inquiry = inquiryFixture({ factId: card.id, levelTest: true });
  const result = await reasonEditorialInquiryV2({ plan: plan(), evidence: card, model: { async generate({ attempt, prompt }) {
    assert.match(prompt, /무엇을 알아내고 싶은가/);
    assert.match(prompt, /왜 이 근거가 중요한가/);
    assert.match(prompt, /지난 판단 때문에/);
    if (attempt === 1) return JSON.stringify({ ...inquiry, factIds: ["invented"] });
    assert.match(prompt, /inquiry-fact-link-mismatch/);
    return JSON.stringify(inquiry);
  } } });
  assert.equal(result.status, "reasoned");
  if (result.status !== "reasoned") assert.fail(result.reason);
  assert.equal(result.attempts, 2);
  const applied = applyEditorialInquiryV2(plan(), card, result.inquiry);
  assert.equal(applied.thesis, inquiry.judgment);
  assert.equal(applied.editorialCase?.question, inquiry.question);
  assert.equal(applied.falsifier.threshold, 100);
});

test("current-level reasoning changes the actual 72h test without mutating source evidence", () => {
  const original = plan();
  const inquiry = { ...inquiryFixture({ factId: card.id, levelTest: true }), check: "current-level" as const };
  const stricter = applyEditorialInquiryV2(original, card, inquiry);
  const observedAt = original.followUpAt.due72h;
  const resolve = (falsifier: typeof original.falsifier) => resolve72HourFollowUpV2({
    now: observedAt, schedule: original.followUpAt, falsifier,
    observation: { metric: "tvl-usd", value: 104, observedAt },
  });
  assert.equal(resolve(original.falsifier).resolution, "supported");
  assert.equal(resolve(stricter.falsifier).resolution, "invalidated");
  assert.equal(original.falsifier.threshold, 100);
  assert.equal(card.followUp?.threshold, 100);
  assert.equal(stricter.falsifier.threshold, 108);
  for (let index = 0; index < 100; index++) assert.deepEqual(applyEditorialInquiryV2(original, card, inquiry), stricter);
});

test("a model can withhold instead of turning a measurable candidate into an obligatory thesis", () => {
  const inquiry = inquiryFixture({ factId: card.id });
  const result = applyEditorialInquiryV2(plan(), card, inquiry);
  assert.equal(result.format, "withhold");
  assert.equal(result.editorialCase?.hypothesis, null);
  assert.equal(result.editorialCase?.scope, "observation-only");
});

test("a falling level uses the opposite comparator and cannot manufacture a missing baseline", () => {
  const falling = { ...card, metric: { ...card.metric, value: -8, raw: "-8%" },
    followUp: { ...card.followUp!, metric: { ...card.followUp!.metric, value: 92, raw: "$92" }, comparator: "gte" as const } };
  const selected = planEditorialV2({ evidence: [falling], now: NOW });
  assert.equal(selected.status, "planned");
  if (selected.status !== "planned") assert.fail(selected.reason);
  const inquiry = { ...inquiryFixture({ factId: card.id, levelTest: true }), check: "current-level" as const };
  const tightened = applyEditorialInquiryV2(selected.plan, falling, inquiry);
  assert.equal(tightened.falsifier.threshold, 92);
  assert.equal(tightened.falsifier.comparator, "gt");
  assert.ok(validateEditorialInquiryV2(inquiry, { ...context, levelTest: false }).includes("inquiry-check-not-supported"));
});

for (const [name, patch, reason] of [
  ["missing question", { question: "" }, "inquiry-question-required"],
  ["missing significance", { whyThisEvidence: "" }, "inquiry-whyThisEvidence-required"],
  ["unsupported fact", { factIds: ["made-up"] }, "inquiry-fact-link-mismatch"],
  ["unsupported measurement", { check: "net-inflows" }, "inquiry-check-not-supported"],
  ["invented experience", { memory: { draftId: "imaginary", resolutionId: null, lesson: "learned", change: "changed" } }, "inquiry-invented-memory"],
] as const) {
  test(`inquiry fails closed on ${name}`, () => {
    const invalid = { ...inquiryFixture({ factId: card.id, levelTest: true }), ...patch };
    assert.ok(validateEditorialInquiryV2(invalid, context).includes(reason));
  });
}

test("a memory lesson must reference the actual draft and recorded outcome", () => {
  const memory = { beliefs: [], previous: { draftId: "prior", provenance: "shadow" as const, text: "record", thesis: "test", verdict: "digesting", recordedAt: NOW,
    outcome: { id: "result", checkpoint: "72h" as const, resolution: "invalidated" as const, reason: "falsifier-matched", resolvedAt: NOW } } };
  const inquiry = inquiryFixture({ factId: card.id, levelTest: true, memory });
  assert.deepEqual(validateEditorialInquiryV2(inquiry, { ...context, memory }), []);
  assert.ok(validateEditorialInquiryV2({ ...inquiry, memory: { ...inquiry.memory!, resolutionId: "forged" } }, { ...context, memory }).includes("inquiry-memory-link-mismatch"));
  assert.ok(validateEditorialInquiryV2({ ...inquiry, memory: { ...inquiry.memory!, change: "" } }, { ...context, memory }).includes("inquiry-memory-change-required"));
});

test("Revisit cannot rewrite a past test as a new stricter test", () => {
  const inquiry = inquiryFixture({ factId: card.id, levelTest: true });
  assert.ok(validateEditorialInquiryV2(inquiry, { ...context, revisit: true }).includes("inquiry-check-not-supported"));
});

test("explicit no-public-value and missing model output stop before writing without fallback", async () => {
  let calls = 0;
  const declined = await reasonEditorialInquiryV2({ plan: plan(), evidence: card, model: { async generate() {
    calls++; return JSON.stringify({ decision: "no-post", reason: "현재 자료로 새로운 질문을 구별할 수 없다" });
  } } });
  assert.equal(declined.status, "blocked");
  assert.match(declined.status === "blocked" ? declined.reason : "", /inquiry-no-public-value/);
  assert.equal(calls, 1);
  const empty = await reasonEditorialInquiryV2({ plan: plan(), evidence: card, model: { async generate() { return null; } } });
  assert.equal(empty.status, "blocked");
  assert.equal(empty.attempts, 1);
  const malformed = await reasonEditorialInquiryV2({ plan: plan(), evidence: card, model: { async generate() { return "not JSON"; } } });
  assert.equal(malformed.status, "blocked");
  assert.equal(malformed.attempts, 2);
});
