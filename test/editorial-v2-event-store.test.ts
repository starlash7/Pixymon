import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  CreateEditorialDraftInputV2,
  EditorialEventStoreV2,
  readEditorialEventsV2,
} from "../src/services/editorial-v2/event-store.ts";
import {
  createFollowUpScheduleV2,
  createMachineFalsifierV2,
} from "../src/services/editorial-v2/follow-ups.ts";
import {
  EDITORIAL_COLLECTION_EPOCH_V2,
  type EditorialGeneratedPayloadV2,
} from "../src/services/editorial-v2/contracts.ts";
import { splitEditorialSentencesV2 } from "../src/services/editorial-v2/validator.ts";
import { acquireRuntimeLock } from "../src/services/process-lock.ts";

const CREATED_AT = "2026-08-01T00:00:00.000Z";

function withTempLog(run: (eventLogPath: string) => void): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-editorial-v2-"));
  try {
    run(path.join(tempDir, "nested", "editorial-events.jsonl"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function idFactory(): (kind: "draft" | "review" | "dispatch" | "follow-up" | "event") => string {
  let sequence = 0;
  return (kind) => `${kind}_${++sequence}`;
}

function draftInput(overrides: Partial<CreateEditorialDraftInputV2> = {}): CreateEditorialDraftInputV2 {
  const followUpSchedule = createFollowUpScheduleV2(CREATED_AT);
  const input: CreateEditorialDraftInputV2 = {
    id: "draft_001",
    runId: "run_001",
    createdAt: CREATED_AT,
    lane: "protocol",
    collectionEpoch: EDITORIAL_COLLECTION_EPOCH_V2,
    format: "bite",
    subject: "Aave",
    thesis: "대출 수요가 인센티브 이후에도 남는다.",
    factIds: ["fact_aave_borrow"],
    facts: [
      {
        factId: "fact_aave_borrow",
        subject: "Aave",
        metric: {
          name: "borrow_usd",
          value: 100_000_000,
          raw: "$100M",
          unit: "USD",
          period: "snapshot",
        },
        source: {
          provider: "defillama",
          url: "https://defillama.com/protocol/aave",
          publishedAt: null,
          observedAt: "2026-08-01T00:30:00.000Z",
        },
      },
    ],
    verdict: "수요가 유지되면 보상보다 습관이 강하다.",
    falsifier: createMachineFalsifierV2(
      { metric: "borrow_usd", comparator: "lt", threshold: 90_000_000, unit: "USD" },
      followUpSchedule
    ),
    followUpSchedule,
    voiceState: "skeptical",
    draft: "Aave 대출액이 1억 달러를 지켰다. 72시간 안에 9천만 달러 아래로 밀리면 수요가 남았다는 내 판정은 틀린다.",
    ...overrides,
  };
  if (!Object.hasOwn(overrides, "generatedPayload")) {
    input.generatedPayload = generatedPayload(input.draft, input.factIds);
  }
  return input;
}

function generatedPayload(
  draft = draftInput().draft,
  factIds: readonly string[] = ["fact_aave_borrow"]
): EditorialGeneratedPayloadV2 {
  return {
    draft,
    usedFactIds: [...factIds],
    claims: splitEditorialSentencesV2(draft).map((text, index) => ({
      kind: index === 0 ? "observation" : "judgment",
      text,
      factIds: [...factIds],
    })),
  };
}

test("editorial event store appends immutable events and publishes an approved draft once", () => {
  withTempLog((eventLogPath) => {
    const store = new EditorialEventStoreV2({
      eventLogPath,
      now: () => new Date("2026-08-01T01:00:00.000Z"),
      idFactory: idFactory(),
    });

    store.createDraft(draftInput());
    store.approve("draft_001", { reviewerId: "operator", reasonTags: ["grounded"] });
    const preparation = store.preparePublication("draft_001");
    assert.equal(preparation.status, "ready");
    if (preparation.status === "ready") {
      assert.equal(preparation.facts[0]?.metric.raw, "$100M");
      assert.equal(preparation.publishText, draftInput().draft);
    }
    const immutablePrefix = fs.readFileSync(eventLogPath, "utf-8");

    if (preparation.status !== "ready") assert.fail("expected ready publication");
    store.markDispatching("draft_001", {
      preparedAt: preparation.freshnessCheckedAt,
      expectedPublishText: preparation.publishText,
      timezone: "UTC",
      dailyLimit: 1,
    });

    const first = store.markPublished("draft_001", {
      externalPostId: "x_post_001",
      preparedAt: preparation.freshnessCheckedAt,
      publishedAt: "2026-08-01T02:00:00.000Z",
    });
    const afterFirstPublish = fs.readFileSync(eventLogPath, "utf-8");
    const retry = store.markPublished("draft_001", { externalPostId: "x_post_retry" });

    assert.equal(first.status, "published");
    assert.equal(retry.status, "already-published");
    assert.equal(retry.publication.externalPostId, "x_post_001");
    assert.equal(fs.readFileSync(eventLogPath, "utf-8"), afterFirstPublish);
    assert.ok(afterFirstPublish.startsWith(immutablePrefix));
    assert.equal(readEditorialEventsV2(eventLogPath).length, 4);

    const reloaded = new EditorialEventStoreV2({ eventLogPath });
    const state = reloaded.getDraftState("draft_001");
    assert.equal(state?.reviewStatus, "approved");
    assert.equal(state?.publication?.externalPostId, "x_post_001");
    assert.equal(state?.publication?.publishedText, draftInput().draft);
    assert.equal(state?.publication?.followUpSchedule.due24h, "2026-08-02T02:00:00.000Z");
    assert.equal(state?.publication?.followUpSchedule.due72h, "2026-08-04T02:00:00.000Z");
    assert.equal(state?.publication?.falsifier.deadline, "2026-08-04T02:00:00.000Z");
    assert.equal(state?.publication?.falsifier.metric, "borrow_usd");
    assert.deepEqual(state?.draft.generatedPayload, draftInput().generatedPayload);
    assert.equal(reloaded.preparePublication("draft_001").status, "already-published");
    assert.throws(
      () => reloaded.reject("draft_001", { reviewerId: "operator", reasonTags: ["late-change"] }),
      /cannot be reviewed again/
    );
  });
});

test("edit approves only the edited text while reject blocks publication", () => {
  withTempLog((eventLogPath) => {
    const store = new EditorialEventStoreV2({ eventLogPath, idFactory: idFactory() });
    store.createDraft(draftInput());
    const editedDraft = "Aave 대출액은 1억 달러다. 72시간 안에 9천만 달러를 이탈하면 수요 잔류 판정을 거둔다.";

    store.edit("draft_001", {
      reviewerId: "operator",
      reasonTags: ["shortened", "shortened"],
      editedDraft,
    });
    assert.equal(store.getDraftState("draft_001")?.publishText, editedDraft);
    assert.equal(store.getDraftState("draft_001")?.reviewStatus, "approved");

    assert.throws(
      () => store.reject("draft_001", { reviewerId: "operator" }),
      /requires at least one reason tag/
    );
    store.reject("draft_001", { reviewerId: "operator", reasonTags: ["unsupported-claim"] });
    assert.equal(store.getDraftState("draft_001")?.reviewStatus, "rejected");
    assert.throws(
      () => store.markPublished("draft_001", { externalPostId: "x_post_002" }),
      /must be approved/
    );
  });
});

test("draft facts map exactly to factIds and expose immutable review evidence", () => {
  withTempLog((eventLogPath) => {
    const store = new EditorialEventStoreV2({ eventLogPath, idFactory: idFactory() });

    assert.throws(
      () => store.createDraft(draftInput({ factIds: ["different_fact"] })),
      /map exactly/
    );
    const draft = store.createDraft(draftInput());
    const state = store.getDraftState(draft.id);

    assert.equal(state?.draft.facts[0]?.metric.raw, "$100M");
    assert.equal(state?.draft.facts[0]?.source.url, "https://defillama.com/protocol/aave");
  });
});

test("generated writer payload is copied into immutable draft lineage", () => {
  withTempLog((eventLogPath) => {
    const store = new EditorialEventStoreV2({ eventLogPath, idFactory: idFactory() });
    const payload = generatedPayload();
    store.createDraft(draftInput({ generatedPayload: payload }));

    (payload.usedFactIds as string[])[0] = "mutated-fact";
    (payload.claims[0].factIds as string[])[0] = "mutated-claim-fact";
    const state = store.getDraftState("draft_001");
    assert.equal(state?.draft.generatedPayload?.usedFactIds[0], "fact_aave_borrow");
    assert.equal(state?.draft.generatedPayload?.claims[0]?.factIds[0], "fact_aave_borrow");
    assert.deepEqual(
      state?.draft.generatedPayload?.claims.map((claim) => claim.kind),
      ["observation", "judgment"]
    );
  });
});

test("generated writer payload enforces text, ids, sentence order, kinds, and coverage", () => {
  withTempLog((eventLogPath) => {
    const store = new EditorialEventStoreV2({ eventLogPath, idFactory: idFactory() });
    const base = generatedPayload();
    const invalid: Array<{ payload: EditorialGeneratedPayloadV2; pattern: RegExp }> = [
      {
        payload: { ...base, draft: `${base.draft} 다르다.` },
        pattern: /must match draft\.draft exactly/,
      },
      {
        payload: { ...base, usedFactIds: ["unknown-fact"] },
        pattern: /usedFactIds must map exactly/,
      },
      {
        payload: {
          ...base,
          claims: [
            { ...base.claims[0], text: base.claims[1].text },
            { ...base.claims[1], text: base.claims[0].text },
          ],
        },
        pattern: /preserve sentence order exactly/,
      },
      {
        payload: {
          ...base,
          claims: [base.claims[0], { ...base.claims[1], kind: "observation" }],
        },
        pattern: /claim 2 must be judgment/,
      },
      {
        payload: {
          ...base,
          claims: [base.claims[0], { ...base.claims[1], factIds: [] }],
        },
        pattern: /claim factIds must cover draft\.factIds exactly/,
      },
    ];

    for (const row of invalid) {
      assert.throws(
        () => store.createDraft(draftInput({ generatedPayload: row.payload })),
        row.pattern
      );
    }
    assert.equal(store.readEvents().length, 0);
  });
});

test("publish rechecks fact freshness using the store clock", () => {
  withTempLog((eventLogPath) => {
    const store = new EditorialEventStoreV2({
      eventLogPath,
      now: () => new Date("2026-08-01T03:00:00.001Z"),
      idFactory: idFactory(),
    });
    store.createDraft(draftInput());
    store.approve("draft_001", { reviewerId: "operator" });

    assert.throws(() => store.preparePublication("draft_001"), /evidence is stale/);
    assert.throws(() => store.markDispatching("draft_001", {
      preparedAt: "2026-08-01T03:00:00.001Z",
      expectedPublishText: draftInput().draft,
      timezone: "UTC",
      dailyLimit: 1,
    }), /evidence is stale/);
    assert.equal(store.getDraftState("draft_001")?.publication, undefined);
    assert.equal(store.readEvents().length, 2);
  });
});

test("durable dispatch intent blocks automatic resend and supports explicit reconciliation", () => {
  withTempLog((eventLogPath) => {
    let current = new Date("2026-08-01T01:00:00.000Z");
    const store = new EditorialEventStoreV2({
      eventLogPath,
      now: () => current,
      idFactory: idFactory(),
    });
    store.createDraft(draftInput());
    store.approve("draft_001", { reviewerId: "operator" });
    const preparation = store.preparePublication("draft_001");
    if (preparation.status !== "ready") assert.fail("expected ready publication");
    store.markDispatching("draft_001", {
      preparedAt: preparation.freshnessCheckedAt,
      expectedPublishText: preparation.publishText,
      timezone: "UTC",
      dailyLimit: 1,
    });

    assert.throws(() => store.preparePublication("draft_001"), /unresolved dispatch intent/);
    assert.equal(store.getDraftState("draft_001")?.dispatchIntent?.publishText, draftInput().draft);

    current = new Date("2026-08-01T01:10:00.000Z");
    const reconciled = store.reconcilePublished("draft_001", {
      externalPostId: "x-confirmed-by-operator",
      publishedAt: "2026-08-01T01:00:05.000Z",
    });
    assert.equal(reconciled.status, "published");
    assert.equal(reconciled.publication.externalPostId, "x-confirmed-by-operator");
    assert.equal(reconciled.publication.followUpSchedule.due24h, "2026-08-02T01:00:05.000Z");
  });
});

test("follow-up resolutions fold once per checkpoint", () => {
  withTempLog((eventLogPath) => {
    const store = new EditorialEventStoreV2({ eventLogPath, idFactory: idFactory() });
    store.createDraft(draftInput());

    const first = store.recordFollowUpResolution("draft_001", {
      checkpoint: "24h",
      resolution: "candidate",
      reason: "meaningful-change",
      resolvedAt: "2026-08-02T00:10:00.000Z",
      observedAt: "2026-08-02T00:05:00.000Z",
      metric: "borrow_usd",
      baselineValue: 100_000_000,
      observedValue: 92_000_000,
      falsifierMatched: false,
      observation: {
        factId: "fact_aave_borrow_followup",
        subject: "Aave",
        metric: {
          name: "borrow_usd",
          value: 92_000_000,
          raw: "$92M",
          unit: "USD",
          period: "snapshot",
        },
        source: {
          provider: "defillama",
          url: "https://defillama.com/protocol/aave",
          publishedAt: null,
          observedAt: "2026-08-02T00:05:00.000Z",
        },
      },
    });
    const retry = store.recordFollowUpResolution("draft_001", {
      checkpoint: "24h",
      resolution: "silent",
      reason: "no-meaningful-change",
    });

    assert.equal(first.status, "recorded");
    assert.equal(retry.status, "already-recorded");
    assert.equal(retry.resolution.resolution, "candidate");
    assert.equal(store.getDraftState("draft_001")?.followUps.length, 1);
    assert.equal(readEditorialEventsV2(eventLogPath).length, 2);
  });
});

test("event reader reports the exact corrupt JSONL line", () => {
  withTempLog((eventLogPath) => {
    fs.mkdirSync(path.dirname(eventLogPath), { recursive: true });
    fs.writeFileSync(eventLogPath, '{"schemaVersion":2}\n{not-json}\n', "utf-8");

    assert.throws(() => readEditorialEventsV2(eventLogPath), /line 1/);
  });
});

test("all ledger mutations share one cross-process lock", () => {
  withTempLog((eventLogPath) => {
    const store = new EditorialEventStoreV2({ eventLogPath, idFactory: idFactory() });
    store.createDraft(draftInput());
    const lock = acquireRuntimeLock(`${eventLogPath}.lock`);
    assert.equal(lock.acquired, true);
    try {
      assert.throws(
        () => store.approve("draft_001", { reviewerId: "operator" }),
        /editorial ledger busy/
      );
      assert.equal(store.getDraftState("draft_001")?.reviewStatus, "pending");
    } finally {
      lock.release();
    }
    store.approve("draft_001", { reviewerId: "operator" });
    assert.equal(store.getDraftState("draft_001")?.reviewStatus, "approved");
  });
});
