import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  aggregateBlindEvaluationV2, BLIND_SCORE_AXES_V2, buildBlindEvaluationPackV2,
  type BlindComparisonCaseV2, type BlindEvaluationAnnotationV2,
  type BlindEvaluationMappingV2, type BlindReplayBindingV2, type BlindScoresV2,
  writeNewBlindEvaluationPackV2, readBlindComparisonCasesV2,
} from "../src/services/editorial-v2/human-eval.ts";
import { EDITORIAL_COLLECTION_EPOCH_V2 } from "../src/services/editorial-v2/contracts.ts";
import type { EditorialReplayFixtureV2 } from "../src/services/editorial-v2/replay-export.ts";

function sourceFixture() {
  const rows: EditorialReplayFixtureV2[] = [];
  for (let index = 0; index < 36; index++) {
    const subject = "프로토콜-" + (index + 1);
    const raw = "+" + (index + 1) + ".0%";
    const sentences = [subject + "의 TVL은 " + raw + "다.", "한 번의 변화를 추세로 부르지 않는다는 판단이다."];
    rows.push({
      schemaVersion: 2, id: "replay-" + String(index + 1).padStart(6, "0"),
      lane: "protocol",
      format: index >= 24 ? "revisit" : index % 2 === 0 ? "bite" : "withhold",
      subject, factIds: ["fact-1"], usedFactIds: ["fact-1"],
      claims: sentences.map((text, sentenceIndex) => ({
        kind: sentenceIndex === 0 ? "observation" : "judgment", text, factIds: ["fact-1"],
      })),
      facts: [{
        factId: "fact-1", subject,
        metric: { name: "tvl-change-24h", value: index + 1, raw, unit: "%", period: "24h" },
        source: { observedAt: "2026-08-01T01:00:00.000Z" },
      }],
      falsifier: { metric: "tvl", comparator: "lt", threshold: 99, deadline: "2026-08-04T01:00:00.000Z", unit: "USD" },
      textProvenance: "generated", reviewDisposition: "pending", wasEverEdited: false,
      draft: sentences.join(" "),
    });
  }
  const comparisons: BlindComparisonCaseV2[] = rows.map((row, index) => ({
    id: "source-" + (index + 1), replayRowId: row.id,
    baselineText: row.subject + "의 기존 문장이다. 숫자를 기록한다.",
  }));
  const binding: BlindReplayBindingV2 = {
    replay: {
      schemaVersion: 2, kind: "pixymon-v2-runtime-replay-export",
      lineage: {
        source: "editorial-event-ledger", sourceLedgerSha256: "b".repeat(64), sourceLedgerBytes: 10000,
        sourceEventCount: 36, sourceDraftCount: 36, collectionEpoch: EDITORIAL_COLLECTION_EPOCH_V2,
        epochDraftCount: 36, excludedDraftCount: 0, selectionPolicy: "first-created-in-epoch",
        requestedLimit: null, exportedDraftCount: 36,
      }, rows,
    },
    replayArtifactSha256: "a".repeat(64), verifiedCommit: "c".repeat(40),
  };
  return { comparisons, binding };
}

function packedFixture(seed = "test-seed") {
  const source = sourceFixture();
  return { ...source, ...buildBlindEvaluationPackV2(source.comparisons, seed, source.binding) };
}

function scores(value = 4): BlindScoresV2 {
  return Object.fromEntries(BLIND_SCORE_AXES_V2.map((axis) => [axis, value])) as BlindScoresV2;
}

function passingAnnotations(mapping: BlindEvaluationMappingV2): BlindEvaluationAnnotationV2[] {
  return mapping.pairs.flatMap((pair) => ["reader-1", "reader-2"].map((reviewerId) => ({
    packId: mapping.packId, pairId: pair.pairId, reviewerId,
    scores: { A: scores(), B: scores() }, preference: pair.v2Side,
    publishUnchanged: { A: pair.v2Side === "A", B: pair.v2Side === "B" },
    pixymonIdentified: { A: pair.v2Side === "A", B: pair.v2Side === "B" },
    hardVetoes: { A: [], B: [] }, reasonTags: { A: [], B: [] },
    reviewedAt: "2026-09-01T00:00:00.000Z",
  })));
}

