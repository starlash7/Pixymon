import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertExternalCallsAllowed, externalCallsDisabled } from "../src/services/external-call-policy.ts";

test("external-call policy denies explicit blocking flags independently of TEST_MODE", () => {
  for (const testMode of [undefined, "false", "true"]) {
    for (const blocked of ["true", " TRUE ", "", "invalid"]) {
      const env = { TEST_MODE: testMode, TEST_NO_EXTERNAL_CALLS: blocked };
      assert.equal(externalCallsDisabled(env), true, JSON.stringify(env));
      assert.throws(() => assertExternalCallsAllowed("test request", env), /test request blocked: external calls are disabled/);
    }
    const env = { TEST_MODE: testMode, TEST_NO_EXTERNAL_CALLS: " false " };
    assert.equal(externalCallsDisabled(env), false, JSON.stringify(env));
    assert.doesNotThrow(() => assertExternalCallsAllowed("test request", env));
  }
});

test("TEST_MODE defaults to offline while ordinary unset flags preserve live behavior", () => {
  assert.equal(externalCallsDisabled({ TEST_MODE: "true" }), true);
  assert.equal(externalCallsDisabled({ TEST_MODE: " TRUE " }), true);
  assert.equal(externalCallsDisabled({ TEST_MODE: "false" }), false);
  assert.equal(externalCallsDisabled({}), false);
});

test("external-call permissions are re-read at the call boundary", (t) => {
  const previous = process.env.TEST_NO_EXTERNAL_CALLS;
  t.after(() => {
    if (previous === undefined) delete process.env.TEST_NO_EXTERNAL_CALLS;
    else process.env.TEST_NO_EXTERNAL_CALLS = previous;
  });
  process.env.TEST_NO_EXTERNAL_CALLS = "false";
  assert.doesNotThrow(() => assertExternalCallsAllowed("first request"));
  process.env.TEST_NO_EXTERNAL_CALLS = "true";
  assert.throws(() => assertExternalCallsAllowed("second request"), /external calls are disabled/);
});

const offlineFlags = [
  { TEST_MODE: "true", TEST_NO_EXTERNAL_CALLS: "true" },
  { TEST_MODE: "false", TEST_NO_EXTERNAL_CALLS: "true" },
  { TEST_MODE: undefined, TEST_NO_EXTERNAL_CALLS: "true" },
  { TEST_MODE: "true", TEST_NO_EXTERNAL_CALLS: undefined },
] as const;

for (const trackingMode of ["live", "shadow"]) {
  for (const flags of offlineFlags) {
    test(`collect ${trackingMode} rejects offline flags ${JSON.stringify(flags)} before API key/client/provider access`, (t) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-offline-cli-"));
      t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
      const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/editorial-collect.ts"], {
        env: {
          ...process.env,
          DOTENV_CONFIG_PATH: path.join(dir, "nonexistent.env"),
          POST_PIPELINE_VERSION: "v2",
          ACTION_MODE: "observe",
          EDITORIAL_TRACKING_MODE: trackingMode,
          PIXYMON_DATA_DIR: dir,
          PIXYMON_LIVE_DATA_DIR: dir,
          EDITORIAL_EVENT_LOG_PATH: "",
          EDITORIAL_METRIC_LOG_PATH: "",
          EDITORIAL_PUBLISH_LOCK_PATH: "",
          // Missing key is a second safety barrier if the CLI guard regresses.
          ANTHROPIC_API_KEY: "",
          TYPESAFE_API_KEY: "",
          ...flags,
        },
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /editorial:collect blocked: external calls are disabled/);
      assert.doesNotMatch(result.stderr, /ANTHROPIC_API_KEY is required/);
      assert.equal(fs.existsSync(path.join(dir, trackingMode === "shadow" ? "editorial-v2-shadow" : "editorial-v2")), false);
    });
  }
}

for (const flags of offlineFlags) {
  test(`followups rejects offline flags ${JSON.stringify(flags)} before provider access`, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-offline-followups-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/editorial-followups.ts"], {
      env: {
        ...process.env,
        DOTENV_CONFIG_PATH: path.join(dir, "nonexistent.env"),
        POST_PIPELINE_VERSION: "v2",
        ACTION_MODE: "observe",
        EDITORIAL_TRACKING_MODE: "live",
        PIXYMON_DATA_DIR: dir,
        PIXYMON_LIVE_DATA_DIR: dir,
        EDITORIAL_EVENT_LOG_PATH: "",
        EDITORIAL_METRIC_LOG_PATH: "",
        ...flags,
      },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /editorial:followups blocked: external calls are disabled/);
    assert.equal(fs.existsSync(path.join(dir, "editorial-v2")), false);
  });
}
