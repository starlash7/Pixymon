import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  draftRepliesV2,
  parseReplyTargetUrlV2,
  publishReplyV2,
  ReplyLedgerV2,
  releaseReplyV2,
  validateReplyV2,
  type ReplyTargetV2,
} from "../src/services/editorial-v2/replies.ts";
import type { EditorialWriterModelV2 } from "../src/services/editorial-v2/writer.ts";

const TRAINER_POST = "앱인토스 8월 수익 후기. 바이코딩 앱으로만 111만원 정산받았습니다. 미니앱을 100개 넘게 만들어봤어요. 앱100위안에 드는 것 하나도 없습니다.";
const trainerTarget: ReplyTargetV2 = { tweetId: "1900000000000000001", url: "https://x.com/Pixy7Crypto/status/1900000000000000001", author: "Pixy7Crypto", text: TRAINER_POST, trainer: true };
const otherTarget: ReplyTargetV2 = { ...trainerTarget, tweetId: "1900000000000000002", author: "someone", trainer: false };
const GOOD = "주인님 미니앱 100개 넘게 만들어서 100위 안에 든 게 하나도 없는데 111만원이면, 픽시몬이 보기엔 실력보다 물량이 이긴 판임.";

test("reply targets come from x.com status URLs; the trainer is recognized by handle", () => {
  assert.deepEqual(parseReplyTargetUrlV2("https://x.com/Pixy7Crypto/status/1900000000000000001?s=20", {}), { tweetId: "1900000000000000001", author: "Pixy7Crypto", trainer: true });
  assert.equal(parseReplyTargetUrlV2("https://twitter.com/someone/status/1900000000000000002", {}).trainer, false);
  assert.throws(() => parseReplyTargetUrlV2("https://x.com/someone", {}), /status/);
});

test("a reply may only use the post's numbers and may call only the trainer 주인님", () => {
  assert.deepEqual(validateReplyV2(GOOD, trainerTarget), []);
  assert.ok(validateReplyV2(GOOD, otherTarget).includes("trainer-address-to-non-trainer"));
  assert.ok(validateReplyV2("주인님 앱 300개면 정산 500만원 각임.", trainerTarget).includes("unsupported-number"));
  assert.ok(validateReplyV2("주인님 대박 🎉", trainerTarget).includes("emoji"));
  assert.ok(validateReplyV2("@toss__official 보고 있음? 픽시몬은 봄.", trainerTarget).includes("mention"));
  assert.ok(validateReplyV2("축하드립니다. 정말 대단하십니다.", trainerTarget).includes("formal-register"));
});

function model(replies: string[]): EditorialWriterModelV2 {
  return { modelId: "test-writer", async generate() { return JSON.stringify({ replies }); } };
}
function critic(verdicts: Array<"pass" | "fail">): EditorialWriterModelV2 {
  return { modelId: "test-critic", async generate() {
    const verdict = verdicts.shift();
    return JSON.stringify(verdict === "pass" ? { verdict: "pass", claim: "", problem: "" } : { verdict: "fail", claim: "x", problem: "사생활" });
  } };
}

test("drafting checks every candidate and asks the critic only about the ones that pass", async () => {
  const candidates = await draftRepliesV2({ target: trainerTarget, model: model([GOOD, "주인님 앱 300개면 정산 500만원 각임.", "주인님 그 정산금 어디 썼는지 다 앎."]), critic: critic(["pass", "fail"]) });
  assert.deepEqual(candidates.map((candidate) => [candidate.reasons.length === 0, candidate.critic]), [[true, "pass"], [false, "not-run"], [true, "fail"]]);
});

function ledger(t: TestContext): ReplyLedgerV2 {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-replies-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new ReplyLedgerV2(path.join(dir, "replies.ndjson"));
}

