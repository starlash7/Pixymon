import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "node:child_process";
import { acquireRuntimeLock } from "../src/services/process-lock.ts";
import {
  AnthropicBudgetService,
  estimateAnthropicMessageCost,
  resolveAnthropicBudgetMode,
} from "../src/services/anthropic-budget.ts";
import { DEFAULT_ANTHROPIC_COST_SETTINGS, DEFAULT_TOTAL_COST_SETTINGS } from "../src/config/runtime.ts";

function createServiceWithClock(startIso: string): {
  service: AnthropicBudgetService;
  dataPath: string;
  setNow: (iso: string) => void;
  cleanup: () => void;
} {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-llm-budget-"));
  const dataPath = path.join(tempDir, "anthropic-budget.json");
  let now = new Date(startIso);
  const service = new AnthropicBudgetService({
    dataPath,
    now: () => now,
  });
  return {
    service,
    dataPath,
    setNow: (iso: string) => {
      now = new Date(iso);
    },
    cleanup: () => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

test("estimateAnthropicMessageCost switches pricing by model family", () => {
  const sonnet = estimateAnthropicMessageCost({
    model: "claude-sonnet-4-5-20250929",
    system: "system",
    messages: [{ content: "hello world" }],
    maxTokens: 200,
    pricing: DEFAULT_ANTHROPIC_COST_SETTINGS,
  });
  const haiku = estimateAnthropicMessageCost({
    model: "claude-3-5-haiku-latest",
    system: "system",
    messages: [{ content: "hello world" }],
    maxTokens: 200,
    pricing: DEFAULT_ANTHROPIC_COST_SETTINGS,
  });

  assert.ok(sonnet.estimatedTotalCostUsd > haiku.estimatedTotalCostUsd);
  assert.ok(sonnet.inputTokens > 0);
  assert.ok(sonnet.outputTokens >= 200);
});

test("resolveAnthropicBudgetMode degrades before local-only", () => {
  const degrade = resolveAnthropicBudgetMode({
    estimatedRequestCostUsd: 0.05,
    timezone: "UTC",
    anthropicCostSettings: {
      ...DEFAULT_ANTHROPIC_COST_SETTINGS,
      dailyMaxUsd: 0.2,
      degradeAtUtilization: 0.7,
      localOnlyAtUtilization: 0.9,
    },
    totalCostSettings: {
      ...DEFAULT_TOTAL_COST_SETTINGS,
      dailyMaxUsd: 0.5,
    },
    xApiEstimatedCostUsd: 0.05,
    currentAnthropicUsage: {
      dateKey: "2026-03-10",
      requestCount: 3,
      estimatedInputTokens: 1000,
      estimatedOutputTokens: 500,
      estimatedTotalCostUsd: 0.1,
      byKind: {},
    },
  });

  assert.equal(degrade.mode, "degrade");

  const localOnly = resolveAnthropicBudgetMode({
    estimatedRequestCostUsd: 0.03,
    timezone: "UTC",
    anthropicCostSettings: {
      ...DEFAULT_ANTHROPIC_COST_SETTINGS,
      dailyMaxUsd: 0.2,
      degradeAtUtilization: 0.7,
      localOnlyAtUtilization: 0.85,
    },
    totalCostSettings: {
      ...DEFAULT_TOTAL_COST_SETTINGS,
      dailyMaxUsd: 0.25,
    },
    xApiEstimatedCostUsd: 0.08,
    currentAnthropicUsage: {
      dateKey: "2026-03-10",
      requestCount: 5,
      estimatedInputTokens: 1500,
      estimatedOutputTokens: 700,
      estimatedTotalCostUsd: 0.16,
      byKind: {},
    },
  });

  assert.equal(localOnly.mode, "local-only");
});

test("anthropic budget tracks requests and blocks when daily usd cap is exceeded", () => {
  const ctx = createServiceWithClock("2026-03-10T00:00:00.000Z");
  try {
    const firstCheck = ctx.service.checkAllowance({
      enabled: true,
      timezone: "UTC",
      dailyMaxUsd: 0.05,
      dailyRequestLimit: 10,
      estimatedCostUsd: 0.02,
      totalDailyMaxUsd: 0.2,
      xApiEstimatedCostUsd: 0.03,
    });
    assert.equal(firstCheck.allowed, true);

    ctx.service.recordUsage({
      timezone: "UTC",
      kind: "post:trend-generate",
      model: "claude-sonnet-4-5-20250929",
      inputTokens: 3000,
      outputTokens: 300,
      estimatedCostUsd: 0.02,
      pricing: DEFAULT_ANTHROPIC_COST_SETTINGS,
    });

    ctx.service.recordUsage({
      timezone: "UTC",
      kind: "reply:engagement-generate",
      model: "claude-sonnet-4-5-20250929",
      inputTokens: 3000,
      outputTokens: 300,
      estimatedCostUsd: 0.02,
      pricing: DEFAULT_ANTHROPIC_COST_SETTINGS,
    });

    const blocked = ctx.service.checkAllowance({
      enabled: true,
      timezone: "UTC",
      dailyMaxUsd: 0.05,
      dailyRequestLimit: 10,
      estimatedCostUsd: 0.02,
      totalDailyMaxUsd: 0.2,
      xApiEstimatedCostUsd: 0.03,
    });
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.reason, "daily-usd-limit");

    const usage = ctx.service.getTodayUsage("UTC");
    assert.equal(usage.requestCount, 2);
    assert.equal(usage.estimatedTotalCostUsd, 0.04);
    assert.equal(usage.byKind["post:trend-generate"], 1);
    assert.equal(usage.byKind["reply:engagement-generate"], 1);
  } finally {
    ctx.cleanup();
  }
});

test("anthropic budget records prompt caching read and write tokens with discounted pricing", () => {
  const ctx = createServiceWithClock("2026-03-10T00:00:00.000Z");
  try {
    const usage = ctx.service.recordUsage({
      timezone: "UTC",
      kind: "reply:engagement-generate",
      model: "claude-3-5-haiku-latest",
      inputTokens: 1000,
      outputTokens: 200,
      cacheCreationInputTokens: 300,
      cacheReadInputTokens: 500,
      pricing: DEFAULT_ANTHROPIC_COST_SETTINGS,
    });

    assert.equal(usage.requestCount, 1);
    assert.equal(usage.estimatedInputTokens, 1000);
    assert.equal(usage.cacheCreationInputTokens, 300);
    assert.equal(usage.cacheReadInputTokens, 500);

    const expectedCost =
      (1000 / 1_000_000) * DEFAULT_ANTHROPIC_COST_SETTINGS.researchInputCostPerMillionUsd +
      (300 / 1_000_000) *
        DEFAULT_ANTHROPIC_COST_SETTINGS.researchInputCostPerMillionUsd *
        DEFAULT_ANTHROPIC_COST_SETTINGS.cacheWriteMultiplier +
      (500 / 1_000_000) *
        DEFAULT_ANTHROPIC_COST_SETTINGS.researchInputCostPerMillionUsd *
        DEFAULT_ANTHROPIC_COST_SETTINGS.cacheReadMultiplier +
      (200 / 1_000_000) * DEFAULT_ANTHROPIC_COST_SETTINGS.researchOutputCostPerMillionUsd;
    assert.equal(usage.estimatedTotalCostUsd, Number(expectedCost.toFixed(9)));
  } finally {
    ctx.cleanup();
  }
});



const reserveInput = {
  enabled: true,
  timezone: "UTC",
  dailyMaxUsd: 0.05,
  dailyRequestLimit: 10,
  estimatedCostUsd: 0.03,
  kind: "test:reserved",
};
const usageInput = {
  model: "claude-3-5-haiku-latest",
  inputTokens: 1000,
  outputTokens: 200,
  pricing: DEFAULT_ANTHROPIC_COST_SETTINGS,
};

function reopen(dataPath: string): AnthropicBudgetService {
  return new AnthropicBudgetService({ dataPath, now: () => new Date("2026-03-10T00:00:00.000Z") });
}

test("budget construction, inspection and flush never create files or rewrite newer state", () => {
  const ctx = createServiceWithClock("2026-03-10T00:00:00.000Z");
  try {
    ctx.service.getTodayUsage("UTC");
    ctx.service.checkAllowance(reserveInput);
    ctx.service.flushNow();
    assert.equal(fs.existsSync(ctx.dataPath), false);
    const other = reopen(ctx.dataPath);
    other.recordUsage({ ...usageInput, timezone: "UTC", kind: "other", estimatedCostUsd: 0.02 });
    const before = fs.readFileSync(ctx.dataPath, "utf8");
    ctx.service.flushNow();
    ctx.service.getTodayUsage("UTC");
    ctx.service.checkAllowance(reserveInput);
    assert.equal(fs.readFileSync(ctx.dataPath, "utf8"), before);
    assert.deepEqual(fs.readdirSync(path.dirname(ctx.dataPath)), ["anthropic-budget.json"]);
  } finally {
    ctx.cleanup();
  }
});

test("separate service instances reload state rather than overwrite each other's usage", () => {
  const ctx = createServiceWithClock("2026-03-10T00:00:00.000Z");
  try {
    const other = reopen(ctx.dataPath);
    ctx.service.recordUsage({ ...usageInput, timezone: "UTC", kind: "first", estimatedCostUsd: 0.02 });
    other.recordUsage({ ...usageInput, timezone: "UTC", kind: "second", estimatedCostUsd: 0.02 });
    const usage = ctx.service.getTodayUsage("UTC");
    assert.equal(usage.requestCount, 2);
    assert.equal(usage.estimatedTotalCostUsd, 0.04);
    assert.deepEqual(usage.byKind, { first: 1, second: 1 });
    assert.equal(ctx.service.checkAllowance(reserveInput).allowed, false);
    ctx.service.flushNow();
    assert.equal(reopen(ctx.dataPath).getTodayUsage("UTC").requestCount, 2);
  } finally {
    ctx.cleanup();
  }
});

test("competing instances reserve cost and request count before any paid call", () => {
  const ctx = createServiceWithClock("2026-03-10T00:00:00.000Z");
  try {
    const other = reopen(ctx.dataPath);
    assert.equal(ctx.service.checkAllowance(reserveInput).allowed, true);
    assert.equal(other.checkAllowance(reserveInput).allowed, true);
    const reservation = ctx.service.reserveRequest(reserveInput);
    assert.equal(reservation.allowed, true);
    assert.ok(reservation.reservationId);
    const blocked = other.reserveRequest(reserveInput);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.reason, "daily-usd-limit");
    assert.equal(blocked.reservationId, undefined);
    const requestBlocked = other.reserveRequest({ ...reserveInput, estimatedCostUsd: 0, dailyRequestLimit: 1 });
    assert.equal(requestBlocked.allowed, false);
    assert.equal(requestBlocked.reason, "daily-request-limit");
    assert.equal(other.getTodayUsage("UTC").requestCount, 1);
    assert.equal(other.getTodayUsage("UTC").estimatedTotalCostUsd, 0.03);
  } finally {
    ctx.cleanup();
  }
});

