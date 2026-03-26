import fs from "fs";
import path from "path";
import { AnthropicCostRuntimeSettings, TotalCostRuntimeSettings } from "../types/runtime.js";
import { quarantineCorruptFile } from "./quarantine.js";
import { resolveSharedStatePath } from "./shared-state-dir.js";

const DEFAULT_DATA_PATH = resolveSharedStatePath("anthropic-budget.json");
const KEEP_DAYS = 21;
const COST_EPSILON = 1e-9;

interface AnthropicUsageBucket {
  dateKey: string;
  requestCount: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  estimatedTotalCostUsd: number;
  byKind: Record<string, number>;
  updatedAt: string;
}

interface AnthropicBudgetState {
  usageByDate: Record<string, AnthropicUsageBucket>;
  lastUpdated: string;
}

export interface AnthropicUsageSnapshot {
  dateKey: string;
  requestCount: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  estimatedTotalCostUsd: number;
  byKind: Record<string, number>;
}

export type AnthropicBudgetBlockReason =
  | "daily-request-limit"
  | "daily-usd-limit"
  | "combined-daily-usd-limit"
  | "state-unavailable"
  | "usage-sync-unavailable";
export type AnthropicBudgetMode = "full" | "degrade" | "local-only";

export interface AnthropicBudgetGuardDecision {
  allowed: boolean;
  reason?: AnthropicBudgetBlockReason;
  projectedDailyCostUsd: number;
  projectedTotalCostUsd: number;
  remainingRequests: number;
  todayRequestCount: number;
}

export interface AnthropicMessageCostEstimate {
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedTotalCostUsd: number;
}

export interface AnthropicBudgetModeDecision {
  mode: AnthropicBudgetMode;
  anthropicUtilization: number;
  totalUtilization: number;
  projectedAnthropicCostUsd: number;
  projectedTotalCostUsd: number;
  reason?: AnthropicBudgetBlockReason | "degrade-threshold" | "local-only-threshold";
}

function createEmptyState(): AnthropicBudgetState {
  return {
    usageByDate: {},
    lastUpdated: new Date().toISOString(),
  };
}

export function estimateAnthropicMessageCost(params: {
  model: string;
  system?: string;
  messages?: Array<{ content?: unknown }>;
  maxTokens?: number;
  pricing: AnthropicCostRuntimeSettings;
}): AnthropicMessageCostEstimate {
  const inputText = [
    typeof params.system === "string" ? params.system : "",
    ...(params.messages || []).map((item) => serializeMessageContent(item?.content)),
  ]
    .filter(Boolean)
    .join("\n");
  const inputTokens = estimateTokens(inputText);
  const outputTokens = Math.max(1, Math.floor(params.maxTokens || 256));
  const modelPricing = resolveAnthropicModelPricing(params.model, params.pricing);
  const estimatedTotalCostUsd = roundUsd(
    (inputTokens / 1_000_000) * modelPricing.inputCostPerMillionUsd +
    (outputTokens / 1_000_000) * modelPricing.outputCostPerMillionUsd
  );
  return {
    model: params.model,
    inputTokens,
    outputTokens,
    estimatedTotalCostUsd,
  };
}

