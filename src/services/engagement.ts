import { TwitterApi } from "twitter-api-v2";
import Anthropic from "@anthropic-ai/sdk";
import { memory } from "./memory.js";
import { BlockchainNewsService, MarketData } from "./blockchain-news.js";
import {
  CLAUDE_MODEL,
  CLAUDE_RESEARCH_MODEL,
  PIXYMON_SYSTEM_PROMPT,
  REPLY_TONE_MODE,
  extractTextFromClaude,
  getReplyToneGuide,
} from "./llm.js";
import { getMentions, postTweet, replyToMention, searchRecentTrendTweets, TEST_MODE, sleep } from "./twitter.js";
import { FiveLayerCognitiveEngine } from "./cognitive-engine.js";
import { detectLanguage } from "../utils/mood.js";
import { findNarrativeDuplicate, validateMarketConsistency } from "./content-guard.js";

const DEFAULT_DAILY_TARGET = 20;
const DEFAULT_TIMEZONE = "Asia/Seoul";
const DEFAULT_MIN_LOOP_MINUTES = 25;
const DEFAULT_MAX_LOOP_MINUTES = 70;
const POST_GENERATION_MAX_ATTEMPTS = 2;

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
  marketData: MarketData[];
  headlines: string[];
  newsSources: Array<{ key: string; trust: number }>;
}

interface ContentQualityCheck {
  ok: boolean;
  reason?: string;
}

interface AdaptivePolicy {
  postDuplicateThreshold: number;
  postNarrativeThreshold: number;
  replyDuplicateThreshold: number;
  replyNarrativeThreshold: number;
  minTrendScore: number;
  minTrendEngagement: number;
  minSourceTrust: number;
  rationale: string;
}

interface RecentPostRecord {
  content: string;
  timestamp: string;
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
  replyCount: number = 2,
  policy: AdaptivePolicy = getDefaultAdaptivePolicy()
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
    const preview = candidates
      .slice(0, 4)
      .map((tweet) => `${tweet.__trendScore || "?"}/${tweet.__trendEngagement || "?"}`)
      .join(", ");
    console.log(`[ENGAGE] 후보 ${candidates.length}개 선별 완료 (score/engage 상위: ${preview || "n/a"})`);

    let repliedCount = 0;
    const recentReplyTexts = memory
      .getRecentTweets(50)
      .filter((tweet) => tweet.type === "reply")
      .map((tweet) => tweet.content);

