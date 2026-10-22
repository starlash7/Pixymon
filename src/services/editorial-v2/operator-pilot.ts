import fs from "node:fs";
import path from "node:path";
import { EDITORIAL_COLLECTION_EPOCH_V2 } from "./contracts.js";
import { EditorialEventStoreV2, type EditorialDraftStateV2 } from "./event-store.js";
import { resolveEditorialRuntimePathsV2 } from "./paths.js";
import { EDITORIAL_FACT_CHECKED_TAG_V2, EDITORIAL_FACT_ERROR_TAGS_V2 } from "./rollout-status.js";

/**
 * Operator decision 2026-10-12 (docs/plan.md §23, option B): the first human-approved
 * originals may be authorized from the operator's own review of real shadow drafts instead of the
 * R0–R2 status (whose R1 zero-X verifier does not exist). Human approval per post, one post per day,
 * the STOP file and the two-phase dispatch guard are unchanged.
 */
/**
 * Operator decision 2026-10-22: every post is human-approved anyway, so the pilot needs only three
 * fact-checked approvals (edits allowed) in the current epoch, and no factual-error tag.
 */
export const OPERATOR_PILOT_MIN_APPROVED_FACT_CHECKED_V2 = 3;
const DAY_MS = 86_400_000;

export interface OperatorPilotEvidenceV2 {
  epoch: string;
  reviewed: number;
  approvedFactChecked: number;
  factualErrors: number;
  passed: boolean;
  reasons: string[];
}

interface OperatorPilotAuthorizationV2 {
  kind: "pixymon-operator-pilot-authorization";
  stage: "R3-pilot";
  scope: "protocol-originals";
  epoch: string;
  operatorId: string;
  commit: string;
  issuedAt: string;
  expiresAt: string;
  shadowLedgerPath: string;
  evidence: OperatorPilotEvidenceV2;
}

const tags = (values: readonly string[]) => new Set(values.map((tag) => tag.trim().toLowerCase()).filter(Boolean));

/** Counts only the current epoch's shadow drafts, so evidence about an older writer never carries over. */
export function evaluateOperatorPilotEvidenceV2(states: readonly EditorialDraftStateV2[]): OperatorPilotEvidenceV2 {
  const epochDrafts = states.filter((state) => state.draft.trackingMode === "shadow" &&
    state.draft.collectionEpoch === EDITORIAL_COLLECTION_EPOCH_V2);
  const reviewed = epochDrafts.filter((state) => state.reviewStatus === "approved" || state.reviewStatus === "rejected");
  // An edit records as approved; the last review must carry the operator's fact check.
  const approvedFactChecked = reviewed.filter((state) => state.reviewStatus === "approved" &&
    tags(state.reviews.at(-1)?.reasonTags ?? []).has(EDITORIAL_FACT_CHECKED_TAG_V2));
  const factualErrors = epochDrafts.filter((state) => state.reviews.some((review) =>
    [...tags(review.reasonTags)].some((tag) => EDITORIAL_FACT_ERROR_TAGS_V2.has(tag))));
  const reasons = [
    ...(approvedFactChecked.length < OPERATOR_PILOT_MIN_APPROVED_FACT_CHECKED_V2
      ? [`fact-checked approvals ${approvedFactChecked.length}/${OPERATOR_PILOT_MIN_APPROVED_FACT_CHECKED_V2}`] : []),
    ...(factualErrors.length > 0 ? [`factual errors ${factualErrors.length} (must be 0)`] : []),
  ];
  return { epoch: EDITORIAL_COLLECTION_EPOCH_V2, reviewed: reviewed.length, approvedFactChecked: approvedFactChecked.length,
    factualErrors: factualErrors.length, passed: reasons.length === 0, reasons };
}

/** The one shadow ledger the evidence may come from; never a path chosen at issuance. */
export function canonicalShadowLedgerPathV2(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(resolveEditorialRuntimePathsV2("observe", { ...env, EDITORIAL_TRACKING_MODE: "shadow" }).eventLogPath);
}

function loadShadowStates(shadowLedgerPath: string): EditorialDraftStateV2[] {
  return new EditorialEventStoreV2({ eventLogPath: shadowLedgerPath }).listDraftStates();
}

export function writeOperatorPilotAuthorizationV2(input: {
  outputPath: string; operatorId: string; commit: string; now?: Date;
  /** Tests only; production always uses the canonical shadow ledger. */
  shadowLedgerPath?: string;
  loadStates?: (shadowLedgerPath: string) => readonly EditorialDraftStateV2[];
}): OperatorPilotEvidenceV2 {
  const now = input.now ?? new Date();
  if (!input.operatorId.trim()) throw new Error("operator identity is required");
  const shadowLedgerPath = path.resolve(input.shadowLedgerPath ?? canonicalShadowLedgerPathV2());
  const evidence = evaluateOperatorPilotEvidenceV2((input.loadStates ?? loadShadowStates)(shadowLedgerPath));
  if (!evidence.passed) throw new Error(`operator-pilot-not-earned: ${evidence.reasons.join(", ")}`);
  const record: OperatorPilotAuthorizationV2 = {
    kind: "pixymon-operator-pilot-authorization", stage: "R3-pilot", scope: "protocol-originals",
    epoch: EDITORIAL_COLLECTION_EPOCH_V2, operatorId: input.operatorId.trim(), commit: input.commit,
    issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + DAY_MS).toISOString(), shadowLedgerPath, evidence,
  };
  fs.mkdirSync(path.dirname(path.resolve(input.outputPath)), { recursive: true });
  fs.writeFileSync(input.outputPath, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return evidence;
}

export function isOperatorPilotAuthorizationV2(record: unknown): boolean {
  return (record as { kind?: unknown })?.kind === "pixymon-operator-pilot-authorization";
}

/** Re-derives the evidence at the dispatch boundary: a factual-error tag added after issuance blocks sending. */
export function assertOperatorPilotAuthorizationV2(record: unknown, input: {
  commit: string; now?: Date;
  /** Tests only; production always re-reads the canonical shadow ledger. */
  shadowLedgerPath?: string;
  loadStates?: (shadowLedgerPath: string) => readonly EditorialDraftStateV2[];
}): void {
  const value = record as Partial<OperatorPilotAuthorizationV2>;
  const nowMs = (input.now ?? new Date()).getTime();
  const shadowLedgerPath = path.resolve(input.shadowLedgerPath ?? canonicalShadowLedgerPathV2());
  const issuedMs = Date.parse(String(value.issuedAt));
  const expiryMs = Date.parse(String(value.expiresAt));
  if (value.kind !== "pixymon-operator-pilot-authorization" || value.stage !== "R3-pilot" ||
      value.scope !== "protocol-originals" || value.epoch !== EDITORIAL_COLLECTION_EPOCH_V2 ||
      value.commit !== input.commit || typeof value.operatorId !== "string" || !value.operatorId.trim() ||
      value.shadowLedgerPath !== shadowLedgerPath || !Number.isFinite(nowMs) ||
      !Number.isFinite(issuedMs) || !Number.isFinite(expiryMs) || issuedMs > nowMs || expiryMs <= nowMs ||
      expiryMs - issuedMs > DAY_MS) {
    throw new Error("operator-pilot-authorization-invalid-or-expired");
  }
  const evidence = evaluateOperatorPilotEvidenceV2((input.loadStates ?? loadShadowStates)(shadowLedgerPath));
  if (!evidence.passed) throw new Error(`operator-pilot-evidence-lost: ${evidence.reasons.join(", ")}`);
}
