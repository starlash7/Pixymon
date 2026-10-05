import fs from "fs";
import path from "path";
import { randomUUID } from "node:crypto";
import type { AnthropicCostRuntimeSettings, TotalCostRuntimeSettings } from "../types/runtime.js";
import { resolveDataDir } from "./data-dir.js";
import { acquireRuntimeLock } from "./process-lock.js";

const DATA_DIR = resolveDataDir();
const DEFAULT_DATA_PATH = path.join(DATA_DIR, "anthropic-budget.json");
const KEEP_DAYS = 21;
const USD_SCALE = 1_000_000_000;
const COST_EPSILON = 1 / (USD_SCALE * 2);

interface AnthropicUsageBucket {
  dateKey: string;
  requestCount: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  estimatedTotalCostUsd: number;
  // Conservative confirmed basis: provider floors plus later settled charges.
  settledCostUsd: number;
  minimumDailyCostUsd: number;
  byKind: Record<string, number>;
  updatedAt: string;
}

interface AnthropicRequestReservation {
  dateKey: string;
  kind: string;
  estimatedCostUsd: number;
  createdAt: string;
}

interface AnthropicBudgetState {
  usageByDate: Record<string, AnthropicUsageBucket>;
  pendingReservations: Record<string, AnthropicRequestReservation>;
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

export type AnthropicBudgetBlockReason = "daily-request-limit" | "daily-usd-limit" | "combined-daily-usd-limit";
export type AnthropicBudgetMode = "full" | "degrade" | "local-only";

export interface AnthropicBudgetGuardDecision {
  allowed: boolean;
  reason?: AnthropicBudgetBlockReason;
  projectedDailyCostUsd: number;
  projectedTotalCostUsd: number;
  remainingRequests: number;
  todayRequestCount: number;
}

export interface AnthropicBudgetAllowanceInput {
  enabled: boolean;
  timezone: string;
  dailyMaxUsd: number;
  dailyRequestLimit: number;
  estimatedCostUsd: number;
  totalDailyMaxUsd?: number;
  xApiEstimatedCostUsd?: number;
  // Confirmed provider cost only; do not pass a snapshot including reservations.
  minimumDailyCostUsd?: number;
  minimumRequestCount?: number;
}

export type AnthropicBudgetReservationDecision = AnthropicBudgetGuardDecision & (
  { allowed: true; reservationId: string } | { allowed: false; reservationId?: never }
);

export interface AnthropicUsageInput {
  model: string;
  // Anthropic input_tokens is uncached input; cache tokens are separate counters.
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  estimatedCostUsd?: number;
  pricing: AnthropicCostRuntimeSettings;
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
    usageByDate: Object.create(null),
    pendingReservations: Object.create(null),
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
  private hasLoadedState = false;

  constructor(options?: { dataPath?: string; now?: () => Date }) {
    this.dataPath = path.resolve(options?.dataPath || DEFAULT_DATA_PATH);
    this.now = typeof options?.now === "function" ? options.now : () => new Date();
    // Construction and usage inspection must not create or rewrite budget files.
  }

  checkAllowance(input: AnthropicBudgetAllowanceInput): AnthropicBudgetGuardDecision {
    const state = this.load();
    const bucket = this.bucketFor(state, input.timezone);
    return this.decideAllowance(bucket, input, pendingCostFor(state, bucket.dateKey));
  }

  syncConfirmedUsageFloor(input: {
    timezone: string;
    dateKey: string;
    minimumDailyCostUsd: number;
    minimumRequestCount?: number;
  }): AnthropicUsageSnapshot {
    return this.withLock(() => {
      const state = this.load();
      const bucket = this.bucketFor(state, input.timezone);
      // A report fetched before midnight must not charge the following day.
      if (input.dateKey !== bucket.dateKey) return snapshot(bucket);
      const floor = requireNonnegativeNumber(input.minimumDailyCostUsd, "minimumDailyCostUsd");
      const count = requireNonnegativeInteger(input.minimumRequestCount ?? 0, "minimumRequestCount");
      const previousFloor = bucket.minimumDailyCostUsd;
      const previousBasis = bucket.settledCostUsd;
      const previousCount = bucket.requestCount;
      bucket.minimumDailyCostUsd = Math.max(previousFloor, floor);
      bucket.settledCostUsd = Math.max(previousBasis, bucket.minimumDailyCostUsd);
      bucket.requestCount = Math.max(previousCount, count);
      if (bucket.minimumDailyCostUsd !== previousFloor || bucket.settledCostUsd !== previousBasis ||
          bucket.requestCount !== previousCount) {
        this.touchAndPersist(state, bucket);
      }
      return snapshot(bucket);
    });
  }

