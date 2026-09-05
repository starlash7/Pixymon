import test from "node:test";
import assert from "node:assert/strict";
import {
  createFollowUpScheduleV2,
  createMachineFalsifierV2,
  matchesFalsifierV2,
  resolve24HourFollowUpV2,
  resolve72HourFollowUpV2,
} from "../src/services/editorial-v2/follow-ups.ts";

const ANCHOR = "2026-08-01T00:00:00.000Z";

test("an observation-only follow-up never becomes hypothesis support or invalidation", () => {
  const { schedule, falsifier } = contract();
  for (const value of [1000, 800]) {
    const decision = resolve72HourFollowUpV2({
      now: schedule.due72h, schedule, falsifier, observationOnly: true,
      observation: { metric: falsifier.metric, value, observedAt: schedule.due72h },
    });
    assert.equal(decision.resolution, "unresolved");
    assert.equal(decision.reason, "observation-only-not-a-hypothesis");
  }
});

function contract() {
  const schedule = createFollowUpScheduleV2(ANCHOR);
  const falsifier = createMachineFalsifierV2(
    { metric: "active_wallets", comparator: "lt", threshold: 900, unit: "wallets" },
    schedule
  );
  return { schedule, falsifier };
}

test("follow-up schedule fixes machine deadline at +24h and +72h", () => {
  const { schedule, falsifier } = contract();

  assert.deepEqual(schedule, {
    due24h: "2026-08-02T00:00:00.000Z",
    due72h: "2026-08-04T00:00:00.000Z",
  });
  assert.equal(falsifier.deadline, schedule.due72h);
});

test("machine falsifier evaluates every numeric comparator", () => {
  const schedule = createFollowUpScheduleV2(ANCHOR);
  const evaluate = (comparator: "gt" | "gte" | "lt" | "lte" | "eq", value: number) =>
    matchesFalsifierV2(
      createMachineFalsifierV2({ metric: "m", comparator, threshold: 10 }, schedule),
      value
    );

  assert.equal(evaluate("gt", 11), true);
  assert.equal(evaluate("gte", 10), true);
  assert.equal(evaluate("lt", 9), true);
  assert.equal(evaluate("lte", 10), true);
  assert.equal(evaluate("eq", 10), true);
  assert.equal(evaluate("eq", 11), false);
  assert.throws(
    () =>
      createMachineFalsifierV2(
        { metric: "m", comparator: "invalid" as "gt", threshold: 10 },
        schedule
      ),
    /unsupported falsifier comparator/
  );
});

test("24h follow-up stays silent without a meaningful post-checkpoint change", () => {
  const { schedule, falsifier } = contract();

  assert.deepEqual(
    resolve24HourFollowUpV2({
      now: "2026-08-01T23:59:59.000Z",
      schedule,
      falsifier,
      baselineValue: 1_000,
    }),
    { checkpoint: "24h", resolution: "pending", reason: "not-due" }
  );
  assert.deepEqual(
    resolve24HourFollowUpV2({
      now: "2026-08-02T01:00:00.000Z",
      schedule,
      falsifier,
      baselineValue: 1_000,
      observation: {
        metric: "active_wallets",
        value: 980,
        observedAt: "2026-08-02T00:10:00.000Z",
      },
      changeThreshold: { kind: "relative", value: 0.05 },
    }),
    { checkpoint: "24h", resolution: "silent", reason: "no-meaningful-change" }
  );
});

test("24h follow-up emits a revisit candidate only after meaningful change", () => {
  const { schedule, falsifier } = contract();
  const decision = resolve24HourFollowUpV2({
    now: "2026-08-02T01:00:00.000Z",
    schedule,
    falsifier,
    baselineValue: 1_000,
    observation: {
      metric: "active_wallets",
      value: 850,
      observedAt: "2026-08-02T00:10:00.000Z",
    },
    changeThreshold: { kind: "absolute", value: 50 },
  });

  assert.equal(decision.resolution, "candidate");
  if (decision.resolution === "candidate") {
    assert.equal(decision.provisionalVerdict, "invalidated");
    assert.equal(decision.falsifierMatched, true);
  }
});

