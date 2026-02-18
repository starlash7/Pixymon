export interface FearGreedPoint {
  value: number;
  label?: string;
}

export interface FearGreedEventPolicy {
  minDelta: number;
  requireRegimeChange: boolean;
}

export interface FearGreedEventDecision {
  isEvent: boolean;
  reason: "first-sample" | "delta-change" | "regime-change" | "regime-required" | "no-change" | "unavailable";
  current?: FearGreedPoint;
  previous?: FearGreedPoint;
  delta?: number;
}

export function parseFearGreedPointFromMarketContext(marketContext: string): FearGreedPoint | null {
  const source = String(marketContext || "");
  const valueMatch =
    source.match(/FearGreed\s+(\d{1,3})/i) ||
    source.match(/fear\s*\/?\s*greed[^0-9]{0,12}(\d{1,3})/i) ||
    source.match(/\bFGI[^0-9]{0,8}(\d{1,3})\b/i) ||
    source.match(/(?:공포|탐욕)\s*지수[^0-9]{0,8}(\d{1,3})/i);
  if (!valueMatch) return null;
  const value = Number.parseInt(valueMatch[1], 10);
  if (!Number.isFinite(value)) return null;
  const labelMatch = source.match(/FearGreed\s+\d{1,3}\s*\(([^)]+)\)/i);

  return {
    value: Math.max(0, Math.min(100, value)),
    label: labelMatch?.[1]?.trim() || undefined,
  };
}

export function detectFearGreedEvent(
  current: FearGreedPoint | null,
  previous: FearGreedPoint | null,
  policy: FearGreedEventPolicy
): FearGreedEventDecision {
  if (!current) {
    return { isEvent: false, reason: "unavailable" };
  }
  if (!previous) {
    return { isEvent: true, reason: "first-sample", current };
  }

  const delta = Math.abs(current.value - previous.value);
  const currentRegime = toFearGreedRegime(current.value);
  const previousRegime = toFearGreedRegime(previous.value);
  const regimeChanged = currentRegime !== previousRegime;
  const deltaChanged = delta >= Math.max(1, Math.floor(policy.minDelta));

  if (policy.requireRegimeChange) {
    if (regimeChanged) {
      return {
        isEvent: true,
        reason: "regime-change",
        current,
        previous,
        delta,
      };
    }
    return {
      isEvent: false,
      reason: "regime-required",
      current,
      previous,
      delta,
    };
  }
  if (deltaChanged) {
    return {
      isEvent: true,
      reason: "delta-change",
      current,
      previous,
      delta,
    };
  }

  return {
    isEvent: false,
    reason: "no-change",
    current,
    previous,
    delta,
  };
}

function toFearGreedRegime(value: number): "extreme-fear" | "fear" | "neutral" | "greed" | "extreme-greed" {
  if (value < 20) return "extreme-fear";
  if (value < 40) return "fear";
  if (value < 60) return "neutral";
  if (value < 80) return "greed";
  return "extreme-greed";
}
