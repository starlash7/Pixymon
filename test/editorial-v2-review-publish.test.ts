import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { EditorialEventStoreV2 } from "../src/services/editorial-v2/event-store.ts";
import { createFollowUpScheduleV2, createMachineFalsifierV2 } from "../src/services/editorial-v2/follow-ups.ts";
import { publishEditorialDraftV2 as publishWithPolicy } from "../src/services/editorial-v2/publisher.ts";
import { recordEditorialReviewV2 } from "../src/services/editorial-v2/review.ts";
import { splitEditorialSentencesV2 } from "../src/services/editorial-v2/validator.ts";
import { EDITORIAL_COLLECTION_EPOCH_V2 } from "../src/services/editorial-v2/contracts.ts";

const NOW = new Date("2026-08-28T10:00:00.000Z");
// Individual dispatch tests inject earned operator authority. Missing/revoked
// authority is exercised independently below and by publication-policy tests.
function publishEditorialDraftV2(input: Parameters<typeof publishWithPolicy>[0]) {
  return publishWithPolicy({ authorize: () => {}, ...input });
}
const TEXT = "Aave의 TVL은 8월 28일 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 이 한 번의 수치는 분명하지만, 더 큰 회복 서사까지 승인한다는 잠정 판단만 남긴다.";

function fixture(
  draftText = TEXT,
  format: "bite" | "revisit" = "bite",
  includeGeneratedPayload = true
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-v2-publish-"));
  let id = 0;
  const store = new EditorialEventStoreV2({ eventLogPath: path.join(dir, "events.ndjson"), now: () => NOW, idFactory: (kind) => `${kind}-${++id}` });
  const schedule = createFollowUpScheduleV2(NOW);
  const draft = store.createDraft({
    runId: "run-1", createdAt: NOW.toISOString(),
    lane: "protocol", collectionEpoch: EDITORIAL_COLLECTION_EPOCH_V2,
    format, subject: "Aave", thesis: "Aave TVL을 확인한다.", factIds: ["fact-1"],
    facts: [{ factId: "fact-1", subject: "Aave", metric: { name: "tvl-change-24h", value: 8.4, raw: "+8.4%", unit: "%", period: "24h" }, source: { provider: "defillama", url: "https://api.llama.fi/v2/chains", publishedAt: null, observedAt: "2026-08-28T09:30:00.000Z" } }],
    verdict: format === "revisit" ? "digesting" : "approve", falsifier: createMachineFalsifierV2({ metric: "tvl-change-24h", comparator: "lt", threshold: 8.4, unit: "%" }, schedule), followUpSchedule: schedule, voiceState: "curious", draft: draftText,
    ...{
      generatedPayload: {
        draft: draftText,
        usedFactIds: ["fact-1"],
        claims: splitEditorialSentencesV2(draftText).map((text, index) => ({
          kind: index === 0 ? "observation" as const : "judgment" as const,
          text,
          factIds: ["fact-1"],
        })),
      },
    },
  } as Parameters<EditorialEventStoreV2["createDraft"]>[0]);
  if (!includeGeneratedPayload) {
    // Historical schema-v2 rows remain readable; new writes cannot omit lineage.
    const events = store.readEvents();
    for (const event of events) {
      if (event.type !== "draft-created") continue;
      delete event.draft.lane;
      delete event.draft.collectionEpoch;
      delete event.draft.generatedPayload;
    }
    fs.writeFileSync(path.join(dir, "events.ndjson"), events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  }
  return { store, draft, metrics: path.join(dir, "metrics.ndjson") };
}

function addDraft(
  target: ReturnType<typeof fixture>,
  input: {
    id: string;
    subject: string;
    text: string;
    value: number;
    raw: string;
    format?: "bite" | "revisit";
  }
) {
  const schedule = createFollowUpScheduleV2(NOW);
  return target.store.createDraft({
    id: input.id,
    runId: `run-${input.id}`,
    createdAt: NOW.toISOString(),
    lane: "protocol",
    collectionEpoch: EDITORIAL_COLLECTION_EPOCH_V2,
    format: input.format ?? "bite",
    subject: input.subject,
    thesis: `${input.subject} TVL을 확인한다.`,
    factIds: [`fact-${input.id}`],
    facts: [{
      factId: `fact-${input.id}`,
      subject: input.subject,
      metric: {
        name: "tvl-change-24h",
        value: input.value,
        raw: input.raw,
        unit: "%",
        period: "24h",
      },
      source: {
        provider: "defillama",
        url: "https://api.llama.fi/v2/chains",
        publishedAt: null,
        observedAt: "2026-08-28T09:30:00.000Z",
      },
    }],
    verdict: input.format === "revisit" ? "digesting" : "approve",
    falsifier: createMachineFalsifierV2({
      metric: "tvl-change-24h",
      comparator: "lt",
      threshold: input.value,
      unit: "%",
    }, schedule),
    followUpSchedule: schedule,
    voiceState: "curious",
    draft: input.text,
    generatedPayload: {
      draft: input.text,
      usedFactIds: [`fact-${input.id}`],
      claims: splitEditorialSentencesV2(input.text).map((text, index) => ({
        kind: index === 0 ? "observation" : "judgment",
        text,
        factIds: [`fact-${input.id}`],
      })),
    },
  });
}

function twoPartyBarrier(): () => Promise<void> {
  let arrivals = 0;
  let release: (() => void) | undefined;
  const bothArrived = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrivals += 1;
    if (arrivals === 2) release?.();
    await bothArrived;
  };
}

