import "dotenv/config";
import type { ActionMode } from "../src/types/runtime.js";
import { resolveEditorialRuntimePathsV2 } from "../src/services/editorial-v2/paths.js";
import {
  buildEditorialReplayExportFromLedgerV2,
  serializeEditorialReplayExportV2,
  writeNewEditorialReplayFileV2,
} from "../src/services/editorial-v2/replay-export.js";

function option(name: string): string | undefined {
  const direct = process.argv.find((argument) => argument.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function actionMode(): ActionMode {
  const value = String(process.env.ACTION_MODE || "observe").trim();
  if (!['observe', 'paper', 'live'].includes(value)) throw new Error("ACTION_MODE is invalid");
  return value as ActionMode;
}

function main(): void {
  const eventLogPath = option("--event-log") ||
    resolveEditorialRuntimePathsV2(actionMode()).eventLogPath;
  const rawLimit = option("--limit");
  const limit = typeof rawLimit === "undefined" ? undefined : Number(rawLimit);
  const replay = buildEditorialReplayExportFromLedgerV2(eventLogPath, { limit });
  const output = option("--output");
  if (!output) {
    process.stdout.write(serializeEditorialReplayExportV2(replay));
    return;
  }
  const target = writeNewEditorialReplayFileV2(output, replay);
  console.log(`[EDITORIAL] immutable replay snapshot=${target} rows=${replay.rows.length} epoch=${replay.lineage.collectionEpoch} excluded=${replay.lineage.excludedDraftCount}`);
}

try {
  main();
} catch (error) {
  console.error(`[EDITORIAL] replay export failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
