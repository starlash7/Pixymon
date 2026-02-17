import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const DEFAULT_DATA_PATH = path.join(DATA_DIR, "x-api-budget.json");
const KEEP_DAYS = 21;
const COST_EPSILON = 1e-9;

type XRequestType = "read" | "create";

interface XApiUsageBucket {
  dateKey: string;
  readRequests: number;
  createRequests: number;
  estimatedReadCostUsd: number;
  estimatedCreateCostUsd: number;
  estimatedTotalCostUsd: number;
  byKind: Record<string, number>;
  updatedAt: string;
}

interface XApiBudgetState {
  usageByDate: Record<string, XApiUsageBucket>;
  lastRequestAtByKind: Record<string, string>;
  lastUpdated: string;
}

interface XBudgetPolicy {
  enabled: boolean;
  timezone: string;
  dailyMaxUsd: number;
  estimatedCostUsd: number;
  dailyRequestLimit: number;
  kind: string;
  minIntervalMinutes: number;
  requestType: XRequestType;
}

export interface XReadBudgetPolicy {
  enabled: boolean;
  timezone: string;
  dailyMaxUsd: number;
  estimatedReadCostUsd: number;
  dailyReadRequestLimit: number;
  kind: string;
  minIntervalMinutes: number;
}

export interface XCreateBudgetPolicy {
  enabled: boolean;
  timezone: string;
  dailyMaxUsd: number;
  estimatedCreateCostUsd: number;
  dailyCreateRequestLimit: number;
  kind: string;
  minIntervalMinutes: number;
}

export type XReadGuardBlockReason = "min-interval" | "daily-request-limit" | "daily-usd-limit";
export type XCreateGuardBlockReason = XReadGuardBlockReason;

interface XBudgetGuardDecision {
  allowed: boolean;
  reason?: XReadGuardBlockReason;
  waitSeconds?: number;
  projectedDailyCostUsd: number;
  remainingRequests: number;
  todayRequestCount: number;
  todayReadRequests: number;
  todayCreateRequests: number;
}

export interface XReadGuardDecision extends XBudgetGuardDecision {
  remainingReadRequests: number;
}

export interface XCreateGuardDecision extends XBudgetGuardDecision {
  remainingCreateRequests: number;
}

export interface XReadUsageSnapshot {
  dateKey: string;
  readRequests: number;
  createRequests: number;
  estimatedReadCostUsd: number;
  estimatedCreateCostUsd: number;
  estimatedTotalCostUsd: number;
  byKind: Record<string, number>;
}

export type XCreateUsageSnapshot = XReadUsageSnapshot;

function createEmptyState(): XApiBudgetState {
  return {
    usageByDate: {},
    lastRequestAtByKind: {},
    lastUpdated: new Date().toISOString(),
  };
}

export class XApiBudgetService {
  private readonly dataPath: string;
  private readonly now: () => Date;
  private state: XApiBudgetState;

  constructor(options?: { dataPath?: string; now?: () => Date }) {
    this.dataPath = options?.dataPath ? path.resolve(options.dataPath) : DEFAULT_DATA_PATH;
    this.now = typeof options?.now === "function" ? options.now : () => new Date();
    this.state = this.load();
  }

  checkReadAllowance(policy: XReadBudgetPolicy): XReadGuardDecision {
    const decision = this.checkAllowance({
      enabled: policy.enabled,
      timezone: policy.timezone,
      dailyMaxUsd: policy.dailyMaxUsd,
      estimatedCostUsd: policy.estimatedReadCostUsd,
      dailyRequestLimit: policy.dailyReadRequestLimit,
      kind: policy.kind,
      minIntervalMinutes: policy.minIntervalMinutes,
      requestType: "read",
    });

    return {
      ...decision,
      remainingReadRequests: decision.remainingRequests,
    };
  }

