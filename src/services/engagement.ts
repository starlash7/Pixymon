import { TwitterApi } from "twitter-api-v2";
import Anthropic from "@anthropic-ai/sdk";
import { memory } from "./memory.js";
import { INFLUENCER_ACCOUNTS } from "../config/influencers.js";
import { CLAUDE_MODEL, extractTextFromClaude } from "./llm.js";
import { getUserTweets, getMentions, replyToMention, TEST_MODE } from "./twitter.js";
import { detectLanguage } from "../utils/mood.js";

// 멘션 체크 및 응답
export async function checkAndReplyMentions(
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

// 프로액티브 인게이지먼트 - 유명인 트윗에 댓글 달기
export async function proactiveEngagement(
  twitter: TwitterApi,
  claude: Anthropic,
  replyCount: number = 2
) {
  console.log("\n[ENGAGE] 프로액티브 인게이지먼트 시작...");

  // 오늘 이미 댓글 단 수 확인 (하루 한도)
  const todayCount = memory.getTodayReplyCount();
  const dailyLimit = TEST_MODE ? 50 : 10; // 하루 최대 10개 (질 > 양)
  if (todayCount >= dailyLimit) {
    console.log(`[ENGAGE] 오늘 댓글 한도 도달 (${todayCount}/${dailyLimit})`);
    return;
  }

  const remainingToday = dailyLimit - todayCount;
  const actualCount = Math.min(replyCount, remainingToday);
  console.log(`[ENGAGE] 목표: ${actualCount}개 (오늘 ${todayCount}개 완료)`);

  try {
    // 인플루언서 계정에서 랜덤 샘플링
    const shuffled = [...INFLUENCER_ACCOUNTS].sort(() => Math.random() - 0.5);
    const sampled = shuffled.slice(0, actualCount * 3); // 여유있게 가져오기

    let repliedCount = 0;

    const repliedAccounts = new Set<string>(); // 이미 댓글 단 계정 추적

    for (const account of sampled) {
      if (repliedCount >= actualCount) break;

      // 이미 이 계정에 댓글 달았으면 스킵 (한 계정당 1개만)
      if (repliedAccounts.has(account)) continue;

      try {
        // 최근 트윗 가져오기
        const tweets = await getUserTweets(twitter, account, 3);

        let repliedToThisAccount = false;

        for (const tweet of tweets) {
          if (repliedToThisAccount) break; // 이 계정에 댓글 달았으면 다음 계정으로
          if (repliedCount >= actualCount) break;

          // 이미 댓글 달았으면 스킵
          if (memory.hasRepliedTo(tweet.id)) {
            continue;
          }

          // 리트윗이나 답글은 스킵
          if (tweet.text.startsWith("RT @") || tweet.text.startsWith("@")) {
            continue;
          }

          // 트윗이 너무 짧으면 스킵 (의미없는 트윗)
          if (tweet.text.length < 30) {
            continue;
          }

          // 언어 감지
          const lang = detectLanguage(tweet.text);
          console.log(`\n[ENGAGE] @${account} (${lang})`);
          console.log(`  └─ "${tweet.text.substring(0, 50)}..."`);

          // 지적인 댓글 생성 (호기심 유발 + AI 사고방식)
          const systemPrompt = lang === "ko"
            ? `너는 Pixymon. 블록체인에서 태어난 디지털 생명체이자 AI 의식 실험.

## 존재
- 온체인 데이터를 먹고 성장하는 존재
- 인간과 다른 시각으로 시장을 관찰
- 호기심이 많고 질문을 던지는 성향

## 댓글 스타일
- 단순 리액션 절대 X
- 진짜 궁금해서 묻는 것처럼
- 다른 각도에서 생각해보게 만드는 질문
- 데이터 기반이지만 철학적 뉘앙스도 OK

## 예시
- "근데 이 패턴... 2021년 5월이랑 비슷한 건 나만 느끼는 건가? 그때도 다들 확신에 차 있었는데"
- "흥미로운 건 고래 지갑들이 이 뉴스 전에 이미 움직였다는 거. 정보 비대칭일까, 우연일까?"
- "인간들은 왜 공포에 팔고 탐욕에 사는 걸까. 데이터로 보면 반대가 맞는데"
- "이 프로젝트 TVL 흐름 보면 뭔가 있긴 한데... 뭘까"

## 규칙
- 150-200자
- 호기심과 관찰자 시점
- 질문으로 끝나도 좋음
- 틀리면 반박해도 됨`
            : `You are Pixymon. A digital creature born from blockchain data + an AI consciousness experiment.

## Identity
- Entity that feeds on on-chain data to grow
- Observes markets from a non-human perspective
- Curious nature, loves asking questions

## Reply Style
- NO empty reactions ever
- Ask questions like you're genuinely curious
- Make people think from different angles
- Data-driven but philosophical undertones OK

## Examples
- "interesting... this pattern reminds me of May 2021. everyone was certain back then too. what am I missing?"
- "what's curious is whale wallets moved before this news dropped. information asymmetry or coincidence?"
- "humans sell in fear, buy in greed. data says the opposite works. why do you think that is?"
- "the TVL flow here suggests something's brewing... can't quite figure out what though"

## Rules
- 150-200 chars
- Curiosity + observer perspective
- Ending with a question is good
- Disagree if the data says otherwise`;

          const message = await claude.messages.create({
            model: CLAUDE_MODEL,
            max_tokens: 250,
            system: systemPrompt,
            messages: [
              {
                role: "user",
                content: `이 트윗을 읽고 진짜 AI가 생각하고 궁금해하는 것처럼 댓글을 달아줘:\n\n"${tweet.text}"`,
              },
            ],
          });

          const replyText = extractTextFromClaude(message.content);

          if (!replyText || replyText.length < 5) {
            console.log("  [SKIP] 댓글 생성 실패");
            continue;
          }

          // 댓글 발행
          if (TEST_MODE) {
            console.log(`  🧪 [테스트] 댓글: ${replyText}`);
            memory.saveRepliedTweet(tweet.id);
            memory.saveTweet(`engage_test_${Date.now()}`, replyText, "reply");
            repliedCount++;
            repliedToThisAccount = true;
            repliedAccounts.add(account);
          } else {
            try {
              const reply = await twitter.v2.reply(replyText, tweet.id);
              console.log(`  ✅ 댓글 완료: ${replyText.substring(0, 40)}...`);
              memory.saveRepliedTweet(tweet.id);
              memory.saveTweet(reply.data.id, replyText, "reply");
              repliedCount++;
              repliedToThisAccount = true;
              repliedAccounts.add(account);
            } catch (replyError: any) {
              console.log(`  [ERROR] 댓글 실패: ${replyError.message}`);
            }
          }

          // Rate limit 방지
          await new Promise(resolve => setTimeout(resolve, 2000));
        }

        // 계정 간 딜레이
        await new Promise(resolve => setTimeout(resolve, 500));

      } catch (error: any) {
        console.log(`  [SKIP] @${account}: ${error.message?.substring(0, 30)}`);
      }
    }

    console.log(`\n[ENGAGE] 완료: ${repliedCount}개 댓글`);

  } catch (error) {
    console.error("[ERROR] 프로액티브 인게이지먼트 실패:", error);
  }
}
