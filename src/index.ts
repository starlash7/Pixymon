import "dotenv/config";
import cron from "node-cron";
import { memory } from "./services/memory.js";
import { initClaudeClient } from "./services/llm.js";
import { TEST_MODE, validateEnvironment, initTwitterClient, getMentions } from "./services/twitter.js";
import { proactiveEngagement, checkAndReplyMentions } from "./services/engagement.js";

/**
 * Pixymon AI Agent - 메인 진입점
 * 트위터 기반 블록체인 뉴스 AI 에이전트
 *
 * Claude API 사용
 */

const SCHEDULER_MODE = process.env.SCHEDULER_MODE === "true";

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
    console.log("  Pixymon v2.1 - 24/7 자동 에이전트");
    console.log("  ├─ 브리핑 자동 포스팅 비활성화");
    console.log("  ├─ 3시간마다 멘션 체크");
    console.log("  └─ 3시간마다 인플루언서 댓글 (3개)");
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

    // 3시간마다 멘션 체크 (0, 3, 6, 9, 12, 15, 18, 21시)
    cron.schedule("0 */3 * * *", async () => {
      if (twitter && !TEST_MODE) {
        console.log("\n📬 멘션 체크");
        await checkAndReplyMentions(twitter, claude);
      }
    }, { timezone: "Asia/Seoul" });

    // 3시간마다 인플루언서 댓글 (30분 오프셋: 0:30, 3:30, 6:30...)
    cron.schedule("30 */3 * * *", async () => {
      if (twitter && !TEST_MODE) {
        console.log("\n💬 프로액티브 인게이지먼트");
        await proactiveEngagement(twitter, claude, 3);
      }
    }, { timezone: "Asia/Seoul" });

    console.log("[SCHEDULER] 대기 중... (Ctrl+C로 종료)\n");

    // 프로세스 유지
    process.on("SIGINT", () => {
      console.log("\n▶ Pixymon 종료.");
      process.exit(0);
    });

  } else {
    // 일회성 실행 모드
    console.log("\n=====================================");
    console.log("  Pixymon v2.1 - 대화형 인게이지먼트");
    console.log("  ├─ 브리핑 자동 포스팅 비활성화");
    console.log("  ├─ 인플루언서 댓글");
    console.log("  └─ 멘션 응답");
    console.log("=====================================\n");

    // 프로액티브 인게이지먼트 (인플루언서 댓글)
    if (twitter) {
      await proactiveEngagement(twitter, claude, 3);
    }

    if (twitter && !TEST_MODE) {
      await checkAndReplyMentions(twitter, claude);
    }

    console.log("=====================================");
    console.log("▶ Pixymon 세션 종료.");
    console.log("=====================================");
  }
}

main().catch(console.error);
