import "dotenv/config";
import { writeApprovedLiveAuthorizationV2 } from "../src/services/editorial-v2/publication-policy.js";
import { editorialVerificationRepositoryStateV2 } from "./editorial-repository-state.js";

function required(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`--${name} is required`);
  return value;
}

try {
  const state = editorialVerificationRepositoryStateV2();
  if (!state.workingTreeClean) throw new Error("approved live requires committed verification inputs");
  writeApprovedLiveAuthorizationV2({
    statusPath: required("status"), outputPath: required("output"),
    operatorId: required("operator"), commit: state.currentCommit,
  });
  console.log("[EDITORIAL] R3 authorization recorded for 24 hours; every post still requires human approval");
} catch (error) {
  console.error(`[EDITORIAL] authorization blocked: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
