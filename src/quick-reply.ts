import "dotenv/config";
import { TwitterApi } from "twitter-api-v2";

/**
 * 특정 트윗에 빠르게 답글 달기
 */

async function quickReply() {
  const twitter = new TwitterApi({
    appKey: process.env.TWITTER_API_KEY!,
    appSecret: process.env.TWITTER_API_SECRET!,
    accessToken: process.env.TWITTER_ACCESS_TOKEN!,
    accessSecret: process.env.TWITTER_ACCESS_SECRET!,
  });

  // 타겟 트윗 ID (URL에서 추출)
  // https://x.com/MoneyMonkeycC8/status/2011404762001080368
  const tweetId = "2011404762001080368";
  
  // 답글 내용
  const replyText = "문버드 두쫀쿠 맛있겠다 🐦";

  try {
    console.log("[REPLY] 답글 작성 중...");
    console.log(`  대상: ${tweetId}`);
    console.log(`  내용: ${replyText}`);
    
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
