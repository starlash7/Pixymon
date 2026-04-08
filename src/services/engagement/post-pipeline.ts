import type { TrendLane } from "../../types/agent.js";
import type { EventEvidencePlan } from "./types.js";

export type PostFallbackKind = "none" | "deterministic" | "hard" | "rescue" | "emergency";

export function allowLiveFallbackPublish(kind: PostFallbackKind, allowFallbackAutoPublish: boolean): boolean {
  if (kind === "none") return true;
  if (allowFallbackAutoPublish) return true;
  return kind === "deterministic";
}

export function evaluatePlannerPublishReadiness(
  plan: EventEvidencePlan,
  recentThreads: Array<{ lane: TrendLane; focus?: string }>
): { allow: boolean; reason?: string } {
  const warnings = new Set(plan.plannerWarnings || []);
  const sameFocusRepeats = recentThreads.filter(
    (item) => item.lane === plan.lane && (item.focus || "general") === plan.focus
  ).length;
  if (plan.focus === "general") warnings.add("focus-general");
  if (plan.plannerScore < 0.7) warnings.add("score-thin");
  if (sameFocusRepeats >= 2) warnings.add("focus-saturated");
  if (warnings.has("scene-repeat") && plan.plannerScore < 0.9) {
    return { allow: false, reason: "scene-repeat" };
  }
  if (warnings.has("focus-general")) return { allow: false, reason: "focus-general" };
  if (warnings.has("generic-evidence")) return { allow: false, reason: "generic-evidence" };
  if (warnings.has("semantic-mismatch")) return { allow: false, reason: "semantic-mismatch" };
  if (warnings.has("score-thin")) return { allow: false, reason: "planner-score-thin" };
  if (warnings.has("focus-saturated")) return { allow: false, reason: "focus-saturated" };
  if (warnings.has("structural-fallback") && plan.lane !== "onchain" && plan.plannerScore < 0.9) {
    return { allow: false, reason: "structural-fallback-thin" };
  }
  return { allow: true };
}

export function evaluateFallbackPublishReadiness(
  plan: EventEvidencePlan,
  kind: PostFallbackKind,
  usedFallback: boolean
): { allow: boolean; reason?: string } {
  if (!usedFallback || kind === "none") return { allow: true };
  const warningSet = new Set(plan.plannerWarnings || []);
  if (plan.focus === "general") return { allow: false, reason: "fallback-on-general-focus" };
  if (warningSet.has("generic-evidence")) return { allow: false, reason: "fallback-on-generic-evidence" };
  if (warningSet.has("semantic-mismatch")) return { allow: false, reason: "fallback-on-semantic-mismatch" };
  if (warningSet.has("scene-repeat") && plan.plannerScore < 0.96) {
    return { allow: false, reason: "fallback-on-scene-repeat" };
  }
  if (kind !== "deterministic") return { allow: false, reason: `fallback-kind-${kind}` };
  if (warningSet.has("structural-fallback") && plan.plannerScore < 0.96) {
    return { allow: false, reason: "fallback-on-thin-structural-plan" };
  }
  if (plan.plannerScore < 0.86) return { allow: false, reason: "fallback-on-thin-plan" };
  return { allow: true };
}
