import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { EditorialMetricV2 } from "../src/services/editorial-v2/telemetry.ts";
import { EditorialEventStoreV2 } from "../src/services/editorial-v2/event-store.ts";
import {
  createFollowUpScheduleV2,
  createMachineFalsifierV2,
} from "../src/services/editorial-v2/follow-ups.ts";
import {
  buildEditorialRolloutStatusV2,
  readEditorialMetricsForRolloutV2,
  type RolloutMachineEvidenceV2,
} from "../src/services/editorial-v2/rollout-status.ts";
import { formatEvidenceSourceTimeV2 } from "../src/services/editorial-v2/validator.ts";
import { isEditorialVerificationInputV2 } from "../scripts/editorial-repository-state.ts";
import { EDITORIAL_COLLECTION_EPOCH_V2 } from "../src/services/editorial-v2/contracts.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const BASE_MS = Date.parse("2026-08-01T00:00:00.000Z");

function metric(
  type: EditorialMetricV2["type"],
  actionId: string,
  timestamp: string,
  outcome: string,
  details?: EditorialMetricV2["details"]
): EditorialMetricV2 {
  return {
    schemaVersion: 2,
    type,
    timestamp,
    runId: `run-${actionId}`,
    actionId,
    mode: "observe",
    stage: "test",
    outcome,
    details,
  };
}

function draftInput(id: string, timestamp: string) {
  const schedule = createFollowUpScheduleV2(timestamp);
  const subject = "테스트프로토콜";
  const factId = `fact-${id}`;
  const sentences = [
    `${subject}의 TVL은 ${formatEvidenceSourceTimeV2(timestamp)} 기준 +3.0%다.`,
    "이 움직임 하나만으로 반복성까지 단정할 근거는 아직 부족하다.",
    "픽시몬의 현재 판정은 구조 변화 승인 보류다.",
  ];
  const draft = sentences.join(" ");
  return {
    id,
    runId: `run-${id}`,
    createdAt: timestamp,
    lane: "protocol" as const,
    collectionEpoch: EDITORIAL_COLLECTION_EPOCH_V2,
    format: "bite" as const,
    subject,
    thesis: "원시 수치만 판정한다.",
    factIds: [factId],
    facts: [{
      factId,
      subject,
      metric: { name: "tvl-change-24h", value: 3, raw: "+3.0%", unit: "%", period: "24h" },
      source: {
        provider: "defillama",
        url: `https://defillama.com/protocol/${id}`,
        publishedAt: null,
        observedAt: timestamp,
      },
    }],
    verdict: "한 번의 변화를 추세로 부르지 않는다.",
    falsifier: createMachineFalsifierV2(
      { metric: "tvl", comparator: "lt" as const, threshold: 90, unit: "USD" },
      schedule
    ),
    followUpSchedule: schedule,
    voiceState: "skeptical" as const,
    draft,
    generatedPayload: {
      draft,
      usedFactIds: [factId],
      claims: sentences.map((text, index) => ({
        kind: index === 0 ? "observation" as const : "judgment" as const,
        text,
        factIds: [factId],
      })),
    },
  };
}

function operationalFixture(input: {
  count?: number;
  dayForIndex?: (index: number) => number;
  tagsForIndex?: (index: number) => string[];
  editIndexes?: ReadonlySet<number>;
  reviewedAtForIndex?: (index: number) => string | undefined;
  invalidDraftIndexes?: ReadonlySet<number>;
}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-rollout-status-"));
  const eventLogPath = path.join(directory, "events.ndjson");
  let current = new Date(BASE_MS);
  let sequence = 0;
  const store = new EditorialEventStoreV2({
    eventLogPath,
    now: () => new Date(current),
    idFactory: (kind) => `${kind}-${++sequence}`,
  });
  const metrics: EditorialMetricV2[] = [];
  const count = input.count ?? 30;
  for (let index = 0; index < count; index += 1) {
    current = new Date(BASE_MS + (input.dayForIndex?.(index) ?? Math.floor(index / 2)) * DAY_MS);
    const timestamp = current.toISOString();
    const id = `draft-${index}`;
    const candidate = draftInput(id, timestamp);
    if (input.invalidDraftIndexes?.has(index)) {
      const invalidDraft = `${candidate.subject}은 +3.0%다.`;
      store.createDraft({
        ...candidate,
        draft: invalidDraft,
        generatedPayload: {
          draft: invalidDraft,
          usedFactIds: [...candidate.factIds],
          claims: [{ kind: "observation", text: invalidDraft, factIds: [...candidate.factIds] }],
        },
      });
    } else {
      store.createDraft(candidate);
    }
    metrics.push(metric("planning_decision", id, timestamp, "planned"));
    metrics.push(metric("generation_attempt", id, timestamp, "drafted", { draftId: id, fallbackUsed: false }));
    if (input.editIndexes?.has(index)) {
      store.edit(id, {
        reviewerId: "operator",
        reasonTags: ["clarity"],
        editedDraft: `${draftInput(id, timestamp).draft} 다듬었다.`,
      });
    }
    const tags = input.tagsForIndex?.(index) ?? ["fact-checked", "language-checked"];
    store.approve(id, {
      reviewerId: "operator",
      reasonTags: tags,
      reviewedAt: input.reviewedAtForIndex?.(index),
    });
    metrics.push(metric("review_decision", id, timestamp, "approve", { draftId: id }));
  }
  return { directory, events: store.readEvents(), metrics };
}