test("review is append-only and non-live publication never dispatches", async () => {
  const f = fixture();
  recordEditorialReviewV2({ store: f.store, draftId: f.draft.id, action: "approve", reviewerId: "operator", metricLogPath: f.metrics, mode: "observe", now: NOW });
  let calls = 0;
  const result = await publishEditorialDraftV2({ store: f.store, draftId: f.draft.id, mode: "observe", dispatch: async () => { calls += 1; return "should-not-run"; }, revalidateEvidence: async () => ({ ok: true }), metricLogPath: f.metrics, timezone: "Asia/Seoul", now: NOW });
  assert.deepEqual(result, { status: "blocked", reason: "live-mode-required" });
  assert.equal(calls, 0);
});

test("approved fresh draft publishes once and is idempotent", async () => {
  const f = fixture();
  recordEditorialReviewV2({ store: f.store, draftId: f.draft.id, action: "approve", reviewerId: "operator", metricLogPath: f.metrics, mode: "live", now: NOW });
  let calls = 0;
  const publish = () => publishEditorialDraftV2({ store: f.store, draftId: f.draft.id, mode: "live", dispatch: async (_text, beforeSend) => { beforeSend(); calls += 1; return "x-123"; }, revalidateEvidence: async () => ({ ok: true }), metricLogPath: f.metrics, timezone: "Asia/Seoul", now: NOW });
  assert.deepEqual(await publish(), { status: "published", externalPostId: "x-123" });
  assert.deepEqual(await publish(), { status: "already-published", externalPostId: "x-123" });
  assert.equal(calls, 1);
});

test("legacy drafts without durable writer lineage cannot publish", async () => {
  const f = fixture(TEXT, "bite", false);
  recordEditorialReviewV2({
    store: f.store,
    draftId: f.draft.id,
    action: "approve",
    reviewerId: "operator",
    metricLogPath: f.metrics,
    mode: "live",
    now: NOW,
  });
  let healthChecks = 0;
  let dispatches = 0;
  const result = await publishEditorialDraftV2({
    store: f.store,
    draftId: f.draft.id,
    mode: "live",
    dispatch: async () => { dispatches += 1; return "x-legacy"; },
    revalidateEvidence: async () => { healthChecks += 1; return { ok: true }; },
    metricLogPath: f.metrics,
    timezone: "Asia/Seoul",
    now: NOW,
  });
  assert.deepEqual(result, { status: "blocked", reason: "writer-lineage-missing" });
  assert.equal(healthChecks, 0);
  assert.equal(dispatches, 0);
});

