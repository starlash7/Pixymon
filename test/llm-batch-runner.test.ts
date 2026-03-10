import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { buildDigestReflectionJob } from "../src/services/llm-batch.ts";
import { LlmBatchQueueService } from "../src/services/llm-batch-queue.ts";
import { submitPendingLlmBatch, syncLlmBatchRuns } from "../src/services/llm-batch-runner.ts";
import { LlmBatchRunsService } from "../src/services/llm-batch-runs.ts";

function withTempBatchState(
  run: (queue: LlmBatchQueueService, runs: LlmBatchRunsService, jobCustomId: string) => Promise<void> | void
): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-llm-batch-runner-"));
  const queue = new LlmBatchQueueService({ queuePath: path.join(tempDir, "queue.json") });
  const runs = new LlmBatchRunsService({ runsPath: path.join(tempDir, "runs.json") });
  const job = buildDigestReflectionJob({
    language: "ko",
    lane: "onchain",
    summary: "고래와 스테이블 흐름이 겹친 날",
    acceptedNutrients: [{ label: "고래 활동", value: "+18%", source: "onchain" }],
    rejectReasons: [],
    xpGainTotal: 9,
    evolvedCount: 0,
    maxChars: 220,
  });
  queue.enqueue(job);

  return Promise.resolve()
    .then(() => run(queue, runs, job.customId))
    .finally(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });
}

test("submitPendingLlmBatch submits queued jobs and records batch state", async () => {
  await withTempBatchState(async (queue, runs, jobCustomId) => {
    const memoryService = {
      recordDigestReflectionMemo() {
        // no-op
      },
    };
    const fakeClaude = {
      beta: {
        messages: {
          batches: {
            create: async ({ requests }: { requests: Array<{ custom_id: string }> }) => ({
              id: "msgbatch_submit_001",
              created_at: "2026-03-10T00:00:00.000Z",
              processing_status: "in_progress",
              ended_at: null,
              expires_at: "2026-03-11T00:00:00.000Z",
              results_url: null,
              request_counts: {
                processing: requests.length,
                succeeded: 0,
                errored: 0,
                canceled: 0,
                expired: 0,
              },
            }),
          },
        },
      },
    } as any;

    const report = await submitPendingLlmBatch(
      fakeClaude,
      {
        enabled: true,
        maxRequestsPerBatch: 8,
        maxSyncBatchesPerRun: 3,
        minSyncMinutes: 0,
      },
      { queue, runs, memoryService }
    );

    assert.equal(report.status, "submitted");
    assert.equal(report.requestCount, 1);
    assert.equal(report.batchId, "msgbatch_submit_001");
    assert.deepEqual(queue.getQueueStats(), {
      pending: 0,
      submitted: 1,
      completed: 0,
      failed: 0,
      total: 1,
    });
    assert.deepEqual(runs.getStats(), {
      active: 1,
      endedPendingResults: 0,
      endedApplied: 0,
      total: 1,
    });
    assert.equal(runs.getSyncCandidates(0, 5)[0]?.customIds[0], jobCustomId);
  });
});

test("syncLlmBatchRuns applies succeeded and failed results back into queue", async () => {
  await withTempBatchState(async (queue, runs, jobCustomId) => {
    const recorded: Array<{ customId: string; text: string }> = [];
    const memoryService = {
      recordDigestReflectionMemo(input: { customId: string; text: string }) {
        recorded.push({ customId: input.customId, text: input.text });
      },
    };
    runs.recordSubmittedBatch(
      {
        id: "msgbatch_sync_001",
        created_at: "2026-03-10T00:00:00.000Z",
        processing_status: "in_progress",
        ended_at: null,
        expires_at: "2026-03-11T00:00:00.000Z",
        results_url: null,
        request_counts: {
          processing: 1,
          succeeded: 0,
          errored: 0,
          canceled: 0,
          expired: 0,
        },
      },
      [jobCustomId]
    );
    queue.markSubmitted([jobCustomId], "msgbatch_sync_001");

    const fakeClaude = {
      beta: {
        messages: {
          batches: {
            retrieve: async () => ({
              id: "msgbatch_sync_001",
              created_at: "2026-03-10T00:00:00.000Z",
              processing_status: "ended",
              ended_at: "2026-03-10T00:02:00.000Z",
              expires_at: "2026-03-11T00:00:00.000Z",
              results_url: "https://example.com/results.jsonl",
              request_counts: {
                processing: 0,
                succeeded: 1,
                errored: 0,
                canceled: 0,
                expired: 0,
              },
            }),
            results: async () =>
              (async function* () {
                yield {
                  custom_id: jobCustomId,
                  result: {
                    type: "succeeded",
                    message: { content: [{ type: "text", text: "reflection memo" }] },
                  },
                };
              })(),
          },
        },
      },
    } as any;

    const report = await syncLlmBatchRuns(
      fakeClaude,
      {
        enabled: true,
        maxRequestsPerBatch: 8,
        maxSyncBatchesPerRun: 3,
        minSyncMinutes: 0,
      },
      { queue, runs, memoryService }
    );

    assert.equal(report.status, "synced");
    assert.equal(report.syncedBatches, 1);
    assert.equal(report.completedJobs, 1);
    assert.equal(report.failedJobs, 0);
    assert.deepEqual(queue.getQueueStats(), {
      pending: 0,
      submitted: 0,
      completed: 1,
      failed: 0,
      total: 1,
    });
    assert.deepEqual(runs.getStats(), {
      active: 0,
      endedPendingResults: 0,
      endedApplied: 1,
      total: 1,
    });
    assert.deepEqual(recorded, [{ customId: jobCustomId, text: "reflection memo" }]);
  });
});
