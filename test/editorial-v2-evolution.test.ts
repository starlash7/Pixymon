import assert from "node:assert/strict";
import test from "node:test";
import { jevReviewCasesV2 } from "../eval/jev-review-cases.ts";
import type { EditorialDraftStateV2, EditorialEventStoreV2 } from "../src/services/editorial-v2/event-store.ts";
import {
  buildEditorialEvolutionPlanV2,
  buildEditorialEvolutionPromptV2,
  selectEditorialEvolutionV2,
  type EditorialReflectionRecordV2,
} from "../src/services/editorial-v2/evolution.ts";
import { splitEditorialSentencesV2 } from "../src/services/editorial-v2/validator.ts";
import { writeEditorialEvolutionV2, type EditorialWriterModelV2 } from "../src/services/editorial-v2/writer.ts";
import { collectEditorialDraftV2 } from "../src/services/editorial-v2/workflow.ts";
import type { EditorialSensingResultV2 } from "../src/services/editorial-v2/provider-adapters.ts";

const NOW = "2026-10-08T12:00:00.000Z";

function closed(id: string, subject: string, resolvedAt: string, resolution: "supported" | "invalidated" | "unresolved",
  format: "bite" | "withhold" | "evolution" = "bite"): EditorialDraftStateV2 {
  const state = structuredClone(jevReviewCasesV2()[0].state);
  const factId = `${id}:fact`;
  state.draft.id = id;
  state.draft.subject = subject;
  state.draft.format = format;
  state.draft.trackingMode = "shadow";
  state.draft.createdAt = new Date(Date.parse(resolvedAt) - 72 * 3_600_000).toISOString();
  state.draft.factIds = [factId];
  state.draft.facts = [{ ...state.draft.facts[0], factId, subject }];
  state.draft.draft = `${subject} 장면을 찍어둠. 아직은 판단 보류.`;
  state.publishText = state.draft.draft;
  delete (state as { publication?: unknown }).publication;
  state.followUps = format === "evolution" ? [] : [{ schemaVersion: 2, id: `${id}:72h`, draftId: id, checkpoint: "72h",
    resolution, reason: resolution === "invalidated" ? "falsifier-matched" : "falsifier-not-matched", resolvedAt }];
  return state;
}

const STARGATE = closed("stargate-thought", "Stargate V2", "2026-10-08T09:00:00.000Z", "invalidated");
const USDD = closed("usdd-thought", "USDD", "2026-10-07T09:00:00.000Z", "supported");
const RECORDS = () => {
  const selected = selectEditorialEvolutionV2([STARGATE, USDD], NOW, "shadow");
  if (selected.status !== "planned") assert.fail(selected.reason);
  return selected.records;
};

test("reflection needs two closed, unreflected judgments from the same ledger", () => {
  const records = RECORDS();
  assert.deepEqual(records.map((record) => [record.subject, record.outcome.resolution, record.provenance]),
    [["Stargate V2", "invalidated", "shadow"], ["USDD", "supported", "shadow"]]);
  assert.deepEqual(selectEditorialEvolutionV2([STARGATE], NOW, "shadow"), { status: "blocked", reason: "evolution-insufficient-memory" });
  // Live reflections never read shadow rehearsal.
  assert.deepEqual(selectEditorialEvolutionV2([STARGATE, USDD], NOW, "live"), { status: "blocked", reason: "evolution-insufficient-memory" });
  // One record per subject.
  const again = closed("stargate-older", "Stargate V2", "2026-10-06T09:00:00.000Z", "supported");
  assert.deepEqual(selectEditorialEvolutionV2([STARGATE, again], NOW, "shadow"), { status: "blocked", reason: "evolution-insufficient-memory" });
  // A 24h check is not a closed judgment.
  const open = closed("open", "Aave", "2026-10-08T08:00:00.000Z", "supported");
  open.followUps = [{ ...open.followUps[0], checkpoint: "24h" }];
  assert.deepEqual(selectEditorialEvolutionV2([STARGATE, open], NOW, "shadow"), { status: "blocked", reason: "evolution-insufficient-memory" });
});