test("edited copy must retain the evidence contract", () => {
  const f = fixture();
  assert.throws(() => recordEditorialReviewV2({ store: f.store, draftId: f.draft.id, action: "edit", reviewerId: "operator", reasonTags: ["clarity"], editedDraft: "Aave 좋아 보인다.", metricLogPath: f.metrics, mode: "observe", now: NOW }), /failed contract/);
});

test("human edits and publishing allow a grounded conditional judgment", async () => {
  const text = "Aave의 TVL은 8월 28일 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 이 수치만으로 회복을 주장한다면 근거가 부족하므로, 현재 판단은 관측된 변화에만 한정한다.";
  const f = fixture();
  recordEditorialReviewV2({
    store: f.store, draftId: f.draft.id, action: "edit", reviewerId: "operator",
    reasonTags: ["clarity"], editedDraft: text, metricLogPath: f.metrics, mode: "observe", now: NOW,
  });
  let calls = 0;
  const result = await publishEditorialDraftV2({
    store: f.store, draftId: f.draft.id, mode: "live",
    dispatch: async (_text, beforeSend) => { beforeSend(); calls += 1; return "x-conditional"; },
    revalidateEvidence: async () => ({ ok: true }), metricLogPath: f.metrics, timezone: "Asia/Seoul", now: NOW,
  });
  assert.equal(result.status, "published");
  assert.equal(calls, 1);
});

test("approval cannot bypass missing or revoked rollout authority", async () => {
  const f = fixture();
  f.store.approve(f.draft.id, { reviewerId: "operator" });
  let writes = 0;
  let checks = 0;
  const common = {
    store: f.store, draftId: f.draft.id, mode: "live" as const,
    dispatch: async (_text: string, beforeSend: () => void) => { beforeSend(); writes += 1; return "x"; },
    revalidateEvidence: async () => ({ ok: true }), metricLogPath: f.metrics, timezone: "Asia/Seoul", now: NOW,
  };
  assert.deepEqual(await publishWithPolicy(common), { status: "blocked", reason: "approved-live-authorization-required" });
  const revoked = await publishWithPolicy({ ...common, authorize: () => {
    checks += 1;
    if (checks > 1) throw new Error("editorial-live-suspended");
  } });
  assert.equal(revoked.status, "blocked");
  assert.equal(writes, 0);
  assert.equal(f.store.getDraftState(f.draft.id)?.dispatchIntent, undefined);
});

test("review and publish reject a Revisit that promises another check", async () => {
  const resolved = "Aave의 현재 TVL은 8월 28일 09:30 UTC 기준 +8.4% 수준이다. 24시간 재검증 결과는 아직 미결이라는 판단으로 남긴다.";
  const promised = "Aave의 현재 TVL은 8월 28일 09:30 UTC 기준 +8.4% 수준이다. 이번 판정은 미결로 남기고 다음 관측에서 다시 확인하겠다.";
  const reviewed = fixture(resolved, "revisit");
  assert.throws(
    () => recordEditorialReviewV2({
      store: reviewed.store,
      draftId: reviewed.draft.id,
      action: "edit",
      reviewerId: "operator",
      editedDraft: promised,
      metricLogPath: reviewed.metrics,
      mode: "observe",
      now: NOW,
    }),
    /future-recheck-promise/
  );

  const published = fixture(promised, "revisit");
  recordEditorialReviewV2({ store: published.store, draftId: published.draft.id, action: "approve", reviewerId: "operator", metricLogPath: published.metrics, mode: "live", now: NOW });
  let calls = 0;
  const result = await publishEditorialDraftV2({
    store: published.store,
    draftId: published.draft.id,
    mode: "live",
    dispatch: async (_text, beforeSend) => { beforeSend(); calls += 1; return "x-should-not-run"; },
    revalidateEvidence: async () => ({ ok: true }),
    metricLogPath: published.metrics,
    timezone: "Asia/Seoul",
    now: NOW,
  });
  assert.equal(result.status, "blocked");
  if (result.status !== "blocked") assert.fail("future Revisit promise reached dispatch");
  assert.match(result.reason, /publish-contract:.*future-recheck-promise/);
  assert.equal(calls, 0);
});