  checkCreateAllowance(policy: XCreateBudgetPolicy): XCreateGuardDecision {
    const decision = this.checkAllowance({
      enabled: policy.enabled,
      timezone: policy.timezone,
      dailyMaxUsd: policy.dailyMaxUsd,
      estimatedCostUsd: policy.estimatedCreateCostUsd,
      dailyRequestLimit: policy.dailyCreateRequestLimit,
      kind: policy.kind,
      minIntervalMinutes: policy.minIntervalMinutes,
      requestType: "create",
    });

    return {
      ...decision,
      remainingCreateRequests: decision.remainingRequests,
    };
  }

  recordRead(policy: Pick<XReadBudgetPolicy, "timezone" | "estimatedReadCostUsd" | "kind">): XReadUsageSnapshot {
    return this.recordUsage({
      timezone: policy.timezone,
      estimatedCostUsd: policy.estimatedReadCostUsd,
      kind: policy.kind,
      requestType: "read",
    });
  }

  recordCreate(policy: Pick<XCreateBudgetPolicy, "timezone" | "estimatedCreateCostUsd" | "kind">): XCreateUsageSnapshot {
    return this.recordUsage({
      timezone: policy.timezone,
      estimatedCostUsd: policy.estimatedCreateCostUsd,
      kind: policy.kind,
      requestType: "create",
    });
  }

  getTodayUsage(timezone: string): XReadUsageSnapshot {
    const dateKey = this.getDateKey(this.now(), this.normalizeTimezone(timezone));
    const bucket = this.ensureBucket(dateKey);
    return {
      dateKey: bucket.dateKey,
      readRequests: bucket.readRequests,
      createRequests: bucket.createRequests,
      estimatedReadCostUsd: bucket.estimatedReadCostUsd,
      estimatedCreateCostUsd: bucket.estimatedCreateCostUsd,
      estimatedTotalCostUsd: bucket.estimatedTotalCostUsd,
      byKind: { ...bucket.byKind },
    };
  }

  private checkAllowance(policy: XBudgetPolicy): XBudgetGuardDecision {
    const timezone = this.normalizeTimezone(policy.timezone);
    const estimatedCostUsd = this.clampNumber(policy.estimatedCostUsd, 0, 100, 0);
    const dailyMaxUsd = this.clampNumber(policy.dailyMaxUsd, 0, 1000, 0);
    const dailyRequestLimit = this.clampInt(policy.dailyRequestLimit, 0, 1_000_000, 0);
    const minIntervalMinutes = this.clampInt(policy.minIntervalMinutes, 0, 24 * 60, 0);
    const kind = this.normalizeKind(policy.kind);

    const nowDate = this.now();
    const bucket = this.ensureBucket(this.getDateKey(nowDate, timezone));
    const todayRequestCount = policy.requestType === "read" ? bucket.readRequests : bucket.createRequests;
    const projectedDailyCostUsd = this.roundUsd(bucket.estimatedTotalCostUsd + estimatedCostUsd);
    const remainingRequests = Math.max(0, dailyRequestLimit - todayRequestCount);

    if (!policy.enabled) {
      return {
        allowed: true,
        projectedDailyCostUsd,
        remainingRequests,
        todayRequestCount,
        todayReadRequests: bucket.readRequests,
        todayCreateRequests: bucket.createRequests,
      };
    }

    if (minIntervalMinutes > 0) {
      const lastRequestAt = this.state.lastRequestAtByKind[kind];
      const waitSeconds = this.getWaitSeconds(lastRequestAt, minIntervalMinutes, nowDate);
      if (waitSeconds > 0) {
        return {
          allowed: false,
          reason: "min-interval",
          waitSeconds,
          projectedDailyCostUsd,
          remainingRequests,
          todayRequestCount,
          todayReadRequests: bucket.readRequests,
          todayCreateRequests: bucket.createRequests,
        };
      }
    }

    if (dailyRequestLimit > 0 && todayRequestCount >= dailyRequestLimit) {
      return {
        allowed: false,
        reason: "daily-request-limit",
        projectedDailyCostUsd,
        remainingRequests: 0,
        todayRequestCount,
        todayReadRequests: bucket.readRequests,
        todayCreateRequests: bucket.createRequests,
      };
    }

    if (dailyMaxUsd > 0 && projectedDailyCostUsd - dailyMaxUsd > COST_EPSILON) {
      return {
        allowed: false,
        reason: "daily-usd-limit",
        projectedDailyCostUsd,
        remainingRequests,
        todayRequestCount,
        todayReadRequests: bucket.readRequests,
        todayCreateRequests: bucket.createRequests,
      };
    }

    return {
      allowed: true,
      projectedDailyCostUsd,
      remainingRequests,
      todayRequestCount,
      todayReadRequests: bucket.readRequests,
      todayCreateRequests: bucket.createRequests,
    };
  }

