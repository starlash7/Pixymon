import os from "os";
import path from "path";

const DEFAULT_SHARED_STATE_DIR = path.join(os.homedir(), ".pixymon", "state");

export function resolveSharedStateDir(): string {
  const raw = String(process.env.PIXYMON_SHARED_STATE_DIR || "").trim();
  if (!raw) {
    return DEFAULT_SHARED_STATE_DIR;
  }
  return path.resolve(raw);
}

export function resolveSharedStatePath(fileName: string): string {
  return path.join(resolveSharedStateDir(), fileName);
}
