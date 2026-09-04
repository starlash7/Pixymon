import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { EditorialEventStoreV2 } from "../src/services/editorial-v2/event-store.ts";
import { createFollowUpScheduleV2, createMachineFalsifierV2 } from "../src/services/editorial-v2/follow-ups.ts";
import { publishEditorialDraftV2 } from "../src/services/editorial-v2/publisher.ts";
import { recordEditorialReviewV2 } from "../src/services/editorial-v2/review.ts";

const NOW = new Date("2026-08-28T10:00:00.000Z");
const TEXT = "Aave의 TVL은 2026-08-28 09:30 UTC 기준 24시간 동안 +8.4% 늘었지만, 바로 승인하진 않겠다. 72시간 뒤 같은 지표의 관측값이 기준 미만이면 이 판정을 철회한다.";

function fixture(draftText = TEXT) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-v2-publish-"));
  let id = 0;
  const store = new EditorialEventStoreV2({ eventLogPath: path.join(dir, "events.ndjson"), now: () => NOW, idFactory: (kind) => `${kind}-${++id}` });
  const schedule = createFollowUpScheduleV2(NOW);
  const draft = store.createDraft({
    runId: "run-1", createdAt: NOW.toISOString(), format: "bite", subject: "Aave", thesis: "Aave TVL을 확인한다.", factIds: ["fact-1"],
    facts: [{ factId: "fact-1", subject: "Aave", metric: { name: "tvl-change-24h", value: 8.4, raw: "+8.4%", unit: "%", period: "24h" }, source: { provider: "defillama", url: "https://api.llama.fi/v2/chains", publishedAt: null, observedAt: "2026-08-28T09:30:00.000Z" } }],
    verdict: "approve", falsifier: createMachineFalsifierV2({ metric: "tvl-change-24h", comparator: "lt", threshold: 8.4, unit: "%" }, schedule), followUpSchedule: schedule, voiceState: "curious", draft: draftText,
  });
  return { store, draft, metrics: path.join(dir, "metrics.ndjson") };
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

test("edited copy must retain the evidence contract", () => {
  const f = fixture();
  assert.throws(() => recordEditorialReviewV2({ store: f.store, draftId: f.draft.id, action: "edit", reviewerId: "operator", reasonTags: ["clarity"], editedDraft: "Aave 좋아 보인다.", metricLogPath: f.metrics, mode: "observe", now: NOW }), /failed contract/);
});

test("human edits cannot invert the machine falsifier direction", () => {
  const f = fixture();
  const inverted = "Aave의 TVL은 2026-08-28 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 72시간 뒤 +8.4% 이상으로 늘어나면 이 판정을 철회한다.";
  assert.throws(
    () => recordEditorialReviewV2({
      store: f.store,
      draftId: f.draft.id,
      action: "edit",
      reviewerId: "operator",
      reasonTags: ["clarity"],
      editedDraft: inverted,
      metricLogPath: f.metrics,
      mode: "observe",
      now: NOW,
    }),
    /falsifier-direction-mismatch/
  );
});

test("human edits cannot negate a matching comparator token", () => {
  const f = fixture();
  const inverted = "Aave의 TVL은 2026-08-28 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 이 한 번의 관측만으로 더 큰 서사를 승인하진 않는다. 72시간 뒤 TVL이 기준 미만이 아니어도 이 판정을 철회한다.";
  assert.throws(
    () => recordEditorialReviewV2({
      store: f.store,
      draftId: f.draft.id,
      action: "edit",
      reviewerId: "operator",
      reasonTags: ["clarity"],
      editedDraft: inverted,
      metricLogPath: f.metrics,
      mode: "observe",
      now: NOW,
    }),
    /falsifier-language-not-canonical/
  );
});

test("human edits cannot wrap a matching comparator in opposite logic", () => {
  const f = fixture();
  const inverted = "Aave의 TVL은 2026-08-28 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 이 한 번의 관측만으로 더 큰 서사를 승인하진 않는다. 72시간 뒤 TVL이 기준 미만을 제외한 값일 경우 이 판정을 철회한다.";
  assert.throws(
    () => recordEditorialReviewV2({
      store: f.store,
      draftId: f.draft.id,
      action: "edit",
      reviewerId: "operator",
      reasonTags: ["clarity"],
      editedDraft: inverted,
      metricLogPath: f.metrics,
      mode: "observe",
      now: NOW,
    }),
    /falsifier-language-not-canonical/
  );
});

