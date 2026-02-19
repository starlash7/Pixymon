import { DigestScore, NutrientLedgerEntry, OnchainNutrient } from "../types/agent.js";

const DEFAULT_MIN_DIGEST_SCORE = 0.5;

export interface DigestedNutrient {
  nutrient: OnchainNutrient;
  digest: DigestScore;
  xpGain: number;
  accepted: boolean;
  rejectionReason?: string;
}

export interface DigestBatchResult {
  records: DigestedNutrient[];
  intakeCount: number;
  acceptedCount: number;
  avgDigestScore: number;
  xpGainTotal: number;
}

interface DigestBatchOptions {
  minDigestScore?: number;
  maxItems?: number;
}

export function digestNutrients(
  nutrients: OnchainNutrient[],
  recentLedger: NutrientLedgerEntry[],
  options: DigestBatchOptions = {}
): DigestBatchResult {
  const minDigestScore = clamp(options.minDigestScore ?? DEFAULT_MIN_DIGEST_SCORE, 0.2, 0.95);
  const maxItems = clampInt(options.maxItems ?? nutrients.length, 1, 64);
  const deduped = dedupNutrients(nutrients).slice(0, maxItems);

  const records = deduped.map((nutrient) => {
    const digest = computeDigestScore(nutrient, recentLedger);
    const accepted = digest.total >= minDigestScore;
    const xpGain = accepted ? convertDigestToXp(digest, nutrient) : 0;
    return {
      nutrient,
      digest,
      xpGain,
      accepted,
      rejectionReason: accepted ? undefined : toRejectReason(digest),
    };
  });

  const intakeCount = records.length;
  const acceptedCount = records.filter((row) => row.accepted).length;
  const avgDigestScore =
    intakeCount > 0
      ? Math.round((records.reduce((sum, row) => sum + row.digest.total, 0) / intakeCount) * 100) / 100
      : 0;
  const xpGainTotal = records.reduce((sum, row) => sum + row.xpGain, 0);

  return {
    records,
    intakeCount,
    acceptedCount,
    avgDigestScore,
    xpGainTotal,
  };
}

export function computeDigestScore(
  nutrient: OnchainNutrient,
  recentLedger: NutrientLedgerEntry[]
): DigestScore {
  const trust = clamp(nutrient.trust, 0.05, 0.99);
  const freshness = resolveFreshness(nutrient);
  const consistency = resolveConsistency(nutrient, recentLedger);
  const total = round(trust * 0.45 + freshness * 0.3 + consistency * 0.25, 2);

  const reasonCodes: string[] = [];
  if (trust < 0.45) reasonCodes.push("low-trust");
  if (freshness < 0.45) reasonCodes.push("stale-signal");
  if (consistency < 0.45) reasonCodes.push("low-consistency");
  if (total >= 0.72) reasonCodes.push("high-quality");
  else if (total >= 0.55) reasonCodes.push("medium-quality");
  else reasonCodes.push("low-quality");

  return {
    trust: round(trust, 2),
    freshness: round(freshness, 2),
    consistency: round(consistency, 2),
    total,
    reasonCodes,
  };
}

export function convertDigestToXp(digest: DigestScore, nutrient: OnchainNutrient): number {
  if (digest.total < 0.4) return 0;
  const sourceBonus = nutrient.source === "onchain" ? 2 : nutrient.source === "market" ? 1 : 0;
  const importanceBonus = resolveImportanceBonus(nutrient);
  const base = digest.total * 10;
  return clampInt(Math.round(base + sourceBonus + importanceBonus), 1, 18);
}

function resolveFreshness(nutrient: OnchainNutrient): number {
  const fromPayload = clamp(nutrient.freshness, 0.05, 0.99);
  const ts = new Date(nutrient.capturedAt).getTime();
  if (!Number.isFinite(ts)) return fromPayload;

  const ageHours = Math.max(0, (Date.now() - ts) / (1000 * 60 * 60));
  if (ageHours <= 2) return fromPayload;

  const decay = clamp(1 - ageHours / 36, 0.15, 1);
  return round(fromPayload * decay, 2);
}

function resolveConsistency(nutrient: OnchainNutrient, recentLedger: NutrientLedgerEntry[]): number {
  const base = clamp(nutrient.consistencyHint ?? 0.66, 0.15, 0.95);
  const recentSame = recentLedger
    .filter((item) => item.source === nutrient.source && item.category === nutrient.category)
    .slice(-8);
  if (recentSame.length === 0) return round(base, 2);

  const avgPast = recentSame.reduce((sum, item) => sum + item.digestScore.consistency, 0) / recentSame.length;
  const repeatedLabel = recentSame.some(
    (item) => normalize(item.label) === normalize(nutrient.label) && item.accepted
  );
  const penalty = repeatedLabel ? 0.08 : 0;
  return round(clamp((base + avgPast) / 2 - penalty, 0.15, 0.95), 2);
}

function resolveImportanceBonus(nutrient: OnchainNutrient): number {
  const raw = String(nutrient.metadata?.importance || "").toLowerCase();
  if (raw === "high") return 2;
  if (raw === "medium") return 1;
  return 0;
}

function dedupNutrients(nutrients: OnchainNutrient[]): OnchainNutrient[] {
  const dedup = new Map<string, OnchainNutrient>();
  for (const nutrient of nutrients) {
    const key = `${nutrient.source}|${nutrient.category}|${normalize(nutrient.label)}|${normalize(nutrient.value)}`;
    if (!dedup.has(key)) {
      dedup.set(key, nutrient);
    }
  }
  return Array.from(dedup.values());
}

function toRejectReason(digest: DigestScore): string {
  if (digest.reasonCodes.includes("low-trust")) return "low-trust";
  if (digest.reasonCodes.includes("stale-signal")) return "stale-signal";
  if (digest.reasonCodes.includes("low-consistency")) return "low-consistency";
  return "low-quality";
}

function normalize(text: string): string {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function round(value: number, precision: number): number {
  const scale = Math.pow(10, Math.max(0, precision));
  return Math.round(value * scale) / scale;
}
