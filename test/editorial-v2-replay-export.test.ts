import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EditorialEventStoreV2 } from "../src/services/editorial-v2/event-store.ts";
import {
  createFollowUpScheduleV2,
  createMachineFalsifierV2,
} from "../src/services/editorial-v2/follow-ups.ts";
import {
  buildEditorialReplayExportFromLedgerV2,
  buildEditorialReplayFixturesV2,
  parseStrictEditorialReplayExportV2,
  readEditorialReplayFixturesV2,
  verifyEditorialReplayLineageV2,
  writeNewEditorialReplayFileV2,
} from "../src/services/editorial-v2/replay-export.ts";
import { EDITORIAL_COLLECTION_EPOCH_V2 } from "../src/services/editorial-v2/contracts.ts";

const NOW = "2026-08-01T01:00:00.000Z";

function draftInput() {
  const followUpSchedule = createFollowUpScheduleV2(NOW);
  const draft = "Aave의 TVL은 8월 1일 01:00 UTC 기준 +3.2%다. 한 번의 상승을 구조 변화로 부르지 않는다.";
  return {
    id: "runtime-draft-secret",
    runId: "runtime-run-secret",
    createdAt: NOW,
    lane: "protocol" as const,
    collectionEpoch: EDITORIAL_COLLECTION_EPOCH_V2,
    format: "bite" as const,
    subject: "Aave",
    thesis: "원시 TVL 변화만 판정한다.",
    factIds: ["runtime-fact-secret"],
    facts: [{
      factId: "runtime-fact-secret",
      subject: "Aave",
      metric: {
        name: "tvl-change-24h",
        value: 3.2,
        raw: "+3.2%",
        unit: "%",
        period: "24h",
      },
      source: {
        provider: "private-provider-name",
        url: "https://private-provider.invalid/secret-path",
        publishedAt: null,
        observedAt: NOW,
      },
    }],
    verdict: "한 번의 상승을 구조 변화로 부르지 않는다.",
    falsifier: createMachineFalsifierV2(
      { metric: "tvl", comparator: "lt" as const, threshold: 99, unit: "USD" },
      followUpSchedule
    ),
    followUpSchedule,
    voiceState: "skeptical" as const,
    draft,
    generatedPayload: {
      draft,
      usedFactIds: ["runtime-fact-secret"],
      claims: [
        {
          kind: "observation" as const,
          text: "Aave의 TVL은 8월 1일 01:00 UTC 기준 +3.2%다.",
          factIds: ["runtime-fact-secret"],
        },
        {
          kind: "judgment" as const,
          text: "한 번의 상승을 구조 변화로 부르지 않는다.",
          factIds: ["runtime-fact-secret"],
        },
      ],
    },
  };
}

