import assert from "node:assert/strict";
import test from "node:test";
import { jevReviewCasesV2 } from "../eval/jev-review-cases.ts";
import { buildEditorialContextV2, formatEditorialContextV2 } from "../src/services/editorial-v2/context.ts";
import type { EvidenceCardV2 } from "../src/services/editorial-v2/evidence.ts";
import { buildEditorialInquiryPromptV2 } from "../src/services/editorial-v2/inquiry.ts";
import { planEditorialV2 } from "../src/services/editorial-v2/planner.ts";
import { buildEditorialScopeCriticPromptV2 } from "../src/services/editorial-v2/scope-critic.ts";
import { editorialDraftValidationInputV2, validateEditorialDraftV2 } from "../src/services/editorial-v2/validator.ts";
import { buildEditorialPromptV2 } from "../src/services/editorial-v2/writer.ts";

const NOW = "2026-10-22T03:00:00.000Z";
const CARD: EvidenceCardV2 = {
  schemaVersion: 2,
  id: "fact:aave:tvl",
  lane: "protocol",
  kind: "signal",
  subject: "Aave V3",
  subjectKey: "aave-v3",
  metric: { name: "tvl-change-24h", value: 6.4, raw: "+6.40%", unit: "%", period: "24h" },
  followUp: { metric: { name: "tvl-usd", value: 30_000_000_000, raw: "$30.00B", unit: "USD", period: "snapshot" }, comparator: "lte", threshold: 28_195_488_721 },
  profile: { category: "Lending", chains: ["Ethereum", "Base"], symbol: "AAVE", change7d: 12.4 },
  selection: { kind: "tvl-outlier", absoluteMoveUsd: 1_804_511_278, benchmarkChangePercent: -1.2, residualPercentagePoints: 7.6 },
  source: { provider: "defillama", url: "https://api.llama.fi/protocols", publishedAt: null, observedAt: "2026-10-22T02:40:00.000Z", origin: "direct", role: "primary" },
  freshness: { kind: "signal", measuredAt: "2026-10-22T02:40:00.000Z", maxAgeMs: 7_200_000, ageMs: 1_200_000, state: "fresh" },
  providerHealth: { provider: "defillama", state: "green", reason: "ok", checkedAt: NOW, latencyMs: 10, itemCount: 1 },
  provenance: { kind: "onchain-nutrient", sourceId: "aave-v3:tvl" },
};
const BTC = { ...CARD, id: "coingecko:bitcoin", lane: "ecosystem" as const, subject: "Bitcoin", metric: { name: "usd-price", value: 67_000, raw: "$67,000", unit: "USD", period: "snapshot" },
  source: { ...CARD.source, provider: "coingecko" as const, url: "https://api.coingecko.com/api/v3/coins/markets", role: "discovery" as const } };
const headline = (title: string) => ({ provider: "rss" as const, title, url: `https://example.com/${encodeURIComponent(title)}`, publishedAt: NOW, blockReason: "discovery-only" as const });
const SENSING = { evidence: [CARD, BTC], discoveries: [
  headline("Aave governance votes on GHO rate cut"),
  headline("Aavegotchi launches new season"),
  headline("ETF flows slow as Bitcoin stalls"),
] };

function context() { return buildEditorialContextV2({ evidence: CARD, sensing: SENSING }); }

test("context gathers the subject's profile, market backdrop and related headlines with sources", () => {
  const items = context();
  const byId = Object.fromEntries(items.map((item) => [item.id, item.text]));
  assert.equal(byId["profile:category"], "Lending");
  assert.equal(byId["profile:chains"], "Ethereum, Base");
  assert.equal(byId["profile:change7d"], "+12.40%");
  assert.equal(byId["profile:tvl"], "$30.00B");
  assert.equal(byId["market:benchmark"], "-1.20%");
  // Without a change rate, the label says so; the writer cannot claim the price did not move.
  assert.equal(byId["market:bitcoin"], "$67,000");
  assert.match(items.find((item) => item.id === "market:bitcoin")!.label, /변화율 없음/);
  const withChange = buildEditorialContextV2({ evidence: CARD, sensing: { ...SENSING, evidence: [CARD, { ...BTC, profile: { change24h: -0.37 } }] } });
  assert.equal(withChange.find((item) => item.id === "market:bitcoin")!.text, "$67,000, -0.37%");
  // Word-boundary matching: "Aavegotchi" is not about Aave.
  assert.deepEqual(items.filter((item) => item.id.startsWith("headline:related")).map((item) => item.text), ["Aave governance votes on GHO rate cut"]);
  assert.equal(items.filter((item) => item.id.startsWith("headline:other")).length, 2);
  assert.match(formatEditorialContextV2(items), /남의 보도라 사실 확인 안 됨/);
});

