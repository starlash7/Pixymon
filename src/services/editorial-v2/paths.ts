import path from "node:path";
import type { ActionMode } from "../../types/runtime.js";

export interface EditorialRuntimePathsV2 {
  trackingMode: "live" | "shadow";
  dataDir: string;
  eventLogPath: string;
  metricLogPath: string;
  publishLockPath: string;
}

function absolute(value: string): string {
  return path.resolve(process.cwd(), value);
}

export function resolveEditorialRuntimePathsV2(
  mode: ActionMode,
  env: NodeJS.ProcessEnv = process.env
): EditorialRuntimePathsV2 {
  const trackingMode = String(env.EDITORIAL_TRACKING_MODE || "live");
  if (trackingMode !== "live" && trackingMode !== "shadow") throw new Error("invalid EDITORIAL_TRACKING_MODE");
  if (trackingMode === "shadow" && mode === "live") throw new Error("shadow tracking cannot run live");
  const liveDataDir = absolute(String(env.PIXYMON_LIVE_DATA_DIR || env.PIXYMON_DATA_DIR || "data"));
  const configuredPaperDir = String(env.PIXYMON_PAPER_DATA_DIR || "").trim();
  if (mode === "paper" && !configuredPaperDir) {
    throw new Error("PIXYMON_PAPER_DATA_DIR is required in paper mode");
  }
  const dataDir = mode === "paper" ? absolute(configuredPaperDir) : liveDataDir;
  if (mode === "paper" && dataDir === liveDataDir) {
    throw new Error("paper data directory must be separate from PIXYMON_DATA_DIR");
  }
  const editorialDir = path.join(dataDir, trackingMode === "shadow" ? "editorial-v2-shadow" : "editorial-v2");
  const eventLogPath = absolute(
    String(env.EDITORIAL_EVENT_LOG_PATH || path.join(editorialDir, "events.ndjson"))
  );
  const metricLogPath = absolute(
    String(env.EDITORIAL_METRIC_LOG_PATH || path.join(editorialDir, "metrics.ndjson"))
  );
  const publishLockPath = absolute(
    String(env.EDITORIAL_PUBLISH_LOCK_PATH || path.join(editorialDir, "publish.lock"))
  );
  if (trackingMode === "shadow") {
    for (const target of [eventLogPath, metricLogPath, publishLockPath]) {
      const relative = path.relative(editorialDir, target);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error("shadow editorial paths must stay inside the shadow directory");
      }
    }
  }
  if (mode === "paper") {
    for (const target of [eventLogPath, metricLogPath, publishLockPath]) {
      const relative = path.relative(dataDir, target);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error("paper editorial paths must stay inside PIXYMON_PAPER_DATA_DIR");
      }
    }
  }
  return { dataDir, eventLogPath, metricLogPath, publishLockPath, trackingMode };
}
