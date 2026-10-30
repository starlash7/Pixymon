import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { EditorialContextItemV2 } from "../src/services/editorial-v2/contracts.ts";
import {
  buildThoughtPromptV2,
  draftThoughtV2,
  normalizeThoughtBetV2,
  recentEndingsV2,
  publishThoughtV2,
  resolveDueBetsV2,
  resultMaterialV2,
  selectThoughtSeedV2,
  ThoughtLedgerV2,
  thoughtDueV2,
  validateThoughtV2,
} from "../src/services/editorial-v2/thoughts.ts";
import type { EditorialWriterModelV2 } from "../src/services/editorial-v2/writer.ts";

const material: EditorialContextItemV2[] = [
  { id: "market:bitcoin", kind: "market", label: "Bitcoin($BTC) 가격과 24시간 변화", text: "$67,000, +1.20%", provider: "coingecko" },
  { id: "headline:0", kind: "headline", label: "기사 제목", text: "ETF flows slow as traders wait", provider: "rss" },
];

function ledger(t: TestContext): ThoughtLedgerV2 {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-thoughts-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new ThoughtLedgerV2(path.join(dir, "thoughts.ndjson"));
}

test("a thought may be free opinion but facts must come from the material", () => {
  const ok = "요즘 숫자는 다 커지는데 이상하게 배가 안 부름. 픽시몬은 이런 날이 꼭 뭔가 빠지기 전이라고 봄.";
  assert.deepEqual(validateThoughtV2(ok, { material, recentPosts: [] }), []);
  assert.deepEqual(validateThoughtV2("Lv.1이라 아직 배고픔. 근데 오늘 먹은 건 다 비슷한 맛이라 질림.", { material, recentPosts: [] }), []);
  assert.ok(validateThoughtV2("$BTC가 $70,000 간다에 걸어봄. 픽시몬은 그렇게 봄.", { material, recentPosts: [] }).includes("unsupported-number"));
  assert.ok(validateThoughtV2("지금 $BTC 사라. 무조건 감.", { material, recentPosts: [] }).includes("investment-advice"));
  assert.ok(validateThoughtV2("주인님 또 차트에 선 긋는 중임. 픽시몬은 지갑을 셈.", { material, recentPosts: [] }).includes("trainer-without-material"));
  assert.ok(validateThoughtV2("오늘은 판단이 안 섬. 일단 소화 중임.", { material, recentPosts: [] }).includes("hedge-only-ending"));
  assert.ok(validateThoughtV2(ok, { material, recentPosts: [ok] }).includes("too-similar"));
});

test("the seed rotates and skips sources that are empty", () => {
  assert.equal(selectThoughtSeedV2({ publishedCount: 0, hasJournal: false, hasTrainer: false }), "material");
  assert.equal(selectThoughtSeedV2({ publishedCount: 1, hasJournal: false, hasTrainer: false }), "growth");
  assert.equal(selectThoughtSeedV2({ publishedCount: 1, hasJournal: true, hasTrainer: false }), "journal");
  assert.equal(selectThoughtSeedV2({ publishedCount: 4, hasJournal: true, hasTrainer: true }), "trainer");
});

test("the prompt carries the journal, the material and recent posts", () => {
  const prompt = buildThoughtPromptV2({ seed: "journal", material, journal: ["요즘 숫자보다 사람 냄새를 믿음"], recentPosts: ["지난 글"],
    trainerHandle: "Pixy7Crypto", retryReasons: [] });
  assert.match(prompt, /요즘 숫자보다 사람 냄새를 믿음/);
  assert.match(prompt, /ETF flows slow/);
  assert.match(prompt, /- 지난 글/);
  assert.match(prompt, /뉴스 요약도, 데이터 보고도 아니다/);
});

test("a failed fact critic gets one rewrite, then the thought and its journal note are returned", async () => {
  const texts = [
    "기사 보니까 ETF 자금이 다 빠졌음. 픽시몬은 이게 끝의 시작 같음.",
    "ETF 얘기가 식었다는 기사가 돌던데, 픽시몬은 조용할 때가 제일 맛있는 구간이라고 봄.",
  ];
  let call = 0;
  const writer: EditorialWriterModelV2 = { modelId: "w", async generate() { return JSON.stringify({ text: texts[call++], journal: "조용한 구간을 좋아하게 됨" }); } };
  let reviews = 0;
  const critic: EditorialWriterModelV2 = { modelId: "c", async generate() {
    reviews += 1;
    return reviews === 1 ? '{"verdict":"fail","claim":"ETF 자금이 다 빠졌음","problem":"기사 내용을 사실로 말함"}' : '{"verdict":"pass","claim":"","problem":""}';
  } };
  const result = await draftThoughtV2({ model: writer, critic, seed: "material", material, journal: [], recentPosts: [], trainerHandle: "Pixy7Crypto" });
  assert.deepEqual(result, { status: "ready", text: texts[1], journal: "조용한 구간을 좋아하게 됨", seed: "material", criticModelId: "c", bet: null });
});

