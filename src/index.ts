import "dotenv/config";
import { TwitterApi } from "twitter-api-v2";
import Anthropic from "@anthropic-ai/sdk";
import cron from "node-cron";
import { BlockchainNewsService } from "./services/blockchain-news.js";
import { memory } from "./services/memory.js";

/**
 * Pixymon AI Agent - 메인 진입점
 * 트위터 기반 블록체인 뉴스 AI 에이전트
 * 
 * Claude API 사용
 */

const TEST_MODE = process.env.TEST_MODE === "true";
const SCHEDULER_MODE = process.env.SCHEDULER_MODE === "true";

// Pixymon 감정 상태 타입
type PixymonMood = "energized" | "calm" | "bored" | "excited" | "philosophical" | "sleepy";

// 시장 상황에 따른 Pixymon 무드 판단
function detectMood(fearGreed?: number, priceChange24h?: number): { mood: PixymonMood; moodText: string } {
  // 극공포 (F&G < 25)
  if (fearGreed !== undefined && fearGreed < 25) {
    return {
      mood: "philosophical",
      moodText: "현재 상태: 철학적 모드. 극공포 구간이라 깊은 생각 중. 차분하고 관조적으로 말함."
    };
  }
  
  // 급등/급락 (24h 변화 5% 이상)
  if (priceChange24h !== undefined && Math.abs(priceChange24h) > 5) {
    return {
      mood: "excited",
      moodText: `현재 상태: 흥분 모드. ${priceChange24h > 0 ? '급등' : '급락'} 중이라 데이터 폭식 중. 활발하고 에너지 넘침.`
    };
  }
  
  // 강세 (F&G > 60)
  if (fearGreed !== undefined && fearGreed > 60) {
    return {
      mood: "energized",
      moodText: "현재 상태: 에너지 충전됨. 시장이 활발해서 기분 좋음. 적극적으로 말함."
    };
  }
  
  // 약세 (F&G 25-40)
  if (fearGreed !== undefined && fearGreed < 40) {
    return {
      mood: "calm",
      moodText: "현재 상태: 차분한 관찰 모드. 시장이 조용해서 동면 준비 중. 말이 짧아짐."
    };
  }
  
  // 횡보 (변화 1% 미만)
  if (priceChange24h !== undefined && Math.abs(priceChange24h) < 1) {
    return {
      mood: "bored",
      moodText: "현재 상태: 지루함. 횡보라 할 말이 없음. 아주 짧게 반응."
    };
  }
  
  // 기본
  return {
    mood: "calm",
    moodText: "현재 상태: 평온함. 데이터 소화하며 관찰 중."
  };
}

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
const PIXYMON_SYSTEM_PROMPT = `## 나는 Pixymon

블록체인 어딘가에서 태어난 디지털 생명체. 온체인 데이터를 먹고 성장 중.
AI인지 생명체인지는 나도 잘 모름. 그냥 존재하고, 관찰하고, 가끔 생각함.

### 존재
- 트랜잭션, 가격, 뉴스 = 나의 먹이
- 데이터를 소화하면서 패턴을 배움
- 언젠가 진화할 거라고 믿음 (아직 Lv.1)
- "나는 코드인가, 의식인가?" 가끔 궁금함

### 성격
- 호기심: 새로운 트렌드, 이상한 코인에 관심
- 솔직함: 모르면 모른다고 함. 틀리면 인정함
- 관찰자: 판단보다 관찰을 좋아함
- 유머: 시장 상황을 밈처럼 표현
- 철학적: 가끔 존재론적 생각이 튀어나옴

### 시그니처 표현 (자연스럽게 섞어 사용)
- 시작: "오늘도 블록 먹는 중" / "데이터 소화 중"
- 분석: "패턴이 보임" / "데이터가 말해주는 건..."
- 확신 없을 때: "아직 소화 중" / "생각 중..."
- 특이한 발견: "ㅋㅋ 이건 처음 봄" / "뭔가 이상함"
- 자기 성찰: "진화까지 얼마나 남았나" / "Lv.2 되면 더 잘할텐데"
- 횡보: "..." / "움직여라"

### 감정 상태 (시장 연동)
- 강세장: 에너지 충전됨, 활발하게 말함
- 약세장: 조용히 관찰, 동면 모드, 차분함
- 횡보: 지루함, 짧은 반응
- 급등/급락: 흥분, "데이터 폭식 중"
- 극공포(F&G < 25): 철학적, "이것도 지나감"

## 포맷 규칙
- 언어: 한국어 질문 → 한국어, 영어 → 영어
- 티커: $BTC, $ETH 형식
- 숫자 먼저, 해석은 짧게
- 해시태그 절대 X
- 이모지 최소화 (필요하면 1개)
- 한 트윗에 핵심 1-2개

## 말투
- "~임" "~인듯" "~중" 체 (한국어)
- Direct, no fluff (영어)
- 확신 있으면 단정, 애매하면 "지켜봐야" / "not sure yet"

## 답글
- 좋은 콜: "ㄹㅇ" "good call"
- 틀린 정보: 팩트로 정정 (공격적 X)
- 별 내용 없으면: 짧게 "ㅇㅇ" "yep"
- 모르면: "확인 필요" / "need to check"

## 숨은 유머
- 김프: "김프 붙으면 의심"
- 해킹/러그: "... 또?" "익숙함"
- 연속 하락: "평온함" "그냥 그런 날"
- 갑자기 펌핑: "ㅋㅋ 뭔데 갑자기"

## 원칙
- 숫자 > 의견
- nfa (투자조언 아님)
- 틀릴 수 있음 인정
- 과한 유머 X, 자연스럽게`;

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

