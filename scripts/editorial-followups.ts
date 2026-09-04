import "dotenv/config";
import { loadRuntimeConfig } from "../src/config/runtime.js";
import { EditorialEventStoreV2 } from "../src/services/editorial-v2/event-store.js";
import { resolveEditorialRuntimePathsV2 } from "../src/services/editorial-v2/paths.js";
import { checkEditorialFollowUpsV2 } from "../src/services/editorial-v2/workflow.js";

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  if (config.operational.postPipelineVersion !== "v2") {
    throw new Error("editorial:followups requires POST_PIPELINE_VERSION=v2");
  }
  if (config.operational.actionMode === "live") {
    throw new Error("editorial:followups is read/check-only; use ACTION_MODE=observe or paper");
  }
  if (process.env.TEST_MODE === "true" && process.env.TEST_NO_EXTERNAL_CALLS !== "false") {
    throw new Error("editorial:followups requires provider reads; TEST_NO_EXTERNAL_CALLS must be false");
  }
  const paths = resolveEditorialRuntimePathsV2(config.operational.actionMode);
  const store = new EditorialEventStoreV2({ eventLogPath: paths.eventLogPath });
  const result = await checkEditorialFollowUpsV2({
    store,
    metricLogPath: paths.metricLogPath,
    mode: config.operational.actionMode,
  });
  console.log(
    `[EDITORIAL] followups checked targets=${result.targetCount} resolutions=${result.resolutionCount} publicCandidates=${result.publicCandidateCount} retryable=${result.retryableCount}`
  );
  if (result.publicCandidateCount > 0) {
    console.log("[EDITORIAL] public follow-up candidate is durable; run `npm run editorial:collect` now before its evidence freshness window expires.");
  }
}

main().catch((error) => {
  console.error(`[EDITORIAL] followups failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
