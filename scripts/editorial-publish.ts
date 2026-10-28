import "dotenv/config";
import path from "node:path";
import {
  assertApprovedLiveAuthorizationV2,
  assertAutoPublishPolicyV2,
  autoPublishEnabledV2,
  originalDailyLimitV2,
} from "../src/services/editorial-v2/publication-policy.js";
import { EDITORIAL_COLLECTION_EPOCH_V2 } from "../src/services/editorial-v2/contracts.js";
import { recordEditorialReviewV2 } from "../src/services/editorial-v2/review.js";
import { editorialVerificationRepositoryStateV2 } from "./editorial-repository-state.js";
import { loadRuntimeConfig } from "../src/config/runtime.js";
import { EditorialEventStoreV2 } from "../src/services/editorial-v2/event-store.js";
import { resolveEditorialRuntimePathsV2 } from "../src/services/editorial-v2/paths.js";
import { publishEditorialDraftV2 } from "../src/services/editorial-v2/publisher.js";
import {
  collectEditorialEvidenceV2,
  type EditorialFollowUpTargetV2,
} from "../src/services/editorial-v2/provider-adapters.js";
import { providerHealthFromOutcomeV2 } from "../src/services/editorial-v2/provider-health.js";
import { acquireRuntimeLock } from "../src/services/process-lock.js";
import { initTwitterClient, postTweet, recordConfirmedXPost, TEST_MODE, TEST_NO_EXTERNAL_CALLS } from "../src/services/twitter.js";