test("settlement replaces reservation with actual uncached and cached cost without double counting requests", () => {
  const ctx = createServiceWithClock("2026-03-10T00:00:00.000Z");
  try {
    const reservation = ctx.service.reserveRequest(reserveInput);
    assert.equal(reservation.allowed, true);
    if (!reservation.allowed) return;
    const usage = reopen(ctx.dataPath).settleRequest({
      ...usageInput,
      reservationId: reservation.reservationId,
      cacheCreationInputTokens: 300,
      cacheReadInputTokens: 500,
    });
    const pricing = DEFAULT_ANTHROPIC_COST_SETTINGS;
    const expected = (1000 * pricing.researchInputCostPerMillionUsd +
      300 * pricing.researchInputCostPerMillionUsd * pricing.cacheWriteMultiplier +
      500 * pricing.researchInputCostPerMillionUsd * pricing.cacheReadMultiplier +
      200 * pricing.researchOutputCostPerMillionUsd) / 1_000_000;
    assert.equal(usage.estimatedTotalCostUsd, Number(expected.toFixed(9)));
    assert.equal(usage.requestCount, 1);
    assert.equal(usage.estimatedInputTokens, 1000);
    assert.equal(usage.estimatedOutputTokens, 200);
    assert.equal(usage.cacheCreationInputTokens, 300);
    assert.equal(usage.cacheReadInputTokens, 500);
    assert.deepEqual(usage.byKind, { "test:reserved": 1 });
    assert.deepEqual(JSON.parse(fs.readFileSync(ctx.dataPath, "utf8")).pendingReservations, {});
    assert.throws(() => ctx.service.settleRequest({ ...usageInput, reservationId: reservation.reservationId }), /already settled/);
    assert.equal(ctx.service.getTodayUsage("UTC").requestCount, 1);
  } finally {
    ctx.cleanup();
  }
});