test("24h follow-up refuses to relabel a +71h observation as the 24h checkpoint", () => {
  const { schedule, falsifier } = contract();
  assert.deepEqual(
    resolve24HourFollowUpV2({
      now: "2026-08-03T23:00:00.000Z",
      schedule,
      falsifier,
      baselineValue: 1_000,
      observation: {
        metric: "active_wallets",
        value: 850,
        observedAt: "2026-08-03T23:00:00.000Z",
      },
      changeThreshold: { kind: "relative", value: 0.05 },
    }),
    { checkpoint: "24h", resolution: "silent", reason: "checkpoint-window-missed" }
  );
});

test("24h checkpoint accepts the three-hour boundary and rejects one millisecond later", () => {
  const { schedule, falsifier } = contract();
  const decide = (observedAt: string) => resolve24HourFollowUpV2({
    now: observedAt,
    schedule,
    falsifier,
    baselineValue: 1_000,
    observation: { metric: "active_wallets", value: 850, observedAt },
    changeThreshold: { kind: "relative", value: 0.05 },
  });
  assert.equal(decide("2026-08-02T03:00:00.000Z").resolution, "candidate");
  assert.deepEqual(decide("2026-08-02T03:00:00.001Z"), {
    checkpoint: "24h",
    resolution: "silent",
    reason: "checkpoint-window-missed",
  });
});

test("percentage follow-up uses a 0.5 percentage-point boundary", () => {
  const schedule = createFollowUpScheduleV2(ANCHOR);
  const falsifier = createMachineFalsifierV2(
    { metric: "change", comparator: "lt", threshold: 8, unit: "%" },
    schedule
  );
  const decide = (value: number) => resolve24HourFollowUpV2({
    now: "2026-08-02T01:00:00.000Z",
    schedule,
    falsifier,
    baselineValue: 8,
    observation: { metric: "change", value, observedAt: "2026-08-02T00:10:00.000Z" },
    changeThreshold: { kind: "absolute", value: 0.5 },
  });

  assert.equal(decide(8.49).resolution, "silent");
  assert.equal(decide(8.5).resolution, "candidate");
});

test("72h follow-up closes as invalidated, supported, or unresolved", () => {
  const { schedule, falsifier } = contract();
  const base = {
    now: "2026-08-04T01:00:00.000Z",
    schedule,
    falsifier,
  };

  assert.equal(
    resolve72HourFollowUpV2({
      ...base,
      observation: {
        metric: "active_wallets",
        value: 850,
        observedAt: "2026-08-04T00:10:00.000Z",
      },
    }).resolution,
    "invalidated"
  );
  assert.equal(
    resolve72HourFollowUpV2({
      ...base,
      observation: {
        metric: "active_wallets",
        value: 950,
        observedAt: "2026-08-04T00:10:00.000Z",
      },
    }).resolution,
    "supported"
  );
  assert.deepEqual(resolve72HourFollowUpV2(base), {
    checkpoint: "72h",
    resolution: "pending",
    reason: "missing-observation",
  });
  assert.deepEqual(
    resolve72HourFollowUpV2({
      ...base,
      observation: {
        metric: "active_wallets",
        value: 850,
        observedAt: "2026-08-03T23:59:59.000Z",
      },
    }),
    { checkpoint: "72h", resolution: "pending", reason: "observation-before-deadline" }
  );
});

test("72h follow-up closes unresolved when the checkpoint window was missed", () => {
  const { schedule, falsifier } = contract();
  assert.deepEqual(
    resolve72HourFollowUpV2({
      now: "2026-08-04T07:00:00.000Z",
      schedule,
      falsifier,
      observation: {
        metric: "active_wallets",
        value: 850,
        observedAt: "2026-08-04T07:00:00.000Z",
      },
    }),
    { checkpoint: "72h", resolution: "unresolved", reason: "checkpoint-window-missed" }
  );
});

test("resolution rejects a falsifier deadline that diverges from the 72h checkpoint", () => {
  const { schedule, falsifier } = contract();

  assert.throws(
    () =>
      resolve72HourFollowUpV2({
        now: "2026-08-04T01:00:00.000Z",
        schedule,
        falsifier: { ...falsifier, deadline: "2026-08-05T00:00:00.000Z" },
      }),
    /must match/
  );
  assert.throws(
    () =>
      resolve72HourFollowUpV2({
        now: "2026-08-04T01:00:00.000Z",
        schedule: { ...schedule, due24h: "2026-08-03T00:00:00.000Z" },
        falsifier,
      }),
    /48 hours apart/
  );
});
