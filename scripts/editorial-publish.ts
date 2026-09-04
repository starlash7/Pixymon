import "dotenv/config";
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
      const reconciledState = store.getDraftState(draftIdArg());
      if (!reconciledState) throw new Error("reconciled draft disappeared");
      recordConfirmedXPost(reconcileXId, reconciledState.publishText, "briefing", {
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
    const state = store.getDraftState(draftIdArg());
    const result = await publishEditorialDraftV2({
      store,
      draftId: draftIdArg(),
      mode: "live",
      metricLogPath: paths.metricLogPath,
      timezone: config.dailyTimezone,
      dailyLimit: Number.parseInt(String(process.env.EDITORIAL_DAILY_POST_LIMIT || "1"), 10),
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
        createKind: "editorial-v2:approved-original",
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
