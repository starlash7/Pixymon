import path from "path";

export function resolveDataDir(): string {
  const actionMode = String(process.env.ACTION_MODE || "observe").trim().toLowerCase();
  const paperDir = String(process.env.PIXYMON_PAPER_DATA_DIR || "").trim();
  const liveDir =
    process.env.PIXYMON_LIVE_DATA_DIR ||
    process.env.PIXYMON_DATA_DIR ||
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