  reserveRequest(input: AnthropicBudgetAllowanceInput & { kind: string }): AnthropicBudgetReservationDecision {
    return this.withLock(() => {
      const state = this.load();
      const bucket = this.bucketFor(state, input.timezone);
      // Confirmed provider cost is a durable floor independent of pending
      // estimates. Otherwise settling one call could erase known billed spend.
      const previousFloor = bucket.minimumDailyCostUsd;
      const previousCount = bucket.requestCount;
      bucket.minimumDailyCostUsd = Math.max(
        previousFloor,
        requireNonnegativeNumber(input.minimumDailyCostUsd ?? 0, "minimumDailyCostUsd")
      );
      bucket.settledCostUsd = Math.max(bucket.settledCostUsd, bucket.minimumDailyCostUsd);
      bucket.requestCount = Math.max(
        previousCount,
        requireNonnegativeInteger(input.minimumRequestCount ?? 0, "minimumRequestCount")
      );
      const decision = this.decideAllowance(bucket, input, pendingCostFor(state, bucket.dateKey));
      if (!decision.allowed) {
        // Even a denied call must not let a later stale caller forget a newer
        // confirmed floor. No request or estimated spend is added on denial.
        if (bucket.minimumDailyCostUsd !== previousFloor || bucket.requestCount !== previousCount) {
          this.touchAndPersist(state, bucket);
        }
        return { ...decision, allowed: false };
      }

      const estimatedCostUsd = roundUsd(requireNonnegativeNumber(input.estimatedCostUsd, "estimatedCostUsd"));
      const kind = normalizeKind(input.kind);
      const reservationId = randomUUID();
      bucket.requestCount += 1;
      bucket.byKind[kind] = (bucket.byKind[kind] || 0) + 1;
      state.pendingReservations[reservationId] = {
        dateKey: bucket.dateKey,
        kind,
        estimatedCostUsd,
        createdAt: this.now().toISOString(),
      };
      this.touchAndPersist(state, bucket);
      return { ...decision, allowed: true, reservationId };
    });
  }

  settleRequest(input: AnthropicUsageInput & { reservationId: string }): AnthropicUsageSnapshot {
    return this.withLock(() => {
      const state = this.load();
      const reservation = state.pendingReservations[input.reservationId];
      if (!reservation) throw new Error("[LLM-BUDGET] Unknown or already settled reservation");
      const bucket = state.usageByDate[reservation.dateKey];
      // Charge the day that admitted the request, including calls finishing
      // after midnight. Never increment the already-reserved request count.
      this.addUsage(bucket, input);
      delete state.pendingReservations[input.reservationId];
      this.touchAndPersist(state, bucket);
      return snapshot(bucket);
    });
  }

  // Compatibility for importing known usage. Paid calls must reserve first.
  recordUsage(input: AnthropicUsageInput & { timezone: string; kind: string }): AnthropicUsageSnapshot {
    return this.withLock(() => {
      const state = this.load();
      const bucket = this.bucketFor(state, input.timezone);
      const kind = normalizeKind(input.kind);
      this.addUsage(bucket, input);
      bucket.requestCount += 1;
      bucket.byKind[kind] = (bucket.byKind[kind] || 0) + 1;
      this.touchAndPersist(state, bucket);
      return snapshot(bucket);
    });
  }

  getTodayUsage(timezone: string): AnthropicUsageSnapshot {
    return snapshot(this.bucketFor(this.load(), timezone));
  }

  flushNow(): void {
    // Each mutation is already synchronously durable. In particular, never
    // overwrite newer usage from another process with an in-memory snapshot.
  }