test("publishing spaces thoughts, caps them per day and keeps the journal", async (t) => {
  const book = ledger(t);
  const now = new Date("2026-10-29T03:00:00Z");
  assert.deepEqual(thoughtDueV2(book, { dailyLimit: 2, timezone: "Asia/Seoul", now }), { due: true });
  const declined = await publishThoughtV2({ ledger: book, id: book.recordDraft({ text: "a", journal: "j0", seed: "growth" }), text: "a", dispatch: async () => null, now });
  assert.deepEqual(declined, { status: "blocked", reason: "x-not-sent" });
  assert.deepEqual(thoughtDueV2(book, { dailyLimit: 2, timezone: "Asia/Seoul", now }), { due: true });
  const id = book.recordDraft({ text: "첫 생각", journal: "첫 메모", seed: "material" });
  const sent = await publishThoughtV2({ ledger: book, id, text: "첫 생각", dispatch: async (_text, beforeSend) => { beforeSend(); return "x1"; }, now });
  assert.deepEqual(sent, { status: "published", xId: "x1" });
  assert.deepEqual(book.journal(), ["첫 메모"]);
  assert.deepEqual(thoughtDueV2(book, { dailyLimit: 2, timezone: "Asia/Seoul", now: new Date("2026-10-29T05:00:00Z") }), { due: false, reason: "thought-spacing" });
  assert.deepEqual(thoughtDueV2(book, { dailyLimit: 1, timezone: "Asia/Seoul", now: new Date("2026-10-29T09:00:00Z") }), { due: false, reason: "thought-daily-limit" });
  assert.deepEqual(thoughtDueV2(book, { dailyLimit: 2, timezone: "Asia/Seoul", now: new Date("2026-10-29T09:00:00Z") }), { due: true });
});

test("tickers need a dollar sign and a thought keeps numbers to one", () => {
  assert.ok(validateThoughtV2("BTC가 조용한 날은 픽시몬도 배가 덜 고픔. 이번엔 귀찮음 쪽에 걸겠음.", { material, recentPosts: [] }).includes("ticker-format"));
  assert.deepEqual(validateThoughtV2("$BTC가 조용한 날은 픽시몬도 배가 덜 고픔. 이번엔 귀찮음 쪽에 걸겠음.", { material, recentPosts: [] }), []);
  assert.ok(validateThoughtV2("$BTC는 $67,000인데 +1.20%라 심심함. 픽시몬은 하품 중에 한 표 던짐.", { material, recentPosts: [] }).includes("too-many-numbers"));
});

test("a bet is kept only on a bettable ticker with a direction and horizon", () => {
  const now = new Date("2026-10-29T04:00:00Z");
  const prices = { BTC: 67000 };
  assert.deepEqual(normalizeThoughtBetV2({ symbol: "$btc", direction: "up", horizonHours: 24, claim: "귀찮음 쪽" }, prices, now), {
    symbol: "BTC", direction: "up", horizonHours: 24, claim: "귀찮음 쪽", baseline: 67000,
    placedAt: "2026-10-29T04:00:00.000Z", dueAt: "2026-10-30T04:00:00.000Z" });
  assert.equal(normalizeThoughtBetV2({ symbol: "USDT", direction: "up", horizonHours: 24, claim: "x" }, prices, now), null);
  assert.equal(normalizeThoughtBetV2({ symbol: "BTC", direction: "sideways", horizonHours: 24, claim: "x" }, prices, now), null);
  assert.equal(normalizeThoughtBetV2(null, prices, now), null);
});