test("replay export is deterministic, minimal, and explicit about generated/edit provenance", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-replay-export-"));
  try {
    const eventLogPath = path.join(directory, "events.ndjson");
    let sequence = 0;
    const store = new EditorialEventStoreV2({
      eventLogPath,
      now: () => new Date(NOW),
      idFactory: (kind) => `${kind}-${++sequence}`,
    });
    const original = store.createDraft(draftInput());
    store.edit(original.id, {
      reviewerId: "private-reviewer",
      reasonTags: ["clarity"],
      editedDraft: `${original.draft} 수정본`,
    });
    store.approve(original.id, { reviewerId: "private-reviewer", reasonTags: ["fact-checked"] });

    const first = buildEditorialReplayFixturesV2(store.readEvents());
    const second = readEditorialReplayFixturesV2(eventLogPath);
    assert.deepEqual(second, first);
    assert.equal(first.length, 1);
    assert.equal(first[0].id, "replay-000001");
    assert.deepEqual(first[0].factIds, ["fact-1"]);
    assert.deepEqual(first[0].usedFactIds, ["fact-1"]);
    assert.deepEqual(first[0].claims.map((claim) => claim.factIds), [["fact-1"], ["fact-1"]]);
    assert.equal(first[0].draft, original.draft);
    assert.equal(first[0].textProvenance, "generated");
    assert.equal(first[0].reviewDisposition, "approved-edited");
    assert.equal(first[0].wasEverEdited, true);
    assert.deepEqual(first[0].falsifier, draftInput().falsifier);

    const replay = buildEditorialReplayExportFromLedgerV2(eventLogPath);
    assert.deepEqual(replay.rows, first);
    assert.equal(replay.lineage.source, "editorial-event-ledger");
    assert.equal(replay.lineage.sourceEventCount, store.readEvents().length);
    assert.equal(replay.lineage.sourceDraftCount, 1);
    assert.equal(replay.lineage.exportedDraftCount, 1);
    verifyEditorialReplayLineageV2(replay, eventLogPath);
    store.approve(original.id, { reviewerId: "private-reviewer", reasonTags: ["language-checked"] });
    verifyEditorialReplayLineageV2(replay, eventLogPath,);
    const wrongLineage = structuredClone(replay);
    wrongLineage.lineage.sourceLedgerSha256 = "0".repeat(64);
    assert.throws(
      () => verifyEditorialReplayLineageV2(wrongLineage, eventLogPath),
      /prefix does not match/
    );

    const serialized = JSON.stringify(replay);
    for (const secret of [
      "runtime-draft-secret",
      "runtime-run-secret",
      "runtime-fact-secret",
      "private-provider-name",
      "private-provider.invalid",
      "private-reviewer",
      "수정본",
    ]) {
      assert.equal(serialized.includes(secret), false, secret);
    }

    const outputPath = path.join(directory, "exports", "replay.json");
    writeNewEditorialReplayFileV2(outputPath, replay);
    assert.throws(() => writeNewEditorialReplayFileV2(outputPath, replay), /EEXIST/);

    assert.throws(() => parseStrictEditorialReplayExportV2(first), /must be an object/);
    const withTopLevelOverride = structuredClone(replay) as unknown as Record<string, unknown>;
    const rows = withTopLevelOverride.rows as Array<Record<string, unknown>>;
    rows[0].metricName = "forged-top-level-metric";
    assert.throws(
      () => parseStrictEditorialReplayExportV2(withTopLevelOverride),
      /unsupported fields: metricName/
    );
    const mismatchedSubject = structuredClone(replay);
    mismatchedSubject.rows[0].subject = "ForgedSubject";
    assert.throws(
      () => parseStrictEditorialReplayExportV2(mismatchedSubject),
      /subject must match the first nested fact/
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("replay export fails closed on a missing ledger or invalid limit", () => {
  assert.throws(
    () => readEditorialReplayFixturesV2("/tmp/pixymon-ledger-does-not-exist.ndjson"),
    /event log not found/
  );
  assert.throws(() => buildEditorialReplayFixturesV2([], { limit: 0 }), /positive integer/);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-replay-legacy-"));
  try {
    const eventLogPath = path.join(directory, "events.ndjson");
    const store = new EditorialEventStoreV2({ eventLogPath });
    const { generatedPayload: _omitted, ...missingPayload } = draftInput();
    assert.throws(
      () => store.createDraft(missingPayload),
      /epoch draft requires durable generated payload/
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("replay excludes declared legacy history and keeps every draft in the selected epoch", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-replay-epoch-"));
  try {
    const eventLogPath = path.join(directory, "events.ndjson");
    const store = new EditorialEventStoreV2({ eventLogPath, now: () => new Date(NOW) });
    store.createDraft(draftInput());
    const legacyEvents = store.readEvents();
    for (const event of legacyEvents) {
      if (event.type !== "draft-created") continue;
      delete event.draft.collectionEpoch;
      delete event.draft.lane;
      delete event.draft.generatedPayload;
    }
    fs.writeFileSync(eventLogPath, legacyEvents.map((event) => JSON.stringify(event)).join("\n") + "\n");
    store.createDraft({ ...draftInput(), id: "new-epoch-draft" });
    const replay = buildEditorialReplayExportFromLedgerV2(eventLogPath, { limit: 1 });
    assert.equal(replay.lineage.sourceDraftCount, 2);
    assert.equal(replay.lineage.epochDraftCount, 1);
    assert.equal(replay.lineage.excludedDraftCount, 1);
    assert.equal(replay.lineage.selectionPolicy, "first-created-in-epoch");
    assert.equal(replay.rows[0].lane, "protocol");
    verifyEditorialReplayLineageV2(replay, eventLogPath);
    const corrupt = store.readEvents();
    for (const event of corrupt) {
      if (event.type === "draft-created" && event.draft.id === "new-epoch-draft") {
        delete event.draft.generatedPayload;
      }
    }
    fs.writeFileSync(eventLogPath, corrupt.map((event) => JSON.stringify(event)).join("\n") + "\n");
    assert.throws(() => buildEditorialReplayExportFromLedgerV2(eventLogPath), /epoch draft requires durable generated payload/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
