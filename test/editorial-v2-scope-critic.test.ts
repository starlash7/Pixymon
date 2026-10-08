import assert from "node:assert/strict";
import test from "node:test";
import { planEditorialV2 } from "../src/services/editorial-v2/planner.ts";
import { reasonEditorialInquiryV2 } from "../src/services/editorial-v2/inquiry.ts";
import {
  buildEditorialScopeCriticPromptV2,
  editorialScopeTextDigestV2,
  reviewEditorialScopeV2,
} from "../src/services/editorial-v2/scope-critic.ts";
import {
  editorialDraftValidationInputV2,
  splitEditorialSentencesV2,
  validateEditorialDraftV2,
} from "../src/services/editorial-v2/validator.ts";
import { writeEditorialDraftV2, type EditorialWriterModelV2 } from "../src/services/editorial-v2/writer.ts";
import type { EvidenceCardV2 } from "../src/services/editorial-v2/evidence.ts";
import { inquiryFixture } from "./helpers/editorial-inquiry.ts";

const NOW = "2026-10-08T07:30:00.000Z";
const STARGATE: EvidenceCardV2 = {
  schemaVersion: 2,
  id: "fact:stargate:tvl",
  lane: "protocol",
  kind: "signal",
  subject: "Stargate V2",
  metric: { name: "tvl-change-24h", value: -33.54, raw: "-33.54%", unit: "%", period: "24h" },
  source: { provider: "defillama", url: "https://api.llama.fi/protocol/stargate-v2", publishedAt: null, observedAt: "2026-10-08T07:10:00.000Z", origin: "direct", role: "primary" },
  freshness: { kind: "signal", measuredAt: "2026-10-08T07:10:00.000Z", maxAgeMs: 7_200_000, ageMs: 1_200_000, state: "fresh" },
  providerHealth: { provider: "defillama", state: "green", reason: "ok", checkedAt: NOW, latencyMs: 10, itemCount: 1 },
  provenance: { kind: "onchain-nutrient", sourceId: "stargate-v2:tvl" },
};
// Regex flags "유입" here; the sentence only says the number cannot tell.
const HEDGED = "Stargate가 하루 만에 확 홀쭉해졌는데 가격은 멀쩡함. 유입이 끊긴 건지 지갑만 옮긴 건지는 이 숫자로 가늠이 안 됨. 조용히 빠지는 쪽이 늘 더 오래 기억에 남더라.";
// Regex-clean paraphrase that still asserts an outflow.
const PARAPHRASED = "Stargate가 하루 만에 확 홀쭉해졌는데 가격은 멀쩡함. 결국 돈 주인들이 짐 싸서 나간 모양임. 조용히 빠지는 쪽이 늘 더 오래 기억에 남더라.";
const CLEAN = "Stargate가 하루 만에 확 홀쭉해졌는데 가격은 멀쩡함. 사람이 떠난 건지 지갑만 옮긴 건지 픽시는 아직 모르겠음. 조용히 빠지는 쪽이 늘 더 오래 기억에 남더라.";

function thoughtPlan() {
  const result = planEditorialV2({ evidence: [STARGATE], now: NOW });
  if (result.status !== "planned") assert.fail(result.reason);
  return { ...result.plan, rendering: "thought" as const };
}

function payload(draft: string) {
  return JSON.stringify({ draft, usedFactIds: [STARGATE.id], claims: splitEditorialSentencesV2(draft).map((text, index) => ({
    kind: index === 0 ? "observation" : "judgment", text, factIds: [STARGATE.id] })) });
}

function critic(verdicts: Array<"pass" | "fail" | "error">, prompts: string[] = []): EditorialWriterModelV2 {
  return { modelId: "critic-test", async generate({ prompt }) {
    prompts.push(prompt);
    const verdict = verdicts.shift();
    if (verdict === "error") throw new Error("gemini-http-503");
    return JSON.stringify(verdict === "pass" ? { verdict: "pass", claim: "", problem: "" }
      : { verdict: "fail", claim: "결국 돈 주인들이 짐 싸서 나간 모양임.", problem: "TVL로 유출을 확인할 수 없음" });
  } };
}

test("scope critic sees the measurement, the price context and the text", () => {
  const withPrice = { ...STARGATE, selection: { priceNeutral: { priceChangePercent: -0.94 } } } as unknown as EvidenceCardV2;
  const prompt = buildEditorialScopeCriticPromptV2(CLEAN, withPrice);
  assert.match(prompt, /tvl-change-24h = -33\.54%/);
  assert.match(prompt, /-0\.94%/);
  assert.ok(prompt.includes(CLEAN));
});

test("scope critic results are explicit: pass carries a digest, malformed output is unavailable", async () => {
  const pass = await reviewEditorialScopeV2({ model: critic(["pass"]), text: CLEAN, evidence: STARGATE });
  assert.equal(pass.status, "pass");
  if (pass.status === "pass") assert.equal(pass.review.textSha256, editorialScopeTextDigestV2(CLEAN));
  const fail = await reviewEditorialScopeV2({ model: critic(["fail"]), text: PARAPHRASED, evidence: STARGATE });
  assert.equal(fail.status, "fail");
  assert.deepEqual(await reviewEditorialScopeV2({ model: critic(["error"]), text: CLEAN, evidence: STARGATE }),
    { status: "unavailable", reason: "gemini-http-503" });
  const malformed = { async generate() { return "{\"verdict\":\"maybe\"}"; } };
  assert.deepEqual(await reviewEditorialScopeV2({ model: malformed, text: CLEAN, evidence: STARGATE }),
    { status: "unavailable", reason: "scope-critic-contract" });
});