    for (const tweet of candidates) {
      if (repliedCount >= goal) break;
      const text = String(tweet.text || "");
      const trendScore = typeof tweet.__trendScore === "number" ? tweet.__trendScore : 0;
      const trendEngagement = typeof tweet.__trendEngagement === "number" ? tweet.__trendEngagement : 0;
      const sourceTrust = typeof tweet.__sourceTrustScore === "number" ? tweet.__sourceTrustScore : 0.5;
      const sourceKey = typeof tweet.__sourceKey === "string" ? tweet.__sourceKey : `x:${String(tweet.author_id || "unknown")}`;
      if (!text || text.length < 30) continue;
      if (trendScore > 0 && trendScore < policy.minTrendScore) continue;
      if (trendEngagement > 0 && trendEngagement < policy.minTrendEngagement) continue;
      if (sourceTrust < policy.minSourceTrust) {
        memory.adjustSourceTrust(sourceKey, -0.004, "below-source-trust");
        continue;
      }
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

      const toneGuide = getReplyToneGuide(lang);

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
- 톤 가이드:
${toneGuide}
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
- Tone guide:
${toneGuide}
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

      let replyText = sanitizeTweetText(extractTextFromClaude(message.content));
      if (!replyText || replyText.length < 5) continue;

      if (detectLanguage(replyText) !== lang) {
        const rewritten = await rewriteByLanguage(claude, replyText, lang, packet.action.maxChars);
        if (rewritten) {
          replyText = rewritten;
        }
      }

      const quality = evaluateReplyQuality(replyText, trend.marketData, recentReplyTexts, policy);
      if (!quality.ok) {
        console.log(`  [SKIP] 품질 게이트: ${quality.reason}`);
        memory.adjustSourceTrust(sourceKey, -0.01, `reply-quality-${toReasonCode(quality.reason || "unknown")}`);
        continue;
      }

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
      memory.adjustSourceTrust(sourceKey, 0.015, "reply-success");
      recentReplyTexts.push(replyText);
      if (recentReplyTexts.length > 60) {
        recentReplyTexts.splice(0, recentReplyTexts.length - 60);
      }
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
  claude: Anthropic,
  policy: AdaptivePolicy = getDefaultAdaptivePolicy(),
  timezone: string = DEFAULT_TIMEZONE
): Promise<boolean> {
  console.log("\n[POST] 트렌드 요약 글 작성 시작...");

  try {
    const cognitive = new FiveLayerCognitiveEngine(claude, CLAUDE_MODEL, PIXYMON_SYSTEM_PROMPT, CLAUDE_RESEARCH_MODEL);
    const runContext = await cognitive.prepareRunContext("briefing");
    const trend = await collectTrendContext();
    const sourceText = `${trend.summary}\n핵심 키워드: ${trend.keywords.join(", ")}`;
    const recentBriefingPosts = memory
      .getRecentTweets(120)
      .filter((tweet) => tweet.type === "briefing")
      .map((tweet) => ({ content: tweet.content, timestamp: tweet.timestamp }));
    const recentBriefingTexts = recentBriefingPosts.map((tweet) => tweet.content);
    const postAngle = pickPostAngle(timezone, recentBriefingPosts);
    const marketAnchors = formatMarketAnchors(trend.marketData);

    const packet = await cognitive.analyzeTarget({
      objective: "briefing",
      text: sourceText,
      author: "trend-radar",
      language: "ko",
      runContext,
    });

    let rejectionFeedback = "";
    let postText: string | null = null;
    let generationAttempts = 0;
    let usedFallback = false;
    let latestFailReason = "";
    const recentContext =
      recentBriefingTexts.length > 0
        ? recentBriefingTexts
            .slice(-3)
            .map((text, index) => `${index + 1}. ${text}`)
            .join("\n")
        : "- 없음";

    for (let attempt = 0; attempt < POST_GENERATION_MAX_ATTEMPTS; attempt++) {
      generationAttempts = attempt + 1;
      const message = await claude.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 320,
        system: `${PIXYMON_SYSTEM_PROMPT}

추가 운영 규칙:
- 오늘 트위터 기술/트렌드 변화 중심으로 한 문장 주장 + 한 문장 근거.
- 과장 금지, 단정은 confidence 높을 때만.
- 숫자는 제공된 시장 앵커 범위 안에서만 인용한다.`,
        messages: [
          {
            role: "user",
            content: `아래 컨텍스트로 오늘의 트렌드 글 1개 작성.

${packet.promptContext}

트렌드 요약:
${trend.summary}

우선 앵글:
${postAngle}

최근 작성 글 (반복 금지):
${recentContext}

시장 숫자 앵커:
${marketAnchors}

직전 실패 원인:
${rejectionFeedback || "없음"}

규칙:
- 220자 이내
- 반드시 한국어로 작성 (고유명사 제외 영어 최소화)
- 해시태그/이모지 금지
- 질문형 또는 관찰형 마무리
- "시장 숫자 앵커"에 없는 가격 숫자는 쓰지 말 것
- 앵커가 없으면 구체 가격 숫자 언급 금지
- 최근 작성 글과 같은 전개/문장 구조 금지
- 트윗 본문만 출력`,
          },
        ],
      });

      let candidate = sanitizeTweetText(extractTextFromClaude(message.content));
      if (!candidate || candidate.length < 20) {
        rejectionFeedback = "문장이 비어있거나 너무 짧음";
        continue;
      }

      if (detectLanguage(candidate) !== "ko") {
        const rewrittenKo = await rewriteByLanguage(claude, candidate, "ko", 220);
        if (rewrittenKo) {
          candidate = rewrittenKo;
        }
      }

      const quality = evaluatePostQuality(candidate, trend.marketData, recentBriefingPosts, policy);
      if (!quality.ok) {
        rejectionFeedback = quality.reason || "품질 게이트 미통과";
        latestFailReason = rejectionFeedback;
        console.log(
          `[POST] 품질 게이트 실패: ${rejectionFeedback} (재시도 ${attempt + 1}/${POST_GENERATION_MAX_ATTEMPTS})`
        );
        continue;
      }

      postText = candidate;
      break;
    }

