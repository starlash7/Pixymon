import assert from "node:assert/strict";
import test from "node:test";
import { evaluateAutoPublishEligibilityV2 } from "../src/services/editorial-v2/critic.ts";

const passingCritic = {
  grounding: 4.5,
  clarity: 4.4,
  insight: 4.1,
  character: 4.2,
  memorability: 4.1,
  followWorthiness: 4.3,
  overall: 4.3,
  hardVetoes: [],
};

test("editorial V2 auto publish requires all evidence, critic, and calibration gates", () => {
  assert.deepEqual(
    evaluateAutoPublishEligibilityV2({
      tierA: true,
      providerGreen: true,
      usedFallback: false,
      hardGateReasons: [],
      critic: passingCritic,
      calibration: { reviewedCount: 30, noEditPrecision: 0.9, hardVetoCount: 0 },
    }),
    { eligible: true, reasons: [] }
  );
});
test("editorial V2 auto publish fails closed before human calibration", () => {
  const result = evaluateAutoPublishEligibilityV2({
    tierA: true,
    providerGreen: true,
    usedFallback: false,
    hardGateReasons: [],
    critic: passingCritic,
    calibration: { reviewedCount: 29, noEditPrecision: 1, hardVetoCount: 0 },
  });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes("calibration-under-30"));
});