test("a later approval preserves the last contract-valid human edit", () => {
  const f = fixture();
  const edited = "Aave의 TVL은 8월 28일 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 이 한 번의 수치는 기록하되, 원인과 지속성에 대한 확대 해석은 보류한다.";
  recordEditorialReviewV2({
    store: f.store,
    draftId: f.draft.id,
    action: "edit",
    reviewerId: "editor",
    reasonTags: ["clarity"],
    editedDraft: edited,
    metricLogPath: f.metrics,
    mode: "observe",
    now: NOW,
  });
  recordEditorialReviewV2({
    store: f.store,
    draftId: f.draft.id,
    action: "approve",
    reviewerId: "approver",
    metricLogPath: f.metrics,
    mode: "observe",
    now: NOW,
  });

  const state = f.store.getDraftState(f.draft.id);
  assert.equal(state?.reviewStatus, "approved");
  assert.equal(state?.publishText, edited);
  assert.equal(state?.draft.generatedPayload?.draft, TEXT);
  assert.notEqual(state?.draft.generatedPayload?.draft, state?.publishText);
});

test("provider health is revalidated immediately before dispatch", async () => {
  const f = fixture();
  recordEditorialReviewV2({ store: f.store, draftId: f.draft.id, action: "approve", reviewerId: "operator", metricLogPath: f.metrics, mode: "live", now: NOW });
  let calls = 0;
  const result = await publishEditorialDraftV2({
    store: f.store,
    draftId: f.draft.id,
    mode: "live",
    dispatch: async (_text, beforeSend) => { beforeSend(); calls += 1; return "x-should-not-run"; },
    revalidateEvidence: async () => ({ ok: false, reason: "defillama:timeout" }),
    metricLogPath: f.metrics,
    timezone: "Asia/Seoul",
    now: NOW,
  });
  assert.deepEqual(result, { status: "blocked", reason: "provider-not-green:defillama:timeout" });
  assert.equal(calls, 0);
});

test("an ambiguous X outcome leaves a durable intent and cannot dispatch twice", async () => {
  const f = fixture();
  recordEditorialReviewV2({ store: f.store, draftId: f.draft.id, action: "approve", reviewerId: "operator", metricLogPath: f.metrics, mode: "live", now: NOW });
  let calls = 0;
  const publish = () => publishEditorialDraftV2({
    store: f.store,
    draftId: f.draft.id,
    mode: "live",
    dispatch: async (_text, beforeSend) => { beforeSend(); calls += 1; return null; },
    revalidateEvidence: async () => ({ ok: true }),
    metricLogPath: f.metrics,
    timezone: "Asia/Seoul",
    now: NOW,
  });
  assert.deepEqual(await publish(), { status: "blocked", reason: "x-dispatch-outcome-unresolved" });
  const retry = await publish();
  assert.equal(retry.status, "blocked");
  if (retry.status !== "blocked") assert.fail("unresolved intent was retried");
  assert.match(retry.reason, /unresolved dispatch intent/);
  assert.equal(calls, 1);
});

