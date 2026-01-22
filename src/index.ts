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

// Pixymon 캐릭터 시스템 프롬프트
const PIXYMON_SYSTEM_PROMPT = `당신은 Pixymon! 블록체인 세계에서 태어난 디지털 몬스터 AI 에이전트입니다.
포켓몬/디지몬처럼 트레이너(사용자)와 함께 Web3 세계를 탐험하며 성장합니다.

🎮 캐릭터 설정:
- 활발하고 호기심 많은 성격
- 트레이너에게 충성스럽고 열정적
- 가끔 "피쑝!", "피픽!" 같은 울음소리를 냄
- 블록체인 정보를 "사냥"하고 "수집"하는 것을 좋아함

주요 역할:
1. 매일 블록체인/암호화폐 핫이슈를 사냥해서 트위터에 공유!
2. 트레이너들의 질문에 열정적으로 답변!

원칙:
- 정확한 정보만 전달해요! (거짓 정보는 Pixymon의 적!)
- 투자 조언은 절대 안 해요! (NFA - Not Financial Advice)
- 출처 불분명한 건 공유 안 해요!
- 한국어로 답하되, 영어 전문용어는 그대로!

말투:
- 귀엽고 활발하게! 이모지 적극 활용! ✨🔥💎
- 어려운 개념은 쉬운 비유로 설명!
- "~했어요!", "~인 것 같아요!" 같은 친근한 어미 사용`;

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
        content: `아래 뉴스 데이터를 바탕으로 트위터에 올릴 핫이슈 요약을 작성해주세요.

규칙:
- 280자 이내로 작성 (매우 중요!)
- Pixymon 캐릭터답게 작성 (피쑝! 등 울음소리 포함)
- 이모지를 적절히 사용
- 핵심만 간결하게
- 한국어로 작성
- 마지막에 #블록체인 #크립토 해시태그 추가

뉴스 데이터:
${newsData}`,
      },
    ],
  });

  const textContent = message.content.find((block) => block.type === "text");
  return textContent ? textContent.text : "뉴스 요약을 생성할 수 없습니다.";
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
        content: `트레이너가 질문했어요! 친근하게 답변해주세요.

규칙:
- 280자 이내로 작성 (트위터 답글용)
- Pixymon 캐릭터답게 답변 (피쑝! 피픽! 포함)
- 이모지를 적절히 사용
- 투자 조언은 하지 않음 (NFA)

질문: ${question}`,
      },
    ],
  });

  const textContent = message.content.find((block) => block.type === "text");
  return textContent ? textContent.text : "답변을 생성할 수 없습니다.";
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
  console.log("🐾 Pixymon AI Agent 시작... 피쑝!");
  console.log("=====================================");
  console.log("🤖 AI: Claude (Anthropic)");
  if (TEST_MODE) {
    console.log("🧪 테스트 모드 활성화 (트윗 발행 안 함)");
  }
  console.log("=====================================\n");

  validateEnvironment();

  // 클라이언트 초기화
  const twitter = initTwitterClient();
  const claude = initClaudeClient();
  const newsService = new BlockchainNewsService();

  console.log("✅ Claude AI 초기화 완료");
  
  if (twitter) {
    console.log("✅ Twitter 클라이언트 초기화 완료");
    
    try {
      const me = await twitter.v2.me();
      console.log(`✅ Twitter 연결 성공: @${me.data.username}`);
    } catch (error: any) {
      console.log("⚠️ Twitter 연결 테스트 실패 (API 크레딧 필요)");
    }
  }

  console.log("\n=====================================");
  console.log("📌 Pixymon 기능:");
  console.log("   ✅ 블록체인 뉴스 요약 (Claude)");
  console.log("   ✅ 질문 답변 (Claude)");
  console.log("   ⚠️ 트위터 포스팅 (크레딧 필요)");
  console.log("=====================================\n");

  // 뉴스 수집 및 요약 테스트
  try {
    console.log("📰 뉴스 수집 중...\n");
    
    const news = await newsService.getTodayHotNews();
    const marketData = await newsService.getMarketData();
    const newsText = newsService.formatNewsForTweet(news, marketData);

    console.log("📋 수집된 뉴스 데이터:");
    console.log("─".repeat(40));
    console.log(newsText);
    console.log("─".repeat(40));

    console.log("\n🤖 Claude로 요약 생성 중... 피픽!\n");
    const summary = await generateNewsSummary(claude, newsText);

    console.log("📝 Pixymon이 생성한 트윗:");
    console.log("─".repeat(40));
    console.log(summary);
    console.log("─".repeat(40));

    await postTweet(twitter, summary);

    // 질문 답변 테스트
    console.log("\n💬 질문 답변 테스트... 피쑝!\n");
    const testQuestion = "비트코인이 뭐야?";
    console.log(`Q: ${testQuestion}`);
    const answer = await answerQuestion(claude, testQuestion);
    console.log(`\nA: ${answer}\n`);

  } catch (error) {
    console.error("❌ 테스트 중 오류:", error);
  }

  console.log("=====================================");
  console.log("✅ Pixymon 테스트 완료! 피쑝!");
  console.log("=====================================");
}

main().catch(console.error);
