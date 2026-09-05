import { randomBytes } from "node:crypto";
import {
  buildBlindEvaluationPackV2,
  readBlindComparisonCasesV2,
  writeNewBlindEvaluationPackV2,
} from "../src/services/editorial-v2/human-eval.js";
import {
  readStrictEditorialReplayExportV2,
  sha256FileV2,
  verifyEditorialReplayLineageV2,
} from "../src/services/editorial-v2/replay-export.js";
import { readRolloutMachineEvidenceV2 } from "../src/services/editorial-v2/rollout-status.js";
import { editorialVerificationRepositoryStateV2 } from "./editorial-repository-state.js";

function option(name: string): string | undefined {
  const direct = process.argv.find((argument) => argument.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredOption(name: string): string {
  const value = String(option(name) || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function main(): void {
  const repository = editorialVerificationRepositoryStateV2();
  if (!repository.workingTreeClean) {
    throw new Error(`blind pack requires a clean verification tree: ${repository.dirtyFiles.join(", ")}`);
  }
  const replayPath = requiredOption("--replay");
  const replayArtifactSha256 = sha256FileV2(replayPath);
  const replay = readStrictEditorialReplayExportV2(replayPath);
  if (sha256FileV2(replayPath) !== replayArtifactSha256) {
    throw new Error("replay artifact changed while blind pack was reading it");
  }
  verifyEditorialReplayLineageV2(replay, requiredOption("--event-log"));
  const evidence = readRolloutMachineEvidenceV2(requiredOption("--machine-evidence"));
  if (
    !evidence.offlineVerify?.passed ||
    evidence.offlineVerify.commit !== repository.currentCommit ||
    !evidence.realReplay?.passed ||
    evidence.realReplay.artifactSha256 !== replayArtifactSha256 ||
    evidence.realReplay.sourceLedgerSha256 !== replay.lineage.sourceLedgerSha256 ||
    evidence.realReplay.collectionEpoch !== replay.lineage.collectionEpoch
  ) {
    throw new Error("machine evidence, replay artifact, and clean current HEAD are not bound");
  }
  const comparisons = readBlindComparisonCasesV2(requiredOption("--input"));
  const result = buildBlindEvaluationPackV2(
    comparisons,
    option("--seed") || randomBytes(32).toString("hex"),
    {
      replay,
      replayArtifactSha256,
      verifiedCommit: repository.currentCommit,
    }
  );
  const written = writeNewBlindEvaluationPackV2(
    requiredOption("--pack-output"),
    requiredOption("--mapping-output"),
    result
  );
  console.log(`[EDITORIAL] blind pack=${written.packPath}`);
  console.log(`[EDITORIAL] private mapping=${written.mappingPath}`);
}

try {
  main();
} catch (error) {
  console.error(`[EDITORIAL] blind pack failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