function writeAudit(startDay: number, endDay: number): RolloutMachineEvidenceV2 {
  return {
    schemaVersion: 2,
    kind: "pixymon-v2-rollout-evidence",
    nonLiveWriteAudit: {
      passed: true,
      writeCount: 0,
      windowStartedAt: new Date(BASE_MS + startDay * DAY_MS).toISOString(),
      windowEndedAt: new Date(BASE_MS + endDay * DAY_MS).toISOString(),
      source: "dispatcher-audit",
    },
  };
}

test("status reports elapsed evidence but does not trust free-form zero-write metadata", () => {
  const fixture = operationalFixture({});
  try {
    const status = buildEditorialRolloutStatusV2({
      events: fixture.events,
      metrics: fixture.metrics,
      eventLogPresent: true,
      metricLogPresent: true,
      machineEvidence: writeAudit(0, 15),
      now: new Date(BASE_MS + 20 * DAY_MS),
    });
    assert.equal(status.gates.r1.earned, false);
    assert.equal(
      status.gates.r1.checks.find((check) => check.id === "non-live-write-audit")?.state,
      "unknown"
    );
    assert.equal(status.gates.r2.earned, false);
    assert.equal(
      status.gates.r2.checks.find((check) => check.id === "final-approved-contract")?.state,
      "pass"
    );
    assert.equal(
      status.gates.r2.checks.find((check) => check.id === "r1-promotion-boundary")?.state,
      "unknown"
    );
    assert.equal(status.counts.observeDecisions, 30);
    assert.equal(status.windows.observeDecisionDays, 15);
    assert.equal(status.windows.reviewDays, 15);
    assert.equal(status.rates.noEditAcceptanceRate, 1);
    assert.equal(status.highestEvidenceStage, "none", "missing R0 must prevent a promotion claim");
    assert.equal(status.manualPromotionRequired, true);
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("status accepts only a live GitHub result bound to current HEAD for network isolation", () => {
  const currentCommit = "0123456789abcdef0123456789abcdef01234567";
  const githubNetworkIsolation = {
    state: "pass" as const,
    repository: "starlash7/Pixymon",
    headSha: currentCommit,
    workflowPath: ".github/workflows/verify.yml" as const,
    reason: "verified-github-push-main-workflow",
    runId: 101,
    runAttempt: 2,
    jobId: 202,
    completedAt: "2026-09-04T02:00:00.000Z",
  };
  const status = buildEditorialRolloutStatusV2({
    events: [],
    metrics: [],
    eventLogPresent: false,
    metricLogPresent: false,
    currentCommit,
    workingTreeClean: true,
    githubNetworkIsolation,
    now: new Date("2026-09-04T03:00:00.000Z"),
  });
  assert.equal(
    status.gates.r0.checks.find((check) => check.id === "network-isolation")?.state,
    "pass"
  );

  const mismatched = buildEditorialRolloutStatusV2({
    events: [],
    metrics: [],
    eventLogPresent: false,
    metricLogPresent: false,
    currentCommit: "ffffffffffffffffffffffffffffffffffffffff",
    workingTreeClean: true,
    githubNetworkIsolation,
    now: new Date("2026-09-04T03:00:00.000Z"),
  });
  assert.equal(
    mismatched.gates.r0.checks.find((check) => check.id === "network-isolation")?.state,
    "fail"
  );
});

test("calendar-date coverage cannot substitute for seven or fourteen full elapsed days", () => {
  const fixture = operationalFixture({ dayForIndex: (index) => index % 7 });
  try {
    const status = buildEditorialRolloutStatusV2({
      events: fixture.events,
      metrics: fixture.metrics,
      eventLogPresent: true,
      metricLogPresent: true,
      machineEvidence: writeAudit(0, 7),
      now: new Date(BASE_MS + 20 * DAY_MS),
    });
    assert.equal(status.windows.observeDecisionDays, 7);
    assert.equal(
      status.gates.r1.checks.find((check) => check.id === "observe-elapsed-time")?.state,
      "fail"
    );
    assert.equal(status.gates.r1.earned, false);
    assert.equal(status.gates.r2.earned, false);
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("R1 and R2 evidence starts at the recorded R0 verification time", () => {
  const fixture = operationalFixture({});
  try {
    const status = buildEditorialRolloutStatusV2({
      events: fixture.events,
      metrics: fixture.metrics,
      eventLogPresent: true,
      metricLogPresent: true,
      now: new Date(BASE_MS + 30 * DAY_MS),
      machineEvidence: {
        schemaVersion: 2,
        kind: "pixymon-v2-rollout-evidence",
        offlineVerify: {
          passed: true,
          offlineContractMode: true,
          completedAt: new Date(BASE_MS + 16 * DAY_MS).toISOString(),
          commit: "head",
          pipelineDeterminismScope: "synthetic-contract",
          pipelineDeterminismPassed: true,
          pipelineDeterminismRuns: 100,
        },
      },
    });
    assert.equal(status.counts.observeDecisions, 0);
    assert.equal(status.counts.reviewedDrafts, 0);
    assert.equal(status.gates.r1.earned, false);
    assert.equal(status.gates.r2.earned, false);
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("review windows use append-only event time, not caller-controlled reviewedAt", () => {
  const fixture = operationalFixture({
    dayForIndex: () => 0,
    reviewedAtForIndex: (index) => new Date(BASE_MS - index * DAY_MS).toISOString(),
  });
  try {
    const status = buildEditorialRolloutStatusV2({
      events: fixture.events,
      metrics: fixture.metrics,
      eventLogPresent: true,
      metricLogPresent: true,
      now: new Date(BASE_MS + DAY_MS),
    });
    assert.equal(status.windows.reviewDays, 1);
    assert.equal(status.gates.r2.checks.find((check) => check.id === "review-elapsed-time")?.state, "fail");
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("R2 never infers zero errors from empty tags and counts edits per unique draft", () => {
  const fixture = operationalFixture({
    editIndexes: new Set([0]),
    tagsForIndex: (index) => index === 1 ? [] : ["fact-checked", "language-checked"],
  });
  try {
    const status = buildEditorialRolloutStatusV2({
      events: fixture.events,
      metrics: fixture.metrics,
      eventLogPresent: true,
      metricLogPresent: true,
      now: new Date(BASE_MS + 20 * DAY_MS),
    });
    assert.equal(status.counts.editedDrafts, 1);
    assert.equal(status.counts.noEditApprovedDrafts, 29);
    assert.equal(status.rates.noEditAcceptanceRate, 29 / 30);
    assert.equal(status.gates.r2.checks.find((check) => check.id === "fact-check-coverage")?.state, "unknown");
    assert.equal(status.gates.r2.checks.find((check) => check.id === "factual-errors")?.state, "unknown");
    assert.equal(status.gates.r2.checks.find((check) => check.id === "language-check-coverage")?.state, "unknown");
    assert.equal(status.gates.r2.earned, false);
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("observed factual, malformed, fallback, and non-live write incidents fail closed", () => {
  const fixture = operationalFixture({
    tagsForIndex: (index) => index === 0
      ? ["fact-checked", "language-checked", "factual-error", "malformed-korean"]
      : ["fact-checked", "language-checked"],
  });
  try {
    fixture.metrics.push(metric("generation_attempt", "blocked", new Date(BASE_MS).toISOString(), "drafted", { fallbackUsed: true }));
    fixture.metrics.push({
      ...metric("dispatch_decision", "write", new Date(BASE_MS).toISOString(), "published", { externalPostId: "x-1" }),
      mode: "paper",
    });
    const status = buildEditorialRolloutStatusV2({
      events: fixture.events,
      metrics: fixture.metrics,
      eventLogPresent: true,
      metricLogPresent: true,
      machineEvidence: writeAudit(0, 15),
      now: new Date(BASE_MS + 20 * DAY_MS),
    });
    assert.equal(status.counts.observedFactualErrors, 1);
    assert.equal(status.counts.observedMalformedErrors, 1);
    assert.equal(status.counts.observedFallbackIncidents, 1);
    assert.equal(status.counts.observedNonLiveWriteIncidents, 1);
    assert.equal(status.gates.r1.earned, false);
    assert.equal(status.gates.r2.earned, false);
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("missing fallbackUsed telemetry stays unknown instead of proving no fallback", () => {
  const fixture = operationalFixture({});
  try {
    const generation = fixture.metrics.find((row) => row.type === "generation_attempt")!;
    generation.details = { draftId: String(generation.details?.draftId) };
    const status = buildEditorialRolloutStatusV2({
      events: fixture.events,
      metrics: fixture.metrics,
      eventLogPresent: true,
      metricLogPresent: true,
      now: new Date(BASE_MS + 20 * DAY_MS),
    });
    assert.equal(status.dataIntegrity.generationAttemptWithoutFallbackFlagCount, 1);
    assert.equal(
      status.gates.r2.checks.find((check) => check.id === "fallback-telemetry-complete")?.state,
      "unknown"
    );
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("R2 revalidates every approved final copy instead of trusting review tags", () => {
  const fixture = operationalFixture({ invalidDraftIndexes: new Set([0]) });
  try {
    const status = buildEditorialRolloutStatusV2({
      events: fixture.events,
      metrics: fixture.metrics,
      eventLogPresent: true,
      metricLogPresent: true,
      now: new Date(BASE_MS + 20 * DAY_MS),
    });
    assert.equal(status.dataIntegrity.finalApprovedContractFailureCount, 1);
    assert.equal(
      status.gates.r2.checks.find((check) => check.id === "final-approved-contract")?.state,
      "fail"
    );
    assert.equal(status.gates.r2.earned, false);
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("R0 rejects future or stale-tree verification evidence and labels corpus reload separately", () => {
  const future = new Date(BASE_MS + 2 * DAY_MS).toISOString();
  const status = buildEditorialRolloutStatusV2({
    events: [],
    metrics: [],
    eventLogPresent: true,
    metricLogPresent: true,
    now: new Date(BASE_MS + DAY_MS),
    currentCommit: "head-commit",
    workingTreeClean: true,
    machineEvidence: {
      schemaVersion: 2,
      kind: "pixymon-v2-rollout-evidence",
      offlineVerify: {
        passed: true,
        offlineContractMode: true,
        completedAt: future,
        commit: "old-commit",
        pipelineDeterminismScope: "synthetic-contract",
        pipelineDeterminismPassed: true,
        pipelineDeterminismRuns: 100,
      },
      realReplay: {
        passed: true,
        candidateCount: 100,
        evaluatedAt: future,
        artifactKind: "pixymon-v2-runtime-replay-export",
        artifactSha256: "a".repeat(64),
        sourceLedgerSha256: "b".repeat(64),
        sourceLedgerBytes: 123,
        sourceEventCount: 100,
        sourceDraftCount: 100,
        collectionEpoch: EDITORIAL_COLLECTION_EPOCH_V2,
        epochDraftCount: 100,
        excludedDraftCount: 0,
        selectionPolicy: "first-created-in-epoch",
        textProvenance: "generated",
        corpusReloadDeterminismPassed: true,
        corpusReloadDeterminismRuns: 100,
      },
    },
  });
  assert.equal(status.gates.r0.checks.find((check) => check.id === "verified-current-tree")?.state, "fail");
  assert.equal(status.gates.r0.checks.find((check) => check.id === "evidence-not-from-future")?.state, "fail");
  assert.equal(status.gates.r0.checks.find((check) => check.id === "pipeline-determinism")?.state, "pass");
  assert.equal(status.gates.r0.checks.find((check) => check.id === "corpus-reload-determinism")?.state, "pass");
  assert.equal(status.gates.r0.earned, false);
});

test("R0 verifies replay digests but never promotes free-form audit metadata", () => {
  const digest = "a".repeat(64);
  const ledgerDigest = "b".repeat(64);
  const machineEvidence: RolloutMachineEvidenceV2 = {
    schemaVersion: 2,
    kind: "pixymon-v2-rollout-evidence",
    offlineVerify: {
      passed: true,
      offlineContractMode: true,
      completedAt: new Date(BASE_MS).toISOString(),
      commit: "head-commit",
      pipelineDeterminismScope: "synthetic-contract",
      pipelineDeterminismPassed: true,
      pipelineDeterminismRuns: 100,
    },
    realReplay: {
      passed: true,
      candidateCount: 100,
      evaluatedAt: new Date(BASE_MS).toISOString(),
      artifactKind: "pixymon-v2-runtime-replay-export",
      artifactSha256: digest,
      sourceLedgerSha256: ledgerDigest,
      sourceLedgerBytes: 1000,
      sourceEventCount: 100,
      sourceDraftCount: 100,
      collectionEpoch: EDITORIAL_COLLECTION_EPOCH_V2,
      epochDraftCount: 100,
      excludedDraftCount: 0,
      selectionPolicy: "first-created-in-epoch",
      textProvenance: "generated",
      corpusReloadDeterminismPassed: true,
      corpusReloadDeterminismRuns: 100,
    },
    networkIsolationAudit: {
      passed: true,
      verifiedAt: new Date(BASE_MS).toISOString(),
      source: "hand-written-metadata",
    },
  };
  const status = buildEditorialRolloutStatusV2({
    events: [],
    metrics: [],
    eventLogPresent: true,
    metricLogPresent: true,
    now: new Date(BASE_MS + DAY_MS),
    currentCommit: "head-commit",
    workingTreeClean: true,
    machineEvidence,
    replayArtifactVerification: {
      artifactSha256: digest,
      sourceLedgerSha256: ledgerDigest,
      collectionEpoch: EDITORIAL_COLLECTION_EPOCH_V2,
      verified: true,
    },
  });
  assert.equal(status.gates.r0.checks.find((check) => check.id === "replay-lineage")?.state, "pass");
  assert.equal(status.gates.r0.checks.find((check) => check.id === "network-isolation")?.state, "unknown");
  assert.equal(
    status.gates.r0.checks.find((check) => check.id === "human-evaluation-lineage")?.state,
    "unknown"
  );
  assert.equal(status.gates.r0.earned, false);
});

test("missing logs and missing write audit remain unknown instead of proving zero writes", () => {
  const status = buildEditorialRolloutStatusV2({
    events: [],
    metrics: [],
    eventLogPresent: false,
    metricLogPresent: false,
    now: new Date(BASE_MS),
  });
  assert.equal(status.gates.r1.checks.find((check) => check.id === "runtime-logs")?.state, "unknown");
  assert.equal(status.gates.r1.checks.find((check) => check.id === "non-live-write-audit")?.state, "unknown");
  assert.equal(status.gates.r1.earned, false);
});

test("metric reader rejects corrupt lines rather than truncating operational evidence", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-rollout-metrics-"));
  try {
    const target = path.join(directory, "metrics.ndjson");
    fs.writeFileSync(target, `${JSON.stringify(metric("planning_decision", "a", new Date(BASE_MS).toISOString(), "planned"))}\n{bad\n`);
    assert.throws(() => readEditorialMetricsForRolloutV2(target), /line 2/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("R0 tree check ignores unrelated local shell helpers but includes verification code", () => {
  assert.equal(isEditorialVerificationInputV2("scripts/run-pixymon-local.sh"), false);
  assert.equal(isEditorialVerificationInputV2(".preflight-backup/config.json"), false);
  assert.equal(isEditorialVerificationInputV2("scripts/editorial-r0-record.ts"), true);
  assert.equal(isEditorialVerificationInputV2("src/services/editorial-v2/writer.ts"), true);
  assert.equal(isEditorialVerificationInputV2("test/editorial-v2-writer.test.ts"), true);
  assert.equal(isEditorialVerificationInputV2("package.json"), true);
  assert.equal(isEditorialVerificationInputV2(".github/workflows/verify.yml"), true);
});

test("R2 credits only drafts and reviews recorded after the verified manual boundary", () => {
  const fixture = operationalFixture({});
  try {
    const currentCommit = "c".repeat(40);
    const input = {
      events: fixture.events, metrics: fixture.metrics,
      eventLogPresent: true, metricLogPresent: true,
      now: new Date(BASE_MS + 30 * DAY_MS), currentCommit, workingTreeClean: true,
      r1Promotion: {
        boundaryAt: new Date(BASE_MS + 8 * DAY_MS).toISOString(), currentCommit,
        sourceStatusSha256: "a".repeat(64),
        statusGeneratedAt: new Date(BASE_MS + 7 * DAY_MS).toISOString(),
        observeWindow: { decisionCount: 30, distinctDays: 8, firstAt: new Date(BASE_MS).toISOString(), lastAt: new Date(BASE_MS + 7 * DAY_MS).toISOString(), elapsedMs: 7 * DAY_MS },
      },
    };
    const status = buildEditorialRolloutStatusV2(input);
    assert.equal(status.gates.r2.checks.find((check) => check.id === "r1-promotion-boundary")?.state, "pass");
    assert.equal(status.counts.reviewedDrafts, 14);
    assert.equal(status.windows.reviewDays, 7);
    assert.equal(status.gates.r2.earned, false);
    const changedCommit = buildEditorialRolloutStatusV2({ ...input, currentCommit: "d".repeat(40) });
    assert.equal(changedCommit.counts.reviewedDrafts, 0);
    assert.equal(changedCommit.gates.r2.checks.find((check) => check.id === "r1-promotion-boundary")?.state, "fail");
  } finally { fs.rmSync(fixture.directory, { recursive: true, force: true }); }
});

test("human promotion lineage must match the replay, epoch, verification commit, and clean tree", () => {
  const currentCommit = "c".repeat(40);
  const artifactSha256 = "a".repeat(64);
  const sourceLedgerSha256 = "b".repeat(64);
  const machineEvidence: RolloutMachineEvidenceV2 = {
    schemaVersion: 2, kind: "pixymon-v2-rollout-evidence",
    offlineVerify: { passed: true, offlineContractMode: true, completedAt: new Date(BASE_MS).toISOString(), commit: currentCommit, pipelineDeterminismScope: "synthetic-contract", pipelineDeterminismPassed: true, pipelineDeterminismRuns: 100 },
    realReplay: { passed: true, candidateCount: 100, evaluatedAt: new Date(BASE_MS).toISOString(), artifactKind: "pixymon-v2-runtime-replay-export", artifactSha256, sourceLedgerSha256, sourceLedgerBytes: 1000, sourceEventCount: 100, sourceDraftCount: 100, collectionEpoch: EDITORIAL_COLLECTION_EPOCH_V2, epochDraftCount: 100, excludedDraftCount: 0, selectionPolicy: "first-created-in-epoch", textProvenance: "generated", corpusReloadDeterminismPassed: true, corpusReloadDeterminismRuns: 100 },
  };
  const humanEvaluation = {
    schemaVersion: 2 as const, kind: "pixymon-v2-blind-report" as const, packId: "blind-test",
    lineage: { verifiedCommit: currentCommit, replayArtifactSha256: artifactSha256, sourceLedgerSha256, collectionEpoch: EDITORIAL_COLLECTION_EPOCH_V2 },
    complete: true, passed: true, pairCount: 36, reviewerCount: 2, annotationCount: 72,
    requiredAdjudicationCount: 0, completedAdjudicationCount: 0,
    means: { grounding: 4, clarity: 4, insight: 4, character: 4, memorability: 4, followWorthiness: 4, overall: 4 },
    v2PreferenceRate: 1, publishUnchangedRate: 1, pixymonIdentificationRate: 1, hardVetoCount: 0,
    incompleteReasons: [], gateFailures: [],
  };
  const input = { events: [], metrics: [], eventLogPresent: true, metricLogPresent: true,
    now: new Date(BASE_MS + DAY_MS), currentCommit, workingTreeClean: true, machineEvidence, humanEvaluation,
    replayArtifactVerification: { artifactSha256, sourceLedgerSha256, collectionEpoch: EDITORIAL_COLLECTION_EPOCH_V2, verified: true },
  };
  assert.equal(buildEditorialRolloutStatusV2(input).gates.r0.checks.find((check) => check.id === "human-evaluation-lineage")?.state, "pass");
  for (const changes of [{ workingTreeClean: false }, { currentCommit: "d".repeat(40) }, {
    humanEvaluation: { ...humanEvaluation, lineage: { ...humanEvaluation.lineage, collectionEpoch: "wrong-epoch" } },
  }]) {
    assert.equal(buildEditorialRolloutStatusV2({ ...input, ...changes }).gates.r0.checks.find((check) => check.id === "human-evaluation-lineage")?.state, "fail");
  }
});
