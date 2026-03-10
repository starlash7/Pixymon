import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  AnthropicAdminUsageService,
  mergeAnthropicUsageSnapshots,
} from "../src/services/anthropic-admin-usage.ts";

function createServiceWithFetch(nowIso: string, payloads: unknown[]) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-admin-usage-"));
  const dataPath = path.join(tempDir, "anthropic-admin-usage.json");
  let now = new Date(nowIso);
  let index = 0;
  const fetchImpl: typeof fetch = async () => {
    const body = payloads[index++];
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const service = new AnthropicAdminUsageService({
    dataPath,
    now: () => now,
    fetchImpl,
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

test("anthropic admin usage sync aggregates usage and cost reports", async () => {
  const ctx = createServiceWithFetch("2026-03-10T06:00:00.000Z", [
    {
      data: [
        {
          results: [
            {
              uncached_input_tokens: 1200,
              cache_read_input_tokens: 700,
              output_tokens: 320,
              cache_creation: {
                ephemeral_5m_input_tokens: 150,
                ephemeral_1h_input_tokens: 50,
              },
            },
          ],
        },
      ],
    },
    {
      data: [
        {
          results: [
            {
              amount: "123.45",
              currency: "USD",
            },
          ],
        },
      ],
    },
  ]);

  try {
    const snapshot = await ctx.service.maybeSyncToday({
      enabled: true,
      timezone: "UTC",
      minSyncMinutes: 5,
      adminApiKey: "sk-ant-admin-test",
    });

    assert.ok(snapshot);
    assert.equal(snapshot?.uncachedInputTokens, 1200);
    assert.equal(snapshot?.cacheReadInputTokens, 700);
    assert.equal(snapshot?.cacheCreationInputTokens, 200);
    assert.equal(snapshot?.outputTokens, 320);
    assert.equal(snapshot?.actualCostUsd, 1.235);
  } finally {
    ctx.cleanup();
  }
});

test("mergeAnthropicUsageSnapshots keeps fresher higher-cost values from remote sync", () => {
  const merged = mergeAnthropicUsageSnapshots(
    {
      dateKey: "2026-03-10",
      requestCount: 4,
      estimatedInputTokens: 1400,
      estimatedOutputTokens: 200,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 100,
      estimatedTotalCostUsd: 0.08,
      byKind: {
        "post:trend-generate": 1,
      },
    },
    {
      dateKey: "2026-03-10",
      syncedAt: "2026-03-10T06:00:00.000Z",
      rangeStart: "2026-03-10T00:00:00.000Z",
      rangeEnd: "2026-03-10T06:00:00.000Z",
      actualCostUsd: 0.11,
      uncachedInputTokens: 1600,
      cacheCreationInputTokens: 300,
      cacheReadInputTokens: 500,
      outputTokens: 260,
    }
  );

  assert.equal(merged.requestCount, 4);
  assert.equal(merged.estimatedInputTokens, 1600);
  assert.equal(merged.estimatedOutputTokens, 260);
  assert.equal(merged.cacheCreationInputTokens, 300);
  assert.equal(merged.cacheReadInputTokens, 500);
  assert.equal(merged.estimatedTotalCostUsd, 0.11);
});
