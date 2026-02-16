import { TwitterApi } from "twitter-api-v2";
import Anthropic from "@anthropic-ai/sdk";
import { memory } from "./memory.js";
import { INFLUENCER_ACCOUNTS } from "../config/influencers.js";
import { CLAUDE_MODEL, PIXYMON_SYSTEM_PROMPT, extractTextFromClaude } from "./llm.js";

export const TEST_MODE = process.env.TEST_MODE === "true";

// 환경 변수 검증
export function validateEnvironment() {
  const required = ["ANTHROPIC_API_KEY"];

  if (!TEST_MODE) {
    required.push(
      "TWITTER_API_KEY",
      "TWITTER_API_SECRET",
      "TWITTER_ACCESS_TOKEN",
      "TWITTER_ACCESS_SECRET"
    );
  }

  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    console.error(`❌ 필수 환경 변수가 누락되었습니다: ${missing.join(", ")}`);
    console.log("📝 .env 파일을 확인해주세요.");
    process.exit(1);
  }

  console.log("✅ 환경 변수 검증 완료");
}

// Twitter 클라이언트 초기화
export function initTwitterClient(): TwitterApi | null {
  if (!process.env.TWITTER_API_KEY) {
    return null;
  }
  return new TwitterApi({
    appKey: process.env.TWITTER_API_KEY!,
    appSecret: process.env.TWITTER_API_SECRET!,
    accessToken: process.env.TWITTER_ACCESS_TOKEN!,
    accessSecret: process.env.TWITTER_ACCESS_SECRET!,
  });
}

// 특정 유저의 최근 트윗 가져오기
export async function getUserTweets(twitter: TwitterApi, username: string, count: number = 5): Promise<any[]> {
  try {
    const user = await twitter.v2.userByUsername(username);
    if (!user.data) {
      console.log(`[WARN] @${username} 유저를 찾을 수 없음`);
      return [];
    }

    // Twitter API v2는 max_results 최소 5 필요
    const tweets = await twitter.v2.userTimeline(user.data.id, {
      max_results: Math.max(5, count),
      "tweet.fields": ["created_at", "text"],
      exclude: ["retweets", "replies"],
    });

    // 요청한 수만큼만 반환
    const data = tweets.data?.data || [];
    return data.slice(0, count);
  } catch (error: any) {
    // 에러 상세 로그 (디버깅용)
    if (error.code === 400) {
      console.log(`  [SKIP] @${username} (API 제한)`);
    } else {
      console.log(`  [SKIP] @${username}`);
    }
    return [];
  }
}

// 인플루언서들의 최근 트윗 수집 (랜덤 샘플링)
export async function getInfluencerTweets(twitter: TwitterApi, sampleSize: number = 10): Promise<string> {
  console.log(`[INTEL] 인플루언서 트윗 수집 중... (${sampleSize}개 샘플링)\n`);

  // 랜덤 샘플링 (rate limit 방지)
  const shuffled = [...INFLUENCER_ACCOUNTS].sort(() => Math.random() - 0.5);
  const sampled = shuffled.slice(0, sampleSize);

  const allTweets: string[] = [];

  for (const account of sampled) {
    try {
      const tweets = await getUserTweets(twitter, account, 1);
      if (tweets.length > 0) {
        const recentTweet = tweets[0];
        allTweets.push(`@${account}: ${recentTweet.text.substring(0, 200)}`);
        console.log(`  [OK] @${account}`);
      }
      // Rate limit 방지
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (error) {
      console.log(`  [SKIP] @${account}`);
    }
  }

  return allTweets.join("\n\n");
}

// 멘션 가져오기
export async function getMentions(twitter: TwitterApi, sinceId?: string): Promise<any[]> {
  try {
    const me = await twitter.v2.me();
    const mentions = await twitter.v2.userMentionTimeline(me.data.id, {
      max_results: 10,
      "tweet.fields": ["created_at", "text", "author_id", "conversation_id"],
      ...(sinceId && { since_id: sinceId }),
    });

    return mentions.data?.data || [];
  } catch (error: any) {
    console.error("[ERROR] 멘션 조회 실패:", error.message);
    return [];
  }
}

// 멘션에 답글 달기
export async function replyToMention(
  twitter: TwitterApi,
  claude: Anthropic,
  mention: any
): Promise<void> {
  try {
    // 팔로워 기록 (멘션한 사람 추적)
    if (mention.author_id) {
      // 유저 정보 가져오기 (username 확인용)
      try {
        const user = await twitter.v2.user(mention.author_id);
        if (user.data) {
          memory.recordMention(mention.author_id, user.data.username);
        }
      } catch {
        // 유저 정보 못 가져오면 ID만으로 기록
        memory.recordMention(mention.author_id, `user_${mention.author_id}`);
      }
    }

    // 언어 감지 (간단한 방식)
    const isEnglish = /^[a-zA-Z0-9\s.,!?@#$%^&*()_+\-=\[\]{}|;':"<>\/\\`~]+$/.test(mention.text.replace(/@\w+/g, '').trim());

    // 팔로워 컨텍스트 가져오기
    const follower = mention.author_id ? memory.getFollower(mention.author_id) : null;
    const followerContext = follower && follower.mentionCount > 1
      ? `\n(이 사람은 ${follower.mentionCount}번째 멘션, 친근하게)`
      : "";

    const message = await claude.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 200,
      system: PIXYMON_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `멘션에 답글 작성.

- 100자 이내
- ${isEnglish ? '영어로 답변' : '한국어로 답변'}
- 질문이면 답변, 아니면 짧은 리액션
- 해시태그 X, 이모지 X${followerContext}

멘션 내용:
${mention.text}`,
        },
      ],
    });

    const replyText = extractTextFromClaude(message.content);

    if (!replyText) return;

    const reply = await twitter.v2.reply(replyText, mention.id);
    console.log(`[OK] 멘션 답글: ${reply.data.id}`);

    // 답글도 메모리에 저장
    memory.saveTweet(reply.data.id, replyText, "reply");
  } catch (error: any) {
    console.error(`[ERROR] 멘션 답글 실패:`, error.message);
  }
}

