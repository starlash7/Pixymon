import "dotenv/config";
import { writeOperatorPilotAuthorizationV2 } from "../src/services/editorial-v2/operator-pilot.js";
import { writeApprovedLiveAuthorizationV2 } from "../src/services/editorial-v2/publication-policy.js";
import { editorialVerificationRepositoryStateV2 } from "./editorial-repository-state.js";

function optional(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function required(name: string): string {
  const value = optional(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

try {
  const state = editorialVerificationRepositoryStateV2();
  if (!state.workingTreeClean) throw new Error("approved live requires committed verification inputs");
  if (process.argv.includes("--pilot")) {
    // Option B: evidence is the operator's review of real shadow drafts in the canonical shadow ledger.
    const evidence = writeOperatorPilotAuthorizationV2({
      outputPath: required("output"), operatorId: required("operator"), commit: state.currentCommit,
    });
    console.log(`[EDITORIAL] operator pilot authorization recorded for 24 hours (reviewed=${evidence.reviewed}, no-edit fact-checked=${evidence.noEditFactChecked}, factual errors=0); every post still requires human approval, max one per day`);
  } else {
    writeApprovedLiveAuthorizationV2({
      statusPath: required("status"), outputPath: required("output"),
      operatorId: required("operator"), commit: state.currentCommit,
    });
    console.log("[EDITORIAL] R3 authorization recorded for 24 hours; every post still requires human approval");
  }
} catch (error) {
  console.error(`[EDITORIAL] authorization blocked: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
