import test from "node:test";
import assert from "node:assert/strict";
import { loadRuntimeConfig } from "../src/config/runtime.ts";
import {
  printEditorialV2StartupBanner,
  runEditorialV2Runtime,
  shouldCollectEditorialV2,
} from "../src/services/editorial-v2/runtime.ts";

test("scheduler drains a public follow-up candidate before the next generic interval", () => {
  assert.deepEqual(
    shouldCollectEditorialV2({
      publicCandidateCount: 1,
      nowMs: 1_000,
      nextGenericCollectAtMs: 50_000,
    }),
    { collect: true, genericDue: false }
  );
  assert.deepEqual(
    shouldCollectEditorialV2({
      publicCandidateCount: 0,
      nowMs: 1_000,
      nextGenericCollectAtMs: 50_000,
    }),
    { collect: false, genericDue: false }
  );
});

for (const flags of [
  { TEST_MODE: "true", TEST_NO_EXTERNAL_CALLS: "true" },
  { TEST_MODE: "false", TEST_NO_EXTERNAL_CALLS: "true" },
  { TEST_MODE: undefined, TEST_NO_EXTERNAL_CALLS: "true" },
  { TEST_MODE: "true", TEST_NO_EXTERNAL_CALLS: undefined },
]) {
  test(`V2 offline flags ${JSON.stringify(flags)} exit before provider or model network`, async () => {
    const previous = {
      testMode: process.env.TEST_MODE,
      noExternal: process.env.TEST_NO_EXTERNAL_CALLS,
      actionMode: process.env.ACTION_MODE,
      pipeline: process.env.POST_PIPELINE_VERSION,
    };
    const originalFetch = globalThis.fetch;
    const originalLog = console.log;
    const messages: string[] = [];
    let fetchCalls = 0;
    if (flags.TEST_MODE === undefined) delete process.env.TEST_MODE;
    else process.env.TEST_MODE = flags.TEST_MODE;
    if (flags.TEST_NO_EXTERNAL_CALLS === undefined) delete process.env.TEST_NO_EXTERNAL_CALLS;
    else process.env.TEST_NO_EXTERNAL_CALLS = flags.TEST_NO_EXTERNAL_CALLS;
    process.env.ACTION_MODE = "observe";
    process.env.POST_PIPELINE_VERSION = "v2";
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("network must not run");
    }) as typeof fetch;
    console.log = (...args: unknown[]) => messages.push(args.join(" "));
    try {
      printEditorialV2StartupBanner(loadRuntimeConfig());
      await runEditorialV2Runtime({} as never, loadRuntimeConfig());
      assert.equal(fetchCalls, 0);
      assert.ok(messages.some((message) => message.includes("[TEST-LOCAL]")));
      assert.ok(messages.some((message) => message.includes("reason=external-calls-disabled")));
    } finally {
      globalThis.fetch = originalFetch;
      console.log = originalLog;
      if (previous.testMode === undefined) delete process.env.TEST_MODE; else process.env.TEST_MODE = previous.testMode;
      if (previous.noExternal === undefined) delete process.env.TEST_NO_EXTERNAL_CALLS; else process.env.TEST_NO_EXTERNAL_CALLS = previous.noExternal;
      if (previous.actionMode === undefined) delete process.env.ACTION_MODE; else process.env.ACTION_MODE = previous.actionMode;
      if (previous.pipeline === undefined) delete process.env.POST_PIPELINE_VERSION; else process.env.POST_PIPELINE_VERSION = previous.pipeline;
    }
  });
}