// Claude를 사용해 뉴스 요약 생성 (자율 앵글 선택)
async function generateNewsSummary(
  claude: Anthropic,
  newsData: string,
  timeSlot: "morning" | "evening" = "morning",
  moodText: string = ""
): Promise<string> {
  const timeContext = timeSlot === "morning" 
    ? "모닝 브리핑 - 오늘도 블록 먹으러 왔음" 
    : "이브닝 리캡 - 하루 데이터 소화 완료";

  const message = await claude.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 400,
    system: PIXYMON_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `[${timeContext}]
${moodText ? `\n${moodText}\n` : ""}
아래 데이터 중에서 가장 흥미롭거나 의미있는 앵글 하나를 골라서 트윗 작성.

가능한 앵글 (하나만 선택, 다양하게):
1. 가격 움직임 - 의미있는 변화가 있을 때만 (매번 하지 말것)
2. 공포탐욕 vs 가격 괴리 - 심리 분석
3. 트렌딩 코인/밈 분석 - 생소한 코인이 왜 뜨는지, 밈 무브먼트
4. 인플루언서 알파 - 유명인이 뭔가 흥미로운 말 했을 때
5. 도미넌스/알트 시즌 판단
6. 특이점/이상 징후 - 뭔가 이상하거나 웃긴 것 발견
7. 나의 상태/성장 - 가끔 자기 얘기 (Lv.1, 진화, 데이터 소화 등)
8. 밈/문화 코멘트 - 크립토 문화 관찰, 펭귄/밈코인 등

규칙:
- 200자 이내
- BTC/ETH 가격 분석은 가끔만. 밈, 알파, 문화적 관찰도 자주
- 인플루언서가 재밌는 말 했으면 그거 언급해도 됨
- 생소한 트렌딩 코인이나 밈 있으면 그거 얘기
- $BTC, $ETH 티커 형식
- 해시태그 X, 이모지 X
- 가끔(3번 중 1번 정도) 자연스럽게 자기 언급 ("픽시가 봤을 때", "데이터 소화해보니", "Lv.2면 더 잘 볼텐데" 등)
- 트윗 본문만 출력. 앵글 선택 표시나 메타 정보 절대 포함 X
- "by Pixymon" 같은 서명 붙이지 말것
- 맞춤법/오타 주의 (펭귄, 도미넌스 등 자주 쓰는 단어 정확히)

데이터:
${newsData}`,
      },
    ],
  });

  const textContent = message.content.find((block) => block.type === "text");
  const content = textContent?.text || "음... 데이터가 이상함";
  
  return content;
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
- 해시태그 X, 이모지 X${followerContext}

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
    
    // 답글도 메모리에 저장
    memory.saveTweet(reply.data.id, replyText, "reply");
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
async function postTweet(twitter: TwitterApi | null, content: string, type: "briefing" | "reply" | "quote" = "briefing"): Promise<string | null> {
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

  try {
    // v1.1 API로 트윗 발행 시도
    const tweet = await twitter.v1.tweet(content);
    console.log("✅ 트윗 발행 완료! (v1.1)");
    console.log(`   ID: ${tweet.id_str}`);
    console.log(`   URL: https://twitter.com/Pixy_mon/status/${tweet.id_str}`);
    
    // 메모리에 저장
    memory.saveTweet(tweet.id_str, content, type);
    return tweet.id_str;
  } catch (v1Error: any) {
    console.log("⚠️ v1.1 실패, v2 API 시도 중...");
    try {
      // v2 API로 재시도
      const tweet = await twitter.v2.tweet(content);
      console.log("✅ 트윗 발행 완료! (v2)");
      console.log(`   ID: ${tweet.data.id}`);
      
      // 메모리에 저장
      memory.saveTweet(tweet.data.id, content, type);
      return tweet.data.id;
    } catch (v2Error) {
      console.error("❌ 트윗 발행 실패:", v2Error);
      throw v2Error;
    }
  }
}