export function resolveAnthropicBudgetMode(input: {
  estimatedRequestCostUsd: number;
  timezone: string;
  anthropicCostSettings: AnthropicCostRuntimeSettings;
  totalCostSettings: TotalCostRuntimeSettings;
  xApiEstimatedCostUsd: number;
  currentAnthropicUsage: AnthropicUsageSnapshot;
}): AnthropicBudgetModeDecision {
  const projectedAnthropicCostUsd = roundUsd(
    input.currentAnthropicUsage.estimatedTotalCostUsd + Math.max(0, input.estimatedRequestCostUsd)
  );
  const projectedTotalCostUsd = roundUsd(projectedAnthropicCostUsd + Math.max(0, input.xApiEstimatedCostUsd));
  const anthropicUtilization =
    input.anthropicCostSettings.dailyMaxUsd > 0
      ? projectedAnthropicCostUsd / input.anthropicCostSettings.dailyMaxUsd
      : 0;
  const totalUtilization =
    input.totalCostSettings.enabled && input.totalCostSettings.dailyMaxUsd > 0
      ? projectedTotalCostUsd / input.totalCostSettings.dailyMaxUsd
      : 0;

  if (!input.anthropicCostSettings.enabled) {
    return {
      mode: "full",
      anthropicUtilization: round2(anthropicUtilization),
      totalUtilization: round2(totalUtilization),
      projectedAnthropicCostUsd,
      projectedTotalCostUsd,
    };
  }

  if (
    input.anthropicCostSettings.dailyRequestLimit > 0 &&
    input.currentAnthropicUsage.requestCount >= input.anthropicCostSettings.dailyRequestLimit
  ) {
    return {
      mode: "local-only",
      anthropicUtilization: round2(anthropicUtilization),
      totalUtilization: round2(totalUtilization),
      projectedAnthropicCostUsd,
      projectedTotalCostUsd,
      reason: "daily-request-limit",
    };
  }

  if (
    input.anthropicCostSettings.dailyMaxUsd > 0 &&
    projectedAnthropicCostUsd - input.anthropicCostSettings.dailyMaxUsd > COST_EPSILON
  ) {
    return {
      mode: "local-only",
      anthropicUtilization: round2(anthropicUtilization),
      totalUtilization: round2(totalUtilization),
      projectedAnthropicCostUsd,
      projectedTotalCostUsd,
      reason: "daily-usd-limit",
    };
  }

  if (
    input.totalCostSettings.enabled &&
    input.totalCostSettings.dailyMaxUsd > 0 &&
    projectedTotalCostUsd - input.totalCostSettings.dailyMaxUsd > COST_EPSILON
  ) {
    return {
      mode: "local-only",
      anthropicUtilization: round2(anthropicUtilization),
      totalUtilization: round2(totalUtilization),
      projectedAnthropicCostUsd,
      projectedTotalCostUsd,
      reason: "combined-daily-usd-limit",
    };
  }

  if (
    anthropicUtilization >= input.anthropicCostSettings.localOnlyAtUtilization ||
    (
      input.totalCostSettings.enabled &&
      totalUtilization >= input.anthropicCostSettings.localOnlyAtUtilization
    )
  ) {
    return {
      mode: "local-only",
      anthropicUtilization: round2(anthropicUtilization),
      totalUtilization: round2(totalUtilization),
      projectedAnthropicCostUsd,
      projectedTotalCostUsd,
      reason: "local-only-threshold",
    };
  }

  if (
    anthropicUtilization >= input.anthropicCostSettings.degradeAtUtilization ||
    (
      input.totalCostSettings.enabled &&
      totalUtilization >= input.anthropicCostSettings.degradeAtUtilization
    )
  ) {
    return {
      mode: "degrade",
      anthropicUtilization: round2(anthropicUtilization),
      totalUtilization: round2(totalUtilization),
      projectedAnthropicCostUsd,
      projectedTotalCostUsd,
      reason: "degrade-threshold",
    };
  }

  return {
    mode: "full",
    anthropicUtilization: round2(anthropicUtilization),
    totalUtilization: round2(totalUtilization),
    projectedAnthropicCostUsd,
    projectedTotalCostUsd,
  };
}

export class AnthropicBudgetService {
  private readonly dataPath: string;
  private readonly now: () => Date;
  private readonly failClosedOnStateError: boolean;
  private state: AnthropicBudgetState;
  private stateHealthy: boolean;

  constructor(options?: { dataPath?: string; now?: () => Date; failClosedOnStateError?: boolean }) {
    this.dataPath = options?.dataPath ? path.resolve(options.dataPath) : DEFAULT_DATA_PATH;
    this.now = typeof options?.now === "function" ? options.now : () => new Date();
    this.failClosedOnStateError =
      typeof options?.failClosedOnStateError === "boolean"
        ? options.failClosedOnStateError
        : String(process.env.ANTHROPIC_FAIL_CLOSED_ON_STATE_ERROR || "true").trim().toLowerCase() !== "false";
    this.stateHealthy = true;
    this.state = this.load();
  }

