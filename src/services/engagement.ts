import { TwitterApi } from "twitter-api-v2";
import Anthropic from "@anthropic-ai/sdk";
import { memory } from "./memory.js";
import { BlockchainNewsService } from "./blockchain-news.js";
import { CLAUDE_MODEL, CLAUDE_RESEARCH_MODEL, PIXYMON_SYSTEM_PROMPT, extractTextFromClaude } from "./llm.js";
import { getMentions, postTweet, replyToMention, searchRecentTrendTweets, TEST_MODE, sleep } from "./twitter.js";
import { FiveLayerCognitiveEngine } from "./cognitive-engine.js";
import { detectLanguage } from "../utils/mood.js";

const DEFAULT_DAILY_TARGET = 20;
const DEFAULT_TIMEZONE = "Asia/Seoul";
const DEFAULT_MIN_LOOP_MINUTES = 25;
const DEFAULT_MAX_LOOP_MINUTES = 70;

interface DailyQuotaOptions {
  dailyTarget?: number;
  timezone?: string;
  maxActionsPerCycle?: number;
  minLoopMinutes?: number;
  maxLoopMinutes?: number;
}

interface TrendContext {
  keywords: string[];
  summary: string;
}

// 멘션 체크 및 응답
export async function checkAndReplyMentions(
  twitter: TwitterApi,
  claude: Anthropic,
  maxMentionsToProcess: number = 5
): Promise<number> {
  const now = new Date().toLocaleString("ko-KR", { timeZone: DEFAULT_TIMEZONE });
  console.log(`\n[${now}] 멘션 체크 중...`);

  try {
    const lastMentionId = memory.getLastProcessedMentionId();
    const mentions = await getMentions(twitter, lastMentionId);

    if (mentions.length === 0) {
      console.log("[INFO] 새 멘션 없음");
      return 0;
    }

    const mentionLimit = clamp(maxMentionsToProcess, 1, 20);
    console.log(`[INFO] ${mentions.length}개 새 멘션 발견 (최대 ${mentionLimit}개 처리)`);
    const cognitive = new FiveLayerCognitiveEngine(claude, CLAUDE_MODEL, PIXYMON_SYSTEM_PROMPT, CLAUDE_RESEARCH_MODEL);
    const runContext = await cognitive.prepareRunContext("reply");

    let repliedCount = 0;
    const mentionsToProcess = mentions.slice(0, mentionLimit).reverse();

    for (const mention of mentionsToProcess) {
      console.log(`  └─ "${String(mention.text || "").substring(0, 45)}..."`);
      const replied = await replyToMention(twitter, claude, mention, {
        cognitiveEngine: cognitive,
        runContext,
      });

      if (!replied) {
        console.log(`[WARN] 멘션 처리 실패로 중단: ${mention.id}`);
        break;
      }

      repliedCount += 1;
      memory.setLastProcessedMentionId(mention.id);
      await sleep(1400);
    }

    return repliedCount;
  } catch (error) {
    console.error("[ERROR] 멘션 처리 실패:", error);
    return 0;
  }
}

