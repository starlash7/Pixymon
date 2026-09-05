import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  EDITORIAL_R1_REQUIRED_CHECK_IDS_V2,
  verifyEditorialR1PromotionV2,
  writeNewEditorialR1PromotionV2,
} from "../src/services/editorial-v2/r1-promotion.ts";
import { buildEditorialRolloutStatusV2 } from "../src/services/editorial-v2/rollout-status.ts";

const DAY = 86_400_000;
const START = "2026-08-01T00:00:00.000Z";
const END = "2026-08-08T00:00:00.000Z";
const PROMOTED = new Date("2026-08-09T00:00:00.000Z");

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-r1-promotion-"));
  const repositoryRoot = path.join(directory, "repository");
  fs.mkdirSync(repositoryRoot);
  const git = (...args: string[]) => execFileSync("git", ["-C", repositoryRoot, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  git("init", "--quiet");
  fs.writeFileSync(path.join(repositoryRoot, "fixture.txt"), "fixture\n");
  git("add", "fixture.txt");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture");
  const commit = git("rev-parse", "HEAD");
  // Synthetic gate results only exercise the artifact contract; they are never
  // exported to the project's runtime data or used to claim operational R1.
  const status = buildEditorialRolloutStatusV2({
    events: [], metrics: [], eventLogPresent: true, metricLogPresent: true,
    now: new Date(END), currentCommit: commit, workingTreeClean: true,
  });
  status.highestEvidenceStage = "r1";
  status.gates.r0 = { earned: true, checks: [{ id: "verified-current-tree", state: "pass", observed: true, required: "fixture" }] };
  status.counts.observeDecisions = 30;
  status.windows.observeDecisionDays = 8;
  status.windows.observeFirstAt = START;
  status.windows.observeLastAt = END;
  status.gates.r1 = {
    earned: true,
    checks: EDITORIAL_R1_REQUIRED_CHECK_IDS_V2.map((id) => ({
      id, state: "pass", required: "fixture",
      observed: id === "observe-decisions" ? 30 : id === "observe-days" ? 8 : id === "observe-elapsed-time" ? 7 * DAY : 0,
    })),
  };
  const statusPath = path.join(directory, "status.json");
  const outputPath = path.join(directory, "promotion.json");
  const writeStatus = () => fs.writeFileSync(statusPath, JSON.stringify(status));
  writeStatus();
  return { directory, repositoryRoot, statusPath, outputPath, status, writeStatus, git };
}

test("manual R1 artifact binds the source status, clean commit, and immutable boundary", () => {
  const f = fixture();
  try {
    writeNewEditorialR1PromotionV2({ ...f, now: PROMOTED });
    const verified = verifyEditorialR1PromotionV2({ ...f, promotionPath: f.outputPath, now: PROMOTED });
    assert.equal(verified.boundaryAt, PROMOTED.toISOString());
    assert.equal(verified.currentCommit, f.git("rev-parse", "HEAD"));
    assert.equal(verified.observeWindow.elapsedMs, 7 * DAY);
    assert.throws(() => writeNewEditorialR1PromotionV2({ ...f, now: PROMOTED }), /EEXIST/);
    fs.appendFileSync(f.statusPath, " ");
    assert.throws(() => verifyEditorialR1PromotionV2({ ...f, promotionPath: f.outputPath, now: PROMOTED }), /byte length|SHA-256/);
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test("manual promotion rejects incomplete gates, stale source commits, and future statuses", () => {
  for (const failure of ["missing-check", "failed-check", "stale-commit", "future"] as const) {
    const f = fixture();
    try {
      if (failure === "missing-check") f.status.gates.r1.checks = f.status.gates.r1.checks.slice(1);
      if (failure === "failed-check") f.status.gates.r1.checks[0].state = "unknown";
      if (failure === "stale-commit") f.status.repository.currentCommit = "a".repeat(40);
      if (failure === "future") f.status.generatedAt = "2026-08-10T00:00:00.000Z";
      f.writeStatus();
      assert.throws(() => writeNewEditorialR1PromotionV2({ ...f, now: PROMOTED }), /incomplete|inconsistent|current HEAD|predates/);
      assert.equal(fs.existsSync(f.outputPath), false);
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
  }
});

test("promotion verification rejects edited boundaries, dirty trees, and newer commits", () => {
  const f = fixture();
  try {
    writeNewEditorialR1PromotionV2({ ...f, now: PROMOTED });
    const original = fs.readFileSync(f.outputPath, "utf8");
    const artifact = JSON.parse(original);
    artifact.promotedAt = "2026-08-07T00:00:00.000Z";
    fs.writeFileSync(f.outputPath, JSON.stringify(artifact));
    assert.throws(() => verifyEditorialR1PromotionV2({ ...f, promotionPath: f.outputPath, now: PROMOTED }), /predates/);
    artifact.promotedAt = "2026-08-10T00:00:00.000Z";
    fs.writeFileSync(f.outputPath, JSON.stringify(artifact));
    assert.throws(() => verifyEditorialR1PromotionV2({ ...f, promotionPath: f.outputPath, now: PROMOTED }), /future/);
    fs.writeFileSync(f.outputPath, original);
    fs.appendFileSync(path.join(f.repositoryRoot, "fixture.txt"), "changed\n");
    assert.throws(() => verifyEditorialR1PromotionV2({ ...f, promotionPath: f.outputPath, now: PROMOTED }), /dirty/);
    f.git("add", "fixture.txt");
    f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "change");
    assert.throws(() => verifyEditorialR1PromotionV2({ ...f, promotionPath: f.outputPath, now: PROMOTED }), /current HEAD/);
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});