test("in-flight reservations survive another request settling and ambiguous failures or restarts", () => {
  const ctx = createServiceWithClock("2026-03-10T00:00:00.000Z");
  try {
    const first = ctx.service.reserveRequest({ ...reserveInput, dailyMaxUsd: 0.1 });
    const second = reopen(ctx.dataPath).reserveRequest({ ...reserveInput, dailyMaxUsd: 0.1 });
    assert.equal(first.allowed, true);
    assert.equal(second.allowed, true);
    if (!first.allowed || !second.allowed) return;
    const settled = ctx.service.settleRequest({ ...usageInput, reservationId: first.reservationId, estimatedCostUsd: 0.01 });
    assert.equal(settled.estimatedTotalCostUsd, 0.04);
    assert.equal(settled.requestCount, 2);
    // A timeout/API rejection has no settlement and must not free possible spend.
    const restarted = reopen(ctx.dataPath);
    assert.equal(restarted.checkAllowance(reserveInput).allowed, false);
    const pending = JSON.parse(fs.readFileSync(ctx.dataPath, "utf8")).pendingReservations;
    assert.deepEqual(Object.keys(pending), [second.reservationId]);
    assert.equal(pending[second.reservationId].estimatedCostUsd, 0.03);
  } finally {
    ctx.cleanup();
  }
});

