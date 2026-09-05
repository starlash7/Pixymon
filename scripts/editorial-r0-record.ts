import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertEditorialCorpusGatesV2,
  evaluateRealReplayCorpusV2,
  evaluateSyntheticCorpusV2,
} from "../eval/editorial-v2-corpus.js";
import {
  readRolloutMachineEvidenceV2,
  writeNewRolloutMachineEvidenceV2,
  type RolloutMachineEvidenceV2,
} from "../src/services/editorial-v2/rollout-status.js";
import {
  readStrictEditorialReplayExportV2,
  sha256FileV2,
  verifyEditorialReplayLineageV2,
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

async function main(): Promise<void> {
  const replayPath = requiredOption("--replay");
  const eventLogPath = requiredOption("--event-log");
  const outputPath = requiredOption("--output");
  const startingState = editorialVerificationRepositoryStateV2();
  const startingCommit = startingState.currentCommit;
  if (!startingState.workingTreeClean) {
    throw new Error(
      `R0 evidence requires committed verification inputs: ${startingState.dirtyFiles.join(", ")}`
    );
  }

  execFileSync("npm", ["run", "verify"], {
    stdio: "inherit",
    env: {
      ...process.env,
      ACTION_MODE: "observe",
      TEST_MODE: "true",
      TEST_NO_EXTERNAL_CALLS: "true",
    },
  });
  const endingState = editorialVerificationRepositoryStateV2();
  if (endingState.currentCommit !== startingCommit || !endingState.workingTreeClean) {
    throw new Error("source/eval/test tree changed while verification was running");
  }

  const replayArtifactSha256 = sha256FileV2(replayPath);
  const replayExport = readStrictEditorialReplayExportV2(replayPath);
  if (sha256FileV2(replayPath) !== replayArtifactSha256) {
    throw new Error("replay artifact changed while it was being read");
  }
  verifyEditorialReplayLineageV2(replayExport, eventLogPath);
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-r0-replay-"));
  const evaluatorInputPath = path.join(temporaryDirectory, "rows.json");
  fs.writeFileSync(evaluatorInputPath, `${JSON.stringify(replayExport.rows)}\n`, "utf8");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("R0 evidence blocked an unexpected network call");
  }) as typeof fetch;
  try {
    const synthetic = await evaluateSyntheticCorpusV2("pixymon-v2-r0");
    assertEditorialCorpusGatesV2(synthetic);
    const replay = evaluateRealReplayCorpusV2(evaluatorInputPath);
    assertEditorialCorpusGatesV2(replay);
    const auditedEvidencePath = option("--non-live-write-audit");
    const auditedEvidence = auditedEvidencePath
      ? readRolloutMachineEvidenceV2(auditedEvidencePath).nonLiveWriteAudit
      : undefined;
    if (auditedEvidencePath && !auditedEvidence) {
      throw new Error("external audit file has no nonLiveWriteAudit record");
    }
    const networkAuditPath = option("--network-isolation-audit");
    const networkAudit = networkAuditPath
      ? readRolloutMachineEvidenceV2(networkAuditPath).networkIsolationAudit
      : undefined;
    if (networkAuditPath && !networkAudit) {
      throw new Error("external audit file has no networkIsolationAudit record");
    }
    const completedAt = new Date().toISOString();
    if (sha256FileV2(replayPath) !== replayArtifactSha256) {
      throw new Error("replay artifact changed while R0 evaluation was running");
    }
    const evidence: RolloutMachineEvidenceV2 = {
      schemaVersion: 2,
      kind: "pixymon-v2-rollout-evidence",
      offlineVerify: {
        passed: true,
        offlineContractMode: true,
        completedAt,
        commit: startingCommit,
        pipelineDeterminismScope: "synthetic-contract",
        pipelineDeterminismPassed: synthetic.determinism.passed,
        pipelineDeterminismRuns: synthetic.determinism.runs,
      },
      realReplay: {
        passed: replay.passed,
        candidateCount: replay.candidateCount,
        evaluatedAt: completedAt,
        artifactKind: replayExport.kind,
        artifactSha256: replayArtifactSha256,
        sourceLedgerSha256: replayExport.lineage.sourceLedgerSha256,
        sourceLedgerBytes: replayExport.lineage.sourceLedgerBytes,
        sourceEventCount: replayExport.lineage.sourceEventCount,
        sourceDraftCount: replayExport.lineage.sourceDraftCount,
        collectionEpoch: replayExport.lineage.collectionEpoch,
        epochDraftCount: replayExport.lineage.epochDraftCount,
        excludedDraftCount: replayExport.lineage.excludedDraftCount,
        selectionPolicy: replayExport.lineage.selectionPolicy,
        textProvenance: "generated",
        corpusReloadDeterminismPassed: replay.determinism.passed,
        corpusReloadDeterminismRuns: replay.determinism.runs,
      },
      networkIsolationAudit: networkAudit,
      nonLiveWriteAudit: auditedEvidence,
    };
    console.log(`[EDITORIAL] R0 evidence=${writeNewRolloutMachineEvidenceV2(outputPath, evidence)}`);
    if (!auditedEvidence) {
      console.log("[EDITORIAL] non-live X write audit remains unproven; R1 status will stay incomplete");
    }
    if (!networkAudit) {
      console.log("[EDITORIAL] OS/CI network isolation remains unproven; R0 status will stay incomplete");
    }
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[EDITORIAL] R0 evidence failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
