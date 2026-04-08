export function sceneFamilyBase(sceneFamily: string): string {
  const parts = String(sceneFamily || "")
    .split(":")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length <= 3) return parts.join(":");
  return parts.slice(0, 3).join(":");
}

export function sceneFamilyTilt(sceneFamily: string): string {
  const parts = String(sceneFamily || "")
    .split(":")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length <= 3) return "";
  return parts.slice(3).join(":");
}

export function sceneFamilyMatches(sceneFamily: string, regex: RegExp): boolean {
  return regex.test(sceneFamilyBase(sceneFamily));
}

export function rewriteSceneFamilyBase(sceneFamily: string, nextBase: string): string {
  const parts = String(sceneFamily || "")
    .split(":")
    .map((part) => part.trim())
    .filter(Boolean);
  const baseParts = nextBase
    .split(":")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!baseParts.length) return sceneFamily;
  const tail = parts.length > 3 ? parts.slice(3) : [];
  return [...baseParts, ...tail].join(":");
}

export function resolveSceneFamilyContext(input: {
  sceneFamily?: string;
  sceneBase?: string;
  sceneTilt?: string;
}): {
  sceneFamily: string;
  sceneBase: string;
  sceneTilt: string;
} {
  const sceneFamily = String(input.sceneFamily || "").trim();
  return {
    sceneFamily,
    sceneBase: String(input.sceneBase || "").trim() || sceneFamilyBase(sceneFamily),
    sceneTilt: String(input.sceneTilt || "").trim() || sceneFamilyTilt(sceneFamily),
  };
}
