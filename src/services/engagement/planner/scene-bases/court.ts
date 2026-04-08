import { pickSceneFamilyBase } from "./shared.js";

export function resolveCourtSceneBase(merged: string, facets: string[]): string {
  const candidates: string[] = [];
  if (/(판결|평결|법원|소송|court)/.test(merged)) {
    candidates.push("verdict+execution", "court+execution", "capital+court");
  }
  if (/(브리핑|해설|기사|뉴스)/.test(merged)) {
    candidates.push("briefing+execution", "briefing+capital", "order+capital");
  }
  if (facets.includes("order")) {
    candidates.push("order+capital");
  }
  if (facets.includes("capital")) {
    candidates.push("capital+court", "capital+execution");
  }
  if (facets.includes("execution")) {
    candidates.push("court+execution", "verdict+execution", "briefing+execution");
  }
  return pickSceneFamilyBase(
    "regulation",
    "court",
    merged,
    facets,
    candidates,
    facets.includes("order") ? "order+capital" : "court+execution"
  );
}
