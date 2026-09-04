import {
  FollowUp24DecisionV2,
  FollowUp72DecisionV2,
  FollowUpScheduleV2,
  MachineFalsifierV2,
  MeaningfulChangeThresholdV2,
  NumericFollowUpObservationV2,
} from "./contracts.js";

const HOUR_MS = 60 * 60 * 1000;
/** Hourly workers get bounded scheduling slack without relabelling much later data. */
export const FOLLOW_UP_CHECKPOINT_WINDOW_MS_V2 = 3 * HOUR_MS;

function parseInstant(value: string | Date, field: string): number {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${field} must be a valid instant`);
  }
  return timestamp;
}

function assertFinite(value: number, field: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${field} must be finite`);
  }
}

function assertScheduleMatchesFalsifier(
  schedule: FollowUpScheduleV2,
  falsifier: MachineFalsifierV2
): void {
  const due24h = parseInstant(schedule.due24h, "schedule.due24h");
  const due72h = parseInstant(schedule.due72h, "schedule.due72h");
  const deadline = parseInstant(falsifier.deadline, "falsifier.deadline");
  if (due72h - due24h !== 48 * HOUR_MS) {
    throw new Error("follow-up checkpoints must be exactly 48 hours apart");
  }
  if (due72h !== deadline) {
    throw new Error("falsifier.deadline must match schedule.due72h");
  }
}

export function createFollowUpScheduleV2(anchor: string | Date): FollowUpScheduleV2 {
  const anchorMs = parseInstant(anchor, "anchor");
  return {
    due24h: new Date(anchorMs + 24 * HOUR_MS).toISOString(),
    due72h: new Date(anchorMs + 72 * HOUR_MS).toISOString(),
  };
}

export function createMachineFalsifierV2(
  input: Omit<MachineFalsifierV2, "deadline">,
  schedule: FollowUpScheduleV2
): MachineFalsifierV2 {
  const metric = input.metric.trim();
  if (!metric) {
    throw new Error("falsifier.metric is required");
  }
  if (!["gt", "gte", "lt", "lte", "eq"].includes(input.comparator)) {
    throw new Error(`unsupported falsifier comparator: ${String(input.comparator)}`);
  }
  assertFinite(input.threshold, "falsifier.threshold");
  parseInstant(schedule.due72h, "schedule.due72h");
  return {
    metric,
    comparator: input.comparator,
    threshold: input.threshold,
    deadline: schedule.due72h,
    unit: input.unit?.trim() || undefined,
  };
}

export function matchesFalsifierV2(falsifier: MachineFalsifierV2, value: number): boolean {
  assertFinite(value, "observation.value");
  assertFinite(falsifier.threshold, "falsifier.threshold");
  switch (falsifier.comparator) {
    case "gt":
      return value > falsifier.threshold;
    case "gte":
      return value >= falsifier.threshold;
    case "lt":
      return value < falsifier.threshold;
    case "lte":
      return value <= falsifier.threshold;
    case "eq":
      return value === falsifier.threshold;
    default:
      throw new Error(`unsupported falsifier comparator: ${String(falsifier.comparator)}`);
  }
}

function hasMeaningfulChange(
  baselineValue: number,
  observedValue: number,
  threshold: MeaningfulChangeThresholdV2
): boolean {
  assertFinite(baselineValue, "baselineValue");
  assertFinite(observedValue, "observation.value");
  assertFinite(threshold.value, "changeThreshold.value");
  if (threshold.value < 0) {
    throw new Error("changeThreshold.value must be non-negative");
  }

  const absoluteDelta = Math.abs(observedValue - baselineValue);
  if (threshold.kind === "absolute") {
    return absoluteDelta > 0 && absoluteDelta >= threshold.value;
  }
  if (threshold.kind === "relative") {
    if (baselineValue === 0) {
      return absoluteDelta > 0;
    }
    const relativeDelta = absoluteDelta / Math.abs(baselineValue);
    return relativeDelta > 0 && relativeDelta >= threshold.value;
  }
  throw new Error(`unsupported change threshold: ${String((threshold as { kind?: unknown }).kind)}`);
}

