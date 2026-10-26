import fs from "node:fs";
import path from "node:path";
import type { EditorialContextItemV2 } from "./contracts.js";
import { resolveDataDir } from "../data-dir.js";

export const TRAINER_NOTES_MAX_AGE_MS_V2 = 48 * 60 * 60 * 1000;
const MAX_TRAINER_ITEMS = 5;

/** Pixymon's trainer, the only account it calls "주인님" and the only one it may roast. */
export function trainerHandleV2(env: NodeJS.ProcessEnv = process.env): string {
  const handle = String(env.PIXYMON_TRAINER_HANDLE || "Pixy7Crypto").trim().replace(/^@/u, "");
  if (!/^[A-Za-z0-9_]{1,15}$/u.test(handle)) throw new Error("PIXYMON_TRAINER_HANDLE is invalid");
  return handle;
}

export function trainerNotesPathV2(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(String(env.PIXYMON_TRAINER_NOTES_PATH || path.join(resolveDataDir(env), "trainer-notes.md")));
}

/**
 * The operator's notes on what the trainer has been doing (until trainer timeline reads are funded).
 * Stale or missing notes yield nothing, so Pixymon never talks about the trainer without material.
 */
export function loadTrainerNotesV2(input: { notesPath: string; handle: string; now: Date }): EditorialContextItemV2[] {
  let stat: fs.Stats;
  try { stat = fs.statSync(input.notesPath); } catch { return []; }
  if (input.now.getTime() - stat.mtimeMs > TRAINER_NOTES_MAX_AGE_MS_V2) return [];
  const lines = fs.readFileSync(input.notesPath, "utf8").split(/\r?\n/u)
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+\.)\s+/u, "").trim())
    .filter((line) => line && !line.startsWith("#"))
    .slice(0, MAX_TRAINER_ITEMS);
  return lines.map((line, index) => ({
    id: `trainer:note:${index}`, kind: "trainer" as const, label: `주인님(@${input.handle}) 최근 활동`,
    text: line.slice(0, 200), provider: "operator-notes", publishedAt: new Date(stat.mtimeMs).toISOString(),
  }));
}
