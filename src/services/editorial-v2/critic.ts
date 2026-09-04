export interface EditorialCriticScoresV2 {
  grounding: number;
  clarity: number;
  insight: number;
  character: number;
  memorability: number;
  followWorthiness: number;
  overall: number;
  hardVetoes: string[];
}
export interface AutoPublishCalibrationV2 {
  reviewedCount: number;
  noEditPrecision: number;
  hardVetoCount: number;
}

export interface AutoPublishEligibilityInputV2 {
  tierA: boolean;
  providerGreen: boolean;
  usedFallback: boolean;
  hardGateReasons: string[];
  critic: EditorialCriticScoresV2;
  calibration: AutoPublishCalibrationV2;
}

export interface AutoPublishEligibilityV2 {
  eligible: boolean;
  reasons: string[];
}

const CRITIC_DIMENSIONS: Array<keyof Omit<EditorialCriticScoresV2, "overall" | "hardVetoes">> = [
  "grounding",
  "clarity",
  "insight",
  "character",
  "memorability",
  "followWorthiness",
];

export function validateCriticScoresV2(scores: EditorialCriticScoresV2): string[] {
  const reasons: string[] = [];
  for (const key of [...CRITIC_DIMENSIONS, "overall" as const]) {
    const value = scores[key];
    if (!Number.isFinite(value) || value < 1 || value > 5) {
      reasons.push(`critic-${key}-out-of-range`);
    }
  }
  if (!Array.isArray(scores.hardVetoes)) reasons.push("critic-hard-vetoes-invalid");
  return reasons;
}

export function evaluateAutoPublishEligibilityV2(
  input: AutoPublishEligibilityInputV2
): AutoPublishEligibilityV2 {
  const reasons = validateCriticScoresV2(input.critic);
  if (!input.tierA) reasons.push("evidence-not-tier-a");
  if (!input.providerGreen) reasons.push("provider-not-green");
  if (input.usedFallback) reasons.push("fallback-used");
  reasons.push(...input.hardGateReasons.map((reason) => `hard-gate:${reason}`));
  reasons.push(...input.critic.hardVetoes.map((reason) => `critic-veto:${reason}`));
  for (const key of CRITIC_DIMENSIONS) {
    if (input.critic[key] < 4) reasons.push(`critic-${key}-below-4`);
  }
  if (input.critic.overall < 4.2) reasons.push("critic-overall-below-4.2");
  if (input.calibration.reviewedCount < 30) reasons.push("calibration-under-30");
  if (input.calibration.noEditPrecision < 0.9) reasons.push("calibration-precision-below-0.9");
  if (input.calibration.hardVetoCount > 0) reasons.push("calibration-hard-veto");
  return { eligible: reasons.length === 0, reasons: [...new Set(reasons)] };
}
