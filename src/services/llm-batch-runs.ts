import fs from "fs";
import path from "path";
import { resolveDataDir } from "./data-dir.js";
import { quarantineCorruptFile } from "./quarantine.js";

const DATA_DIR = resolveDataDir();
const DEFAULT_RUNS_PATH = path.join(DATA_DIR, "llm-batch-runs.json");

export interface LlmBatchRunRequestCounts {
  processing: number;
  succeeded: number;
  errored: number;
  canceled: number;
  expired: number;
}

export interface LlmBatchRunRecord {
  batchId: string;
  status: "in_progress" | "canceling" | "ended";
  requestCount: number;
  customIds: string[];
  createdAt: string;
  updatedAt: string;
  lastSyncedAt?: string;
  endedAt?: string;
  expiresAt?: string;
  resultsUrl?: string;
  resultsAppliedAt?: string;
  requestCounts: LlmBatchRunRequestCounts;
}

interface LlmBatchRunsData {
  schemaVersion: 1;
  runs: LlmBatchRunRecord[];
  updatedAt: string;
}

export interface LlmBatchRunsStats {
  active: number;
  endedPendingResults: number;
  endedApplied: number;
  total: number;
}

export interface RemoteBatchLike {
  id: string;
  created_at: string;
  processing_status: "in_progress" | "canceling" | "ended";
  ended_at: string | null;
  expires_at: string;
  results_url: string | null;
  request_counts: Partial<LlmBatchRunRequestCounts>;
}

function createEmptyRunsData(): LlmBatchRunsData {
  return {
    schemaVersion: 1,
    runs: [],
    updatedAt: new Date().toISOString(),
  };
}

function normalizeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function normalizeRequestCounts(raw?: Partial<LlmBatchRunRequestCounts>): LlmBatchRunRequestCounts {
  return {
    processing: normalizeCount(raw?.processing),
    succeeded: normalizeCount(raw?.succeeded),
    errored: normalizeCount(raw?.errored),
    canceled: normalizeCount(raw?.canceled),
    expired: normalizeCount(raw?.expired),
  };
}

function normalizeRunRecord(raw: unknown, fallbackNow: string): LlmBatchRunRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const batchId = typeof item.batchId === "string" ? item.batchId.trim() : "";
  if (!batchId) return null;
  const status =
    item.status === "canceling" || item.status === "ended"
      ? item.status
      : "in_progress";
  const customIds = Array.isArray(item.customIds)
    ? item.customIds
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean)
    : [];
  return {
    batchId,
    status,
    requestCount: normalizeCount(item.requestCount) || customIds.length,
    customIds,
    createdAt: typeof item.createdAt === "string" && item.createdAt.trim() ? item.createdAt : fallbackNow,
    updatedAt: typeof item.updatedAt === "string" && item.updatedAt.trim() ? item.updatedAt : fallbackNow,
    lastSyncedAt: typeof item.lastSyncedAt === "string" && item.lastSyncedAt.trim() ? item.lastSyncedAt : undefined,
    endedAt: typeof item.endedAt === "string" && item.endedAt.trim() ? item.endedAt : undefined,
    expiresAt: typeof item.expiresAt === "string" && item.expiresAt.trim() ? item.expiresAt : undefined,
    resultsUrl: typeof item.resultsUrl === "string" && item.resultsUrl.trim() ? item.resultsUrl : undefined,
    resultsAppliedAt:
      typeof item.resultsAppliedAt === "string" && item.resultsAppliedAt.trim() ? item.resultsAppliedAt : undefined,
    requestCounts: normalizeRequestCounts(item.requestCounts as Partial<LlmBatchRunRequestCounts> | undefined),
  };
}

export class LlmBatchRunsService {
  private readonly runsPath: string;
  private data: LlmBatchRunsData;

  constructor(options?: { runsPath?: string }) {
    this.runsPath = options?.runsPath || DEFAULT_RUNS_PATH;
    this.data = this.load();
  }

  recordSubmittedBatch(remote: RemoteBatchLike, customIds: string[]): void {
    const normalizedIds = [...new Set(customIds.map((item) => String(item || "").trim()).filter(Boolean))];
    if (!remote.id || normalizedIds.length === 0) return;

    const now = new Date().toISOString();
    const nextRecord: LlmBatchRunRecord = {
      batchId: remote.id,
      status: remote.processing_status,
      requestCount: normalizedIds.length,
      customIds: normalizedIds,
      createdAt: remote.created_at || now,
      updatedAt: now,
      lastSyncedAt: now,
      endedAt: remote.ended_at || undefined,
      expiresAt: remote.expires_at || undefined,
      resultsUrl: remote.results_url || undefined,
      requestCounts: normalizeRequestCounts(remote.request_counts),
    };

    const existingIndex = this.data.runs.findIndex((item) => item.batchId === remote.id);
    if (existingIndex >= 0) {
      const previous = this.data.runs[existingIndex];
      this.data.runs[existingIndex] = {
        ...previous,
        ...nextRecord,
        resultsAppliedAt: previous.resultsAppliedAt,
      };
    } else {
      this.data.runs.push(nextRecord);
    }
    this.persist();
  }