  isHealthy(): boolean {
    return this.stateHealthy;
  }

  checkAllowance(input: {
    enabled: boolean;
    timezone: string;
    dailyMaxUsd: number;
    dailyRequestLimit: number;
    estimatedCostUsd: number;
    totalDailyMaxUsd?: number;
    xApiEstimatedCostUsd?: number;
  }): AnthropicBudgetGuardDecision {
    const timezone = normalizeTimezone(input.timezone);
    const bucket = this.ensureBucket(getDateKey(this.now(), timezone));
    const estimatedCostUsd = clampNumber(input.estimatedCostUsd, 0, 100, 0);
    const dailyMaxUsd = clampNumber(input.dailyMaxUsd, 0, 1000, 0);
    const totalDailyMaxUsd = clampNumber(input.totalDailyMaxUsd, 0, 1000, 0);
    const xApiEstimatedCostUsd = clampNumber(input.xApiEstimatedCostUsd, 0, 1000, 0);
    const dailyRequestLimit = clampInt(input.dailyRequestLimit, 0, 1_000_000, 0);

    const projectedDailyCostUsd = roundUsd(bucket.estimatedTotalCostUsd + estimatedCostUsd);
    const projectedTotalCostUsd = roundUsd(projectedDailyCostUsd + xApiEstimatedCostUsd);
    const remainingRequests = Math.max(0, dailyRequestLimit - bucket.requestCount);

    if (!input.enabled) {
      return {
        allowed: true,
        projectedDailyCostUsd,
        projectedTotalCostUsd,
        remainingRequests,
        todayRequestCount: bucket.requestCount,
      };
    }

    if (this.failClosedOnStateError && !this.stateHealthy) {
      return {
        allowed: false,
        reason: "state-unavailable",
        projectedDailyCostUsd,
        projectedTotalCostUsd,
        remainingRequests,
        todayRequestCount: bucket.requestCount,
      };
    }

    if (dailyRequestLimit > 0 && bucket.requestCount >= dailyRequestLimit) {
      return {
        allowed: false,
        reason: "daily-request-limit",
        projectedDailyCostUsd,
        projectedTotalCostUsd,
        remainingRequests: 0,
        todayRequestCount: bucket.requestCount,
      };
    }

    if (dailyMaxUsd > 0 && projectedDailyCostUsd - dailyMaxUsd > COST_EPSILON) {
      return {
        allowed: false,
        reason: "daily-usd-limit",
        projectedDailyCostUsd,
        projectedTotalCostUsd,
        remainingRequests,
        todayRequestCount: bucket.requestCount,
      };
    }

    if (totalDailyMaxUsd > 0 && projectedTotalCostUsd - totalDailyMaxUsd > COST_EPSILON) {
      return {
        allowed: false,
        reason: "combined-daily-usd-limit",
        projectedDailyCostUsd,
        projectedTotalCostUsd,
        remainingRequests,
        todayRequestCount: bucket.requestCount,
      };
    }

    return {
      allowed: true,
      projectedDailyCostUsd,
      projectedTotalCostUsd,
      remainingRequests,
      todayRequestCount: bucket.requestCount,
    };
  }