// 트렌드 기반 프로액티브 인게이지먼트
export async function proactiveEngagement(
  twitter: TwitterApi,
  claude: Anthropic,
  replyCount: number = 2
): Promise<number> {
  const goal = clamp(replyCount, 0, 20);
  if (goal === 0) return 0;

  console.log(`\n[ENGAGE] 트렌드 기반 인게이지먼트 시작... (목표 ${goal}개)`);

  try {
    const cognitive = new FiveLayerCognitiveEngine(claude, CLAUDE_MODEL, PIXYMON_SYSTEM_PROMPT, CLAUDE_RESEARCH_MODEL);
    const runContext = await cognitive.prepareRunContext("engagement");
    const trend = await collectTrendContext();

    const candidates = await searchRecentTrendTweets(twitter, trend.keywords, Math.max(24, goal * 10));
    if (candidates.length === 0) {
      console.log("[ENGAGE] 트렌드 후보 트윗 없음");
      return 0;
    }

    let repliedCount = 0;
    for (const tweet of candidates) {
      if (repliedCount >= goal) break;
      const text = String(tweet.text || "");
      if (!text || text.length < 30) continue;
      if (text.startsWith("RT @") || text.startsWith("@")) continue;
      if (memory.hasRepliedTo(tweet.id)) continue;

      const lang = detectLanguage(text);
      const packet = await cognitive.analyzeTarget({
        objective: "engagement",
        text,
        author: String(tweet.author_id || ""),
        language: lang,
        runContext,
      });

      if (!packet.action.shouldReply) continue;

      const systemPrompt = `${PIXYMON_SYSTEM_PROMPT}

추가 운영 규칙:
- 트렌드/기술 변화 중심으로만 말한다.
- 공허한 칭찬/리액션은 금지한다.
- 근거가 약하면 질문형으로 전개한다.`;

      const userPrompt =
        lang === "ko"
          ? `아래 컨텍스트로 답글 작성.

트렌드 요약:
${trend.summary}

${packet.promptContext}

타겟 트윗:
"${text}"

규칙:
- ${packet.action.maxChars}자 이내
- 톤: ${packet.action.style}
- intent: ${packet.action.intent}
- 리스크 모드: ${packet.action.riskMode}
- 마지막 문장 ${packet.action.shouldEndWithQuestion ? "질문형" : "관찰형"}
- 해시태그/이모지 금지
- 1줄만 출력`
          : `Write one concise reply using this context.

Trend summary:
${trend.summary}

${packet.promptContext}

Target tweet:
"${text}"

Rules:
- Max ${packet.action.maxChars} chars
- Tone: ${packet.action.style}
- Intent: ${packet.action.intent}
- Risk mode: ${packet.action.riskMode}
- Ending: ${packet.action.shouldEndWithQuestion ? "open question" : "clear observation"}
- No hashtags or emoji
- Output only the reply text`;

      const message = await claude.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 250,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      });

      const replyText = sanitizeTweetText(extractTextFromClaude(message.content));
      if (!replyText || replyText.length < 5) continue;

      if (TEST_MODE) {
        console.log(`  🧪 [테스트] 댓글: ${replyText}`);
        memory.saveRepliedTweet(tweet.id);
        memory.saveTweet(`engage_test_${Date.now()}`, replyText, "reply");
      } else {
        try {
          const reply = await twitter.v2.reply(replyText, tweet.id);
          console.log(`  ✅ 댓글 완료: ${replyText.substring(0, 45)}...`);
          memory.saveRepliedTweet(tweet.id);
          memory.saveTweet(reply.data.id, replyText, "reply");
        } catch (replyError: any) {
          console.log(`  [ERROR] 댓글 실패: ${replyError.message}`);
          continue;
        }
      }

      memory.recordCognitiveActivity("social", 2);
      repliedCount += 1;
      await sleep(1800);
    }

    console.log(`[ENGAGE] 완료: ${repliedCount}개 댓글`);
    return repliedCount;
  } catch (error) {
    console.error("[ERROR] 프로액티브 인게이지먼트 실패:", error);
    return 0;
  }
}

