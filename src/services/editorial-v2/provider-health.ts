export type EvidenceProviderV2 =
  | "defillama"
  | "mempool.space"
  | "coingecko"
  | "rss"
  | "cryptocompare"
  | "blockchain.com"
  | "unknown";

export type ProviderFailureCodeV2 =
  | "not-configured"
  | "unauthorized"
  | "rate-limited"
  | "timeout"
  | "parse-error"
  | "stale-cache"
  | "payload-too-large"
  | "empty"
  | "http-error"
  | "network-error";

export interface ProviderSuccessOutcomeV2 {
  kind: "success";
  provider: EvidenceProviderV2;
  checkedAt: string;
  latencyMs: number;
  itemCount: number;
}

export interface ProviderFailureOutcomeV2 {
  kind: "failure";
  provider: EvidenceProviderV2;
  checkedAt: string;
  latencyMs: number;
  failure: ProviderFailureCodeV2;
  statusCode?: number;
}

export type ProviderFetchOutcomeV2 = ProviderSuccessOutcomeV2 | ProviderFailureOutcomeV2;

export type ProviderHealthStateV2 = "green" | "yellow" | "red";

export interface ProviderHealthV2 {
  provider: EvidenceProviderV2;
  state: ProviderHealthStateV2;
  reason: "ok" | ProviderFailureCodeV2;
  checkedAt: string;
  latencyMs: number;
  itemCount: number;
  statusCode?: number;
}

const YELLOW_FAILURES = new Set<ProviderFailureCodeV2>([
  "rate-limited",
  "timeout",
  "stale-cache",
  "payload-too-large",
  "empty",
  "network-error",
]);

/**
 * Reduces a fetch outcome to a health snapshot without hiding the original
 * failure reason. Callers create one outcome per provider attempt.
 */
export function providerHealthFromOutcomeV2(outcome: ProviderFetchOutcomeV2): ProviderHealthV2 {
  if (outcome.kind === "success") {
    if (outcome.itemCount <= 0) {
      return {
        provider: outcome.provider,
        state: "yellow",
        reason: "empty",
        checkedAt: outcome.checkedAt,
        latencyMs: outcome.latencyMs,
        itemCount: 0,
      };
    }
    return {
      provider: outcome.provider,
      state: "green",
      reason: "ok",
      checkedAt: outcome.checkedAt,
      latencyMs: outcome.latencyMs,
      itemCount: outcome.itemCount,
    };
  }

  return {
    provider: outcome.provider,
    state: YELLOW_FAILURES.has(outcome.failure) ? "yellow" : "red",
    reason: outcome.failure,
    checkedAt: outcome.checkedAt,
    latencyMs: outcome.latencyMs,
    itemCount: 0,
    statusCode: outcome.statusCode,
  };
}

export function providerFailureCodeFromHttpStatusV2(statusCode: number): ProviderFailureCodeV2 {
  if (statusCode === 401 || statusCode === 403) return "unauthorized";
  if (statusCode === 429) return "rate-limited";
  return "http-error";
}
