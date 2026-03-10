import fs from "fs";
import path from "path";
import { sanitizeTweetText } from "./engagement/quality.js";
import { detectNarrativeFlagHits } from "./narrative-lexicon.js";

export type NarrativeSurfaceKind = "post" | "quote" | "reply";

interface NarrativeObservationInput {
  surface: NarrativeSurfaceKind;
  text: string;
  language: "ko" | "en";
  lane?: string;
  narrativeMode?: string;
  fallbackKind?: string;
}

interface NarrativeObservationEvent {
  type: "narrative_observation";
  timestamp: string;
  surface: NarrativeSurfaceKind;
  language: "ko" | "en";
  lane: string;
  narrativeMode: string;
  fallbackKind: string;
  text: string;
  hits: ReturnType<typeof detectNarrativeFlagHits>;
}

interface NarrativeObservationSummary {
  total: number;
  bySurface: Record<NarrativeSurfaceKind, number>;
  byLabel: Record<string, number>;
  latestHits: Array<{
    timestamp: string;
    surface: NarrativeSurfaceKind;
    label: string;
    match: string;
  }>;
}

export function recordNarrativeObservation(input: NarrativeObservationInput): void {
  const settings = resolveNarrativeAuditSettings();
  if (!settings.enabled) return;

  const text = sanitizeTweetText(input.text);
  if (!text) return;

  const event: NarrativeObservationEvent = {
    type: "narrative_observation",
    timestamp: new Date().toISOString(),
    surface: input.surface,
    language: input.language,
    lane: String(input.lane || "unknown"),
    narrativeMode: String(input.narrativeMode || "unknown"),
    fallbackKind: String(input.fallbackKind || "none"),
    text,
    hits: detectNarrativeFlagHits(text, input.language),
  };

  appendNdjson(settings.logPath, event);
  updateSummary(settings.summaryPath, event);
}

function appendNdjson(filePath: string, event: NarrativeObservationEvent): void {
  const targetPath = resolvePath(filePath);
  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.appendFileSync(targetPath, `${JSON.stringify(event)}\n`);
  } catch {
    // no-op
  }
}

function updateSummary(filePath: string, event: NarrativeObservationEvent): void {
  const targetPath = resolvePath(filePath);
  const summary = readSummary(targetPath);

  summary.total += 1;
  summary.bySurface[event.surface] = (summary.bySurface[event.surface] || 0) + 1;
  for (const hit of event.hits) {
    summary.byLabel[hit.label] = (summary.byLabel[hit.label] || 0) + 1;
    summary.latestHits.unshift({
      timestamp: event.timestamp,
      surface: event.surface,
      label: hit.label,
      match: hit.match,
    });
  }
  summary.latestHits = summary.latestHits.slice(0, 50);

  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, `${JSON.stringify(summary, null, 2)}\n`);
  } catch {
    // no-op
  }
}

function readSummary(filePath: string): NarrativeObservationSummary {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<NarrativeObservationSummary>;
    return {
      total: Number.isFinite(parsed.total) ? Number(parsed.total) : 0,
      bySurface: {
        post: Number(parsed.bySurface?.post || 0),
        quote: Number(parsed.bySurface?.quote || 0),
        reply: Number(parsed.bySurface?.reply || 0),
      },
      byLabel: parsed.byLabel && typeof parsed.byLabel === "object" ? { ...parsed.byLabel } : {},
      latestHits: Array.isArray(parsed.latestHits) ? parsed.latestHits.slice(0, 50) as NarrativeObservationSummary["latestHits"] : [],
    };
  } catch {
    return {
      total: 0,
      bySurface: { post: 0, quote: 0, reply: 0 },
      byLabel: {},
      latestHits: [],
    };
  }
}

function resolvePath(rawPath: string): string {
  const normalized = String(rawPath || "").trim();
  if (!normalized) {
    return path.join(process.cwd(), "data", "narrative-observation.ndjson");
  }
  return path.isAbsolute(normalized) ? normalized : path.join(process.cwd(), normalized);
}

function resolveNarrativeAuditSettings(): { enabled: boolean; logPath: string; summaryPath: string } {
  return {
    enabled: String(process.env.NARRATIVE_AUDIT_ENABLED ?? "true").trim().toLowerCase() !== "false",
    logPath: process.env.NARRATIVE_AUDIT_LOG_PATH || "data/narrative-observation.ndjson",
    summaryPath: process.env.NARRATIVE_AUDIT_SUMMARY_PATH || "data/narrative-phrase-audit.json",
  };
}