  private decideAllowance(bucket: AnthropicUsageBucket, input: AnthropicBudgetAllowanceInput, pendingCostUsd: number): AnthropicBudgetGuardDecision {
    const estimatedCostUsd = roundUsd(requireNonnegativeNumber(input.estimatedCostUsd, "estimatedCostUsd"));
    const dailyMaxUsd = requireNonnegativeNumber(input.dailyMaxUsd, "dailyMaxUsd");
    const totalDailyMaxUsd = requireNonnegativeNumber(input.totalDailyMaxUsd ?? 0, "totalDailyMaxUsd");
    const xApiEstimatedCostUsd = requireNonnegativeNumber(input.xApiEstimatedCostUsd ?? 0, "xApiEstimatedCostUsd");
    const dailyRequestLimit = requireNonnegativeInteger(input.dailyRequestLimit, "dailyRequestLimit");
    const todayRequestCount = Math.max(
      bucket.requestCount,
      requireNonnegativeInteger(input.minimumRequestCount ?? 0, "minimumRequestCount")
    );
    const projectedDailyCostUsd = roundUsd(Math.max(
      bucket.settledCostUsd,
      bucket.minimumDailyCostUsd,
      requireNonnegativeNumber(input.minimumDailyCostUsd ?? 0, "minimumDailyCostUsd")
    ) + pendingCostUsd + estimatedCostUsd);
    const projectedTotalCostUsd = roundUsd(projectedDailyCostUsd + xApiEstimatedCostUsd);
    const remainingRequests = Math.max(0, dailyRequestLimit - todayRequestCount);
    const common = { projectedDailyCostUsd, projectedTotalCostUsd, remainingRequests, todayRequestCount };

    if (!input.enabled) return { ...common, allowed: true };
    if (dailyRequestLimit > 0 && todayRequestCount >= dailyRequestLimit) {
      return { ...common, allowed: false, reason: "daily-request-limit" };
    }
    if (dailyMaxUsd > 0 && projectedDailyCostUsd - dailyMaxUsd > COST_EPSILON) {
      return { ...common, allowed: false, reason: "daily-usd-limit" };
    }
    if (totalDailyMaxUsd > 0 && projectedTotalCostUsd - totalDailyMaxUsd > COST_EPSILON) {
      return { ...common, allowed: false, reason: "combined-daily-usd-limit" };
    }
    return { ...common, allowed: true };
  }

  private addUsage(bucket: AnthropicUsageBucket, input: AnthropicUsageInput): void {
    const inputTokens = requireNonnegativeInteger(input.inputTokens, "inputTokens");
    const outputTokens = requireNonnegativeInteger(input.outputTokens, "outputTokens");
    const cacheCreationInputTokens = requireNonnegativeInteger(input.cacheCreationInputTokens ?? 0, "cacheCreationInputTokens");
    const cacheReadInputTokens = requireNonnegativeInteger(input.cacheReadInputTokens ?? 0, "cacheReadInputTokens");
    const modelPricing = resolveAnthropicModelPricing(input.model, input.pricing);
    const inputPrice = requireNonnegativeNumber(modelPricing.inputCostPerMillionUsd, "inputCostPerMillionUsd");
    const outputPrice = requireNonnegativeNumber(modelPricing.outputCostPerMillionUsd, "outputCostPerMillionUsd");
    const writeMultiplier = requireNonnegativeNumber(input.pricing.cacheWriteMultiplier, "cacheWriteMultiplier");
    const readMultiplier = requireNonnegativeNumber(input.pricing.cacheReadMultiplier, "cacheReadMultiplier");
    const estimatedCostUsd = roundUsd(input.estimatedCostUsd === undefined
      ? (inputTokens * inputPrice + cacheCreationInputTokens * inputPrice * writeMultiplier +
          cacheReadInputTokens * inputPrice * readMultiplier + outputTokens * outputPrice) / 1_000_000
      : requireNonnegativeNumber(input.estimatedCostUsd, "estimatedCostUsd"));
    bucket.estimatedInputTokens += inputTokens;
    bucket.estimatedOutputTokens += outputTokens;
    bucket.cacheCreationInputTokens += cacheCreationInputTokens;
    bucket.cacheReadInputTokens += cacheReadInputTokens;
    // A provider floor is already-confirmed spend, not reusable credit. New
    // actual usage adds to that basis, even when a delayed report may overlap
    // an in-flight call. Conservative double-counting is safer than reuse.
    bucket.settledCostUsd = roundUsd(Math.max(bucket.settledCostUsd, bucket.minimumDailyCostUsd) + estimatedCostUsd);
  }

  private bucketFor(state: AnthropicBudgetState, timezone: string): AnthropicUsageBucket {
    const dateKey = getDateKey(this.now(), normalizeTimezone(timezone));
    if (!state.usageByDate[dateKey]) {
      state.usageByDate[dateKey] = {
        dateKey,
        requestCount: 0,
        estimatedInputTokens: 0,
        estimatedOutputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        estimatedTotalCostUsd: 0,
        settledCostUsd: 0,
        minimumDailyCostUsd: 0,
        byKind: Object.create(null),
        updatedAt: this.now().toISOString(),
      };
    }
    return state.usageByDate[dateKey];
  }

  private withLock<T>(operation: () => T): T {
    const lock = acquireRuntimeLock(`${this.dataPath}.lock`);
    if (!lock.acquired) throw new Error(`[LLM-BUDGET] Budget lock unavailable: ${lock.reason}`);
    try {
      return operation();
    } finally {
      lock.release();
    }
  }