// 트렌드 요약 글 작성
export async function postTrendUpdate(
  twitter: TwitterApi,
  claude: Anthropic
): Promise<boolean> {
  console.log("\n[POST] 트렌드 요약 글 작성 시작...");

  try {
    const cognitive = new FiveLayerCognitiveEngine(claude, CLAUDE_MODEL, PIXYMON_SYSTEM_PROMPT, CLAUDE_RESEARCH_MODEL);
    const runContext = await cognitive.prepareRunContext("briefing");
    const trend = await collectTrendContext();
    const sourceText = `${trend.summary}\n핵심 키워드: ${trend.keywords.join(", ")}`;

    const packet = await cognitive.analyzeTarget({
      objective: "briefing",
      text: sourceText,
      author: "trend-radar",
      language: "ko",
      runContext,
    });

    const message = await claude.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 320,
      system: `${PIXYMON_SYSTEM_PROMPT}

추가 운영 규칙:
- 오늘 트위터 기술/트렌드 변화 중심으로 한 문장 주장 + 한 문장 근거.
- 과장 금지, 단정은 confidence 높을 때만.`,
      messages: [
        {
          role: "user",
          content: `아래 컨텍스트로 오늘의 트렌드 글 1개 작성.

${packet.promptContext}

트렌드 요약:
${trend.summary}

규칙:
- 220자 이내
- 해시태그/이모지 금지
- 질문형 또는 관찰형 마무리
- 트윗 본문만 출력`,
        },
      ],
    });

    let postText = sanitizeTweetText(extractTextFromClaude(message.content));
    if (!postText || postText.length < 20) {
      console.log("[POST] 글 생성 실패");
      return false;
    }

    const duplicate = memory.checkDuplicate(postText, 0.72);
    if (duplicate.isDuplicate) {
      const regen = await claude.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 240,
        system: PIXYMON_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `아래 트윗과 다른 각도로 다시 작성.

중복 트윗:
${duplicate.similarTweet?.content || ""}

새 규칙:
- 220자 이내
- 해시태그/이모지 금지
- 오늘 트렌드 기술 변화에만 초점`,
          },
        ],
      });

      const regenerated = sanitizeTweetText(extractTextFromClaude(regen.content));
      if (regenerated && regenerated.length >= 20) {
        postText = regenerated;
      }
    }

    const tweetId = await postTweet(twitter, postText, "briefing");
    if (!tweetId) return false;

    memory.recordCognitiveActivity("social", 2);
    console.log(`[POST] 완료: ${postText.substring(0, 55)}...`);
    return true;
  } catch (error) {
    console.error("[ERROR] 트렌드 글 작성 실패:", error);
    return false;
  }
}

export async function runDailyQuotaCycle(
  twitter: TwitterApi,
  claude: Anthropic,
  options: DailyQuotaOptions = {}
): Promise<{ target: number; remaining: number; executed: number }> {
  const target = normalizeDailyTarget(options.dailyTarget);
  const timezone = options.timezone || DEFAULT_TIMEZONE;
  const maxActions = clamp(options.maxActionsPerCycle ?? 3, 1, 10);

  let remaining = target - memory.getTodayActivityCount(timezone);
  if (remaining <= 0) {
    console.log(`[QUOTA] 오늘 목표 ${target}개 달성 완료`);
    return { target, remaining: 0, executed: 0 };
  }

  console.log(`[QUOTA] 오늘 활동 ${target - remaining}/${target}, 이번 사이클 최대 ${maxActions}개`);

  let executed = 0;
  const mentionBudget = Math.min(remaining, Math.max(1, Math.floor(maxActions / 2)));
  const mentionProcessed = await checkAndReplyMentions(twitter, claude, mentionBudget);
  executed += mentionProcessed;

  remaining = target - memory.getTodayActivityCount(timezone);
  if (remaining <= 0 || executed >= maxActions) {
    return { target, remaining: Math.max(0, remaining), executed };
  }

  const postGoal = Math.max(6, Math.floor(target * 0.35));

  while (executed < maxActions && remaining > 0) {
    const before = executed;
    const todayPosts = memory.getTodayPostCount(timezone);
    const preferPost = todayPosts < postGoal && (executed === 0 || executed % 2 === 0);

    if (preferPost) {
      const posted = await postTrendUpdate(twitter, claude);
      if (posted) {
        executed += 1;
      }
    } else {
      const replied = await proactiveEngagement(twitter, claude, 1);
      executed += replied;
    }

    if (executed === before) {
      if (preferPost) {
        const fallbackReplies = await proactiveEngagement(twitter, claude, 1);
        executed += fallbackReplies;
      } else {
        const fallbackPosted = await postTrendUpdate(twitter, claude);
        if (fallbackPosted) executed += 1;
      }
    }

    if (executed === before) {
      console.log("[QUOTA] 이번 사이클에서 추가 생성 불가, 다음 사이클로 이월");
      break;
    }

    remaining = target - memory.getTodayActivityCount(timezone);
  }

  return { target, remaining: Math.max(0, remaining), executed };
}

