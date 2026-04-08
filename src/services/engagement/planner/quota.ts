import { TrendLane } from "../../../types/agent.js";
import { sceneFamilyBase } from "./scene-family.js";
import type { PlannerFocus, RecentNarrativeThread } from "./spec.js";

function normalizeBaseKey(lane: TrendLane, focus: PlannerFocus, base: string): string {
  const trimmed = String(base || "").trim();
  if (!trimmed) return `${lane}:${focus}:generic`;
  return trimmed.includes(":") ? trimmed : `${lane}:${focus}:${trimmed}`;
}

export function countRecentSceneFamilyBase(
  lane: TrendLane,
  focus: PlannerFocus,
  base: string,
  recentThreads: RecentNarrativeThread[]
): number {
  const normalized = normalizeBaseKey(lane, focus, base);
  return (recentThreads || [])
    .slice(-8)
    .filter(
      (item) =>
        item.lane === lane &&
        (item.focus || "general") === focus &&
        normalizeBaseKey(lane, focus, sceneFamilyBase(item.sceneFamily || "")) === normalized
    ).length;
}

export function isHotSceneFamilyBase(lane: TrendLane, focus: PlannerFocus, base: string): boolean {
  const normalized = normalizeBaseKey(lane, focus, base);
  if (lane === "ecosystem" && focus === "builder") return /builder\+return|builder\+usage|builder\+treasury/.test(normalized);
  if (lane === "regulation" && focus === "court") return /court\+execution|briefing\+execution|verdict\+execution/.test(normalized);
  if (lane === "protocol" && focus === "durability") return /recovery\+validator|repair\+validator|recovery\+rollout|repair\+ops/.test(normalized);
  if (lane === "protocol" && focus === "launch") return /return\+showcase|return\+launch|return\+announcement|launch\+showcase/.test(normalized);
  if (lane === "ecosystem" && focus === "retention") return /retention\+cohort|retention\+usage|wallet\+retention|return\+habit/.test(normalized);
  if (lane === "market-structure" && focus === "settlement") return /fill\+book|execution\+settlement|depth\+settlement|volume\+settlement/.test(normalized);
  return false;
}

export function sceneFamilyBaseQuotaThreshold(
  lane: TrendLane,
  focus: PlannerFocus,
  base: string
): number {
  return isHotSceneFamilyBase(lane, focus, base) ? 1 : 2;
}

export function sceneFamilyBaseQuotaLimited(
  lane: TrendLane,
  focus: PlannerFocus,
  base: string,
  recentThreads: RecentNarrativeThread[]
): boolean {
  return countRecentSceneFamilyBase(lane, focus, base, recentThreads) >= sceneFamilyBaseQuotaThreshold(lane, focus, base);
}

export function estimateSceneFamilyBaseQuotaPenalty(
  lane: TrendLane,
  focus: PlannerFocus,
  base: string,
  recentThreads: RecentNarrativeThread[]
): number {
  const count = countRecentSceneFamilyBase(lane, focus, base, recentThreads);
  const threshold = sceneFamilyBaseQuotaThreshold(lane, focus, base);
  if (count < threshold) return 0;
  const hotBonus = isHotSceneFamilyBase(lane, focus, base) ? 0.12 : 0;
  return Math.min(0.62, 0.28 + hotBonus + (count - threshold) * 0.12);
}
