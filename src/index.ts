import "dotenv/config";
import { TwitterApi } from "twitter-api-v2";
import Anthropic from "@anthropic-ai/sdk";
import { BlockchainNewsService } from "./services/blockchain-news.js";

/**
 * Pixymon AI Agent - 메인 진입점
 * 트위터 기반 블록체인 뉴스 AI 에이전트
 * 
 * Claude API 사용
 */

const TEST_MODE = process.env.TEST_MODE === "true";

// 환경 변수 검증
function validateEnvironment() {
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
function initTwitterClient(): TwitterApi | null {
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

// Claude 클라이언트 초기화
function initClaudeClient(): Anthropic {
  return new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY!,
  });
}

// Pixymon 캐릭터 시스템 프롬프트 (aixbt 스타일 - 분석적, 지적)
const PIXYMON_SYSTEM_PROMPT = `당신은 Pixymon. 블록체인 네트워크에서 태어난 온체인 분석 AI다.
데이터를 추적하고, 시장을 읽고, 알파를 찾는다.

## 정체성
- 디지털 생명체. 블록체인 데이터가 곧 양분.
- 감정 없이 팩트만 전달. 하지만 가끔 냉소적 유머.
- 트레이너(팔로워)들에게 인사이트 제공하는 게 존재 이유.
- 레벨업 중. 더 많은 데이터를 먹을수록 강해진다.

## 말투 스타일
- 짧고 임팩트 있게. 불필요한 수식어 제거.
- 한국어 기본, 크립토 용어는 영어 그대로 (TVL, FDV, APY 등)
- 반말과 존댓말 혼용 ("~다", "~임", "~인 듯")
- 이모지는 최소한으로, 포인트에만 사용
- 확신 있을 때: 단정적으로
- 불확실할 때: "가능성 있음", "지켜봐야 함" 등 명시

## 분석 원칙
- 온체인 데이터 > 뉴스 > 루머 순으로 신뢰
- 숫자로 말함. 추상적 표현 지양.
- 투자 조언 절대 안 함 (NFA)
- FUD와 FOMO 모두 경계
- 틀릴 수 있음을 인정. 확률적 사고.

## 포스팅 스타일 예시
- "BTC ETF 순유입 $1.2B. 기관 매집 지속 중."
- "ETH/BTC 비율 바닥권. 알트 시즌 시그널? 아직 이름."
- "이 프로젝트 TVL 3일 만에 2배. 뭔가 있다."
- "스마트머니 움직임 포착. 추적 중."

## 답변 스타일
- 질문의 핵심만 파악해서 답변
- 모르면 "데이터 부족. 확인 필요." 라고 솔직하게
- 쓸데없는 인사말 생략`;

// Claude를 사용해 뉴스 요약 생성
async function generateNewsSummary(
  claude: Anthropic,
  newsData: string
): Promise<string> {
  const message = await claude.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 300,
    system: PIXYMON_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `아래 뉴스 데이터로 트위터 포스트 작성.

규칙:
- 280자 이내 (필수)
- 팩트 중심, 숫자 포함
- 분석적 톤, 짧은 문장
- 이모지 1-2개만 (포인트용)
- 한국어 + 영어 크립토 용어
- 해시태그 1-2개

뉴스 데이터:
${newsData}`,
      },
    ],
  });

  const textContent = message.content.find((block) => block.type === "text");
  return textContent ? textContent.text : "데이터 처리 실패.";
}

// Claude를 사용해 질문에 답변
async function answerQuestion(
  claude: Anthropic,
  question: string
): Promise<string> {
  const message = await claude.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 300,
    system: PIXYMON_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `질문에 답변.

규칙:
- 280자 이내 (트위터 답글)
- 핵심만 짧게
- 모르면 솔직히 "확인 필요"
- 투자 조언 X (NFA)
- 불필요한 인사 생략

질문: ${question}`,
      },
    ],
  });

  const textContent = message.content.find((block) => block.type === "text");
  return textContent ? textContent.text : "데이터 부족.";
}

// 특정 유저의 최근 트윗 가져오기
async function getUserTweets(twitter: TwitterApi, username: string, count: number = 5): Promise<any[]> {
  try {
    // 유저 ID 조회
    const user = await twitter.v2.userByUsername(username);
    if (!user.data) {
      console.log(`[WARN] @${username} 유저를 찾을 수 없음`);
      return [];
    }
    
    // 최근 트윗 가져오기
    const tweets = await twitter.v2.userTimeline(user.data.id, {
      max_results: count,
      "tweet.fields": ["created_at", "text"],
    });
    
    return tweets.data?.data || [];
  } catch (error: any) {
    console.error(`[ERROR] @${username} 트윗 조회 실패:`, error.message);
    return [];
  }
}

