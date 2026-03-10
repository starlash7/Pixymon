import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  AnthropicBudgetService,
  estimateAnthropicMessageCost,
  resolveAnthropicBudgetMode,
} from "../src/services/anthropic-budget.ts";
import { DEFAULT_ANTHROPIC_COST_SETTINGS, DEFAULT_TOTAL_COST_SETTINGS } from "../src/config/runtime.ts";

function createServiceWithClock(startIso: string): {
  service: AnthropicBudgetService;
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
      (200 / 1_000_000) * DEFAULT_ANTHROPIC_COST_SETTINGS.researchInputCostPerMillionUsd +
      (300 / 1_000_000) *
        DEFAULT_ANTHROPIC_COST_SETTINGS.researchInputCostPerMillionUsd *
        DEFAULT_ANTHROPIC_COST_SETTINGS.cacheWriteMultiplier +
      (500 / 1_000_000) *
        DEFAULT_ANTHROPIC_COST_SETTINGS.researchInputCostPerMillionUsd *
        DEFAULT_ANTHROPIC_COST_SETTINGS.cacheReadMultiplier +
      (200 / 1_000_000) * DEFAULT_ANTHROPIC_COST_SETTINGS.researchOutputCostPerMillionUsd;
    assert.equal(usage.estimatedTotalCostUsd, Number(expectedCost.toFixed(3)));
  } finally {
    ctx.cleanup();
  }
});
