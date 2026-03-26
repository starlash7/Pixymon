import fs from "fs";
import path from "path";
import { AnthropicUsageSnapshot } from "./anthropic-budget.js";
import { resolveSharedStatePath } from "./shared-state-dir.js";

const DEFAULT_DATA_PATH = resolveSharedStatePath("anthropic-admin-usage.json");

export interface AnthropicAdminUsageSnapshot {
  dateKey: string;
  syncedAt: string;
  rangeStart: string;
  rangeEnd: string;
  actualCostUsd: number;
  uncachedInputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
}

interface AnthropicAdminUsageState {
  usageByDate: Record<string, AnthropicAdminUsageSnapshot>;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
}

type FetchLike = typeof fetch;

export interface AnthropicAdminUsageSyncInput {
  enabled: boolean;
  timezone: string;
  minSyncMinutes: number;
  adminApiKey?: string;
}

export function mergeAnthropicUsageSnapshots(
  local: AnthropicUsageSnapshot,
  remote: AnthropicAdminUsageSnapshot | null
): AnthropicUsageSnapshot {
  if (!remote || remote.dateKey !== local.dateKey) {
    return local;
  }
  return {
    ...local,
    estimatedInputTokens: Math.max(local.estimatedInputTokens, remote.uncachedInputTokens),
    estimatedOutputTokens: Math.max(local.estimatedOutputTokens, remote.outputTokens),
    cacheCreationInputTokens: Math.max(local.cacheCreationInputTokens, remote.cacheCreationInputTokens),
    cacheReadInputTokens: Math.max(local.cacheReadInputTokens, remote.cacheReadInputTokens),
    estimatedTotalCostUsd: Math.max(local.estimatedTotalCostUsd, remote.actualCostUsd),
  };
}

export class AnthropicAdminUsageService {
  private readonly dataPath: string;
  private readonly now: () => Date;
  private readonly fetchImpl: FetchLike;
  private state: AnthropicAdminUsageState;

  constructor(options?: { dataPath?: string; now?: () => Date; fetchImpl?: FetchLike }) {
    this.dataPath = options?.dataPath ? path.resolve(options.dataPath) : DEFAULT_DATA_PATH;
    this.now = typeof options?.now === "function" ? options.now : () => new Date();
    this.fetchImpl = options?.fetchImpl || fetch;
    this.state = this.load();
  }

  getTodayUsage(timezone: string): AnthropicAdminUsageSnapshot | null {
    const dateKey = getDateKey(this.now(), normalizeTimezone(timezone));
    return this.state.usageByDate[dateKey] || null;
  }

  async maybeSyncToday(input: AnthropicAdminUsageSyncInput): Promise<AnthropicAdminUsageSnapshot | null> {
    const timezone = normalizeTimezone(input.timezone);
    const dateKey = getDateKey(this.now(), timezone);
    const existing = this.state.usageByDate[dateKey] || null;
    if (!input.enabled) {
      return existing;
    }
    const adminApiKey = String(input.adminApiKey || process.env.ANTHROPIC_ADMIN_API_KEY || "").trim();
    if (!adminApiKey) {
      return existing;
    }
    if (existing && isFresh(existing.syncedAt, this.now(), input.minSyncMinutes)) {
      return existing;
    }

    this.state.lastAttemptAt = this.now().toISOString();
    const range = getDayRange(this.now(), timezone);
    const [usageJson, costJson] = await Promise.all([
      this.fetchReport("/v1/organizations/usage_report/messages", range, adminApiKey),
      this.fetchReport("/v1/organizations/cost_report", range, adminApiKey),
    ]);

    const usage = parseUsageReport(usageJson);
    const actualCostUsd = parseCostReport(costJson);
    const snapshot: AnthropicAdminUsageSnapshot = {
      dateKey,
      syncedAt: this.now().toISOString(),
      rangeStart: range.startingAt,
      rangeEnd: range.endingAt,
      actualCostUsd,
      uncachedInputTokens: usage.uncachedInputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      outputTokens: usage.outputTokens,
    };
    this.state.usageByDate[dateKey] = snapshot;
    this.state.lastSuccessAt = snapshot.syncedAt;
    this.persist();
    return snapshot;
  }

  flushNow(): void {
    this.persist();
  }