  private recordUsage(params: {
    timezone: string;
    estimatedCostUsd: number;
    kind: string;
    requestType: XRequestType;
  }): XReadUsageSnapshot {
    const timezone = this.normalizeTimezone(params.timezone);
    const date = this.now();
    const dateKey = this.getDateKey(date, timezone);
    const bucket = this.ensureBucket(dateKey);
    const kind = this.normalizeKind(params.kind);
    const requestCost = this.clampNumber(params.estimatedCostUsd, 0, 100, 0);

    if (params.requestType === "read") {
      bucket.readRequests += 1;
      bucket.estimatedReadCostUsd = this.roundUsd(bucket.estimatedReadCostUsd + requestCost);
    } else {
      bucket.createRequests += 1;
      bucket.estimatedCreateCostUsd = this.roundUsd(bucket.estimatedCreateCostUsd + requestCost);
    }

    bucket.estimatedTotalCostUsd = this.roundUsd(bucket.estimatedReadCostUsd + bucket.estimatedCreateCostUsd);
    bucket.byKind[kind] = (bucket.byKind[kind] || 0) + 1;
    bucket.updatedAt = date.toISOString();
    this.state.lastRequestAtByKind[kind] = date.toISOString();
    this.state.lastUpdated = date.toISOString();

    this.compactUsage(KEEP_DAYS);
    this.save();

    return {
      dateKey: bucket.dateKey,
      readRequests: bucket.readRequests,
      createRequests: bucket.createRequests,
      estimatedReadCostUsd: bucket.estimatedReadCostUsd,
      estimatedCreateCostUsd: bucket.estimatedCreateCostUsd,
      estimatedTotalCostUsd: bucket.estimatedTotalCostUsd,
      byKind: { ...bucket.byKind },
    };
  }

