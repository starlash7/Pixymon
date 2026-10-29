import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { EditorialContextItemV2 } from "../src/services/editorial-v2/contracts.ts";
import {
  buildThoughtPromptV2,
  draftThoughtV2,
  publishThoughtV2,
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
  assert.deepEqual(result, { status: "ready", text: texts[1], journal: "조용한 구간을 좋아하게 됨", seed: "material", criticModelId: "c" });
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
