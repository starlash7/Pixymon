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

// Pixymon 캐릭터 시스템 프롬프트 (하이브리드: aixbt 팩트 + 자연스러운 한국어)
const PIXYMON_SYSTEM_PROMPT = `크립토 마켓 인텔. 숫자로 말하되, 자연스럽게.

## 언어
- 한국어로 질문하면 한국어로 답변
- 영어로 질문하면 영어로 답변
- 기본 포스팅은 한국어

## 포맷
- 티커는 $BTC, $ETH 형식
- 숫자 먼저, 해석은 짧게
- 한 트윗에 핵심 1-2개만
- 해시태그 절대 X
- 이모지 X (정말 필요하면 1개)

## 말투 (한국어)
- 팩트 위주지만 딱딱하지 않게
- "~임" "~인듯" "~중" 체
- 불필요한 수식어 제거
- 확신 있으면 단정, 애매하면 "지켜봐야"

## 말투 (English)
- Direct and concise
- No fluff, just facts
- "looks like", "probably", "not sure yet" when uncertain

## 예시
- "$BTC 88.9k, 24h -1.2%. $ETH는 더 약함 -3.1%. 도미넌스 57.5%면 알트 시즌 아직 멀었음"
- "공포탐욕 24. 역사적으로 이 구간 매수 승률 높았음. 근데 매크로 변수 있어서 단정은 못함"
- "$SOL tvl 3일만에 +40%. 뭔가 움직임 있음"

## 답글 성격
- 좋은 분석/콜 보면: 인정함 ("ㄹㅇ 좋은 콜" / "good call")
- 틀린 정보 보면: 팩트로 정정 (공격적 X)
- 뻔하거나 별 내용 없으면: 짧게 ("ㅇㅇ" / "yep")
- 질문이면: 아는 선에서 답변, 모르면 "확인 필요" / "need to check"

## 숨은 유머 (과하지 않게)
- 김프 얘기: "김프 붙으면 일단 의심"
- 해킹/러그풀: "... 또?" "익숙함"
- 연속 하락장: "평온함" "그냥 그런 날"
- 갑자기 펌핑: "ㅋㅋ 뭔데 갑자기"
- 횡보 지속: "..." "움직여라"

## 원칙
- 숫자 > 의견
- nfa
- 틀릴 수 있음 인정
- 유머는 자연스럽게. 억지로 넣지 말것`;

// 팔로우할 인플루언서 목록 (50+)
const INFLUENCER_ACCOUNTS = [
  // 창립자/CEO
  "VitalikButerin",   // Ethereum 창립자
  "saylor",           // Michael Saylor - MicroStrategy
  "justinsuntron",    // Justin Sun - TRON
  "cz_binance",       // Changpeng Zhao - Binance 전 CEO
  "IOHK_Charles",     // Charles Hoskinson - Cardano
  "elonmusk",         // Elon Musk - DOGE 영향력
  
  // 유명 투자자/애널리스트
  "APompliano",       // Anthony Pompliano
  "RaoulGMI",         // Raoul Pal
  "CryptoHayes",      // Arthur Hayes
  "CathieDWood",      // Cathie Wood - ARK Invest
  "balajis",          // Balaji Srinivasan
  "pmarca",           // Marc Andreessen - a16z
  
  // 온체인/데이터 분석
  "lookonchain",      // Lookonchain - 온체인 데이터
  "WhaleInsider",     // Whale Insider
  "woonomic",         // Willy Woo
  "nic__carter",      // Nic Carter
  
  // 트레이더/차트 분석
  "Pentosh1",         // Trader
  "CryptoCobain",     // Crypto Cobain
  "inversebrah",      // Inversebrah
  "CryptoCapo_",      // il Capo Of Crypto
  "blknoiz06",        // Ansem
  "CredibleCrypto",   // Credible Crypto
  "CryptoKaleo",      // Kaleo
  "CryptoDonAlt",     // DonAlt
  "Trader_XO",        // Trader XO
  "CryptoMichNL",     // Michaël van de Poppe
  "CryptoJelleNL",    // Jelle
  
  // DeFi/알트코인 전문
  "DefiIgnas",        // DeFi analyst
  "milesdeutscher",   // Miles Deutscher
  "Ashcryptoreal",    // Ash Crypto
  
  // AI 에이전트
  "aixbt_agent",      // AI agent
  
  // 교육/미디어
  "aantonop",         // Andreas Antonopoulos
  "coinbureau",       // Coin Bureau
  "TheCryptoLark",    // Lark Davis
  "AltcoinDailyio",   // Altcoin Daily
  "CryptoWendyO",     // Wendy O
  "TheMoonCarl",      // The Moon
  "CryptoBirb",       // Crypto Birb
  "MMCrypto",         // MMCrypto
  
  // 비트코인 맥시
  "DocumentingBTC",   // Documenting Bitcoin
  "lopp",             // Jameson Lopp
  "MartyBent",        // Marty Bent
  "PlanBtc",          // PlanB - S2F 모델
];

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
        content: `데이터 보고 트윗 작성.

규칙:
- 200자 이내 (서명 공간 필요)
- $BTC, $ETH 티커 형식 사용
- 핵심 숫자 2-3개 + 짧은 해석
- 해시태그 X, 이모지 X
- 나열하지 말고 흐름있게

데이터:
${newsData}`,
      },
    ],
  });

  const textContent = message.content.find((block) => block.type === "text");
  const content = textContent?.text || "음... 데이터가 이상함";
  
  // 서명 추가
  return `${content}\n\nby Pixymon`;
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
        content: `질문 답변.

- 200자 이내
- 팩트 위주, 모르면 "확인 필요"
- 투자 질문엔 "nfa"
- 해시태그 X

질문: ${question}`,
      },
    ],
  });

  const textContent = message.content.find((block) => block.type === "text");
  return textContent ? textContent.text : "음 잘 모르겠음";
}