test("reflection has a cooldown and never revisits the same judgments", () => {
  const recent = closed("reflection-recent", "Stargate V2", NOW, "supported", "evolution");
  recent.draft.createdAt = "2026-10-08T00:00:00.000Z";
  assert.deepEqual(selectEditorialEvolutionV2([STARGATE, USDD, recent], NOW, "shadow"), { status: "blocked", reason: "evolution-cooldown" });
  const older = closed("reflection-older", "Stargate V2", NOW, "supported", "evolution");
  older.draft.createdAt = "2026-10-06T00:00:00.000Z";
  older.draft.factIds = [STARGATE.draft.factIds[0], USDD.draft.factIds[0]];
  assert.deepEqual(selectEditorialEvolutionV2([STARGATE, USDD, older], NOW, "shadow"), { status: "blocked", reason: "evolution-insufficient-memory" });
});

test("a reflection plan carries the remembered facts and is never re-measured", () => {
  const plan = buildEditorialEvolutionPlanV2(RECORDS(), NOW, "protocol");
  assert.equal(plan.format, "evolution");
  assert.equal(plan.rendering, "thought");
  assert.equal(plan.verdict, "corrected");
  assert.equal(plan.voiceState, "humbled");
  assert.deepEqual(plan.factIds, ["stargate-thought:fact", "usdd-thought:fact"]);
  const prompt = buildEditorialEvolutionPromptV2(plan, RECORDS(), []);
  assert.match(prompt, /Stargate V2[\s\S]*그때 픽시 생각이 틀린 쪽이었음/);
  assert.match(prompt, /USDD[\s\S]*그때 픽시 생각이 맞는 쪽이었음/);
  assert.match(prompt, /움직임 자체를 판정하지 않는다/);
  assert.match(prompt, /실제로 올렸던 글처럼 말하지 않는다/);
});

function payload(draft: string, records: readonly EditorialReflectionRecordV2[]) {
  const factIds = records.map((record) => record.fact.factId);
  return JSON.stringify({ draft, usedFactIds: factIds, claims: splitEditorialSentencesV2(draft).map((text, index) => ({
    kind: index === 0 ? "observation" : "judgment", text, factIds })) });
}

const REFLECTION = "Stargate가 홀쭉해졌을 때 일시적일 거라 넘겼는데 사흘 뒤 그 판단은 깨졌음. USDD 쪽은 버텼고. 조용히 빠지는 장면을 가볍게 보던 버릇부터 고쳐야겠음.";

test("a grounded reflection is written and checked against the records", async () => {
  const records = RECORDS();
  const criticPrompts: string[] = [];
  const critic: EditorialWriterModelV2 = { modelId: "critic", async generate({ prompt }) {
    criticPrompts.push(prompt); return JSON.stringify({ verdict: "pass", claim: "", problem: "" }); } };
  const result = await writeEditorialEvolutionV2({ plan: buildEditorialEvolutionPlanV2(records, NOW, "protocol"), records,
    scopeCritic: critic, model: { async generate() { return payload(REFLECTION, records); } } });
  assert.equal(result.status, "generated", JSON.stringify(result));
  assert.match(criticPrompts[0], /지난 판단 기록과 다른 주장/);
  assert.match(criticPrompts[0], /틀린 쪽이었음/);
});

