import "dotenv/config";
import fs from "node:fs";
import { readEditorialDecisionContextV2, replayEditorialDecisionV2 } from "../src/services/editorial-v2/decision-replay.js";
import { createAnthropicEditorialWriterV2 } from "../src/services/editorial-v2/writer.js";
import { initClaudeClient } from "../src/services/llm.js";
import { sha256FileV2 } from "../src/services/editorial-v2/replay-export.js";

function required(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`--${name} is required`);
  return value;
}

async function main() {
  if (process.env.ACTION_MODE === "live") throw new Error("comparison is read/generate-only");
  const contextPath = required("context");
  const outputPath = required("output");
  if (fs.existsSync(outputPath)) throw new Error("comparison output already exists");
  const contextSha256 = sha256FileV2(contextPath);
  const context = readEditorialDecisionContextV2(contextPath);
  const claude = initClaudeClient();
  const model = createAnthropicEditorialWriterV2(claude);
  const inquiryModel = createAnthropicEditorialWriterV2(claude, undefined, "inquire");
  const baseline = await replayEditorialDecisionV2({ context, model, inquiryModel, variant: "captured-plan" });
  const candidate = await replayEditorialDecisionV2({ context, model, inquiryModel, variant: "current-plan" });
  if (sha256FileV2(contextPath) !== contextSha256) throw new Error("comparison context changed");
  fs.writeFileSync(outputPath, JSON.stringify({
    kind: "pixymon-same-context-comparison", contextSha256, sourceRevision: context.revision,
    modelId: model.modelId, inquiryModelId: inquiryModel.modelId,
    baselineVariant: "captured-plan", candidateVariant: "current-plan",
    baseline, candidate, humanEvaluation: "pending",
  }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log("[EDITORIAL] same-context comparison saved; human preference and no-edit acceptance are not yet measured");
}
main().catch((error) => {
  console.error(`[EDITORIAL] comparison failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