test("request finishing after midnight settles its original date", () => {
  const ctx = createServiceWithClock("2026-03-10T23:59:59.000Z");
  try {
    const reservation = ctx.service.reserveRequest(reserveInput);
    assert.equal(reservation.allowed, true);
    if (!reservation.allowed) return;
    ctx.setNow("2026-03-11T00:00:01.000Z");
    const settled = ctx.service.settleRequest({ ...usageInput, reservationId: reservation.reservationId, estimatedCostUsd: 0.01 });
    assert.equal(settled.dateKey, "2026-03-10");
    assert.equal(settled.requestCount, 1);
    assert.equal(ctx.service.getTodayUsage("UTC").requestCount, 0);
  } finally {
    ctx.cleanup();
  }
});

test("small per-request costs retain precision through repeated accounting and allowance checks", () => {
  const ctx = createServiceWithClock("2026-03-10T00:00:00.000Z");
  try {
    const smallUsage = { ...usageInput, inputTokens: 1, outputTokens: 0, timezone: "UTC", kind: "small" };
    const perRequest = DEFAULT_ANTHROPIC_COST_SETTINGS.researchInputCostPerMillionUsd / 1_000_000;
    for (let i = 0; i < 20; i += 1) ctx.service.recordUsage(smallUsage);
    assert.equal(ctx.service.getTodayUsage("UTC").estimatedTotalCostUsd, Number((20 * perRequest).toFixed(9)));
    const denied = ctx.service.reserveRequest({
      ...reserveInput, dailyRequestLimit: 100, estimatedCostUsd: perRequest, dailyMaxUsd: 20.5 * perRequest,
    });
    assert.equal(denied.allowed, false);
    assert.equal(denied.reason, "daily-usd-limit");
    const estimate = estimateAnthropicMessageCost({ model: usageInput.model, messages: [{ content: "a" }], maxTokens: 1, pricing: usageInput.pricing });
    assert.ok(estimate.estimatedTotalCostUsd > 0);
    assert.ok(estimate.estimatedTotalCostUsd < 0.001);
  } finally {
    ctx.cleanup();
  }
});

test("admin cost and request floors are persisted before reservations so they cannot be reused", () => {
  const ctx = createServiceWithClock("2026-03-10T00:00:00.000Z");
  try {
    const options = { ...reserveInput, minimumDailyCostUsd: 0.02, minimumRequestCount: 9 };
    const reservation = ctx.service.reserveRequest(options);
    assert.equal(reservation.allowed, true);
    assert.equal(ctx.service.getTodayUsage("UTC").estimatedTotalCostUsd, 0.05);
    assert.equal(ctx.service.getTodayUsage("UTC").requestCount, 10);
    const blocked = reopen(ctx.dataPath).reserveRequest(options);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.reason, "daily-request-limit");
    const costBlocked = reopen(ctx.dataPath).reserveRequest({ ...options, dailyRequestLimit: 100 });
    assert.equal(costBlocked.allowed, false);
    assert.equal(costBlocked.reason, "daily-usd-limit");
  } finally {
    ctx.cleanup();
  }
});

test("combined cost ceiling accounts for reserved requests", () => {
  const ctx = createServiceWithClock("2026-03-10T00:00:00.000Z");
  try {
    const options = { ...reserveInput, dailyMaxUsd: 1, totalDailyMaxUsd: 0.1, xApiEstimatedCostUsd: 0.06 };
    assert.equal(ctx.service.reserveRequest(options).allowed, true);
    const blocked = reopen(ctx.dataPath).reserveRequest(options);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.reason, "combined-daily-usd-limit");
  } finally {
    ctx.cleanup();
  }
});

