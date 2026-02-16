import { TwitterApi } from "twitter-api-v2";
import Anthropic from "@anthropic-ai/sdk";
import { memory } from "./memory.js";
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
import { buildFallbackPost, collectTrendContext, formatMarketAnchors, pickPostAngle } from "./engagement/trend-context.js";
import {
  buildAdaptivePolicy,
  clamp,
  getDefaultAdaptivePolicy,
  normalizeDailyTarget,
  randomInt,
  toReasonCode,
} from "./engagement/policy.js";
import { evaluatePostQuality, evaluateReplyQuality, sanitizeTweetText } from "./engagement/quality.js";
import { AdaptivePolicy, DailyQuotaOptions } from "./engagement/types.js";

const DEFAULT_TIMEZONE = "Asia/Seoul";
const DEFAULT_MIN_LOOP_MINUTES = 25;
const DEFAULT_MAX_LOOP_MINUTES = 70;
const POST_GENERATION_MAX_ATTEMPTS = 2;

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

  const sourceTrustUpdates: Array<{ sourceKey: string; delta: number; reason: string; fallback?: number }> = [];

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
        sourceTrustUpdates.push({ sourceKey, delta: -0.004, reason: "below-source-trust" });
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
        sourceTrustUpdates.push({
          sourceKey,
          delta: -0.01,
          reason: `reply-quality-${toReasonCode(quality.reason || "unknown")}`,
        });
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
      sourceTrustUpdates.push({ sourceKey, delta: 0.015, reason: "reply-success" });
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
  } finally {
    if (sourceTrustUpdates.length > 0) {
      memory.applySourceTrustDeltaBatch(sourceTrustUpdates);
    }
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

    if (trend.newsSources.length > 0) {
      memory.applySourceTrustDeltaBatch(
        trend.newsSources.slice(0, 3).map((source) => ({
          sourceKey: source.key,
          delta: 0.006,
          reason: "post-news-source-used",
          fallback: source.trust,
        }))
      );
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
