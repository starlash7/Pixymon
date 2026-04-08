import { pickSceneFamilyBase } from "./shared.js";

export function resolveLaunchSceneBase(merged: string, facets: string[]): string {
  const candidates: string[] = [];
  if (/(쇼케이스|데모|무대|객석|발표회|포스터)/.test(merged)) {
    candidates.push("return+showcase", "launch+showcase", "launch+audience");
  }
  if (/(박수|발표|브리핑|기사|뉴스|기대)/.test(merged)) {
    candidates.push("return+announcement", "launch+audience", "return+launch");
  }
  if (/(운영|로그|복구|배포|롤아웃)/.test(merged)) {
    candidates.push("return+ops", "launch+ops", "capital+rollout");
  }
  if (/(자금|돈|treasury|예치 자금|복귀 자금)/.test(merged)) {
    candidates.push("capital+launch", "launch+treasury", "return+launch");
  }
  if (facets.includes("showcase")) candidates.push("return+showcase", "launch+showcase", "launch+audience");
  if (facets.includes("ops")) candidates.push("return+ops", "launch+ops", "capital+rollout");
  if (facets.includes("capital")) candidates.push("capital+launch", "launch+treasury", "return+launch");
  if (facets.includes("return")) candidates.push("return+launch", "return+announcement", "return+showcase");
  return pickSceneFamilyBase(
    "protocol",
    "launch",
    merged,
    facets,
    candidates,
    facets.includes("capital") ? "capital+launch" : "return+launch"
  );
}
