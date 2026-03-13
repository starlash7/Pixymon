import fs from "fs";
import path from "path";
import { resolveDataDir } from "./data-dir.js";

const QUARANTINE_DIR = path.join(resolveDataDir(), "quarantine");

export function isQuarantineEnabled(): boolean {
  return String(process.env.SESSION_QUARANTINE_ON_PARSE_ERROR || "true").trim().toLowerCase() === "true";
}

export function quarantineCorruptFile(params: {
  filePath: string;
  raw: string;
  reason: string;
}): string | null {
  if (!isQuarantineEnabled()) {
    return null;
  }

  try {
    fs.mkdirSync(QUARANTINE_DIR, { recursive: true });
    const base = path.basename(params.filePath).replace(/[^a-zA-Z0-9._-]/g, "_");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = path.join(QUARANTINE_DIR, `${base}.${stamp}.bad.json`);
    const metaPath = `${target}.meta.json`;
    fs.writeFileSync(target, params.raw, "utf-8");
    fs.writeFileSync(
      metaPath,
      JSON.stringify(
        {
          source: params.filePath,
          reason: params.reason,
          quarantinedAt: new Date().toISOString(),
        },
        null,
        2
      ),
      "utf-8"
    );
    return target;
  } catch {
    return null;
  }
}