test("contended or uncertain locks fail closed and are never removed by a contender", () => {
  const ctx = createServiceWithClock("2026-03-10T00:00:00.000Z");
  const lockPath = `${ctx.dataPath}.lock`;
  try {
    const lock = acquireRuntimeLock(lockPath);
    assert.equal(lock.acquired, true);
    const before = fs.readFileSync(lockPath, "utf8");
    assert.throws(() => ctx.service.reserveRequest(reserveInput), /Budget lock unavailable/);
    assert.equal(fs.readFileSync(lockPath, "utf8"), before);
    assert.equal(fs.existsSync(ctx.dataPath), false);
    lock.release();
    fs.writeFileSync(lockPath, "unreadable ownership");
    assert.throws(() => ctx.service.reserveRequest(reserveInput), /Budget lock unavailable/);
    assert.equal(fs.readFileSync(lockPath, "utf8"), "unreadable ownership");
  } finally {
    ctx.cleanup();
  }
});

test("malformed and semantically corrupt state fail closed without quarantine or reset", () => {
  const ctx = createServiceWithClock("2026-03-10T00:00:00.000Z");
  try {
    const corruptStates = ["{", "null", "{}", JSON.stringify({ usageByDate: [], lastUpdated: "2026-03-10T00:00:00.000Z" })];
    for (const raw of corruptStates) {
      fs.writeFileSync(ctx.dataPath, raw);
      assert.throws(() => ctx.service.getTodayUsage("UTC"), /Invalid budget state/);
      assert.throws(() => ctx.service.reserveRequest(reserveInput), /Invalid budget state/);
      assert.equal(fs.readFileSync(ctx.dataPath, "utf8"), raw);
      assert.deepEqual(fs.readdirSync(path.dirname(ctx.dataPath)), ["anthropic-budget.json"]);
    }
  } finally {
    ctx.cleanup();
  }
});

test("corrupt reservation totals and invalid usage cannot erase reserved spend", () => {
  const ctx = createServiceWithClock("2026-03-10T00:00:00.000Z");
  try {
    const reservation = ctx.service.reserveRequest(reserveInput);
    assert.equal(reservation.allowed, true);
    if (!reservation.allowed) return;
    const before = fs.readFileSync(ctx.dataPath, "utf8");
    assert.throws(() => ctx.service.settleRequest({ ...usageInput, inputTokens: NaN, reservationId: reservation.reservationId }), /Invalid inputTokens/);
    assert.equal(fs.readFileSync(ctx.dataPath, "utf8"), before);
    const corrupt = JSON.parse(before);
    corrupt.usageByDate["2026-03-10"].estimatedTotalCostUsd = 0;
    fs.writeFileSync(ctx.dataPath, JSON.stringify(corrupt));
    assert.throws(() => ctx.service.reserveRequest(reserveInput), /Reservation exceeds recorded budget usage/);
  } finally {
    ctx.cleanup();
  }
});

test("atomic write failure never grants a reservation and preserves the previous state", () => {
  const ctx = createServiceWithClock("2026-03-10T00:00:00.000Z");
  try {
    ctx.service.recordUsage({ ...usageInput, timezone: "UTC", kind: "existing", estimatedCostUsd: 0.01 });
    const before = fs.readFileSync(ctx.dataPath, "utf8");
    const rename = fs.renameSync;
    fs.renameSync = () => { throw new Error("simulated rename failure"); };
    try {
      assert.throws(() => ctx.service.reserveRequest(reserveInput), /Cannot persist budget state/);
    } finally {
      fs.renameSync = rename;
    }
    assert.equal(fs.readFileSync(ctx.dataPath, "utf8"), before);
    assert.deepEqual(fs.readdirSync(path.dirname(ctx.dataPath)), ["anthropic-budget.json"]);
  } finally {
    ctx.cleanup();
  }
});

test("legacy state without pending reservations migrates without losing usage", () => {
  const ctx = createServiceWithClock("2026-03-10T00:00:00.000Z");
  try {
    ctx.service.recordUsage({ ...usageInput, timezone: "UTC", kind: "legacy", estimatedCostUsd: 0.01 });
    const legacy = JSON.parse(fs.readFileSync(ctx.dataPath, "utf8"));
    delete legacy.pendingReservations;
    delete legacy.usageByDate["2026-03-10"].settledCostUsd;
    delete legacy.usageByDate["2026-03-10"].minimumDailyCostUsd;
    fs.writeFileSync(ctx.dataPath, JSON.stringify(legacy));
    const reservation = reopen(ctx.dataPath).reserveRequest(reserveInput);
    assert.equal(reservation.allowed, true);
    assert.equal(ctx.service.getTodayUsage("UTC").requestCount, 2);
    assert.equal(ctx.service.getTodayUsage("UTC").estimatedTotalCostUsd, 0.04);
  } finally {
    ctx.cleanup();
  }
});