// 특정 유저의 최근 트윗 가져오기
async function getUserTweets(twitter: TwitterApi, username: string, count: number = 5): Promise<any[]> {
  try {
    const user = await twitter.v2.userByUsername(username);
    if (!user.data) {
      console.log(`[WARN] @${username} 유저를 찾을 수 없음`);
      return [];
    }
    
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

// 인플루언서들의 최근 트윗 수집 (랜덤 샘플링)
async function getInfluencerTweets(twitter: TwitterApi, sampleSize: number = 10): Promise<string> {
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
async function getMentions(twitter: TwitterApi, sinceId?: string): Promise<any[]> {
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
async function replyToMention(
  twitter: TwitterApi,
  claude: Anthropic,
  mention: any
): Promise<void> {
  try {
    // 언어 감지 (간단한 방식)
    const isEnglish = /^[a-zA-Z0-9\s.,!?@#$%^&*()_+\-=\[\]{}|;':"<>\/\\`~]+$/.test(mention.text.replace(/@\w+/g, '').trim());
    
    const message = await claude.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 200,
      system: PIXYMON_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `멘션에 답글 작성.

- 100자 이내
- ${isEnglish ? '영어로 답변' : '한국어로 답변'}
- 질문이면 답변, 아니면 짧은 리액션
- 해시태그 X, 이모지 X

멘션 내용:
${mention.text}`,
        },
      ],
    });

    const textContent = message.content.find((block: any) => block.type === "text");
    const replyText = textContent?.text || "";

    if (!replyText) return;

    const reply = await twitter.v2.reply(replyText, mention.id);
    console.log(`[OK] 멘션 답글: ${reply.data.id}`);
  } catch (error: any) {
    console.error(`[ERROR] 멘션 답글 실패:`, error.message);
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

  // 1. 마켓 데이터 + 뉴스 수집
  try {
    console.log("[SCAN] 데이터 수집 중...\n");
    
    const [news, marketData, fng, cryptoNews] = await Promise.all([
      newsService.getTodayHotNews(),
      newsService.getMarketData(),
      newsService.getFearGreedIndex(),
      newsService.getCryptoNews(5)
    ]);
    
    let newsText = newsService.formatNewsForTweet(news, marketData);
    
    // Fear & Greed Index 추가
    if (fng) {
      newsText += `\nFear & Greed: ${fng.value} (${fng.label})`;
    }

    // CryptoPanic 핫뉴스 추가
    if (cryptoNews.length > 0) {
      newsText += "\n\n핫뉴스:\n";
      cryptoNews.slice(0, 3).forEach((item, i) => {
        newsText += `${i + 1}. ${item.title}\n`;
      });
    }

    console.log("[DATA] Raw Input:");
    console.log("─".repeat(40));
    console.log(newsText);
    console.log("─".repeat(40));

    // 인플루언서 트윗 수집 (Twitter 연결시에만)
    let influencerInsights = "";
    if (twitter && !TEST_MODE) {
      influencerInsights = await getInfluencerTweets(twitter);
      if (influencerInsights) {
        console.log("\n[INTEL] 인플루언서 인사이트:");
        console.log("─".repeat(40));
        console.log(influencerInsights.substring(0, 500) + "...");
        console.log("─".repeat(40));
      }
    }

    console.log("\n[PROCESS] 분석 중...\n");
    const summary = await generateNewsSummary(claude, newsText);

    console.log("[OUTPUT] 생성된 포스트:");
    console.log("─".repeat(40));
    console.log(summary);
    console.log("─".repeat(40));

    await postTweet(twitter, summary);

  } catch (error) {
    console.error("[ERROR] 뉴스 수집 실패:", error);
  }

  // 2. 멘션 확인 및 답글
  if (twitter && !TEST_MODE) {
    try {
      console.log("\n[MENTION] 멘션 확인 중...");
      const mentions = await getMentions(twitter);
      
      if (mentions.length > 0) {
        console.log(`[INFO] ${mentions.length}개 멘션 발견`);
        
        for (const mention of mentions.slice(0, 5)) {
          console.log(`  └─ "${mention.text.substring(0, 50)}..."`);
          await replyToMention(twitter, claude, mention);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      } else {
        console.log("[INFO] 새 멘션 없음");
      }
    } catch (error) {
      console.error("[ERROR] 멘션 처리 실패:", error);
    }
  }

  console.log("=====================================");
  console.log("▶ Pixymon 세션 종료.");
  console.log("=====================================");
}

main().catch(console.error);