function observationIssue<T extends "observation-before-checkpoint" | "observation-before-deadline">(
  observation: NumericFollowUpObservationV2 | undefined,
  falsifier: MachineFalsifierV2,
  checkpointMs: number,
  nowMs: number,
  beforeReason: T
): "missing-observation" | "metric-mismatch" | "checkpoint-window-missed" | T | null {
  const windowEndMs = checkpointMs + FOLLOW_UP_CHECKPOINT_WINDOW_MS_V2;
  if (!observation) {
    return nowMs > windowEndMs ? "checkpoint-window-missed" : "missing-observation";
  }
  if (observation.metric.trim() !== falsifier.metric.trim()) return "metric-mismatch";
  const observedAt = parseInstant(observation.observedAt, "observation.observedAt");
  if (observedAt < checkpointMs) return beforeReason;
  if (observedAt > windowEndMs) return "checkpoint-window-missed";
  assertFinite(observation.value, "observation.value");
  return null;
}

export function resolve24HourFollowUpV2(input: {
  now: string | Date;
  schedule: FollowUpScheduleV2;
  falsifier: MachineFalsifierV2;
  baselineValue: number;
  observation?: NumericFollowUpObservationV2;
  changeThreshold?: MeaningfulChangeThresholdV2;
}): FollowUp24DecisionV2 {
  assertScheduleMatchesFalsifier(input.schedule, input.falsifier);
  const nowMs = parseInstant(input.now, "now");
  const due24hMs = parseInstant(input.schedule.due24h, "schedule.due24h");
  if (nowMs < due24hMs) {
    return { checkpoint: "24h", resolution: "pending", reason: "not-due" };
  }

  const issue = observationIssue(
    input.observation,
    input.falsifier,
    due24hMs,
    nowMs,
    "observation-before-checkpoint"
  );
  if (issue) {
    return { checkpoint: "24h", resolution: "silent", reason: issue };
  }

  const observation = input.observation as NumericFollowUpObservationV2;
  const threshold = input.changeThreshold ?? { kind: "absolute", value: 0 };
  if (!hasMeaningfulChange(input.baselineValue, observation.value, threshold)) {
    return { checkpoint: "24h", resolution: "silent", reason: "no-meaningful-change" };
  }

  const falsifierMatched = matchesFalsifierV2(input.falsifier, observation.value);
  return {
    checkpoint: "24h",
    resolution: "candidate",
    reason: "meaningful-change",
    provisionalVerdict: falsifierMatched ? "invalidated" : "unresolved",
    falsifierMatched,
    baselineValue: input.baselineValue,
    observedValue: observation.value,
    observedAt: observation.observedAt,
  };
}

export function resolve72HourFollowUpV2(input: {
  now: string | Date;
  schedule: FollowUpScheduleV2;
  falsifier: MachineFalsifierV2;
  observation?: NumericFollowUpObservationV2;
}): FollowUp72DecisionV2 {
  assertScheduleMatchesFalsifier(input.schedule, input.falsifier);
  const nowMs = parseInstant(input.now, "now");
  const deadlineMs = parseInstant(input.falsifier.deadline, "falsifier.deadline");
  if (nowMs < deadlineMs) {
    return { checkpoint: "72h", resolution: "pending", reason: "not-due" };
  }

  const issue = observationIssue(
    input.observation,
    input.falsifier,
    deadlineMs,
    nowMs,
    "observation-before-deadline"
  );
  if (issue) {
    return issue === "checkpoint-window-missed"
      ? { checkpoint: "72h", resolution: "unresolved", reason: issue }
      : { checkpoint: "72h", resolution: "pending", reason: issue };
  }

  const observation = input.observation as NumericFollowUpObservationV2;
  const falsifierMatched = matchesFalsifierV2(input.falsifier, observation.value);
  return {
    checkpoint: "72h",
    resolution: falsifierMatched ? "invalidated" : "supported",
    reason: falsifierMatched ? "falsifier-matched" : "falsifier-clear",
    falsifierMatched,
    observedValue: observation.value,
    observedAt: observation.observedAt,
  };
}