test("independent processes cannot both reserve the last request allowance", { timeout: 10_000 }, async () => {
  const ctx = createServiceWithClock("2026-03-10T00:00:00.000Z");
  const children: ReturnType<typeof spawn>[] = [];
  try {
    const script = `
      import { AnthropicBudgetService } from ${JSON.stringify(new URL("../src/services/anthropic-budget.ts", import.meta.url).href)};
      const service = new AnthropicBudgetService({ dataPath: process.env.BUDGET_TEST_PATH, now: () => new Date("2026-03-10T00:00:00.000Z") });
      process.stdout.write("ready\\n");
      process.stdin.once("data", () => {
        try {
          const decision = service.reserveRequest(${JSON.stringify({ ...reserveInput, dailyRequestLimit: 1 })});
          process.stdout.write(JSON.stringify({ allowed: decision.allowed, reason: decision.reason }) + "\\n");
        } catch (error) {
          process.stdout.write(JSON.stringify({ allowed: false, reason: error.message }) + "\\n");
        }
        process.stdin.destroy();
      });
    `;
    const ready: Promise<void>[] = [];
    const results: Promise<{ allowed: boolean; reason?: string }>[] = [];
    for (let i = 0; i < 2; i += 1) {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
        cwd: process.cwd(),
        env: { ...process.env, BUDGET_TEST_PATH: ctx.dataPath },
        stdio: ["pipe", "pipe", "pipe"],
      });
      children.push(child);
      let stdout = "";
      let stderr = "";
      ready.push(new Promise<void>((resolve, reject) => {
        child.stdout.on("data", (chunk) => {
          stdout += String(chunk);
          if (stdout.includes("ready\n")) resolve();
        });
        child.on("error", reject);
        child.on("exit", (code) => { if (!stdout.includes("ready\n")) reject(new Error(`Child exited before ready (${code}): ${stderr}`)); });
      }));
      results.push(new Promise((resolve, reject) => {
        child.stderr.on("data", (chunk) => { stderr += String(chunk); });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code !== 0) return reject(new Error(`Reservation process failed (${code}): ${stderr}`));
          try { resolve(JSON.parse(stdout.trim().split("\n").at(-1)!)); } catch (error) { reject(error); }
        });
      }));
    }
    await Promise.all(ready);
    for (const child of children) child.stdin!.end("go");
    const decisions = await Promise.all(results);
    assert.equal(decisions.filter((result) => result.allowed).length, 1);
    assert.ok(decisions.some((result) => result.reason === "daily-request-limit" || result.reason?.includes("Budget lock unavailable")));
    assert.equal(ctx.service.getTodayUsage("UTC").requestCount, 1);
    assert.equal(ctx.service.getTodayUsage("UTC").estimatedTotalCostUsd, 0.03);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    ctx.cleanup();
  }
});

test("reservation durability syncs the budget before rename and the directory before returning", () => {
  const ctx = createServiceWithClock("2026-03-10T00:00:00.000Z");
  const fsync = fs.fsyncSync;
  const rename = fs.renameSync;
  const events: string[] = [];
  try {
    fs.fsyncSync = (fd) => {
      events.push(fs.fstatSync(fd).isDirectory() ? "directory-fsync" : "file-fsync");
      fsync(fd);
    };
    fs.renameSync = (source, destination) => {
      events.push("rename");
      rename(source, destination);
    };
    assert.equal(ctx.service.reserveRequest(reserveInput).allowed, true);
    assert.deepEqual(events, ["file-fsync", "file-fsync", "rename", "directory-fsync"]);
  } finally {
    fs.fsyncSync = fsync;
    fs.renameSync = rename;
    ctx.cleanup();
  }
});

test("uncertain directory sync fails admission but leaves the written reservation charged", () => {
  const ctx = createServiceWithClock("2026-03-10T00:00:00.000Z");
  const fsync = fs.fsyncSync;
  try {
    fs.fsyncSync = (fd) => {
      if (fs.fstatSync(fd).isDirectory()) throw new Error("simulated directory sync failure");
      fsync(fd);
    };
    assert.throws(() => ctx.service.reserveRequest(reserveInput), /Cannot persist budget state/);
    fs.fsyncSync = fsync;
    assert.equal(reopen(ctx.dataPath).getTodayUsage("UTC").estimatedTotalCostUsd, 0.03);
    assert.equal(reopen(ctx.dataPath).checkAllowance(reserveInput).allowed, false);
  } finally {
    fs.fsyncSync = fsync;
    ctx.cleanup();
  }
});

