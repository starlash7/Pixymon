import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { buildDigestReflectionJob } from "../src/services/llm-batch.ts";
import { LlmBatchQueueService } from "../src/services/llm-batch-queue.ts";

function withTempQueue(run: (queuePath: string) => void): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-llm-batch-queue-"));
  try {
    run(path.join(tempDir, "llm-batch-queue.json"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function buildSampleJob(summary: string) {
  return buildDigestReflectionJob({
    language: "ko",
    lane: "onchain",
    summary,
    acceptedNutrients: [
      { label: "고래 활동", value: "+18%", source: "onchain" },
      { label: "스테이블 유입", value: "+$92M", source: "market" },
    ],
    rejectReasons: ["stale-signal"],
    xpGainTotal: 11,
    evolvedCount: 1,
    maxChars: 220,
  });
}

test("llm batch queue enqueues once and dedupes by customId", () => {
  withTempQueue((queuePath) => {
    const service = new LlmBatchQueueService({ queuePath });
    const job = buildSampleJob("고래가 먼저 움직인 날");

    const first = service.enqueue(job);
    const second = service.enqueue(job);

    assert.equal(first.status, "queued");
    assert.equal(second.status, "duplicate");
    assert.equal(service.getPendingJobs().length, 1);
    assert.deepEqual(service.getQueueStats(), {
      pending: 1,
      submitted: 0,
      completed: 0,
      failed: 0,
      total: 1,
    });
  });
});

test("llm batch queue persists submission and completion state", () => {
  withTempQueue((queuePath) => {
    const service = new LlmBatchQueueService({ queuePath });
    const jobA = buildSampleJob("첫 번째 digest");
    const jobB = buildSampleJob("두 번째 digest");

    service.enqueue(jobA);
    service.enqueue(jobB);

    assert.equal(service.markSubmitted([jobA.customId], "batch_001"), 1);
    assert.equal(service.markCompleted(jobA.customId, "remote-finished"), true);

    const reloaded = new LlmBatchQueueService({ queuePath });
    assert.equal(reloaded.getPendingJobs().length, 1);
    assert.equal(reloaded.getPendingJobs()[0]?.customId, jobB.customId);
    assert.deepEqual(reloaded.getQueueStats(), {
      pending: 1,
      submitted: 0,
      completed: 1,
      failed: 0,
      total: 2,
    });
  });
});

test("llm batch queue resets corrupt json to empty state", () => {
  withTempQueue((queuePath) => {
    const previous = process.env.SESSION_QUARANTINE_ON_PARSE_ERROR;
    process.env.SESSION_QUARANTINE_ON_PARSE_ERROR = "false";
    try {
      fs.mkdirSync(path.dirname(queuePath), { recursive: true });
      fs.writeFileSync(queuePath, "{not-json", "utf-8");

      const service = new LlmBatchQueueService({ queuePath });
      assert.deepEqual(service.getQueueStats(), {
        pending: 0,
        submitted: 0,
        completed: 0,
        failed: 0,
        total: 0,
      });

      const persisted = JSON.parse(fs.readFileSync(queuePath, "utf-8")) as { schemaVersion?: number; jobs?: unknown[] };
      assert.equal(persisted.schemaVersion, 1);
      assert.deepEqual(persisted.jobs, []);
    } finally {
      if (typeof previous === "undefined") {
        delete process.env.SESSION_QUARANTINE_ON_PARSE_ERROR;
      } else {
        process.env.SESSION_QUARANTINE_ON_PARSE_ERROR = previous;
      }
    }
  });
});
