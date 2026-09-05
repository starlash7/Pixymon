import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "node:crypto";
import { resolveDataDir } from "./data-dir.js";

export interface RuntimeLock {
  acquired: boolean;
  lockPath: string;
  existingPid?: number;
  reason?: string;
  release: () => void;
}

interface LockMeta {
  pid: number;
  createdAt: string;
  host: string;
  token?: string;
}

const DEFAULT_LOCK_PATH = path.join(resolveDataDir(), "pixymon-runtime.lock");

export function acquireRuntimeLock(lockPath: string = DEFAULT_LOCK_PATH): RuntimeLock {
  const releaseNoop = () => {};
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  } catch (error) {
    return {
      acquired: false,
      lockPath,
      reason: `[LOCK] 디렉토리 생성 실패: ${String(error)}`,
      release: releaseNoop,
    };
  }

  const firstTry = tryAcquire(lockPath);
  if (firstTry.acquired) return firstTry;
  if (firstTry.reason !== "exists") {
    return firstTry;
  }

  const stalePid = readLockPid(lockPath);
  if (stalePid && isProcessAlive(stalePid)) {
    return {
      acquired: false,
      lockPath,
      existingPid: stalePid,
      reason: "[LOCK] 이미 실행 중인 Pixymon 프로세스가 있음",
      release: releaseNoop,
    };
  }
  // Never auto-delete a stale-looking path. POSIX unlink has no
  // compare-and-delete primitive: another contender could replace the stale
  // inode between our read and unlink, causing us to remove its live lock.
  return {
    acquired: false,
    lockPath,
    existingPid: stalePid,
    reason: "[LOCK] stale 또는 확인 불가 lock 존재; 상태 확인 후 수동 정리 필요",
    release: releaseNoop,
  };
}

export function registerRuntimeLockCleanup(lock: RuntimeLock): void {
  if (!lock.acquired) return;
  const cleanup = () => {
    lock.release();
  };
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);
  process.once("exit", cleanup);
}

function tryAcquire(lockPath: string): RuntimeLock {
  const releaseNoop = () => {};
  const token = randomUUID();
  const temporaryPath = `${lockPath}.${process.pid}.${token}.tmp`;
  let fd: number | null = null;
  try {
    // Publish only a fully written metadata file. Creating lockPath first and
    // filling it afterwards leaves a window where a contender can mistake the
    // empty file for a stale lock and unlink it.
    fd = fs.openSync(temporaryPath, "wx", 0o600);
    const payload: LockMeta = {
      pid: process.pid,
      createdAt: new Date().toISOString(),
      host: os.hostname(),
      token,
    };
    fs.writeFileSync(fd, JSON.stringify(payload, null, 2), { encoding: "utf-8" });
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.linkSync(temporaryPath, lockPath);
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // The published lock is valid; a leftover private temp link is harmless.
    }

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      try {
        const owner = readLockMeta(lockPath);
        if (owner?.pid === process.pid && owner.token === token) {
          fs.unlinkSync(lockPath);
        }
      } catch {
        // no-op
      }
    };

    return {
      acquired: true,
      lockPath,
      release,
    };
  } catch (error: any) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // no-op
      }
    }
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // no-op
    }
    if (error?.code === "EEXIST") {
      return {
        acquired: false,
        lockPath,
        reason: "exists",
        release: releaseNoop,
      };
    }
    return {
      acquired: false,
      lockPath,
      reason: `[LOCK] lock 생성 실패: ${String(error)}`,
      release: releaseNoop,
    };
  }
}

function readLockPid(lockPath: string): number | undefined {
  return readLockMeta(lockPath)?.pid;
}

function readLockMeta(lockPath: string): LockMeta | undefined {
  try {
    const raw = fs.readFileSync(lockPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<LockMeta>;
    if (typeof parsed.pid === "number" && Number.isFinite(parsed.pid) && parsed.pid > 0) {
      return {
        pid: Math.floor(parsed.pid),
        createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
        host: typeof parsed.host === "string" ? parsed.host : "",
        token: typeof parsed.token === "string" ? parsed.token : undefined,
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    if (error?.code === "EPERM") return true;
    return false;
  }
}