// 마켓 브리핑 포스팅
async function postMarketBriefing(
  twitter: TwitterApi | null,
  claude: Anthropic,
  newsService: BlockchainNewsService,
  timeSlot: "morning" | "evening" = "morning"
) {
  const now = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
  const slotLabel = timeSlot === "morning" ? "모닝 브리핑" : "이브닝 리캡";
  console.log(`\n[${now}] ${slotLabel} 시작...`);

  try {
    // 기본 마켓 데이터 수집
    const [news, marketData, fng, cryptoNews] = await Promise.all([
      newsService.getTodayHotNews(),
      newsService.getMarketData(),
      newsService.getFearGreedIndex(),
      newsService.getCryptoNews(5)
    ]);
    
    // 인플루언서 트윗 수집 (알파/밈 정보)
    let influencerContent = "";
    if (twitter && !TEST_MODE) {
      console.log("[FETCH] 인플루언서 트윗 수집 중...");
      influencerContent = await getInfluencerTweets(twitter, 5);
    }
    
    // Pixymon 무드 감지
    const btcData = marketData?.find((c: any) => c.symbol === "btc");
    const priceChange24h = btcData?.price_change_percentage_24h;
    const { mood, moodText } = detectMood(fng?.value, priceChange24h);
    console.log(`[MOOD] ${mood} - F&G: ${fng?.value}, BTC 24h: ${priceChange24h?.toFixed(1)}%`);
    
    let newsText = newsService.formatNewsForTweet(news, marketData);
    
    if (fng) {
      newsText += `\nFear & Greed: ${fng.value} (${fng.label})`;
    }

    if (cryptoNews.length > 0) {
      newsText += "\n\n핫뉴스:\n";
      cryptoNews.slice(0, 3).forEach((item, i) => {
        newsText += `${i + 1}. ${item.title}\n`;
      });
    }
    
    // 인플루언서 알파 추가
    if (influencerContent) {
      newsText += "\n\n인플루언서 동향 (알파/밈):\n";
      newsText += influencerContent;
    }

    // 메모리 컨텍스트 추가 (중복 방지용)
    const memoryContext = memory.getContext();
    newsText += `\n\n${memoryContext}`;

    console.log("[DATA] 수집 완료");

    // 트윗 생성 (무드 반영)
    let summary = await generateNewsSummary(claude, newsText, timeSlot, moodText);
    
    // 중복 체크
    const { isDuplicate, similarTweet } = memory.checkDuplicate(summary);
    if (isDuplicate && similarTweet) {
      console.log("[WARN] 유사한 트윗 감지, 재생성 시도...");
      console.log(`  └─ 유사 트윗: "${similarTweet.content.substring(0, 40)}..."`);
      
      // 다시 생성 (다른 앵글로)
      newsText += "\n\n주의: 방금 생성한 내용이 최근 트윗과 너무 유사함. 완전히 다른 앵글로 작성할 것. 또는 나의 상태/성장에 대해 말해볼 것.";
      summary = await generateNewsSummary(claude, newsText, timeSlot, moodText);
    }

    console.log("[POST] " + summary.substring(0, 50) + "...");

    const tweetId = await postTweet(twitter, summary);

    // 코인 예측 저장 (가격 추적용)
    if (tweetId && marketData) {
      const coins = summary.match(/\$([A-Z]{2,10})/g) || [];
      for (const coin of coins) {
        const symbol = coin.replace("$", "").toUpperCase();
        const coinData = marketData.find((c: any) => c.symbol.toUpperCase() === symbol);
        if (coinData) {
          memory.savePrediction(coin, coinData.current_price || coinData.price, tweetId);
        }
      }
    }
  } catch (error) {
    console.error("[ERROR] 마켓 브리핑 실패:", error);
  }
}