  getSyncCandidates(minSyncMinutes: number, limit: number): LlmBatchRunRecord[] {
    const minMinutes = Math.max(0, Math.floor(minSyncMinutes || 0));
    const maxItems = Math.max(1, Math.floor(limit || 1));
    const now = Date.now();
    return this.data.runs
      .filter((record) => record.status !== "ended" || !record.resultsAppliedAt)
      .filter((record) => {
        if (!record.lastSyncedAt) return true;
        const syncedAt = Date.parse(record.lastSyncedAt);
        if (!Number.isFinite(syncedAt)) return true;
        return now - syncedAt >= minMinutes * 60 * 1000;
      })
      .slice(0, maxItems)
      .map((record) => ({ ...record, customIds: [...record.customIds], requestCounts: { ...record.requestCounts } }));
  }

  updateFromRemote(remote: RemoteBatchLike): void {
    const index = this.data.runs.findIndex((record) => record.batchId === remote.id);
    if (index < 0) return;
    const previous = this.data.runs[index];
    this.data.runs[index] = {
      ...previous,
      status: remote.processing_status,
      updatedAt: new Date().toISOString(),
      lastSyncedAt: new Date().toISOString(),
      endedAt: remote.ended_at || previous.endedAt,
      expiresAt: remote.expires_at || previous.expiresAt,
      resultsUrl: remote.results_url || previous.resultsUrl,
      requestCounts: normalizeRequestCounts(remote.request_counts),
    };
    this.persist();
  }

  markResultsApplied(batchId: string): boolean {
    const normalizedId = String(batchId || "").trim();
    if (!normalizedId) return false;
    const index = this.data.runs.findIndex((record) => record.batchId === normalizedId);
    if (index < 0) return false;
    this.data.runs[index] = {
      ...this.data.runs[index],
      resultsAppliedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.persist();
    return true;
  }

  getStats(): LlmBatchRunsStats {
    const stats: LlmBatchRunsStats = {
      active: 0,
      endedPendingResults: 0,
      endedApplied: 0,
      total: this.data.runs.length,
    };
    for (const record of this.data.runs) {
      if (record.status !== "ended") {
        stats.active += 1;
      } else if (record.resultsAppliedAt) {
        stats.endedApplied += 1;
      } else {
        stats.endedPendingResults += 1;
      }
    }
    return stats;
  }

  flushNow(): void {
    this.persist();
  }

  private load(): LlmBatchRunsData {
    fs.mkdirSync(path.dirname(this.runsPath), { recursive: true });

    if (!fs.existsSync(this.runsPath)) {
      const empty = createEmptyRunsData();
      this.persistData(empty);
      return empty;
    }

    let raw = "";
    try {
      raw = fs.readFileSync(this.runsPath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<LlmBatchRunsData>;
      return this.normalizeData(parsed);
    } catch (error) {
      if (raw) {
        quarantineCorruptFile({
          filePath: this.runsPath,
          raw,
          reason: `llm-batch-runs-parse:${error instanceof Error ? error.message : "unknown"}`,
        });
      }
      const empty = createEmptyRunsData();
      this.persistData(empty);
      return empty;
    }
  }

  private normalizeData(raw: Partial<LlmBatchRunsData>): LlmBatchRunsData {
    const now = new Date().toISOString();
    const runs = Array.isArray(raw.runs)
      ? raw.runs
          .map((item) => normalizeRunRecord(item, now))
          .filter((item): item is LlmBatchRunRecord => Boolean(item))
      : [];
    return {
      schemaVersion: 1,
      runs,
      updatedAt: typeof raw.updatedAt === "string" && raw.updatedAt.trim() ? raw.updatedAt : now,
    };
  }

  private persist(): void {
    this.persistData(this.data);
  }

  private persistData(data: LlmBatchRunsData): void {
    fs.mkdirSync(path.dirname(this.runsPath), { recursive: true });
    data.updatedAt = new Date().toISOString();
    fs.writeFileSync(this.runsPath, JSON.stringify(data, null, 2), "utf-8");
  }
}

export const llmBatchRuns = new LlmBatchRunsService();
