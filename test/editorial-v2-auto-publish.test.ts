import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { DEFAULT_X_API_COST_SETTINGS } from "../src/config/runtime.ts";
import { mentionSkipReasonV2, replyToNewMentionsV2, type MentionTimelineClientV2 } from "../src/services/editorial-v2/mentions.ts";
import { assertAutoPublishPolicyV2, autoPublishEnabledV2 } from "../src/services/editorial-v2/publication-policy.ts";
import { ReplyLedgerV2 } from "../src/services/editorial-v2/replies.ts";
import type { EditorialWriterModelV2 } from "../src/services/editorial-v2/writer.ts";

function dir(t: TestContext): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-auto-"));
  t.after(() => fs.rmSync(value, { recursive: true, force: true }));
  return value;
}

test("auto publishing needs the explicit flag, a clean tree and no STOP file", (t) => {
  const root = dir(t);
  const stopPath = path.join(root, "STOP");
  assert.equal(autoPublishEnabledV2({ PIXYMON_AUTO_PUBLISH: "true" }), true);
  assert.equal(autoPublishEnabledV2({}), false);
  assertAutoPublishPolicyV2({ enabled: true, stopPath, workingTreeClean: true });
  assert.throws(() => assertAutoPublishPolicyV2({ enabled: false, stopPath, workingTreeClean: true }), /auto-publish-disabled/);
  assert.throws(() => assertAutoPublishPolicyV2({ enabled: true, stopPath, workingTreeClean: false }), /tree-dirty/);
  fs.writeFileSync(stopPath, "");
  assert.throws(() => assertAutoPublishPolicyV2({ enabled: true, stopPath, workingTreeClean: true }), /editorial-live-suspended/);
});

const SELF = "2013948537416110080";
test("mentions that are not conversations are skipped", () => {
  assert.equal(mentionSkipReasonV2({ id: "1", text: "@Pixy_mon hi", authorId: SELF, username: "Pixy_mon" }, SELF), "self");
  assert.equal(mentionSkipReasonV2({ id: "2", text: "@Pixy_mon free airdrop https://spam.xyz", authorId: "9", username: "spam" }, SELF), "link");
  assert.equal(mentionSkipReasonV2({ id: "3", text: "@a @b @c @d @Pixy_mon", authorId: "9", username: "x" }, SELF), "tag-storm");
  assert.equal(mentionSkipReasonV2({ id: "4", text: "@Pixy_mon 이거 진짜 바닥임?", authorId: "9", username: "x" }, SELF), undefined);
});

function client(rows: Array<{ id: string; text: string; author_id: string }>, users: Array<{ id: string; username: string }>, calls: Array<Record<string, unknown>>): MentionTimelineClientV2 {
  return { async userMentionTimeline(_userId, options) { calls.push(options); return { data: { data: rows, includes: { users } } }; } };
}
const writer: EditorialWriterModelV2 = { modelId: "w", async generate({ prompt }) {
  return JSON.stringify({ replies: prompt.includes("픽시몬의 트레이너, 주인님") ? ["주인님 그건 좀 이름. 픽시몬은 일단 한 번 더 의심함."] : ["픽시몬이 보기엔 바닥 얘기는 아직 이른 듯."] });
} };
const critic: EditorialWriterModelV2 = { modelId: "c", async generate() { return JSON.stringify({ verdict: "pass", claim: "", problem: "" }); } };

test("Pixymon replies to new mentions oldest first, applies trainer rules, and resumes after a limit stop", async (t) => {
  const root = dir(t);
  const statePath = path.join(root, "mentions-state.json");
  const ledger = new ReplyLedgerV2(path.join(root, "replies.ndjson"));
  const sent: Array<[string, string]> = [];
  const dispatch = async (text: string, to: string) => { sent.push([text, to]); return `x${sent.length}`; };
  const calls: Array<Record<string, unknown>> = [];
  const rows = [
    { id: "1900000000000000003", text: "@Pixy_mon 이거 진짜 바닥임?", author_id: "7" },
    { id: "1900000000000000001", text: "@Pixy_mon 픽시몬아 나 오늘 또 손절함", author_id: "5" },
    { id: "1900000000000000002", text: "@Pixy_mon airdrop https://spam.xyz", author_id: "6" },
  ];
  const users = [{ id: "5", username: "Pixy7Crypto" }, { id: "6", username: "spammer" }, { id: "7", username: "someone" }];
  const base = { client: client(rows, users, calls), selfId: SELF, statePath, ledger, model: writer, critic, dispatch, trainerHandle: "Pixy7Crypto",
    timezone: "Asia/Seoul", xApiCost: { ...DEFAULT_X_API_COST_SETTINGS, dailyReadRequestLimit: 100, dailyMaxUsd: 10 }, maxRepliesPerRun: 5, minPollMinutes: 0 };
  const first = await replyToNewMentionsV2({ ...base, replyDailyLimit: 1 });
  assert.deepEqual(first.replied, ["x1"]);
  assert.deepEqual(sent, [["주인님 그건 좀 이름. 픽시몬은 일단 한 번 더 의심함.", "1900000000000000001"]]);
  // The spam mention was skipped; the daily limit stopped before the third, so it is not marked handled.
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).sinceId, "1900000000000000002");
  assert.equal(calls[0].max_results, 5);
  const second = await replyToNewMentionsV2({ ...base, client: client([rows[0]], users, calls), replyDailyLimit: 5 });
  assert.deepEqual(second.replied, ["x2"]);
  assert.equal(calls[1].since_id, "1900000000000000002");
  assert.equal(sent[1][1], "1900000000000000003");
});
