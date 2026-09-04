import "dotenv/config";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadRuntimeConfig } from "../src/config/runtime.js";
import { EditorialEventStoreV2 } from "../src/services/editorial-v2/event-store.js";
import { resolveEditorialRuntimePathsV2 } from "../src/services/editorial-v2/paths.js";
import { formatEditorialReviewCardV2, recordEditorialReviewV2 } from "../src/services/editorial-v2/review.js";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function decideInteractive(store: EditorialEventStoreV2, metricLogPath: string): Promise<void> {
  const config = loadRuntimeConfig();
  const reviewerId = String(process.env.EDITORIAL_REVIEWER_ID || process.env.USER || "operator").trim();
  const requested = arg("id");
  const states = store.listDraftStates().filter((state) => !state.publication && state.reviewStatus === "pending" && (!requested || state.draft.id === requested));
  if (states.length === 0) {
    console.log("[EDITORIAL] pending draft 없음");
    return;
  }
  const rl = readline.createInterface({ input, output });
  try {
    for (const state of states) {
      console.log(`\n${formatEditorialReviewCardV2(state)}\n`);
      const rawAction = (await rl.question("approve / edit / reject / skip > ")).trim().toLowerCase();
      if (rawAction === "skip" || !rawAction) continue;
      if (!['approve', 'edit', 'reject'].includes(rawAction)) {
        console.log("[EDITORIAL] 알 수 없는 선택, skip");
        continue;
      }
      const action = rawAction as "approve" | "edit" | "reject";
      const reasons = (await rl.question("reason tags (comma, optional for approve) > ")).split(",").map((item) => item.trim()).filter(Boolean);
      const editedDraft = action === "edit" ? (await rl.question("edited draft (single line) > ")).trim() : undefined;
      recordEditorialReviewV2({ store, draftId: state.draft.id, action, reviewerId, reasonTags: reasons, editedDraft, metricLogPath, mode: config.operational.actionMode });
      console.log(`[EDITORIAL] ${state.draft.id} -> ${action}`);
    }
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  const paths = resolveEditorialRuntimePathsV2(config.operational.actionMode);
  const store = new EditorialEventStoreV2({ eventLogPath: paths.eventLogPath });
  const actionArg = arg("action");
  const draftId = arg("id");
  if (!actionArg) return decideInteractive(store, paths.metricLogPath);
  if (!draftId || !["approve", "edit", "reject"].includes(actionArg)) throw new Error("non-interactive review requires --id and --action approve|edit|reject");
  const reviewerId = String(process.env.EDITORIAL_REVIEWER_ID || process.env.USER || "operator").trim();
  const reasonTags = String(arg("reason") || "").split(",").map((item) => item.trim()).filter(Boolean);
  recordEditorialReviewV2({ store, draftId, action: actionArg as "approve" | "edit" | "reject", reviewerId, reasonTags, editedDraft: arg("text"), metricLogPath: paths.metricLogPath, mode: config.operational.actionMode });
  console.log(`[EDITORIAL] ${draftId} -> ${actionArg}`);
}

main().catch((error) => {
  console.error(`[EDITORIAL] review failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
