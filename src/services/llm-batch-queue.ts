import fs from "fs";
import path from "path";
import { BatchReadyClaudeJob } from "./llm-batch.js";
import { quarantineCorruptFile } from "./quarantine.js";

const DATA_DIR = path.join(process.cwd(), "data");
const DEFAULT_QUEUE_PATH = path.join(DATA_DIR, "llm-batch-queue.json");

export type LlmBatchQueueStatus = "pending" | "submitted" | "completed" | "failed";

export interface LlmBatchQueueEntry {
  customId: string;
  kind: string;
  status: LlmBatchQueueStatus;
  job: BatchReadyClaudeJob;
  queuedAt: string;
  updatedAt: string;
  submittedAt?: string;
  completedAt?: string;
  batchId?: string;
  note?: string;
}

interface LlmBatchQueueData {
  schemaVersion: 1;
  jobs: LlmBatchQueueEntry[];
  updatedAt: string;
}

export interface LlmBatchQueueStats {
  pending: number;
  submitted: number;
  completed: number;
  failed: number;
  total: number;
}

export interface LlmBatchEnqueueResult {
  status: "queued" | "duplicate";
  entry: LlmBatchQueueEntry;
}

function createEmptyQueueData(): LlmBatchQueueData {
  return {
    schemaVersion: 1,
    jobs: [],
    updatedAt: new Date().toISOString(),
  };
}

function isBatchReadyClaudeJob(value: unknown): value is BatchReadyClaudeJob {
  if (!value || typeof value !== "object") return false;
  const job = value as Record<string, unknown>;
  return (
    typeof job.customId === "string" &&
    typeof job.kind === "string" &&
    Boolean(job.request && typeof job.request === "object") &&
    Boolean(job.execution && typeof job.execution === "object") &&
    Boolean(job.metadata && typeof job.metadata === "object")
  );
}

function normalizeStatus(value: unknown): LlmBatchQueueStatus {
  if (value === "submitted" || value === "completed" || value === "failed") {
    return value;
  }
  return "pending";
}

function normalizeQueueEntry(raw: unknown, fallbackNow: string): LlmBatchQueueEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  if (!isBatchReadyClaudeJob(item.job)) return null;

  const customId = typeof item.customId === "string" ? item.customId.trim() : item.job.customId;
  const kind = typeof item.kind === "string" ? item.kind.trim() : item.job.kind;
  if (!customId || !kind) return null;

  return {
    customId,
    kind,
    status: normalizeStatus(item.status),
    job: item.job,
    queuedAt: typeof item.queuedAt === "string" && item.queuedAt.trim() ? item.queuedAt : fallbackNow,
    updatedAt: typeof item.updatedAt === "string" && item.updatedAt.trim() ? item.updatedAt : fallbackNow,
    submittedAt: typeof item.submittedAt === "string" && item.submittedAt.trim() ? item.submittedAt : undefined,
    completedAt: typeof item.completedAt === "string" && item.completedAt.trim() ? item.completedAt : undefined,
    batchId: typeof item.batchId === "string" && item.batchId.trim() ? item.batchId : undefined,
    note: typeof item.note === "string" && item.note.trim() ? item.note.slice(0, 220) : undefined,
  };
}

export class LlmBatchQueueService {
  private readonly queuePath: string;
  private data: LlmBatchQueueData;

  constructor(options?: { queuePath?: string }) {
    this.queuePath = options?.queuePath || DEFAULT_QUEUE_PATH;
    this.data = this.load();
  }

  enqueue(job: BatchReadyClaudeJob): LlmBatchEnqueueResult {
    const existing = this.findEntry(job.customId);
    if (existing) {
      return {
        status: "duplicate",
        entry: { ...existing },
      };
    }

    const now = new Date().toISOString();
    const entry: LlmBatchQueueEntry = {
      customId: job.customId,
      kind: job.kind,
      status: "pending",
      job,
      queuedAt: now,
      updatedAt: now,
    };
    this.data.jobs.push(entry);
    this.persist();
    return {
      status: "queued",
      entry: { ...entry },
    };
  }

  getPendingJobs(limit: number = 50): BatchReadyClaudeJob[] {
    const maxItems = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 50;
    return this.data.jobs
      .filter((entry) => entry.status === "pending")
      .slice(0, maxItems)
      .map((entry) => entry.job);
  }

