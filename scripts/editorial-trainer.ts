import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { loadRuntimeConfig } from "../src/config/runtime.js";
import { resolveDataDir } from "../src/services/data-dir.js";
import { initTwitterClient, TEST_MODE, TEST_NO_EXTERNAL_CALLS } from "../src/services/twitter.js";
import { readTrainerPostsV2 } from "../src/services/editorial-v2/trainer-posts.js";
import { autoPublishEnabledV2 } from "../src/services/editorial-v2/publication-policy.js";
import { trainerHandleV2 } from "../src/services/editorial-v2/trainer.js";

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
  const result = await readTrainerPostsV2({
    client: twitter.v2 as never,
    trainerHandle: trainerHandleV2(),
    statePath: path.join(dataDir, "editorial-v2", "trainer-state.json"),
    timezone: config.dailyTimezone,
    xApiCost: config.xApiCost,
    minPollMinutes: intEnv("PIXYMON_TRAINER_POLL_MINUTES", 720),
  });
  console.log(`[TRAINER] polled=${result.polled}${result.reason ? ` reason=${result.reason}` : ""} read=${result.read}`);
}

main().catch((error) => {
  console.error(`[TRAINER] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
