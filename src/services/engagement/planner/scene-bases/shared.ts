import { TrendLane } from "../../../../types/agent.js";
import {
  countRecentSceneFamilyBase,
  estimateSceneFamilyBaseQuotaPenalty,
  sceneFamilyBaseQuotaLimited,
} from "../quota.js";
import type { PlannerFocus } from "../spec.js";
import type { RecentNarrativeThread } from "../spec.js";

function stableSeed(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return Math.abs(hash >>> 0);
}

export function pickSceneFamilyBase(
  lane: TrendLane,
  focus: PlannerFocus,
  merged: string,
  facets: string[],
  candidates: string[],
  fallback: string,
  recentThreads: RecentNarrativeThread[] = []
): string {
  const pool = [...new Set(candidates.filter(Boolean))];
  if (!pool.length) return fallback;
  const seed = stableSeed(`${lane}|${focus}|${merged}|${facets.join("+")}|${pool.join("|")}`);
  const unrestrictedPool = pool.filter((base) => !sceneFamilyBaseQuotaLimited(lane, focus, base, recentThreads));
  const activePool = unrestrictedPool.length > 0 ? unrestrictedPool : pool;
  const scored = activePool
    .map((base, index) => {
      const orderBoost = Math.max(0, pool.length - index) * 0.06;
      const facetBoost = facets.some((facet) => base.includes(facet)) ? 0.08 : 0;
      const quotaPenalty = estimateSceneFamilyBaseQuotaPenalty(lane, focus, base, recentThreads);
      const countPenalty = countRecentSceneFamilyBase(lane, focus, base, recentThreads) * 0.08;
      const tieBreak = ((stableSeed(`${seed}|${base}`) % 1000) / 1000) * 0.01;
      return {
        base,
        score: orderBoost + facetBoost - quotaPenalty - countPenalty + tieBreak,
      };
    })
    .sort((a, b) => b.score - a.score);
  return scored[0]?.base || activePool[Math.abs(seed) % activePool.length] || fallback;
}
