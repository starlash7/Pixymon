import "dotenv/config";
import { memory } from "./services/memory.js";
import { REPLY_TONE_MODE, initClaudeClient } from "./services/llm.js";
import { validateEnvironment, initTwitterClient, TEST_NO_EXTERNAL_CALLS } from "./services/twitter.js";
import { loadRuntimeConfig } from "./config/runtime.js";
import { printStartupBanner, runOneShotMode, runSchedulerMode } from "./services/runtime.js";
import { operationalState } from "./services/operational-state.js";
import { anthropicBudget } from "./services/anthropic-budget.js";
import { anthropicAdminUsage } from "./services/anthropic-admin-usage.js";
import { acquireRuntimeLock, registerRuntimeLockCleanup } from "./services/process-lock.js";
import { xApiBudget } from "./services/x-api-budget.js";

/**
 * Pixymon AI Agent - 메인 진입점
 * 트위터 기반 블록체인 뉴스 AI 에이전트
 *
 * Claude API 사용
 */

const runtimeConfig = loadRuntimeConfig();
let shutdownCommitted = false;

function commitShutdown(reason: string): void {
  if (shutdownCommitted) {
    return;
  }
  shutdownCommitted = true;
  try {
    memory.flushNow();
  } catch {
    // no-op
  }
  try {
    xApiBudget.flushNow();
  } catch {
    // no-op
  }
  try {
    anthropicBudget.flushNow();
  } catch {
    // no-op
  }
  try {
    anthropicAdminUsage.flushNow();
  } catch {
    // no-op
  }
  try {
    operationalState.recordShutdown(runtimeConfig, reason);
  } catch {
    // no-op
  }
}

function registerSafetyHooks(): void {
  process.once("SIGINT", () => {
    console.log("\n▶ Pixymon 종료(SIGINT).");
    commitShutdown("signal:SIGINT");
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    console.log("\n▶ Pixymon 종료(SIGTERM).");
    commitShutdown("signal:SIGTERM");
    process.exit(0);
  });

  if (!runtimeConfig.operational.crashFlushOnException) {
    return;
  }

  process.on("uncaughtException", (error) => {
    console.error("[FATAL] uncaughtException:", error);
    commitShutdown("uncaughtException");
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[FATAL] unhandledRejection:", reason);
    commitShutdown("unhandledRejection");
    process.exit(1);
  });
}

// 메인 실행
async function main() {
  registerSafetyHooks();
  const lock = acquireRuntimeLock();
  if (!lock.acquired) {
    const pidText = lock.existingPid ? ` (pid=${lock.existingPid})` : "";
    console.error(`[LOCK] 실행 중단: 다른 인스턴스가 이미 실행 중${pidText}`);
    process.exit(1);
  }
  registerRuntimeLockCleanup(lock);
  console.log(`[LOCK] 런타임 락 획득: ${lock.lockPath}`);

  printStartupBanner(runtimeConfig);

  validateEnvironment();
  operationalState.reconcileOnBoot(runtimeConfig);
  operationalState.recordBoot(runtimeConfig);
  console.log("[COGNITION] Narrative OS 루프 활성화 (feed → digest → evolve → plan → act → reflect)");
  console.log(`[STYLE] 댓글 톤 모드: ${REPLY_TONE_MODE} (env: REPLY_TONE_MODE=signal|personal)`);
  console.log(memory.getAgentStateContext());

  // 클라이언트 초기화
  const twitter = initTwitterClient();
  const claude = initClaudeClient();

  console.log("[OK] Claude 연결됨");

  if (twitter) {
    console.log("[OK] Twitter 연결됨");

    if (TEST_NO_EXTERNAL_CALLS) {
      console.log("[TEST-LOCAL] Twitter 인증 조회 스킵 (외부 호출 없음)");
    } else {
      try {
        const me = await twitter.v2.me();
        console.log(`[OK] @${me.data.username} 인증 완료`);
      } catch (error: any) {
        console.log("[WARN] Twitter API 인증 실패");
      }
    }
  }

  // 스케줄러 모드
  if (runtimeConfig.schedulerMode) {
    await runSchedulerMode(twitter, claude, runtimeConfig);
  } else {
    await runOneShotMode(twitter, claude, runtimeConfig);
    commitShutdown("one-shot-finished");
  }
}

main().catch((error) => {
  console.error(error);
  commitShutdown("main-catch");
});
