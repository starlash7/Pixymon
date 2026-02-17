import "dotenv/config";
import { memory } from "./services/memory.js";
import { REPLY_TONE_MODE, initClaudeClient } from "./services/llm.js";
import { validateEnvironment, initTwitterClient } from "./services/twitter.js";
import { loadRuntimeConfig } from "./config/runtime.js";
import { printStartupBanner, runOneShotMode, runSchedulerMode } from "./services/runtime.js";
import { acquireRuntimeLock, registerRuntimeLockCleanup } from "./services/process-lock.js";

/**
 * Pixymon AI Agent - 메인 진입점
 * 트위터 기반 블록체인 뉴스 AI 에이전트
 *
 * Claude API 사용
 */

const runtimeConfig = loadRuntimeConfig();

// 메인 실행
async function main() {
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
  console.log("[COGNITION] 5-layer 루프 활성화 (signal → cluster → belief → action → reflection)");
  console.log(`[STYLE] 댓글 톤 모드: ${REPLY_TONE_MODE} (env: REPLY_TONE_MODE=signal|personal)`);
  console.log(memory.getAgentStateContext());

  // 클라이언트 초기화
  const twitter = initTwitterClient();
  const claude = initClaudeClient();

  console.log("[OK] Claude 연결됨");

  if (twitter) {
    console.log("[OK] Twitter 연결됨");

    try {
      const me = await twitter.v2.me();
      console.log(`[OK] @${me.data.username} 인증 완료`);
    } catch (error: any) {
      console.log("[WARN] Twitter API 인증 실패");
    }
  }

  // 스케줄러 모드
  if (runtimeConfig.schedulerMode) {
    await runSchedulerMode(twitter, claude, runtimeConfig);
  } else {
    await runOneShotMode(twitter, claude, runtimeConfig);
  }
}

main().catch(console.error);
