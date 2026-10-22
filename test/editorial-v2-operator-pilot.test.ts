import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { jevReviewCasesV2 } from "../eval/jev-review-cases.ts";
import { EDITORIAL_COLLECTION_EPOCH_V2 } from "../src/services/editorial-v2/contracts.ts";
import type { EditorialDraftStateV2 } from "../src/services/editorial-v2/event-store.ts";
import {
  assertOperatorPilotAuthorizationV2,
  evaluateOperatorPilotEvidenceV2,
  writeOperatorPilotAuthorizationV2,
} from "../src/services/editorial-v2/operator-pilot.ts";
import { assertApprovedLiveAuthorizationV2 } from "../src/services/editorial-v2/publication-policy.ts";

const NOW = new Date("2026-10-20T00:00:00.000Z");
const COMMIT = "a".repeat(40);

function reviewed(id: string, status: "approved" | "rejected", options: { edited?: boolean; tags?: string[] } = {}): EditorialDraftStateV2 {
  const state = structuredClone(jevReviewCasesV2()[0].state);
  state.draft.id = id;
  state.draft.trackingMode = "shadow";
  state.draft.collectionEpoch = EDITORIAL_COLLECTION_EPOCH_V2;
  const base = { schemaVersion: 2 as const, draftId: id, reviewerId: "operator", reviewedAt: NOW.toISOString() };
  state.reviews = [
    ...(options.edited ? [{ ...base, id: `${id}:edit`, action: "edit" as const, reasonTags: [], editedDraft: "x" }] : []),
    { ...base, id: `${id}:final`, action: status === "approved" ? "approve" as const : "reject" as const,
      reasonTags: options.tags ?? (status === "approved" ? ["fact-checked"] : ["정보봇같음"]) },
  ];
  state.reviewStatus = status;
  return state;
}

function earned(): EditorialDraftStateV2[] {
  return [
    ...Array.from({ length: 3 }, (_, index) => reviewed(`ok-${index}`, "approved")),
    reviewed("no-0", "rejected"),
  ];
}

test("pilot evidence needs 3 fact-checked approvals and no factual error", () => {
  assert.deepEqual(evaluateOperatorPilotEvidenceV2(earned()),
    { epoch: EDITORIAL_COLLECTION_EPOCH_V2, reviewed: 4, approvedFactChecked: 3, factualErrors: 0, passed: true, reasons: [] });
  assert.deepEqual(evaluateOperatorPilotEvidenceV2(earned().slice(1)).reasons, ["fact-checked approvals 2/3"]);
  // The operator may edit; an edited, fact-checked approval still counts.
  const edited = earned(); edited[0] = reviewed("ok-0", "approved", { edited: true });
  assert.equal(evaluateOperatorPilotEvidenceV2(edited).passed, true);
  const unchecked = earned(); unchecked[0] = reviewed("ok-0", "approved", { tags: ["픽시답다"] });
  assert.equal(evaluateOperatorPilotEvidenceV2(unchecked).passed, false);
  const wrong = earned(); wrong[3] = reviewed("no-0", "rejected", { tags: ["wrong-number"] });
  assert.deepEqual(evaluateOperatorPilotEvidenceV2(wrong).reasons, ["factual errors 1 (must be 0)"]);
});

test("pilot evidence ignores other epochs, live drafts and pending drafts", () => {
  const states = earned();
  states[0].draft.collectionEpoch = "character-writer-v5";
  states[1].draft.trackingMode = "live";
  (states[3] as { reviewStatus: string }).reviewStatus = "pending";
  assert.deepEqual(evaluateOperatorPilotEvidenceV2(states).reviewed, 1);
});

function dir(t: TestContext): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-pilot-"));
  t.after(() => fs.rmSync(value, { recursive: true, force: true }));
  return value;
}

test("a pilot authorization is only written when earned and is re-derived at dispatch", (t) => {
  const root = dir(t);
  const output = path.join(root, "auth.json");
  assert.throws(() => writeOperatorPilotAuthorizationV2({ shadowLedgerPath: "/ledger", outputPath: output, operatorId: "theo",
    commit: COMMIT, now: NOW, loadStates: () => earned().slice(1) }), /operator-pilot-not-earned: fact-checked approvals 2\/3/);
  assert.equal(fs.existsSync(output), false);
  writeOperatorPilotAuthorizationV2({ shadowLedgerPath: "/ledger", outputPath: output, operatorId: "theo", commit: COMMIT, now: NOW,
    loadStates: () => earned() });
  const record = JSON.parse(fs.readFileSync(output, "utf8"));
  const later = new Date(NOW.getTime() + 3_600_000);
  assertOperatorPilotAuthorizationV2(record, { commit: COMMIT, now: later, shadowLedgerPath: "/ledger", loadStates: () => earned() });
  // The recheck reads only the canonical ledger, never a path chosen at issuance.
  assert.throws(() => assertOperatorPilotAuthorizationV2(record, { commit: COMMIT, now: later, shadowLedgerPath: "/real-ledger",
    loadStates: () => earned() }), /invalid-or-expired/);
  assert.throws(() => assertOperatorPilotAuthorizationV2(record, { commit: COMMIT, now: new Date(Number.NaN), shadowLedgerPath: "/ledger",
    loadStates: () => earned() }), /invalid-or-expired/);
  const wrong = earned(); wrong[11] = reviewed("no-3", "rejected", { tags: ["factual-error"] });
  assert.throws(() => assertOperatorPilotAuthorizationV2(record, { commit: COMMIT, now: later, shadowLedgerPath: "/ledger", loadStates: () => wrong }),
    /operator-pilot-evidence-lost: factual errors 1/);
  assert.throws(() => assertOperatorPilotAuthorizationV2(record, { commit: "b".repeat(40), now: later, shadowLedgerPath: "/ledger", loadStates: () => earned() }),
    /invalid-or-expired/);
  assert.throws(() => assertOperatorPilotAuthorizationV2(record, { commit: COMMIT, now: new Date(NOW.getTime() + 25 * 3_600_000),
    shadowLedgerPath: "/ledger", loadStates: () => earned() }), /invalid-or-expired/);
});

test("the live boundary routes pilot authorizations but keeps STOP and clean-tree checks first", (t) => {
  const root = dir(t);
  const output = path.join(root, "auth.json");
  const stopPath = path.join(root, "STOP");
  writeOperatorPilotAuthorizationV2({ shadowLedgerPath: "/ledger", outputPath: output, operatorId: "theo", commit: COMMIT, now: NOW,
    loadStates: () => earned() });
  const check = (overrides: Partial<Parameters<typeof assertApprovedLiveAuthorizationV2>[0]>) => assertApprovedLiveAuthorizationV2({
    authorizationPath: output, stopPath, commit: COMMIT, workingTreeClean: true, now: NOW, shadowLedgerPath: "/ledger",
    loadShadowStates: () => earned(), ...overrides });
  check({});
  assert.throws(() => check({ workingTreeClean: false }), /editorial-live-tree-dirty/);
  fs.writeFileSync(stopPath, "");
  assert.throws(() => check({}), /editorial-live-suspended/);
});
