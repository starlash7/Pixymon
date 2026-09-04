import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendEditorialMetricV2, buildEditorialMetricV2 } from "../src/services/editorial-v2/telemetry.ts";

test("editorial V2 telemetry links one decision chain and persists ndjson", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-editorial-metric-"));
  const target = path.join(dir, "events.ndjson");
  const event = buildEditorialMetricV2(
    {
      runId: "run-1",
      actionId: "action-1",
      mode: "observe",
      now: new Date("2026-08-28T00:00:00.000Z"),
    },
    {
      type: "planning_decision",
      stage: "eligibility",
      outcome: "blocked",
      reason: "no-tier-a-evidence",
      details: { candidateCount: 0 },
    }
  );

  appendEditorialMetricV2(target, event);
  const rows = fs.readFileSync(target, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(rows, [event]);
});
test("editorial V2 telemetry rejects an empty path instead of failing silently", () => {
  const event = buildEditorialMetricV2(
    { runId: "run-2", actionId: "action-2", mode: "paper" },
    { type: "dispatch_decision", stage: "dispatch", outcome: "skipped" }
  );
  assert.throws(() => appendEditorialMetricV2("", event), /editorial-metric-path-missing/);
});