function check(text: string) {
  return validateEditorialDraftV2(editorialDraftValidationInputV2({ text, subject: CARD.subject, fact: CARD, factIds: [CARD.id],
    usedFactIds: [CARD.id], rendering: "thought", context: context() }));
}

test("context numbers and names are grounded; anything else still is not", () => {
  assert.deepEqual(check("Aave가 하루 만에 확 불었는데 일주일로 보면 +12.40%라 갑자기는 아님. GHO 금리 인하 투표 기사가 돌던데 픽시 생각엔 그쪽 기대감 같음.").reasons, []);
  assert.deepEqual(check("Aave가 확 불었는데 비트코인은 $67,000에서 멈춰 있음. 픽시 생각엔 돈이 갈 곳을 고르는 중 같음.").reasons, []);
  assert.ok(check("Aave가 확 불었는데 Compound는 조용함. 픽시 생각엔 자리 이동 같음.").reasons.includes("unsupported-name"));
  assert.ok(check("Aave가 확 불었는데 일주일로 보면 +30%임. 픽시 생각엔 기대감 같음.").reasons.includes("unsupported-number"));
});

function plan() {
  const result = planEditorialV2({ evidence: [CARD], now: NOW });
  if (result.status !== "planned") assert.fail(result.reason);
  return { ...result.plan, rendering: "thought" as const, context: context() };
}

test("the writer gets the context and is asked for its own angle, marked as opinion", () => {
  const prompt = buildEditorialPromptV2(plan(), CARD, []);
  assert.match(prompt, /같이 먹은 재료/);
  assert.match(prompt, /관련 기사 제목: Aave governance votes on GHO rate cut/);
  assert.match(prompt, /픽시몬만의 관점 하나를 낸다/);
  assert.match(prompt, /'픽시몬이 판단하기에', '픽시몬이 보기엔', '~같음', '~듯'처럼 의견으로 드러낸다/);
});

test("the inquiry reads the context and forms one labelled hypothesis", () => {
  const prompt = buildEditorialInquiryPromptV2(plan(), CARD);
  assert.match(prompt, /같이 먹은 재료/);
  assert.match(prompt, /4\. 픽시몬만의 해석은 무엇인가/);
  assert.match(prompt, /가설이면 "~같다", "~듯", "픽시몬이 판단하기에"처럼 가설로 쓴다/);
});

test("the critic allows marked opinions and fails unmarked causal claims and treated-as-fact headlines", () => {
  const prompt = buildEditorialScopeCriticPromptV2("Aave가 확 불었음.", CARD, context());
  assert.match(prompt, /픽시의 의견은 허용된다/);
  assert.match(prompt, /의견으로 드러낸 해석/);
  assert.match(prompt, /기사 제목의 내용을 확인된 사실처럼 말함/);
  assert.match(prompt, /투자 조언/);
  assert.match(prompt, /가격만 있고 변화율이 없는데/);
  assert.match(prompt, /GHO rate cut/);
});

test("the ledger rejects malformed context", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { EditorialEventStoreV2 } = await import("../src/services/editorial-v2/event-store.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-context-"));
  try {
    const store = new EditorialEventStoreV2({ eventLogPath: path.join(dir, "events.ndjson") });
    const draft = structuredClone(jevReviewCasesV2()[0].state.draft) as Record<string, unknown>;
    delete draft.schemaVersion;
    assert.throws(() => store.createDraft({ ...draft, id: "bad-context", context: [{ id: "x", kind: "rumor", label: "l", text: "t", provider: "p" }] } as never),
      /invalid editorial context/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a particle glued to a grounded number is not a new number, but a different number still is", () => {
  assert.equal(check("Aave가 확 불었는데 비트코인은 $67,000에서 멈춰 있음. 픽시 생각엔 돈이 갈 곳을 고르는 중 같음.").reasons.includes("unsupported-number"), false);
  assert.ok(check("Aave가 확 불었는데 비트코인은 $68,000에서 멈춰 있음. 픽시 생각엔 쉬는 중 같음.").reasons.includes("unsupported-number"));
});

test("dropping the sign of a grounded change is not a new number", () => {
  assert.equal(check("Aave가 하루 만에 6.40% 불었는데 일주일로 보면 갑자기는 아님. 픽시 생각엔 GHO 쪽 기대감 같음.").reasons.includes("unsupported-number"), false);
  assert.ok(check("Aave가 하루 만에 7배 빨리 불었음. 픽시 생각엔 기대감 같음.").reasons.some((reason) => reason.startsWith("unsupported-number")));
});