  recordUsage(input: {
    timezone: string;
    kind: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
    estimatedCostUsd?: number;
    pricing: AnthropicCostRuntimeSettings;
  }): AnthropicUsageSnapshot {
    const timezone = normalizeTimezone(input.timezone);
    const bucket = this.ensureBucket(getDateKey(this.now(), timezone));
    const modelPricing = resolveAnthropicModelPricing(input.model, input.pricing);
    const totalInputTokens = Math.max(0, Math.floor(input.inputTokens));
    const cacheCreationInputTokens = Math.max(0, Math.floor(input.cacheCreationInputTokens || 0));
    const cacheReadInputTokens = Math.max(0, Math.floor(input.cacheReadInputTokens || 0));
    const directInputTokens = Math.max(0, totalInputTokens - cacheCreationInputTokens - cacheReadInputTokens);
    const estimatedCostUsd =
      typeof input.estimatedCostUsd === "number" && Number.isFinite(input.estimatedCostUsd)
        ? Math.max(0, input.estimatedCostUsd)
        : roundUsd(
            (directInputTokens / 1_000_000) * modelPricing.inputCostPerMillionUsd +
            (cacheCreationInputTokens / 1_000_000) *
              modelPricing.inputCostPerMillionUsd *
              input.pricing.cacheWriteMultiplier +
            (cacheReadInputTokens / 1_000_000) *
              modelPricing.inputCostPerMillionUsd *
              input.pricing.cacheReadMultiplier +
            (Math.max(0, input.outputTokens) / 1_000_000) * modelPricing.outputCostPerMillionUsd
          );
    const kind = normalizeKind(input.kind);
    bucket.requestCount += 1;
    bucket.estimatedInputTokens += totalInputTokens;
    bucket.estimatedOutputTokens += Math.max(0, Math.floor(input.outputTokens));
    bucket.cacheCreationInputTokens += cacheCreationInputTokens;
    bucket.cacheReadInputTokens += cacheReadInputTokens;
    bucket.estimatedTotalCostUsd = roundUsd(bucket.estimatedTotalCostUsd + estimatedCostUsd);
    bucket.byKind[kind] = (bucket.byKind[kind] || 0) + 1;
    bucket.updatedAt = this.now().toISOString();
    this.state.lastUpdated = bucket.updatedAt;
    try {
      this.persist(this.state);
    } catch {
      this.stateHealthy = false;
      throw new Error("anthropic-budget-state-unavailable");
    }

    return {
      dateKey: bucket.dateKey,
      requestCount: bucket.requestCount,
      estimatedInputTokens: bucket.estimatedInputTokens,
      estimatedOutputTokens: bucket.estimatedOutputTokens,
      cacheCreationInputTokens: bucket.cacheCreationInputTokens,
      cacheReadInputTokens: bucket.cacheReadInputTokens,
      estimatedTotalCostUsd: bucket.estimatedTotalCostUsd,
      byKind: { ...bucket.byKind },
    };
  }

  getTodayUsage(timezone: string): AnthropicUsageSnapshot {
    const bucket = this.ensureBucket(getDateKey(this.now(), normalizeTimezone(timezone)));
    return {
      dateKey: bucket.dateKey,
      requestCount: bucket.requestCount,
      estimatedInputTokens: bucket.estimatedInputTokens,
      estimatedOutputTokens: bucket.estimatedOutputTokens,
      cacheCreationInputTokens: bucket.cacheCreationInputTokens,
      cacheReadInputTokens: bucket.cacheReadInputTokens,
      estimatedTotalCostUsd: bucket.estimatedTotalCostUsd,
      byKind: { ...bucket.byKind },
    };
  }

  flushNow(): void {
    try {
      this.persist(this.state);
    } catch {
      this.stateHealthy = false;
    }
  }

  private ensureBucket(dateKey: string): AnthropicUsageBucket {
    this.pruneOldBuckets();
    if (!this.state.usageByDate[dateKey]) {
      this.state.usageByDate[dateKey] = {
        dateKey,
        requestCount: 0,
        estimatedInputTokens: 0,
        estimatedOutputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        estimatedTotalCostUsd: 0,
        byKind: {},
        updatedAt: this.now().toISOString(),
      };
    }
    return this.state.usageByDate[dateKey];
  }

  private pruneOldBuckets(): void {
    const cutoff = new Date(this.now().getTime() - KEEP_DAYS * 24 * 60 * 60 * 1000);
    for (const key of Object.keys(this.state.usageByDate)) {
      if (new Date(`${key}T00:00:00.000Z`).getTime() < cutoff.getTime()) {
        delete this.state.usageByDate[key];
      }
    }
  }

