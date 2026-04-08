import { pickSceneFamilyBase } from "./shared.js";

export function resolveSettlementSceneBase(merged: string, facets: string[]): string {
  const candidates: string[] = [];
  if (/(호가 책|호가|book)/.test(merged)) {
    candidates.push("fill+book", "volume+book", "execution+settlement");
  }
  if (/(거래량|숫자|볼륨|volume)/.test(merged)) {
    candidates.push("volume+settlement", "volume+depth", "fill+depth");
  }
  if (/(정산|settlement)/.test(merged)) {
    candidates.push("depth+settlement", "execution+settlement", "settlement+heat");
  }
  if (/(깊이|depth)/.test(merged)) {
    candidates.push("depth+heat", "depth+settlement", "execution+depth");
  }
  if (facets.includes("execution")) candidates.push("execution+depth", "execution+settlement", "fill+depth");
  if (facets.includes("volume")) candidates.push("volume+settlement", "volume+book", "volume+depth");
  if (facets.includes("depth")) candidates.push("depth+heat", "depth+settlement", "execution+depth");
  if (facets.includes("settlement")) candidates.push("execution+settlement", "settlement+heat", "volume+settlement");
  return pickSceneFamilyBase(
    "market-structure",
    "settlement",
    merged,
    facets,
    candidates,
    facets.includes("depth") ? "depth+settlement" : "volume+settlement"
  );
}