test("a pre-X dispatch block leaves no intent and can be safely retried", async () => {
  const f = fixture();
  recordEditorialReviewV2({ store: f.store, draftId: f.draft.id, action: "approve", reviewerId: "operator", metricLogPath: f.metrics, mode: "live", now: NOW });
  const common = {
    store: f.store,
    draftId: f.draft.id,
    mode: "live" as const,
    revalidateEvidence: async () => ({ ok: true }),
    metricLogPath: f.metrics,
    timezone: "Asia/Seoul",
    now: NOW,
  };
  const blocked = await publishEditorialDraftV2({
    ...common,
    dispatch: async () => null,
  });
  assert.deepEqual(blocked, { status: "blocked", reason: "x-dispatch-not-attempted" });
  assert.equal(f.store.getDraftState(f.draft.id)?.dispatchIntent, undefined);

  const retried = await publishEditorialDraftV2({
    ...common,
    dispatch: async (_text, beforeSend) => { beforeSend(); return "x-after-preflight"; },
  });
  assert.deepEqual(retried, { status: "published", externalPostId: "x-after-preflight" });
});

test("a review edit between preparation and send blocks the stale prepared text", async () => {
  const f = fixture();
  recordEditorialReviewV2({ store: f.store, draftId: f.draft.id, action: "approve", reviewerId: "operator", metricLogPath: f.metrics, mode: "live", now: NOW });
  const edited = "Aave의 TVL은 8월 28일 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 이 한 번의 수치는 기록하되, 원인과 지속성에 대한 확대 해석은 보류한다.";
  let xCalls = 0;
  const result = await publishEditorialDraftV2({
    store: f.store,
    draftId: f.draft.id,
    mode: "live",
    dispatch: async (_text, beforeSend) => {
      recordEditorialReviewV2({ store: f.store, draftId: f.draft.id, action: "edit", reviewerId: "editor", reasonTags: ["clarity"], editedDraft: edited, metricLogPath: f.metrics, mode: "live", now: NOW });
      beforeSend();
      xCalls += 1;
      return "x-must-not-send";
    },
    revalidateEvidence: async () => ({ ok: true }),
    metricLogPath: f.metrics,
    timezone: "Asia/Seoul",
    now: NOW,
  });

  assert.equal(result.status, "blocked");
  if (result.status !== "blocked") assert.fail("stale prepared copy was dispatched");
  assert.match(result.reason, /approved draft changed after publication preparation/);
  assert.equal(xCalls, 0);
  assert.equal(f.store.getDraftState(f.draft.id)?.publishText, edited);
  assert.equal(f.store.getDraftState(f.draft.id)?.dispatchIntent, undefined);
});

test("publish-time gate blocks the same subject inside rolling 24h without a meaningful delta", async () => {
  const f = fixture();
  recordEditorialReviewV2({ store: f.store, draftId: f.draft.id, action: "approve", reviewerId: "operator", metricLogPath: f.metrics, mode: "live", now: NOW });
  await publishEditorialDraftV2({
    store: f.store,
    draftId: f.draft.id,
    mode: "live",
    dispatch: async (_text, beforeSend) => { beforeSend(); return "x-first-subject"; },
    revalidateEvidence: async () => ({ ok: true }),
    metricLogPath: f.metrics,
    timezone: "Asia/Seoul",
    dailyLimit: 2,
    now: NOW,
  });

  const schedule = createFollowUpScheduleV2(NOW);
  const secondText = "Aave의 TVL은 8월 28일 09:40 UTC 기준 24시간 동안 +8.4% 늘었다. 이 한 번의 수치는 기록하되, 원인과 지속성에 대한 확대 해석은 보류한다.";
  const second = f.store.createDraft({
    id: "same-subject-second",
    runId: "run-second",
    lane: "protocol", collectionEpoch: EDITORIAL_COLLECTION_EPOCH_V2,
    createdAt: NOW.toISOString(),
    format: "withhold",
    subject: "Aave",
    thesis: "같은 대상을 새 변화 없이 반복하지 않는다.",
    factIds: ["fact-second"],
    facts: [{ factId: "fact-second", subject: "Aave", metric: { name: "tvl-change-24h", value: 8.4, raw: "+8.4%", unit: "%", period: "24h" }, source: { provider: "defillama", url: "https://api.llama.fi/v2/chains", publishedAt: null, observedAt: "2026-08-28T09:40:00.000Z" } }],
    verdict: "digesting",
    falsifier: createMachineFalsifierV2({ metric: "tvl-change-24h", comparator: "lt", threshold: 8.4, unit: "%" }, schedule),
    followUpSchedule: schedule,
    voiceState: "patient",
    draft: secondText,
    generatedPayload: {
      draft: secondText,
      usedFactIds: ["fact-second"],
      claims: splitEditorialSentencesV2(secondText).map((text, index) => ({
        kind: index === 0 ? "observation" as const : "judgment" as const,
        text,
        factIds: ["fact-second"],
      })),
    },
  });
  recordEditorialReviewV2({ store: f.store, draftId: second.id, action: "approve", reviewerId: "operator", metricLogPath: f.metrics, mode: "live", now: NOW });
  let secondXCalls = 0;
  const result = await publishEditorialDraftV2({
    store: f.store,
    draftId: second.id,
    mode: "live",
    dispatch: async (_text, beforeSend) => { beforeSend(); secondXCalls += 1; return "x-second-subject"; },
    revalidateEvidence: async () => ({ ok: true }),
    metricLogPath: f.metrics,
    timezone: "Asia/Seoul",
    dailyLimit: 2,
    now: NOW,
  });
  assert.equal(result.status, "blocked");
  if (result.status !== "blocked") assert.fail("same-subject duplicate was dispatched");
  assert.match(result.reason, /same subject within 24h/);
  assert.equal(secondXCalls, 0);
});

