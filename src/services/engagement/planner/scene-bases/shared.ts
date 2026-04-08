import { TrendLane } from "../../../../types/agent.js";
import type { PlannerFocus } from "../spec.js";

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
  fallback: string
): string {
  const pool = [...new Set(candidates.filter(Boolean))];
  if (!pool.length) return fallback;
  const seed = stableSeed(`${lane}|${focus}|${merged}|${facets.join("+")}|${pool.join("|")}`);
  return pool[Math.abs(seed) % pool.length] || fallback;
}