  getEntry(customId: string): LlmBatchQueueEntry | null {
    return this.findEntry(customId);
  }

  markSubmitted(customIds: string[], batchId?: string): number {
    const ids = new Set(
      customIds
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    );
    if (ids.size === 0) return 0;

    const now = new Date().toISOString();
    let changed = 0;
    this.data.jobs = this.data.jobs.map((entry) => {
      if (!ids.has(entry.customId) || entry.status !== "pending") {
        return entry;
      }
      changed += 1;
      return {
        ...entry,
        status: "submitted",
        submittedAt: now,
        updatedAt: now,
        batchId: batchId ? String(batchId).trim().slice(0, 120) : entry.batchId,
      };
    });

    if (changed > 0) {
      this.persist();
    }
    return changed;
  }

  markCompleted(customId: string, note?: string): boolean {
    return this.updateTerminalStatus(customId, "completed", note);
  }

  markFailed(customId: string, note?: string): boolean {
    return this.updateTerminalStatus(customId, "failed", note);
  }

  getQueueStats(): LlmBatchQueueStats {
    const stats: LlmBatchQueueStats = {
      pending: 0,
      submitted: 0,
      completed: 0,
      failed: 0,
      total: this.data.jobs.length,
    };
    for (const entry of this.data.jobs) {
      if (entry.status === "submitted") {
        stats.submitted += 1;
      } else if (entry.status === "completed") {
        stats.completed += 1;
      } else if (entry.status === "failed") {
        stats.failed += 1;
      } else {
        stats.pending += 1;
      }
    }
    return stats;
  }

  flushNow(): void {
    this.persist();
  }

  private updateTerminalStatus(customId: string, status: "completed" | "failed", note?: string): boolean {
    const normalizedId = String(customId || "").trim();
    if (!normalizedId) return false;

    const now = new Date().toISOString();
    let changed = false;
    this.data.jobs = this.data.jobs.map((entry) => {
      if (entry.customId !== normalizedId || entry.status === status) {
        return entry;
      }
      changed = true;
      return {
        ...entry,
        status,
        completedAt: now,
        updatedAt: now,
        note: typeof note === "string" && note.trim() ? note.trim().slice(0, 220) : entry.note,
      };
    });

    if (changed) {
      this.persist();
    }
    return changed;
  }

  private findEntry(customId: string): LlmBatchQueueEntry | null {
    const normalizedId = String(customId || "").trim();
    if (!normalizedId) return null;
    const found = this.data.jobs.find((entry) => entry.customId === normalizedId);
    return found ? { ...found } : null;
  }

  private load(): LlmBatchQueueData {
    fs.mkdirSync(path.dirname(this.queuePath), { recursive: true });

    if (!fs.existsSync(this.queuePath)) {
      const empty = createEmptyQueueData();
      this.persistData(empty);
      return empty;
    }

    let raw = "";
    try {
      raw = fs.readFileSync(this.queuePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<LlmBatchQueueData>;
      return this.normalizeData(parsed);
    } catch (error) {
      if (raw) {
        quarantineCorruptFile({
          filePath: this.queuePath,
          raw,
          reason: `llm-batch-queue-parse:${error instanceof Error ? error.message : "unknown"}`,
        });
      }
      const empty = createEmptyQueueData();
      this.persistData(empty);
      return empty;
    }
  }

  private normalizeData(raw: Partial<LlmBatchQueueData>): LlmBatchQueueData {
    const now = new Date().toISOString();
    const jobs = Array.isArray(raw.jobs)
      ? raw.jobs
          .map((item) => normalizeQueueEntry(item, now))
          .filter((item): item is LlmBatchQueueEntry => Boolean(item))
      : [];
    return {
      schemaVersion: 1,
      jobs,
      updatedAt: typeof raw.updatedAt === "string" && raw.updatedAt.trim() ? raw.updatedAt : now,
    };
  }

  private persist(): void {
    this.persistData(this.data);
  }

  private persistData(data: LlmBatchQueueData): void {
    fs.mkdirSync(path.dirname(this.queuePath), { recursive: true });
    data.updatedAt = new Date().toISOString();
    fs.writeFileSync(this.queuePath, JSON.stringify(data, null, 2), "utf-8");
  }
}

export const llmBatchQueue = new LlmBatchQueueService();