    if (!postText) {
      const fallbackPost = buildFallbackPost(trend, postAngle);
      if (fallbackPost) {
        const fallbackQuality = evaluatePostQuality(fallbackPost, trend.marketData, recentBriefingPosts, policy);
        if (fallbackQuality.ok) {
          postText = fallbackPost;
          usedFallback = true;
          console.log("[POST] LLM 재시도 실패, deterministic fallback으로 전환");
        } else {
          console.log(`[POST] fallback 실패: ${fallbackQuality.reason}`);
          latestFailReason = fallbackQuality.reason || latestFailReason;
        }
      }
    }

    if (!postText) {
      memory.recordPostGeneration({
        timezone,
        retryCount: Math.max(0, generationAttempts - 1),
        usedFallback: false,
        success: false,
        failReason: toReasonCode(latestFailReason || rejectionFeedback || "unknown"),
      });
      console.log("[POST] 품질 기준을 만족하는 글 생성 실패");
      return false;
    }

    const tweetId = await postTweet(twitter, postText, "briefing");
    if (!tweetId) return false;

    memory.recordCognitiveActivity("social", 2);
    memory.recordPostGeneration({
      timezone,
      retryCount: Math.max(0, generationAttempts - 1),
      usedFallback,
      success: true,
      failReason: usedFallback ? "fallback-success" : undefined,
    });
    for (const source of trend.newsSources.slice(0, 3)) {
      memory.adjustSourceTrust(source.key, 0.006, "post-news-source-used", source.trust);
    }
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
  const adaptivePolicy = buildAdaptivePolicy(target, target - remaining, timezone);
  console.log(
    `[POLICY] ${adaptivePolicy.rationale} | dup(post:${adaptivePolicy.postDuplicateThreshold.toFixed(2)}, reply:${adaptivePolicy.replyDuplicateThreshold.toFixed(2)}) | source>=${adaptivePolicy.minSourceTrust.toFixed(2)}`
  );

  let executed = 0;
  const mentionBudget = Math.min(remaining, Math.max(1, Math.floor(maxActions / 2)));
  const mentionProcessed = await checkAndReplyMentions(twitter, claude, mentionBudget);
  executed += mentionProcessed;

  remaining = target - memory.getTodayActivityCount(timezone);
  if (remaining <= 0 || executed >= maxActions) {
    return { target, remaining: Math.max(0, remaining), executed };
  }

  const postGoal = Math.max(3, Math.floor(target * 0.25));

