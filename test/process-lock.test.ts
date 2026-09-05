import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import { acquireRuntimeLock } from "../src/services/process-lock.ts";

async function contendForLock(lockPath: string, count = 8): Promise<string[]> {
  const moduleUrl = pathToFileURL(path.resolve("src/services/process-lock.ts")).href;
  const childSource = `
    import { acquireRuntimeLock } from ${JSON.stringify(moduleUrl)};
    let lock;
    process.on("message", (message) => {
      if (message === "acquire") {
        lock = acquireRuntimeLock(process.env.LOCK_PATH);
        process.send(lock.acquired ? "acquired" : "blocked");
      } else if (message === "release") {
        lock?.release();
        process.disconnect();
      }
    });
    process.send("ready");
  `;
  const children: ChildProcess[] = [];
  try {
    return await new Promise<string[]>((resolve, reject) => {
      const outcomes: string[] = [];
      let ready = 0;
      let exited = 0;
      const timeout = setTimeout(() => reject(new Error("lock contention barrier timed out")), 20_000);
      for (let index = 0; index < count; index++) {
      const child = spawn(process.execPath, [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        childSource,
      ], {
        env: {
          ...process.env,
          LOCK_PATH: lockPath,
        },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      children.push(child);
      let stderr = "";
      child.stderr!.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
      child.on("message", (message) => {
        if (message === "ready") {
          if (++ready === count) children.forEach((process) => process.send("acquire"));
        } else if (message === "acquired" || message === "blocked") {
          outcomes.push(message);
          // The owner holds its lock until even the slowest child has tried.
          if (outcomes.length === count) children.forEach((process) => process.send("release"));
        }
      });
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      child.once("exit", (code) => {
        if (code !== 0) { clearTimeout(timeout); reject(new Error(`lock child failed (${code}): ${stderr}`)); }
        else if (++exited === count) { clearTimeout(timeout); resolve(outcomes); }
      });
      }
    });
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
  }
}

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

test("runtime lock publishes complete metadata and release cannot remove a replacement lock", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-lock-owner-"));
  const lockPath = path.join(tmpDir, "runtime.lock");
  try {
    const lock = acquireRuntimeLock(lockPath);
    assert.equal(lock.acquired, true);
    const metadata = JSON.parse(fs.readFileSync(lockPath, "utf8")) as {
      pid?: number;
      token?: string;
    };
    assert.equal(metadata.pid, process.pid);
    assert.match(metadata.token || "", /^[0-9a-f-]{36}$/i);

    fs.unlinkSync(lockPath);
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: process.pid,
      createdAt: new Date().toISOString(),
      host: os.hostname(),
      token: "replacement-owner-token",
    }));
    lock.release();
    assert.equal(fs.existsSync(lockPath), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("runtime lock admits only one process at a shared acquisition boundary", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-lock-processes-"));
  const lockPath = path.join(tmpDir, "runtime.lock");
  try {
    const outcomes = await contendForLock(lockPath);
    assert.equal(outcomes.filter((outcome) => outcome === "acquired").length, 1);
    assert.equal(outcomes.filter((outcome) => outcome === "blocked").length, 7);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("runtime lock never auto-recovers a stale-looking path under contention", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-lock-stale-"));
  const lockPath = path.join(tmpDir, "runtime.lock");
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: 2_147_483_647,
    createdAt: "2000-01-01T00:00:00.000Z",
    host: os.hostname(),
    token: "dead-owner",
  }));
  try {
    const outcomes = await contendForLock(lockPath, 16);
    assert.deepEqual(new Set(outcomes), new Set(["blocked"]));
    assert.equal(fs.existsSync(lockPath), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
