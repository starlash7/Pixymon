import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { XApiBudgetService, XCreateBudgetPolicy, XReadBudgetPolicy } from "../src/services/x-api-budget.ts";

function createServiceWithClock(startIso: string): {
  service: XApiBudgetService;
  setNow: (iso: string) => void;
  cleanup: () => void;
} {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-xapi-budget-"));
  const dataPath = path.join(tempDir, "x-api-budget.json");
  let now = new Date(startIso);
  const service = new XApiBudgetService({
    dataPath,
    now: () => now,
  });
  return {
    service,
    setNow: (iso: string) => {
      now = new Date(iso);
    },
    cleanup: () => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

function buildPolicy(overrides: Partial<XReadBudgetPolicy> = {}): XReadBudgetPolicy {
  return {
    enabled: true,
    timezone: "UTC",
    dailyMaxUsd: 0.1,
    estimatedReadCostUsd: 0.03,
    dailyReadRequestLimit: 10,
    kind: "trend-search",
    minIntervalMinutes: 0,
    ...overrides,
  };
}

function buildCreatePolicy(overrides: Partial<XCreateBudgetPolicy> = {}): XCreateBudgetPolicy {
  return {
    enabled: true,
    timezone: "UTC",
    dailyMaxUsd: 0.1,
    estimatedCreateCostUsd: 0.04,
    dailyCreateRequestLimit: 10,
    kind: "post:briefing",
    minIntervalMinutes: 0,
    ...overrides,
  };
}

test("x-api budget blocks reads when projected daily usd exceeds cap", () => {
  const ctx = createServiceWithClock("2026-02-17T00:00:00.000Z");
  try {
    const policy = buildPolicy();

    for (let i = 0; i < 3; i += 1) {
      const check = ctx.service.checkReadAllowance(policy);
      assert.equal(check.allowed, true);
      ctx.service.recordRead(policy);
    }

    const blocked = ctx.service.checkReadAllowance(policy);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.reason, "daily-usd-limit");
  } finally {
    ctx.cleanup();
  }
});

test("x-api budget enforces min interval per read kind", () => {
  const ctx = createServiceWithClock("2026-02-17T01:00:00.000Z");
  try {
    const policy = buildPolicy({
      kind: "mentions",
      minIntervalMinutes: 120,
      estimatedReadCostUsd: 0.01,
    });

    const first = ctx.service.checkReadAllowance(policy);
    assert.equal(first.allowed, true);
    ctx.service.recordRead(policy);

    const blocked = ctx.service.checkReadAllowance(policy);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.reason, "min-interval");
    assert.ok((blocked.waitSeconds || 0) > 0);

    ctx.setNow("2026-02-17T03:01:00.000Z");
    const allowedAfterCooldown = ctx.service.checkReadAllowance(policy);
    assert.equal(allowedAfterCooldown.allowed, true);
  } finally {
    ctx.cleanup();
  }
});

test("x-api budget tracks usage by kind", () => {
  const ctx = createServiceWithClock("2026-02-17T00:00:00.000Z");
  try {
    ctx.service.recordRead(buildPolicy({ kind: "mentions", estimatedReadCostUsd: 0.01 }));
    ctx.service.recordRead(buildPolicy({ kind: "trend-search", estimatedReadCostUsd: 0.02 }));
    ctx.service.recordCreate(buildCreatePolicy({ kind: "reply:mention", estimatedCreateCostUsd: 0.03 }));

    const usage = ctx.service.getTodayUsage("UTC");
    assert.equal(usage.readRequests, 2);
    assert.equal(usage.createRequests, 1);
    assert.equal(usage.estimatedReadCostUsd, 0.03);
    assert.equal(usage.estimatedCreateCostUsd, 0.03);
    assert.equal(usage.estimatedTotalCostUsd, 0.06);
    assert.equal(usage.byKind["mentions"], 1);
    assert.equal(usage.byKind["trend-search"], 1);
    assert.equal(usage.byKind["reply:mention"], 1);
  } finally {
    ctx.cleanup();
  }
});

test("x-api budget blocks create when daily total cap would be exceeded", () => {
  const ctx = createServiceWithClock("2026-02-17T00:00:00.000Z");
  try {
    ctx.service.recordRead(buildPolicy({ estimatedReadCostUsd: 0.07, kind: "mentions" }));

    const createPolicy = buildCreatePolicy({
      estimatedCreateCostUsd: 0.04,
      kind: "post:briefing",
    });
    const blocked = ctx.service.checkCreateAllowance(createPolicy);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.reason, "daily-usd-limit");
  } finally {
    ctx.cleanup();
  }
});

test("x-api budget enforces daily create request limit", () => {
  const ctx = createServiceWithClock("2026-02-17T00:00:00.000Z");
  try {
    const createPolicy = buildCreatePolicy({
      estimatedCreateCostUsd: 0.01,
      dailyCreateRequestLimit: 2,
      kind: "reply:engagement",
    });
    assert.equal(ctx.service.checkCreateAllowance(createPolicy).allowed, true);
    ctx.service.recordCreate(createPolicy);
    assert.equal(ctx.service.checkCreateAllowance(createPolicy).allowed, true);
    ctx.service.recordCreate(createPolicy);

    const blocked = ctx.service.checkCreateAllowance(createPolicy);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.reason, "daily-request-limit");
  } finally {
    ctx.cleanup();
  }
});
