import { TrendLane } from "../../../types/agent.js";
import { sceneFamilyBase } from "./scene-family.js";
import { getPlannerBaseQuotaPolicy, plannerBaseIsHot, plannerBaseQuotaThreshold } from "./base-quotas.js";
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
  const policy = getPlannerBaseQuotaPolicy(lane, focus);
  return (recentThreads || [])
    .slice(-policy.recentWindow)
    .filter(
      (item) =>
        item.lane === lane &&
        (item.focus || "general") === focus &&
        normalizeBaseKey(lane, focus, sceneFamilyBase(item.sceneFamily || "")) === normalized
    ).length;
}

export function isHotSceneFamilyBase(lane: TrendLane, focus: PlannerFocus, base: string): boolean {
  const normalized = normalizeBaseKey(lane, focus, base);
  return plannerBaseIsHot(lane, focus, normalized);
}

export function sceneFamilyBaseQuotaThreshold(
  lane: TrendLane,
  focus: PlannerFocus,
  base: string
): number {
  return plannerBaseQuotaThreshold(lane, focus, normalizeBaseKey(lane, focus, base));
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
