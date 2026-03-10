import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { LlmBatchRunsService } from "../src/services/llm-batch-runs.ts";

function withTempRuns(run: (runsPath: string) => void): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-llm-batch-runs-"));
  try {
    run(path.join(tempDir, "llm-batch-runs.json"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("llm batch runs records submitted batch and persists sync state", () => {
  withTempRuns((runsPath) => {
    const service = new LlmBatchRunsService({ runsPath });
    service.recordSubmittedBatch(
      {
        id: "msgbatch_001",
        created_at: "2026-03-10T00:00:00.000Z",
        processing_status: "in_progress",
        ended_at: null,
        expires_at: "2026-03-11T00:00:00.000Z",
        results_url: null,
        request_counts: {
          processing: 2,
          succeeded: 0,
          errored: 0,
          canceled: 0,
          expired: 0,
        },
      },
      ["job_1", "job_2"]
    );

    const reloaded = new LlmBatchRunsService({ runsPath });
    assert.deepEqual(reloaded.getStats(), {
      active: 1,
      endedPendingResults: 0,
      endedApplied: 0,
      total: 1,
    });
    assert.equal(reloaded.getSyncCandidates(0, 5).length, 1);
  });
});

test("llm batch runs tracks ended batch until results are applied", () => {
  withTempRuns((runsPath) => {
    const service = new LlmBatchRunsService({ runsPath });
    service.recordSubmittedBatch(
      {
        id: "msgbatch_ended",
        created_at: "2026-03-10T00:00:00.000Z",
        processing_status: "ended",
        ended_at: "2026-03-10T00:10:00.000Z",
        expires_at: "2026-03-11T00:00:00.000Z",
        results_url: "https://example.com/results.jsonl",
        request_counts: {
          processing: 0,
          succeeded: 1,
          errored: 0,
          canceled: 0,
          expired: 0,
        },
      },
      ["job_1"]
    );

    assert.equal(service.getSyncCandidates(0, 5).length, 1);
    assert.equal(service.markResultsApplied("msgbatch_ended"), true);
    assert.deepEqual(service.getStats(), {
      active: 0,
      endedPendingResults: 0,
      endedApplied: 1,
      total: 1,
    });
    assert.equal(service.getSyncCandidates(0, 5).length, 0);
  });
});
