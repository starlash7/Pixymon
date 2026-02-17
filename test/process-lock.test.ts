import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { acquireRuntimeLock } from "../src/services/process-lock.ts";

test("runtime lock blocks second acquisition and allows re-acquire after release", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-lock-"));
  const lockPath = path.join(tmpDir, "runtime.lock");

  const first = acquireRuntimeLock(lockPath);
  assert.equal(first.acquired, true);

  const second = acquireRuntimeLock(lockPath);
  assert.equal(second.acquired, false);
  assert.equal(second.existingPid, process.pid);

  first.release();
  const third = acquireRuntimeLock(lockPath);
  assert.equal(third.acquired, true);
  third.release();

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
