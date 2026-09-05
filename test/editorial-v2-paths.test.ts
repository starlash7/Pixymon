import test from "node:test";
import assert from "node:assert/strict";
import { resolveEditorialRuntimePathsV2 } from "../src/services/editorial-v2/paths.ts";

test("shadow has a separate ledger and cannot be used as a live publishing path", () => {
  const env = { PIXYMON_DATA_DIR: "/tmp/live", EDITORIAL_TRACKING_MODE: "shadow" };
  assert.match(resolveEditorialRuntimePathsV2("observe", env).eventLogPath, /editorial-v2-shadow/);
  assert.throws(() => resolveEditorialRuntimePathsV2("live", env), /cannot run live/);
  assert.throws(() => resolveEditorialRuntimePathsV2("observe", {
    ...env, EDITORIAL_EVENT_LOG_PATH: "/tmp/live/editorial-v2/events.ndjson",
  }), /shadow directory/);
});

test("paper mode requires an isolated data directory", () => {
  assert.throws(() => resolveEditorialRuntimePathsV2("paper", { PIXYMON_DATA_DIR: "/tmp/live" }), /PIXYMON_PAPER_DATA_DIR/);
  assert.throws(() => resolveEditorialRuntimePathsV2("paper", { PIXYMON_DATA_DIR: "/tmp/same", PIXYMON_PAPER_DATA_DIR: "/tmp/same" }), /separate/);
  const paths = resolveEditorialRuntimePathsV2("paper", { PIXYMON_DATA_DIR: "/tmp/live", PIXYMON_PAPER_DATA_DIR: "/tmp/paper" });
  assert.equal(paths.dataDir, "/tmp/paper");
  assert.ok(paths.eventLogPath.startsWith("/tmp/paper/"));
});

test("observe and live share the configured durable review queue", () => {
  const observe = resolveEditorialRuntimePathsV2("observe", { PIXYMON_DATA_DIR: "/tmp/pixymon" });
  const live = resolveEditorialRuntimePathsV2("live", { PIXYMON_DATA_DIR: "/tmp/pixymon" });
  assert.equal(observe.eventLogPath, live.eventLogPath);
});
