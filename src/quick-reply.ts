import "dotenv/config";
import { TwitterApi } from "twitter-api-v2";

/**
 * 특정 트윗에 빠르게 답글 달기
 * 사용법:
 * QUICK_REPLY_TWEET_ID=<tweet_id> QUICK_REPLY_TEXT="<text>" npx tsx src/quick-reply.ts
 */

async function quickReply() {
  const tweetId = String(process.env.QUICK_REPLY_TWEET_ID || "").trim();
  const replyText = String(process.env.QUICK_REPLY_TEXT || "").trim();
  const dryRun = process.env.QUICK_REPLY_DRY_RUN === "true";
  const appKey = String(process.env.TWITTER_API_KEY || "").trim();
  const appSecret = String(process.env.TWITTER_API_SECRET || "").trim();
  const accessToken = String(process.env.TWITTER_ACCESS_TOKEN || "").trim();
  const accessSecret = String(process.env.TWITTER_ACCESS_SECRET || "").trim();

  if (!tweetId || !replyText) {
    console.error("[ERROR] QUICK_REPLY_TWEET_ID, QUICK_REPLY_TEXT 환경변수가 필요합니다.");
    process.exit(1);
  }

  if (replyText.length > 280) {
    console.error("[ERROR] QUICK_REPLY_TEXT는 280자를 넘을 수 없습니다.");
    process.exit(1);
  }

  if (!appKey || !appSecret || !accessToken || !accessSecret) {
    console.error("[ERROR] Twitter API 키가 필요합니다.");
    process.exit(1);
  }

  const twitter = new TwitterApi({
    appKey,
    appSecret,
    accessToken,
    accessSecret,
  });

  try {
    console.log("[REPLY] 답글 작성 중...");
    console.log(`  대상: ${tweetId}`);
    console.log(`  내용: ${replyText}`);

    if (dryRun) {
      console.log("  [DRY RUN] 실제 전송하지 않음");
      return;
    }
    
    const reply = await twitter.v2.reply(replyText, tweetId);
    
    console.log("[OK] 답글 완료!");
    console.log(`  ID: ${reply.data.id}`);
    console.log(`  URL: https://twitter.com/Pixy_mon/status/${reply.data.id}`);
  } catch (error: any) {
    console.error("[ERROR]", error.message);
    if (error.data) {
      console.error("  Details:", JSON.stringify(error.data, null, 2));
    }
  }
}

quickReply();