test("duration suffixes and generic market terms are not new numbers or names", () => {
  assert.deepEqual(check("Aave가 7일간 +12.40% 불었는데 DeFi 대출 쪽만 그럼. 픽시 생각엔 GHO 쪽 기대감 같음.").reasons, []);
  assert.ok(check("Aave가 불었는데 Morpho는 조용함. 픽시 생각엔 자리 이동 같음.").reasons.includes("unsupported-name"));
});

test("Pixymon refers to itself once by its third-person name, separately from metaphor cues", () => {
  assert.deepEqual(check("Aave가 하루 만에 확 불었는데 비트코인은 $67,000에서 멈춤. 픽시몬이 판단하기에 GHO 쪽 기대감을 먼저 소화한 돈 같음.").reasons, []);
  assert.ok(check("Aave가 확 불었음. 픽시몬이 보기엔 기대감인데, 픽시몬은 그래도 한 번 더 의심함.").reasons.includes("self-name-overuse"));
});

test("tickers of context coins and the subject's token count as grounded names", () => {
  const withTicker = buildEditorialContextV2({ evidence: CARD, sensing: { ...SENSING, evidence: [CARD, { ...BTC, profile: { change24h: 0.06, symbol: "BTC" } }] } });
  assert.match(withTicker.find((item) => item.id === "market:bitcoin")!.label, /\$BTC/);
  const text = "Aave가 확 불었는데 $BTC는 제자리고 $AAVE 쪽만 들썩임. 픽시몬이 판단하기에 GHO 쪽 기대감 같음.";
  const reasons = validateEditorialDraftV2(editorialDraftValidationInputV2({ text, subject: CARD.subject, fact: CARD, factIds: [CARD.id],
    usedFactIds: [CARD.id], rendering: "thought", context: withTicker })).reasons;
  assert.equal(reasons.includes("unsupported-name"), false, reasons.join(","));
});

test("the critic sees the follow-up baseline the inquiry may cite", () => {
  const prompt = buildEditorialScopeCriticPromptV2("Aave가 확 불었음.", CARD, context());
  assert.match(prompt, /현재 수준: \$30\.00B/);
  assert.match(prompt, /변동 전 수준\(재관측 기준점\): \$28\.20B/);
});

test("the inquiry is given exact memory ids, or told memory must be null", () => {
  const none = buildEditorialInquiryPromptV2(plan(), CARD);
  assert.match(none, /memory는 반드시 null이다/);
  const withMemory = { ...plan(), memoryContext: { beliefs: [], previous: { draftId: "draft-42", provenance: "shadow" as const, text: "t", thesis: "t", verdict: "digesting", recordedAt: NOW,
    outcome: { id: "draft-42:72h", checkpoint: "72h" as const, resolution: "supported" as const, reason: "r", resolvedAt: NOW } } } };
  const prompt = buildEditorialInquiryPromptV2(withMemory, CARD);
  assert.match(prompt, /"draftId":"draft-42","resolutionId":"draft-42:72h"/);
});

test("an invented memory object is dropped when there is nothing to link", async () => {
  const { reasonEditorialInquiryV2 } = await import("../src/services/editorial-v2/inquiry.ts");
  const { inquiryFixture } = await import("./helpers/editorial-inquiry.ts");
  const levelPlan = { ...plan(), editorialCase: { ...plan().editorialCase!, scope: "usd-tvl-level" as const } };
  const invented = { ...inquiryFixture({ factId: CARD.id, levelTest: true }), memory: { draftId: "made-up", resolutionId: null, lesson: "x", change: "y" } };
  const result = await reasonEditorialInquiryV2({ plan: levelPlan, evidence: CARD, model: { async generate() { return JSON.stringify(invented); } } });
  assert.equal(result.status, "reasoned", JSON.stringify(result));
  if (result.status === "reasoned") assert.equal(result.inquiry.memory, null);
});

test("length is checked the way X counts it: Hangul weighs two", async () => {
  const { xWeightedLengthV2 } = await import("../src/services/editorial-v2/validator.ts");
  assert.equal(xWeightedLengthV2("abc 1%"), 6);
  assert.equal(xWeightedLengthV2("픽시몬"), 6);
  const long = "Aave가 하루 만에 확 불었는데 일주일로 보면 갑자기는 아님. 대출 쪽 사람들이 다 같이 움직인 날이라 픽시몬이 판단하기에 기대감이 먼저 달려간 것 같음. 그런 날은 보통 며칠 뒤에 조용히 빠지던데 이번에는 체인도 여러 개라 조금 다를 수도 있음. 결국 끝까지 남아서 버티는 쪽이 진짜 신호라고 보는 게 맞다고 봄.";
  assert.ok(long.length <= 190 && xWeightedLengthV2(long) > 280, `${long.length} ${xWeightedLengthV2(long)}`);
  assert.ok(check(long).reasons.includes("too-long"));
});