  while (executed < maxActions && remaining > 0) {
    const before = executed;
    const todayPosts = memory.getTodayPostCount(timezone);
    const preferPost = todayPosts < postGoal && (executed === 0 || executed % 2 === 0);

    if (preferPost) {
      const posted = await postTrendUpdate(twitter, claude, adaptivePolicy, timezone);
      if (posted) {
        executed += 1;
      }
    } else {
      const replied = await proactiveEngagement(twitter, claude, 1, adaptivePolicy);
      executed += replied;
    }

    if (executed === before) {
      if (preferPost) {
        const fallbackReplies = await proactiveEngagement(twitter, claude, 1, adaptivePolicy);
        executed += fallbackReplies;
      } else {
        const fallbackPosted = await postTrendUpdate(twitter, claude, adaptivePolicy, timezone);
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
  console.log(`[LOOP] 댓글 톤 모드: ${REPLY_TONE_MODE}`);
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

  const mergedNews = [...hotNews, ...cryptoNews].map((item) => {
    const sourceKey = `news:${normalizeSourceLabel(item.source || "unknown")}`;
    const fallbackTrust = estimateNewsSourceFallbackTrust(item.source || "unknown");
    const trust = memory.getSourceTrustScore(sourceKey, fallbackTrust);
    return { item, sourceKey, trust };
  });

  const trustedNews = mergedNews
    .filter((row) => row.trust >= 0.28)
    .sort((a, b) => b.trust - a.trust);

  const filteredNews = trustedNews.length > 0 ? trustedNews : mergedNews.sort((a, b) => b.trust - a.trust);
  const titlePool = filteredNews.map((row) => row.item.title).filter(Boolean);
  for (const title of titlePool.slice(0, 12)) {
    extractKeywordsFromTitle(title).forEach((keyword) => keywordSet.add(keyword));
  }

  for (const seed of ["onchain", "layer2", "ETF", "liquidity", "macro", "AI agent"]) {
    keywordSet.add(seed);
  }

  const keywords = Array.from(keywordSet).filter(Boolean).slice(0, 18);
  const topCoinSummary = marketData
    .slice(0, 4)
    .map((coin) => `${coin.symbol} ${coin.change24h >= 0 ? "+" : ""}${coin.change24h.toFixed(1)}%`)
    .join(" | ");
  const newsSummary = titlePool.slice(0, 4).map((title) => `- ${title}`).join("\n");

  return {
    keywords: keywords.length > 0 ? keywords : ["crypto", "blockchain", "layer2", "onchain", "ETF", "macro"],
    summary: `마켓 흐름: ${topCoinSummary || "데이터 확인 중"}\n핫 토픽:\n${newsSummary || "- 데이터 부족"}`,
    marketData,
    headlines: titlePool.slice(0, 8),
    newsSources: filteredNews.slice(0, 8).map((row) => ({ key: row.sourceKey, trust: row.trust })),
  };
}

function extractKeywordsFromTitle(title: string): string[] {
  const tokens = title.match(/[A-Za-z][A-Za-z0-9-]{2,}|[가-힣]{2,}/g) || [];
  return tokens
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .filter((token) => !/^(the|and|with|from|this|that|for|into|about|news)$/i.test(token))
    .filter((token) => !/^(join|community|private|group|airdrop|giveaway)$/i.test(token))
    .slice(0, 4);
}

function sanitizeTweetText(text: string): string {
  return text.replace(/\s+/g, " ").replace(/[“”]/g, "\"").trim();
}

async function rewriteByLanguage(
  claude: Anthropic,
  text: string,
  lang: "ko" | "en",
  maxChars: number
): Promise<string | null> {
  try {
    const prompt =
      lang === "ko"
        ? `아래 문장을 자연스러운 한국어 한 줄로 다시 써줘.

원문:
${text}

규칙:
- ${maxChars}자 이내
- 의미 유지
- 해시태그/이모지 금지
- 최종 문장만 출력`
        : `Rewrite the text in natural English, one line.

Original:
${text}

Rules:
- Max ${maxChars} chars
- Keep meaning
- No hashtags or emoji
- Output only the final sentence`;

    const message = await claude.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 220,
      system: PIXYMON_SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
    });

    const rewritten = sanitizeTweetText(extractTextFromClaude(message.content));
    if (!rewritten) return null;
    return rewritten.slice(0, maxChars);
  } catch {
    return null;
  }
}

function evaluateReplyQuality(
  text: string,
  marketData: MarketData[],
  recentReplyTexts: string[],
  policy: AdaptivePolicy
): ContentQualityCheck {
  const marketConsistency = validateMarketConsistency(text, marketData);
  if (!marketConsistency.ok) {
    return { ok: false, reason: marketConsistency.reason || "시장 숫자 불일치" };
  }

  const duplicate = memory.checkDuplicate(text, policy.replyDuplicateThreshold);
  if (duplicate.isDuplicate) {
    return { ok: false, reason: "기존 발화와 과도하게 유사" };
  }

  const narrativeDup = findNarrativeDuplicate(text, recentReplyTexts, policy.replyNarrativeThreshold);
  if (narrativeDup.isDuplicate) {
    return {
      ok: false,
      reason: `최근 댓글과 내러티브 중복(sim=${narrativeDup.similarity})`,
    };
  }

  return { ok: true };
}

function evaluatePostQuality(
  text: string,
  marketData: MarketData[],
  recentPosts: RecentPostRecord[],
  policy: AdaptivePolicy
): ContentQualityCheck {
  if (!text || text.length < 20) {
    return { ok: false, reason: "문장이 너무 짧음" };
  }

  const recentPostTexts = recentPosts.map((post) => post.content);
  const marketConsistency = validateMarketConsistency(text, marketData);
  if (!marketConsistency.ok) {
    return { ok: false, reason: marketConsistency.reason || "시장 숫자 불일치" };
  }

  const duplicate = memory.checkDuplicate(text, policy.postDuplicateThreshold);
  if (duplicate.isDuplicate) {
    return { ok: false, reason: "기존 트윗과 의미 중복" };
  }

  const narrativeDup = findNarrativeDuplicate(text, recentPostTexts, policy.postNarrativeThreshold);
  if (narrativeDup.isDuplicate) {
    return {
      ok: false,
      reason: `최근 포스트와 내러티브 중복(sim=${narrativeDup.similarity})`,
    };
  }

  const normalized = sanitizeTweetText(text).slice(0, 24);
  if (normalized && recentPostTexts.some((item) => sanitizeTweetText(item).slice(0, 24) === normalized)) {
    return { ok: false, reason: "문장 시작 패턴 중복" };
  }

  const recentWithin24 = recentPosts.filter((post) => isWithinHours(post.timestamp, 24));
  if (recentWithin24.length > 0) {
    const candidateTag = inferTopicTag(text);
    const recentTags = recentWithin24.map((post) => inferTopicTag(post.content));
    const lastTag = recentTags[recentTags.length - 1];
    if (lastTag === candidateTag) {
      return { ok: false, reason: `주제 다양성 부족(${candidateTag} 연속)` };
    }
    const sameTagCount = recentTags.filter((tag) => tag === candidateTag).length;
    if (sameTagCount >= 3) {
      return { ok: false, reason: `24h 내 동일 주제 과밀(${candidateTag})` };
    }
  }

  return { ok: true };
}

function pickPostAngle(timezone: string, recentPosts: RecentPostRecord[]): string {
  const angles = [
    "심리(FearGreed)와 온체인 시그널 괴리 해석",
    "오늘 나온 기술/업그레이드 이슈의 실사용 영향",
    "유동성(스테이블/거래량)과 가격 반응의 비동기",
    "리스크 플래그(고래/멤풀/변동성) 관점에서 재해석",
    "시장 참여자 행동 변화(관망 vs 추격) 프레이밍",
  ];
  const todayPosts = memory.getTodayPostCount(timezone);
  const lastTag = recentPosts.length > 0 ? inferTopicTag(recentPosts[recentPosts.length - 1].content) : "";
  const candidates = angles.filter((angle) => inferTopicTag(angle) !== lastTag);
  if (candidates.length === 0) {
    return angles[todayPosts % angles.length];
  }
  return candidates[todayPosts % candidates.length];
}

function formatMarketAnchors(marketData: MarketData[]): string {
  if (marketData.length === 0) {
    return "- 실시간 마켓 앵커 없음 (구체 가격 숫자 언급 금지)";
  }

  return marketData
    .slice(0, 4)
    .map((coin) => {
      const sign = coin.change24h >= 0 ? "+" : "";
      return `- ${coin.symbol}: $${Math.round(coin.price).toLocaleString("en-US")} (${sign}${coin.change24h.toFixed(2)}%)`;
    })
    .join("\n");
}

function buildFallbackPost(trend: TrendContext, postAngle: string): string | null {
  const angle = postAngle.replace(/\s+/g, " ").trim();
  const headline = trend.headlines.find((item) => typeof item === "string" && item.trim().length > 0);
  const compactHeadline = headline ? headline.replace(/\s+/g, " ").trim().slice(0, 70) : "주요 시장 뉴스 업데이트";
  const marketLine = trend.marketData[0]
    ? `${trend.marketData[0].symbol} ${trend.marketData[0].change24h >= 0 ? "+" : ""}${trend.marketData[0].change24h.toFixed(1)}%`
    : "주요 코인 변동";
  const keywordPool = trend.keywords.filter((item) => item && !item.startsWith("$"));
  const keyword = keywordPool.length > 0 ? keywordPool[Math.floor(Math.random() * keywordPool.length)] : "온체인";
  const closingPool = [
    "지금은 심리보다 확인 신호를 더 보자.",
    "단기 소음보다 데이터 방향성이 먼저다.",
    "추세 전환 판단은 거래량 확인이 우선이다.",
    "해석보다 검증이 먼저인 구간으로 본다.",
  ];
  const closing = closingPool[Math.floor(Math.random() * closingPool.length)];
  const text = `${angle}. ${compactHeadline}. ${marketLine}와 ${keyword} 흐름의 동조를 점검 중, ${closing}`;
  const normalized = sanitizeTweetText(text);
  if (normalized.length < 40) return null;
  return normalized.slice(0, 220);
}

function getDefaultAdaptivePolicy(): AdaptivePolicy {
  return {
    postDuplicateThreshold: 0.82,
    postNarrativeThreshold: 0.79,
    replyDuplicateThreshold: 0.88,
    replyNarrativeThreshold: 0.82,
    minTrendScore: 2.8,
    minTrendEngagement: 4,
    minSourceTrust: 0.32,
    rationale: "default",
  };
}

function buildAdaptivePolicy(target: number, todayCount: number, timezone: string): AdaptivePolicy {
  const base = getDefaultAdaptivePolicy();
  const metrics = memory.getTodayPostGenerationMetrics(timezone);
  const progress = target > 0 ? todayCount / target : 1;
  const failLoad = metrics.postRuns > 0 ? metrics.postFailures / metrics.postRuns : 0;
  const reasons: string[] = ["default"];

  const policy: AdaptivePolicy = { ...base };

  if (progress < 0.45) {
    policy.postDuplicateThreshold += 0.04;
    policy.postNarrativeThreshold += 0.04;
    policy.replyDuplicateThreshold += 0.03;
    policy.replyNarrativeThreshold += 0.02;
    policy.minTrendScore -= 0.2;
    policy.minSourceTrust -= 0.03;
    reasons.push("under-target");
  } else if (progress > 1.05) {
    policy.postDuplicateThreshold -= 0.05;
    policy.postNarrativeThreshold -= 0.05;
    policy.replyDuplicateThreshold -= 0.03;
    policy.replyNarrativeThreshold -= 0.03;
    policy.minTrendScore += 0.35;
    policy.minTrendEngagement += 1;
    policy.minSourceTrust += 0.05;
    reasons.push("over-target");
  }

  if (metrics.fallbackRate >= 0.35 || failLoad >= 0.5) {
    policy.postDuplicateThreshold += 0.03;
    policy.postNarrativeThreshold += 0.03;
    policy.minTrendScore -= 0.1;
    reasons.push("high-fallback-or-fail");
  }

  if ((metrics.failReasons["duplicate"] || 0) >= 2) {
    policy.postDuplicateThreshold += 0.02;
    policy.postNarrativeThreshold += 0.02;
    reasons.push("duplicate-heavy");
  }

  policy.postDuplicateThreshold = clamp(policy.postDuplicateThreshold, 0.74, 0.92);
  policy.postNarrativeThreshold = clamp(policy.postNarrativeThreshold, 0.72, 0.9);
  policy.replyDuplicateThreshold = clamp(policy.replyDuplicateThreshold, 0.82, 0.94);
  policy.replyNarrativeThreshold = clamp(policy.replyNarrativeThreshold, 0.76, 0.9);
  policy.minTrendScore = clamp(policy.minTrendScore, 2.2, 4.2);
  policy.minTrendEngagement = Math.floor(clamp(policy.minTrendEngagement, 3, 12));
  policy.minSourceTrust = clamp(policy.minSourceTrust, 0.24, 0.55);
  policy.rationale = reasons.join("+");
  return policy;
}

function toReasonCode(reason: string): string {
  const normalized = String(reason || "").toLowerCase();
  if (!normalized) return "unknown";
  if (normalized.includes("시장 숫자") || normalized.includes("100k") || normalized.includes("오차")) return "market-mismatch";
  if (normalized.includes("중복") || normalized.includes("유사")) return "duplicate";
  if (normalized.includes("주제 다양성")) return "topic-diversity";
  if (normalized.includes("24h 내 동일")) return "topic-density";
  if (normalized.includes("짧음")) return "too-short";
  if (normalized.includes("fallback")) return "fallback";
  return "quality-gate";
}

function inferTopicTag(text: string): string {
  const lower = text.toLowerCase();
  if (/\$btc|bitcoin|비트코인/.test(lower)) return "bitcoin";
  if (/\$eth|ethereum|이더/.test(lower)) return "ethereum";
  if (/fomc|fed|macro|금리|inflation|dxy/.test(lower)) return "macro";
  if (/onchain|멤풀|수수료|고래|stable|유동성|tvl/.test(lower)) return "onchain";
  if (/layer2|rollup|업그레이드|mainnet|testnet/.test(lower)) return "tech";
  if (/ai|agent|inference/.test(lower)) return "ai";
  if (/defi|dex|lending|staking/.test(lower)) return "defi";
  return "general";
}

function isWithinHours(isoTimestamp: string, hours: number): boolean {
  const timestamp = new Date(isoTimestamp).getTime();
  if (!Number.isFinite(timestamp)) return false;
  return Date.now() - timestamp <= hours * 60 * 60 * 1000;
}

function normalizeSourceLabel(source: string): string {
  return String(source || "unknown")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "");
}

function estimateNewsSourceFallbackTrust(source: string): number {
  const lower = String(source || "").toLowerCase();
  if (/(coingecko|cryptocompare|reuters|coindesk|blockworks|bloomberg)/.test(lower)) return 0.62;
  if (/(twitter|x|unknown|community)/.test(lower)) return 0.45;
  return 0.52;
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
