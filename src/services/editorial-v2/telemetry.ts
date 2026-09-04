import fs from "node:fs";
import path from "node:path";

export type EditorialMetricTypeV2 =
  | "provider_fetch"
  | "planning_decision"
  | "generation_attempt"
  | "review_decision"
  | "dispatch_decision"
  | "followup_resolution";

export interface EditorialMetricV2 {
  schemaVersion: 2;
  type: EditorialMetricTypeV2;
  timestamp: string;
  runId: string;
  actionId: string;
  mode: "observe" | "paper" | "live";
  stage: string;
  outcome: string;
  reason?: string;
  details?: Record<string, string | number | boolean | string[] | null>;
}
export interface EditorialMetricContextV2 {
  runId: string;
  actionId: string;
  mode: EditorialMetricV2["mode"];
  now?: Date;
}

export function buildEditorialMetricV2(
  context: EditorialMetricContextV2,
  input: Omit<EditorialMetricV2, "schemaVersion" | "timestamp" | "runId" | "actionId" | "mode">
): EditorialMetricV2 {
  return {
    schemaVersion: 2,
    timestamp: (context.now || new Date()).toISOString(),
    runId: context.runId,
    actionId: context.actionId,
    mode: context.mode,
    ...input,
  };
}

export function appendEditorialMetricV2(filePath: string, event: EditorialMetricV2): void {
  const normalized = String(filePath || "").trim();
  if (!normalized) {
    throw new Error("editorial-metric-path-missing");
  }
  const target = path.isAbsolute(normalized) ? normalized : path.join(process.cwd(), normalized);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, `${JSON.stringify(event)}\n`, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[EDITORIAL-METRIC] write failed: ${message}`);
    throw new Error(`editorial-metric-write-failed:${message}`);
  }
}
