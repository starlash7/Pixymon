import "dotenv/config";
import { memory } from "./services/memory.js";
import { initClaudeClient } from "./services/llm.js";
import { TEST_MODE, validateEnvironment, initTwitterClient, getMentions } from "./services/twitter.js";
import { runDailyQuotaCycle, runDailyQuotaLoop } from "./services/engagement.js";

/**
 * Pixymon AI Agent - 메인 진입점
 * 트위터 기반 블록체인 뉴스 AI 에이전트
 *
 * Claude API 사용
 */

const SCHEDULER_MODE = process.env.SCHEDULER_MODE === "true";
const DAILY_ACTIVITY_TARGET = Number.parseInt(process.env.DAILY_ACTIVITY_TARGET || "20", 10);
const DAILY_TIMEZONE = process.env.DAILY_TARGET_TIMEZONE || "Asia/Seoul";

// 메인 실행
async function main() {
  console.log("▶ Pixymon 온라인.");
  console.log("=====================================");
  console.log("  AI: Claude | Mode: Analyst");
  if (TEST_MODE) {
    console.log("  [TEST MODE] 실제 트윗 발행 안 함");
  }
  if (SCHEDULER_MODE) {
    console.log("  [SCHEDULER] 24/7 자동 실행 모드");
  }
  console.log("=====================================\n");

  validateEnvironment();
  console.log("[COGNITION] 5-layer 루프 활성화 (signal → cluster → belief → action → reflection)");
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
  if (SCHEDULER_MODE) {
    console.log("\n=====================================");
    console.log("  Pixymon v3 - Daily Quota Autopilot");
    console.log(`  ├─ 하루 목표: ${DAILY_ACTIVITY_TARGET}개`);
    console.log("  ├─ 구성: 트렌드 글 + 트렌드 댓글 + 멘션 답글");
    console.log("  └─ 고정 시간 크론 미사용 (자율 간격 루프)");
    console.log("=====================================\n");

    // 메모리에서 마지막 처리 멘션 ID 확인 (영구 저장됨)
    if (twitter && !TEST_MODE) {
      const savedMentionId = memory.getLastProcessedMentionId();
      if (savedMentionId) {
        console.log(`[INIT] 저장된 마지막 멘션 ID: ${savedMentionId}`);
        console.log("[INIT] 이후 새 멘션만 처리됩니다.");
      } else {
        // 처음 실행 시 기존 멘션 ID 저장
        console.log("[INIT] 첫 실행 - 기존 멘션 ID 확인 중...");
        const existingMentions = await getMentions(twitter);
        if (existingMentions.length > 0) {
          memory.setLastProcessedMentionId(existingMentions[0].id);
          console.log("[INIT] 이후 새 멘션만 처리됩니다.");
        }
      }
    }

    if (twitter) {
      await runDailyQuotaLoop(twitter, claude, {
        dailyTarget: DAILY_ACTIVITY_TARGET,
        timezone: DAILY_TIMEZONE,
        maxActionsPerCycle: 4,
        minLoopMinutes: 25,
        maxLoopMinutes: 70,
      });
    } else {
      console.log("[WARN] Twitter 클라이언트 없음. 루프 시작 불가");
    }

  } else {
    // 일회성 실행 모드
    console.log("\n=====================================");
    console.log("  Pixymon v3 - Quota Cycle (One-shot)");
    console.log(`  ├─ 하루 목표: ${DAILY_ACTIVITY_TARGET}개`);
    console.log("  ├─ 이번 실행: 멘션 + 트렌드 글/댓글 사이클");
    console.log("  └─ 고정 시간 없음");
    console.log("=====================================\n");

    if (twitter) {
      await runDailyQuotaCycle(twitter, claude, {
        dailyTarget: DAILY_ACTIVITY_TARGET,
        timezone: DAILY_TIMEZONE,
        maxActionsPerCycle: 4,
      });
    }

    console.log("=====================================");
    console.log("▶ Pixymon 세션 종료.");
    console.log("=====================================");
  }
}

main().catch(console.error);
