import test from "node:test";
import assert from "node:assert/strict";
import { resolveEditorialRuntimePathsV2 } from "../src/services/editorial-v2/paths.ts";

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
