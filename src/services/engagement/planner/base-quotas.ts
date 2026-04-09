import type { TrendLane } from "../../../types/agent.js";
import type { PlannerFocus } from "./spec.js";

export interface PlannerBaseQuotaPolicy {
  recentWindow: number;
  defaultThreshold: number;
  hotThreshold: number;
  hardBlockAtThreshold: boolean;
  hotBases: RegExp[];
}

const DEFAULT_POLICY: PlannerBaseQuotaPolicy = {
  recentWindow: 16,
  defaultThreshold: 2,
  hotThreshold: 1,
  hardBlockAtThreshold: true,
  hotBases: [],
};

const POLICY_BY_FOCUS: Partial<Record<`${TrendLane}:${PlannerFocus}`, PlannerBaseQuotaPolicy>> = {
  "ecosystem:builder": {
    recentWindow: 16,
    defaultThreshold: 2,
    hotThreshold: 1,
    hardBlockAtThreshold: true,
    hotBases: [/builder\+return$/, /builder\+usage$/, /builder\+treasury$/],
  },
  "ecosystem:retention": {
    recentWindow: 16,
    defaultThreshold: 2,
    hotThreshold: 1,
    hardBlockAtThreshold: true,
    hotBases: [
      /retention\+usage$/,
      /retention\+cohort$/,
      /wallet\+retention$/,
      /retention\+wallet$/,
      /community\+retention$/,
      /return\+habit$/,
    ],
  },
  "regulation:court": {
    recentWindow: 16,
    defaultThreshold: 2,
    hotThreshold: 1,
    hardBlockAtThreshold: true,
    hotBases: [/court\+execution$/, /briefing\+execution$/, /verdict\+execution$/],
  },
  "protocol:launch": {
    recentWindow: 16,
    defaultThreshold: 2,
    hotThreshold: 1,
    hardBlockAtThreshold: true,
    hotBases: [/return\+launch$/, /return\+showcase$/, /return\+ops$/, /launch\+treasury$/],
  },
  "protocol:durability": {
    recentWindow: 16,
    defaultThreshold: 2,
    hotThreshold: 1,
    hardBlockAtThreshold: true,
    hotBases: [/recovery\+validator$/, /repair\+validator$/, /recovery\+rollout$/, /ops\+validator$/],
  },
  "market-structure:settlement": {
    recentWindow: 16,
    defaultThreshold: 2,
    hotThreshold: 1,
    hardBlockAtThreshold: true,
    hotBases: [/fill\+book$/, /fill\+depth$/, /execution\+settlement$/, /volume\+book$/, /volume\+settlement$/],
  },
};

export function getPlannerBaseQuotaPolicy(lane: TrendLane, focus: PlannerFocus): PlannerBaseQuotaPolicy {
  return POLICY_BY_FOCUS[`${lane}:${focus}`] || DEFAULT_POLICY;
}

export function plannerBaseIsHot(lane: TrendLane, focus: PlannerFocus, base: string): boolean {
  const normalized = String(base || "").trim();
  const policy = getPlannerBaseQuotaPolicy(lane, focus);
  return policy.hotBases.some((pattern) => pattern.test(normalized));
}

export function plannerBaseQuotaThreshold(lane: TrendLane, focus: PlannerFocus, base: string): number {
  const policy = getPlannerBaseQuotaPolicy(lane, focus);
  return plannerBaseIsHot(lane, focus, base) ? policy.hotThreshold : policy.defaultThreshold;
}