test("a due bet is graded, earns experience, can evolve Pixymon and queues one result post", async (t) => {
  const book = ledger(t);
  const placed = new Date("2026-10-29T04:00:00Z");
  const sendOk = (xId: string) => async (_text: string, beforeSend: () => void) => { beforeSend(); return xId; };
  // 45 published thoughts put Pixymon at 45 XP, five short of Lv.2.
  for (let index = 0; index < 44; index += 1) {
    const filler = book.recordDraft({ text: `생각 ${index}`, journal: "", seed: "growth" });
    await publishThoughtV2({ ledger: book, id: filler, text: `생각 ${index}`, dispatch: sendOk(`f${index}`), now: placed });
  }
  const bet = normalizeThoughtBetV2({ symbol: "BTC", direction: "down", horizonHours: 24, claim: "귀찮음 쪽" }, { BTC: 80000 }, placed)!;
  const id = book.recordDraft({ text: "겁먹은 돈은 눕는 중. 픽시몬은 내림에 걸겠음.", journal: "내림에 걸었음", seed: "material", bet });
  await publishThoughtV2({ ledger: book, id, text: "겁먹은 돈은 눕는 중.", dispatch: sendOk("x1"), now: placed });
  assert.equal(book.progress().xp, 45);
  assert.deepEqual(resolveDueBetsV2(book, { BTC: 78000 }, new Date("2026-10-29T20:00:00Z")), []);
  assert.deepEqual(resolveDueBetsV2(book, { BTC: 78000 }, new Date("2026-10-30T05:00:00Z")), [{ id, outcome: "won" }]);
  assert.deepEqual(book.progress(), { xp: 55, level: 2, nextLevelXp: 100, wins: 1, losses: 0 });
  const pending = book.pendingResults();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].levelUpTo, 2);
  const facts = resultMaterialV2(pending[0]).map((item) => item.text).join(" | ");
  assert.match(facts, /\$80,000 → \$78,000/);
  assert.match(facts, /맞힘, 경험치 \+10, Lv\.2로 진화/);
  const announce = book.recordDraft({ text: "결과", journal: "", seed: "result", resultFor: id });
  await publishThoughtV2({ ledger: book, id: announce, text: "결과", dispatch: sendOk("x2"), now: new Date("2026-10-30T05:00:00Z") });
  assert.deepEqual(book.pendingResults(), []);
  assert.deepEqual(book.openBets(), []);
});

test("one cashtag per post, and a definitive X rejection gives the slot back", async (t) => {
  assert.ok(validateThoughtV2("$BTC랑 $ETH 둘 다 흔들림. 픽시몬은 내림에 걸겠음.", { material, recentPosts: [] }).includes("too-many-cashtags"));
  const book = ledger(t);
  const now = new Date("2026-10-29T03:00:00Z");
  const id = book.recordDraft({ text: "생각", journal: "메모", seed: "material" });
  const rejected = await publishThoughtV2({ ledger: book, id, text: "생각", now, dispatch: async (_text, beforeSend) => {
    beforeSend();
    throw Object.assign(new Error("Request failed with code 403"), { code: 403, data: { detail: "Posts are limited to a maximum of one cashtag" } });
  } });
  assert.deepEqual(rejected, { status: "blocked", reason: "x-rejected:Posts are limited to a maximum of one cashtag" });
  assert.deepEqual(book.prepared(), []);
  assert.deepEqual(thoughtDueV2(book, { dailyLimit: 1, timezone: "Asia/Seoul", now }), { due: true });
  // An unknown failure after the send started stays prepared (never resend blind).
  const unknown = book.recordDraft({ text: "생각2", journal: "", seed: "growth" });
  await assert.rejects(publishThoughtV2({ ledger: book, id: unknown, text: "생각2", now, dispatch: async (_text, beforeSend) => {
    beforeSend();
    throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  } }));
  assert.equal(book.prepared().length, 1);
});

test("a post may not end like the last three, and an open bet blocks a new one", () => {
  const recent = ["관망 가설은 반쯤 접음. 픽시몬은 이 하락이 하루 더 간다에 걸겠음.", "해킹 기사가 돌던데 $BTC가 더 빠진다에 걸겠음.", "공포보다 귀찮음이 무섭다고 봄."];
  assert.deepEqual(recentEndingsV2(recent), ["걸겠음", "봄"]);
  assert.ok(validateThoughtV2("오늘은 다들 겁먹은 척만 하는 듯. 픽시몬은 이번에도 반대쪽에 걸겠음.", { material, recentPosts: recent }).includes("repeated-ending"));
  assert.ok(!validateThoughtV2("오늘은 다들 겁먹은 척만 하는 듯. 픽시몬만 배고픈 건가?", { material, recentPosts: recent }).includes("repeated-ending"));
  const open = buildThoughtPromptV2({ seed: "material", material, journal: [], recentPosts: recent, trainerHandle: "Pixy7Crypto", retryReasons: [], bettable: ["BTC"], openBet: true });
  assert.match(open, /이번 글에서는 내기를 걸지 않는다/);
  assert.doesNotMatch(open, /"bet":/);
  assert.match(open, /최근 글이 끝난 말\(걸겠음, 봄\)로 끝내지 않는다/);
  const free = buildThoughtPromptV2({ seed: "material", material, journal: [], recentPosts: [], trainerHandle: "Pixy7Crypto", retryReasons: [], bettable: ["BTC"] });
  assert.match(free, /진짜 걸고 싶을 때만/);
});
