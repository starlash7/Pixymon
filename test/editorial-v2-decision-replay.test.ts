import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { planEditorialV2 } from "../src/services/editorial-v2/planner.ts";
import { readEditorialDecisionContextV2, replayEditorialDecisionV2, writeEditorialDecisionContextV2, type EditorialDecisionContextV2 } from "../src/services/editorial-v2/decision-replay.ts";

test("decision replay captures no-post inputs, preserves clock/seed, and rejects overwritten input", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-decision-replay-"));
  try {
    const planningInput = { evidence: [], now: "2026-09-05T00:00:00.000Z", selectionSeed: "fixed-seed" };
    const context: EditorialDecisionContextV2 = {
      kind: "pixymon-decision-context", version: 1, actionId: "no-facts", trackingMode: "shadow",
      revision: { commit: "a".repeat(40), dirty: false }, modelId: "test", writerVersion: "hypothesis-writer-v2",
      planningInput, memories: {}, capturedPlanning: planEditorialV2(planningInput),
    };
    const file = writeEditorialDecisionContextV2(dir, context);
    assert.throws(() => writeEditorialDecisionContextV2(dir, context), /EEXIST/);
    const loaded = readEditorialDecisionContextV2(file);
    assert.deepEqual(loaded, context);
    let modelCalls = 0;
    const model = { async generate() { modelCalls += 1; return null; } };
    const baseline = await replayEditorialDecisionV2({ context: loaded, model, variant: "captured-plan" });
    for (let index = 0; index < 100; index++) {
      assert.deepEqual(await replayEditorialDecisionV2({ context: loaded, model, variant: "current-plan" }), baseline);
    }
    assert.equal(modelCalls, 0);
    const modified = JSON.parse(fs.readFileSync(file, "utf8"));
    modified.context.planningInput.selectionSeed = "changed";
    fs.writeFileSync(file, JSON.stringify(modified));
    assert.throws(() => readEditorialDecisionContextV2(file), /digest/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
