import assert from "node:assert/strict";
import test from "node:test";
import { EDITORIAL_DATA_RENDERING_EVERY_V2, selectEditorialRenderingV2 } from "../src/services/editorial-v2/contracts.ts";
import { planEditorialV2 } from "../src/services/editorial-v2/planner.ts";
import {
  editorialDraftValidationInputV2,
  splitEditorialSentencesV2,
  validateEditorialDraftV2,
} from "../src/services/editorial-v2/validator.ts";
import { buildEditorialPromptV2, writeEditorialDraftV2 } from "../src/services/editorial-v2/writer.ts";
import type { EvidenceCardV2 } from "../src/services/editorial-v2/evidence.ts";

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
// The operator's reference post for the thought voice (2026-10-08).
const REFERENCE = "Stargate가 하루 만에 확 홀쭉해졌는데 가격은 멀쩡함. 사람이 떠난 건지 지갑만 옮긴 건지 픽시는 아직 모르겠음. 조용히 빠지는 쪽이 늘 더 오래 기억에 남더라.";

function check(text: string, rendering: "thought" | "data") {
  return validateEditorialDraftV2(editorialDraftValidationInputV2({
    text, subject: STARGATE.subject, fact: STARGATE, factIds: [STARGATE.id], usedFactIds: [STARGATE.id], rendering,
  }));
}

function plan(rendering?: "thought" | "data") {
  const result = planEditorialV2({ evidence: [STARGATE], now: NOW });
  if (result.status !== "planned") assert.fail(result.reason);
  return { ...result.plan, rendering };
}

test("rendering is deterministic per action and mixes data posts in occasionally", () => {
  assert.equal(selectEditorialRenderingV2("action_x"), selectEditorialRenderingV2("action_x"));
  const renderings = Array.from({ length: 400 }, (_, index) => selectEditorialRenderingV2(`action_${index}`));
  const dataShare = renderings.filter((value) => value === "data").length / renderings.length;
  assert.ok(Math.abs(dataShare - 1 / EDITORIAL_DATA_RENDERING_EVERY_V2) < 0.08, String(dataShare));
});

test("the reference thought passes without a number or timestamp, but not as a data post", () => {
  assert.deepEqual(check(REFERENCE, "thought").reasons, []);
  const asData = check(REFERENCE, "data").reasons;
  for (const reason of ["numeric-fact-not-in-first-two-sentences", "source-time-missing", "final-judgment-missing"]) {
    assert.ok(asData.includes(reason), reason);
  }
});

test("thought copy keeps every stated fact grounded", () => {
  const exact = "Stargate가 -33.54%나 홀쭉해졌는데 가격은 멀쩡함. 사람이 떠난 건지 지갑만 옮긴 건지 픽시는 아직 모르겠음.";
  assert.deepEqual(check(exact, "thought").reasons, []);
  assert.ok(check("Stargate가 40%나 홀쭉해졌는데 가격은 멀쩡함. 픽시는 아직 모르겠음.", "thought").reasons.includes("unsupported-number"));
  assert.ok(check("어떤 브릿지가 하루 만에 홀쭉해졌음. 픽시는 아직 모르겠음, 이게 뭔지.", "thought").reasons.includes("subject-missing"));
  assert.ok(check("Stargate가 하루 만에 확 불어났는데 가격은 멀쩡함. 픽시는 아직 모르겠음, 이게 뭔지.", "thought").reasons.includes("metric-direction-conflict"));
  assert.ok(check("Stargate가 홀쭉해졌는데 자금 유출이 분명해 보임. 픽시는 이 장면을 오래 기억할 듯.", "thought").reasons.includes("metric-semantic-scope"));
  // Observed Gemini thought (2026-10-08): an inflow claim without the word 유입.
  assert.ok(check("Stargate 규모가 갑자기 쪼그라드는 흐름이 찍힘. 가격 착시보다 자금이 직접 빠져나가면서 덩치가 준 모습임. 며칠 더 두고 소화해볼 생각임.", "thought").reasons.includes("metric-semantic-scope"));
  assert.ok(check("Stargate가 홀쭉해졌습니다. 픽시는 아직 판단을 보류합니다.", "thought").reasons.includes("formal-register"));
  assert.ok(check("Stargate가 홀쭉해졌음. 다음 데이터 오면 다시 확인하겠다.", "thought").reasons.includes("future-recheck-promise"));
});

test("plain-prose words like 오늘 do not read as a direction claim", () => {
  const text = "오늘 Stargate가 확 홀쭉해졌는데 가격은 멀쩡함. 사람이 떠난 건지 지갑만 옮긴 건지 픽시는 아직 모르겠음.";
  assert.equal(check(text, "thought").reasons.includes("metric-direction-conflict"), false);
});

test("legacy drafts without a rendering keep the numeric data contract", () => {
  const legacy = validateEditorialDraftV2(editorialDraftValidationInputV2({
    text: REFERENCE, subject: STARGATE.subject, fact: STARGATE, factIds: [STARGATE.id], usedFactIds: [STARGATE.id],
  }));
  assert.ok(legacy.reasons.includes("source-time-missing"));
});

test("the writer asks for a thought or a data post according to the plan", () => {
  const thought = buildEditorialPromptV2(plan("thought"), STARGATE, []);
  assert.match(thought, /픽시의 생각 글이다/);
  assert.match(thought, /"Stargate"를 한 번 넣는다/);
  assert.match(thought, /방향: 작아짐/);
  assert.doesNotMatch(thought, /첫 두 문장 안에 rawValue/);
  const data = buildEditorialPromptV2(plan("data"), STARGATE, []);
  assert.match(data, /첫 두 문장 안에 rawValue/);
  assert.match(data, /판정 성격이 드러나는 단어/);
  assert.doesNotMatch(data, /픽시의 생각 글이다/);
});

test("the writer accepts the reference thought end to end", async () => {
  const sentences = splitEditorialSentencesV2(REFERENCE);
  const result = await writeEditorialDraftV2({
    plan: plan("thought"),
    evidence: STARGATE,
    model: { async generate() {
      return JSON.stringify({ draft: REFERENCE, usedFactIds: [STARGATE.id], claims: sentences.map((text, index) => ({
        kind: index === 0 ? "observation" : "judgment", text, factIds: [STARGATE.id] })) });
    } },
  });
  assert.equal(result.status, "generated", JSON.stringify(result));
});