  private load(): AnthropicBudgetState {
    try {
      if (!fs.existsSync(this.dataPath)) {
        fs.mkdirSync(path.dirname(this.dataPath), { recursive: true });
        const empty = createEmptyState();
        fs.writeFileSync(this.dataPath, `${JSON.stringify(empty, null, 2)}\n`, "utf-8");
        this.stateHealthy = true;
        return empty;
      }
      const raw = fs.readFileSync(this.dataPath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<AnthropicBudgetState>;
      this.stateHealthy = true;
      return this.normalizeState(parsed);
    } catch (error) {
      const raw = safeReadRaw(this.dataPath);
      if (raw) {
        const quarantined = quarantineCorruptFile({
          filePath: this.dataPath,
          raw,
          reason: "anthropic-budget-json-parse-failure",
        });
        if (quarantined) {
          console.error(`[LLM-BUDGET] 손상 파일 격리됨: ${quarantined}`);
        }
      }
      this.stateHealthy = false;
      return createEmptyState();
    }
  }

  private normalizeState(raw: Partial<AnthropicBudgetState>): AnthropicBudgetState {
    const usageByDate = raw.usageByDate && typeof raw.usageByDate === "object" ? raw.usageByDate : {};
    const state = createEmptyState();
    for (const [dateKey, bucket] of Object.entries(usageByDate)) {
      const row = bucket as Partial<AnthropicUsageBucket>;
      state.usageByDate[dateKey] = {
        dateKey,
        requestCount: clampInt(row.requestCount, 0, 1_000_000, 0),
        estimatedInputTokens: clampInt(row.estimatedInputTokens, 0, 1_000_000_000, 0),
        estimatedOutputTokens: clampInt(row.estimatedOutputTokens, 0, 1_000_000_000, 0),
        cacheCreationInputTokens: clampInt(row.cacheCreationInputTokens, 0, 1_000_000_000, 0),
        cacheReadInputTokens: clampInt(row.cacheReadInputTokens, 0, 1_000_000_000, 0),
        estimatedTotalCostUsd: clampNumber(row.estimatedTotalCostUsd, 0, 100_000, 0),
        byKind: normalizeByKind(row.byKind),
        updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : new Date().toISOString(),
      };
    }
    state.lastUpdated = typeof raw.lastUpdated === "string" ? raw.lastUpdated : new Date().toISOString();
    return state;
  }

  private persist(state: AnthropicBudgetState): void {
    fs.mkdirSync(path.dirname(this.dataPath), { recursive: true });
    fs.writeFileSync(this.dataPath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
    this.stateHealthy = true;
  }
}

function serializeMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && "text" in item) {
          return String((item as { text?: unknown }).text || "");
        }
        try {
          return JSON.stringify(item);
        } catch {
          return "";
        }
      })
      .filter(Boolean)
      .join("\n");
  }
  try {
    return JSON.stringify(content);
  } catch {
    return "";
  }
}

function estimateTokens(text: string): number {
  const normalized = String(text || "").trim();
  if (!normalized) return 0;
  return Math.max(1, Math.ceil(normalized.length / 4));
}

function resolveAnthropicModelPricing(model: string, pricing: AnthropicCostRuntimeSettings): {
  inputCostPerMillionUsd: number;
  outputCostPerMillionUsd: number;
} {
  if (/haiku/i.test(model)) {
    return {
      inputCostPerMillionUsd: pricing.researchInputCostPerMillionUsd,
      outputCostPerMillionUsd: pricing.researchOutputCostPerMillionUsd,
    };
  }
  return {
    inputCostPerMillionUsd: pricing.primaryInputCostPerMillionUsd,
    outputCostPerMillionUsd: pricing.primaryOutputCostPerMillionUsd,
  };
}

function normalizeTimezone(timezone: string): string {
  return typeof timezone === "string" && timezone.trim().length > 0 ? timezone.trim() : "Asia/Seoul";
}

function normalizeKind(kind: string): string {
  const normalized = String(kind || "").trim();
  return normalized.length > 0 ? normalized.slice(0, 120) : "unknown";
}

function normalizeByKind(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    out[normalizeKind(key)] = clampInt(value, 0, 1_000_000, 0);
  }
  return out;
}

function getDateKey(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function safeReadRaw(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function roundUsd(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1000) / 1000;
}

function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

export const anthropicBudget = new AnthropicBudgetService();
