import "dotenv/config";
import { TwitterApi } from "twitter-api-v2";
import Anthropic from "@anthropic-ai/sdk";
import { BlockchainNewsService } from "./services/blockchain-news.js";

/**
 * Pixymon AI Agent - 메인 진입점
 * 트위터 기반 블록체인 뉴스 AI 에이전트
 * 
 * 테스트 모드: TEST_MODE=true 로 설정하면 API 호출 없이 테스트
 */

const TEST_MODE = process.env.TEST_MODE === "true" || true; // 기본값: 테스트 모드

// 환경 변수 검증
function validateEnvironment() {
  const required = [
    "TWITTER_API_KEY",
    "TWITTER_API_SECRET",
    "TWITTER_ACCESS_TOKEN",
    "TWITTER_ACCESS_SECRET",
  ];

  // 테스트 모드가 아닐 때만 ANTHROPIC_API_KEY 필수
  if (!TEST_MODE) {
    required.push("ANTHROPIC_API_KEY");
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
function initTwitterClient(): TwitterApi {
  return new TwitterApi({
    appKey: process.env.TWITTER_API_KEY!,
    appSecret: process.env.TWITTER_API_SECRET!,
    accessToken: process.env.TWITTER_ACCESS_TOKEN!,
    accessSecret: process.env.TWITTER_ACCESS_SECRET!,
  });
}

// Claude 클라이언트 초기화 (테스트 모드에서는 null)
function initClaudeClient(): Anthropic | null {
  if (TEST_MODE) {
    return null;
  }
  return new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY!,
  });
}

// 테스트용 뉴스 요약 생성
function generateTestNewsSummary(newsText: string): string {
  const today = new Date().toLocaleDateString("ko-KR", {
    month: "numeric",
    day: "numeric",
  });

  return `🔥 [테스트] ${today} 블록체인 핫이슈

1️⃣ Bitcoin ETF 거래량 사상 최고치 기록 📈
2️⃣ Ethereum Dencun 업그레이드 성공 ⟠
3️⃣ Solana DeFi TVL 100억 달러 돌파 🚀

📊 마켓: BTC $100K | ETH $3.5K | SOL $180

#블록체인 #크립토 #Bitcoin`;
}

// 테스트용 질문 답변
function generateTestAnswer(question: string): string {
  return `🤖 [테스트 답변]

좋은 질문이에요! "${question.slice(0, 20)}..."에 대해 답변드릴게요.

블록체인은 분산원장 기술로, 데이터를 여러 노드에 저장하여 투명성과 보안성을 확보합니다.

더 궁금한 점 있으시면 물어봐주세요! 💬`;
}