// 트윗에 답글 달기
export async function replyToTweet(
  twitter: TwitterApi,
  claude: Anthropic,
  tweetId: string,
  tweetText: string
): Promise<void> {
  try {
    // Claude로 답글 생성
    const message = await claude.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 200,
      system: PIXYMON_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `이 트윗에 답글.

- 100자 이내
- 좋은 콜이면 인정 ("ㄹㅇ", "이거 맞는듯")
- 틀린 정보면 팩트로 정정
- 별 내용 없으면 짧게 ("ㅇㅇ", "그치")
- 해시태그 X, 이모지 X
- 자연스러운 유머 ok (억지 X)

트윗:
${tweetText}`,
        },
      ],
    });

    const replyText = extractTextFromClaude(message.content);

    if (!replyText) {
      console.log("[SKIP] 답글 생성 실패");
      return;
    }

    // 답글 발행
    const reply = await twitter.v2.reply(replyText, tweetId);
    console.log(`[OK] 답글 완료: ${reply.data.id}`);
  } catch (error: any) {
    console.error(`[ERROR] 답글 실패:`, error.message);
  }
}

export function isRateLimitError(error: unknown): boolean {
  const err = error as { code?: number; status?: number; data?: { status?: number; title?: string } };
  const title = err?.data?.title?.toLowerCase() ?? "";
  return (
    err?.code === 429 ||
    err?.status === 429 ||
    err?.data?.status === 429 ||
    title.includes("rate")
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 트윗 발행 (Twitter API v2 only)
export async function postTweet(twitter: TwitterApi | null, content: string, type: "briefing" | "reply" | "quote" = "briefing"): Promise<string | null> {
  if (TEST_MODE || !twitter) {
    console.log("🧪 [테스트 모드] 트윗 발행 시뮬레이션:");
    console.log("─".repeat(40));
    console.log(content);
    console.log("─".repeat(40));
    console.log("✅ (실제 트윗은 발행되지 않음)\n");

    // 테스트 모드에서도 메모리에 저장
    const testId = `test_${Date.now()}`;
    memory.saveTweet(testId, content, type);
    return testId;
  }

  let lastError: unknown;
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const tweet = await twitter.v2.tweet(content);
      console.log("✅ 트윗 발행 완료! (v2)");
      console.log(`   ID: ${tweet.data.id}`);
      console.log(`   URL: https://twitter.com/Pixy_mon/status/${tweet.data.id}`);

      memory.saveTweet(tweet.data.id, content, type);
      return tweet.data.id;
    } catch (error) {
      lastError = error;
      const rateLimited = isRateLimitError(error);
      const delayMs = rateLimited ? 60000 * attempt : 2000 * attempt;

      if (attempt === maxAttempts) {
        break;
      }

      console.error(
        `⚠️ 트윗 발행 실패 (시도 ${attempt}/${maxAttempts})${rateLimited ? " [rate limit]" : ""}`
      );
      await sleep(delayMs);
    }
  }

  console.error("❌ 트윗 발행 실패:", lastError);
  throw lastError;
}