export async function runDailyQuotaLoop(
  twitter: TwitterApi,
  claude: Anthropic,
  options: DailyQuotaOptions = {}
): Promise<void> {
  const timezone = options.timezone || DEFAULT_TIMEZONE;
  const minLoop = clamp(options.minLoopMinutes ?? DEFAULT_MIN_LOOP_MINUTES, 5, 180);
  const maxLoop = clamp(options.maxLoopMinutes ?? DEFAULT_MAX_LOOP_MINUTES, minLoop, 240);

  console.log(`[LOOP] 고정 시간 스케줄 없이 자율 루프 실행 (${minLoop}~${maxLoop}분 간격)`);
  while (true) {
    const result = await runDailyQuotaCycle(twitter, claude, options);
    const now = new Date().toLocaleString("ko-KR", { timeZone: timezone });
    console.log(`[LOOP] ${now} | 이번 사이클 ${result.executed}개 생성 | 남은 목표 ${result.remaining}개`);

    const waitMinutes = result.remaining <= 0 ? 60 : randomInt(minLoop, maxLoop);
    console.log(`[LOOP] 다음 실행까지 ${waitMinutes}분 대기`);
    await sleep(waitMinutes * 60 * 1000);
  }
}

async function collectTrendContext(): Promise<TrendContext> {
  const newsService = new BlockchainNewsService();
  const [hotNews, cryptoNews, marketData] = await Promise.all([
    newsService.getTodayHotNews(),
    newsService.getCryptoNews(10),
    newsService.getMarketData(),
  ]);

  const keywordSet = new Set<string>();
  for (const coin of marketData.slice(0, 6)) {
    keywordSet.add(`$${coin.symbol}`);
    keywordSet.add(coin.name);
  }

  const titlePool = [...hotNews, ...cryptoNews].map((item) => item.title).filter(Boolean);
  for (const title of titlePool) {
    extractKeywordsFromTitle(title).forEach((keyword) => keywordSet.add(keyword));
  }

  const keywords = Array.from(keywordSet).filter(Boolean).slice(0, 14);
  const topCoinSummary = marketData
    .slice(0, 4)
    .map((coin) => `${coin.symbol} ${coin.change24h >= 0 ? "+" : ""}${coin.change24h.toFixed(1)}%`)
    .join(" | ");
  const newsSummary = titlePool.slice(0, 4).map((title) => `- ${title}`).join("\n");

  return {
    keywords: keywords.length > 0 ? keywords : ["crypto", "blockchain", "layer2", "onchain"],
    summary: `마켓 흐름: ${topCoinSummary || "데이터 확인 중"}\n핫 토픽:\n${newsSummary || "- 데이터 부족"}`,
  };
}

function extractKeywordsFromTitle(title: string): string[] {
  const tokens = title.match(/[A-Za-z][A-Za-z0-9-]{2,}|[가-힣]{2,}/g) || [];
  return tokens
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .filter((token) => !/^(the|and|with|from|this|that|for|into|about|news)$/i.test(token))
    .slice(0, 4);
}

function sanitizeTweetText(text: string): string {
  return text.replace(/\s+/g, " ").replace(/[“”]/g, "\"").trim();
}

function normalizeDailyTarget(value: number | undefined): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_DAILY_TARGET;
  return clamp(Math.floor(parsed), 1, 100);
}

function randomInt(min: number, max: number): number {
  if (max <= min) return min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