test("blind pack derives V2 fields from replay and is deterministic and balanced", () => {
  const first = packedFixture();
  assert.deepEqual(buildBlindEvaluationPackV2(first.comparisons, "test-seed", first.binding), {
    pack: first.pack, mapping: first.mapping,
  });
  assert.equal(first.mapping.pairs.filter((pair) => pair.v2Side === "A").length, 18);
  assert.equal(first.mapping.pairs.filter((pair) => pair.format === "revisit").length, 12);
  for (const pair of first.mapping.pairs) {
    const source = first.binding.replay.rows.find((row) => row.id === pair.replayRowId)!;
    const publicPair = first.pack.pairs.find((row) => row.pairId === pair.pairId)!;
    assert.equal(publicPair[pair.v2Side].text, source.draft);
    assert.deepEqual(publicPair.evidence.metric, source.facts[0].metric);
    assert.equal(pair.lane, source.lane);
    assert.equal(pair.format, source.format);
  }
  for (const secret of ["baseline", "v2", "replayRowId", "sourceCaseId", "verifiedCommit", "v2Side"]) {
    assert.equal(JSON.stringify(first.pack).includes(secret), false, secret);
  }
});

test("blind outputs are create-only and private mapping is owner-readable", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-blind-pack-"));
  try {
    const result = packedFixture();
    const packPath = path.join(directory, "pack.json");
    const mappingPath = path.join(directory, "mapping.json");
    writeNewBlindEvaluationPackV2(packPath, mappingPath, result);
    if (process.platform !== "win32") assert.equal(fs.statSync(mappingPath).mode & 0o777, 0o600);
    assert.throws(() => writeNewBlindEvaluationPackV2(packPath, mappingPath, result), /already exist/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("blind pack rejects duplicate or unknown replay rows and unstratified sources", () => {
  const { comparisons, binding } = sourceFixture();
  const duplicated = structuredClone(comparisons);
  duplicated[1].replayRowId = duplicated[0].replayRowId;
  assert.throws(() => buildBlindEvaluationPackV2(duplicated, "seed", binding), /duplicate replay row/);
  duplicated[1].replayRowId = "missing";
  assert.throws(() => buildBlindEvaluationPackV2(duplicated, "seed", binding), /unknown replay row/);
  const oneLane = structuredClone(binding);
  oneLane.replay.rows[0].lane = "onchain";
  assert.throws(() => buildBlindEvaluationPackV2(comparisons, "seed", oneLane), /protocol-only/);
  const evolution = structuredClone(binding);
  evolution.replay.rows.forEach((row) => { if (row.format !== "revisit") row.format = "evolution"; });
  assert.throws(() => buildBlindEvaluationPackV2(comparisons, "seed", evolution), /requires 24 protocol originals/);
});

test("comparison input cannot override the V2 side or replay classifications", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-blind-input-"));
  try {
    const inputPath = path.join(directory, "cases.json");
    const { comparisons } = sourceFixture();
    fs.writeFileSync(inputPath, JSON.stringify(comparisons));
    assert.deepEqual(readBlindComparisonCasesV2(inputPath), comparisons);
    fs.writeFileSync(inputPath, JSON.stringify(comparisons.map((row) => ({ ...row, v2Text: "forged" }))));
    assert.throws(() => readBlindComparisonCasesV2(inputPath), /unsupported fields/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("blind aggregation requires two readers and adjudicates large disagreements", () => {
  const input = packedFixture();
  const annotations = passingAnnotations(input.mapping);
  const passed = aggregateBlindEvaluationV2({ ...input, annotations });
  assert.equal(passed.passed, true);
  assert.equal(passed.v2PreferenceRate, 1);
  assert.deepEqual(passed.lineage, input.mapping.lineage);
  assert.equal(aggregateBlindEvaluationV2({
    ...input, annotations: annotations.filter((row) => row.reviewerId === "reader-1"),
  }).complete, false);
  annotations[1].scores.A.grounding = 2;
  const pending = aggregateBlindEvaluationV2({ ...input, annotations });
  assert.ok(pending.incompleteReasons.includes("missing-adjudications:1"));
  const resolved = aggregateBlindEvaluationV2({
    ...input, annotations, adjudications: [{
      packId: input.pack.packId, pairId: annotations[0].pairId, side: "A", axis: "grounding",
      adjudicatorId: "adjudicator-1", resolvedScore: 4, reason: "근거 카드를 다시 대조했다.",
      adjudicatedAt: "2026-09-02T00:00:00.000Z",
    }],
  });
  assert.equal(resolved.passed, true);
});

test("blind aggregation fails vetoes, missing fields, identifying reviewers, and empty edits", () => {
  const input = packedFixture();
  const annotations = passingAnnotations(input.mapping);
  annotations[0].hardVetoes[input.mapping.pairs[0].v2Side] = ["unsupported-claim"];
  const report = aggregateBlindEvaluationV2({ ...input, annotations });
  assert.equal(report.complete, true);
  assert.equal(report.passed, false);
  assert.equal(report.hardVetoCount, 1);
  const missing = structuredClone(annotations);
  delete (missing[0] as Partial<BlindEvaluationAnnotationV2>).hardVetoes;
  assert.throws(() => aggregateBlindEvaluationV2({ ...input, annotations: missing }), /hardVetoes must be an object/);
  annotations[0].reviewerId = "alice@example.com";
  assert.throws(() => aggregateBlindEvaluationV2({ ...input, annotations }), /reader-1 or reader-2/);
  annotations[0].reviewerId = "reader-1";
  annotations[0].editedText = {};
  assert.throws(() => aggregateBlindEvaluationV2({ ...input, annotations }), /must contain A or B/);
});

test("blind aggregation rejects changed mapping, text, artifact, commit, and replay rows", () => {
  const input = packedFixture();
  const annotations = passingAnnotations(input.mapping);
  const flipped = structuredClone(input.mapping);
  flipped.pairs[0].v2Side = flipped.pairs[0].v2Side === "A" ? "B" : "A";
  assert.throws(() => aggregateBlindEvaluationV2({ ...input, mapping: flipped, annotations }), /mapping commitment is invalid/);
  const changedPack = structuredClone(input.pack);
  changedPack.pairs[0].A.text += " 변조";
  assert.throws(() => aggregateBlindEvaluationV2({ ...input, pack: changedPack, annotations }), /public pack digest mismatch/);
  for (const field of ["verifiedCommit", "replayArtifactSha256"] as const) {
    const binding = { ...input.binding, [field]: "d".repeat(field === "verifiedCommit" ? 40 : 64) };
    assert.throws(() => aggregateBlindEvaluationV2({ ...input, binding, annotations }), /replay lineage mismatch/);
  }
  const changedRow = structuredClone(input.binding);
  changedRow.replay.rows[0].lane = "ecosystem";
  assert.throws(() => aggregateBlindEvaluationV2({ ...input, binding: changedRow, annotations }), /row digest mismatch/);
});

test("edited annotations cannot inflate the unchanged publication rate", () => {
  const input = packedFixture();
  const annotations = passingAnnotations(input.mapping);
  const side = input.mapping.pairs[0].v2Side;
  annotations[0].editedText = { [side]: "독자가 수정한 문장이다." };
  assert.throws(() => aggregateBlindEvaluationV2({ ...input, annotations }), /cannot be publishUnchanged/);
  annotations[0].publishUnchanged[side] = false;
  assert.equal(aggregateBlindEvaluationV2({ ...input, annotations }).publishUnchangedRate, 71 / 72);
});