test("actual usage above the reservation is recorded and blocks later requests", () => {
  const ctx = createServiceWithClock("2026-03-10T00:00:00.000Z");
  try {
    const reservation = ctx.service.reserveRequest(reserveInput);
    assert.equal(reservation.allowed, true);
    if (!reservation.allowed) return;
    const settled = ctx.service.settleRequest({ ...usageInput, reservationId: reservation.reservationId, estimatedCostUsd: 0.06 });
    assert.equal(settled.estimatedTotalCostUsd, 0.06);
    assert.equal(settled.requestCount, 1);
    assert.equal(ctx.service.checkAllowance({ ...reserveInput, estimatedCostUsd: 0 }).allowed, false);
  } finally {
    ctx.cleanup();
  }
});

test("old ambiguous reservations remain in the ledger after ordinary bucket pruning", () => {
  const ctx = createServiceWithClock("2026-03-10T00:00:00.000Z");
  try {
    const reservation = ctx.service.reserveRequest(reserveInput);
    assert.equal(reservation.allowed, true);
    if (!reservation.allowed) return;
    ctx.setNow("2026-04-20T00:00:00.000Z");
    ctx.service.recordUsage({ ...usageInput, timezone: "UTC", kind: "later", estimatedCostUsd: 0.01 });
    const state = JSON.parse(fs.readFileSync(ctx.dataPath, "utf8"));
    assert.equal(state.usageByDate["2026-03-10"].estimatedTotalCostUsd, 0.03);
    assert.ok(state.pendingReservations[reservation.reservationId]);
    assert.equal(ctx.service.getTodayUsage("UTC").estimatedTotalCostUsd, 0.01);
  } finally {
    ctx.cleanup();
  }
});

test("disappearing previously loaded state fails closed instead of resetting usage", () => {
  const ctx = createServiceWithClock("2026-03-10T00:00:00.000Z");
  try {
    ctx.service.reserveRequest(reserveInput);
    fs.unlinkSync(ctx.dataPath);
    assert.throws(() => ctx.service.reserveRequest(reserveInput), /Cannot read budget state/);
    assert.equal(fs.existsSync(ctx.dataPath), false);
  } finally {
    ctx.cleanup();
  }
});

test("interleaved admin sync and settlement cannot release confirmed spend or other pending reservations", () => {
  const ctx = createServiceWithClock("2026-03-10T00:00:00.000Z");
  try {
    const first = ctx.service.reserveRequest({ ...reserveInput, dailyMaxUsd: 0.1 });
    const second = reopen(ctx.dataPath).reserveRequest({
      ...reserveInput, dailyMaxUsd: 0.1, estimatedCostUsd: 0.01, minimumDailyCostUsd: 0.05,
    });
    assert.equal(first.allowed, true);
    assert.equal(second.allowed, true);
    if (!first.allowed || !second.allowed) return;
    assert.equal(ctx.service.getTodayUsage("UTC").estimatedTotalCostUsd, 0.09);
    const settled = ctx.service.settleRequest({ ...usageInput, reservationId: first.reservationId, estimatedCostUsd: 0.001 });
    assert.equal(settled.estimatedTotalCostUsd, 0.061);
    const third = reopen(ctx.dataPath).reserveRequest({
      ...reserveInput, dailyMaxUsd: 0.061, estimatedCostUsd: 0.01, minimumDailyCostUsd: 0.05,
    });
    assert.equal(third.allowed, false);
    assert.equal(third.reason, "daily-usd-limit");
    assert.equal(third.projectedDailyCostUsd, 0.071);
    const staleCaller = reopen(ctx.dataPath).reserveRequest({
      ...reserveInput, dailyMaxUsd: 0.061, estimatedCostUsd: 0.01,
    });
    assert.equal(staleCaller.allowed, false);
    const state = JSON.parse(fs.readFileSync(ctx.dataPath, "utf8"));
    assert.equal(state.usageByDate["2026-03-10"].minimumDailyCostUsd, 0.05);
    assert.equal(state.usageByDate["2026-03-10"].settledCostUsd, 0.051);
    assert.deepEqual(Object.keys(state.pendingReservations), [second.reservationId]);
  } finally {
    ctx.cleanup();
  }
});

test("a newer admin floor blocks overlapping reservations and stays durable even on denial", () => {
  const ctx = createServiceWithClock("2026-03-10T00:00:00.000Z");
  try {
    ctx.service.reserveRequest(reserveInput);
    const denied = ctx.service.reserveRequest({
      ...reserveInput, dailyMaxUsd: 0.061, estimatedCostUsd: 0.01, minimumDailyCostUsd: 0.05,
    });
    assert.equal(denied.allowed, false);
    assert.equal(denied.projectedDailyCostUsd, 0.09);
    const usage = reopen(ctx.dataPath).getTodayUsage("UTC");
    assert.equal(usage.requestCount, 1);
    assert.equal(usage.estimatedTotalCostUsd, 0.08);
    const staleCaller = reopen(ctx.dataPath).reserveRequest({ ...reserveInput, dailyMaxUsd: 0.061, estimatedCostUsd: 0.01 });
    assert.equal(staleCaller.allowed, false);
  } finally {
    ctx.cleanup();
  }
});


