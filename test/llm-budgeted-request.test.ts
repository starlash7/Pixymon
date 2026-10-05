import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

// Each case imports the real wrapper and singleton services in a separate
// process/data directory. Fake SDK clients and a throwing fetch prohibit any
// provider traffic, even in the cases that explicitly exercise online policy.
function runCase(body: string, env: Record<string, string> = {}): any {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-budgeted-request-"));
  try {
    const script = `
      import assert from "node:assert/strict";
      globalThis.fetch = async () => { throw new Error("Unexpected external fetch in offline test"); };
      const { requestBudgetedClaudeMessage, CLAUDE_MODEL } = await import("./src/services/llm.ts");
      const { anthropicBudget } = await import("./src/services/anthropic-budget.ts");
      const { anthropicAdminUsage } = await import("./src/services/anthropic-admin-usage.ts");
      const params = { model: CLAUDE_MODEL, max_tokens: 1000, system: "stable system", messages: [{ role: "user", content: "hello" }] };
      const options = { kind: "editorial-v2:inquire", timezone: "UTC", allowResearchModel: false };
      const client = (create) => ({ messages: { create }, beta: { promptCaching: { messages: { create } } } });
      const result = await (async () => { ${body} })();
      console.log("TEST_RESULT=" + JSON.stringify(result));
    `;
    const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: root,
      env: {
        ...process.env,
        ACTION_MODE: "observe",
        TEST_MODE: "false",
        TEST_NO_EXTERNAL_CALLS: "false",
        ANTHROPIC_API_KEY: "offline-test-key",
        ANTHROPIC_ADMIN_API_KEY: "",
        ANTHROPIC_USAGE_API_ENABLED: "false",
        ANTHROPIC_COST_GUARD_ENABLED: "true",
        ANTHROPIC_PROMPT_CACHING_ENABLED: "true",
        ANTHROPIC_CACHE_WRITE_MULTIPLIER: "1.25",
        ANTHROPIC_CACHE_READ_MULTIPLIER: "0.1",
        ANTHROPIC_PRIMARY_INPUT_COST_PER_MILLION_USD: "3",
        ANTHROPIC_PRIMARY_OUTPUT_COST_PER_MILLION_USD: "15",
        ANTHROPIC_DAILY_MAX_USD: "0.4",
        ANTHROPIC_DAILY_REQUEST_LIMIT: "40",
        TOTAL_COST_GUARD_ENABLED: "true",
        TOTAL_DAILY_MAX_USD: "0.5",
        PIXYMON_DATA_DIR: directory,
        PIXYMON_LIVE_DATA_DIR: directory,
        ...env,
      },
      encoding: "utf8",
      timeout: 20_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const line = output.split("\n").find((row) => row.startsWith("TEST_RESULT="));
    assert.ok(line, output);
    return JSON.parse(line.slice("TEST_RESULT=".length));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("budgeted model guard runs before admin sync, SDK calls, and reservations", () => {
  const result = runCase(`
    let adminCalls = 0, modelCalls = 0;
    anthropicAdminUsage.maybeSyncToday = async () => { adminCalls++; return null; };
    await assert.rejects(
      requestBudgetedClaudeMessage(client(async () => { modelCalls++; }), params, options),
      /external calls are disabled/
    );
    return { adminCalls, modelCalls, count: anthropicBudget.getTodayUsage("UTC").requestCount };
  `, { TEST_MODE: "false", TEST_NO_EXTERNAL_CALLS: "true", ANTHROPIC_USAGE_API_ENABLED: "true" });
  assert.deepEqual(result, { adminCalls: 0, modelCalls: 0, count: 0 });
});

test("budgeted cached response settles one reserved request with separate token charges", () => {
  const result = runCase(`
    let atDispatch, retries;
    const response = await requestBudgetedClaudeMessage(client(async (_params, requestOptions) => {
      atDispatch = anthropicBudget.getTodayUsage("UTC");
      retries = requestOptions.maxRetries;
      return { content: [{ type: "text", text: "ok" }], usage: {
        input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 2000
      } };
    }), params, options);
    return { ok: Boolean(response), atDispatch, retries, settled: anthropicBudget.getTodayUsage("UTC") };
  `);
  assert.equal(result.ok, true);
  assert.equal(result.retries, 0);
  assert.equal(result.atDispatch.requestCount, 1);
  assert.ok(result.atDispatch.estimatedTotalCostUsd > 0.0051);
  assert.equal(result.settled.requestCount, 1);
  assert.equal(result.settled.estimatedInputTokens, 1000);
  assert.equal(result.settled.cacheReadInputTokens, 2000);
  assert.equal(result.settled.estimatedTotalCostUsd, 0.0051);
});

test("changing the offline flag during admin sync blocks model dispatch before reservation", () => {
  const result = runCase(`
    let modelCalls = 0;
    anthropicAdminUsage.maybeSyncToday = async () => {
      process.env.TEST_NO_EXTERNAL_CALLS = "true";
      return null;
    };
    await assert.rejects(
      requestBudgetedClaudeMessage(client(async () => { modelCalls++; }), params, options),
      /external calls are disabled/
    );
    return { modelCalls, count: anthropicBudget.getTodayUsage("UTC").requestCount };
  `, { ANTHROPIC_USAGE_API_ENABLED: "true" });
  assert.deepEqual(result, { modelCalls: 0, count: 0 });
});

test("a provider-confirmed floor persists even when the wrapper exits in local-only mode", () => {
  const result = runCase(`
    let calls = 0;
    const dateKey = anthropicBudget.getTodayUsage("UTC").dateKey;
    anthropicAdminUsage.maybeSyncToday = async () => ({
      dateKey, actualCostUsd: 0.39, uncachedInputTokens: 0,
      cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0
    });
    const sdk = client(async () => { calls++; throw new Error("must not send"); });
    const first = await requestBudgetedClaudeMessage(sdk, params, options);
    anthropicAdminUsage.maybeSyncToday = async () => null;
    const second = await requestBudgetedClaudeMessage(sdk, params, options);
    return { first, second, calls, usage: anthropicBudget.getTodayUsage("UTC") };
  `, { ANTHROPIC_USAGE_API_ENABLED: "true" });
  assert.equal(result.first, null);
  assert.equal(result.second, null);
  assert.equal(result.calls, 0);
  assert.equal(result.usage.requestCount, 0);
  assert.equal(result.usage.estimatedTotalCostUsd, 0.39);
});

test("overlapping model requests see the in-flight request reservation", () => {
  const result = runCase(`
    let calls = 0, release;
    const pending = new Promise((resolve) => { release = resolve; });
    const sdk = client(async () => {
      calls++;
      await pending;
      return { content: [], usage: { input_tokens: 10, output_tokens: 10 } };
    });
    const first = requestBudgetedClaudeMessage(sdk, params, options);
    const second = await requestBudgetedClaudeMessage(sdk, params, options);
    release();
    await first;
    return { calls, second, usage: anthropicBudget.getTodayUsage("UTC") };
  `, { ANTHROPIC_DAILY_REQUEST_LIMIT: "1" });
  assert.equal(result.calls, 1);
  assert.equal(result.second, null);
  assert.equal(result.usage.requestCount, 1);
});

test("ambiguous provider failure retains charged reservation and disables SDK retries", () => {
  const result = runCase(`
    let calls = 0, retries;
    const sdk = client(async (_params, requestOptions) => {
      calls++; retries = requestOptions.maxRetries;
      throw new Error("simulated connection reset after request was sent");
    });
    await assert.rejects(requestBudgetedClaudeMessage(sdk, params, options), /connection reset/);
    const second = await requestBudgetedClaudeMessage(sdk, params, options);
    return { calls, retries, second, usage: anthropicBudget.getTodayUsage("UTC") };
  `, { ANTHROPIC_DAILY_REQUEST_LIMIT: "1" });
  assert.equal(result.calls, 1);
  assert.equal(result.retries, 0);
  assert.equal(result.second, null);
  assert.equal(result.usage.requestCount, 1);
  assert.ok(result.usage.estimatedTotalCostUsd > 0);
});

test("local in-flight estimates are not promoted to permanent admin spending floors", () => {
  const result = runCase(`
    let calls = 0, release;
    const pending = new Promise((resolve) => { release = resolve; });
    const sdk = client(async () => {
      calls++;
      await pending;
      return { content: [], usage: { input_tokens: 10, output_tokens: 10 } };
    });
    const first = requestBudgetedClaudeMessage(sdk, params, options);
    const second = requestBudgetedClaudeMessage(sdk, params, options);
    release();
    await Promise.all([first, second]);
    return { calls, usage: anthropicBudget.getTodayUsage("UTC") };
  `);
  assert.equal(result.calls, 2);
  assert.equal(result.usage.requestCount, 2);
  assert.equal(result.usage.estimatedTotalCostUsd, 0.00036);
});

test("missing response usage preserves the reservation instead of assuming zero cost", () => {
  const result = runCase(`
    let reserved;
    await requestBudgetedClaudeMessage(client(async () => {
      reserved = anthropicBudget.getTodayUsage("UTC").estimatedTotalCostUsd;
      return { content: [{ type: "text", text: "ok" }] };
    }), params, options);
    return { reserved, usage: anthropicBudget.getTodayUsage("UTC") };
  `);
  assert.equal(result.usage.requestCount, 1);
  assert.ok(result.reserved > 0);
  assert.equal(result.usage.estimatedTotalCostUsd, result.reserved);
});
