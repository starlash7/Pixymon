import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_X_API_COST_SETTINGS } from "../src/config/runtime.ts";
import { loadTrainerPostsV2, readTrainerPostsV2 } from "../src/services/editorial-v2/trainer-posts.ts";

const NOW = new Date("2026-10-29T09:00:00Z");
const idAt = (iso: string) => ((BigInt(Date.parse(iso)) - 1288834974657n) << 22n).toString();

test("Pixymon reads the trainer's posts once per poll and keeps the fresh ones as thought material", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-trainer-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const statePath = path.join(root, "trainer-state.json");
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
  const cost = { ...DEFAULT_X_API_COST_SETTINGS, dailyReadRequestLimit: 100, dailyMaxUsd: 10 };
  assert.deepEqual(await readTrainerPostsV2({ client, trainerHandle: "Pixy7Crypto", statePath, timezone: "Asia/Seoul", xApiCost: cost, minPollMinutes: 0, now: NOW }),
    { polled: true, read: 3 });
  assert.deepEqual(calls[1][1].exclude, ["replies", "retweets"]);
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(state.userId, "777");
  assert.equal(state.sinceId, fresh);
  const material = loadTrainerPostsV2({ statePath, handle: "Pixy7Crypto", now: NOW });
  assert.deepEqual(material.map((item) => item.text), ["앱인토스 정산 들어옴", "솔라나 다시 들어감"]);
  assert.ok(material.every((item) => item.kind === "trainer"));
  await readTrainerPostsV2({ client, trainerHandle: "Pixy7Crypto", statePath, timezone: "Asia/Seoul", xApiCost: cost, minPollMinutes: 0, now: NOW });
  assert.equal(calls.filter(([kind]) => kind === "lookup").length, 1);
  assert.equal(calls[2][1].since_id, fresh);
});
