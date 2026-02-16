export interface RuntimeConfig {
  schedulerMode: boolean;
  dailyActivityTarget: number;
  dailyTimezone: string;
  maxActionsPerCycle: number;
  minLoopMinutes: number;
  maxLoopMinutes: number;
}

const DEFAULT_DAILY_ACTIVITY_TARGET = 20;
const DEFAULT_DAILY_TIMEZONE = "Asia/Seoul";
const DEFAULT_MAX_ACTIONS_PER_CYCLE = 4;
const DEFAULT_MIN_LOOP_MINUTES = 25;
const DEFAULT_MAX_LOOP_MINUTES = 70;

function parseIntInRange(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  const parsed = Number.parseInt(raw || "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function loadRuntimeConfig(): RuntimeConfig {
  const schedulerMode = process.env.SCHEDULER_MODE === "true";
  const dailyActivityTarget = parseIntInRange(
    process.env.DAILY_ACTIVITY_TARGET,
    DEFAULT_DAILY_ACTIVITY_TARGET,
    1,
    100
  );
  const dailyTimezone = process.env.DAILY_TARGET_TIMEZONE || DEFAULT_DAILY_TIMEZONE;
  const maxActionsPerCycle = parseIntInRange(
    process.env.MAX_ACTIONS_PER_CYCLE,
    DEFAULT_MAX_ACTIONS_PER_CYCLE,
    1,
    10
  );
  const minLoopMinutes = parseIntInRange(
    process.env.MIN_LOOP_MINUTES,
    DEFAULT_MIN_LOOP_MINUTES,
    5,
    180
  );
  const maxLoopMinutes = parseIntInRange(
    process.env.MAX_LOOP_MINUTES,
    DEFAULT_MAX_LOOP_MINUTES,
    minLoopMinutes,
    240
  );

  return {
    schedulerMode,
    dailyActivityTarget,
    dailyTimezone,
    maxActionsPerCycle,
    minLoopMinutes,
    maxLoopMinutes,
  };
}