test("publishing sends only an operator-picked, checked candidate, once per target, within the daily limit", async (t) => {
  const book = ledger(t);
  const sent: Array<[string, string]> = [];
  const dispatch = async (text: string, replyTo: string, beforeSend: () => void) => { beforeSend(); sent.push([text, replyTo]); return `x-${sent.length}`; };
  const id = book.recordDraft(trainerTarget, [{ text: GOOD, reasons: [], critic: "pass" }, { text: "bad", reasons: ["too-short"], critic: "not-run" }], "m");
  assert.deepEqual(await publishReplyV2({ ledger: book, id, pick: 2, dispatch, timezone: "Asia/Seoul" }), { status: "blocked", reason: "candidate-failed-checks:too-short" });
  assert.deepEqual(await publishReplyV2({ ledger: book, id, pick: 1, dispatch, timezone: "Asia/Seoul" }), { status: "published", xId: "x-1" });
  assert.deepEqual(sent, [[GOOD, trainerTarget.tweetId]]);
  // A second reply to the same post is blocked, even from a new draft.
  const again = book.recordDraft(trainerTarget, [{ text: GOOD, reasons: [], critic: "pass" }], "m");
  assert.deepEqual(await publishReplyV2({ ledger: book, id: again, pick: 1, dispatch, timezone: "Asia/Seoul" }), { status: "blocked", reason: "target-already-replied-or-unresolved" });
  const second = book.recordDraft({ ...otherTarget, text: "다른 글" }, [{ text: "픽시몬이 보기엔 그건 좀 이름.", reasons: [], critic: "pass" }], "m");
  assert.equal((await publishReplyV2({ ledger: book, id: second, pick: 1, dispatch, timezone: "Asia/Seoul", dailyLimit: 1 })).status, "blocked");
  assert.equal(sent.length, 1);
});

test("an unresolved send leaves a prepared record so the same reply is never sent twice", async (t) => {
  const book = ledger(t);
  const id = book.recordDraft(trainerTarget, [{ text: GOOD, reasons: [], critic: "pass" }], "m");
  let calls = 0;
  const failing = async (_text: string, _to: string, beforeSend: () => void) => { beforeSend(); calls += 1; return null; };
  assert.equal((await publishReplyV2({ ledger: book, id, pick: 1, dispatch: failing, timezone: "Asia/Seoul" })).status, "blocked");
  assert.equal((await publishReplyV2({ ledger: book, id, pick: 1, dispatch: failing, timezone: "Asia/Seoul" })).status, "blocked");
  assert.equal(calls, 1);
  assert.deepEqual(book.events().map((event) => event.type), ["reply-drafted", "reply-prepared"]);
});

test("a guard that declines before sending leaves no prepared record, and a checked unsent reply can be released", async (t) => {
  const book = ledger(t);
  const id = book.recordDraft(trainerTarget, [{ text: GOOD, reasons: [], critic: "pass" }], "m");
  const declined = async () => null;
  assert.deepEqual(await publishReplyV2({ ledger: book, id, pick: 1, dispatch: declined, timezone: "Asia/Seoul" }),
    { status: "blocked", reason: "x-not-sent (guard declined; retry later)" });
  assert.deepEqual(book.events().map((event) => event.type), ["reply-drafted"]);
  const unresolved = async (_text: string, _to: string, beforeSend: () => void) => { beforeSend(); return null; };
  assert.equal((await publishReplyV2({ ledger: book, id, pick: 1, dispatch: unresolved, timezone: "Asia/Seoul" })).status, "blocked");
  assert.deepEqual(releaseReplyV2(book, id, ""), { status: "blocked", reason: "release-reason-required" });
  assert.deepEqual(releaseReplyV2(book, id, "checked on X: not posted"), { status: "released" });
  const ok = async (_text: string, _to: string, beforeSend: () => void) => { beforeSend(); return "x-9"; };
  assert.deepEqual(await publishReplyV2({ ledger: book, id, pick: 1, dispatch: ok, timezone: "Asia/Seoul" }), { status: "published", xId: "x-9" });
  // A published reply is never released, and its target stays blocked.
  assert.deepEqual(releaseReplyV2(book, id, "x"), { status: "blocked", reason: "reply-already-published" });
  assert.equal((await publishReplyV2({ ledger: book, id, pick: 1, dispatch: ok, timezone: "Asia/Seoul" })).status, "blocked");
});

test("replies may use a character cue word once", () => {
  assert.ok(validateReplyV2("지금 소화 중임. 온체인 데이터 씹는 데 시간 걸림", otherTarget).includes("character-cue-overuse"));
  assert.ok(!validateReplyV2("픽시몬은 아직 소화 중임. 결론은 조금 더 보고 냄", otherTarget).includes("character-cue-overuse"));
});
