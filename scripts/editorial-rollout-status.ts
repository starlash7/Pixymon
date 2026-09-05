import "dotenv/config";
import type { ActionMode } from "../src/types/runtime.js";
import { editorialVerificationRepositoryStateV2 } from "./editorial-repository-state.js";
import {
  aggregateBlindEvaluationV2,
  readBlindEvaluationAdjudicationsV2,
  readBlindEvaluationAnnotationsV2,
  readBlindEvaluationPackV2,
  readBlindEvaluationMappingV2,
} from "../src/services/editorial-v2/human-eval.js";
import { verifyGitHubNetworkIsolationV2 } from "../src/services/editorial-v2/github-ci-verifier.js";
import { resolveEditorialRuntimePathsV2 } from "../src/services/editorial-v2/paths.js";
import { verifyEditorialR1PromotionV2 } from "../src/services/editorial-v2/r1-promotion.js";
import {
  readStrictEditorialReplayExportV2,
  sha256FileV2,
  verifyEditorialReplayLineageV2,
} from "../src/services/editorial-v2/replay-export.js";
import {
  buildEditorialRolloutStatusV2,
  readEditorialRolloutInputsV2,
  readRolloutMachineEvidenceV2,
  serializeEditorialRolloutStatusV2,
  writeNewEditorialRolloutStatusV2,
} from "../src/services/editorial-v2/rollout-status.js";

function option(name: string): string | undefined {
  const direct = process.argv.find((argument) => argument.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function actionMode(): ActionMode {
  const value = String(process.env.ACTION_MODE || "observe").trim();
  if (!['observe', 'paper', 'live'].includes(value)) throw new Error("ACTION_MODE is invalid");
  return value as ActionMode;
}

function repositoryState(): { currentCommit?: string; workingTreeClean?: boolean } {
  try {
    const state = editorialVerificationRepositoryStateV2();
    return { currentCommit: state.currentCommit, workingTreeClean: state.workingTreeClean };
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const repoState = repositoryState();
  const mode = actionMode();
  const requestedEventLog = option("--event-log");
  const requestedMetricLog = option("--metric-log");
  const paths = requestedEventLog && requestedMetricLog
    ? undefined
    : resolveEditorialRuntimePathsV2(mode);
  const eventLogPath = requestedEventLog || paths!.eventLogPath;
  const metricLogPath = requestedMetricLog || paths!.metricLogPath;
  const data = readEditorialRolloutInputsV2({
    eventLogPath,
    metricLogPath,
  });
  const evidencePath = option("--machine-evidence");
  const machineEvidence = evidencePath ? readRolloutMachineEvidenceV2(evidencePath) : undefined;
  const replayPath = option("--replay");
  if (replayPath && !machineEvidence?.realReplay) {
    throw new Error("--replay requires machine evidence with realReplay");
  }
  const replayArtifactVerification = replayPath && machineEvidence?.realReplay
    ? (() => {
        const artifactSha256 = sha256FileV2(replayPath);
        const replay = readStrictEditorialReplayExportV2(replayPath);
        if (sha256FileV2(replayPath) !== artifactSha256) {
          throw new Error("replay artifact changed while status was reading it");
        }
        verifyEditorialReplayLineageV2(replay, eventLogPath);
        return {
          replay,
          artifactSha256,
          sourceLedgerSha256: replay.lineage.sourceLedgerSha256,
          collectionEpoch: replay.lineage.collectionEpoch,
          verified: true,
        };
      })()
    : undefined;
  const packPath = option("--pack");
  const mappingPath = option("--mapping");
  const annotationsPath = option("--annotations");
  if (new Set([Boolean(packPath), Boolean(mappingPath), Boolean(annotationsPath)]).size !== 1) {
    throw new Error("--pack, --mapping, and --annotations must be supplied together");
  }
  const adjudicationPath = option("--adjudications");
  if (adjudicationPath && !packPath) {
    throw new Error("--adjudications requires --pack, --mapping, and --annotations");
  }
  if (packPath && (!replayArtifactVerification || !repoState.currentCommit || !repoState.workingTreeClean)) {
    throw new Error("human evaluation requires --replay, machine evidence, and a clean current HEAD");
  }
  const humanEvaluation = packPath && mappingPath && annotationsPath
    ? aggregateBlindEvaluationV2({
        pack: readBlindEvaluationPackV2(packPath),
        mapping: readBlindEvaluationMappingV2(mappingPath),
        annotations: readBlindEvaluationAnnotationsV2(annotationsPath),
        adjudications: adjudicationPath
          ? readBlindEvaluationAdjudicationsV2(adjudicationPath)
          : [],
        binding: {
          replay: replayArtifactVerification!.replay,
          replayArtifactSha256: replayArtifactVerification!.artifactSha256,
          verifiedCommit: repoState.currentCommit!,
        },
      })
    : undefined;
  const nowValue = option("--now");
  const now = nowValue ? new Date(nowValue) : new Date();
  const promotionPath = option("--r1-promotion");
  const promotionStatusPath = option("--r1-status");
  if (Boolean(promotionPath) !== Boolean(promotionStatusPath)) {
    throw new Error("--r1-promotion and --r1-status must be supplied together");
  }
  const r1Promotion = promotionPath && promotionStatusPath
    ? verifyEditorialR1PromotionV2({ promotionPath, statusPath: promotionStatusPath, now })
    : undefined;
  const githubCiRepo = option("--github-ci-repo");
  const githubNetworkIsolation = githubCiRepo
    ? repoState.currentCommit && repoState.workingTreeClean
      ? await verifyGitHubNetworkIsolationV2({
          repository: githubCiRepo,
          headSha: repoState.currentCommit,
          token: process.env.GITHUB_TOKEN,
        })
      : {
          state: "unknown" as const,
          repository: githubCiRepo,
          headSha: repoState.currentCommit || "",
          workflowPath: ".github/workflows/verify.yml" as const,
          reason: "clean-current-head-unavailable",
        }
    : undefined;
  const status = buildEditorialRolloutStatusV2({
    ...data,
    now,
    timezone: option("--timezone") || process.env.DAILY_TARGET_TIMEZONE || "Asia/Seoul",
    machineEvidence,
    replayArtifactVerification,
    humanEvaluation,
    r1Promotion,
    githubNetworkIsolation,
    ...repoState,
  });
  const output = option("--output");
  if (output) {
    console.log(`[EDITORIAL] rollout status=${writeNewEditorialRolloutStatusV2(output, status)}`);
  } else {
    process.stdout.write(serializeEditorialRolloutStatusV2(status));
  }
}

try {
  await main();
} catch (error) {
  console.error(`[EDITORIAL] rollout status failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
