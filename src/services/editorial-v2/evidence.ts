import type { OnchainNutrient } from "../../types/agent.js";
import type { NewsItem } from "../blockchain-news.js";
import type { EvidenceProviderV2, ProviderHealthV2 } from "./provider-health.js";
import type { EditorialLaneV2, MachineComparatorV2 } from "./contracts.js";

export const SIGNAL_FRESHNESS_MS = 2 * 60 * 60 * 1000;
export const NEWS_FRESHNESS_MS = 6 * 60 * 60 * 1000;

export type EvidenceLaneV2 = EditorialLaneV2;
export type EvidenceKindV2 = "signal" | "news";
export type EvidenceOriginV2 = "direct" | "derived";
export type EvidenceRoleV2 = "primary" | "discovery";
export type EvidenceFreshnessStateV2 = "fresh" | "stale" | "future" | "invalid";

export interface EvidenceMetricV2 {
  name: string;
  value: number;
  raw: string;
  unit: string;
  period: string;
}

export interface EvidenceFreshnessV2 {
  kind: EvidenceKindV2;
  measuredAt: string | null;
  maxAgeMs: number;
  ageMs: number | null;
  state: EvidenceFreshnessStateV2;
}

export interface EvidenceCardV2 {
  schemaVersion: 2;
  id: string;
  lane: EvidenceLaneV2;
  kind: EvidenceKindV2;
  subject: string;
  /** Provider-stable identity when one exists; display names are not identities. */
  subjectKey?: string;
  metric: EvidenceMetricV2;
  /** Absolute measurement used to verify whether the published event persisted. */
  followUp?: {
    metric: EvidenceMetricV2;
    comparator: MachineComparatorV2;
    threshold: number;
  };
  /** Derived ranking context; never promoted into a direct public claim. */
  selection?: {
    kind: "tvl-outlier";
    absoluteMoveUsd: number;
    benchmarkChangePercent: number;
    residualPercentagePoints: number;
    /** Derived screening only; never a public inflow/deposit claim. */
    priceNeutral?: {
      quantityChangePercent: number;
      priceChangePercent: number;
      quantityMoveUsd: number;
      quantityShare: number;
      coverageAtT0: number;
      coverageAtT1: number;
      t0: number;
      t1: number;
      interpolatedT0: boolean;
    };
  };
  source: {
    provider: EvidenceProviderV2;
    url: string;
    publishedAt: string | null;
    observedAt: string;
    origin: EvidenceOriginV2;
    role: EvidenceRoleV2;
  };
  freshness: EvidenceFreshnessV2;
  providerHealth: ProviderHealthV2;
  provenance: {
    kind: "news-item" | "onchain-nutrient";
    sourceId: string;
  };
}

export type TierABlockReasonV2 =
  | "subject-not-named"
  | "source-url-invalid"
  | "source-time-invalid"
  | "numeric-fact-missing"
  | "metric-metadata-missing"
  | "not-direct"
  | "discovery-only"
  | "rss-discovery-only"
  | "provider-health-mismatch"
  | "provider-not-green"
  | "stale"
  | "future-timestamp";

export interface TierAEligibilityV2 {
  eligible: boolean;
  reasons: TierABlockReasonV2[];
  freshness: EvidenceFreshnessV2;
}

export type EvidenceConversionReasonV2 =
  | "id-missing"
  | "subject-missing"
  | "metric-missing"
  | "source-url-missing"
  | "source-url-invalid"
  | "published-at-missing"
  | "timestamp-invalid"
  | "system-neutral";

export type EvidenceConversionResultV2 =
  | { ok: true; card: EvidenceCardV2 }
  | { ok: false; reasons: EvidenceConversionReasonV2[] };

interface EvidenceConversionContextV2 {
  id: string;
  lane: EvidenceLaneV2;
  subject: string;
  sourceUrl?: string;
  observedAt: string;
  now: string;
  providerHealth: ProviderHealthV2;
  metric?: EvidenceMetricV2;
  origin?: EvidenceOriginV2;
  role?: EvidenceRoleV2;
}

export interface NewsEvidenceContextV2 extends EvidenceConversionContextV2 {
  publishedAt?: string;
}

export interface NutrientEvidenceContextV2 extends EvidenceConversionContextV2 {
  metricName?: string;
  metricUnit?: string;
  metricPeriod?: string;
}

const GENERIC_SUBJECTS = new Set([
  "시장",
  "크립토",
  "크립토 시장",
  "생태계",
  "프로토콜",
  "온체인",
  "온체인 데이터",
  "뉴스",
  "코인",
  "토큰",
]);

function parseInstant(value: string | undefined): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function hasNamedSubject(subject: string): boolean {
  const normalized = subject.trim().replace(/\s+/g, " ");
  return normalized.length >= 2 && !GENERIC_SUBJECTS.has(normalized.toLowerCase());
}

