import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { EDITORIAL_COLLECTION_EPOCH_V2 } from "./contracts.js";
import { EDITORIAL_R1_REQUIRED_CHECK_IDS_V2 } from "./r1-promotion.js";
import type { EditorialRolloutStatusV2 } from "./rollout-status.js";

const DAY_MS = 86_400_000;
const REQUIRED_CHECKS = {
  r0: ["offline-contract-verify", "network-isolation", "verified-current-tree", "evidence-not-from-future", "pipeline-determinism"],
  r1: [...EDITORIAL_R1_REQUIRED_CHECK_IDS_V2],
  r2: ["real-replay", "replay-lineage", "corpus-reload-determinism", "two-reader-blind-evaluation", "human-evaluation-lineage",
    "r1-prerequisite", "r1-promotion-boundary", "runtime-logs", "no-future-records", "reviewed-drafts", "review-days",
    "review-elapsed-time", "fact-check-coverage", "factual-errors", "language-check-coverage", "malformed-errors",
    "no-edit-acceptance", "final-approved-contract", "telemetry-links", "fallback-incidents", "fallback-telemetry-complete"],
} as const;

interface ApprovedLiveAuthorizationV2 {
  kind: "pixymon-approved-live-authorization";
  stage: "R3";
  scope: "protocol-originals";
  epoch: string;
  operatorId: string;
  commit: string;
  issuedAt: string;
  expiresAt: string;
  statusPath: string;
  statusSha256: string;
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Local operator authority, not an external zero-write attestation or auto-publish permission. */
export function assertApprovedLiveStatusV2(status: EditorialRolloutStatusV2, commit: string): void {
  if (status?.kind !== "pixymon-v2-rollout-status" || status.schemaVersion !== 2 ||
      status.repository?.currentCommit !== commit || status.repository.verificationTreeClean !== true) {
    throw new Error("approved-live-status-commit-mismatch");
  }
  for (const stage of ["r0", "r1", "r2"] as const) {
    const gate = status.gates?.[stage];
    if (!gate || gate.earned !== true || !Array.isArray(gate.checks) ||
      gate.checks.some((check) => check.state !== "pass") ||
      new Set(gate.checks.map((check) => check.id)).size !== gate.checks.length ||
      REQUIRED_CHECKS[stage].some((id) => !gate.checks.some((check) => check.id === id))) {
      throw new Error(`approved-live-${stage}-not-earned`);
    }
  }
}

export function writeApprovedLiveAuthorizationV2(input: {
  statusPath: string; outputPath: string; operatorId: string; commit: string; now?: Date;
}): void {
  const now = input.now ?? new Date();
  if (!input.operatorId.trim()) throw new Error("operator identity is required");
  const bytes = fs.readFileSync(input.statusPath);
  const status = JSON.parse(bytes.toString("utf8")) as EditorialRolloutStatusV2;
  assertApprovedLiveStatusV2(status, input.commit);
  const age = now.getTime() - Date.parse(status.generatedAt);
  if (!Number.isFinite(age) || age < 0 || age > 15 * 60_000) throw new Error("fresh rollout status required (15 minutes)");
  const authorization: ApprovedLiveAuthorizationV2 = {
    kind: "pixymon-approved-live-authorization", stage: "R3", scope: "protocol-originals",
    epoch: EDITORIAL_COLLECTION_EPOCH_V2, operatorId: input.operatorId.trim(), commit: input.commit,
    issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + DAY_MS).toISOString(),
    statusPath: path.resolve(input.statusPath), statusSha256: digest(bytes),
  };
  fs.mkdirSync(path.dirname(path.resolve(input.outputPath)), { recursive: true });
  fs.writeFileSync(input.outputPath, `${JSON.stringify(authorization, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

export function assertApprovedLiveAuthorizationV2(input: {
  authorizationPath: string; stopPath: string; commit: string; workingTreeClean: boolean; now?: Date;
}): void {
  if (fs.existsSync(input.stopPath)) throw new Error("editorial-live-suspended");
  if (!input.workingTreeClean) throw new Error("editorial-live-tree-dirty");
  if (!input.authorizationPath) throw new Error("approved-live-authorization-required");
  const record = JSON.parse(fs.readFileSync(input.authorizationPath, "utf8")) as ApprovedLiveAuthorizationV2;
  const nowMs = (input.now ?? new Date()).getTime();
  const issuedMs = Date.parse(record.issuedAt);
  const expiryMs = Date.parse(record.expiresAt);
  if (record.kind !== "pixymon-approved-live-authorization" || record.stage !== "R3" ||
      record.scope !== "protocol-originals" || record.epoch !== EDITORIAL_COLLECTION_EPOCH_V2 ||
      record.commit !== input.commit || typeof record.operatorId !== "string" || !record.operatorId.trim() ||
      !Number.isFinite(issuedMs) || !Number.isFinite(expiryMs) || !Number.isFinite(nowMs) ||
      issuedMs > nowMs || expiryMs <= nowMs || expiryMs - issuedMs > DAY_MS || expiryMs <= issuedMs) {
    throw new Error("approved-live-authorization-invalid-or-expired");
  }
  const statusBytes = fs.readFileSync(record.statusPath);
  if (digest(statusBytes) !== record.statusSha256) throw new Error("approved-live-status-changed");
  assertApprovedLiveStatusV2(JSON.parse(statusBytes.toString("utf8")), input.commit);
}
