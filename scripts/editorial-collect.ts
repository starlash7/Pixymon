import "dotenv/config";
import path from "node:path";
import { loadRuntimeConfig } from "../src/config/runtime.js";
import { EditorialEventStoreV2 } from "../src/services/editorial-v2/event-store.js";
import { resolveEditorialRuntimePathsV2 } from "../src/services/editorial-v2/paths.js";
import { collectEditorialDraftV2 } from "../src/services/editorial-v2/workflow.js";
import { createAnthropicEditorialWriterV2 } from "../src/services/editorial-v2/writer.js";
import { initClaudeClient } from "../src/services/llm.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--jev-memory") || args.length > 1) throw new Error("usage: editorial:collect [--jev-memory]");
  const jevMemory = args.includes("--jev-memory");
  const config = loadRuntimeConfig();
  if (config.operational.postPipelineVersion !== "v2") throw new Error("editorial:collect requires POST_PIPELINE_VERSION=v2");
  if (config.operational.actionMode === "live") throw new Error("editorial:collect is read/generate-only; use ACTION_MODE=observe or paper");
  const paths = resolveEditorialRuntimePathsV2(config.operational.actionMode);
  if (jevMemory) {
    if (paths.trackingMode !== "shadow") throw new Error("--jev-memory requires EDITORIAL_TRACKING_MODE=shadow");
    if (process.env.TEST_MODE !== "false" || process.env.TEST_NO_EXTERNAL_CALLS !== "false") {
      throw new Error("--jev-memory requires TEST_MODE=false and TEST_NO_EXTERNAL_CALLS=false");
    }
    if (!process.env.TYPESAFE_API_KEY?.trim()) throw new Error("TYPESAFE_API_KEY is required for --jev-memory");
  }
  if (!String(process.env.ANTHROPIC_API_KEY || "").trim()) throw new Error("ANTHROPIC_API_KEY is required");
  const store = new EditorialEventStoreV2({ eventLogPath: paths.eventLogPath });
  const claude = initClaudeClient();
  const result = await collectEditorialDraftV2({
    store,
    writerModel: createAnthropicEditorialWriterV2(claude, config.dailyTimezone),
    inquiryModel: createAnthropicEditorialWriterV2(claude, config.dailyTimezone, "inquire"),
    metricLogPath: paths.metricLogPath,
    mode: config.operational.actionMode,
    trackingMode: paths.trackingMode,
    jevMemory: jevMemory ? { apiKey: process.env.TYPESAFE_API_KEY, allowExternal: true,
      auditDir: path.join(paths.dataDir, "editorial-jev") } : undefined,
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