function metricIsComplete(metric: EvidenceMetricV2): boolean {
  return (
    metric.name.trim().length > 0 &&
    Number.isFinite(metric.value) &&
    /\d/.test(metric.raw) &&
    metric.unit.trim().length > 0 &&
    metric.period.trim().length > 0
  );
}

export function evaluateEvidenceFreshnessV2(input: {
  kind: EvidenceKindV2;
  observedAt: string;
  publishedAt?: string | null;
  now: string;
}): EvidenceFreshnessV2 {
  const maxAgeMs = input.kind === "news" ? NEWS_FRESHNESS_MS : SIGNAL_FRESHNESS_MS;
  const measuredAt = input.kind === "news" ? input.publishedAt || null : input.observedAt;
  const measuredMs = parseInstant(measuredAt || undefined);
  const nowMs = parseInstant(input.now);

  if (measuredMs === null || nowMs === null) {
    return { kind: input.kind, measuredAt, maxAgeMs, ageMs: null, state: "invalid" };
  }

  const ageMs = nowMs - measuredMs;
  const state: EvidenceFreshnessStateV2 =
    ageMs < 0 ? "future" : ageMs <= maxAgeMs ? "fresh" : "stale";
  return { kind: input.kind, measuredAt, maxAgeMs, ageMs, state };
}

export function assessTierAEligibilityV2(card: EvidenceCardV2, now: string): TierAEligibilityV2 {
  const reasons: TierABlockReasonV2[] = [];
  const freshness = evaluateEvidenceFreshnessV2({
    kind: card.kind,
    observedAt: card.source.observedAt,
    publishedAt: card.source.publishedAt,
    now,
  });

  if (!hasNamedSubject(card.subject)) reasons.push("subject-not-named");
  if (!isHttpUrl(card.source.url)) reasons.push("source-url-invalid");
  if (
    parseInstant(card.source.observedAt) === null ||
    (card.kind === "news" && parseInstant(card.source.publishedAt || undefined) === null)
  ) {
    reasons.push("source-time-invalid");
  }
  if (!Number.isFinite(card.metric.value) || !/\d/.test(card.metric.raw)) {
    reasons.push("numeric-fact-missing");
  }
  if (!card.metric.name.trim() || !card.metric.unit.trim() || !card.metric.period.trim()) {
    reasons.push("metric-metadata-missing");
  }
  if (card.source.origin !== "direct") reasons.push("not-direct");
  if (card.source.role !== "primary") reasons.push("discovery-only");
  if (card.source.provider === "rss") reasons.push("rss-discovery-only");
  if (card.providerHealth.provider !== card.source.provider) {
    reasons.push("provider-health-mismatch");
  }
  if (card.providerHealth.state !== "green") reasons.push("provider-not-green");
  if (freshness.state === "stale") reasons.push("stale");
  if (freshness.state === "future") reasons.push("future-timestamp");
  if (freshness.state === "invalid" && !reasons.includes("source-time-invalid")) {
    reasons.push("source-time-invalid");
  }

  return { eligible: reasons.length === 0, reasons, freshness };
}

function conversionReasons(input: {
  id: string;
  subject: string;
  sourceUrl: string;
  observedAt: string;
  publishedAt?: string;
  requirePublishedAt: boolean;
  now: string;
  providerCheckedAt: string;
  metric?: EvidenceMetricV2;
}): EvidenceConversionReasonV2[] {
  const reasons: EvidenceConversionReasonV2[] = [];
  if (!input.id.trim()) reasons.push("id-missing");
  if (!input.subject.trim()) reasons.push("subject-missing");
  if (!input.metric || !metricIsComplete(input.metric)) reasons.push("metric-missing");
  if (!input.sourceUrl.trim()) {
    reasons.push("source-url-missing");
  } else if (!isHttpUrl(input.sourceUrl)) {
    reasons.push("source-url-invalid");
  }
  if (input.requirePublishedAt && !input.publishedAt) reasons.push("published-at-missing");
  if (
    parseInstant(input.observedAt) === null ||
    parseInstant(input.now) === null ||
    parseInstant(input.providerCheckedAt) === null ||
    (input.requirePublishedAt && input.publishedAt && parseInstant(input.publishedAt) === null)
  ) {
    reasons.push("timestamp-invalid");
  }
  return reasons;
}

function isRssSource(provider: EvidenceProviderV2, sourceLabel: string): boolean {
  return provider === "rss" || /\brss\b/i.test(sourceLabel);
}