  private async fetchReport(
    pathname: string,
    range: { startingAt: string; endingAt: string },
    adminApiKey: string
  ): Promise<unknown> {
    const url = new URL(pathname, "https://api.anthropic.com");
    url.searchParams.set("starting_at", range.startingAt);
    url.searchParams.set("ending_at", range.endingAt);
    url.searchParams.set("bucket_width", "1d");
    const response = await this.fetchImpl(url, {
      headers: {
        "x-api-key": adminApiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
    });
    if (!response.ok) {
      const body = await safeReadText(response);
      throw new Error(`Anthropic admin API ${pathname} failed: ${response.status} ${body}`);
    }
    return response.json();
  }

  private load(): AnthropicAdminUsageState {
    try {
      if (!fs.existsSync(this.dataPath)) {
        return { usageByDate: {} };
      }
      const raw = fs.readFileSync(this.dataPath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<AnthropicAdminUsageState>;
      const usageByDate = parsed.usageByDate && typeof parsed.usageByDate === "object"
        ? parsed.usageByDate
        : {};
      const state: AnthropicAdminUsageState = { usageByDate: {} };
      for (const [dateKey, snapshot] of Object.entries(usageByDate)) {
        const row = snapshot as Partial<AnthropicAdminUsageSnapshot>;
        state.usageByDate[dateKey] = {
          dateKey,
          syncedAt: typeof row.syncedAt === "string" ? row.syncedAt : new Date().toISOString(),
          rangeStart: typeof row.rangeStart === "string" ? row.rangeStart : "",
          rangeEnd: typeof row.rangeEnd === "string" ? row.rangeEnd : "",
          actualCostUsd: clampNumber(row.actualCostUsd),
          uncachedInputTokens: clampInt(row.uncachedInputTokens),
          cacheCreationInputTokens: clampInt(row.cacheCreationInputTokens),
          cacheReadInputTokens: clampInt(row.cacheReadInputTokens),
          outputTokens: clampInt(row.outputTokens),
        };
      }
      state.lastAttemptAt = typeof parsed.lastAttemptAt === "string" ? parsed.lastAttemptAt : undefined;
      state.lastSuccessAt = typeof parsed.lastSuccessAt === "string" ? parsed.lastSuccessAt : undefined;
      return state;
    } catch {
      return { usageByDate: {} };
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.dataPath), { recursive: true });
    fs.writeFileSync(this.dataPath, `${JSON.stringify(this.state, null, 2)}\n`, "utf-8");
  }
}

function parseUsageReport(payload: unknown): {
  uncachedInputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
} {
  let uncachedInputTokens = 0;
  let cacheCreationInputTokens = 0;
  let cacheReadInputTokens = 0;
  let outputTokens = 0;
  for (const result of extractBucketResults(payload)) {
    uncachedInputTokens += clampInt((result as Record<string, unknown>).uncached_input_tokens);
    cacheReadInputTokens += clampInt((result as Record<string, unknown>).cache_read_input_tokens);
    outputTokens += clampInt((result as Record<string, unknown>).output_tokens);
    const cacheCreation = (result as Record<string, unknown>).cache_creation;
    if (cacheCreation && typeof cacheCreation === "object") {
      for (const value of Object.values(cacheCreation as Record<string, unknown>)) {
        cacheCreationInputTokens += clampInt(value);
      }
    }
  }
  return {
    uncachedInputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    outputTokens,
  };
}

function parseCostReport(payload: unknown): number {
  let totalUsd = 0;
  for (const result of extractBucketResults(payload)) {
    const row = result as Record<string, unknown>;
    const amount = typeof row.amount === "string" || typeof row.amount === "number"
      ? Number.parseFloat(String(row.amount))
      : 0;
    if (!Number.isFinite(amount)) continue;
    totalUsd += amount / 100;
  }
  return roundUsd(totalUsd);
}

function extractBucketResults(payload: unknown): unknown[] {
  if (!payload || typeof payload !== "object") return [];
  const data = Array.isArray((payload as { data?: unknown }).data)
    ? (payload as { data: unknown[] }).data
    : [];
  const out: unknown[] = [];
  for (const bucket of data) {
    if (!bucket || typeof bucket !== "object") continue;
    const results = Array.isArray((bucket as { results?: unknown }).results)
      ? (bucket as { results: unknown[] }).results
      : [];
    out.push(...results);
  }
  return out;
}

function getDayRange(now: Date, timezone: string): { startingAt: string; endingAt: string } {
  const start = getStartOfDayInTimezone(now, timezone);
  return {
    startingAt: start.toISOString(),
    endingAt: now.toISOString(),
  };
}

function getStartOfDayInTimezone(date: Date, timezone: string): Date {
  const parts = getDateParts(date, timezone);
  const utcMidnight = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0));
  const offsetMinutes = getOffsetMinutes(utcMidnight, timezone);
  return new Date(utcMidnight.getTime() - offsetMinutes * 60_000);
}

function getOffsetMinutes(date: Date, timezone: string): number {
  const parts = getDateTimeParts(date, timezone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((asUtc - date.getTime()) / 60_000);
}

function getDateParts(date: Date, timezone: string): { year: number; month: number; day: number } {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  return {
    year: Number(parts.find((part) => part.type === "year")?.value || 0),
    month: Number(parts.find((part) => part.type === "month")?.value || 1),
    day: Number(parts.find((part) => part.type === "day")?.value || 1),
  };
}

function getDateTimeParts(
  date: Date,
  timezone: string
): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  return {
    year: Number(parts.find((part) => part.type === "year")?.value || 0),
    month: Number(parts.find((part) => part.type === "month")?.value || 1),
    day: Number(parts.find((part) => part.type === "day")?.value || 1),
    hour: Number(parts.find((part) => part.type === "hour")?.value || 0),
    minute: Number(parts.find((part) => part.type === "minute")?.value || 0),
    second: Number(parts.find((part) => part.type === "second")?.value || 0),
  };
}

function getDateKey(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function normalizeTimezone(timezone: string): string {
  return typeof timezone === "string" && timezone.trim().length > 0 ? timezone.trim() : "Asia/Seoul";
}

function isFresh(iso: string, now: Date, minSyncMinutes: number): boolean {
  const value = new Date(iso).getTime();
  if (!Number.isFinite(value)) return false;
  return now.getTime() - value < minSyncMinutes * 60_000;
}

function clampInt(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
}

function clampNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, parsed);
}

function roundUsd(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1000) / 1000;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return (await response.text()).trim().slice(0, 200);
  } catch {
    return "";
  }
}

export const anthropicAdminUsage = new AnthropicAdminUsageService();
