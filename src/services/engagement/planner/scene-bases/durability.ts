import { pickSceneFamilyBase } from "./shared.js";

export function resolveDurabilitySceneBase(merged: string, facets: string[]): string {
  const candidates: string[] = [];
  if (/(로그|기록|운영 로그)/.test(merged)) {
    candidates.push("ops+log", "repair+log", "validator+log");
  }
  if (/(복구|회복|장애|recovery)/.test(merged)) {
    candidates.push("recovery+validator", "recovery+rollout", "ops+recovery");
  }
  if (/(수리|패치|repair)/.test(merged)) {
    candidates.push("repair+validator", "repair+ops", "repair+log");
  }
  if (/(배포|롤아웃|rollout)/.test(merged)) {
    candidates.push("rollout+validator", "recovery+rollout", "ops+recovery");
  }
  if (facets.includes("validator")) candidates.push("repair+validator", "ops+validator", "recovery+validator");
  if (facets.includes("ops")) candidates.push("ops+validator", "ops+log", "ops+recovery");
  if (facets.includes("recovery")) candidates.push("recovery+validator", "recovery+rollout", "ops+recovery");
  if (facets.includes("rollout")) candidates.push("rollout+validator", "recovery+rollout");
  return pickSceneFamilyBase(
    "protocol",
    "durability",
    merged,
    facets,
    candidates,
    facets.includes("validator") ? "repair+validator" : "ops+recovery"
  );
}