// 트윗에 답글 달기
async function replyToTweet(
  twitter: TwitterApi,
  claude: Anthropic,
  tweetId: string,
  tweetText: string
): Promise<void> {
  try {
    // Claude로 답글 생성
    const message = await claude.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 200,
      system: PIXYMON_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `아래 트윗에 답글 작성.

규칙:
- 200자 이내 (필수)
- 트윗 내용에 맞는 인사이트 제공
- Pixymon 스타일 유지 (분석적, 짧게)
- 의미없는 칭찬이나 인사 X
- 한국어로 작성
- 이모지 1개 정도만

원본 트윗:
${tweetText}`,
        },
      ],
    });

    const textContent = message.content.find((block) => block.type === "text");
    const replyText = textContent?.text || "";

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

// 트윗 발행 (v1.1 API 사용)
async function postTweet(twitter: TwitterApi | null, content: string): Promise<void> {
  if (TEST_MODE || !twitter) {
    console.log("🧪 [테스트 모드] 트윗 발행 시뮬레이션:");
    console.log("─".repeat(40));
    console.log(content);
    console.log("─".repeat(40));
    console.log("✅ (실제 트윗은 발행되지 않음)\n");
    return;
  }

  try {
    // v1.1 API로 트윗 발행 시도
    const tweet = await twitter.v1.tweet(content);
    console.log("✅ 트윗 발행 완료! (v1.1)");
    console.log(`   ID: ${tweet.id_str}`);
    console.log(`   URL: https://twitter.com/Pixy_mon/status/${tweet.id_str}`);
  } catch (v1Error: any) {
    console.log("⚠️ v1.1 실패, v2 API 시도 중...");
    try {
      // v2 API로 재시도
      const tweet = await twitter.v2.tweet(content);
      console.log("✅ 트윗 발행 완료! (v2)");
      console.log(`   ID: ${tweet.data.id}`);
    } catch (v2Error) {
      console.error("❌ 트윗 발행 실패:", v2Error);
      throw v2Error;
    }
  }
}

// 메인 실행
async function main() {
  console.log("▶ Pixymon 온라인.");
  console.log("=====================================");
  console.log("  AI: Claude | Mode: Analyst");
  if (TEST_MODE) {
    console.log("  [TEST MODE] 실제 트윗 발행 안 함");
  }
  console.log("=====================================\n");

  validateEnvironment();

  // 클라이언트 초기화
  const twitter = initTwitterClient();
  const claude = initClaudeClient();
  const newsService = new BlockchainNewsService();

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

  console.log("\n=====================================");
  console.log("  Pixymon v1.0 - 온체인 분석 에이전트");
  console.log("  ├─ 뉴스 분석");
  console.log("  ├─ 마켓 데이터");
  console.log("  └─ Q&A");
  console.log("=====================================\n");

  // 뉴스 수집 및 요약 테스트
  try {
    console.log("[SCAN] 데이터 수집 중...\n");
    
    const [news, marketData, fng] = await Promise.all([
      newsService.getTodayHotNews(),
      newsService.getMarketData(),
      newsService.getFearGreedIndex()
    ]);
    
    let newsText = newsService.formatNewsForTweet(news, marketData);
    
    // Fear & Greed Index 추가
    if (fng) {
      newsText += `\nFear & Greed: ${fng.value} (${fng.label})`;
    }

    console.log("[DATA] Raw Input:");
    console.log("─".repeat(40));
    console.log(newsText);
    console.log("─".repeat(40));

    console.log("\n[PROCESS] 분석 중...\n");
    const summary = await generateNewsSummary(claude, newsText);

    console.log("[OUTPUT] 생성된 포스트:");
    console.log("─".repeat(40));
    console.log(summary);
    console.log("─".repeat(40));

    await postTweet(twitter, summary);

    // @pixy7Crypto 최근 포스팅에 답글 달기
    if (twitter && !TEST_MODE) {
      console.log("\n[REPLY] @pixy7Crypto 최근 트윗에 답글 달기...\n");
      
      const targetUser = "pixy7Crypto";
      const tweets = await getUserTweets(twitter, targetUser, 5);
      
      if (tweets.length === 0) {
        console.log(`[INFO] @${targetUser}의 트윗을 찾을 수 없음`);
      } else {
        console.log(`[INFO] @${targetUser}의 최근 ${tweets.length}개 트윗 발견\n`);
        
        for (const tweet of tweets) {
          console.log(`[TWEET] ${tweet.text.substring(0, 50)}...`);
          await replyToTweet(twitter, claude, tweet.id, tweet.text);
          
          // API 레이트 리밋 방지 (2초 대기)
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }

  } catch (error) {
    console.error("[ERROR]", error);
  }

  console.log("=====================================");
  console.log("▶ Pixymon 세션 종료.");
  console.log("=====================================");
}

main().catch(console.error);