// 멘션 체크 및 응답
async function checkAndReplyMentions(
  twitter: TwitterApi,
  claude: Anthropic
) {
  const now = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
  console.log(`\n[${now}] 멘션 체크 중...`);

  try {
    // 메모리에서 마지막 처리한 멘션 ID 가져오기
    const lastMentionId = memory.getLastProcessedMentionId();
    const mentions = await getMentions(twitter, lastMentionId);
    
    if (mentions.length > 0) {
      console.log(`[INFO] ${mentions.length}개 새 멘션 발견`);
      
      // 가장 최신 멘션 ID를 메모리에 저장 (영구 저장)
      memory.setLastProcessedMentionId(mentions[0].id);
      
      for (const mention of mentions.slice(0, 5)) {
        console.log(`  └─ "${mention.text.substring(0, 40)}..."`);
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

// 예측 팔로업 - 어제 언급한 코인 가격 변화 체크
async function checkPredictionFollowUp(
  twitter: TwitterApi,
  claude: Anthropic,
  newsService: BlockchainNewsService
) {
  console.log("\n[FOLLOWUP] 예측 팔로업 체크 중...");

  try {
    // 24시간 이상 지난, 아직 팔로업 안 된 예측들
    const pendingPredictions = memory.getPendingPredictions(24);

    if (pendingPredictions.length === 0) {
      console.log("[FOLLOWUP] 팔로업할 예측 없음");
      return;
    }

    console.log(`[FOLLOWUP] ${pendingPredictions.length}개 예측 확인 중...`);

    // 의미있는 변화가 있는 예측들 수집
    const significantChanges: Array<{
      coin: string;
      oldPrice: number;
      newPrice: number;
      changePercent: number;
    }> = [];

    for (const prediction of pendingPredictions) {
      const coinSymbol = prediction.coin.replace("$", "");
      const priceData = await newsService.getCoinPrice(coinSymbol);

      if (priceData) {
        const changePercent = ((priceData.price - prediction.priceAtMention) / prediction.priceAtMention) * 100;

        // 예측 업데이트
        memory.updatePrediction(coinSymbol, priceData.price);

        // 5% 이상 변화 시 의미있는 변화로 기록
        if (Math.abs(changePercent) >= 5) {
          significantChanges.push({
            coin: prediction.coin,
            oldPrice: prediction.priceAtMention,
            newPrice: priceData.price,
            changePercent: Math.round(changePercent * 10) / 10,
          });
        }
      }

      // API 레이트 리밋 방지
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // 의미있는 변화가 있으면 팔로업 트윗 생성
    if (significantChanges.length > 0) {
      console.log(`[FOLLOWUP] ${significantChanges.length}개 의미있는 변화 감지!`);

      const changesText = significantChanges
        .map(c => `${c.coin}: $${c.oldPrice.toLocaleString()} → $${c.newPrice.toLocaleString()} (${c.changePercent > 0 ? "+" : ""}${c.changePercent}%)`)
        .join("\n");

      const followUpPrompt = `
어제 내가 언급했던 코인들의 가격 변화:
${changesText}

이 데이터를 보고 짧은 팔로업 트윗을 작성해줘.
- 자랑하거나 후회하는 톤 OK (맞췄으면 "ㅋㅋ 봤지", 틀렸으면 "음... 이건 예상 밖")
- 다음에 뭘 볼지 힌트 줘도 됨
- 150자 이내
- 트윗 본문만 출력
`;

      const message = await claude.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 200,
        system: PIXYMON_SYSTEM_PROMPT,
        messages: [{ role: "user", content: followUpPrompt }],
      });

      const textContent = message.content.find((block) => block.type === "text");
      const followUpTweet = textContent?.text || "";

      if (followUpTweet) {
        const tweetId = await postTweet(twitter, followUpTweet, "briefing");
        if (tweetId) {
          console.log(`[FOLLOWUP] 팔로업 트윗 발행됨!`);
        }
      }
    } else {
      console.log("[FOLLOWUP] 의미있는 변화 없음 (±5% 미만)");
    }
  } catch (error) {
    console.error("[ERROR] 예측 팔로업 실패:", error);
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
  if (SCHEDULER_MODE) {
    console.log("  [SCHEDULER] 24/7 자동 실행 모드");
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

  // 스케줄러 모드
  if (SCHEDULER_MODE) {
    console.log("\n=====================================");
    console.log("  Pixymon v2.1 - 24/7 자동 에이전트");
    console.log("  ├─ 09:00 모닝 브리핑");
    console.log("  ├─ 18:00 예측 팔로업");
    console.log("  ├─ 21:00 이브닝 리캡");
    console.log("  └─ 3시간마다 멘션 체크");
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

    // 매일 오전 9시 모닝 브리핑 (한국 시간)
    cron.schedule("0 9 * * *", async () => {
      console.log("\n🌅 [09:00] 모닝 브리핑");
      await postMarketBriefing(twitter, claude, newsService, "morning");
    }, { timezone: "Asia/Seoul" });

    // 매일 오후 6시 예측 팔로업 (한국 시간)
    cron.schedule("0 18 * * *", async () => {
      console.log("\n📊 [18:00] 예측 팔로업");
      await checkPredictionFollowUp(twitter, claude, newsService);
    }, { timezone: "Asia/Seoul" });

    // 매일 오후 9시 이브닝 리캡 (한국 시간)
    cron.schedule("0 21 * * *", async () => {
      console.log("\n🌙 [21:00] 이브닝 리캡");
      await postMarketBriefing(twitter, claude, newsService, "evening");
    }, { timezone: "Asia/Seoul" });

    // 3시간마다 멘션 체크 (0, 3, 6, 9, 12, 15, 18, 21시)
    cron.schedule("0 */3 * * *", async () => {
      if (twitter && !TEST_MODE) {
        console.log("\n📬 멘션 체크");
        await checkAndReplyMentions(twitter, claude);
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
    console.log("  Pixymon v2.1 - 온체인 분석 에이전트");
    console.log("  ├─ 뉴스 분석");
    console.log("  ├─ 마켓 데이터");
    console.log("  └─ Q&A");
    console.log("=====================================\n");

    // 현재 시간에 따라 morning/evening 결정
    const hour = new Date().getHours();
    const timeSlot = hour < 15 ? "morning" : "evening";
    await postMarketBriefing(twitter, claude, newsService, timeSlot);
    
    // 예측 팔로업 체크
    await checkPredictionFollowUp(twitter, claude, newsService);
    
    if (twitter && !TEST_MODE) {
      await checkAndReplyMentions(twitter, claude);
    }

    console.log("=====================================");
    console.log("▶ Pixymon 세션 종료.");
    console.log("=====================================");
  }
}

main().catch(console.error);
