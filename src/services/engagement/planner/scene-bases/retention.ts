import type { RecentNarrativeThread } from "../spec.js";
import { pickSceneFamilyBase } from "./shared.js";

export function resolveRetentionSceneBase(merged: string, facets: string[], recentThreads: RecentNarrativeThread[] = []): string {
  const candidates: string[] = [];
  if (/(생활|습관|리듬|다음 날)/.test(merged)) {
    candidates.push("habit+retention", "return+habit", "cohort+retention");
  }
  if (/(실사용|생활 흔적|사용 흔적|체인 안쪽 사용)/.test(merged) && facets.includes("usage")) {
    candidates.push("retention+usage", "usage+wallet", "cohort+usage");
  }
  if (/(커뮤니티|열기|광고|홍보|포스터)/.test(merged)) {
    candidates.push("community+retention", "cohort+retention", "wallet+retention");
  }
  if (facets.includes("wallet")) {
    candidates.push("wallet+retention", "retention+wallet");
  }
  if (facets.includes("cohort") || facets.includes("retention")) {
    candidates.push("cohort+retention", "retention+cohort");
  }
  if (!candidates.length) {
    if (facets.includes("usage")) candidates.push("retention+usage", "usage+wallet");
    if (facets.includes("community")) candidates.push("community+retention");
  }
  return pickSceneFamilyBase(
    "ecosystem",
    "retention",
    merged,
    facets,
    candidates,
    facets.includes("wallet") ? "wallet+retention" : "retention+usage",
    recentThreads
  );
}