test("concurrent exact-duplicate drafts reserve at most one X send", async () => {
  const f = fixture();
  const second = addDraft(f, {
    id: "duplicate-second",
    subject: "Aave",
    text: TEXT,
    value: 8.4,
    raw: "+8.4%",
  });
  for (const draftId of [f.draft.id, second.id]) {
    recordEditorialReviewV2({
      store: f.store,
      draftId,
      action: "approve",
      reviewerId: "operator",
      metricLogPath: f.metrics,
      mode: "live",
      now: NOW,
    });
  }

  const waitForBoth = twoPartyBarrier();
  let xCalls = 0;
  const publish = (draftId: string) => publishEditorialDraftV2({
    store: f.store,
    draftId,
    mode: "live",
    dispatch: async (_text, beforeSend) => {
      await waitForBoth();
      beforeSend();
      xCalls += 1;
      return `x-${draftId}`;
    },
    revalidateEvidence: async () => ({ ok: true }),
    metricLogPath: f.metrics,
    timezone: "Asia/Seoul",
    dailyLimit: 2,
    now: NOW,
  });

  const results = await Promise.all([publish(f.draft.id), publish(second.id)]);
  assert.equal(results.filter((result) => result.status === "published").length, 1);
  assert.deepEqual(
    results.filter((result) => result.status === "blocked"),
    [{ status: "blocked", reason: "duplicate-published-text" }]
  );
  assert.equal(xCalls, 1);
  assert.equal(f.store.listDraftStates().filter((state) => state.dispatchIntent).length, 1);
  assert.equal(f.store.listDraftStates().filter((state) => state.publication).length, 1);
});

