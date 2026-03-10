import Anthropic from "@anthropic-ai/sdk";
import { TrendLane } from "../types/agent.js";
import { LlmBatchRuntimeSettings } from "../types/runtime.js";
import { LlmBatchQueueService, llmBatchQueue } from "./llm-batch-queue.js";
import { LlmBatchRunsService, llmBatchRuns, RemoteBatchLike } from "./llm-batch-runs.js";
import { memory } from "./memory.js";
import { TEST_NO_EXTERNAL_CALLS } from "./twitter.js";

interface BatchRunnerMemoryLike {
  recordDigestReflectionMemo(input: {
    customId: string;
    lane?: TrendLane;
    summary?: string;
    text: string;
    batchId?: string;
  }): void;
}

export interface LlmBatchSubmitReport {
  status: "disabled" | "local-skip" | "empty" | "submitted" | "error";
  requestCount: number;
  batchId?: string;
  error?: string;
}

export interface LlmBatchSyncReport {
  status: "disabled" | "local-skip" | "empty" | "synced" | "error";
  syncedBatches: number;
  completedJobs: number;
  failedJobs: number;
  error?: string;
}

export async function submitPendingLlmBatch(
  claude: Anthropic,
  settings: LlmBatchRuntimeSettings,
  deps: {
    queue?: LlmBatchQueueService;
    runs?: LlmBatchRunsService;
    memoryService?: BatchRunnerMemoryLike;
  } = {}
): Promise<LlmBatchSubmitReport> {
  if (!settings.enabled) {
    return { status: "disabled", requestCount: 0 };
  }
  if (TEST_NO_EXTERNAL_CALLS) {
    return { status: "local-skip", requestCount: 0 };
  }

  const queue = deps.queue || llmBatchQueue;
  const runs = deps.runs || llmBatchRuns;
  const pendingJobs = queue.getPendingJobs(settings.maxRequestsPerBatch);
  if (pendingJobs.length === 0) {
    return { status: "empty", requestCount: 0 };
  }

  try {
    const batch = await claude.beta.messages.batches.create({
      requests: pendingJobs.map((job) => ({
        custom_id: job.customId,
        params: job.request as any,
      })),
    });
    const customIds = pendingJobs.map((job) => job.customId);
    queue.markSubmitted(customIds, batch.id);
    runs.recordSubmittedBatch(toRemoteBatchLike(batch), customIds);
    return {
      status: "submitted",
      requestCount: customIds.length,
      batchId: batch.id,
    };
  } catch (error) {
    return {
      status: "error",
      requestCount: pendingJobs.length,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function syncLlmBatchRuns(
  claude: Anthropic,
  settings: LlmBatchRuntimeSettings,
  deps: {
    queue?: LlmBatchQueueService;
    runs?: LlmBatchRunsService;
    memoryService?: BatchRunnerMemoryLike;
  } = {}
): Promise<LlmBatchSyncReport> {
  if (!settings.enabled) {
    return { status: "disabled", syncedBatches: 0, completedJobs: 0, failedJobs: 0 };
  }
  if (TEST_NO_EXTERNAL_CALLS) {
    return { status: "local-skip", syncedBatches: 0, completedJobs: 0, failedJobs: 0 };
  }

  const queue = deps.queue || llmBatchQueue;
  const runs = deps.runs || llmBatchRuns;
  const memoryService = deps.memoryService || memory;
  const candidates = runs.getSyncCandidates(settings.minSyncMinutes, settings.maxSyncBatchesPerRun);
  if (candidates.length === 0) {
    return { status: "empty", syncedBatches: 0, completedJobs: 0, failedJobs: 0 };
  }

  let syncedBatches = 0;
  let completedJobs = 0;
  let failedJobs = 0;

  try {
    for (const candidate of candidates) {
      const batch = await claude.beta.messages.batches.retrieve(candidate.batchId);
      const remote = toRemoteBatchLike(batch);
      runs.updateFromRemote(remote);
      syncedBatches += 1;

      if (remote.processing_status !== "ended" || candidate.resultsAppliedAt) {
        continue;
      }

      const results = await claude.beta.messages.batches.results(candidate.batchId);
      for await (const entry of results as AsyncIterable<any>) {
        const customId = typeof entry?.custom_id === "string" ? entry.custom_id : "";
        if (!customId) continue;
        const resultType = typeof entry?.result?.type === "string" ? entry.result.type : "unknown";
        if (resultType === "succeeded") {
          const queueEntry = queue.getEntry(customId);
          if (queueEntry?.job.kind === "digest:reflection") {
            const reflectionText = extractBatchMessageText(entry?.result?.message?.content);
            if (reflectionText) {
              memoryService.recordDigestReflectionMemo({
                customId,
                lane: typeof queueEntry.job.metadata?.lane === "string" ? queueEntry.job.metadata.lane as TrendLane : undefined,
                summary:
                  typeof queueEntry.job.metadata?.summarySnippet === "string"
                    ? queueEntry.job.metadata.summarySnippet
                    : undefined,
                text: reflectionText,
                batchId: candidate.batchId,
              });
            }
          }
          if (queue.markCompleted(customId, `batch:${candidate.batchId}:succeeded`)) {
            completedJobs += 1;
          }
          continue;
        }

        const errorMessage =
          typeof entry?.result?.error?.message === "string"
            ? entry.result.error.message
            : resultType;
        if (queue.markFailed(customId, `batch:${candidate.batchId}:${errorMessage}`)) {
          failedJobs += 1;
        }
      }
      runs.markResultsApplied(candidate.batchId);
    }

    return {
      status: "synced",
      syncedBatches,
      completedJobs,
      failedJobs,
    };
  } catch (error) {
    return {
      status: "error",
      syncedBatches,
      completedJobs,
      failedJobs,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function toRemoteBatchLike(batch: any): RemoteBatchLike {
  return {
    id: String(batch?.id || "").trim(),
    created_at: String(batch?.created_at || new Date().toISOString()),
    processing_status:
      batch?.processing_status === "canceling" || batch?.processing_status === "ended"
        ? batch.processing_status
        : "in_progress",
    ended_at: typeof batch?.ended_at === "string" ? batch.ended_at : null,
    expires_at: String(batch?.expires_at || ""),
    results_url: typeof batch?.results_url === "string" ? batch.results_url : null,
    request_counts: {
      processing: typeof batch?.request_counts?.processing === "number" ? batch.request_counts.processing : 0,
      succeeded: typeof batch?.request_counts?.succeeded === "number" ? batch.request_counts.succeeded : 0,
      errored: typeof batch?.request_counts?.errored === "number" ? batch.request_counts.errored : 0,
      canceled: typeof batch?.request_counts?.canceled === "number" ? batch.request_counts.canceled : 0,
      expired: typeof batch?.request_counts?.expired === "number" ? batch.request_counts.expired : 0,
    },
  };
}

function extractBatchMessageText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const row = block as Record<string, unknown>;
      return row.type === "text" && typeof row.text === "string" ? row.text.trim() : "";
    })
    .filter(Boolean)
    .join(" ")
    .trim()
    .slice(0, 280);
}
