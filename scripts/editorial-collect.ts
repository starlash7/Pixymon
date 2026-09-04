import "dotenv/config";
import { loadRuntimeConfig } from "../src/config/runtime.js";
import { EditorialEventStoreV2 } from "../src/services/editorial-v2/event-store.js";
import { resolveEditorialRuntimePathsV2 } from "../src/services/editorial-v2/paths.js";
import { collectEditorialDraftV2 } from "../src/services/editorial-v2/workflow.js";
import { createAnthropicEditorialWriterV2 } from "../src/services/editorial-v2/writer.js";
import { initClaudeClient } from "../src/services/llm.js";

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  if (config.operational.postPipelineVersion !== "v2") throw new Error("editorial:collect requires POST_PIPELINE_VERSION=v2");
  if (config.operational.actionMode === "live") throw new Error("editorial:collect is read/generate-only; use ACTION_MODE=observe or paper");
  if (!String(process.env.ANTHROPIC_API_KEY || "").trim()) throw new Error("ANTHROPIC_API_KEY is required");
  const paths = resolveEditorialRuntimePathsV2(config.operational.actionMode);
  const store = new EditorialEventStoreV2({ eventLogPath: paths.eventLogPath });
  const result = await collectEditorialDraftV2({
    store,
    writerModel: createAnthropicEditorialWriterV2(initClaudeClient(), config.dailyTimezone),
    metricLogPath: paths.metricLogPath,
    mode: config.operational.actionMode,
  });
  if (result.status === "drafted") {
    console.log(`[EDITORIAL] draft=${result.draftId}`);
    console.log(result.draft);
    console.log(`review: npm run editorial:review -- --id ${result.draftId}`);
    return;
  }
  console.log(`[EDITORIAL] no-post stage=${result.stage} reason=${result.reason}`);
  process.exitCode = 2;
}

main().catch((error) => {
  console.error(`[EDITORIAL] collect failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