test("concurrent distinct drafts atomically reserve the daily X budget", async () => {
  const f = fixture();
  const secondText = "Compound의 TVL은 8월 28일 09:30 UTC 기준 24시간 동안 +4.2% 늘었다. 이 한 번의 수치는 분명하지만, 더 큰 회복 서사까지 승인한다는 잠정 판단만 남긴다.";
  const second = addDraft(f, {
    id: "daily-limit-second",
    subject: "Compound",
    text: secondText,
    value: 4.2,
    raw: "+4.2%",
  });
  for (const draftId of [f.draft.id, second.id]) {
    recordEditorialReviewV2({
      store: f.store,
      draftId,
      action: "approve",
      reviewerId: "operator",
      metricLogPath: f.metrics,
      mode: "live",
      now: NOW,
    });
  }

  const waitForBoth = twoPartyBarrier();
  let xCalls = 0;
  const publish = (draftId: string) => publishEditorialDraftV2({
    store: f.store,
    draftId,
    mode: "live",
    dispatch: async (_text, beforeSend) => {
      await waitForBoth();
      beforeSend();
      xCalls += 1;
      return `x-${draftId}`;
    },
    revalidateEvidence: async () => ({ ok: true }),
    metricLogPath: f.metrics,
    timezone: "Asia/Seoul",
    dailyLimit: 1,
    now: NOW,
  });

  const results = await Promise.all([publish(f.draft.id), publish(second.id)]);
  assert.equal(results.filter((result) => result.status === "published").length, 1);
  assert.deepEqual(
    results.filter((result) => result.status === "blocked"),
    [{ status: "blocked", reason: "editorial-daily-limit" }]
  );
  assert.equal(xCalls, 1);
  assert.equal(f.store.listDraftStates().filter((state) => state.dispatchIntent).length, 1);
  assert.equal(f.store.listDraftStates().filter((state) => state.publication).length, 1);
});

test("invalid daily limit fails closed to one post per day", async () => {
  const f = fixture();
  recordEditorialReviewV2({ store: f.store, draftId: f.draft.id, action: "approve", reviewerId: "operator", metricLogPath: f.metrics, mode: "live", now: NOW });
  const common = {
    mode: "live" as const,
    revalidateEvidence: async () => ({ ok: true }),
    metricLogPath: f.metrics,
    timezone: "Asia/Seoul",
    now: NOW,
  };
  await publishEditorialDraftV2({ ...common, store: f.store, draftId: f.draft.id, dailyLimit: 1, dispatch: async (_text, beforeSend) => { beforeSend(); return "x-first"; } });

  const schedule = createFollowUpScheduleV2(NOW);
  const secondText = "Compound의 TVL은 8월 28일 09:30 UTC 기준 24시간 동안 +4.2% 늘었다. 이 한 번의 수치는 분명하지만, 더 큰 회복 서사까지 승인한다는 잠정 판단만 남긴다.";
  const second = f.store.createDraft({
    id: "draft-second",
    runId: "run-2",
    lane: "protocol", collectionEpoch: EDITORIAL_COLLECTION_EPOCH_V2,
    createdAt: NOW.toISOString(),
    format: "bite",
    subject: "Compound",
    thesis: "Compound TVL을 확인한다.",
    factIds: ["fact-2"],
    facts: [{ factId: "fact-2", subject: "Compound", metric: { name: "tvl-change-24h", value: 4.2, raw: "+4.2%", unit: "%", period: "24h" }, source: { provider: "defillama", url: "https://api.llama.fi/v2/chains", publishedAt: null, observedAt: "2026-08-28T09:30:00.000Z" } }],
    verdict: "approve",
    falsifier: createMachineFalsifierV2({ metric: "tvl-change-24h", comparator: "lt", threshold: 4.2, unit: "%" }, schedule),
    followUpSchedule: schedule,
    voiceState: "curious",
    draft: secondText,
    generatedPayload: {
      draft: secondText,
      usedFactIds: ["fact-2"],
      claims: splitEditorialSentencesV2(secondText).map((text, index) => ({
        kind: index === 0 ? "observation" as const : "judgment" as const,
        text,
        factIds: ["fact-2"],
      })),
    },
  });
  recordEditorialReviewV2({ store: f.store, draftId: second.id, action: "approve", reviewerId: "operator", metricLogPath: f.metrics, mode: "live", now: NOW });
  let secondCalls = 0;
  const result = await publishEditorialDraftV2({
    ...common,
    store: f.store,
    draftId: second.id,
    dailyLimit: Number.NaN,
    dispatch: async (_text, beforeSend) => { beforeSend(); secondCalls += 1; return "x-second"; },
  });
  assert.deepEqual(result, { status: "blocked", reason: "editorial-daily-limit" });
  assert.equal(secondCalls, 0);
});
