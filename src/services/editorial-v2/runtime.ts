import type Anthropic from "@anthropic-ai/sdk";
import type { RuntimeConfig } from "../../config/runtime.js";
import { EditorialEventStoreV2 } from "./event-store.js";
import { resolveEditorialRuntimePathsV2 } from "./paths.js";
import { checkEditorialFollowUpsV2, collectEditorialDraftV2 } from "./workflow.js";
import { createAnthropicEditorialWriterV2 } from "./writer.js";

async function collectOnce(claude: Anthropic, config: RuntimeConfig): Promise<void> {
  if (config.operational.socialSurfacesEnabled) {
    console.log("[V2] SOCIAL_SURFACES_ENABLED 요청은 첫 마일스톤에서 무시됩니다 (original-only lock).");
  }
  const paths = resolveEditorialRuntimePathsV2(config.operational.actionMode);
  const store = new EditorialEventStoreV2({ eventLogPath: paths.eventLogPath });
  const result = await collectEditorialDraftV2({
    store,
    writerModel: createAnthropicEditorialWriterV2(claude, config.dailyTimezone),
    metricLogPath: paths.metricLogPath,
    mode: config.operational.actionMode,
    trackingMode: paths.trackingMode,
  });
  if (result.status === "drafted") {
    console.log(`[V2] 검토 후보 생성: ${result.draftId}`);
    console.log(result.draft);
    return;
  }
  console.log(`[V2] no-post stage=${result.stage} reason=${result.reason}`);
}

async function checkFollowUpsOnce(config: RuntimeConfig): Promise<number> {
  const paths = resolveEditorialRuntimePathsV2(config.operational.actionMode);
  const store = new EditorialEventStoreV2({ eventLogPath: paths.eventLogPath });
  const result = await checkEditorialFollowUpsV2({
    store,
    metricLogPath: paths.metricLogPath,
    mode: config.operational.actionMode,
  });
  console.log(
    `[V2] followups targets=${result.targetCount} resolutions=${result.resolutionCount} publicCandidates=${result.publicCandidateCount} retryable=${result.retryableCount}`
  );
  return result.publicCandidateCount;
}

export function shouldCollectEditorialV2(input: {
  publicCandidateCount: number;
  nowMs: number;
  nextGenericCollectAtMs: number;
}): { collect: boolean; genericDue: boolean } {
  const genericDue = input.nowMs >= input.nextGenericCollectAtMs;
  return {
    collect: input.publicCandidateCount > 0 || genericDue,
    genericDue,
  };
}

export function printEditorialV2StartupBanner(config: RuntimeConfig): void {
  const testMode = process.env.TEST_MODE === "true";
  const noExternal =
    testMode && String(process.env.TEST_NO_EXTERNAL_CALLS ?? "true").trim().toLowerCase() !== "false";
  console.log("▶ Pixymon V2 온라인.");
  console.log("=====================================");
  console.log("  Mode: evidence-first original-only");
  console.log(
    `  [SAFE] action=${config.operational.actionMode} | pipeline=v2 | X client=off | social=off`
  );
  if (noExternal) console.log("  [TEST-LOCAL] 외부 API 호출 차단");
  if (config.schedulerMode) console.log("  [SCHEDULER] editorial collection only");
  console.log("=====================================\n");
}

export async function runEditorialV2Runtime(
  claude: Anthropic,
  config: RuntimeConfig
): Promise<void> {
  const testMode = process.env.TEST_MODE === "true";
  const noExternal =
    testMode && String(process.env.TEST_NO_EXTERNAL_CALLS ?? "true").trim().toLowerCase() !== "false";
  if (config.operational.actionMode === "live") {
    console.log("[V2] 자동 live는 잠겨 있습니다. 검토 후 editorial:publish를 사용하세요.");
    return;
  }
  if (noExternal) {
    console.log("[V2] no-post stage=sensing reason=external-calls-disabled");
    return;
  }
  if (!config.schedulerMode) {
    console.log("[V2] original-only editorial collection (X write/social/memory disabled)");
    await collectOnce(claude, config);
    console.log("▶ Pixymon V2 collection 종료.");
    return;
  }

  const rawInterval = Number.parseInt(
    String(process.env.EDITORIAL_COLLECT_INTERVAL_MINUTES || "360"),
    10
  );
  const intervalMinutes = Math.max(
    60,
    Math.min(1440, Number.isFinite(rawInterval) ? rawInterval : 360)
  );
  const followUpIntervalMinutes = 60;
  let nextGenericCollectAtMs = 0;
  console.log(
    `[V2] editorial scheduler: followups every ${followUpIntervalMinutes} minutes, generic collection every ${intervalMinutes} minutes (X write/social/memory disabled)`
  );
  while (true) {
    const publicCandidateCount = await checkFollowUpsOnce(config);
    const nowMs = Date.now();
    const decision = shouldCollectEditorialV2({
      publicCandidateCount,
      nowMs,
      nextGenericCollectAtMs,
    });
    if (decision.collect) await collectOnce(claude, config);
    if (decision.genericDue) {
      nextGenericCollectAtMs = nowMs + intervalMinutes * 60 * 1000;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, followUpIntervalMinutes * 60 * 1000));
  }
}
