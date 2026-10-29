import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_X_API_COST_SETTINGS } from "../src/config/runtime.ts";
import { ReplyLedgerV2 } from "../src/services/editorial-v2/replies.ts";
import { loadTrainerPostsV2, replyToTrainerPostsV2 } from "../src/services/editorial-v2/trainer-posts.ts";
import type { EditorialWriterModelV2 } from "../src/services/editorial-v2/writer.ts";

const NOW = new Date("2026-10-29T09:00:00Z");
const idAt = (iso: string) => ((BigInt(Date.parse(iso)) - 1288834974657n) << 22n).toString();
const writer: EditorialWriterModelV2 = { modelId: "w", async generate() {
  return JSON.stringify({ replies: ["주인님 그건 좀 성급함. 픽시몬은 한 번 더 의심함.", "주인님 오늘도 부지런함.", "주인님 그 판 픽시몬은 반대쪽임."] });
} };
const critic: EditorialWriterModelV2 = { modelId: "c", async generate() { return JSON.stringify({ verdict: "pass", claim: "", problem: "" }); } };

test("Pixymon reads the trainer's posts, replies once to the newest fresh one and keeps them as material", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-trainer-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const statePath = path.join(root, "trainer-state.json");
  const ledger = new ReplyLedgerV2(path.join(root, "replies.ndjson"));
  const fresh = idAt("2026-10-29T07:00:00Z");
  const older = idAt("2026-10-29T03:00:00Z");
  const stale = idAt("2026-10-20T03:00:00Z");
  const calls: Array<[string, Record<string, unknown>]> = [];
  const client = {
    async userByUsername(name: string) { calls.push(["lookup", { name }]); return { data: { id: "777" } }; },
    async userTimeline(id: string, options: Record<string, unknown>) {
      calls.push(["timeline", { id, ...options }]);
      return { data: { data: [{ id: older, text: "솔라나 다시 들어감" }, { id: fresh, text: "앱인토스 정산 들어옴" }, { id: stale, text: "옛날 글" }] } };
    },
  };
  const sent: Array<[string, string]> = [];
  const result = await replyToTrainerPostsV2({ client, trainerHandle: "Pixy7Crypto", statePath, ledger, model: writer, critic,
    dispatch: async (text, to, beforeSend) => { beforeSend(); sent.push([text, to]); return "r1"; },
    timezone: "Asia/Seoul", xApiCost: { ...DEFAULT_X_API_COST_SETTINGS, dailyReadRequestLimit: 100, dailyMaxUsd: 10 },
    replyDailyLimit: 3, minPollMinutes: 0, now: NOW });
  assert.equal(result.replied, "r1");
  assert.deepEqual(sent, [["주인님 그건 좀 성급함. 픽시몬은 한 번 더 의심함.", fresh]]);
  assert.deepEqual(calls[1][1].exclude, ["replies", "retweets"]);
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(state.userId, "777");
  assert.equal(state.sinceId, fresh);
  const material = loadTrainerPostsV2({ statePath, handle: "Pixy7Crypto", now: NOW });
  assert.deepEqual(material.map((item) => item.text), ["앱인토스 정산 들어옴", "솔라나 다시 들어감"]);
  assert.ok(material.every((item) => item.kind === "trainer"));
  // The next poll does not look the user up again and never replies twice to the same post.
  const again = await replyToTrainerPostsV2({ client, trainerHandle: "Pixy7Crypto", statePath, ledger, model: writer, critic,
    dispatch: async () => "r2", timezone: "Asia/Seoul", xApiCost: { ...DEFAULT_X_API_COST_SETTINGS, dailyReadRequestLimit: 100, dailyMaxUsd: 10 },
    replyDailyLimit: 3, minPollMinutes: 0, now: NOW });
  assert.equal(calls.filter(([kind]) => kind === "lookup").length, 1);
  assert.equal(calls[2][1].since_id, fresh);
  assert.ok(again.skipped.some(([id, why]) => id === fresh && why === "already-drafted"));
});