  private touchAndPersist(state: AnthropicBudgetState, bucket: AnthropicUsageBucket): void {
    bucket.estimatedTotalCostUsd = roundUsd(
      Math.max(bucket.settledCostUsd, bucket.minimumDailyCostUsd) + pendingCostFor(state, bucket.dateKey)
    );
    bucket.updatedAt = this.now().toISOString();
    state.lastUpdated = bucket.updatedAt;
    // Never forget an uncertain paid request simply because a retention timer
    // elapsed. Pending reservations remain inspectable until explicitly settled.
    const pendingDates = new Set(Object.values(state.pendingReservations).map((row) => row.dateKey));
    const cutoff = this.now().getTime() - KEEP_DAYS * 24 * 60 * 60 * 1000;
    for (const dateKey of Object.keys(state.usageByDate)) {
      if (dateKey !== bucket.dateKey && !pendingDates.has(dateKey) && new Date(`${dateKey}T00:00:00.000Z`).getTime() < cutoff) {
        delete state.usageByDate[dateKey];
      }
    }
    this.persist(state);
  }

  private load(): AnthropicBudgetState {
    let raw: string;
    try {
      raw = fs.readFileSync(this.dataPath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && !this.hasLoadedState) return createEmptyState();
      throw new Error(`[LLM-BUDGET] Cannot read budget state: ${String(error)}`);
    }
    this.hasLoadedState = true;
    try {
      return parseState(JSON.parse(raw));
    } catch (error) {
      // Leave the original in place: quarantining-and-resetting grants a fresh
      // budget on the next process restart and silently forgets billed spend.
      throw new Error(`[LLM-BUDGET] Invalid budget state; manual recovery required: ${String(error)}`);
    }
  }

  private persist(state: AnthropicBudgetState): void {
    // Validate calculated totals too (overflow/precision errors fail closed).
    parseState(state);
    const directory = path.dirname(this.dataPath);
    const temporaryPath = `${this.dataPath}.${process.pid}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    let directoryFd: number | undefined;
    try {
      fs.mkdirSync(directory, { recursive: true });
      fd = fs.openSync(temporaryPath, "wx", 0o600);
      fs.writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temporaryPath, this.dataPath);
      this.hasLoadedState = true;
      directoryFd = fs.openSync(directory, "r");
      fs.fsyncSync(directoryFd);
    } catch (error) {
      throw new Error(`[LLM-BUDGET] Cannot persist budget state: ${String(error)}`);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (directoryFd !== undefined) fs.closeSync(directoryFd);
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    }
  }
}

function snapshot(bucket: AnthropicUsageBucket): AnthropicUsageSnapshot {
  const { updatedAt: _updatedAt, settledCostUsd: _settledCostUsd, minimumDailyCostUsd: _minimumDailyCostUsd, ...usage } = bucket;
  return { ...usage, byKind: { ...bucket.byKind } };
}

function pendingCostFor(state: AnthropicBudgetState, dateKey: string): number {
  return Object.values(state.pendingReservations)
    .filter((reservation) => reservation.dateKey === dateKey)
    .reduce((cost, reservation) => roundUsd(cost + reservation.estimatedCostUsd), 0);
}

function requireRecord(raw: unknown, name: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Invalid ${name}`);
  return raw as Record<string, unknown>;
}

function requireNonnegativeNumber(raw: unknown, name: string): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) throw new Error(`Invalid ${name}`);
  return raw;
}

function requireNonnegativeInteger(raw: unknown, name: string): number {
  const value = requireNonnegativeNumber(raw, name);
  if (!Number.isSafeInteger(value)) throw new Error(`Invalid ${name}`);
  return value;
}

function requireTimestamp(raw: unknown, name: string): string {
  if (typeof raw !== "string" || !Number.isFinite(Date.parse(raw))) throw new Error(`Invalid ${name}`);
  return raw;
}

