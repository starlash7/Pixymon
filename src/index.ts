import "dotenv/config";
import { loadRuntimeConfig } from "./config/runtime.js";
import { acquireRuntimeLock, registerRuntimeLockCleanup } from "./services/process-lock.js";

/**
 * Pixymon runtime entrypoint.
 *
 * V2 deliberately loads through a separate dynamic import boundary. This is a
 * safety boundary: the legacy memory/Twitter graph must never be evaluated by
 * observe or paper editorial collection.
 */

const runtimeConfig = loadRuntimeConfig();
let shutdownCommitted = false;
const shutdownCallbacks: Array<(reason: string) => void> = [];

function commitShutdown(reason: string): void {
  if (shutdownCommitted) return;
  shutdownCommitted = true;
  for (const callback of shutdownCallbacks) {
    try {
      callback(reason);
    } catch {
      // best-effort shutdown only
    }
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
  if (!runtimeConfig.operational.crashFlushOnException) return;
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

function validateEditorialV2Environment(): void {
  const testMode = process.env.TEST_MODE === "true";
  const noExternal =
    testMode && String(process.env.TEST_NO_EXTERNAL_CALLS ?? "true").trim().toLowerCase() !== "false";
  if (
    runtimeConfig.operational.actionMode !== "live" &&
    !noExternal &&
    !String(process.env.ANTHROPIC_API_KEY || "").trim()
  ) {
    throw new Error("ANTHROPIC_API_KEY is required for V2 collection");
  }
}

async function runEditorialV2(): Promise<void> {
  validateEditorialV2Environment();
  const [llm, editorialRuntime, anthropicBudgetModule, adminUsageModule] = await Promise.all([
    import("./services/llm.js"),
    import("./services/editorial-v2/runtime.js"),
    import("./services/anthropic-budget.js"),
    import("./services/anthropic-admin-usage.js"),
  ]);
  shutdownCallbacks.push(() => anthropicBudgetModule.anthropicBudget.flushNow());
  shutdownCallbacks.push(() => adminUsageModule.anthropicAdminUsage.flushNow());
  editorialRuntime.printEditorialV2StartupBanner(runtimeConfig);
  console.log("[V2] X client와 legacy character memory를 로드하지 않습니다.");
  await editorialRuntime.runEditorialV2Runtime(llm.initClaudeClient(), runtimeConfig);
}

async function runLegacyV1(): Promise<void> {
  const [memoryModule, llm, twitterModule, runtime, operational, xBudget, anthropicBudgetModule, adminUsageModule, batchRuns] =
    await Promise.all([
      import("./services/memory.js"),
      import("./services/llm.js"),
      import("./services/twitter.js"),
      import("./services/runtime.js"),
      import("./services/operational-state.js"),
      import("./services/x-api-budget.js"),
      import("./services/anthropic-budget.js"),
      import("./services/anthropic-admin-usage.js"),
      import("./services/llm-batch-runs.js"),
    ]);

  shutdownCallbacks.push(() => memoryModule.memory.flushNow());
  shutdownCallbacks.push(() => xBudget.xApiBudget.flushNow());
  shutdownCallbacks.push(() => anthropicBudgetModule.anthropicBudget.flushNow());
  shutdownCallbacks.push(() => adminUsageModule.anthropicAdminUsage.flushNow());
  shutdownCallbacks.push(() => batchRuns.llmBatchRuns.flushNow());
  shutdownCallbacks.push((reason) => operational.operationalState.recordShutdown(runtimeConfig, reason));

  runtime.printStartupBanner(runtimeConfig);
  twitterModule.validateEnvironment();
  operational.operationalState.reconcileOnBoot(runtimeConfig);
  operational.operationalState.recordBoot(runtimeConfig);
  console.log("[COGNITION] Narrative OS 루프 활성화 (feed → digest → evolve → plan → act → reflect)");
  console.log(`[STYLE] 댓글 톤 모드: ${llm.REPLY_TONE_MODE} (env: REPLY_TONE_MODE=signal|personal)`);
  console.log(memoryModule.memory.getAgentStateContext());

  const twitter = twitterModule.initTwitterClient();
  const claude = llm.initClaudeClient();
  console.log("[OK] Claude 연결됨");
  if (twitter) {
    console.log("[OK] Twitter 연결됨");
    if (twitterModule.TEST_NO_EXTERNAL_CALLS) {
      console.log("[TEST-LOCAL] Twitter 인증 조회 스킵 (외부 호출 없음)");
    } else {
      try {
        const me = await twitter.v2.me();
        console.log(`[OK] @${me.data.username} 인증 완료`);
      } catch {
        console.log("[WARN] Twitter API 인증 실패");
      }
    }
  }

  if (runtimeConfig.schedulerMode) {
    await runtime.runSchedulerMode(twitter, claude, runtimeConfig);
  } else {
    await runtime.runOneShotMode(twitter, claude, runtimeConfig);
  }
}

async function main(): Promise<void> {
  registerSafetyHooks();
  const lock = acquireRuntimeLock();
  if (!lock.acquired) {
    const pidText = lock.existingPid ? ` (pid=${lock.existingPid})` : "";
    throw new Error(`[LOCK] 실행 중단: 다른 인스턴스가 이미 실행 중${pidText}`);
  }
  registerRuntimeLockCleanup(lock);
  console.log(`[LOCK] 런타임 락 획득: ${lock.lockPath}`);

  if (runtimeConfig.operational.postPipelineVersion === "v2") {
    await runEditorialV2();
  } else {
    await runLegacyV1();
  }
  if (!runtimeConfig.schedulerMode) commitShutdown("one-shot-finished");
}

main().catch((error) => {
  console.error(error);
  commitShutdown("main-catch");
  process.exitCode = 1;
});
