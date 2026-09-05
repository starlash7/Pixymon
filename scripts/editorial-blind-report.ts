import {
  aggregateBlindEvaluationV2,
  readBlindEvaluationAdjudicationsV2,
  readBlindEvaluationAnnotationsV2,
  readBlindEvaluationPackV2,
  readBlindEvaluationMappingV2,
  writeNewBlindEvaluationReportV2,
} from "../src/services/editorial-v2/human-eval.js";
import {
  readStrictEditorialReplayExportV2,
  sha256FileV2,
} from "../src/services/editorial-v2/replay-export.js";
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
  const adjudicationPath = option("--adjudications");
  const replayPath = requiredOption("--replay");
  const replayArtifactSha256 = sha256FileV2(replayPath);
  const replay = readStrictEditorialReplayExportV2(replayPath);
  if (sha256FileV2(replayPath) !== replayArtifactSha256) {
    throw new Error("replay artifact changed while blind report was reading it");
  }
  const repository = editorialVerificationRepositoryStateV2();
  if (!repository.workingTreeClean) {
    throw new Error("blind report requires a clean verification tree");
  }
  const report = aggregateBlindEvaluationV2({
    pack: readBlindEvaluationPackV2(requiredOption("--pack")),
    mapping: readBlindEvaluationMappingV2(requiredOption("--mapping")),
    annotations: readBlindEvaluationAnnotationsV2(requiredOption("--annotations")),
    adjudications: adjudicationPath
      ? readBlindEvaluationAdjudicationsV2(adjudicationPath)
      : [],
    binding: {
      replay,
      replayArtifactSha256,
      verifiedCommit: repository.currentCommit,
    },
  });
  const output = option("--output");
  if (output) {
    console.log(`[EDITORIAL] blind report=${writeNewBlindEvaluationReportV2(output, report)}`);
  } else {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
  if (!report.passed) process.exitCode = 2;
}

try {
  main();
} catch (error) {
  console.error(`[EDITORIAL] blind report failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