function parseState(raw: unknown): AnthropicBudgetState {
  const root = requireRecord(raw, "budget state");
  const usageByDate = requireRecord(root.usageByDate, "usageByDate");
  const state = createEmptyState();
  state.lastUpdated = requireTimestamp(root.lastUpdated, "lastUpdated");
  for (const [dateKey, rawBucket] of Object.entries(usageByDate)) {
    const row = requireRecord(rawBucket, "usage bucket");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) ||
        !Number.isFinite(Date.parse(`${dateKey}T00:00:00.000Z`)) ||
        new Date(`${dateKey}T00:00:00.000Z`).toISOString().slice(0, 10) !== dateKey || row.dateKey !== dateKey) {
      throw new Error("Invalid bucket date");
    }
    const byKind: Record<string, number> = Object.create(null);
    for (const [kind, count] of Object.entries(requireRecord(row.byKind, "byKind"))) {
      byKind[kind] = requireNonnegativeInteger(count, "kind count");
    }
    state.usageByDate[dateKey] = {
      dateKey,
      requestCount: requireNonnegativeInteger(row.requestCount, "requestCount"),
      estimatedInputTokens: requireNonnegativeInteger(row.estimatedInputTokens, "estimatedInputTokens"),
      estimatedOutputTokens: requireNonnegativeInteger(row.estimatedOutputTokens, "estimatedOutputTokens"),
      cacheCreationInputTokens: requireNonnegativeInteger(row.cacheCreationInputTokens === undefined ? 0 : row.cacheCreationInputTokens, "cacheCreationInputTokens"),
      cacheReadInputTokens: requireNonnegativeInteger(row.cacheReadInputTokens === undefined ? 0 : row.cacheReadInputTokens, "cacheReadInputTokens"),
      estimatedTotalCostUsd: requireNonnegativeNumber(row.estimatedTotalCostUsd, "estimatedTotalCostUsd"),
      settledCostUsd: requireNonnegativeNumber(row.settledCostUsd === undefined ? 0 : row.settledCostUsd, "settledCostUsd"),
      minimumDailyCostUsd: requireNonnegativeNumber(row.minimumDailyCostUsd === undefined ? 0 : row.minimumDailyCostUsd, "minimumDailyCostUsd"),
      byKind,
      updatedAt: requireTimestamp(row.updatedAt, "updatedAt"),
    };
    const kindTotal = Object.values(byKind).reduce((total, count) => total + count, 0);
    if (!Number.isSafeInteger(kindTotal) || kindTotal > state.usageByDate[dateKey].requestCount) {
      throw new Error("Kind counts exceed recorded request count");
    }
  }
  // Files written before reservations were introduced remain readable.
  const reservations = root.pendingReservations === undefined ? {} : requireRecord(root.pendingReservations, "pendingReservations");
  const pendingByDate: Record<string, { count: number; costUsd: number }> = Object.create(null);
  for (const [id, rawReservation] of Object.entries(reservations)) {
    const row = requireRecord(rawReservation, "reservation");
    if (!id || typeof row.dateKey !== "string" || !state.usageByDate[row.dateKey] ||
        typeof row.kind !== "string" || !row.kind) throw new Error("Invalid reservation reference");
    const reservation = {
      dateKey: row.dateKey,
      kind: row.kind,
      estimatedCostUsd: requireNonnegativeNumber(row.estimatedCostUsd, "reserved cost"),
      createdAt: requireTimestamp(row.createdAt, "reservation createdAt"),
    };
    state.pendingReservations[id] = reservation;
    const pending = pendingByDate[reservation.dateKey] ||= { count: 0, costUsd: 0 };
    pending.count += 1;
    pending.costUsd = roundUsd(pending.costUsd + reservation.estimatedCostUsd);
  }
  for (const [dateKey, bucket] of Object.entries(state.usageByDate)) {
    const pending = pendingByDate[dateKey] || { count: 0, costUsd: 0 };
    if (pending.count > bucket.requestCount || pending.costUsd - bucket.estimatedTotalCostUsd > COST_EPSILON) {
      throw new Error("Reservation exceeds recorded budget usage");
    }
    const source = requireRecord(usageByDate[dateKey], "usage bucket");
    if (source.settledCostUsd === undefined) {
      // Legacy files have one inclusive total and no separate provider floor.
      if (source.minimumDailyCostUsd !== undefined) throw new Error("Missing settled cost basis");
      bucket.settledCostUsd = roundUsd(bucket.estimatedTotalCostUsd - pending.costUsd);
    }
    const expectedTotal = roundUsd(Math.max(bucket.settledCostUsd, bucket.minimumDailyCostUsd) + pending.costUsd);
    if (Math.abs(expectedTotal - bucket.estimatedTotalCostUsd) > COST_EPSILON) {
      throw new Error("Budget total does not match confirmed and pending costs");
    }
  }
  return state;
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

function getDateKey(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function roundUsd(value: number): number {
  requireNonnegativeNumber(value, "USD amount");
  if (!Number.isSafeInteger(Math.round(value * USD_SCALE))) throw new Error("USD amount exceeds safe precision");
  return Math.round(value * USD_SCALE) / USD_SCALE;
}

function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

export const anthropicBudget = new AnthropicBudgetService();
