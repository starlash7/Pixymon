import path from "path";

export function resolveDataDir(): string {
  return process.env.PIXYMON_DATA_DIR || path.join(process.cwd(), "data");
}
