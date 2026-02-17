import { memory } from "../memory.js";
import { AdaptivePolicy } from "./types.js";

export const DEFAULT_DAILY_TARGET = 20;

export function getDefaultAdaptivePolicy(): AdaptivePolicy {
  return {
    postDuplicateThreshold: 0.74,
    postNarrativeThreshold: 0.7,
    replyDuplicateThreshold: 0.84,
    replyNarrativeThreshold: 0.78,
    minTrendScore: 2.8,
    minTrendEngagement: 4,
    minSourceTrust: 0.32,
    rationale: "default",
  };
}

export function buildAdaptivePolicy(target: number, todayCount: number, timezone: string): AdaptivePolicy {
  const base = getDefaultAdaptivePolicy();
  const metrics = memory.getTodayPostGenerationMetrics(timezone);
  const progress = target > 0 ? todayCount / target : 1;
  const failLoad = metrics.postRuns > 0 ? metrics.postFailures / metrics.postRuns : 0;
  const reasons: string[] = ["default"];

  const policy: AdaptivePolicy = { ...base };

  if (progress < 0.45) {
    policy.minTrendScore -= 0.2;
    policy.minSourceTrust -= 0.03;
    reasons.push("under-target");
  } else if (progress > 1.05) {
    policy.postDuplicateThreshold -= 0.05;
    policy.postNarrativeThreshold -= 0.05;
    policy.replyDuplicateThreshold -= 0.03;
    policy.replyNarrativeThreshold -= 0.03;
    policy.minTrendScore += 0.35;
    policy.minTrendEngagement += 1;
    policy.minSourceTrust += 0.05;
    reasons.push("over-target");
  }

  if (metrics.fallbackRate >= 0.35 || failLoad >= 0.5) {
    policy.minTrendScore -= 0.1;
    reasons.push("high-fallback-or-fail");
  }

  if ((metrics.failReasons["duplicate"] || 0) >= 2) {
    policy.postDuplicateThreshold -= 0.03;
    policy.postNarrativeThreshold -= 0.03;
    policy.replyDuplicateThreshold -= 0.02;
    policy.replyNarrativeThreshold -= 0.02;
    reasons.push("duplicate-heavy");
  }

  policy.postDuplicateThreshold = clamp(policy.postDuplicateThreshold, 0.65, 0.86);
  policy.postNarrativeThreshold = clamp(policy.postNarrativeThreshold, 0.62, 0.84);
  policy.replyDuplicateThreshold = clamp(policy.replyDuplicateThreshold, 0.74, 0.9);
  policy.replyNarrativeThreshold = clamp(policy.replyNarrativeThreshold, 0.7, 0.86);
  policy.minTrendScore = clamp(policy.minTrendScore, 2.2, 4.2);
  policy.minTrendEngagement = Math.floor(clamp(policy.minTrendEngagement, 3, 12));
  policy.minSourceTrust = clamp(policy.minSourceTrust, 0.24, 0.55);
  policy.rationale = reasons.join("+");
  return policy;
}

export function normalizeDailyTarget(value: number | undefined): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_DAILY_TARGET;
  return clamp(Math.floor(parsed), 1, 100);
}

export function randomInt(min: number, max: number): number {
  if (max <= min) return min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function toReasonCode(reason: string): string {
  const normalized = String(reason || "").toLowerCase();
  if (!normalized) return "unknown";
  if (normalized.includes("시장 숫자") || normalized.includes("100k") || normalized.includes("오차")) return "market-mismatch";
  if (normalized.includes("중복") || normalized.includes("유사")) return "duplicate";
  if (normalized.includes("주제 다양성")) return "topic-diversity";
  if (normalized.includes("24h 내 동일")) return "topic-density";
  if (normalized.includes("짧음")) return "too-short";
  if (normalized.includes("fallback")) return "fallback";
  return "quality-gate";
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