test("settlements add to the confirmed provider basis instead of reusing its floor", () => {
  const ctx = createServiceWithClock("2026-03-10T00:00:00.000Z");
  try {
    const options = { ...reserveInput, dailyMaxUsd: 0.061, estimatedCostUsd: 0.01, minimumDailyCostUsd: 0.05 };
    const reservation = ctx.service.reserveRequest(options);
    assert.equal(reservation.allowed, true);
    if (!reservation.allowed) return;
    const settled = ctx.service.settleRequest({ ...usageInput, reservationId: reservation.reservationId, estimatedCostUsd: 0.01 });
    assert.equal(settled.estimatedTotalCostUsd, 0.06);
    for (const minimumDailyCostUsd of [0.05, 0]) {
      const denied = reopen(ctx.dataPath).reserveRequest({ ...options, minimumDailyCostUsd });
      assert.equal(denied.allowed, false);
      assert.equal(denied.reason, "daily-usd-limit");
      assert.equal(denied.projectedDailyCostUsd, 0.07);
    }
    assert.equal(ctx.service.getTodayUsage("UTC").requestCount, 1);
  } finally {
    ctx.cleanup();
  }
});


test("confirmed remote spend persists independently of request admission", () => {
  const ctx = createServiceWithClock("2026-03-10T00:00:00.000Z");
  try {
    const usage = ctx.service.syncConfirmedUsageFloor({ timezone: "UTC", dateKey: "2026-03-10", minimumDailyCostUsd: 0.05 });
    assert.equal(usage.requestCount, 0);
    assert.equal(usage.estimatedTotalCostUsd, 0.05);
    assert.deepEqual(usage.byKind, {});
    const restarted = reopen(ctx.dataPath);
    const denied = restarted.reserveRequest({ ...reserveInput, dailyMaxUsd: 0.05, estimatedCostUsd: 0.001 });
    assert.equal(denied.allowed, false);
    const raw = fs.readFileSync(ctx.dataPath, "utf8");
    assert.deepEqual(JSON.parse(raw).pendingReservations, {});
    restarted.syncConfirmedUsageFloor({ timezone: "UTC", dateKey: "2026-03-10", minimumDailyCostUsd: 0.01 });
    assert.equal(fs.readFileSync(ctx.dataPath, "utf8"), raw);
  } finally {
    ctx.cleanup();
  }
});

test("confirmed floor sync preserves pending spend and adds later settlements to the basis", () => {
  const ctx = createServiceWithClock("2026-03-10T00:00:00.000Z");
  try {
    const reservation = ctx.service.reserveRequest(reserveInput);
    assert.equal(reservation.allowed, true);
    if (!reservation.allowed) return;
    const synced = reopen(ctx.dataPath).syncConfirmedUsageFloor({
      timezone: "UTC", dateKey: "2026-03-10", minimumDailyCostUsd: 0.05, minimumRequestCount: 9,
    });
    assert.equal(synced.estimatedTotalCostUsd, 0.08);
    assert.equal(synced.requestCount, 9);
    const settled = ctx.service.settleRequest({ ...usageInput, reservationId: reservation.reservationId, estimatedCostUsd: 0.01 });
    assert.equal(settled.estimatedTotalCostUsd, 0.06);
    assert.equal(settled.requestCount, 9);
  } finally {
    ctx.cleanup();
  }
});

test("confirmed floor sync rejects stale-day attribution and obeys existing locks", () => {
  const ctx = createServiceWithClock("2026-03-10T00:00:00.000Z");
  try {
    const stale = ctx.service.syncConfirmedUsageFloor({ timezone: "UTC", dateKey: "2026-03-09", minimumDailyCostUsd: 1 });
    assert.equal(stale.dateKey, "2026-03-10");
    assert.equal(stale.estimatedTotalCostUsd, 0);
    assert.equal(fs.existsSync(ctx.dataPath), false);
    const lock = acquireRuntimeLock(`${ctx.dataPath}.lock`);
    try {
      assert.throws(() => ctx.service.syncConfirmedUsageFloor({
        timezone: "UTC", dateKey: "2026-03-10", minimumDailyCostUsd: 0.05,
      }), /Budget lock unavailable/);
      assert.equal(fs.existsSync(ctx.dataPath), false);
    } finally {
      lock.release();
    }
  } finally {
    ctx.cleanup();
  }
});
