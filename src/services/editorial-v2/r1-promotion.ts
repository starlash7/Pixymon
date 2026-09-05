import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;

export const EDITORIAL_R1_REQUIRED_CHECK_IDS_V2 = [
  "r0-prerequisite",
  "runtime-logs",
  "no-future-records",
  "observe-decisions",
  "observe-days",
  "observe-elapsed-time",
  "known-non-live-write-incidents",
  "non-live-write-audit",
  "telemetry-links",
  "fallback-incidents",
  "fallback-telemetry-complete",
] as const;

export interface EditorialR1ObserveWindowV2 {
  readonly decisionCount: number;
  readonly distinctDays: number;
  readonly firstAt: string;
  readonly lastAt: string;
  readonly elapsedMs: number;
}

export interface EditorialR1PromotionArtifactV2 {
  readonly schemaVersion: 2;
  readonly kind: "pixymon-v2-r1-promotion";
  readonly sourceStatus: {
    readonly sha256: string;
    readonly bytes: number;
    readonly generatedAt: string;
  };
  readonly repository: {
    readonly commit: string;
    readonly clean: true;
  };
  readonly promotedAt: string;
  readonly observeWindow: EditorialR1ObserveWindowV2;
}

export interface WriteNewEditorialR1PromotionInputV2 {
  readonly statusPath: string;
  readonly outputPath: string;
  readonly repositoryRoot?: string;
  readonly now?: Date;
}

export interface VerifyEditorialR1PromotionInputV2 {
  readonly statusPath: string;
  readonly promotionPath: string;
  readonly repositoryRoot?: string;
  readonly now?: Date;
}

export interface VerifiedEditorialR1BoundaryV2 {
  readonly boundaryAt: string;
  readonly currentCommit: string;
  readonly sourceStatusSha256: string;
  readonly statusGeneratedAt: string;
  readonly observeWindow: EditorialR1ObserveWindowV2;
}

type JsonRecord = Record<string, unknown>;

interface ParsedR1Status {
  generatedAt: string;
  commit: string;
  observeWindow: EditorialR1ObserveWindowV2;
}

interface RepositoryState {
  commit: string;
  clean: boolean;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, field: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  return value;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    throw new Error(`${field} must be a non-empty trimmed string`);
  }
  return value;
}

function instant(value: unknown, field: string): string {
  const text = requiredText(value, field);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${field} must be a valid instant`);
  return text;
}

function nonnegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${field} must be a nonnegative safe integer`);
  }
  return Number(value);
}

function requireFields(value: JsonRecord, fields: readonly string[], field: string): void {
  const missing = fields.filter((name) => !Object.hasOwn(value, name));
  if (missing.length > 0) throw new Error(`${field} is incomplete: ${missing.join(",")}`);
}