test("a critic pass clears a regex false positive on a hedge, for exactly that text", async () => {
  const regexOnly = validateEditorialDraftV2(editorialDraftValidationInputV2({
    text: HEDGED, subject: STARGATE.subject, fact: STARGATE, factIds: [STARGATE.id], usedFactIds: [STARGATE.id], rendering: "thought" }));
  assert.deepEqual(regexOnly.reasons, ["metric-semantic-scope"]);
  const result = await writeEditorialDraftV2({ plan: thoughtPlan(), evidence: STARGATE, scopeCritic: critic(["pass"]),
    model: { async generate() { return payload(HEDGED); } } });
  assert.equal(result.status, "generated", JSON.stringify(result));
  if (result.status !== "generated") return;
  const revalidate = (text: string) => validateEditorialDraftV2(editorialDraftValidationInputV2({
    text, subject: STARGATE.subject, fact: STARGATE, factIds: [STARGATE.id], usedFactIds: [STARGATE.id],
    rendering: "thought", scopeReview: result.scopeReview }));
  assert.deepEqual(revalidate(HEDGED).reasons, []);
  // A human edit is new text; the regex floor applies again.
  assert.ok(revalidate(HEDGED.replace("가늠이 안 됨", "가늠이 안 됨, 아마도")).reasons.includes("metric-semantic-scope"));
});

test("a critic fail catches a paraphrased outflow the regex missed and feeds it back once", async () => {
  const drafts = [PARAPHRASED, CLEAN];
  const writerPrompts: string[] = [];
  const result = await writeEditorialDraftV2({ plan: thoughtPlan(), evidence: STARGATE, scopeCritic: critic(["fail", "pass"]),
    model: { async generate({ prompt }) { writerPrompts.push(prompt); return payload(drafts.shift()!); } } });
  assert.equal(result.status, "generated", JSON.stringify(result));
  if (result.status === "generated") assert.equal(result.payload.draft, CLEAN);
  assert.match(writerPrompts[1], /짐 싸서 나간 모양임.*확인할 수 없는 해석/);
});

test("an unavailable critic stops the draft instead of publishing on the regex floor", async () => {
  let writerCalls = 0;
  const result = await writeEditorialDraftV2({ plan: thoughtPlan(), evidence: STARGATE, scopeCritic: critic(["error"]),
    model: { async generate() { writerCalls += 1; return payload(CLEAN); } } });
  assert.deepEqual(result, { status: "blocked", stage: "scope", reason: "gemini-http-503", attempts: 1, validationReasons: ["gemini-http-503"] });
  assert.equal(writerCalls, 1);
});

test("other contract failures never reach the critic", async () => {
  const prompts: string[] = [];
  const result = await writeEditorialDraftV2({ plan: thoughtPlan(), evidence: STARGATE, scopeCritic: critic([], prompts),
    model: { async generate() { return payload("Stargate가 홀쭉해졌습니다. 픽시는 아직 모르겠습니다."); } } });
  assert.equal(result.status, "blocked");
  assert.equal(prompts.length, 0);
});

test("the inquiry judgment gets the same semantic check before writing", async () => {
  const base = inquiryFixture({ factId: STARGATE.id, levelTest: true });
  const plan = thoughtPlan();
  const levelPlan = { ...plan, editorialCase: { ...plan.editorialCase!, scope: "usd-tvl-level" as const } };
  const hedged = { ...base, judgment: "유입이 끊긴 건지 지갑만 옮긴 건지는 이 숫자로 가늠이 안 된다." };
  const cleared = await reasonEditorialInquiryV2({ plan: levelPlan, evidence: STARGATE, scopeCritic: critic(["pass"]),
    model: { async generate() { return JSON.stringify(hedged); } } });
  assert.equal(cleared.status, "reasoned", JSON.stringify(cleared));
  const responses = [{ ...base, judgment: "돈 주인들이 짐 싸서 나간 모양이다." }, hedged];
  const prompts: string[] = [];
  const retried = await reasonEditorialInquiryV2({ plan: levelPlan, evidence: STARGATE, scopeCritic: critic(["fail", "pass"]),
    model: { async generate({ prompt }) { prompts.push(prompt); return JSON.stringify(responses.shift()); } } });
  assert.equal(retried.status, "reasoned", JSON.stringify(retried));
  assert.match(prompts[1], /문제 문장/);
});

test("the inquiry sees the price context but not the quantity decomposition it would narrate as flows", async () => {
  const { buildEditorialInquiryPromptV2 } = await import("../src/services/editorial-v2/inquiry.ts");
  const screened = { ...STARGATE, selection: { kind: "tvl-outlier", absoluteMoveUsd: 51_115_919, benchmarkChangePercent: -1.6,
    residualPercentagePoints: -31.9, priceNeutral: { quantityChangePercent: -33.31, priceChangePercent: -0.94, quantityMoveUsd: -51_051_908,
      quantityShare: 0.98, coverageAtT0: 1, coverageAtT1: 1, t0: 1, t1: 2, interpolatedT0: true } } } as EvidenceCardV2;
  const prompt = buildEditorialInquiryPromptV2(thoughtPlan(), screened);
  assert.match(prompt, /"priceChangePercent":-0\.94/);
  assert.doesNotMatch(prompt, /quantity/i);
});
