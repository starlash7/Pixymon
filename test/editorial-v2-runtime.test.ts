import test from "node:test";
import assert from "node:assert/strict";
import { loadRuntimeConfig } from "../src/config/runtime.ts";
import {
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

test("V2 TEST_NO_EXTERNAL_CALLS exits before provider or model network", async () => {
  const previous = {
    testMode: process.env.TEST_MODE,
    noExternal: process.env.TEST_NO_EXTERNAL_CALLS,
    actionMode: process.env.ACTION_MODE,
    pipeline: process.env.POST_PIPELINE_VERSION,
  };
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  process.env.TEST_MODE = "true";
  process.env.TEST_NO_EXTERNAL_CALLS = "true";
  process.env.ACTION_MODE = "observe";
  process.env.POST_PIPELINE_VERSION = "v2";
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("network must not run");
  }) as typeof fetch;
  try {
    await runEditorialV2Runtime({} as never, loadRuntimeConfig());
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (previous.testMode === undefined) delete process.env.TEST_MODE; else process.env.TEST_MODE = previous.testMode;
    if (previous.noExternal === undefined) delete process.env.TEST_NO_EXTERNAL_CALLS; else process.env.TEST_NO_EXTERNAL_CALLS = previous.noExternal;
    if (previous.actionMode === undefined) delete process.env.ACTION_MODE; else process.env.ACTION_MODE = previous.actionMode;
    if (previous.pipeline === undefined) delete process.env.POST_PIPELINE_VERSION; else process.env.POST_PIPELINE_VERSION = previous.pipeline;
  }
});