export function evidenceCardFromNewsItemV2(
  item: NewsItem,
  context: NewsEvidenceContextV2
): EvidenceConversionResultV2 {
  const sourceUrl = (context.sourceUrl || item.url || "").trim();
  const publishedAt = (context.publishedAt || item.publishedAt || "").trim() || undefined;
  const reasons = conversionReasons({
    id: context.id,
    subject: context.subject,
    sourceUrl,
    observedAt: context.observedAt,
    publishedAt,
    requirePublishedAt: true,
    now: context.now,
    providerCheckedAt: context.providerHealth.checkedAt,
    metric: context.metric,
  });
  if (reasons.length > 0 || !context.metric || !publishedAt) {
    return { ok: false, reasons };
  }

  const rss = isRssSource(context.providerHealth.provider, item.source);
  const freshness = evaluateEvidenceFreshnessV2({
    kind: "news",
    observedAt: context.observedAt,
    publishedAt,
    now: context.now,
  });
  return {
    ok: true,
    card: {
      schemaVersion: 2,
      id: context.id.trim(),
      lane: context.lane,
      kind: "news",
      subject: context.subject.trim(),
      metric: { ...context.metric },
      source: {
        provider: context.providerHealth.provider,
        url: sourceUrl,
        publishedAt,
        observedAt: context.observedAt,
        origin: context.origin ?? "derived",
        role: rss ? "discovery" : context.role ?? "primary",
      },
      freshness,
      providerHealth: { ...context.providerHealth },
      provenance: {
        kind: "news-item",
        sourceId: item.url || item.title,
      },
    },
  };
}

function isSystemNeutralNutrient(nutrient: OnchainNutrient): boolean {
  const metadataSource = String(nutrient.metadata?.source || "").toLowerCase();
  const identity = `${nutrient.id} ${nutrient.label} ${nutrient.value}`.toLowerCase();
  return metadataSource === "system" || identity.includes("fallback-neutral") || identity.includes("system neutral");
}

function isDerivedProxyNutrient(nutrient: OnchainNutrient): boolean {
  const content = `${nutrient.id} ${nutrient.category} ${nutrient.label} ${nutrient.evidence}`.toLowerCase();
  return content.includes("proxy") || content.includes("프록시");
}

function inferUnit(raw: string): string | null {
  if (/\$\s*[+-]?\s*\d|[+-]?\s*\$\s*\d/.test(raw)) return "USD";
  if (/sat\s*\/\s*vb/i.test(raw)) return "sat/vB";
  if (/%/.test(raw)) return "%";
  if (/\btx\b/i.test(raw)) return "tx";
  if (/\bmb\b/i.test(raw)) return "MB";
  if (/\d\s*x\b/i.test(raw)) return "ratio";
  return null;
}

function inferPeriod(raw: string): string {
  const match = raw.match(/\b(\d+\s*(?:h|d|w|m|y))\b/i);
  return match ? match[1].replace(/\s+/g, "").toLowerCase() : "snapshot";
}

function parseNutrientMetric(
  nutrient: OnchainNutrient,
  context: NutrientEvidenceContextV2
): EvidenceMetricV2 | undefined {
  if (context.metric) return { ...context.metric };

  const raw = nutrient.value.trim();
  const match = raw.match(/([+-]?)\s*(\$)?\s*(\d[\d,]*(?:\.\d+)?)\s*([KMBT])?/i);
  if (!match) return undefined;

  const parsed = Number(match[3].replace(/,/g, ""));
  const multipliers: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
  const multiplier = match[4] ? multipliers[match[4].toUpperCase()] : 1;
  const value = parsed * multiplier * (match[1] === "-" ? -1 : 1);
  const unit = context.metricUnit?.trim() || (match[2] ? "USD" : inferUnit(raw));
  if (!Number.isFinite(value) || !unit) return undefined;

  return {
    name: context.metricName?.trim() || nutrient.category.trim() || nutrient.label.trim(),
    value,
    raw,
    unit,
    period: context.metricPeriod?.trim() || inferPeriod(raw),
  };
}

export function evidenceCardFromNutrientV2(
  nutrient: OnchainNutrient,
  context: NutrientEvidenceContextV2
): EvidenceConversionResultV2 {
  if (isSystemNeutralNutrient(nutrient)) {
    return { ok: false, reasons: ["system-neutral"] };
  }

  const sourceUrl = (context.sourceUrl || "").trim();
  const metric = parseNutrientMetric(nutrient, context);
  const reasons = conversionReasons({
    id: context.id,
    subject: context.subject,
    sourceUrl,
    observedAt: context.observedAt,
    requirePublishedAt: false,
    now: context.now,
    providerCheckedAt: context.providerHealth.checkedAt,
    metric,
  });
  if (reasons.length > 0 || !metric) {
    return { ok: false, reasons };
  }

  const freshness = evaluateEvidenceFreshnessV2({
    kind: "signal",
    observedAt: context.observedAt,
    now: context.now,
  });
  return {
    ok: true,
    card: {
      schemaVersion: 2,
      id: context.id.trim(),
      lane: context.lane,
      kind: "signal",
      subject: context.subject.trim(),
      metric,
      source: {
        provider: context.providerHealth.provider,
        url: sourceUrl,
        publishedAt: null,
        observedAt: context.observedAt,
        origin: isDerivedProxyNutrient(nutrient) ? "derived" : context.origin ?? "direct",
        role: context.role ?? "primary",
      },
      freshness,
      providerHealth: { ...context.providerHealth },
      provenance: {
        kind: "onchain-nutrient",
        sourceId: nutrient.id,
      },
    },
  };
}
