import type { RecentNarrativeThread } from "../spec.js";
import { pickSceneFamilyBase } from "./shared.js";

export function resolveBuilderSceneBase(merged: string, facets: string[], recentThreads: RecentNarrativeThread[] = []): string {
  const candidates: string[] = [];
  if (/(일기장|내부자|회의실|포스터)/.test(merged)) {
    candidates.push("builder+inside", "builder+usage", "builder+return");
  }
  if (/(복귀 자금|자금 복귀|안 돌아|돌아오지|객석|돈이 안 붙)/.test(merged)) {
    candidates.push("builder+return", "builder+treasury", "builder+usage");
  }
  if (/(예치 자금|tvl|자금|돈|treasury)/.test(merged)) {
    candidates.push("builder+treasury", "builder+return", "builder+usage");
  }
  if (/(실사용|사용|빌드|제품|체인 안쪽 사용|사용 흔적)/.test(merged)) {
    candidates.push("builder+usage", "builder+inside", "builder+return");
  }
  if (facets.includes("inside")) candidates.push("builder+inside", "builder+usage", "builder+return");
  if (facets.includes("return")) candidates.push("builder+return", "builder+treasury", "builder+usage");
  if (facets.includes("capital")) candidates.push("builder+treasury", "builder+return", "builder+usage");
  if (facets.includes("usage")) candidates.push("builder+usage", "builder+inside", "builder+treasury");
  return pickSceneFamilyBase(
    "ecosystem",
    "builder",
    merged,
    facets,
    candidates,
    facets.includes("usage") ? "builder+usage" : "builder+return",
    recentThreads
  );
}