  private load(): XApiBudgetState {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      if (!fs.existsSync(this.dataPath)) {
        const empty = createEmptyState();
        this.persist(empty);
        return empty;
      }

      const raw = fs.readFileSync(this.dataPath, "utf-8");
      return this.normalizeState(JSON.parse(raw) as Partial<XApiBudgetState>);
    } catch {
      return createEmptyState();
    }
  }

  private normalizeState(raw: Partial<XApiBudgetState>): XApiBudgetState {
    const usageByDate: Record<string, XApiUsageBucket> = {};
    const now = new Date().toISOString();

    for (const [key, value] of Object.entries(raw.usageByDate || {})) {
      if (!value || typeof value !== "object") continue;
      const row = value as Partial<XApiUsageBucket> & { readCostUsd?: number; createCostUsd?: number };

      const readRequests = this.clampInt(row.readRequests, 0, 1_000_000, 0);
      const createRequests = this.clampInt(row.createRequests, 0, 1_000_000, 0);
      const estimatedReadCostUsd = this.roundUsd(this.clampNumber(row.estimatedReadCostUsd ?? row.readCostUsd, 0, 1_000_000, 0));
      const estimatedCreateCostUsd = this.roundUsd(this.clampNumber(row.estimatedCreateCostUsd ?? row.createCostUsd, 0, 1_000_000, 0));

      usageByDate[key] = {
        dateKey: typeof row.dateKey === "string" && row.dateKey ? row.dateKey : key,
        readRequests,
        createRequests,
        estimatedReadCostUsd,
        estimatedCreateCostUsd,
        estimatedTotalCostUsd: this.roundUsd(estimatedReadCostUsd + estimatedCreateCostUsd),
        byKind: this.normalizeByKind(row.byKind),
        updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : now,
      };
    }

    const lastRequestAtByKind: Record<string, string> = {};
    const legacyLastReadAtByKind = (raw as unknown as { lastReadAtByKind?: Record<string, string> }).lastReadAtByKind || {};
    const mergedLastRequestAt = {
      ...(raw.lastRequestAtByKind || {}),
      ...legacyLastReadAtByKind,
    };

    for (const [key, value] of Object.entries(mergedLastRequestAt)) {
      if (typeof value !== "string") continue;
      const kind = this.normalizeKind(key);
      if (!kind) continue;
      lastRequestAtByKind[kind] = value;
    }

    return {
      usageByDate,
      lastRequestAtByKind,
      lastUpdated: typeof raw.lastUpdated === "string" ? raw.lastUpdated : now,
    };
  }

  private normalizeByKind(raw: unknown): Record<string, number> {
    if (!raw || typeof raw !== "object") {
      return {};
    }
    const output: Record<string, number> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const kind = this.normalizeKind(key);
      if (!kind) continue;
      output[kind] = this.clampInt(value, 0, 1_000_000, 0);
    }
    return output;
  }

  private save(): void {
    this.persist(this.state);
  }

  private persist(state: XApiBudgetState): void {
    fs.mkdirSync(path.dirname(this.dataPath), { recursive: true });
    fs.writeFileSync(this.dataPath, JSON.stringify(state, null, 2));
  }

  private ensureBucket(dateKey: string): XApiUsageBucket {
    if (!this.state.usageByDate[dateKey]) {
      this.state.usageByDate[dateKey] = {
        dateKey,
        readRequests: 0,
        createRequests: 0,
        estimatedReadCostUsd: 0,
        estimatedCreateCostUsd: 0,
        estimatedTotalCostUsd: 0,
        byKind: {},
        updatedAt: this.now().toISOString(),
      };
    }
    return this.state.usageByDate[dateKey];
  }

  private getWaitSeconds(lastRequestAt: string | undefined, minIntervalMinutes: number, now: Date): number {
    if (!lastRequestAt || minIntervalMinutes <= 0) return 0;
    const last = new Date(lastRequestAt);
    if (Number.isNaN(last.getTime())) return 0;
    const cooldownMs = minIntervalMinutes * 60 * 1000;
    const elapsedMs = now.getTime() - last.getTime();
    if (elapsedMs >= cooldownMs) return 0;
    return Math.max(1, Math.ceil((cooldownMs - elapsedMs) / 1000));
  }

  private compactUsage(keepDays: number): void {
    const entries = Object.entries(this.state.usageByDate);
    if (entries.length <= keepDays) return;
    entries
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .slice(0, Math.max(0, entries.length - keepDays))
      .forEach(([key]) => {
        delete this.state.usageByDate[key];
      });
  }

  private getDateKey(date: Date, timezone: string): string {
    return date.toLocaleDateString("en-CA", { timeZone: timezone });
  }

  private normalizeKind(raw: string): string {
    return (
      String(raw || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9:_-]/g, "") || "unknown"
    );
  }

  private normalizeTimezone(raw: string): string {
    const value = String(raw || "").trim();
    return value || "Asia/Seoul";
  }

  private clampInt(value: unknown, min: number, max: number, fallback: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return fallback;
    }
    return Math.floor(Math.min(max, Math.max(min, value)));
  }

  private clampNumber(value: unknown, min: number, max: number, fallback: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, value));
  }

  private roundUsd(value: number): number {
    return Math.round(value * 10_000) / 10_000;
  }
}

export const xApiBudget = new XApiBudgetService();