// Claude를 사용해 뉴스 요약 생성
async function generateNewsSummary(
  claude: Anthropic | null,
  newsData: string
): Promise<string> {
  // 테스트 모드
  if (!claude) {
    console.log("🧪 [테스트 모드] Claude 호출 스킵, 테스트 데이터 사용");
    return generateTestNewsSummary(newsData);
  }

  const message = await claude.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 500,
    messages: [
      {
        role: "user",
        content: `당신은 Pixymon이라는 블록체인 뉴스 AI 에이전트입니다.
        
아래 뉴스 데이터를 바탕으로 트위터에 올릴 핫이슈 요약을 작성해주세요.

규칙:
- 280자 이내로 작성
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
  claude: Anthropic | null,
  question: string
): Promise<string> {
  // 테스트 모드
  if (!claude) {
    return generateTestAnswer(question);
  }

  const message = await claude.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 500,
    messages: [
      {
        role: "user",
        content: `당신은 Pixymon이라는 블록체인 전문 AI 에이전트입니다.

규칙:
- 친근하고 이해하기 쉽게 답변
- 280자 이내로 작성 (트위터 답글용)
- 이모지를 적절히 사용
- 투자 조언은 하지 않음 (NFA)
- 한국어로 답변

질문: ${question}`,
      },
    ],
  });

  const textContent = message.content.find((block) => block.type === "text");
  return textContent ? textContent.text : "답변을 생성할 수 없습니다.";
}

// 트윗 발행 (테스트 모드에서는 로그만)
async function postTweet(twitter: TwitterApi, content: string): Promise<void> {
  if (TEST_MODE) {
    console.log("🧪 [테스트 모드] 트윗 발행 시뮬레이션:");
    console.log("─".repeat(40));
    console.log(content);
    console.log("─".repeat(40));
    console.log("✅ (실제 트윗은 발행되지 않음)\n");
    return;
  }

  try {
    const tweet = await twitter.v2.tweet(content);
    console.log("✅ 트윗 발행 완료:", tweet.data.id);
  } catch (error) {
    console.error("❌ 트윗 발행 실패:", error);
    throw error;
  }
}

// 메인 실행
async function main() {
  console.log("🚀 Pixymon AI Agent 시작...");
  console.log("=====================================");
  
  if (TEST_MODE) {
    console.log("🧪 테스트 모드로 실행 중 (API 호출 없음)");
    console.log("   실제 운영 시 index.ts의 TEST_MODE를 false로 변경하세요");
  }
  console.log("=====================================\n");

  validateEnvironment();

  // 클라이언트 초기화
  const twitter = initTwitterClient();
  const claude = initClaudeClient();
  const newsService = new BlockchainNewsService();

  console.log("✅ Twitter 클라이언트 초기화 완료");
  console.log(claude ? "✅ Claude 클라이언트 초기화 완료" : "🧪 Claude 클라이언트 스킵 (테스트 모드)");

  // Twitter 연결 테스트
  try {
    const me = await twitter.v2.me();
    console.log(`✅ Twitter 연결 성공: @${me.data.username}`);
  } catch (error: any) {
    if (error.code === 403 || error.code === 401) {
      console.error("❌ Twitter 인증 실패");
      console.log("💡 Access Token 권한을 확인하세요 (Read and Write 필요)");
    } else {
      console.log("⚠️ Twitter 연결 테스트 스킵 (크레딧 필요할 수 있음)");
    }
  }

  console.log("\n=====================================");
  console.log("📌 Pixymon 기능:");
  console.log("   - 트위터 뉴스 포스팅");
  console.log("   - 블록체인 뉴스 요약");
  console.log("   - 질문 답변");
  console.log("=====================================\n");

  // 뉴스 수집 및 요약 테스트
  try {
    console.log("📰 뉴스 수집 테스트...\n");
    
    const news = await newsService.getTodayHotNews();
    const marketData = await newsService.getMarketData();
    const newsText = newsService.formatNewsForTweet(news, marketData);

    console.log("📋 수집된 뉴스 데이터:");
    console.log("─".repeat(40));
    console.log(newsText);
    console.log("─".repeat(40));

    console.log("\n🤖 AI 요약 생성 중...\n");
    const summary = await generateNewsSummary(claude, newsText);

    console.log("📝 생성된 트윗:");
    await postTweet(twitter, summary);

    // 질문 답변 테스트
    console.log("💬 질문 답변 테스트...\n");
    const testQuestion = "비트코인이 뭐야?";
    console.log(`Q: ${testQuestion}`);
    const answer = await answerQuestion(claude, testQuestion);
    console.log(`A: ${answer}\n`);

  } catch (error) {
    console.error("❌ 테스트 중 오류:", error);
  }

  console.log("=====================================");
  console.log("✅ 테스트 완료!");
  console.log("");
  console.log("📌 다음 단계:");
  console.log("   1. Anthropic API 결제 설정 (Claude 사용)");
  console.log("   2. Twitter API 크레딧 구매 (트윗 발행)");
  console.log("   3. index.ts에서 TEST_MODE = false 로 변경");
  console.log("   4. npm run dev 로 실제 운영 시작");
  console.log("=====================================");

  // 테스트 모드에서는 바로 종료
  if (TEST_MODE) {
    process.exit(0);
  }

  // 프로세스 종료 처리
  process.on("SIGINT", () => {
    console.log("\n🛑 에이전트 종료...");
    process.exit(0);
  });
}

main().catch(console.error);
