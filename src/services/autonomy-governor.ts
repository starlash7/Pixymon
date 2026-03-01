import { detectLanguage } from "../utils/mood.js";
import { XApiCostRuntimeSettings, EngagementRuntimeSettings } from "../types/runtime.js";
import { EventEvidencePlan } from "./engagement/types.js";
import { xApiBudget } from "./x-api-budget.js";
import { sanitizeTweetText } from "./engagement/quality.js";

export interface AutonomyGovernorInput {
  timezone: string;
  postText: string;
  trendSummary: string;
  eventPlan: EventEvidencePlan;
  runtimeSettings: EngagementRuntimeSettings;
  xApiCostSettings: XApiCostRuntimeSettings;
  currentUsage?: {
    estimatedTotalCostUsd: number;
    readRequests: number;
    createRequests: number;
  };
}

export interface AutonomyGovernorDecision {
  allow: boolean;
  level: "allow" | "warn" | "block";
  reasons: string[];
  diagnostics: {
    budgetUtilization: number;
    projectedCostUsd: number;
    riskScore: number;
    languageOk: boolean;
    hasOnchainEvidence: boolean;
    hasCrossSourceEvidence: boolean;
    evidenceSourceDiversity: number;
    assertiveTone: boolean;
  };
}

const RISK_SIGNAL_PATTERNS = [
  /hack|exploit|breach|rug|depeg|liquidation|bankrun|sanction|lawsuit|fraud|outage/i,
  /해킹|익스플로잇|디페그|청산|런|제재|소송|사기|중단|사고/i,
];

const ASSERTIVE_TONE_PATTERNS = [
  /100%|확정|무조건|반드시|지금\s*매수|all\s*in|guaranteed|sure\s*win|certainly/i,
];

export function evaluateAutonomyGovernor(input: AutonomyGovernorInput): AutonomyGovernorDecision {
  const reasons: string[] = [];
  let level: "allow" | "warn" | "block" = "allow";

  const usage =
    input.currentUsage ||
    xApiBudget.getTodayUsage(input.timezone || "Asia/Seoul");
  const projectedCostUsd = roundUsd(usage.estimatedTotalCostUsd + input.xApiCostSettings.estimatedCreateCostUsd);
  const budgetUtilization =
    input.xApiCostSettings.dailyMaxUsd > 0
      ? projectedCostUsd / input.xApiCostSettings.dailyMaxUsd
      : 0;

  if (
    input.xApiCostSettings.enabled &&
    budgetUtilization > input.runtimeSettings.autonomyMaxBudgetUtilization
  ) {
    reasons.push(
      `budget_utilization_exceeded(${round2(budgetUtilization)} > ${round2(
        input.runtimeSettings.autonomyMaxBudgetUtilization
      )})`
    );
    level = "block";
  }

  if (input.runtimeSettings.requireOnchainEvidence && !input.eventPlan.hasOnchainEvidence) {
    reasons.push("missing_onchain_evidence");
    level = "block";
  }

  if (input.runtimeSettings.requireCrossSourceEvidence && !input.eventPlan.hasCrossSourceEvidence) {
    reasons.push("missing_cross_source_evidence");
    level = "block";
  }

  const normalizedPost = sanitizeTweetText(input.postText);
  const language = detectLanguage(normalizedPost);
  const languageOk = !input.runtimeSettings.enforceKoreanPosts || language === "ko";
  if (!languageOk) {
    reasons.push("post_language_not_korean");
    level = "block";
  }

  const riskScore = computeRiskScore([input.trendSummary, input.eventPlan.event.headline, normalizedPost]);
  const assertiveTone = hasAssertiveTone(normalizedPost);
  if (riskScore >= input.runtimeSettings.autonomyRiskBlockScore && assertiveTone) {
    reasons.push(`risk_assertive_block(score=${riskScore})`);
    level = "block";
  } else if (riskScore >= input.runtimeSettings.autonomyRiskBlockScore && level !== "block") {
    reasons.push(`risk_high_watch(score=${riskScore})`);
    level = "warn";
  }

  if (
    input.eventPlan.evidenceSourceDiversity <= 1 &&
    level === "allow"
  ) {
    reasons.push("evidence_source_diversity_low");
    level = "warn";
  }

  return {
    allow: level !== "block",
    level,
    reasons,
    diagnostics: {
      budgetUtilization: round2(budgetUtilization),
      projectedCostUsd,
      riskScore,
      languageOk,
      hasOnchainEvidence: input.eventPlan.hasOnchainEvidence,
      hasCrossSourceEvidence: input.eventPlan.hasCrossSourceEvidence,
      evidenceSourceDiversity: input.eventPlan.evidenceSourceDiversity,
      assertiveTone,
    },
  };
}

function computeRiskScore(lines: string[]): number {
  const joined = lines
    .map((line) => sanitizeTweetText(String(line || "")))
    .join(" ")
    .trim();
  if (!joined) return 0;
  let score = 0;
  for (const pattern of RISK_SIGNAL_PATTERNS) {
    const hits = joined.match(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`));
    if (hits && hits.length > 0) {
      score += hits.length * 2;
    }
  }
  return Math.max(0, Math.min(10, Math.floor(score)));
}

function hasAssertiveTone(text: string): boolean {
  return ASSERTIVE_TONE_PATTERNS.some((pattern) => pattern.test(text));
}

function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

function roundUsd(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1000) / 1000;
}