test("a reflection cannot invent numbers or other protocols", async () => {
  const records = RECORDS();
  const plan = buildEditorialEvolutionPlanV2(records, NOW, "protocol");
  for (const [text, reason] of [
    ["Stargate가 홀쭉해졌을 때 넘겼는데 그 판단은 깨졌음. 세 번 중 2번은 틀렸으니 버릇을 고쳐야겠음.", "unsupported-number"],
    ["Stargate랑 Aave를 넘겼는데 그 판단은 깨졌음. 조용히 빠지는 장면을 가볍게 보던 버릇부터 고쳐야겠음.", "unsupported-name"],
  ] as const) {
    const result = await writeEditorialEvolutionV2({ plan, records, model: { async generate() { return payload(text, records); } } });
    assert.equal(result.status, "blocked");
    if (result.status === "blocked") assert.ok(result.validationReasons.includes(reason), `${reason}: ${result.validationReasons.join(",")}`);
  }
});

test("collection reflects on memory when nothing new is eligible, only when enabled", async (t) => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-evolution-collect-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const created: unknown[] = [];
  const store = { listDraftStates: () => [STARGATE, USDD], recordFollowUpResolution: () => undefined,
    createDraft: (input: Record<string, unknown>) => { created.push(input); return { ...input, schemaVersion: 2 }; },
  } as unknown as EditorialEventStoreV2;
  const sensing: EditorialSensingResultV2 = { evidence: [], observations: [], discoveries: [], providers: [] };
  const writerModel: EditorialWriterModelV2 = { async generate() { return payload(REFLECTION, RECORDS()); } };
  const inquiryModel: EditorialWriterModelV2 = { async generate() { throw new Error("no inquiry for reflections"); } };
  const base = { store, writerModel, inquiryModel, sensing, mode: "observe" as const, trackingMode: "shadow" as const,
    metricLogPath: path.join(dir, "metrics.ndjson"), now: new Date(NOW) };
  const silent = await collectEditorialDraftV2({ ...base, actionId: "quiet" });
  assert.equal(silent.status, "no-post");
  assert.equal(created.length, 0);
  const reflected = await collectEditorialDraftV2({ ...base, actionId: "reflection", memoryReflection: true });
  assert.equal(reflected.status, "drafted", JSON.stringify(reflected));
  const draft = created[0] as { format: string; facts: unknown[]; rendering: string; subject: string };
  assert.equal(draft.format, "evolution");
  assert.equal(draft.rendering, "thought");
  assert.equal(draft.facts.length, 2);
});

test("a reflection draft is accepted by the real ledger and survives review re-validation", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { EditorialEventStoreV2 } = await import("../src/services/editorial-v2/event-store.ts");
  const { editorialDraftValidationInputV2, validateEditorialDraftV2 } = await import("../src/services/editorial-v2/validator.ts");
  const { EDITORIAL_COLLECTION_EPOCH_V2 } = await import("../src/services/editorial-v2/contracts.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-evolution-"));
  try {
    const store = new EditorialEventStoreV2({ eventLogPath: path.join(dir, "events.ndjson"), now: () => new Date(NOW) });
    const records = RECORDS();
    const plan = buildEditorialEvolutionPlanV2(records, NOW, "protocol");
    const parsed = JSON.parse(payload(REFLECTION, records));
    const draft = store.createDraft({ id: "reflection-1", runId: "run-1", createdAt: NOW, trackingMode: "shadow", lane: "protocol",
      collectionEpoch: EDITORIAL_COLLECTION_EPOCH_V2, rendering: "thought", format: "evolution", subject: plan.subject,
      thesis: plan.thesis, factIds: plan.factIds, facts: records.map((record) => record.fact), verdict: plan.verdict,
      falsifier: plan.falsifier, followUpSchedule: plan.followUpAt, voiceState: plan.voiceState, draft: REFLECTION,
      generatedPayload: parsed });
    const state = store.getDraftState(draft.id)!;
    assert.equal(state.draft.format, "evolution");
    const validation = validateEditorialDraftV2(editorialDraftValidationInputV2({
      text: state.publishText, subject: state.draft.subject, fact: state.draft.facts[0], extraFacts: state.draft.facts.slice(1),
      format: state.draft.format, factIds: state.draft.factIds, usedFactIds: state.draft.factIds, rendering: state.draft.rendering }));
    assert.deepEqual(validation.reasons, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
