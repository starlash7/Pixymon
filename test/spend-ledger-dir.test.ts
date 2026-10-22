import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveSpendLedgerDir } from "../src/services/data-dir.ts";

test("paid-provider processes share one spend ledger per machine user, regardless of data directory", () => {
  const shared = path.join(os.homedir(), ".pixymon", "spend");
  assert.equal(resolveSpendLedgerDir({ TEST_NO_EXTERNAL_CALLS: "false", PIXYMON_DATA_DIR: "/worktree-a/data" }), shared);
  assert.equal(resolveSpendLedgerDir({ TEST_NO_EXTERNAL_CALLS: "false", PIXYMON_DATA_DIR: "/worktree-b/data" }), shared);
});

test("offline processes keep their own data directory and an explicit override wins", () => {
  assert.equal(resolveSpendLedgerDir({ TEST_NO_EXTERNAL_CALLS: "true", PIXYMON_DATA_DIR: "/tmp/offline" }), "/tmp/offline");
  assert.equal(resolveSpendLedgerDir({ TEST_MODE: "true", PIXYMON_DATA_DIR: "/tmp/offline" }), "/tmp/offline");
  assert.equal(resolveSpendLedgerDir({ TEST_NO_EXTERNAL_CALLS: "false", PIXYMON_SPEND_DIR: "/tmp/spend" }), "/tmp/spend");
});
