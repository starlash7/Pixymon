import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { loadRuntimeConfig } from "../src/config/runtime.js";
import { resolveDataDir } from "../src/services/data-dir.js";
import { initClaudeClient } from "../src/services/llm.js";
import { initTwitterClient, postTweet, TEST_MODE, TEST_NO_EXTERNAL_CALLS } from "../src/services/twitter.js";
import { replyToNewMentionsV2 } from "../src/services/editorial-v2/mentions.js";
import { autoPublishEnabledV2 } from "../src/services/editorial-v2/publication-policy.js";
import { DEFAULT_REPLY_DAILY_LIMIT_V2, ReplyLedgerV2 } from "../src/services/editorial-v2/replies.js";
import { trainerHandleV2 } from "../src/services/editorial-v2/trainer.js";
import { createAnthropicEditorialWriterV2 } from "../src/services/editorial-v2/writer.js";

const PIXY_MON_USER_ID = "2013948537416110080";

function intEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  if (!autoPublishEnabledV2()) throw new Error("auto-publish-disabled (set PIXYMON_AUTO_PUBLISH=true)");
  if (config.operational.actionMode !== "live") throw new Error("editorial:mentions requires ACTION_MODE=live");
  if (TEST_MODE || TEST_NO_EXTERNAL_CALLS) throw new Error("editorial:mentions refuses TEST_MODE or TEST_NO_EXTERNAL_CALLS");
  const dataDir = resolveDataDir();
  if (fs.existsSync(path.join(dataDir, "editorial-v2", "STOP"))) throw new Error("editorial-live-suspended");
  const twitter = initTwitterClient();
  if (!twitter) throw new Error("Twitter credentials are required");
  const claude = initClaudeClient();
  const result = await replyToNewMentionsV2({
    client: twitter.v2 as never,
    selfId: process.env.PIXYMON_SELF_ID || PIXY_MON_USER_ID,
    statePath: path.join(dataDir, "editorial-v2", "mentions-state.json"),
    ledger: new ReplyLedgerV2(path.join(dataDir, "editorial-v2", "replies.ndjson")),
    model: createAnthropicEditorialWriterV2(claude, config.dailyTimezone, "write"),
    critic: createAnthropicEditorialWriterV2(claude, config.dailyTimezone, "critique"),
    dispatch: (text, replyToTweetId, beforeSend) => postTweet(twitter, text, "reply", {
      replyToTweetId, maxAttempts: 1, createKind: "reply:mention-v2", timezone: config.dailyTimezone, xApiCostSettings: config.xApiCost, beforeSend,
    }),
    trainerHandle: trainerHandleV2(),
    timezone: config.dailyTimezone,
    xApiCost: config.xApiCost,
    replyDailyLimit: intEnv("PIXYMON_REPLY_DAILY_LIMIT", DEFAULT_REPLY_DAILY_LIMIT_V2),
    maxRepliesPerRun: intEnv("PIXYMON_MENTION_REPLIES_PER_RUN", 2),
    minPollMinutes: intEnv("PIXYMON_MENTION_POLL_MINUTES", 240),
  });
  console.log(`[MENTIONS] polled=${result.polled}${result.reason ? ` reason=${result.reason}` : ""} read=${result.read} replied=${result.replied.join(",") || "-"} skipped=${result.skipped.map(([id, why]) => `${id}:${why}`).join(",") || "-"}`);
}

main().catch((error) => {
  console.error(`[MENTIONS] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
