import os from "os";
import path from "path";
import { externalCallsDisabled } from "./external-call-policy.js";

export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const actionMode = String(env.ACTION_MODE || "observe").trim().toLowerCase();
  const paperDir = String(env.PIXYMON_PAPER_DATA_DIR || "").trim();
  const liveDir =
    env.PIXYMON_LIVE_DATA_DIR ||
    env.PIXYMON_DATA_DIR ||
    path.join(process.cwd(), "data");
  if (actionMode === "paper") {
    if (!paperDir) {
      throw new Error("PIXYMON_PAPER_DATA_DIR is required in paper mode");
    }
    if (path.resolve(process.cwd(), paperDir) === path.resolve(process.cwd(), liveDir)) {
      throw new Error("paper data directory must be separate from PIXYMON_DATA_DIR");
    }
    return paperDir;
  }
  return liveDir;
}

/**
 * Spend is billed per API key, not per checkout. Every process that can reach a paid provider shares
 * one ledger per machine user, so separate worktrees or data directories cannot each get a fresh daily
 * cap. Offline/test processes keep their own data directory and never touch the real ledger.
 */
export function resolveSpendLedgerDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = String(env.PIXYMON_SPEND_DIR || "").trim();
  if (configured) return path.resolve(configured);
  if (externalCallsDisabled(env)) return resolveDataDir(env);
  return path.join(os.homedir(), ".pixymon", "spend");
}
