import "dotenv/config";
import path from "node:path";
import { EditorialEventStoreV2 } from "../src/services/editorial-v2/event-store.js";
import { resolveEditorialRuntimePathsV2 } from "../src/services/editorial-v2/paths.js";
import { runJevReviewV2 } from "../src/services/editorial-v2/jev-review-runner.js";
import { jevReviewCasesV2 } from "../eval/jev-review-cases.js";

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("editorial:jev-review (--id <draftId> | --case <synthetic-case>) [--execute]\nDefault: preview exact TypeSafe payload; zero API calls.\n--execute: one paid TypeSafe request, at most 12/day UTC; advisory only, never approval.\nSends current draft, evidence, inquiry and relevant past judgment to TypeSafe; no X/provider/Anthropic calls.\nSynthetic cases: " + jevReviewCasesV2().map((item) => item.id).join(", "));
    return;
  }
  let id: string | undefined;
  let caseId: string | undefined;
  let execute = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--id" && !id && args[index + 1] && !args[index + 1].startsWith("--")) id = args[++index];
    else if (args[index] === "--case" && !caseId && args[index + 1] && !args[index + 1].startsWith("--")) caseId = args[++index];
    else if (args[index] === "--execute" && !execute) execute = true;
    else throw new Error("expected (--id <draftId> | --case <synthetic-case>) [--execute]");
  }
  if (Boolean(id) === Boolean(caseId)) throw new Error("choose exactly one of --id or --case");
  const mode = process.env.ACTION_MODE || "observe";
  if (mode !== "observe" && mode !== "paper") throw new Error("Jev review requires observe or paper mode");
  const paths = resolveEditorialRuntimePathsV2(mode);
  const store = new EditorialEventStoreV2({ eventLogPath: paths.eventLogPath });
  const fixture = caseId ? jevReviewCasesV2().find((item) => item.id === caseId) : undefined;
  const state = id ? store.getDraftState(id) : fixture?.state;
  if (!state) throw new Error("unknown editorial draft");
  // Both safety flags must explicitly permit a real call. Merely setting a key never calls TypeSafe.
  const allowExternal = process.env.TEST_MODE === "false" && process.env.TEST_NO_EXTERNAL_CALLS === "false";
  const report = await runJevReviewV2({ state, execute, allowExternal, apiKey: process.env.TYPESAFE_API_KEY,
    sourceKind: fixture ? "synthetic" : "ledger",
    auditDir: path.join(paths.dataDir, "editorial-jev") });
  // Labels are for comparison only and are never included in the API request.
  const labelComparison = fixture && "result" in report && report.result.status === "evaluated"
    ? Object.entries(fixture.expected).map(([question, expected]) => ({ question, expected,
      actual: report.result.status === "evaluated" ? report.result.response.answers[question]?.choice : null })) : undefined;
  console.log(JSON.stringify({ ...report, labelComparison }, null, 2));
  if ("result" in report && report.result.status === "unavailable") process.exitCode = 1;
}

main().catch((error) => {
  // No provider response bodies or credentials appear in diagnostics.
  console.error(`[EDITORIAL-JEV] ${error instanceof Error ? error.message : "review failed"}`);
  process.exitCode = 1;
});
