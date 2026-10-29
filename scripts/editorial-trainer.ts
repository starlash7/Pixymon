import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { loadRuntimeConfig } from "../src/config/runtime.js";
import { resolveDataDir } from "../src/services/data-dir.js";
import { initClaudeClient } from "../src/services/llm.js";
import { initTwitterClient, postTweet, TEST_MODE, TEST_NO_EXTERNAL_CALLS } from "../src/services/twitter.js";
import { replyToTrainerPostsV2 } from "../src/services/editorial-v2/trainer-posts.js";
import { autoPublishEnabledV2 } from "../src/services/editorial-v2/publication-policy.js";
import { DEFAULT_REPLY_DAILY_LIMIT_V2, ReplyLedgerV2 } from "../src/services/editorial-v2/replies.js";
import { trainerHandleV2 } from "../src/services/editorial-v2/trainer.js";
import { createAnthropicEditorialWriterV2 } from "../src/services/editorial-v2/writer.js";

function intEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  if (!autoPublishEnabledV2()) throw new Error("auto-publish-disabled (set PIXYMON_AUTO_PUBLISH=true)");
  if (config.operational.actionMode !== "live") throw new Error("editorial:trainer requires ACTION_MODE=live");
  if (TEST_MODE || TEST_NO_EXTERNAL_CALLS) throw new Error("editorial:trainer refuses TEST_MODE or TEST_NO_EXTERNAL_CALLS");
  const dataDir = resolveDataDir();
  if (fs.existsSync(path.join(dataDir, "editorial-v2", "STOP"))) throw new Error("editorial-live-suspended");
  const twitter = initTwitterClient();
  if (!twitter) throw new Error("Twitter credentials are required");
  const claude = initClaudeClient();
  const result = await replyToTrainerPostsV2({
    client: twitter.v2 as never,
    trainerHandle: trainerHandleV2(),
    statePath: path.join(dataDir, "editorial-v2", "trainer-state.json"),
    ledger: new ReplyLedgerV2(path.join(dataDir, "editorial-v2", "replies.ndjson")),
    model: createAnthropicEditorialWriterV2(claude, config.dailyTimezone, "write"),
    critic: createAnthropicEditorialWriterV2(claude, config.dailyTimezone, "critique"),
    dispatch: (text, replyToTweetId, beforeSend) => postTweet(twitter, text, "reply", {
      replyToTweetId, maxAttempts: 1, createKind: "reply:trainer-v2", timezone: config.dailyTimezone, xApiCostSettings: config.xApiCost, beforeSend,
    }),
    timezone: config.dailyTimezone,
    xApiCost: config.xApiCost,
    replyDailyLimit: intEnv("PIXYMON_REPLY_DAILY_LIMIT", DEFAULT_REPLY_DAILY_LIMIT_V2),
    minPollMinutes: intEnv("PIXYMON_TRAINER_POLL_MINUTES", 720),
  });
  console.log(`[TRAINER] polled=${result.polled}${result.reason ? ` reason=${result.reason}` : ""} read=${result.read} replied=${result.replied ?? "-"} skipped=${result.skipped.map(([id, why]) => `${id}:${why}`).join(",") || "-"}`);
}

main().catch((error) => {
  console.error(`[TRAINER] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