for (const inverted of [
  "Aave의 TVL은 2026-08-28 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 이 한 번의 관측만으로 더 큰 서사를 승인하진 않는다. 72시간 뒤 TVL 관측값이 기준선을 웃도는 때 이 판정을 철회한다.",
  "Aave의 TVL은 2026-08-28 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 72시간 뒤 기준 이상으로 늘어나면 이 판정을 철회한다. 72시간 뒤 같은 지표의 관측값이 기준 미만이면 이 판정을 철회한다.",
  "Aave의 TVL은 2026-08-28 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 다음 관측값이 기준선을 웃돌 때 이 판정을 폐기한다. 72시간 뒤 같은 지표의 관측값이 기준 미만이면 이 판정을 철회한다.",
  "Aave의 TVL은 2026-08-28 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 사흘 후 수치가 경계보다 높아지면 이 판정을 취소한다. 72시간 뒤 같은 지표의 관측값이 기준 미만이면 이 판정을 철회한다.",
]) {
  test("human edits cannot hide or duplicate the machine falsifier", () => {
    const f = fixture();
    assert.throws(
      () => recordEditorialReviewV2({
        store: f.store,
        draftId: f.draft.id,
        action: "edit",
        reviewerId: "operator",
        reasonTags: ["clarity"],
        editedDraft: inverted,
        metricLogPath: f.metrics,
        mode: "observe",
        now: NOW,
      }),
      /falsifier-(?:language-not-canonical|deadline-not-isolated|condition-outside-final|action-outside-final|language-outside-final)/
    );
  });
}

test("publish-time validation blocks a hidden competing falsifier", async () => {
  const hidden = "Aave의 TVL은 2026-08-28 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 사흘 후 수치가 경계보다 높아지면 이 판정을 취소한다. 72시간 뒤 같은 지표의 관측값이 기준 미만이면 이 판정을 철회한다.";
  const f = fixture(hidden);
  recordEditorialReviewV2({
    store: f.store,
    draftId: f.draft.id,
    action: "approve",
    reviewerId: "operator",
    metricLogPath: f.metrics,
    mode: "live",
    now: NOW,
  });
  let calls = 0;
  const result = await publishEditorialDraftV2({
    store: f.store,
    draftId: f.draft.id,
    mode: "live",
    dispatch: async (_text, beforeSend) => {
      beforeSend();
      calls += 1;
      return "x-should-not-run";
    },
    revalidateEvidence: async () => ({ ok: true }),
    metricLogPath: f.metrics,
    timezone: "Asia/Seoul",
    now: NOW,
  });
  assert.equal(result.status, "blocked");
  if (result.status !== "blocked") assert.fail("hidden falsifier reached dispatch");
  assert.match(result.reason, /publish-contract:.*falsifier-condition-outside-final/);
  assert.equal(calls, 0);
});

test("a later approval preserves the last contract-valid human edit", () => {
  const f = fixture();
  const edited = "Aave의 TVL은 2026-08-28 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 아직 한 번의 관측이라 확대 해석은 보류한다. 72시간 뒤 같은 지표의 관측값이 기준 미만이면 이 판정을 철회한다.";
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
  const edited = "Aave의 TVL은 2026-08-28 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 한 번의 관측이라 확대 해석은 보류한다. 72시간 뒤 같은 지표의 관측값이 기준 미만이면 이 판정을 철회한다.";
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
  const secondText = "Aave의 TVL은 2026-08-28 09:40 UTC 기준 24시간 동안 +8.4% 늘었다. 아직 한 번의 관측이라 해석은 보류한다. 72시간 뒤 같은 지표의 관측값이 기준 미만이면 이 판정을 철회한다.";
  const second = f.store.createDraft({
    id: "same-subject-second",
    runId: "run-second",
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
  const secondText = "Compound의 TVL은 2026-08-28 09:30 UTC 기준 24시간 동안 +4.2% 늘었지만, 바로 승인하진 않겠다. 72시간 뒤 같은 지표의 관측값이 기준 미만이면 이 판정을 철회한다.";
  const second = f.store.createDraft({
    id: "draft-second",
    runId: "run-2",
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
