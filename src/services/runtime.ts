import Anthropic from "@anthropic-ai/sdk";
import { TwitterApi } from "twitter-api-v2";
import { RuntimeConfig } from "../config/runtime.js";
import { memory } from "./memory.js";
import { runDailyQuotaCycle, runDailyQuotaLoop } from "./engagement.js";
import { TEST_MODE, getMentions } from "./twitter.js";
import { xApiBudget } from "./x-api-budget.js";

export function printStartupBanner(config: RuntimeConfig): void {
  console.log("▶ Pixymon 온라인.");
  console.log("=====================================");
  console.log("  AI: Claude | Mode: Analyst");
  if (TEST_MODE) {
    console.log("  [TEST MODE] 실제 트윗 발행 안 함");
  }
  if (config.schedulerMode) {
    console.log("  [SCHEDULER] 24/7 자동 실행 모드");
  }
  console.log(
    `  [SOUL] soul=${config.soul.soulMode ? "on" : "off"} | quest=${config.soul.questMode ? "on" : "off"} | softGate=${config.soul.softGateMode ? "on" : "off"}`
  );
  console.log("=====================================\n");
}

export async function initializeMentionCursor(
  twitter: TwitterApi | null,
  config: RuntimeConfig
): Promise<void> {
  if (!twitter || TEST_MODE) return;

  const savedMentionId = memory.getLastProcessedMentionId();
  if (savedMentionId) {
    console.log(`[INIT] 저장된 마지막 멘션 ID: ${savedMentionId}`);
    console.log("[INIT] 이후 새 멘션만 처리됩니다.");
    return;
  }

  console.log("[INIT] 첫 실행 - 기존 멘션 ID 확인 중...");
  const mentionReadGuard = xApiBudget.checkReadAllowance({
    enabled: config.xApiCost.enabled,
    timezone: config.dailyTimezone,
    dailyMaxUsd: config.xApiCost.dailyMaxUsd,
    estimatedReadCostUsd: config.xApiCost.estimatedReadCostUsd,
    dailyReadRequestLimit: config.xApiCost.dailyReadRequestLimit,
    kind: "mentions-init",
    minIntervalMinutes: config.xApiCost.mentionReadMinIntervalMinutes,
  });
  if (!mentionReadGuard.allowed) {
    console.log("[INIT] 멘션 커서 초기화 스킵 (X read budget guard)");
    return;
  }

  xApiBudget.recordRead({
    timezone: config.dailyTimezone,
    estimatedReadCostUsd: config.xApiCost.estimatedReadCostUsd,
    kind: "mentions-init",
  });
  const existingMentions = await getMentions(twitter);
  if (existingMentions.length > 0) {
    memory.setLastProcessedMentionId(existingMentions[0].id);
    console.log("[INIT] 이후 새 멘션만 처리됩니다.");
  }
}

export async function runSchedulerMode(
  twitter: TwitterApi | null,
  claude: Anthropic,
  config: RuntimeConfig
): Promise<void> {
  console.log("\n=====================================");
  console.log("  Pixymon v3 - Daily Quota Autopilot");
  console.log(`  ├─ 하루 목표: ${config.dailyActivityTarget}개`);
  console.log("  ├─ 구성: 트렌드 글 + 트렌드 댓글 + 멘션 답글");
  console.log("  └─ 고정 시간 크론 미사용 (자율 간격 루프)");
  console.log("=====================================\n");

  await initializeMentionCursor(twitter, config);

  if (!twitter) {
    console.log("[WARN] Twitter 클라이언트 없음. 루프 시작 불가");
    return;
  }

  process.on("SIGINT", () => {
    console.log("\n▶ Pixymon 종료.");
    process.exit(0);
  });

  await runDailyQuotaLoop(twitter, claude, {
    dailyTarget: config.dailyActivityTarget,
    timezone: config.dailyTimezone,
    maxActionsPerCycle: config.maxActionsPerCycle,
    minLoopMinutes: config.minLoopMinutes,
    maxLoopMinutes: config.maxLoopMinutes,
    engagement: config.engagement,
    xApiCost: config.xApiCost,
    observability: config.observability,
  });
}

export async function runOneShotMode(
  twitter: TwitterApi | null,
  claude: Anthropic,
  config: RuntimeConfig
): Promise<void> {
  console.log("\n=====================================");
  console.log("  Pixymon v3 - Quota Cycle (One-shot)");
  console.log(`  ├─ 하루 목표: ${config.dailyActivityTarget}개`);
  console.log("  ├─ 이번 실행: 멘션 + 트렌드 글/댓글 사이클");
  console.log("  └─ 고정 시간 없음");
  console.log("=====================================\n");

  if (twitter) {
    await runDailyQuotaCycle(twitter, claude, {
      dailyTarget: config.dailyActivityTarget,
      timezone: config.dailyTimezone,
      maxActionsPerCycle: config.maxActionsPerCycle,
      engagement: config.engagement,
      xApiCost: config.xApiCost,
      observability: config.observability,
    });
  } else {
    console.log("[WARN] Twitter 클라이언트 없음. 일회성 사이클 건너뜀");
  }

  console.log("=====================================");
  console.log("▶ Pixymon 세션 종료.");
  console.log("=====================================");
}
