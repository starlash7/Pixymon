import fs from "fs";
import os from "os";
import path from "path";

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
}

const DEFAULT_LOCK_PATH = path.join(process.cwd(), "data", "pixymon-runtime.lock");

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

  try {
    fs.unlinkSync(lockPath);
  } catch {
    return {
      acquired: false,
      lockPath,
      existingPid: stalePid,
      reason: "[LOCK] 기존 lock 파일 제거 실패",
      release: releaseNoop,
    };
  }

  const secondTry = tryAcquire(lockPath);
  if (secondTry.acquired) return secondTry;
  return secondTry;
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
  let fd: number | null = null;
  try {
    fd = fs.openSync(lockPath, "wx");
    const payload: LockMeta = {
      pid: process.pid,
      createdAt: new Date().toISOString(),
      host: os.hostname(),
    };
    fs.writeFileSync(fd, JSON.stringify(payload, null, 2), { encoding: "utf-8" });
    fs.closeSync(fd);
    fd = null;

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      try {
        const ownerPid = readLockPid(lockPath);
        if (!ownerPid || ownerPid === process.pid) {
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
  try {
    const raw = fs.readFileSync(lockPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<LockMeta>;
    if (typeof parsed.pid === "number" && Number.isFinite(parsed.pid) && parsed.pid > 0) {
      return Math.floor(parsed.pid);
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