function draftIdArg(): string {
  const index = process.argv.indexOf("--id");
  const value = index >= 0 ? process.argv[index + 1] : "";
  if (!value) throw new Error("usage: npm run editorial:publish -- --id <draftId>");
  return value;
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  if (config.operational.postPipelineVersion !== "v2") throw new Error("editorial:publish requires POST_PIPELINE_VERSION=v2");
  if (config.operational.actionMode !== "live") throw new Error("editorial:publish requires ACTION_MODE=live");
  if (TEST_MODE || TEST_NO_EXTERNAL_CALLS) throw new Error("editorial:publish refuses TEST_MODE or TEST_NO_EXTERNAL_CALLS");
  const paths = resolveEditorialRuntimePathsV2("live");
  const lock = acquireRuntimeLock(paths.publishLockPath);
  if (!lock.acquired) throw new Error(lock.reason || "another editorial publish is running");
  try {
    const store = new EditorialEventStoreV2({ eventLogPath: paths.eventLogPath });
    const reconcileXId = arg("reconcile-x-id");
    if (reconcileXId) {
      const publishedAt = arg("published-at");
      if (!publishedAt) throw new Error("--reconcile-x-id requires --published-at <ISO timestamp>");
      const result = store.reconcilePublished(draftIdArg(), {
        externalPostId: reconcileXId,
        publishedAt,
      });
      if (result.publication.externalPostId !== reconcileXId) {
        throw new Error(
          `reconcile X id conflicts with existing publication: ${result.publication.externalPostId}`
        );
      }
      const reconciledState = store.getDraftState(draftIdArg());
      if (!reconciledState) throw new Error("reconciled draft disappeared");
      recordConfirmedXPost(result.publication.externalPostId, reconciledState.publishText, "briefing", {
        createKind: "editorial-v2:reconciled-original",
        metadata: {
          eventId: reconciledState.draft.id,
          evidenceIds: [...reconciledState.draft.factIds],
          narrativeMode: reconciledState.draft.format,
        },
      });
      console.log(`[EDITORIAL] reconcile ${result.status} id=${result.publication.externalPostId}`);
      return;
    }

    const twitter = initTwitterClient();
    if (!twitter) throw new Error("Twitter credentials are required; live publish cannot simulate success");
    const auto = process.argv.includes("--auto");
    const stopPath = path.join(paths.dataDir, "editorial-v2", "STOP");
    if (auto) {
      // Auto mode publishes only a fresh, critic-passed, untouched candidate of the current writer.
      if (!autoPublishEnabledV2()) throw new Error("auto-publish-disabled (set PIXYMON_AUTO_PUBLISH=true)");
      const candidate = store.getDraftState(draftIdArg());
      if (!candidate) throw new Error("unknown draft");
      if ((candidate.draft.trackingMode ?? "live") !== "live") throw new Error("auto-publish requires a live candidate");
      if (candidate.draft.collectionEpoch !== EDITORIAL_COLLECTION_EPOCH_V2) throw new Error("auto-publish requires the current writer epoch");
      if (!candidate.draft.scopeReview) throw new Error("auto-publish requires a semantic critic pass");
      if (candidate.reviewStatus === "pending") {
        recordEditorialReviewV2({ store, draftId: candidate.draft.id, action: "approve", reviewerId: "pixymon-auto",
          reasonTags: ["auto-publish"], metricLogPath: paths.metricLogPath, mode: "live" });
      } else if (candidate.reviewStatus !== "approved") {
        throw new Error(`auto-publish skips a ${candidate.reviewStatus} draft`);
      }
    }
    const state = store.getDraftState(draftIdArg());
    const authorize = () => {
      const repository = editorialVerificationRepositoryStateV2();
      if (auto) {
        assertAutoPublishPolicyV2({ enabled: autoPublishEnabledV2(), stopPath, workingTreeClean: repository.workingTreeClean });
        return;
      }
      assertApprovedLiveAuthorizationV2({
        authorizationPath: arg("authorization") || "",
        stopPath,
        commit: repository.currentCommit,
        workingTreeClean: repository.workingTreeClean,
      });
    };
    const result = await publishEditorialDraftV2({
      store,
      draftId: draftIdArg(),
      mode: "live",
      authorize,
      metricLogPath: paths.metricLogPath,
      timezone: config.dailyTimezone,
      // Manual R3/pilot scope stays one per day; operator-enabled auto mode uses PIXYMON_ORIGINAL_DAILY_LIMIT.
      dailyLimit: auto ? originalDailyLimitV2() : 1,
      revalidateEvidence: async (facts) => {
        const revalidationTargets: EditorialFollowUpTargetV2[] = facts.map((fact) => ({
          provider: fact.source.provider as EditorialFollowUpTargetV2["provider"],
          subject: fact.subject,
          subjectKey: fact.subjectKey,
          metricName: fact.metric.name,
          unit: fact.metric.unit,
          period: fact.metric.period,
        }));
        const sensing = await collectEditorialEvidenceV2({
          now: new Date().toISOString(),
          followUpTargets: revalidationTargets,
          includeGenericCandidates: false,
        });
        for (const fact of facts) {
          const provider = sensing.providers.find(
            (row) => row.outcome.provider === fact.source.provider
          );
          if (!provider) return { ok: false, reason: `${fact.source.provider}:missing` };
          const health = providerHealthFromOutcomeV2(provider.outcome);
          if (health.state !== "green") {
            return { ok: false, reason: `${fact.source.provider}:${health.reason}` };
          }
          const currentFactAvailable = [...provider.evidence, ...provider.observations].some(
            (card) =>
              (fact.subjectKey ? card.subjectKey === fact.subjectKey : card.subject === fact.subject) &&
              card.metric.name === fact.metric.name &&
              card.metric.unit === fact.metric.unit &&
              card.metric.period === fact.metric.period &&
              card.source.origin === "direct" &&
              card.source.role === "primary"
          );
          if (!currentFactAvailable) {
            return { ok: false, reason: `${fact.source.provider}:fact-unavailable` };
          }
        }
        return { ok: true };
      },
      dispatch: (text, beforeSend) => postTweet(twitter, text, "briefing", {
        timezone: config.dailyTimezone,
        xApiCostSettings: config.xApiCost,
        createKind: auto ? "editorial-v2:auto-original" : "editorial-v2:approved-original",
        maxAttempts: 1,
        beforeSend,
        metadata: state ? { eventId: state.draft.id, evidenceIds: [...state.draft.factIds], narrativeMode: state.draft.format } : undefined,
      }),
    });
    console.log(`[EDITORIAL] publish ${result.status}${"externalPostId" in result ? ` id=${result.externalPostId}` : ` reason=${result.reason}`}`);
    if (result.status === "blocked") process.exitCode = 2;
  } finally {
    lock.release();
  }
}

main().catch((error) => {
  console.error(`[EDITORIAL] publish failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