function onlyFields(value: JsonRecord, fields: readonly string[], field: string): void {
  const extras = Object.keys(value).filter((name) => !fields.includes(name));
  if (extras.length > 0) throw new Error(`${field} has unsupported fields: ${extras.join(",")}`);
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function readJsonFile(filePath: string, field: string): { raw: Buffer; value: unknown } {
  const target = path.resolve(requiredText(filePath, `${field} path`));
  const raw = fs.readFileSync(target);
  try {
    return { raw, value: JSON.parse(raw.toString("utf8")) as unknown };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${field} is not valid JSON: ${message}`);
  }
}

function parseGate(value: unknown, field: string): {
  earned: boolean;
  checks: readonly JsonRecord[];
} {
  const gate = record(value, field);
  requireFields(gate, ["earned", "checks"], field);
  if (typeof gate.earned !== "boolean") throw new Error(`${field}.earned must be boolean`);
  if (!Array.isArray(gate.checks) || gate.checks.length === 0) {
    throw new Error(`${field}.checks must be a non-empty array`);
  }
  const checks = gate.checks.map((value, index) => {
    const check = record(value, `${field}.checks[${index}]`);
    requireFields(check, ["id", "state", "observed", "required"], `${field}.checks[${index}]`);
    requiredText(check.id, `${field}.checks[${index}].id`);
    if (!['pass', 'fail', 'unknown'].includes(String(check.state))) {
      throw new Error(`${field}.checks[${index}].state is invalid`);
    }
    requiredText(check.required, `${field}.checks[${index}].required`);
    return check;
  });
  const allPass = checks.every((check) => check.state === "pass");
  if (gate.earned !== allPass) throw new Error(`${field}.earned is inconsistent with its checks`);
  return { earned: gate.earned, checks };
}

function parseCompleteEarnedR1Status(value: unknown): ParsedR1Status {
  const status = record(value, "rollout status");
  requireFields(status, [
    "schemaVersion",
    "kind",
    "generatedAt",
    "timezone",
    "manualPromotionRequired",
    "highestEvidenceStage",
    "repository",
    "dataIntegrity",
    "counts",
    "windows",
    "rates",
    "gates",
  ], "rollout status");
  if (status.schemaVersion !== 2 || status.kind !== "pixymon-v2-rollout-status") {
    throw new Error("unsupported rollout status schema");
  }
  const generatedAt = instant(status.generatedAt, "rollout status.generatedAt");
  const repository = record(status.repository, "rollout status.repository");
  const commit = requiredText(repository.currentCommit, "rollout status.repository.currentCommit");
  if (repository.verificationTreeClean !== true) {
    throw new Error("rollout status verification tree is not clean");
  }
  requiredText(status.timezone, "rollout status.timezone");
  if (status.manualPromotionRequired !== true) {
    throw new Error("rollout status.manualPromotionRequired must be true");
  }
  if (!['r1', 'r2'].includes(String(status.highestEvidenceStage))) {
    throw new Error("rollout status does not identify R1 as earned");
  }

  const dataIntegrity = record(status.dataIntegrity, "rollout status.dataIntegrity");
  requireFields(dataIntegrity, [
    "eventLogPresent",
    "metricLogPresent",
    "futureEventCount",
    "futureMetricCount",
    "draftWithoutGenerationMetricCount",
    "reviewedDraftWithoutReviewMetricCount",
    "publicationWithoutLiveMetricCount",
    "generationAttemptWithoutFallbackFlagCount",
    "finalApprovedContractFailureCount",
    "replayArtifactVerified",
    "replayArtifactSha256",
    "replaySourceLedgerSha256",
    "replaySourceLedgerBytes",
    "replaySourceEventCount",
    "replaySourceDraftCount",
  ], "rollout status.dataIntegrity");

  const counts = record(status.counts, "rollout status.counts");
  const countFields = [
    "exportableGeneratedDrafts",
    "observeDecisions",
    "reviewedDrafts",
    "approvedDrafts",
    "editedDrafts",
    "rejectedDrafts",
    "noEditApprovedDrafts",
    "factCheckedDrafts",
    "observedFactualErrors",
    "observedMalformedErrors",
    "observedFallbackIncidents",
    "observedNonLiveWriteIncidents",
  ] as const;
  requireFields(counts, countFields, "rollout status.counts");
  for (const field of countFields) nonnegativeInteger(counts[field], `rollout status.counts.${field}`);

  const windows = record(status.windows, "rollout status.windows");
  requireFields(windows, [
    "observeDecisionDays",
    "observeFirstAt",
    "observeLastAt",
    "reviewDays",
    "reviewFirstAt",
    "reviewLastAt",
  ], "rollout status.windows");
  const distinctDays = nonnegativeInteger(
    windows.observeDecisionDays,
    "rollout status.windows.observeDecisionDays"
  );
  const firstAt = instant(windows.observeFirstAt, "rollout status.windows.observeFirstAt");
  const lastAt = instant(windows.observeLastAt, "rollout status.windows.observeLastAt");
  const firstMs = Date.parse(firstAt);
  const lastMs = Date.parse(lastAt);
  const generatedMs = Date.parse(generatedAt);
  if (firstMs > lastMs) throw new Error("rollout status observe window is inverted");
  if (lastMs > generatedMs) throw new Error("rollout status observe window ends after generatedAt");

  const rates = record(status.rates, "rollout status.rates");
  requireFields(rates, [
    "approvalRate",
    "noEditAcceptanceRate",
    "observedFactualErrorRate",
    "observedMalformedErrorRate",
  ], "rollout status.rates");

  const gates = record(status.gates, "rollout status.gates");
  requireFields(gates, ["r0", "r1", "r2"], "rollout status.gates");
  const r0 = parseGate(gates.r0, "rollout status.gates.r0");
  const r1 = parseGate(gates.r1, "rollout status.gates.r1");
  parseGate(gates.r2, "rollout status.gates.r2");
  if (!r0.earned) throw new Error("rollout status R0 prerequisite is not earned");
  if (!r1.earned || r1.checks.some((check) => check.state !== "pass")) {
    throw new Error("rollout status R1 gate is not fully earned");
  }
  const checkIds = r1.checks.map((check) => String(check.id));
  if (new Set(checkIds).size !== checkIds.length) {
    throw new Error("rollout status R1 checks contain duplicate ids");
  }
  const missingChecks = EDITORIAL_R1_REQUIRED_CHECK_IDS_V2.filter((id) => !checkIds.includes(id));
  if (missingChecks.length > 0) {
    throw new Error(`rollout status R1 checks are incomplete: ${missingChecks.join(",")}`);
  }

  const decisionCount = nonnegativeInteger(
    counts.observeDecisions,
    "rollout status.counts.observeDecisions"
  );
  const elapsedMs = lastMs - firstMs;
  if (decisionCount < 30 || distinctDays < 7 || elapsedMs < 7 * DAY_MS) {
    throw new Error("rollout status observe window does not meet the R1 minimum");
  }
  const observedById = new Map(r1.checks.map((check) => [String(check.id), check.observed]));
  if (
    observedById.get("observe-decisions") !== decisionCount ||
    observedById.get("observe-days") !== distinctDays ||
    observedById.get("observe-elapsed-time") !== elapsedMs
  ) {
    throw new Error("rollout status observe summary disagrees with its R1 checks");
  }
  return {
    generatedAt,
    commit,
    observeWindow: { decisionCount, distinctDays, firstAt, lastAt, elapsedMs },
  };
}

function parsePromotionArtifact(value: unknown): EditorialR1PromotionArtifactV2 {
  const artifact = record(value, "R1 promotion artifact");
  const artifactFields = [
    "schemaVersion",
    "kind",
    "sourceStatus",
    "repository",
    "promotedAt",
    "observeWindow",
  ] as const;
  requireFields(artifact, artifactFields, "R1 promotion artifact");
  onlyFields(artifact, artifactFields, "R1 promotion artifact");
  if (artifact.schemaVersion !== 2 || artifact.kind !== "pixymon-v2-r1-promotion") {
    throw new Error("unsupported R1 promotion artifact schema");
  }

  const source = record(artifact.sourceStatus, "R1 promotion artifact.sourceStatus");
  onlyFields(source, ["sha256", "bytes", "generatedAt"], "R1 promotion artifact.sourceStatus");
  const sourceSha256 = requiredText(source.sha256, "R1 promotion artifact.sourceStatus.sha256");
  if (!/^[a-f0-9]{64}$/.test(sourceSha256)) {
    throw new Error("R1 promotion artifact.sourceStatus.sha256 must be SHA-256 hex");
  }
  const sourceBytes = nonnegativeInteger(source.bytes, "R1 promotion artifact.sourceStatus.bytes");
  const sourceGeneratedAt = instant(
    source.generatedAt,
    "R1 promotion artifact.sourceStatus.generatedAt"
  );

  const repository = record(artifact.repository, "R1 promotion artifact.repository");
  onlyFields(repository, ["commit", "clean"], "R1 promotion artifact.repository");
  const commit = requiredText(repository.commit, "R1 promotion artifact.repository.commit");
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) {
    throw new Error("R1 promotion artifact.repository.commit must be a full Git object id");
  }
  if (repository.clean !== true) throw new Error("R1 promotion artifact.repository.clean must be true");

  const promotedAt = instant(artifact.promotedAt, "R1 promotion artifact.promotedAt");
  const window = record(artifact.observeWindow, "R1 promotion artifact.observeWindow");
  onlyFields(
    window,
    ["decisionCount", "distinctDays", "firstAt", "lastAt", "elapsedMs"],
    "R1 promotion artifact.observeWindow"
  );
  const observeWindow: EditorialR1ObserveWindowV2 = {
    decisionCount: nonnegativeInteger(
      window.decisionCount,
      "R1 promotion artifact.observeWindow.decisionCount"
    ),
    distinctDays: nonnegativeInteger(
      window.distinctDays,
      "R1 promotion artifact.observeWindow.distinctDays"
    ),
    firstAt: instant(window.firstAt, "R1 promotion artifact.observeWindow.firstAt"),
    lastAt: instant(window.lastAt, "R1 promotion artifact.observeWindow.lastAt"),
    elapsedMs: nonnegativeInteger(window.elapsedMs, "R1 promotion artifact.observeWindow.elapsedMs"),
  };
  return {
    schemaVersion: 2,
    kind: "pixymon-v2-r1-promotion",
    sourceStatus: { sha256: sourceSha256, bytes: sourceBytes, generatedAt: sourceGeneratedAt },
    repository: { commit, clean: true },
    promotedAt,
    observeWindow,
  };
}

function repositoryState(repositoryRoot: string): RepositoryState {
  const root = path.resolve(repositoryRoot);
  try {
    const commit = execFileSync("git", ["-C", root, "rev-parse", "--verify", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim().toLowerCase();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) {
      throw new Error("HEAD is not a full Git object id");
    }
    const dirty = execFileSync(
      "git",
      ["-C", root, "status", "--porcelain=v1", "--untracked-files=all"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    ).length > 0;
    return { commit, clean: !dirty };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`unable to read repository state: ${message}`);
  }
}

function cleanStableRepositoryState(repositoryRoot: string, before?: RepositoryState): RepositoryState {
  const current = repositoryState(repositoryRoot);
  if (!current.clean) throw new Error("repository working tree is dirty");
  if (before && before.commit !== current.commit) {
    throw new Error("repository commit changed while reading promotion evidence");
  }
  return current;
}

function validNow(now: Date | undefined): Date {
  const value = now ?? new Date();
  if (!Number.isFinite(value.getTime())) throw new Error("R1 promotion clock is invalid");
  return value;
}

function assertChronology(
  status: ParsedR1Status,
  promotedAt: string,
  now: Date
): void {
  const statusMs = Date.parse(status.generatedAt);
  const promotedMs = Date.parse(promotedAt);
  if (statusMs > promotedMs) throw new Error("R1 promotion predates its source status");
  if (promotedMs > now.getTime()) throw new Error("R1 promotion is from the future");
}

function sameObserveWindow(
  left: EditorialR1ObserveWindowV2,
  right: EditorialR1ObserveWindowV2
): boolean {
  return left.decisionCount === right.decisionCount &&
    left.distinctDays === right.distinctDays &&
    left.firstAt === right.firstAt &&
    left.lastAt === right.lastAt &&
    left.elapsedMs === right.elapsedMs;
}

export function writeNewEditorialR1PromotionV2(
  input: WriteNewEditorialR1PromotionInputV2
): string {
  const now = validNow(input.now);
  const repositoryRoot = input.repositoryRoot ?? process.cwd();
  const before = cleanStableRepositoryState(repositoryRoot);
  const source = readJsonFile(input.statusPath, "rollout status");
  const status = parseCompleteEarnedR1Status(source.value);
  assertChronology(status, now.toISOString(), now);
  const current = cleanStableRepositoryState(repositoryRoot, before);
  if (status.commit !== current.commit) {
    throw new Error("source status commit does not match current HEAD");
  }
  const artifact: EditorialR1PromotionArtifactV2 = {
    schemaVersion: 2,
    kind: "pixymon-v2-r1-promotion",
    sourceStatus: {
      sha256: sha256(source.raw),
      bytes: source.raw.byteLength,
      generatedAt: status.generatedAt,
    },
    repository: { commit: current.commit, clean: true },
    promotedAt: now.toISOString(),
    observeWindow: status.observeWindow,
  };

  const target = path.resolve(requiredText(input.outputPath, "R1 promotion output path"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(artifact, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return target;
}

export function verifyEditorialR1PromotionV2(
  input: VerifyEditorialR1PromotionInputV2
): VerifiedEditorialR1BoundaryV2 {
  const now = validNow(input.now);
  const repositoryRoot = input.repositoryRoot ?? process.cwd();
  const before = cleanStableRepositoryState(repositoryRoot);
  const promotion = parsePromotionArtifact(
    readJsonFile(input.promotionPath, "R1 promotion artifact").value
  );
  const source = readJsonFile(input.statusPath, "rollout status");
  const status = parseCompleteEarnedR1Status(source.value);
  const current = cleanStableRepositoryState(repositoryRoot, before);

  if (status.commit !== current.commit) {
    throw new Error("source status commit does not match current HEAD");
  }
  if (current.commit !== promotion.repository.commit) {
    throw new Error("R1 promotion commit does not match current HEAD");
  }
  if (source.raw.byteLength !== promotion.sourceStatus.bytes) {
    throw new Error("R1 promotion source status byte length does not match");
  }
  if (sha256(source.raw) !== promotion.sourceStatus.sha256) {
    throw new Error("R1 promotion source status SHA-256 does not match");
  }
  if (status.generatedAt !== promotion.sourceStatus.generatedAt) {
    throw new Error("R1 promotion source status generatedAt does not match");
  }
  if (!sameObserveWindow(status.observeWindow, promotion.observeWindow)) {
    throw new Error("R1 promotion observe window does not match its source status");
  }
  assertChronology(status, promotion.promotedAt, now);

  return {
    boundaryAt: promotion.promotedAt,
    currentCommit: current.commit,
    sourceStatusSha256: promotion.sourceStatus.sha256,
    statusGeneratedAt: status.generatedAt,
    observeWindow: { ...promotion.observeWindow },
  };
}
