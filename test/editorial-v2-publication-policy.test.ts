import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { buildEditorialRolloutStatusV2 } from "../src/services/editorial-v2/rollout-status.ts";
import { assertApprovedLiveStatusV2, assertApprovedLiveAuthorizationV2, writeApprovedLiveAuthorizationV2 } from "../src/services/editorial-v2/publication-policy.ts";

const NOW = new Date("2026-09-05T00:00:00Z");
const COMMIT = "a".repeat(40);
function statusFixture() {
  const status = buildEditorialRolloutStatusV2({
    events: [], metrics: [], eventLogPresent: true, metricLogPresent: true,
    now: NOW, currentCommit: COMMIT, workingTreeClean: true,
  });
  // Fabricated status for policy-unit tests only; never operational evidence.
  for (const gate of Object.values(status.gates)) {
    gate.earned = true;
    gate.checks = gate.checks.map((check) => ({ ...check, state: "pass" as const }));
  }
  return status;
}

for (const stage of ["r0", "r1", "r2"] as const) {
  test(`R3 refuses missing, failed, unknown or empty ${stage} evidence`, () => {
    for (const state of ["fail", "unknown"] as const) {
      const status = statusFixture();
      status.gates[stage].checks[0].state = state;
      assert.throws(() => assertApprovedLiveStatusV2(status, COMMIT), /not-earned/);
    }
    const status = statusFixture();
    status.gates[stage].checks = [];
    assert.throws(() => assertApprovedLiveStatusV2(status, COMMIT), /not-earned/);
  });
}

test("approved live authority is create-only, commit-bound, expiring, and independently suspendable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-approved-live-"));
  try {
    const statusPath = path.join(dir, "status.json");
    const authorizationPath = path.join(dir, "authorization.json");
    const stopPath = path.join(dir, "STOP");
    fs.writeFileSync(statusPath, JSON.stringify(statusFixture()));
    const issue = { statusPath, outputPath: authorizationPath, operatorId: "operator", commit: COMMIT, now: NOW };
    writeApprovedLiveAuthorizationV2(issue);
    assert.throws(() => writeApprovedLiveAuthorizationV2(issue), /EEXIST/);
    const input = { authorizationPath, stopPath, commit: COMMIT, workingTreeClean: true, now: NOW };
    assert.doesNotThrow(() => assertApprovedLiveAuthorizationV2(input));
    assert.throws(() => assertApprovedLiveAuthorizationV2({ ...input, commit: "b".repeat(40) }), /invalid-or-expired/);
    assert.throws(() => assertApprovedLiveAuthorizationV2({ ...input, workingTreeClean: false }), /tree-dirty/);
    assert.throws(() => assertApprovedLiveAuthorizationV2({ ...input, now: new Date(NOW.getTime() + 86_400_000) }), /invalid-or-expired/);
    fs.writeFileSync(stopPath, "suspended");
    assert.throws(() => assertApprovedLiveAuthorizationV2(input), /suspended/);
    fs.unlinkSync(stopPath);
    fs.appendFileSync(statusPath, " ");
    assert.throws(() => assertApprovedLiveAuthorizationV2(input), /status-changed/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("offline bootstrap does not depend on live Revisit quality evidence", () => {
  const status = buildEditorialRolloutStatusV2({ events: [], metrics: [], now: NOW });
  assert.equal(status.gates.r0.checks.some((check) => check.id === "real-replay"), false);
  assert.equal(status.gates.r2.checks.find((check) => check.id === "real-replay")?.state, "unknown");
  assert.equal(status.gates.r2.checks.find((check) => check.id === "two-reader-blind-evaluation")?.state, "unknown");
});
