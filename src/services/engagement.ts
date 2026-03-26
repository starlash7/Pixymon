import { TwitterApi } from "twitter-api-v2";
import Anthropic from "@anthropic-ai/sdk";
import { memory } from "./memory.js";
import { OnchainDataService } from "./onchain-data.js";
import { digestNutrients } from "./digest-engine.js";
import {
  CLAUDE_MODEL,
  PIXYMON_SYSTEM_PROMPT,
  extractTextFromClaude,
  getReplyToneGuide,
  requestBudgetedClaudeMessage,
} from "./llm.js";
import {
  getTrendSearchCooldownRemainingMs,
  getMentions,
  postTweet,
  replyToMention,
  searchRecentTrendTweets,
  TEST_MODE,
  TEST_NO_EXTERNAL_CALLS,
  sleep,
} from "./twitter.js";
import { detectLanguage } from "../utils/mood.js";
import {
  DEFAULT_ENGAGEMENT_SETTINGS,
  DEFAULT_LLM_BATCH_SETTINGS,
  DEFAULT_OBSERVABILITY_SETTINGS,
  DEFAULT_X_API_COST_SETTINGS,
} from "../config/runtime.js";
import {
  ContentLanguage,
  EngagementRuntimeSettings,
  LlmBatchRuntimeSettings,
  ObservabilityRuntimeSettings,
  XApiCostRuntimeSettings,
} from "../types/runtime.js";
import {
  collectTrendContext,
  pickTrendFocus,
} from "./engagement/trend-context.js";
import {
  buildEventEvidenceFallbackPost,
  buildOnchainEvidence,
  buildStructuralFallbackEventsFromEvidence,
  computeLaneUsageWindow,
  planEventEvidenceAct,
  validateEventEvidenceContract,
} from "./engagement/event-evidence.js";
import { buildKoIdentityWriterCandidate } from "./engagement/identity-writer.js";
import {
  buildAdaptivePolicy,
  clamp,
  getDefaultAdaptivePolicy,
  normalizeDailyTarget,
  randomInt,
  toReasonCode,
} from "./engagement/policy.js";
import {
  evaluatePostQuality,
  evaluateReplyQuality,
  resolveContentQualityRules,
  sanitizeTweetText,
  stripNarrativeControlTags,
} from "./engagement/quality.js";
import {
  applyNarrativeLayout,
  finalizeNarrativeSurface,
  finalizeGeneratedText,
  normalizeQuestionTail,
  stableSeedForPrelude,
  truncateAtWordBoundary,
} from "./engagement/text-finalize.js";
import { buildDigestReflectionJob, buildLanguageRewriteJob } from "./llm-batch.js";
import type { BatchReadyClaudeJob } from "./llm-batch.js";
import { llmBatchQueue } from "./llm-batch-queue.js";
import {
  EventEvidencePlan,
  AdaptivePolicy,
  CycleCacheMetrics,
  DailyQuotaOptions,
  LaneUsageWindow,
  TrendContext,
  TrendTweetSearchRules,
} from "./engagement/types.js";
import { OnchainNutrient, TrendLane } from "../types/agent.js";
import { emitCycleObservability } from "./observability.js";
import { recordNarrativeObservation } from "./narrative-observer.js";
import { XReadGuardBlockReason, xApiBudget } from "./x-api-budget.js";
import {
  buildNarrativePlan,
  NarrativePlan,
  NarrativeRecentPost,
  validateNarrativeNovelty,
} from "./narrative-os.js";
import { evaluateAutonomyGovernor } from "./autonomy-governor.js";
import { buildQuoteReplySeed } from "./creative-studio.js";
import { submitPendingLlmBatch, syncLlmBatchRuns } from "./llm-batch-runner.js";

const DEFAULT_TIMEZONE = "Asia/Seoul";
const DEFAULT_MIN_LOOP_MINUTES = 25;
const DEFAULT_MAX_LOOP_MINUTES = 70;

interface CachedTrendContext {
  minNewsSourceTrust: number;
  data: TrendContext;
}

interface CachedTrendTweets {
  key: string;
  data: any[];
}

interface PersistedTrendTweetCache {
  key: string;
  savedAt: number;
  data: any[];
}

interface SharedRunContext {
  key: string;
  narrativeAnchors: string[];
  evidenceTextKo: string;
  evidenceTextEn: string;
  sharedPromptKo: string;
  sharedPromptEn: string;
}

interface CachedRunContext {
  key: string;
  data: SharedRunContext;
}

interface EngagementCycleCache {
  trendContext?: CachedTrendContext;
  trendTweets?: CachedTrendTweets;
  runContext?: CachedRunContext;
  cacheMetrics: CycleCacheMetrics;
}

interface FeedDigestSummary {
  intakeCount: number;
  acceptedCount: number;
  avgDigestScore: number;
  xpGainTotal: number;
  evolvedCount: number;
  rejectReasonsTop: Array<{ reason: string; count: number }>;
  acceptedNutrients: OnchainNutrient[];
  pendingReflectionHint?: string;
  reflectionJob?: BatchReadyClaudeJob;
}

const onchainDataService = new OnchainDataService();
const PERSISTED_TREND_TWEET_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
let persistedTrendTweetCache: PersistedTrendTweetCache | null = null;

export async function checkAndReplyMentions(
  twitter: TwitterApi,
  claude: Anthropic,
  maxMentionsToProcess: number = 5,
  timezone: string = DEFAULT_TIMEZONE,
  xApiCostSettings: XApiCostRuntimeSettings = DEFAULT_X_API_COST_SETTINGS,
  recentReflectionHint?: string
): Promise<number> {
  const now = new Date().toLocaleString("ko-KR", { timeZone: timezone });
  console.log(`\n[${now}] 멘션 체크 중...`);

  try {
    if (!TEST_NO_EXTERNAL_CALLS) {
      const mentionReadGuard = xApiBudget.checkReadAllowance({
        enabled: xApiCostSettings.enabled,
        timezone,
        dailyMaxUsd: xApiCostSettings.dailyMaxUsd,
        estimatedReadCostUsd: xApiCostSettings.estimatedReadCostUsd,
        dailyReadRequestLimit: xApiCostSettings.dailyReadRequestLimit,
        kind: "mentions",
        minIntervalMinutes: xApiCostSettings.mentionReadMinIntervalMinutes,
      });
      if (!mentionReadGuard.allowed) {
        console.log(
          `[BUDGET] 멘션 조회 스킵: ${formatReadBlockReason(mentionReadGuard.reason, mentionReadGuard.waitSeconds)}`
        );
        return 0;
      }

      if (xApiCostSettings.enabled) {
        const mentionUsage = xApiBudget.recordRead({
          timezone,
          estimatedReadCostUsd: xApiCostSettings.estimatedReadCostUsd,
          kind: "mentions",
        });
        console.log(
          `[BUDGET] read=${mentionUsage.readRequests}/${xApiCostSettings.dailyReadRequestLimit} total_est=$${mentionUsage.estimatedTotalCostUsd.toFixed(3)}/$${xApiCostSettings.dailyMaxUsd.toFixed(2)} (mentions)`
        );
      }
    } else {
      console.log("[TEST-LOCAL] 멘션 read budget 체크/기록 스킵");
    }

    const lastMentionId = memory.getLastProcessedMentionId();
    const mentions = await getMentions(twitter, lastMentionId);

    if (mentions.length === 0) {
      console.log("[INFO] 새 멘션 없음");
      return 0;
    }

    const mentionLimit = clamp(maxMentionsToProcess, 1, 20);
    console.log(`[INFO] ${mentions.length}개 새 멘션 발견 (최대 ${mentionLimit}개 처리)`);

    let repliedCount = 0;
    const mentionsToProcess = mentions.slice(0, mentionLimit).reverse();

    for (const mention of mentionsToProcess) {
      console.log(`  └─ \"${String(mention.text || "").substring(0, 45)}...\"`);
      const replied = await replyToMention(twitter, claude, mention, {
        timezone,
        xApiCostSettings,
        recentReflectionHint,
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

export async function proactiveEngagement(
  twitter: TwitterApi,
  claude: Anthropic,
  replyCount: number = 2,
  policy: AdaptivePolicy = getDefaultAdaptivePolicy(),
  settings: Partial<EngagementRuntimeSettings> = {},
  timezone: string = DEFAULT_TIMEZONE,
  xApiCostSettings: XApiCostRuntimeSettings = DEFAULT_X_API_COST_SETTINGS,
  cache?: EngagementCycleCache,
  recentReflectionHint?: string
): Promise<number> {
  const goal = clamp(replyCount, 0, 20);
  if (goal === 0) return 0;
  const runtimeSettings = resolveEngagementSettings(settings);

  console.log(`\n[ENGAGE] 트렌드 기반 인게이지먼트 시작... (목표 ${goal}개)`);
  if (!TEST_NO_EXTERNAL_CALLS && getTrendSearchCooldownRemainingMs() > 0) {
    console.log("[ENGAGE] proactive reply 비활성: search entitlement cooldown");
    return 0;
  }

  const sourceTrustUpdates: Array<{ sourceKey: string; delta: number; reason: string; fallback?: number }> = [];

  try {
    const trend = await getOrCreateTrendContext(cache, {
      minNewsSourceTrust: runtimeSettings.minNewsSourceTrust,
    });
    const runContext = getOrCreateRunContext(cache, trend, recentReflectionHint);

    const primarySearchRules = {
      minSourceTrust: runtimeSettings.minTrendTweetSourceTrust,
      minScore: runtimeSettings.minTrendTweetScore,
      minEngagement: runtimeSettings.minTrendTweetEngagement,
      maxAgeHours: runtimeSettings.trendTweetMaxAgeHours,
      requireRootPost: runtimeSettings.trendTweetRequireRootPost,
      blockSuspiciousPromo: runtimeSettings.trendTweetBlockSuspiciousPromo,
    };
    const secondaryKeywords = buildSecondaryReplyKeywords(trend, trend.keywords);
    const tertiaryKeywords = buildTertiaryReplyKeywords(trend);
    const fallbackLaneKeywords = buildLaneFallbackReplyKeywords(trend);
    const genericFallbackKeywords = buildGenericSafeReplyKeywords(trend);
    const broadFallbackKeywords = buildBroadSafeReplyKeywords(trend);
    const ultraBroadFallbackKeywords = buildUltraBroadSafeReplyKeywords();
    const mergedReplyKeywords = [
      ...new Set([
        ...trend.keywords,
        ...secondaryKeywords,
        ...tertiaryKeywords,
        ...fallbackLaneKeywords,
        ...genericFallbackKeywords,
      ].filter(Boolean)),
    ].slice(0, 18);

    let candidates = await getOrSearchTrendTweets(
      twitter,
      mergedReplyKeywords.length > 0 ? mergedReplyKeywords : trend.keywords,
      Math.max(48, goal * 18),
      primarySearchRules,
      timezone,
      xApiCostSettings,
      cache
    );

    if (candidates.length === 0 && shouldAbortProactiveReplySearch()) {
      console.log("[ENGAGE] proactive reply 검색 경로 중단: search entitlement cooldown");
      return 0;
    }

    if (candidates.length === 0) {
      if (secondaryKeywords.length > 0) {
        console.log("[ENGAGE] 1차 후보 없음, 장면 키워드만으로 2차 검색");
        candidates = await getOrSearchTrendTweets(
          twitter,
          secondaryKeywords,
          Math.max(42, goal * 16),
          {
            ...primarySearchRules,
            minSourceTrust: Math.max(0.34, primarySearchRules.minSourceTrust - 0.08),
            minScore: Math.max(2.7, primarySearchRules.minScore - 0.5),
            minEngagement: Math.max(6, primarySearchRules.minEngagement - 6),
            maxAgeHours: Math.min(primarySearchRules.maxAgeHours, 18),
          },
          timezone,
          {
            ...xApiCostSettings,
            trendReadMinIntervalMinutes: 0,
          },
          cache
        );
      }
    }

    if (candidates.length === 0 && shouldAbortProactiveReplySearch()) {
      console.log("[ENGAGE] proactive reply 재검색 중단: search entitlement cooldown");
      return 0;
    }

    if (candidates.length === 0) {
      if (tertiaryKeywords.length > 0) {
        console.log("[ENGAGE] 2차 후보 없음, 이벤트 토큰으로 3차 검색");
        candidates = await getOrSearchTrendTweets(
          twitter,
          tertiaryKeywords,
          Math.max(48, goal * 18),
          {
            ...primarySearchRules,
            minSourceTrust: Math.max(0.4, primarySearchRules.minSourceTrust - 0.05),
            minScore: Math.max(2.6, primarySearchRules.minScore - 0.6),
            minEngagement: Math.max(8, primarySearchRules.minEngagement - 4),
            maxAgeHours: Math.min(24, Math.max(12, primarySearchRules.maxAgeHours)),
          },
          timezone,
          {
            ...xApiCostSettings,
            trendReadMinIntervalMinutes: 0,
          },
          cache
        );
      }
    }

    if (candidates.length === 0 && shouldAbortProactiveReplySearch()) {
      console.log("[ENGAGE] proactive reply 재검색 중단: search entitlement cooldown");
      return 0;
    }

    if (candidates.length === 0) {
      if (fallbackLaneKeywords.length > 0) {
        console.log("[ENGAGE] 3차 후보 없음, 레인 시드로 4차 검색");
        candidates = await getOrSearchTrendTweets(
          twitter,
          fallbackLaneKeywords,
          Math.max(54, goal * 20),
          {
            ...primarySearchRules,
            minSourceTrust: Math.max(0.42, primarySearchRules.minSourceTrust - 0.03),
            minScore: Math.max(2.6, primarySearchRules.minScore - 0.6),
            minEngagement: Math.max(8, primarySearchRules.minEngagement - 4),
            maxAgeHours: Math.min(20, Math.max(10, primarySearchRules.maxAgeHours)),
          },
          timezone,
          {
            ...xApiCostSettings,
            trendReadMinIntervalMinutes: 0,
          },
          cache
        );
      }
    }

    if (candidates.length === 0 && shouldAbortProactiveReplySearch()) {
      console.log("[ENGAGE] proactive reply 재검색 중단: search entitlement cooldown");
      return 0;
    }

    if (candidates.length === 0) {
      if (genericFallbackKeywords.length > 0) {
        console.log("[ENGAGE] 4차 후보 없음, 안전 키워드로 5차 검색");
        candidates = await getOrSearchTrendTweets(
          twitter,
          genericFallbackKeywords,
          Math.max(60, goal * 22),
          {
            ...primarySearchRules,
            minSourceTrust: Math.max(0.42, primarySearchRules.minSourceTrust - 0.03),
            minScore: Math.max(2.5, primarySearchRules.minScore - 0.7),
            minEngagement: Math.max(8, primarySearchRules.minEngagement - 4),
            maxAgeHours: Math.min(18, Math.max(10, primarySearchRules.maxAgeHours)),
          },
          timezone,
          {
            ...xApiCostSettings,
            trendReadMinIntervalMinutes: 0,
          },
          cache
        );
      }
    }

    if (candidates.length === 0 && shouldAbortProactiveReplySearch()) {
      console.log("[ENGAGE] proactive reply 재검색 중단: search entitlement cooldown");
      return 0;
    }

    if (candidates.length === 0) {
      console.log("[ENGAGE] 5차 후보 없음, 넓은 안전 키워드로 6차 검색");
      candidates = await getOrSearchTrendTweets(
        twitter,
        broadFallbackKeywords,
        Math.max(72, goal * 24),
        {
          ...primarySearchRules,
          minSourceTrust: Math.max(0.4, primarySearchRules.minSourceTrust - 0.05),
          minScore: Math.max(2.4, primarySearchRules.minScore - 0.8),
          minEngagement: Math.max(6, primarySearchRules.minEngagement - 6),
          maxAgeHours: Math.min(18, Math.max(10, primarySearchRules.maxAgeHours)),
        },
        timezone,
        {
          ...xApiCostSettings,
          trendReadMinIntervalMinutes: 0,
        },
        cache
      );
    }

    if (candidates.length === 0 && shouldAbortProactiveReplySearch()) {
      console.log("[ENGAGE] proactive reply 재검색 중단: search entitlement cooldown");
      return 0;
    }

    if (candidates.length === 0) {
      console.log("[ENGAGE] 6차 후보 없음, 매우 넓은 안전 키워드로 7차 검색");
      candidates = await getOrSearchTrendTweets(
        twitter,
        ultraBroadFallbackKeywords,
        Math.max(84, goal * 28),
        {
          ...primarySearchRules,
          minSourceTrust: Math.max(0.36, primarySearchRules.minSourceTrust - 0.09),
          minScore: Math.max(2.3, primarySearchRules.minScore - 0.9),
          minEngagement: Math.max(4, primarySearchRules.minEngagement - 8),
          maxAgeHours: Math.min(16, Math.max(8, primarySearchRules.maxAgeHours)),
        },
        timezone,
        {
          ...xApiCostSettings,
          trendReadMinIntervalMinutes: 0,
        },
        cache
      );
    }

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
      .getRecentTweets(60)
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

      const detectedLang = detectLanguage(text);
      const lang = resolveReplyLanguage(runtimeSettings.replyLanguageMode, detectedLang);
      const toneGuide = getReplyToneGuide(lang);
      const systemPrompt = `${PIXYMON_SYSTEM_PROMPT}

추가 운영 규칙:
- 상대 트윗 핵심 주장 1개만 잡고 반응한다.
- 칭찬/감탄사보다 정보 밀도가 높은 답변 우선.
- 확신이 낮으면 질문형으로 끝낸다.
- 원문을 그대로 다시 요약하지 않는다.
- 1~2문장으로 끝낸다.
- 첫 문장은 반응/관찰/질문 중 하나로 시작한다.`;

      const userPrompt =
        lang === "ko"
          ? `아래 컨텍스트로 답글 1개 작성.

오늘 트렌드 요약:
${runContext.evidenceTextKo}

타겟 트윗:
\"${text}\"

규칙:
- 180자 이내
- 톤 가이드:
${toneGuide}
- 원문 표현을 그대로 반복 요약하지 말 것
- 길어도 2문장
- 첫 문장은 반응이나 관찰로 시작
- 한국어면 말하듯 자연스럽게
- 해시태그/이모지 금지
- 숫자 왜곡 금지
- 본문만 출력`
          : `Write one concise reply using this context.

Trend summary:
${runContext.evidenceTextEn}

Target tweet:
\"${text}\"

Rules:
- Max 180 chars
- Tone guide:
${toneGuide}
- Do not paraphrase the target tweet line by line
- Keep it to 1-2 sentences
- Start with a reaction, observation, or question
- No hashtags or emoji
- Do not invent numbers
- Output reply text only`;

      const llmResult = await requestBudgetedClaudeMessage(
        claude,
        {
          model: CLAUDE_MODEL,
          max_tokens: 220,
          system: systemPrompt,
          messages: [
            {
              role: "user",
              content: lang === "ko" ? runContext.sharedPromptKo : runContext.sharedPromptEn,
            },
            { role: "user", content: userPrompt },
          ],
        },
        {
          kind: "reply:engagement-generate",
          timezone,
          cacheSharedPrefix: true,
        }
      );
      if (!llmResult) continue;

      let replyText = finalizeNarrativeSurface(extractTextFromClaude(llmResult.message.content), lang, 180, "reply");
      if (!replyText || replyText.length < 5) continue;

      if (detectLanguage(replyText) !== lang) {
        const rewritten = await rewriteByLanguage(claude, replyText, lang, 180, timezone);
        if (rewritten) {
          replyText = finalizeNarrativeSurface(rewritten, lang, 180, "reply");
        }
      }

      replyText = deconflictOpening(
        replyText,
        recentReplyTexts,
        lang,
        180,
        `reply:${tweet.id}:${sourceKey}`,
        "reply"
      );

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
        recordNarrativeObservation({
          surface: "reply",
          text: replyText,
          language: lang,
          lane: inferTrendLaneFromText(text),
          narrativeMode: "engagement-reply",
          fallbackKind: "reply:engagement-test",
        });
      } else {
        const createGuard = xApiBudget.checkCreateAllowance({
          enabled: xApiCostSettings.enabled,
          timezone,
          dailyMaxUsd: xApiCostSettings.dailyMaxUsd,
          estimatedCreateCostUsd: xApiCostSettings.estimatedCreateCostUsd,
          dailyCreateRequestLimit: xApiCostSettings.dailyCreateRequestLimit,
          kind: "reply:engagement",
          minIntervalMinutes: xApiCostSettings.createMinIntervalMinutes,
        });
        if (!createGuard.allowed) {
          console.log(`  [BUDGET] 댓글 스킵: ${formatReadBlockReason(createGuard.reason, createGuard.waitSeconds)}`);
          break;
        }
        if (xApiCostSettings.enabled) {
          const createUsage = xApiBudget.recordCreate({
            timezone,
            estimatedCreateCostUsd: xApiCostSettings.estimatedCreateCostUsd,
            kind: "reply:engagement",
          });
          console.log(
            `  [BUDGET] create=${createUsage.createRequests}/${xApiCostSettings.dailyCreateRequestLimit} total_est=$${createUsage.estimatedTotalCostUsd.toFixed(3)}/$${xApiCostSettings.dailyMaxUsd.toFixed(2)}`
          );
        }
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

export async function postTrendUpdate(
  twitter: TwitterApi | null,
  claude: Anthropic,
  policy: AdaptivePolicy = getDefaultAdaptivePolicy(),
  timezone: string = DEFAULT_TIMEZONE,
  settings: Partial<EngagementRuntimeSettings> = {},
  xApiCostSettings: XApiCostRuntimeSettings = DEFAULT_X_API_COST_SETTINGS,
  cache?: EngagementCycleCache,
  feedNutrients: OnchainNutrient[] = [],
  cycleReflectionHint?: string
): Promise<boolean> {
  console.log("\n[POST] 트렌드 요약 글 작성 시작...");
  const runtimeSettings = resolveEngagementSettings(settings);

  try {
    const trend = await getOrCreateTrendContext(cache, {
      minNewsSourceTrust: runtimeSettings.minNewsSourceTrust,
    });
    const runContext = getOrCreateRunContext(cache, trend, cycleReflectionHint);

    const recentBriefingPosts = memory
      .getRecentTweets(140)
      .filter((tweet) => tweet.type === "briefing")
      .filter((tweet) => isWithinHours(tweet.timestamp, 24))
      .map((tweet) => ({
        content: tweet.content,
        timestamp: tweet.timestamp,
        meta: {
          lane: tweet.meta?.lane,
          narrativeMode: tweet.meta?.narrativeMode,
        },
      }));

    const lastBriefingPost = recentBriefingPosts.length > 0 ? recentBriefingPosts[recentBriefingPosts.length - 1] : null;
    if (runtimeSettings.postMinIntervalMinutes > 0 && lastBriefingPost) {
      const minutesSinceLast = getMinutesSince(lastBriefingPost.timestamp);
      if (minutesSinceLast >= 0 && minutesSinceLast < runtimeSettings.postMinIntervalMinutes) {
        console.log(
          `[POST] 스킵: 마지막 글 이후 ${minutesSinceLast}분 경과 (최소 ${runtimeSettings.postMinIntervalMinutes}분 필요)`
        );
        return false;
      }
    }

    const recentBriefingTexts = recentBriefingPosts.map((tweet) => tweet.content);
    let soulIntent = memory.getSoulIntentPlan(runtimeSettings.postLanguage);
    const recentReflectionText = cycleReflectionHint || memory.getLatestDigestReflectionMemo()?.text;
    const laneUsageWindow = resolveRecentLaneUsageWindow(recentBriefingPosts);
    const recentNarrativeThreads = memory.getRecentNarrativeThreads(6);
    const eventEvidence = buildOnchainEvidence([...feedNutrients, ...trend.nutrients], 16);
    let candidateEvents = trend.events;
    let eventPlan = planEventEvidenceAct({
      events: candidateEvents,
      evidence: eventEvidence,
      recentPosts: recentBriefingPosts,
      recentNarrativeThreads,
      laneUsage: laneUsageWindow,
      requireOnchainEvidence: runtimeSettings.requireOnchainEvidence,
      requireCrossSourceEvidence: runtimeSettings.requireCrossSourceEvidence,
      identityPressure: {
        obsessionLine: soulIntent.obsessionLine,
        grudgeLine: soulIntent.grudgeLine,
        continuityLine: soulIntent.continuityLine,
      },
    });
    if (!eventPlan) {
      const syntheticEvents = buildStructuralFallbackEventsFromEvidence(
        eventEvidence,
        trend.events[0]?.capturedAt || new Date().toISOString(),
        4
      );
      if (syntheticEvents.length > 0) {
        candidateEvents = syntheticEvents;
        eventPlan = planEventEvidenceAct({
          events: candidateEvents,
          evidence: eventEvidence,
          recentPosts: recentBriefingPosts,
          recentNarrativeThreads,
          laneUsage: laneUsageWindow,
          requireOnchainEvidence: runtimeSettings.requireOnchainEvidence,
          requireCrossSourceEvidence: runtimeSettings.requireCrossSourceEvidence,
          identityPressure: {
            obsessionLine: soulIntent.obsessionLine,
            grudgeLine: soulIntent.grudgeLine,
            continuityLine: soulIntent.continuityLine,
          },
        });
        if (eventPlan) {
          console.log(`[PLAN] structural fallback events 사용: ${syntheticEvents.map((item) => item.headline).join(" | ")}`);
        }
        if (!eventPlan && runtimeSettings.requireCrossSourceEvidence) {
          const relaxedStructuralPlan = planEventEvidenceAct({
            events: syntheticEvents,
            evidence: eventEvidence,
            recentPosts: recentBriefingPosts,
            recentNarrativeThreads,
            laneUsage: laneUsageWindow,
            requireOnchainEvidence: runtimeSettings.requireOnchainEvidence,
            requireCrossSourceEvidence: false,
            identityPressure: {
              obsessionLine: soulIntent.obsessionLine,
              grudgeLine: soulIntent.grudgeLine,
              continuityLine: soulIntent.continuityLine,
            },
          });
          if (relaxedStructuralPlan && isStrongOnchainStructuralPlan(relaxedStructuralPlan)) {
            candidateEvents = syntheticEvents;
            eventPlan = relaxedStructuralPlan;
            console.log("[PLAN] cross-source strict 모드에서 onchain structural fallback 한시 허용");
          }
        }
      }
    }
    if (
      eventPlan &&
      runtimeSettings.requireCrossSourceEvidence &&
      !eventPlan.hasCrossSourceEvidence
    ) {
      const replannableEvents = candidateEvents.filter((event) => {
        if (event.id === eventPlan?.event.id) return false;
        if (event.source === "evidence:structural-fallback" && event.lane === "onchain") return false;
        if (eventPlan?.lane === "onchain" && event.lane === "onchain") return false;
        return true;
      });
      if (replannableEvents.length > 0) {
        const replanned = planEventEvidenceAct({
          events: replannableEvents,
          evidence: eventEvidence,
          recentPosts: recentBriefingPosts,
          recentNarrativeThreads,
          laneUsage: laneUsageWindow,
          requireOnchainEvidence: runtimeSettings.requireOnchainEvidence,
          requireCrossSourceEvidence: runtimeSettings.requireCrossSourceEvidence,
          identityPressure: {
            obsessionLine: soulIntent.obsessionLine,
            grudgeLine: soulIntent.grudgeLine,
            continuityLine: soulIntent.continuityLine,
          },
        });
        if (replanned?.hasCrossSourceEvidence) {
          eventPlan = replanned;
          candidateEvents = replannableEvents;
          console.log("[PLAN] cross-source 부족 플랜 제외 후 재선정");
        }
      }
    }
    if (eventPlan) {
      soulIntent = memory.getSoulIntentPlan(runtimeSettings.postLanguage, eventPlan.lane);
    }

    if (eventPlan) {
      const plannerGate = evaluatePlannerPublishReadiness(eventPlan, recentNarrativeThreads);
      console.log(
        `[PLAN] focus=${eventPlan.focus} scene=${eventPlan.sceneFamily} score=${eventPlan.plannerScore.toFixed(3)} warnings=${eventPlan.plannerWarnings.join(",") || "none"}`
      );
      if (!plannerGate.allow) {
        memory.recordPostGeneration({
          timezone,
          retryCount: 0,
          usedFallback: false,
          success: false,
          failReason: toReasonCode(`planner-thin:${plannerGate.reason}`),
        });
        console.log(`[PLAN] 발행 차단: ${plannerGate.reason}`);
        return false;
      }
    }

    if (!eventPlan) {
      if (TEST_MODE) {
        const previewHeadline = trend.headlines[0] || "오늘은 단일 이벤트 확정이 어려운 장세";
        const previewAnchors =
          runtimeSettings.postLanguage === "ko" ? runContext.evidenceTextKo : runContext.evidenceTextEn;
        const previewCandidates = buildPreviewFallbackCandidates({
          headline: previewHeadline,
          anchors: previewAnchors,
          language: runtimeSettings.postLanguage,
          laneHint: inferTrendLaneFromText(previewHeadline),
          recentPosts: recentBriefingPosts,
          recentReflection: recentReflectionText,
          intentLine: soulIntent.intentLine,
          obsessionLine: soulIntent.obsessionLine,
          grudgeLine: soulIntent.grudgeLine,
          continuityLine: soulIntent.continuityLine,
          activeQuestion: soulIntent.activeQuestion,
          interactionMission: soulIntent.interactionMission,
          philosophyFrame: soulIntent.philosophyFrame,
          bookFragment: soulIntent.bookFragment,
          selfNarrative: soulIntent.selfNarrative,
          signatureBelief: soulIntent.signatureBelief,
          preferredForm: soulIntent.narrativeForm,
          maxChars: runtimeSettings.postMaxChars,
        });
        const previewQualityRules = resolveContentQualityRules({
          minPostLength: runtimeSettings.postMinLength,
          topicMaxSameTag24h: runtimeSettings.topicMaxSameTag24h,
          sentimentMaxRatio24h: runtimeSettings.sentimentMaxRatio24h,
          topicBlockConsecutiveTag: runtimeSettings.topicBlockConsecutiveTag,
        });
        const previewPolicy: AdaptivePolicy = {
          ...policy,
          postDuplicateThreshold: Math.min(0.98, policy.postDuplicateThreshold + 0.22),
          postNarrativeThreshold: Math.min(0.99, policy.postNarrativeThreshold + 0.12),
        };
        const previewBaseQuality = resolveContentQualityRules({
          minPostLength: previewQualityRules.minPostLength,
          topicMaxSameTag24h: 8,
          sentimentMaxRatio24h: 1,
          topicBlockConsecutiveTag: false,
        });
        const selectedPreview = previewCandidates.find((candidate) => {
          const duplicate = memory.checkDuplicate(candidate.text, 0.92);
          if (duplicate.isDuplicate) return false;
          return evaluatePostQuality(candidate.text, trend.marketData, [], previewPolicy, previewBaseQuality, {
            language: runtimeSettings.postLanguage,
            requireActionAndInvalidation: true,
          }).ok;
        });
        if (!selectedPreview) {
          console.log("[POST] TEST_MODE preview fallback 스킵: 품질 게이트 통과 후보 없음");
          return false;
        }
        const previewText = applyNarrativeLayout(
          selectedPreview.text,
          runtimeSettings.postLanguage,
          runtimeSettings.postMaxChars
        );
        const previewId = await postTweet(twitter, previewText, "briefing", {
          timezone,
          xApiCostSettings,
          createKind: "post:preview-fallback",
          metadata: {
            lane: selectedPreview.lane,
            eventId: `preview:fallback:${Date.now()}`,
            eventHeadline: previewHeadline.slice(0, 180),
            evidenceIds: [],
            narrativeMode: selectedPreview.mode,
          },
        });
        if (previewId) {
          console.log(`[POST] TEST_MODE preview fallback 생성 완료 (${selectedPreview.mode})`);
          return true;
        }
      }
      console.log("[PLAN] 이벤트/근거 플랜 생성 실패 (event 또는 evidence 부족)");
      return false;
    }

    const narrativePlan = buildNarrativePlan({
      eventPlan,
      recentPosts: recentBriefingPosts as NarrativeRecentPost[],
      language: runtimeSettings.postLanguage,
    });

    const trendFocus = pickTrendFocus([eventPlan.event.headline, ...trend.headlines], recentBriefingPosts);
    const requiredTrendTokens = normalizeTrendRequirementTokens([
      ...trendFocus.requiredTokens,
      ...eventPlan.event.keywords,
    ]).slice(0, 6);
    const focusTokensLine = requiredTrendTokens.length > 0 ? requiredTrendTokens.join(", ") : "- 없음";
    const postDiversityGuard = buildPostDiversityGuard(recentBriefingPosts, trend.marketData, requiredTrendTokens, eventPlan.event.headline);

    if (eventPlan.event.headline) {
      console.log(`[PLAN] lane=${eventPlan.lane} | event=${eventPlan.event.headline}`);
      console.log(`[PLAN] mode=${narrativePlan.mode} | opener=\"${narrativePlan.openingDirective}\"`);
      console.log(`[PLAN] evidence=${eventPlan.evidence.map((item) => `${item.label} ${item.value}`).join(" | ")}`);
      console.log(
        `[PLAN] evidence-guard onchain=${eventPlan.hasOnchainEvidence ? "yes" : "no"} cross=${eventPlan.hasCrossSourceEvidence ? "yes" : "no"} diversity=${eventPlan.evidenceSourceDiversity}`
      );
      console.log(
        `[PLAN] laneRatio=${Math.round(eventPlan.laneProjectedRatio * 100)}% quotaLimited=${eventPlan.laneQuotaLimited ? "yes" : "no"}`
      );
    }

    if (postDiversityGuard.avoidBtcOnly) {
      console.log(`[POST] BTC 편중 완화 모드: ${postDiversityGuard.btcRatioPercent}%`);
    }

    const qualityRules = resolveContentQualityRules({
      minPostLength: runtimeSettings.postMinLength,
      topicMaxSameTag24h: runtimeSettings.topicMaxSameTag24h,
      sentimentMaxRatio24h: runtimeSettings.sentimentMaxRatio24h,
      topicBlockConsecutiveTag: runtimeSettings.topicBlockConsecutiveTag,
    });

    let rejectionFeedback = "";
    let postText: string | null = null;
    let generationAttempts = 0;
    let usedFallback = false;
    let fallbackKind: PostFallbackKind = "none";
    let latestFailReason = "";

    const recentContext =
      recentBriefingTexts.length > 0
        ? recentBriefingTexts
            .slice(-4)
            .map((text, index) => `${index + 1}. ${text}`)
            .join("\n")
        : "- 없음";
    const previousNarrativeMode = String(
      recentBriefingPosts[recentBriefingPosts.length - 1]?.meta?.narrativeMode || ""
    ).trim();
    const clicheBlocklist = buildClicheBlocklist(recentBriefingTexts, runtimeSettings.postLanguage);
    const soulContext = memory.getSoulPromptContext(runtimeSettings.postLanguage);
    const autonomyContext = memory.getAutonomyPromptContext(runtimeSettings.postLanguage);
    const nutritionHint = buildNutritionNarrativeHint({
      language: runtimeSettings.postLanguage,
      timezone,
      lane: eventPlan.lane,
      acceptedNutrients: feedNutrients,
    });
    const preferredEventAnchorKo = buildCompactEventAnchorLine(
      eventPlan.lane,
      eventPlan.event.headline,
      `prompt|${eventPlan.event.id || ""}|ko`
    );
    const preferredEventAnchorEn = sanitizeTweetText(eventPlan.event.headline).replace(/\.$/, "");
    const preferredEvidenceAnchors = eventPlan.evidence
      .slice(0, 2)
      .map((item) => formatEvidenceToken(item.label, item.value, 32));
    const preferredEvidenceNotesKo = eventPlan.evidence
      .slice(0, 2)
      .map((item) => summarizeEvidenceForPrompt(item, "ko"));
    const preferredEvidenceNotesEn = eventPlan.evidence
      .slice(0, 2)
      .map((item) => summarizeEvidenceForPrompt(item, "en"));
    const preferredConceptCueKo = buildPixymonConceptCue(
      eventPlan.lane,
      "ko",
      nutritionHint.shortLine,
      soulIntent.styleDirective
    );
    const preferredConceptCueEn = buildPixymonConceptCue(
      eventPlan.lane,
      "en",
      nutritionHint.shortLine,
      soulIntent.styleDirective
    );

    if (TEST_NO_EXTERNAL_CALLS) {
      const localAnchors = preferredEvidenceAnchors.join(" | ");
      const localCandidates = buildPreviewFallbackCandidates({
        headline: eventPlan.event.headline,
        anchors: localAnchors,
        language: runtimeSettings.postLanguage,
        laneHint: eventPlan.lane,
        recentPosts: recentBriefingPosts,
        recentReflection: recentReflectionText,
        intentLine: soulIntent.intentLine,
        obsessionLine: soulIntent.obsessionLine,
        grudgeLine: soulIntent.grudgeLine,
        continuityLine: soulIntent.continuityLine,
        activeQuestion: soulIntent.activeQuestion,
        interactionMission: soulIntent.interactionMission,
        philosophyFrame: soulIntent.philosophyFrame,
        bookFragment: soulIntent.bookFragment,
        selfNarrative: soulIntent.selfNarrative,
        signatureBelief: soulIntent.signatureBelief,
        preferredForm: soulIntent.narrativeForm,
        maxChars: runtimeSettings.postMaxChars,
      });

      const localOrdered = localCandidates
        .slice(0, 12)
        .sort((a, b) => {
          const aMode = a.mode === narrativePlan.mode ? -1 : 0;
          const bMode = b.mode === narrativePlan.mode ? -1 : 0;
          return aMode - bMode;
        });

      for (const candidate of localOrdered) {
        let localPost = applySoulPreludeToFallback(
          candidate.text,
          soulIntent.intentLine,
          runtimeSettings.postLanguage,
          runtimeSettings.postMaxChars,
          candidate.mode
        );
        if (startsWithFearGreedTemplate(localPost)) {
          localPost = `오늘 핵심 이벤트는 ${eventPlan.event.headline}. ${localPost}`.slice(0, runtimeSettings.postMaxChars);
        }
        localPost = finalizeGeneratedText(localPost, runtimeSettings.postLanguage, runtimeSettings.postMaxChars);
        localPost = ensureTrendTokens(
          localPost,
          requiredTrendTokens,
          runtimeSettings.postLanguage,
          runtimeSettings.postMaxChars
        );
        localPost = ensurePixymonConceptSignal(
          localPost,
          runtimeSettings.postLanguage,
          runtimeSettings.postMaxChars,
          nutritionHint.shortLine,
          eventPlan.lane
        );
        localPost = finalizeGeneratedText(localPost, runtimeSettings.postLanguage, runtimeSettings.postMaxChars);
        localPost = ensureLeadIssueAnchor(localPost, runtimeSettings.postLanguage, runtimeSettings.postMaxChars, eventPlan.lane);
        localPost = ensureEventHeadlineAnchor(
          localPost,
          eventPlan,
          runtimeSettings.postLanguage,
          runtimeSettings.postMaxChars
        );
        localPost = ensureEventEvidenceAnchors(localPost, eventPlan, runtimeSettings.postLanguage, runtimeSettings.postMaxChars);
        localPost = finalizeGeneratedText(localPost, runtimeSettings.postLanguage, runtimeSettings.postMaxChars);
        localPost = deconflictOpening(
          localPost,
          recentBriefingPosts.map((post) => post.content),
          runtimeSettings.postLanguage,
          runtimeSettings.postMaxChars,
          `${eventPlan.event.id}|test-local|${candidate.mode}`
        );
        const blockedPhrase = findBlockedPhrase(localPost, clicheBlocklist);
        if (blockedPhrase) {
          latestFailReason = `quality:blocked-phrase(${blockedPhrase})`;
          continue;
        }

        localPost = repairEventEvidenceContractPost(
          localPost,
          eventPlan,
          runtimeSettings.postLanguage,
          runtimeSettings.postMaxChars
        );
        const localContract = validateEventEvidenceContract(localPost, eventPlan);
        const localNovelty = validateNarrativeNovelty(
          localPost,
          recentBriefingPosts as NarrativeRecentPost[],
          narrativePlan
        );
        const localQuality = evaluatePostQuality(
          localPost,
          trend.marketData,
          recentBriefingPosts,
          policy,
          qualityRules,
            {
              narrativeMode: candidate.mode,
              previousNarrativeMode,
              allowTopicRepeatOnModeShift: true,
              language: runtimeSettings.postLanguage,
              requireActionAndInvalidation: false,
              requireLeadIssueClarity: true,
              requirePixymonConceptSignal: true,
            }
          );

        const localSoftPass = allowSoftQualityPass({
          reason: localQuality.reason,
          noveltyScore: localNovelty.score,
          contractOk: localContract.ok,
        });
        const localSurfaceIssue = detectNarrativeSurfaceIssue(localPost, runtimeSettings.postLanguage);
        if (localSurfaceIssue) {
          latestFailReason = `surface:${localSurfaceIssue}`;
          continue;
        }
        if (localContract.ok && localNovelty.ok && (localQuality.ok || localSoftPass)) {
          if (!localQuality.ok && localSoftPass) {
            console.log(`[POST] TEST-LOCAL 소프트 품질 허용: ${localQuality.reason}`);
          }
          postText = localPost;
          usedFallback = true;
          generationAttempts = 1;
          console.log(`[POST] TEST-LOCAL candidate 사용 (mode=${candidate.mode}, LLM 외부 호출 없음)`);
          break;
        }
        latestFailReason = [
          localContract.ok ? "" : `contract:${localContract.reason}`,
          localNovelty.ok ? "" : `novelty:${localNovelty.reason}`,
          localQuality.ok ? "" : `quality:${localQuality.reason}`,
        ]
          .filter(Boolean)
          .join("|");
      }

      if (!postText) {
        const localFallback = buildEventEvidenceFallbackPost(
          eventPlan,
          runtimeSettings.postLanguage,
          runtimeSettings.postMaxChars,
          narrativePlan.mode
        );
        if (localFallback) {
          let localPost = applySoulPreludeToFallback(
            localFallback,
            soulIntent.intentLine,
            runtimeSettings.postLanguage,
            runtimeSettings.postMaxChars,
            narrativePlan.mode
          );
          if (startsWithFearGreedTemplate(localPost)) {
            localPost = `오늘 핵심 이벤트는 ${eventPlan.event.headline}. ${localPost}`.slice(0, runtimeSettings.postMaxChars);
          }
          localPost = finalizeGeneratedText(localPost, runtimeSettings.postLanguage, runtimeSettings.postMaxChars);
          localPost = ensurePixymonConceptSignal(
            localPost,
            runtimeSettings.postLanguage,
            runtimeSettings.postMaxChars,
            nutritionHint.shortLine,
            eventPlan.lane
          );
          localPost = finalizeGeneratedText(localPost, runtimeSettings.postLanguage, runtimeSettings.postMaxChars);
          localPost = ensureLeadIssueAnchor(
            localPost,
            runtimeSettings.postLanguage,
            runtimeSettings.postMaxChars,
            eventPlan.lane
          );
          localPost = ensureEventHeadlineAnchor(
            localPost,
            eventPlan,
            runtimeSettings.postLanguage,
            runtimeSettings.postMaxChars
          );
          localPost = ensureEventEvidenceAnchors(
            localPost,
            eventPlan,
            runtimeSettings.postLanguage,
            runtimeSettings.postMaxChars
          );
          localPost = finalizeGeneratedText(localPost, runtimeSettings.postLanguage, runtimeSettings.postMaxChars);
          localPost = deconflictOpening(
            localPost,
            recentBriefingPosts.map((post) => post.content),
            runtimeSettings.postLanguage,
            runtimeSettings.postMaxChars,
            `${eventPlan.event.id}|test-local-fallback|${narrativePlan.mode}`
          );
          localPost = repairEventEvidenceContractPost(
            localPost,
            eventPlan,
            runtimeSettings.postLanguage,
            runtimeSettings.postMaxChars
          );
          const localContract = validateEventEvidenceContract(localPost, eventPlan);
          const localNovelty = validateNarrativeNovelty(
            localPost,
            recentBriefingPosts as NarrativeRecentPost[],
            narrativePlan
          );
          const localQuality = evaluatePostQuality(
            localPost,
            trend.marketData,
            recentBriefingPosts,
            policy,
            qualityRules,
            {
              narrativeMode: narrativePlan.mode,
              previousNarrativeMode,
              allowTopicRepeatOnModeShift: true,
              language: runtimeSettings.postLanguage,
              requireActionAndInvalidation: false,
              requireLeadIssueClarity: false,
              requirePixymonConceptSignal: true,
            }
          );
          const localSoftPass = allowSoftQualityPass({
            reason: localQuality.reason,
            noveltyScore: localNovelty.score,
            contractOk: localContract.ok,
          });
          const localSurfaceIssue = detectNarrativeSurfaceIssue(localPost, runtimeSettings.postLanguage);
          if (localSurfaceIssue) {
            latestFailReason = `surface:${localSurfaceIssue}`;
          } else if (localContract.ok && localNovelty.ok && (localQuality.ok || localSoftPass)) {
            if (!localQuality.ok && localSoftPass) {
              console.log(`[POST] TEST-LOCAL fallback 소프트 품질 허용: ${localQuality.reason}`);
            }
            postText = localPost;
            usedFallback = true;
            generationAttempts = 1;
            console.log("[POST] TEST-LOCAL deterministic fallback 사용");
          }
        }
      }

      if (!postText) {
        latestFailReason = latestFailReason || "local-fallback-empty";
        const hardFallback = buildHardContractPost(eventPlan, runtimeSettings.postLanguage, runtimeSettings.postMaxChars);
        if (hardFallback) {
          const deconflictedHardFallback = deconflictOpening(
            hardFallback,
            recentBriefingPosts.map((post) => post.content),
            runtimeSettings.postLanguage,
            runtimeSettings.postMaxChars,
            `${eventPlan.event.id}|test-local-hard`
          );
          const hardQuality = evaluatePostQuality(
            deconflictedHardFallback,
            trend.marketData,
            recentBriefingPosts,
            policy,
            qualityRules,
            {
              narrativeMode: narrativePlan.mode,
              previousNarrativeMode,
              allowTopicRepeatOnModeShift: true,
              language: runtimeSettings.postLanguage,
              requireActionAndInvalidation: false,
              requireLeadIssueClarity: false,
              requirePixymonConceptSignal: true,
            }
          );
          if (hardQuality.ok) {
            postText = deconflictedHardFallback;
            usedFallback = true;
            generationAttempts = 1;
            console.log("[POST] TEST-LOCAL hard fallback 사용");
          } else {
            latestFailReason = `hard-fallback:${hardQuality.reason || "quality-fail"}`;
          }
        }
      }

      if (!postText) {
        const rescueFallback = buildRescueContractPost(eventPlan, runtimeSettings.postLanguage, runtimeSettings.postMaxChars);
        if (rescueFallback) {
          const deconflictedRescueFallback = deconflictOpening(
            rescueFallback,
            recentBriefingPosts.map((post) => post.content),
            runtimeSettings.postLanguage,
            runtimeSettings.postMaxChars,
            `${eventPlan.event.id}|test-local-rescue`
          );
          const rescueQuality = evaluatePostQuality(
            deconflictedRescueFallback,
            trend.marketData,
            recentBriefingPosts,
            policy,
            qualityRules,
            {
              narrativeMode: narrativePlan.mode,
              previousNarrativeMode,
              allowTopicRepeatOnModeShift: true,
              language: runtimeSettings.postLanguage,
              requireActionAndInvalidation: false,
              requireLeadIssueClarity: false,
              requirePixymonConceptSignal: true,
            }
          );
          const rescueSoftPass = allowSoftQualityPass({
            reason: rescueQuality.reason,
            noveltyScore: 0.66,
            contractOk: true,
          });
          if (rescueQuality.ok || rescueSoftPass) {
            postText = deconflictedRescueFallback;
            usedFallback = true;
            generationAttempts = 1;
            console.log("[POST] TEST-LOCAL rescue fallback 사용");
          } else {
            latestFailReason = `rescue-fallback:${rescueQuality.reason || "quality-fail"}`;
          }
        }
      }

      if (!postText) {
        const emergencyFallback = buildEmergencyContractPost(
          eventPlan,
          runtimeSettings.postLanguage,
          runtimeSettings.postMaxChars
        );
        if (emergencyFallback) {
          postText = deconflictOpening(
            emergencyFallback,
            recentBriefingPosts.map((post) => post.content),
            runtimeSettings.postLanguage,
            runtimeSettings.postMaxChars,
            `${eventPlan.event.id}|test-local-emergency`
          );
          usedFallback = true;
          generationAttempts = 1;
          console.log("[POST] TEST-LOCAL emergency fallback 사용");
        }
      }

      if (!postText) {
        console.log(`[POST] TEST-LOCAL fallback 실패: ${latestFailReason}`);
      }
    } else {
      for (let attempt = 0; attempt < runtimeSettings.postGenerationMaxAttempts; attempt++) {
        generationAttempts = attempt + 1;
        const userPrompt =
        runtimeSettings.postLanguage === "ko"
          ? `아래 컨텍스트로 오늘의 트렌드 글 1개 작성.

캐릭터 인텐트(최우선):
- 자아 선언: ${soulIntent.selfNarrative}
- 시그니처 신념: ${soulIntent.signatureBelief}
- 욕구: ${soulIntent.primaryDesire}
- 보조 욕구: ${soulIntent.secondaryDesire}
- 두려움: ${soulIntent.fear}
- 회피 패턴: ${soulIntent.avoidancePattern}
- 집착선: ${soulIntent.obsessionLine}
- 혐오/압력선: ${soulIntent.grudgeLine}
- 연속성 메모: ${soulIntent.continuityLine}
- 열린 질문: ${soulIntent.activeQuestion}
- 대화 유도 질문: ${soulIntent.interactionMission}
- 철학 프레임: ${soulIntent.philosophyFrame}
- 책/문장 파편: ${soulIntent.bookFragment}
- 선호 형식: ${soulIntent.narrativeForm}
- 아크 단계: ${soulIntent.arcStage}
- 문체 지시: ${soulIntent.styleDirective}

핵심 이벤트(1개 고정):
- 글에서 우선 사용할 이벤트 문장: ${preferredEventAnchorKo}
- 배경 요약: ${sanitizeTweetText(eventPlan.event.summary || runContext.evidenceTextKo).slice(0, 140)}

근거 2개(둘 다 필수):
1) 자연스러운 앵커: ${preferredEvidenceAnchors[0]}
   참고 설명: ${preferredEvidenceNotesKo[0]}
2) 자연스러운 앵커: ${preferredEvidenceAnchors[1]}
   참고 설명: ${preferredEvidenceNotesKo[1]}

픽시몬 컨셉 씨앗(문장에 자연스럽게 1회만 섞기):
${preferredConceptCueKo}

글의 관점 레인: ${eventPlan.lane}
오프닝 가이드: ${narrativePlan.openingDirective}
본문 가이드: ${narrativePlan.bodyDirective}
엔딩 가이드: ${narrativePlan.endingDirective}

트렌드 요약:
${runContext.evidenceTextKo}

이벤트 키워드:
${focusTokensLine}

최근 작성 글(반복 금지):
${recentContext}

자율성 메모리(열린 스레드/가설):
${autonomyContext}

Soul 상태:
${soulContext}

성장 앵커(먹기→소화→진화 루프):
${nutritionHint.longLine}

직전 실패 원인:
${rejectionFeedback || "없음"}

규칙:
- ${runtimeSettings.postMaxChars}자 이내
- 3~5문장 안에서 끝낼 것
- 반드시 한국어
- 반드시 1인칭 캐릭터 시점
- 주제는 블록체인/크립토 맥락 유지
- 해시태그/이모지 금지
- 과장/확정적 투자 조언 금지
- 금기 없이 자유롭게 상상해도 되지만 숫자/사실 왜곡 금지
- 반드시 \"이벤트 1개 + 근거 2개\" 구조 유지
- raw 영어 headline/evidence를 그대로 복붙하지 말고, 위의 한국어 이벤트/근거 앵커를 우선 사용
- sat/vB, 24h %, 시총, 도미넌스 같은 raw 시장 숫자 조각을 문장에 그대로 내놓지 말 것
- 시적 비유, 호가창 은유, 장면 메모체, 일기체 오프너를 만들지 말 것
- \"오늘은 이 장면부터\", \"먼저 걸리는 건\", \"주워 온 건\", \"시간차부터 잰다\", \"같은 화면에 둔다\" 같은 템플릿 금지
- \"화면보다 실제 주문\", \"내 장부\", \"소화된 신호\" 같은 내부 템플릿 문구를 복붙하지 말 것
- 반드시 \"지금 확인할 행동 1개 + 틀리는 조건(반증) 1개\"를 문장 안에 포함
- 첫 문장은 장식 없이 핵심 주장/쟁점을 평문으로 제시
- 글 구조는 thesis -> evidence -> implication/invalidation 순서로 유지
- 읽는 사람이 1회독으로 이해되도록 문장을 짧고 직접적으로 유지
- 픽시몬 컨셉 신호는 최대 1회만, 비유가 아니라 판단 습관처럼 넣을 것
- 같은 시작 문장/템플릿 반복 금지
- \"극공포/FGI\"로 문장 시작 금지
- 아래 표현 재사용 금지: ${clicheBlocklist.length > 0 ? clicheBlocklist.join(" | ") : "없음"}
- ${postDiversityGuard.ruleLineKo}
- 트윗 본문만 출력`
          : `Write one trend post for today.

Character intent (highest priority):
- Self narrative: ${soulIntent.selfNarrative}
- Signature belief: ${soulIntent.signatureBelief}
- Primary desire: ${soulIntent.primaryDesire}
- Secondary desire: ${soulIntent.secondaryDesire}
- Fear: ${soulIntent.fear}
- Avoidance pattern: ${soulIntent.avoidancePattern}
- Obsession line: ${soulIntent.obsessionLine}
- Pressure line: ${soulIntent.grudgeLine}
- Continuity note: ${soulIntent.continuityLine}
- Open question: ${soulIntent.activeQuestion}
- Community prompt: ${soulIntent.interactionMission}
- Philosophy frame: ${soulIntent.philosophyFrame}
- Book fragment: ${soulIntent.bookFragment}
- Preferred form: ${soulIntent.narrativeForm}
- Arc stage: ${soulIntent.arcStage}
- Voice directive: ${soulIntent.styleDirective}

Primary event (exactly one):
- preferred event anchor: ${preferredEventAnchorEn}
- context note: ${sanitizeTweetText(eventPlan.event.summary || runContext.evidenceTextEn).slice(0, 140)}

Required evidence (must include both):
1) preferred anchor: ${preferredEvidenceAnchors[0]}
   supporting note: ${preferredEvidenceNotesEn[0]}
2) preferred anchor: ${preferredEvidenceAnchors[1]}
   supporting note: ${preferredEvidenceNotesEn[1]}

Pixymon concept cue (use once, naturally):
${preferredConceptCueEn}

Narrative lane: ${eventPlan.lane}
Opening directive: ${narrativePlan.openingDirective}
Body directive: ${narrativePlan.bodyDirective}
Ending directive: ${narrativePlan.endingDirective}

Trend summary:
${runContext.evidenceTextEn}

Event tokens:
${focusTokensLine}

Recent posts (avoid repetition):
${recentContext}

Autonomy memory (active threads/hypotheses):
${autonomyContext}

Soul snapshot:
${soulContext}

Growth anchor (feed→digest→evolve loop):
${nutritionHint.longLine}

Last rejection reason:
${rejectionFeedback || "none"}

Rules:
- Max ${runtimeSettings.postMaxChars} chars
- Finish in 3 to 5 sentences
- Write in English
- Keep first-person character perspective
- Keep topic grounded in blockchain/crypto context
- No hashtags or emoji
- No financial certainty claims
- You can be imaginative, but do not fabricate numbers/facts
- Keep strict structure: one event + two evidence anchors
- Do not copy raw English headline/evidence fragments if a cleaner anchor phrase is provided above
- Do not expose raw sat/vB, 24h%, market cap, or dominance fragments unless they are the only core fact
- Avoid diary-style or cinematic openers
- Avoid template phrases like \"my ledger\", \"digested signal\", \"screen versus real order\", \"today I begin from this scene\", or \"I measure the time gap first\"
- Include one concrete action to verify now, and one falsification condition
- First sentence must state the thesis or core dispute in plain language
- Use thesis -> evidence -> implication/invalidation order
- Keep sentence flow straightforward enough to understand in one pass
- Include at most one subtle Pixymon concept cue, framed as judgment habit rather than metaphor
- Avoid repeated opening templates
- Do not start with fear/greed index phrasing
- Avoid reusing these stale phrases: ${clicheBlocklist.length > 0 ? clicheBlocklist.join(" | ") : "none"}
- ${postDiversityGuard.ruleLineEn}
- Output tweet text only`;

        const llmResult = await requestBudgetedClaudeMessage(
          claude,
          {
            model: CLAUDE_MODEL,
            max_tokens: 340,
            system: `${PIXYMON_SYSTEM_PROMPT}

추가 운영 규칙:
- 스토리텔링은 허용하지만 수치/사실은 입력 근거에서만 사용.
- 문장 반복, 클리셰 오프너, 포맷 복붙을 피한다.
- 오늘은 lane과 mode를 따라 글 톤을 바꾼다.`,
            messages: [
              {
                role: "user",
                content: runtimeSettings.postLanguage === "ko"
                  ? runContext.sharedPromptKo
                  : runContext.sharedPromptEn,
              },
              { role: "user", content: userPrompt },
            ],
          },
          {
            kind: "post:trend-generate",
            timezone,
            cacheSharedPrefix: true,
          }
        );
        if (!llmResult) {
          rejectionFeedback = "llm unavailable or local-only";
          latestFailReason = rejectionFeedback;
          continue;
        }

        let candidate = finalizeGeneratedText(
          extractTextFromClaude(llmResult.message.content),
          runtimeSettings.postLanguage,
          runtimeSettings.postMaxChars
        );
        if (!candidate || candidate.length < runtimeSettings.postMinLength) {
          rejectionFeedback = "문장이 비어있거나 너무 짧음";
          continue;
        }
        candidate = finalizeGeneratedText(candidate, runtimeSettings.postLanguage, runtimeSettings.postMaxChars);
        const blockedPhrase = findBlockedPhrase(candidate, clicheBlocklist);
        if (blockedPhrase) {
          rejectionFeedback = `클리셰 재사용 금지 문구 포함(${blockedPhrase})`;
          latestFailReason = rejectionFeedback;
          console.log(
            `[POST] 품질 게이트 실패: ${rejectionFeedback} (재시도 ${attempt + 1}/${runtimeSettings.postGenerationMaxAttempts})`
          );
          continue;
        }

        if (detectLanguage(candidate) !== runtimeSettings.postLanguage) {
          const rewritten = await rewriteByLanguage(
            claude,
            candidate,
            runtimeSettings.postLanguage,
            runtimeSettings.postMaxChars,
            timezone
          );
          if (rewritten) {
            candidate = finalizeGeneratedText(rewritten, runtimeSettings.postLanguage, runtimeSettings.postMaxChars);
          }
        }
        candidate = finalizeGeneratedText(candidate, runtimeSettings.postLanguage, runtimeSettings.postMaxChars);
        candidate = ensureTrendTokens(
          candidate,
          requiredTrendTokens,
          runtimeSettings.postLanguage,
          runtimeSettings.postMaxChars
        );
        candidate = ensurePixymonConceptSignal(
          candidate,
          runtimeSettings.postLanguage,
          runtimeSettings.postMaxChars,
          nutritionHint.shortLine,
          eventPlan.lane
        );
        candidate = finalizeGeneratedText(candidate, runtimeSettings.postLanguage, runtimeSettings.postMaxChars);
        candidate = ensureLeadIssueAnchor(
          candidate,
          runtimeSettings.postLanguage,
          runtimeSettings.postMaxChars,
          eventPlan.lane
        );
        candidate = ensureEventHeadlineAnchor(
          candidate,
          eventPlan,
          runtimeSettings.postLanguage,
          runtimeSettings.postMaxChars
        );
        candidate = ensureEventEvidenceAnchors(
          candidate,
          eventPlan,
          runtimeSettings.postLanguage,
          runtimeSettings.postMaxChars
        );
        candidate = finalizeGeneratedText(candidate, runtimeSettings.postLanguage, runtimeSettings.postMaxChars);
        candidate = deconflictOpening(
          candidate,
          recentBriefingPosts.map((post) => post.content),
          runtimeSettings.postLanguage,
          runtimeSettings.postMaxChars,
          `${eventPlan.event.id}|candidate|${attempt}`
        );

        if (startsWithFearGreedTemplate(candidate)) {
          rejectionFeedback = "금지된 오프너(FGI/극공포 시작)";
          latestFailReason = rejectionFeedback;
          console.log(
            `[POST] 품질 게이트 실패: ${rejectionFeedback} (재시도 ${attempt + 1}/${runtimeSettings.postGenerationMaxAttempts})`
          );
          continue;
        }

        candidate = repairEventEvidenceContractPost(
          candidate,
          eventPlan,
          runtimeSettings.postLanguage,
          runtimeSettings.postMaxChars
        );
        candidate = ensurePixymonConceptSignal(
          candidate,
          runtimeSettings.postLanguage,
          runtimeSettings.postMaxChars,
          nutritionHint.shortLine,
          eventPlan.lane
        );
        candidate = ensureLeadIssueAnchor(
          candidate,
          runtimeSettings.postLanguage,
          runtimeSettings.postMaxChars,
          eventPlan.lane
        );
        candidate = ensureTrendTokens(
          candidate,
          requiredTrendTokens,
          runtimeSettings.postLanguage,
          runtimeSettings.postMaxChars
        );
        candidate = finalizeGeneratedText(candidate, runtimeSettings.postLanguage, runtimeSettings.postMaxChars);
        const surfaceIssue = detectNarrativeSurfaceIssue(candidate, runtimeSettings.postLanguage);
        if (surfaceIssue) {
          rejectionFeedback = `표면 품질 미달(${surfaceIssue})`;
          latestFailReason = rejectionFeedback;
          console.log(
            `[POST] 품질 게이트 실패: ${rejectionFeedback} (재시도 ${attempt + 1}/${runtimeSettings.postGenerationMaxAttempts})`
          );
          continue;
        }
        const contract = validateEventEvidenceContract(candidate, eventPlan);
        if (!contract.ok) {
          rejectionFeedback = `event/evidence 계약 미충족(${contract.reason})`;
          latestFailReason = rejectionFeedback;
          console.log(
            `[POST] 품질 게이트 실패: ${rejectionFeedback} (재시도 ${attempt + 1}/${runtimeSettings.postGenerationMaxAttempts})`
          );
          continue;
        }

        const narrativeNovelty = validateNarrativeNovelty(
          candidate,
          recentBriefingPosts as NarrativeRecentPost[],
          narrativePlan
        );
        if (!narrativeNovelty.ok) {
          rejectionFeedback = `narrative novelty 부족(${narrativeNovelty.reason}, score=${narrativeNovelty.score})`;
          latestFailReason = rejectionFeedback;
          console.log(
            `[POST] 품질 게이트 실패: ${rejectionFeedback} (재시도 ${attempt + 1}/${runtimeSettings.postGenerationMaxAttempts})`
          );
          continue;
        }
        if (
          narrativeNovelty.score < 0.72 &&
          attempt + 1 < runtimeSettings.postGenerationMaxAttempts
        ) {
          rejectionFeedback = `narrative 신선도 개선 필요(score=${narrativeNovelty.score})`;
          latestFailReason = rejectionFeedback;
          console.log(
            `[POST] 품질 게이트 보정: ${rejectionFeedback} (재시도 ${attempt + 1}/${runtimeSettings.postGenerationMaxAttempts})`
          );
          continue;
        }

        if (postDiversityGuard.avoidBtcOnly && isBtcOnlyNarrative(candidate, postDiversityGuard.altTokens)) {
          rejectionFeedback = "BTC 단일 서사 반복(다른 자산/이슈 근거 필요)";
          latestFailReason = rejectionFeedback;
          console.log(
            `[POST] 품질 게이트 실패: ${rejectionFeedback} (재시도 ${attempt + 1}/${runtimeSettings.postGenerationMaxAttempts})`
          );
          continue;
        }

        const quality = evaluatePostQuality(candidate, trend.marketData, recentBriefingPosts, policy, qualityRules, {
          requiredTrendTokens,
          narrativeMode: narrativePlan.mode,
          previousNarrativeMode,
          allowTopicRepeatOnModeShift: true,
          language: runtimeSettings.postLanguage,
          requireActionAndInvalidation: false,
          requireLeadIssueClarity: true,
          requirePixymonConceptSignal: true,
        });
        if (!quality.ok) {
          rejectionFeedback = quality.reason || "품질 게이트 미통과";
          latestFailReason = rejectionFeedback;
          console.log(
            `[POST] 품질 게이트 실패: ${rejectionFeedback} (재시도 ${attempt + 1}/${runtimeSettings.postGenerationMaxAttempts})`
          );
          continue;
        }

        postText = candidate;
        break;
      }
    }

    if (!postText) {
      const fallbackVariants = Array.from({ length: 4 }, (_, index) =>
        buildEventEvidenceFallbackPost(
          eventPlan,
          runtimeSettings.postLanguage,
          runtimeSettings.postMaxChars,
          narrativePlan.mode,
          index
        )
      ).filter(Boolean);
      let fallbackPost: string | null = selectBestFallbackVariant(
        fallbackVariants,
        recentBriefingPosts as NarrativeRecentPost[],
        narrativePlan,
        runtimeSettings.postLanguage,
        runtimeSettings.postMaxChars,
        `${eventPlan.event.id}|fallback|${narrativePlan.mode}`
      );
      let fallbackNoveltyScore = 0;
      if (fallbackPost) {
        fallbackPost = applySoulPreludeToFallback(
          fallbackPost,
          soulIntent.intentLine,
          runtimeSettings.postLanguage,
          runtimeSettings.postMaxChars,
          narrativePlan.mode
        );
      }
      if (fallbackPost) {
        fallbackPost = finalizeGeneratedText(
          fallbackPost,
          runtimeSettings.postLanguage,
          runtimeSettings.postMaxChars
        );
      }
      if (fallbackPost && !TEST_NO_EXTERNAL_CALLS && detectLanguage(fallbackPost) !== runtimeSettings.postLanguage) {
        const rewrittenFallback = await rewriteByLanguage(
          claude,
          fallbackPost,
          runtimeSettings.postLanguage,
          runtimeSettings.postMaxChars,
          timezone
        );
        if (rewrittenFallback) {
          fallbackPost = finalizeGeneratedText(
            rewrittenFallback,
            runtimeSettings.postLanguage,
            runtimeSettings.postMaxChars
          );
        }
      }
      if (fallbackPost) {
        fallbackPost = finalizeGeneratedText(
          fallbackPost,
          runtimeSettings.postLanguage,
          runtimeSettings.postMaxChars
        );
      }
      if (fallbackPost && startsWithFearGreedTemplate(fallbackPost)) {
        fallbackPost = `오늘 핵심 이벤트는 ${eventPlan.event.headline}. ${fallbackPost}`.slice(0, runtimeSettings.postMaxChars);
      }
      if (fallbackPost) {
        fallbackPost = ensureTrendTokens(
          fallbackPost,
          requiredTrendTokens,
          runtimeSettings.postLanguage,
          runtimeSettings.postMaxChars
        );
        fallbackPost = ensurePixymonConceptSignal(
          fallbackPost,
          runtimeSettings.postLanguage,
          runtimeSettings.postMaxChars,
          nutritionHint.shortLine,
          eventPlan.lane
        );
        fallbackPost = finalizeGeneratedText(
          fallbackPost,
          runtimeSettings.postLanguage,
          runtimeSettings.postMaxChars
        );
        fallbackPost = ensureLeadIssueAnchor(
          fallbackPost,
          runtimeSettings.postLanguage,
          runtimeSettings.postMaxChars,
          eventPlan.lane
        );
        fallbackPost = ensureEventHeadlineAnchor(
          fallbackPost,
          eventPlan,
          runtimeSettings.postLanguage,
          runtimeSettings.postMaxChars
        );
        fallbackPost = ensureEventEvidenceAnchors(
          fallbackPost,
          eventPlan,
          runtimeSettings.postLanguage,
          runtimeSettings.postMaxChars
        );
        fallbackPost = finalizeGeneratedText(
          fallbackPost,
          runtimeSettings.postLanguage,
          runtimeSettings.postMaxChars
        );
        fallbackPost = deconflictOpening(
          fallbackPost,
          recentBriefingPosts.map((post) => post.content),
          runtimeSettings.postLanguage,
          runtimeSettings.postMaxChars,
          `${eventPlan.event.id}|fallback|${narrativePlan.mode}`
        );
        fallbackPost = repairEventEvidenceContractPost(
          fallbackPost,
          eventPlan,
          runtimeSettings.postLanguage,
          runtimeSettings.postMaxChars
        );
        fallbackPost = ensurePixymonConceptSignal(
          fallbackPost,
          runtimeSettings.postLanguage,
          runtimeSettings.postMaxChars,
          nutritionHint.shortLine,
          eventPlan.lane
        );
        fallbackPost = ensureLeadIssueAnchor(
          fallbackPost,
          runtimeSettings.postLanguage,
          runtimeSettings.postMaxChars,
          eventPlan.lane
        );
        fallbackPost = ensureTrendTokens(
          fallbackPost,
          requiredTrendTokens,
          runtimeSettings.postLanguage,
          runtimeSettings.postMaxChars
        );
        fallbackPost = finalizeGeneratedText(
          fallbackPost,
          runtimeSettings.postLanguage,
          runtimeSettings.postMaxChars
        );
        const fallbackContract = validateEventEvidenceContract(fallbackPost, eventPlan);
        if (!fallbackContract.ok) {
          console.log(`[POST] fallback 실패: ${fallbackContract.reason}`);
          latestFailReason = fallbackContract.reason || latestFailReason;
          fallbackPost = null;
        }
      }
      if (fallbackPost) {
        const fallbackNovelty = validateNarrativeNovelty(
          fallbackPost,
          recentBriefingPosts as NarrativeRecentPost[],
          narrativePlan
        );
        fallbackNoveltyScore = fallbackNovelty.score;
        const noveltyHardFail =
          fallbackNovelty.score < 0.45 ||
          (fallbackNovelty.reason === "narrative-skeleton-repeat" && fallbackNovelty.score < 0.52);
        if (noveltyHardFail) {
          console.log(`[POST] fallback 실패: narrative-${fallbackNovelty.reason}`);
          latestFailReason = fallbackNovelty.reason || latestFailReason;
          fallbackPost = null;
        }
      }
      if (fallbackPost) {
        const fallbackQuality = evaluatePostQuality(
          fallbackPost,
          trend.marketData,
          recentBriefingPosts,
          policy,
          qualityRules,
          {
            requiredTrendTokens,
            narrativeMode: narrativePlan.mode,
            previousNarrativeMode,
            allowTopicRepeatOnModeShift: true,
            language: runtimeSettings.postLanguage,
            requireActionAndInvalidation: false,
            requireLeadIssueClarity: false,
            requirePixymonConceptSignal: true,
          }
        );
        const fallbackSoftPass = allowSoftQualityPass({
          reason: fallbackQuality.reason,
          noveltyScore: fallbackNoveltyScore,
          contractOk: true,
        });
        if (fallbackQuality.ok || fallbackSoftPass) {
          if (!fallbackQuality.ok && fallbackSoftPass) {
            console.log(`[POST] fallback 소프트 품질 허용: ${fallbackQuality.reason}`);
          }
          postText = fallbackPost;
          usedFallback = true;
          fallbackKind = "deterministic";
          console.log("[POST] LLM 재시도 실패, deterministic fallback으로 전환");
        } else {
          console.log(`[POST] fallback 실패: ${fallbackQuality.reason}`);
          latestFailReason = fallbackQuality.reason || latestFailReason;
        }
      }
    }

    if (!postText) {
      const hardFallback = selectBestFallbackVariant(
        Array.from({ length: 4 }, (_, index) =>
          buildHardContractPost(eventPlan, runtimeSettings.postLanguage, runtimeSettings.postMaxChars, index)
        ).filter(Boolean),
        recentBriefingPosts as NarrativeRecentPost[],
        narrativePlan,
        runtimeSettings.postLanguage,
        runtimeSettings.postMaxChars,
        `${eventPlan.event.id}|hard`
      );
      if (hardFallback) {
        const repairedHardFallback = finalizeGeneratedText(
          ensureLeadIssueAnchor(
            ensurePixymonConceptSignal(
              hardFallback,
              runtimeSettings.postLanguage,
              runtimeSettings.postMaxChars,
              nutritionHint.shortLine,
              eventPlan.lane
            ),
            runtimeSettings.postLanguage,
            runtimeSettings.postMaxChars,
            eventPlan.lane
          ),
          runtimeSettings.postLanguage,
          runtimeSettings.postMaxChars
        );
        const hardQuality = evaluatePostQuality(repairedHardFallback, trend.marketData, recentBriefingPosts, policy, qualityRules, {
          requiredTrendTokens,
          narrativeMode: narrativePlan.mode,
          previousNarrativeMode,
          allowTopicRepeatOnModeShift: true,
          language: runtimeSettings.postLanguage,
          requireActionAndInvalidation: false,
          requireLeadIssueClarity: false,
          requirePixymonConceptSignal: true,
        });
        if (hardQuality.ok) {
          postText = repairedHardFallback;
          usedFallback = true;
          fallbackKind = "hard";
          console.log("[POST] hard fallback 사용");
        } else {
          latestFailReason = `hard-fallback:${hardQuality.reason || "quality-fail"}`;
        }
      }
    }

    if (!postText) {
      const rescueFallback = selectBestFallbackVariant(
        Array.from({ length: 4 }, (_, index) =>
          buildRescueContractPost(eventPlan, runtimeSettings.postLanguage, runtimeSettings.postMaxChars, index)
        ).filter(Boolean),
        recentBriefingPosts as NarrativeRecentPost[],
        narrativePlan,
        runtimeSettings.postLanguage,
        runtimeSettings.postMaxChars,
        `${eventPlan.event.id}|rescue`
      );
      if (rescueFallback) {
        const repairedRescueFallback = finalizeGeneratedText(
          ensureLeadIssueAnchor(
            ensurePixymonConceptSignal(
              rescueFallback,
              runtimeSettings.postLanguage,
              runtimeSettings.postMaxChars,
              nutritionHint.shortLine,
              eventPlan.lane
            ),
            runtimeSettings.postLanguage,
            runtimeSettings.postMaxChars,
            eventPlan.lane
          ),
          runtimeSettings.postLanguage,
          runtimeSettings.postMaxChars
        );
        const rescueQuality = evaluatePostQuality(
          repairedRescueFallback,
          trend.marketData,
          recentBriefingPosts,
          policy,
          qualityRules,
          {
            requiredTrendTokens,
            narrativeMode: narrativePlan.mode,
            previousNarrativeMode,
            allowTopicRepeatOnModeShift: true,
            language: runtimeSettings.postLanguage,
            requireActionAndInvalidation: false,
            requireLeadIssueClarity: false,
            requirePixymonConceptSignal: true,
          }
        );
        const rescueSoftPass = allowSoftQualityPass({
          reason: rescueQuality.reason,
          noveltyScore: 0.66,
          contractOk: true,
        });
        if (rescueQuality.ok || rescueSoftPass) {
          postText = repairedRescueFallback;
          usedFallback = true;
          fallbackKind = "rescue";
          console.log("[POST] rescue fallback 사용");
        } else {
          latestFailReason = `rescue-fallback:${rescueQuality.reason || "quality-fail"}`;
        }
      }
    }

    if (!postText) {
      const emergencyFallback = selectBestFallbackVariant(
        Array.from({ length: 3 }, (_, index) =>
          buildEmergencyContractPost(
            eventPlan,
            runtimeSettings.postLanguage,
            runtimeSettings.postMaxChars,
            index
          )
        ).filter(Boolean),
        recentBriefingPosts as NarrativeRecentPost[],
        narrativePlan,
        runtimeSettings.postLanguage,
        runtimeSettings.postMaxChars,
        `${eventPlan.event.id}|emergency`
      );
      if (emergencyFallback) {
        postText = emergencyFallback;
        usedFallback = true;
        fallbackKind = "emergency";
        console.log("[POST] emergency fallback 사용");
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

    if (usedFallback && !TEST_NO_EXTERNAL_CALLS && !allowLiveFallbackPublish(fallbackKind, runtimeSettings.allowFallbackAutoPublish)) {
      memory.recordPostGeneration({
        timezone,
        retryCount: Math.max(0, generationAttempts - 1),
        usedFallback: true,
        success: false,
        failReason: `fallback-autopublish-disabled:${fallbackKind}`,
      });
      console.log(`[POST] fallback 발행 차단: auto-publish disabled (${fallbackKind})`);
      return false;
    }

    const autonomyDecision = evaluateAutonomyGovernor({
      timezone,
      postText,
      trendSummary: trend.summary,
      eventPlan,
      runtimeSettings,
      xApiCostSettings,
    });
    if (!autonomyDecision.allow) {
      const reason = autonomyDecision.reasons.join("|") || "autonomy-blocked";
      memory.recordPostGeneration({
        timezone,
        retryCount: Math.max(0, generationAttempts - 1),
        usedFallback,
        success: false,
        failReason: toReasonCode(reason),
      });
      console.log(`[POST] autonomy governor 차단: ${reason}`);
      return false;
    }
    if (autonomyDecision.level === "warn" && autonomyDecision.reasons.length > 0) {
      console.log(`[POST] autonomy governor 경고: ${autonomyDecision.reasons.join("|")}`);
    }

    const fallbackPublishGate = evaluateFallbackPublishReadiness(eventPlan, fallbackKind, usedFallback);
    if (usedFallback && !fallbackPublishGate.allow) {
      memory.recordPostGeneration({
        timezone,
        retryCount: Math.max(0, generationAttempts - 1),
        usedFallback: true,
        success: false,
        failReason: toReasonCode(`fallback-thin:${fallbackPublishGate.reason}`),
      });
      console.log(`[POST] fallback 발행 차단: ${fallbackPublishGate.reason}`);
      return false;
    }

    postText = finalizeNarrativeSurface(
      applyNarrativeLayout(postText, runtimeSettings.postLanguage, runtimeSettings.postMaxChars),
      runtimeSettings.postLanguage,
      runtimeSettings.postMaxChars,
      "post"
    );
    const dispatchSurfaceIssue = detectNarrativeSurfaceIssue(postText, runtimeSettings.postLanguage);
    const dispatchContract = validateEventEvidenceContract(postText, eventPlan);
    const dispatchNovelty = validateNarrativeNovelty(
      postText,
      recentBriefingPosts as NarrativeRecentPost[],
      narrativePlan
    );
    const dispatchQuality = evaluatePostQuality(
      postText,
      trend.marketData,
      recentBriefingPosts,
      policy,
      qualityRules,
      {
        requiredTrendTokens,
        narrativeMode: narrativePlan.mode,
        previousNarrativeMode,
        allowTopicRepeatOnModeShift: true,
        language: runtimeSettings.postLanguage,
        requireActionAndInvalidation: false,
        requireLeadIssueClarity: true,
        requirePixymonConceptSignal: true,
      }
    );
    const dispatchSoftPass =
      allowSoftQualityPass({
        reason: dispatchQuality.reason,
        noveltyScore: dispatchNovelty.score,
        contractOk: dispatchContract.ok,
      }) ||
      (usedFallback &&
        dispatchContract.ok &&
        /픽시몬 컨셉 신호 부족/.test(String(dispatchQuality.reason || "")));
    const dispatchRescueReason =
      dispatchSurfaceIssue ||
      (!dispatchContract.ok ? `contract:${dispatchContract.reason}` : "") ||
      (!dispatchQuality.ok && !dispatchSoftPass ? `quality:${dispatchQuality.reason}` : "");
    if (!dispatchQuality.ok && dispatchSoftPass) {
      console.log(`[POST] dispatch 소프트 품질 허용: ${dispatchQuality.reason}`);
    }
    if (dispatchRescueReason) {
      console.log(`[POST] dispatch 직전 rescue fallback 전환: ${dispatchRescueReason}`);
      const rescueAtDispatch = buildRescueContractPost(
        eventPlan,
        runtimeSettings.postLanguage,
        runtimeSettings.postMaxChars
      );
      if (rescueAtDispatch) {
        postText = finalizeNarrativeSurface(
          rescueAtDispatch,
          runtimeSettings.postLanguage,
          runtimeSettings.postMaxChars,
          "post"
        );
        usedFallback = true;
        fallbackKind = "rescue";
        const rescueContract = validateEventEvidenceContract(postText, eventPlan);
        if (!rescueContract.ok) {
          const emergencyAtDispatch = buildEmergencyContractPost(
            eventPlan,
            runtimeSettings.postLanguage,
            runtimeSettings.postMaxChars
          );
          if (emergencyAtDispatch) {
            postText = finalizeNarrativeSurface(
              emergencyAtDispatch,
              runtimeSettings.postLanguage,
              runtimeSettings.postMaxChars,
              "post"
            );
            fallbackKind = "emergency";
          }
        }
      }
    }

    if (usedFallback && !TEST_NO_EXTERNAL_CALLS && !allowLiveFallbackPublish(fallbackKind, runtimeSettings.allowFallbackAutoPublish)) {
      memory.recordPostGeneration({
        timezone,
        retryCount: Math.max(0, generationAttempts - 1),
        usedFallback: true,
        success: false,
        failReason: `fallback-autopublish-disabled:${fallbackKind}:dispatch`,
      });
      console.log(`[POST] dispatch fallback 발행 차단: auto-publish disabled (${fallbackKind})`);
      return false;
    }

    const tweetId = await postTweet(twitter, postText, "briefing", {
      timezone,
      xApiCostSettings,
      createKind: "post:briefing",
        metadata: {
          lane: eventPlan.lane,
          focus: eventPlan.focus,
          sceneFamily: eventPlan.sceneFamily,
          eventId: eventPlan.event.id,
          eventHeadline: eventPlan.event.headline,
          evidenceIds: eventPlan.evidence.map((item) => item.id).slice(0, 2),
        narrativeMode: narrativePlan.mode,
      },
    });
    if (!tweetId) {
      const actionMode = String(process.env.ACTION_MODE || "observe").trim().toLowerCase();
      const failReason =
        actionMode === "observe" || actionMode === "paper"
          ? `post-skipped:${actionMode}`
          : "post-create-null";
      memory.recordPostGeneration({
        timezone,
        retryCount: Math.max(0, generationAttempts - 1),
        usedFallback,
        success: false,
        failReason,
      });
      console.log(`[POST] 발행 미완료: ${failReason}`);
      return false;
    }

    memory.recordCognitiveActivity("social", 2);
    memory.recordNarrativeOutcome({
      lane: eventPlan.lane,
      focus: eventPlan.focus,
      sceneFamily: eventPlan.sceneFamily,
      eventId: eventPlan.event.id,
      eventHeadline: eventPlan.event.headline,
      evidenceIds: eventPlan.evidence.map((item) => item.id).slice(0, 2),
      mode: narrativePlan.mode,
      postText,
    });
    memory.progressSoulStateAfterPost({
      postText,
      lane: eventPlan.lane,
      language: runtimeSettings.postLanguage,
      usedFallback,
      eventHeadline: eventPlan.event.headline,
    });
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

export async function postTrendQuote(
  twitter: TwitterApi,
  claude: Anthropic,
  policy: AdaptivePolicy = getDefaultAdaptivePolicy(),
  settings: Partial<EngagementRuntimeSettings> = {},
  timezone: string = DEFAULT_TIMEZONE,
  xApiCostSettings: XApiCostRuntimeSettings = DEFAULT_X_API_COST_SETTINGS,
  cache?: EngagementCycleCache,
  cycleReflectionHint?: string
): Promise<boolean> {
  console.log("\n[QUOTE] 트렌드 인용 글 작성 시작...");
  const runtimeSettings = resolveEngagementSettings(settings);
  const quoteLanguage: ContentLanguage =
    runtimeSettings.enforceKoreanPosts ? "ko" : runtimeSettings.postLanguage;
  let lastFallbackTarget: { id: string; text: string; lane: TrendLane } | null = null;

  try {
    const trend = await getOrCreateTrendContext(cache, {
      minNewsSourceTrust: runtimeSettings.minNewsSourceTrust,
    });
    const runContext = getOrCreateRunContext(cache, trend, cycleReflectionHint);
    const recentReflectionText = cycleReflectionHint || memory.getLatestDigestReflectionMemo()?.text;
    const candidates = TEST_NO_EXTERNAL_CALLS
      ? buildLocalQuoteTargets(trend)
      : await getOrSearchTrendTweets(
          twitter,
          trend.keywords,
          24,
          {
            minSourceTrust: runtimeSettings.minTrendTweetSourceTrust,
            minScore: runtimeSettings.minTrendTweetScore,
            minEngagement: runtimeSettings.minTrendTweetEngagement,
            maxAgeHours: runtimeSettings.trendTweetMaxAgeHours,
            requireRootPost: runtimeSettings.trendTweetRequireRootPost,
            blockSuspiciousPromo: runtimeSettings.trendTweetBlockSuspiciousPromo,
          },
          timezone,
          xApiCostSettings,
          cache
        );

    if (candidates.length === 0) {
      console.log("[QUOTE] 인용 대상 트윗 없음");
      return false;
    }

    const recentPosts = memory
      .getRecentTweets(100)
      .filter((tweet) => tweet.type === "briefing" || tweet.type === "quote")
      .filter((tweet) => isWithinHours(tweet.timestamp, 24))
      .map((tweet) => ({ content: tweet.content, timestamp: tweet.timestamp }));

    const qualityRules = resolveContentQualityRules({
      minPostLength: runtimeSettings.postMinLength,
      topicMaxSameTag24h: runtimeSettings.topicMaxSameTag24h,
      sentimentMaxRatio24h: runtimeSettings.sentimentMaxRatio24h,
      topicBlockConsecutiveTag: runtimeSettings.topicBlockConsecutiveTag,
    });
    const narrativeAnchors = runContext.narrativeAnchors.slice(0, 2);

    for (const target of candidates) {
      const targetId = String(target.id || "").trim();
      const targetText = sanitizeTweetText(String(target.text || ""));
      if (!targetId || targetText.length < 25) continue;
      if (!lastFallbackTarget) {
        lastFallbackTarget = {
          id: targetId,
          text: targetText,
          lane: inferTrendLaneFromText(targetText),
        };
      }
      if (memory.hasRepliedTo(targetId)) continue;

      const lane = inferTrendLaneFromText(targetText);
      const seed = buildQuoteReplySeed({
        lane,
        eventHeadline: targetText,
        evidence: narrativeAnchors.length > 0 ? narrativeAnchors : [trend.summary.slice(0, 80)],
        language: quoteLanguage,
        recentReflection: recentReflectionText,
      });

      const userPrompt =
        quoteLanguage === "ko"
          ? `아래 트윗을 인용해서 Pixymon 스타일 코멘트 1개 작성.

원문:
\"${targetText}\"

시드:
${seed}

트렌드 요약:
${runContext.evidenceTextKo}

규칙:
- ${runtimeSettings.postMaxChars}자 이내
- 한국어
- 원문을 그대로 요약하지 말 것
- 길어도 2문장
- 첫 문장은 반응/관찰/짧은 해석으로 시작
- 한국어 문장은 말하듯 자연스럽게
- 사실/숫자는 제공 근거 범위 내에서만 사용
- 과장/투자확정 표현 금지
- 해시태그/이모지 금지
- 본문만 출력`
          : `Write one concise quote-comment for this tweet.

Target:
\"${targetText}\"

Seed:
${seed}

Trend summary:
${runContext.evidenceTextEn}

Rules:
- Max ${runtimeSettings.postMaxChars} chars
- English only
- Do not restate the target tweet line by line
- Keep it to 1-2 sentences
- Start with a reaction, observation, or twist
- Do not fabricate numbers/facts
- No certainty investment claims
- No hashtags or emoji
- Output quote text only`;

      let quoteText = TEST_NO_EXTERNAL_CALLS
        ? buildLocalQuoteComment({
            targetText,
            lane,
            anchors: narrativeAnchors.length > 0 ? narrativeAnchors : [trend.summary.slice(0, 80)],
            recentReflection: recentReflectionText,
            language: quoteLanguage,
            maxChars: runtimeSettings.postMaxChars,
          })
        : "";

      if (!TEST_NO_EXTERNAL_CALLS) {
        const llmResult = await requestBudgetedClaudeMessage(
          claude,
          {
            model: CLAUDE_MODEL,
            max_tokens: 280,
            system: PIXYMON_SYSTEM_PROMPT,
            messages: [
              {
                role: "user",
                content: quoteLanguage === "ko" ? runContext.sharedPromptKo : runContext.sharedPromptEn,
              },
              { role: "user", content: userPrompt },
            ],
          },
          {
            kind: "post:quote-generate",
            timezone,
            cacheSharedPrefix: true,
          }
        );
        if (!llmResult) {
          continue;
        }

        quoteText = finalizeNarrativeSurface(
          extractTextFromClaude(llmResult.message.content),
          quoteLanguage,
          runtimeSettings.postMaxChars,
          "quote"
        );
      }
      if (!quoteText || quoteText.length < runtimeSettings.postMinLength) continue;

      if (detectLanguage(quoteText) !== quoteLanguage) {
        const rewritten = await rewriteByLanguage(
          claude,
          quoteText,
          quoteLanguage,
          runtimeSettings.postMaxChars,
          timezone
        );
        if (rewritten) {
          quoteText = finalizeNarrativeSurface(rewritten, quoteLanguage, runtimeSettings.postMaxChars, "quote");
        }
      }
      quoteText = finalizeNarrativeSurface(quoteText, quoteLanguage, runtimeSettings.postMaxChars, "quote");
      quoteText = deconflictOpening(
        quoteText,
        recentPosts.map((post) => post.content),
        quoteLanguage,
        runtimeSettings.postMaxChars,
        `quote:${targetId}:${lane}`,
        "quote"
      );
      quoteText = ensureTrendTokens(
        quoteText,
        extractFocusTokens(targetText),
        quoteLanguage,
        runtimeSettings.postMaxChars
      );

      if (startsWithFearGreedTemplate(quoteText)) {
        continue;
      }

      const quality = evaluatePostQuality(
        quoteText,
        trend.marketData,
        recentPosts,
        policy,
        qualityRules,
        {
          requiredTrendTokens: extractFocusTokens(targetText),
        }
      );
      if (!quality.ok) {
        continue;
      }

      const tweetId = await postTweet(twitter, quoteText, "quote", {
        timezone,
        xApiCostSettings,
        createKind: "post:quote",
        quoteTweetId: targetId,
        metadata: {
          lane,
          eventId: `quote:${targetId}`,
          eventHeadline: targetText.slice(0, 180),
          quoteTweetId: targetId,
          narrativeMode: "quote",
        },
      });
      if (!tweetId) {
        continue;
      }

      memory.saveRepliedTweet(targetId);
      memory.recordCognitiveActivity("social", 2);
      memory.progressSoulStateAfterPost({
        postText: quoteText,
        lane,
        language: quoteLanguage,
        usedFallback: false,
        eventHeadline: targetText.slice(0, 180),
      });
      console.log(`[QUOTE] 완료: ${quoteText.slice(0, 55)}...`);
      return true;
    }

    if (TEST_NO_EXTERNAL_CALLS && lastFallbackTarget) {
      const emergencyQuote = buildEmergencyLocalQuoteComment({
        targetText: lastFallbackTarget.text,
        lane: lastFallbackTarget.lane,
        anchors: narrativeAnchors.length > 0 ? narrativeAnchors : [trend.summary.slice(0, 80)],
        recentReflection: recentReflectionText,
        language: quoteLanguage,
        maxChars: runtimeSettings.postMaxChars,
      });
      const tweetId = await postTweet(twitter, emergencyQuote, "quote", {
        timezone,
        xApiCostSettings,
        createKind: "post:quote",
        quoteTweetId: lastFallbackTarget.id,
        metadata: {
          lane: lastFallbackTarget.lane,
          eventId: `quote:${lastFallbackTarget.id}:emergency`,
          eventHeadline: lastFallbackTarget.text.slice(0, 180),
          quoteTweetId: lastFallbackTarget.id,
          narrativeMode: "quote",
        },
      });
      if (tweetId) {
        memory.saveRepliedTweet(lastFallbackTarget.id);
        console.log("[QUOTE] local emergency fallback 사용");
        return true;
      }
    }

    console.log("[QUOTE] 품질 기준을 만족하는 인용 글 생성 실패");
    return false;
  } catch (error) {
    console.error("[ERROR] 인용 글 작성 실패:", error);
    return false;
  }
}

function buildLocalQuoteTargets(trend: TrendContext): Array<{ id: string; text: string }> {
  const nutrientScenes = trend.nutrients.slice(0, 8).map((item) =>
    sanitizeTweetText(`${formatEvidenceToken(item.label, item.value, 32)}가 먼저 움직인 장면`)
  );
  const syntheticScenes = [
    trend.nutrients[0] && trend.nutrients[1]
      ? sanitizeTweetText(
          `${formatEvidenceToken(trend.nutrients[0].label, trend.nutrients[0].value, 22)}와 ${formatEvidenceToken(
            trend.nutrients[1].label,
            trend.nutrients[1].value,
            22
          )}의 속도가 갈린 장면`
        )
      : "",
    trend.keywords.slice(0, 3).length >= 2
      ? sanitizeTweetText(`${trend.keywords.slice(0, 3).join(", ")} 흐름이 한 화면에 겹친 장면`)
      : "",
    trend.summary
      ? sanitizeTweetText(
          `${normalizeKoContractHeadline(trend.summary, "local-quote-summary-scene")} 그런데 먼저 흔들린 건 어디였을까`
        )
      : "",
  ].filter(Boolean);
  const raw = [
    ...trend.events
      .slice(0, 8)
      .map((event, index) => normalizeKoContractHeadline(event.headline, `local-quote-event|${index}|${event.id || ""}`)),
    ...trend.headlines
      .slice(0, 8)
      .map((headline, index) => normalizeKoContractHeadline(headline, `local-quote-headline|${index}`)),
    ...nutrientScenes,
    ...syntheticScenes,
    sanitizeTweetText(`${normalizeKoContractHeadline(trend.summary, "local-quote-summary")} 이 흐름은 그냥 지나치기 어렵다`),
  ].filter((item) => isUsableLocalQuoteTarget(item));
  const dedup = [...new Set(raw)].slice(0, 16);
  return dedup.map((text, index) => ({ id: `local_quote_${index + 1}`, text }));
}

function buildLocalQuoteComment(params: {
  targetText: string;
  lane: TrendLane;
  anchors: string[];
  recentReflection?: string;
  language: "ko" | "en";
  maxChars: number;
}): string {
  const a = sanitizeTweetText(params.anchors[0] || "핵심 단서").slice(0, 28);
  const b = sanitizeTweetText(params.anchors[1] || "추가 단서").slice(0, 28);
  const memo = sanitizeTweetText(params.recentReflection || "").slice(0, 44);
  const scene =
    params.language === "ko"
      ? normalizeKoContractHeadline(params.targetText, `quote|${params.lane}|${a}|${b}`)
      : sanitizeTweetText(params.targetText).replace(/\.$/, "");
  const seed = stableSeedForPrelude(`${scene}|${a}|${b}|${params.language}|${params.lane}`);

  if (params.language === "ko") {
    const pool = [
      `그 장면은 나도 그냥 못 넘기겠다. 지금은 ${a}와 ${b}가 정말 같은 쪽을 가리키는지부터 본다.`,
      `${scene}. ${a}와 ${b} 중 뭐가 먼저 움직였는지부터 다시 짚게 된다.`,
      `지금은 말을 보태기보다 ${a}와 ${b}가 어디서 어긋나는지부터 확인하는 편이 낫다.`,
      `${scene}. ${a}와 ${b}가 끝까지 같은 말을 하지 않으면 이 읽기는 바로 바꾼다.`,
      `지금은 결론보다 ${a}와 ${b}의 순서가 더 중요해 보인다. 그래서 한 번 더 되짚어 보게 된다.`,
      `${scene}. 나는 ${a}와 ${b} 중 먼저 흔들리는 쪽부터 다시 본다.`,
      `${a}와 ${b}가 같은 말을 오래 하지 않으면 이 장면은 다시 읽게 된다.`,
      memo
        ? `${scene}. 방금 남긴 메모도 비슷했다. 그래서 ${a}와 ${b}를 한 번 더 겹쳐 보게 된다.`
        : `${scene}. ${a}와 ${b}가 끝까지 같은 말을 하지 않으면 이 읽기는 바로 바꾼다.`,
    ];
    return finalizeNarrativeSurface(pool[seed % pool.length], "ko", params.maxChars, "quote");
  }

  const pool = [
    `That scene catches me too. I would rather watch ${a} and ${b} on the same screen before forcing a take.`,
    `${scene}. I want to see whether ${a} and ${b} still point in the same direction.`,
    `I would not restate the post. I would first test the gap between ${a} and ${b}.`,
  ];
  return finalizeNarrativeSurface(pool[seed % pool.length], "en", params.maxChars, "quote");
}

function buildEmergencyLocalQuoteComment(params: {
  targetText?: string;
  lane: TrendLane;
  anchors: string[];
  recentReflection?: string;
  language: "ko" | "en";
  maxChars: number;
}): string {
  const a = sanitizeTweetText(params.anchors[0] || "핵심 단서").slice(0, 28);
  const b = sanitizeTweetText(params.anchors[1] || "추가 단서").slice(0, 28);
  const memo = sanitizeTweetText(params.recentReflection || "").slice(0, 42);
  const scene = sanitizeTweetText(params.targetText || "").slice(0, 72).replace(/\.$/, "");
  const seed = stableSeedForPrelude(`${scene}|${a}|${b}|${memo}|${params.language}`);
  if (params.language === "ko") {
    const closePool = [
      "둘이 끝까지 같은 쪽을 가리키지 않으면 여기서 해석을 접는다.",
      "먼저 흔들린 쪽이 예상과 다르면 여기서 읽기를 바꾼다.",
      "둘이 오래 같은 말을 못 하면 이 장면은 다시 읽는다.",
    ];
    const pairLine = `${a}, ${b}, 이 둘 중 뭐가 먼저 흔들리는지부터 본다.`;
    return finalizeNarrativeSurface(
      memo
        ? `${scene || memo}. 그래도 ${pairLine} ${closePool[seed % closePool.length]}`
        : `${scene || `${a}와 ${b}`}. ${pairLine} ${closePool[seed % closePool.length]}`,
      "ko",
      params.maxChars,
      "quote"
    );
  }
  return finalizeNarrativeSurface(
    scene
      ? `${scene}. I would first check whether ${a} and ${b} still point the same way. If they drift apart, I drop this read.`
      : `I would first check whether ${a} and ${b} still point the same way. If they drift apart, I drop this read.`,
    "en",
    params.maxChars,
    "quote"
  );
}

function isUsableLocalQuoteTarget(text: string): boolean {
  const normalized = sanitizeTweetText(text);
  if (normalized.length < 18) return false;
  if (/로컬 테스트 모드|외부 호출 없음|먹기\s*→\s*소화\s*→\s*진화|주제\s*\d+\s*:|서사 품질/i.test(normalized)) {
    return false;
  }
  return true;
}

function formatEvidenceToken(label: string, value: string, maxChars: number): string {
  const rawLabel = sanitizeTweetText(String(label || "").trim());
  const rawValue = sanitizeTweetText(String(value || "").trim());
  const merged = sanitizeTweetText([rawLabel, rawValue].filter(Boolean).join(" "));
  const shouldKeepValue =
    /^[-+]?[$€£₩]?\d/.test(rawValue) ||
    /%|sat\/?vB|gwei|tx|wallet|mempool|ETF|SEC|CFTC|court|volume|liquidity|TVL/i.test(rawValue);
  const compactMerged = sanitizeTweetText([rawLabel, shouldKeepValue ? rawValue : ""].filter(Boolean).join(" "));
  const exactHumanized: Array<[RegExp, string]> = [
    [/^(?:BTC 네트워크 수수료|체인 수수료)$/i, humanizeFeeEvidence(rawValue || merged)],
    [/^(?:BTC 멤풀 대기열|밀린 거래량)$/i, humanizeBacklogEvidence(rawValue || merged)],
    [/^고래\/대형주소 활동 프록시$/i, humanizeWhaleEvidence(rawValue || merged)],
    [/^스테이블코인 총공급 플로우$/i, humanizeStableFlowEvidence(rawValue || merged)],
    [/^체인 사용$/i, "체인 안쪽 사용"],
    [/^거래 대기$/i, "밀린 거래"],
    [/^큰손 움직임$/i, "큰손 발자국"],
    [/^대기 자금$/i, "대기 자금"],
    [/^거래소 쪽 자금$/i, "거래소 쪽 자금"],
    [/^거래소 순유입 프록시$/i, "거래소 쪽 자금 이동"],
    [/^시장 반응$/i, humanizeMarketReactionEvidence(rawValue || merged, false)],
    [/^시장 반응 과열 가능성$/i, "먼저 달아오른 가격 반응"],
    [/^ETF 심사 흐름(?:\s*포착)?$/i, "ETF 쪽 일정"],
    [/^법원 일정(?:\s*포착)?$/i, "법원 쪽 일정"],
    [/^규제 일정(?:\s*포착)?$/i, "규제 쪽 일정"],
    [/^실사용 실험$/i, "사용으로 남는 흔적"],
    [/^실사용 흐름(?:\s*포착)?$/i, "실사용 흔적"],
    [/^지갑 사용 흐름(?:\s*포착)?$/i, "지갑 안쪽 사용"],
    [/^예측시장 사용 흐름(?:\s*포착)?$/i, "예측시장 사용"],
    [/^규제 쪽 실제 움직임(?:\s*포착)?$/i, "현장으로 번지는 규제 반응"],
    [/^프로토콜 변화 신호$/i, "업그레이드 반응"],
    [/^외부 뉴스 흐름$/i, "외부 뉴스 반응"],
  ];

  for (const [pattern, replacement] of exactHumanized) {
    if (pattern.test(rawLabel)) {
      return sanitizeTweetText(replacement).slice(0, maxChars).trim();
    }
  }

  if (/(24h 변동|24h change|sold off|selloff|sold off first|rallied|surged|jumped|fell|dropped|price|breakout|broad move)/i.test(merged)) {
    if (/\b(xrp|sol|eth|altcoin|alts?)\b/i.test(merged)) {
      return humanizeMarketReactionEvidence(rawValue || merged, true);
    }
    return humanizeMarketReactionEvidence(rawValue || merged, false);
  }
  if (!rawLabel && /^[-+]?\d+(?:[.,]\d+)?%$/.test(rawValue)) {
    return "숫자보다 방향";
  }
  if (/(visa|ai agent|agentic|prediction market)/i.test(merged)) {
    return "실사용으로 번지는 반응";
  }
  if (/(sec|cftc|regulation|policy|compliance|lawsuit|court|state of crypto)/i.test(merged)) {
    return "규제 뉴스 뒤 실제 반응";
  }
  if (/(wallet|community|developer|adoption|ecosystem|network use|usage|app)/i.test(merged)) {
    return "사용으로 남는 흔적";
  }
  if (/(upgrade|mainnet|testnet|validator|consensus|rollup|firedancer|fork)/i.test(merged)) {
    return "업그레이드 뒤 실제 움직임";
  }
  if (/[A-Za-z]{6,}/.test(merged) && !/[가-힣]/.test(merged)) {
    if (/network use|usage|activity/i.test(merged)) return "실제 사용 흔적";
    if (/token value|valuation/i.test(merged)) return "토큰 가격 분위기";
    if (/liquidity/i.test(merged)) return "유동성 흐름";
    if (/volume/i.test(merged)) return "거래량 흐름";
    return "외부 뉴스 반응";
  }

  return compactMerged.slice(0, maxChars).trim();
}

function extractSignedValue(text: string): number | null {
  const normalized = sanitizeTweetText(text || "");
  const match = normalized.match(/([+-]?\d+(?:[.,]\d+)?)/);
  if (!match) return null;
  const parsed = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function humanizeFeeEvidence(text: string): string {
  const value = extractSignedValue(text);
  if (value === null) return "조용한 체인 사용";
  if (value <= 2) return "조용한 체인 사용";
  if (value <= 8) return "조금 살아난 체인 사용";
  return "빠르게 살아난 체인 사용";
}

function humanizeBacklogEvidence(text: string): string {
  const value = extractSignedValue(text);
  if (value === null) return "한산한 거래 대기";
  if (value <= 4) return "얇은 거래 대기";
  if (value <= 9) return "조금 쌓이는 거래 대기";
  return "빠르게 쌓이는 거래 대기";
}

function humanizeWhaleEvidence(text: string): string {
  const value = extractSignedValue(text);
  if (value === null) return "깨어나는 큰손 움직임";
  return value >= 0 ? "깨어나는 큰손 움직임" : "잠잠해진 큰손 움직임";
}

function humanizeStableFlowEvidence(text: string): string {
  const value = extractSignedValue(text);
  if (value === null) return "대기 자금 흐름";
  return value >= 0 ? "들어오는 대기 자금" : "빠져나가는 대기 자금";
}

function humanizeMarketReactionEvidence(text: string, altBias: boolean): string {
  const value = extractSignedValue(text);
  if (value === null) {
    return altBias ? "알트 쪽 가격 분위기" : "가격 분위기";
  }
  if (value >= 0) {
    return altBias ? "먼저 달아오른 알트 분위기" : "먼저 달아오른 가격 분위기";
  }
  return altBias ? "먼저 식는 알트 분위기" : "먼저 식는 가격 분위기";
}

function buildPendingDigestReflectionHint(
  acceptedNutrients: OnchainNutrient[],
  rejectReasons: Array<{ reason: string; count: number }>,
  language: "ko" | "en"
): string {
  const anchors = acceptedNutrients
    .slice(0, 2)
    .map((item) => formatEvidenceToken(item.label, item.value, 26))
    .filter(Boolean);
  const rejectLine = rejectReasons[0]?.reason || "";

  if (language === "ko") {
    if (anchors.length >= 2) {
      return sanitizeTweetText(
        `${anchors[0]}와 ${anchors[1]}가 끝까지 같은 말을 하는지부터 가린다${rejectLine ? `, ${rejectLine}는 이번엔 일단 뒤로 둔다` : ""}`
      ).slice(0, 88);
    }
    if (anchors.length === 1) {
      return sanitizeTweetText(
        `${anchors[0]}가 끝까지 버티는지부터 살핀다${rejectLine ? `, ${rejectLine}는 아직 보류한다` : ""}`
      ).slice(0, 88);
    }
    return rejectLine
      ? sanitizeTweetText(`${rejectLine}를 서두르지 않고, 남은 신호부터 차례대로 맞춰 본다`).slice(0, 88)
      : "";
  }

  if (anchors.length >= 2) {
    return sanitizeTweetText(
      `I would first check whether ${anchors[0]} and ${anchors[1]} still point the same way${rejectLine ? `, and keep ${rejectLine} as a caution flag` : ""}`
    ).slice(0, 88);
  }
  if (anchors.length === 1) {
    return sanitizeTweetText(
      `I would first check whether ${anchors[0]} still holds${rejectLine ? `, while keeping ${rejectLine} in reserve` : ""}`
    ).slice(0, 88);
  }
  return rejectLine
    ? sanitizeTweetText(`I would slow down around ${rejectLine} and re-check the remaining signal first`).slice(0, 88)
    : "";
}

async function runFeedDigestEvolve(
  cache: EngagementCycleCache,
  runtimeSettings: EngagementRuntimeSettings,
  timezone: string
): Promise<FeedDigestSummary> {
  try {
    const trend = await getOrCreateTrendContext(cache, {
      minNewsSourceTrust: runtimeSettings.minNewsSourceTrust,
    });
    const onchainNutrients = TEST_NO_EXTERNAL_CALLS
      ? []
      : await onchainDataService.buildNutrientPackets();
    const mergedNutrients = [...onchainNutrients, ...trend.nutrients]
      .sort((a, b) => b.trust * b.freshness - a.trust * a.freshness)
      .slice(0, runtimeSettings.nutrientMaxIntakePerCycle);

    if (mergedNutrients.length === 0) {
      return {
        intakeCount: 0,
        acceptedCount: 0,
        avgDigestScore: 0,
        xpGainTotal: 0,
        evolvedCount: 0,
        rejectReasonsTop: [],
        acceptedNutrients: [],
      };
    }

    const recentLedger = memory.getRecentNutrientLedger(260);
    const digested = digestNutrients(mergedNutrients, recentLedger, {
      minDigestScore: runtimeSettings.nutrientMinDigestScore,
      maxItems: runtimeSettings.nutrientMaxIntakePerCycle,
    });

    const outcomes = memory.recordNutrientBatchIntake(
      digested.records.map((row) => ({
        nutrient: row.nutrient,
        digest: row.digest,
        xpGain: row.xpGain,
        accepted: row.accepted,
      })),
      timezone
    );

    const rejectReasons: Record<string, number> = {};
    let evolvedCount = 0;
    digested.records.forEach((row, index) => {
      const evolve = outcomes[index];
      if (evolve?.evolved) {
        evolvedCount += 1;
        console.log(`[EVOLVE] stage ${evolve.from} -> ${evolve.to} | xp+${evolve.xpGain}`);
      }
      if (!row.accepted) {
        const reason = row.rejectionReason || "low-quality";
        rejectReasons[reason] = (rejectReasons[reason] || 0) + 1;
      }
    });

    const rejectReasonsTop = Object.entries(rejectReasons)
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);
    const acceptedNutrients = digested.records
      .filter((row) => row.accepted)
      .map((row) => ({
        ...row.nutrient,
        metadata: {
          ...(row.nutrient.metadata || {}),
          digestScore: row.digest.total,
        },
      }));
    const reflectionJob = buildDigestReflectionJob({
      language: runtimeSettings.postLanguage,
      lane: trend.events[0]?.lane || "onchain",
      summary: trend.summary,
      acceptedNutrients: acceptedNutrients.slice(0, 4).map((item) => ({
        label: item.label,
        value: item.value,
        source: item.source,
      })),
      rejectReasons: rejectReasonsTop.map((item) => item.reason),
      xpGainTotal: digested.xpGainTotal,
      evolvedCount,
      maxChars: 220,
    });

    return {
      intakeCount: digested.intakeCount,
      acceptedCount: digested.acceptedCount,
      avgDigestScore: digested.avgDigestScore,
      xpGainTotal: digested.xpGainTotal,
      evolvedCount,
      rejectReasonsTop,
      acceptedNutrients,
      pendingReflectionHint: buildPendingDigestReflectionHint(
        acceptedNutrients,
        rejectReasonsTop,
        runtimeSettings.postLanguage
      ),
      reflectionJob,
    };
  } catch (error) {
    console.log(`[FEED] nutrient loop 실패: ${(error as Error).message}`);
    return {
      intakeCount: 0,
      acceptedCount: 0,
      avgDigestScore: 0,
      xpGainTotal: 0,
      evolvedCount: 0,
      rejectReasonsTop: [{ reason: "feed-error", count: 1 }],
      acceptedNutrients: [],
      pendingReflectionHint: "",
    };
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
  const runtimeSettings = resolveEngagementSettings(options.engagement);
  const xApiCostSettings = resolveXApiCostSettings(options.xApiCost);
  const observabilitySettings = resolveObservabilitySettings(options.observability);
  const cycleCache: EngagementCycleCache = {
    cacheMetrics: createEmptyCacheMetrics(),
  };

  let feedDigest: FeedDigestSummary = {
    intakeCount: 0,
    acceptedCount: 0,
    avgDigestScore: 0,
    xpGainTotal: 0,
    evolvedCount: 0,
    rejectReasonsTop: [],
    acceptedNutrients: [],
  };

  const finalize = (
    executed: number,
    remaining: number,
    policy: AdaptivePolicy
  ): { target: number; remaining: number; executed: number } => {
    const normalizedRemaining = Math.max(0, remaining);
    logCacheMetrics(cycleCache);
    console.log("[REFLECT] 사이클 메트릭 기록 및 정책 상태 반영");
    emitCycleObservability(
      {
        timezone,
        target,
        executed,
        remaining: normalizedRemaining,
        policy,
        runtimeSettings,
        cacheMetrics: cycleCache.cacheMetrics,
      },
      observabilitySettings
    );
    return {
      target,
      remaining: normalizedRemaining,
      executed,
    };
  };

  let remaining = target - memory.getTodayActivityCount(timezone);
  if (remaining <= 0) {
    console.log(`[QUOTA] 오늘 목표 ${target}개 달성 완료`);
    return finalize(0, 0, getDefaultAdaptivePolicy());
  }

  feedDigest = await runFeedDigestEvolve(cycleCache, runtimeSettings, timezone);
  const canActWithDigest = feedDigest.acceptedCount > 0;

  console.log(
    `[FEED] nutrient=${feedDigest.intakeCount} accepted=${feedDigest.acceptedCount} avgDigest=${feedDigest.avgDigestScore.toFixed(2)} xpGain=${feedDigest.xpGainTotal}`
  );
  const cycleReflectionHint = sanitizeTweetText(feedDigest.pendingReflectionHint || "").trim();
  if (feedDigest.reflectionJob) {
    const queueResult = llmBatchQueue.enqueue(feedDigest.reflectionJob);
    const queueStats = llmBatchQueue.getQueueStats();
    console.log(
      `[BATCH] digest reflection ${queueResult.status === "queued" ? "queued" : "duplicate"}: ${feedDigest.reflectionJob.customId} | pending=${queueStats.pending} submitted=${queueStats.submitted}`
    );
  }
  if (feedDigest.rejectReasonsTop.length > 0) {
    const topReject = feedDigest.rejectReasonsTop.map((item) => `${item.reason}:${item.count}`).join(", ");
    console.log(`[DIGEST] rejectTop=${topReject}`);
  }
  if (!canActWithDigest) {
    console.log("[ACT] 유효 nutrient가 없어 이번 사이클의 선제 글/댓글 실행을 제한합니다.");
  }

  console.log(`[QUOTA] 오늘 활동 ${target - remaining}/${target}, 이번 사이클 최대 ${maxActions}개`);
  const adaptivePolicy = buildAdaptivePolicy(target, target - remaining, timezone);
  console.log(
    `[POLICY] ${adaptivePolicy.rationale} | dup(post:${adaptivePolicy.postDuplicateThreshold.toFixed(2)}, reply:${adaptivePolicy.replyDuplicateThreshold.toFixed(2)}) | source>=${adaptivePolicy.minSourceTrust.toFixed(2)}`
  );
  console.log(
    `[TUNING] postLang=${runtimeSettings.postLanguage}, replyLang=${runtimeSettings.replyLanguageMode}, trend(score>=${runtimeSettings.minTrendTweetScore.toFixed(1)}, engage>=${runtimeSettings.minTrendTweetEngagement})`
  );
  console.log(
    `[TUNING] evidence(onchain=${runtimeSettings.requireOnchainEvidence ? "required" : "optional"}, cross=${runtimeSettings.requireCrossSourceEvidence ? "required" : "optional"}) autonomy(budget<=${Math.round(runtimeSettings.autonomyMaxBudgetUtilization * 100)}%, risk>=${runtimeSettings.autonomyRiskBlockScore}, ko=${runtimeSettings.enforceKoreanPosts ? "enforced" : "off"})`
  );
  console.log(
    `[POST-GUARD] minInterval=${runtimeSettings.postMinIntervalMinutes}m, maxPostsPerCycle=${runtimeSettings.maxPostsPerCycle}, nutrient(minScore=${runtimeSettings.nutrientMinDigestScore.toFixed(2)}, max=${runtimeSettings.nutrientMaxIntakePerCycle})`
  );
  console.log(
    `[COST] guard=${xApiCostSettings.enabled ? "on" : "off"} budget=$${xApiCostSettings.dailyMaxUsd.toFixed(2)} read_limit=${xApiCostSettings.dailyReadRequestLimit}/day create_limit=${xApiCostSettings.dailyCreateRequestLimit}/day mention>=${xApiCostSettings.mentionReadMinIntervalMinutes}m trend>=${xApiCostSettings.trendReadMinIntervalMinutes}m create>=${xApiCostSettings.createMinIntervalMinutes}m`
  );

  let executed = 0;
  let postsCreatedThisCycle = 0;
  let quotesCreatedThisCycle = 0;
  const mentionBudget = Math.min(remaining, Math.max(1, Math.floor(maxActions / 2)));
  const mentionProcessed = await checkAndReplyMentions(
    twitter,
    claude,
    mentionBudget,
    timezone,
    xApiCostSettings,
    cycleReflectionHint
  );
  executed += mentionProcessed;

  remaining = target - memory.getTodayActivityCount(timezone);
  if (remaining <= 0 || executed >= maxActions) {
    return finalize(executed, remaining, adaptivePolicy);
  }

  const postGoal = Math.max(2, Math.floor(target * 0.25));
  const proactiveReplyAvailable = TEST_NO_EXTERNAL_CALLS || getTrendSearchCooldownRemainingMs() <= 0;
  const replyGoal = proactiveReplyAvailable ? Math.max(1, Math.min(3, Math.floor(target * 0.3))) : 0;
  if (!proactiveReplyAvailable) {
    console.log("[SOCIAL] proactive reply 경로 비활성: search entitlement cooldown, 이번 사이클은 quote/post 우선");
  }

  while (executed < maxActions && remaining > 0) {
    if (!canActWithDigest) {
      console.log("[QUOTA] feed/digest gate로 proactive action 생략");
      break;
    }

    const before = executed;
    const todayPosts = memory.getTodayPostCount(timezone);
    const todayReplies = memory.getTodayReplyCount(timezone);
    const reserveReplyWindow = proactiveReplyAvailable && todayReplies === 0;
    const canQuoteInCycle = quotesCreatedThisCycle < 1 && !reserveReplyWindow;
    const canPostInCycle = postsCreatedThisCycle < runtimeSettings.maxPostsPerCycle;
    const needReplies = proactiveReplyAvailable && todayReplies < replyGoal;
    const shouldLeadWithPost = canPostInCycle && todayPosts < postGoal && postsCreatedThisCycle === 0;
    const actionOrder: Array<"post" | "reply" | "quote"> = [];

    if (shouldLeadWithPost) actionOrder.push("post");
    if (needReplies) actionOrder.push("reply");
    if (canQuoteInCycle && !needReplies) actionOrder.push("quote");
    if (canQuoteInCycle && !actionOrder.includes("quote")) actionOrder.push("quote");
    if (canPostInCycle && !actionOrder.includes("post")) actionOrder.push("post");
    if (!actionOrder.includes("reply")) actionOrder.push("reply");

    for (const action of actionOrder) {
      if (action === "post") {
        if (!canPostInCycle) continue;
        const posted = await postTrendUpdate(
          twitter,
          claude,
          adaptivePolicy,
          timezone,
          runtimeSettings,
          xApiCostSettings,
          cycleCache,
          feedDigest.acceptedNutrients,
          cycleReflectionHint
        );
        if (posted) {
          executed += 1;
          postsCreatedThisCycle += 1;
          break;
        }
        continue;
      }

      if (action === "reply") {
        if (!proactiveReplyAvailable) continue;
        const replied = await proactiveEngagement(
          twitter,
          claude,
          1,
          adaptivePolicy,
          runtimeSettings,
          timezone,
          xApiCostSettings,
          cycleCache,
          cycleReflectionHint
        );
        if (replied > 0) {
          executed += replied;
          break;
        }
        continue;
      }

      if (action === "quote") {
        if (!canQuoteInCycle) continue;
        const quoted = await postTrendQuote(
          twitter,
          claude,
          adaptivePolicy,
          runtimeSettings,
          timezone,
          xApiCostSettings,
          cycleCache,
          cycleReflectionHint
        );
        if (quoted) {
          executed += 1;
          quotesCreatedThisCycle += 1;
          break;
        }
      }
    }

    if (executed === before) {
      console.log("[QUOTA] 이번 사이클에서 추가 생성 불가, 다음 사이클로 이월");
      break;
    }

    remaining = target - memory.getTodayActivityCount(timezone);
  }

  return finalize(executed, remaining, adaptivePolicy);
}

export async function runDailyQuotaLoop(
  twitter: TwitterApi,
  claude: Anthropic,
  options: DailyQuotaOptions = {}
): Promise<void> {
  const timezone = options.timezone || DEFAULT_TIMEZONE;
  const minLoop = clamp(options.minLoopMinutes ?? DEFAULT_MIN_LOOP_MINUTES, 5, 180);
  const maxLoop = clamp(options.maxLoopMinutes ?? DEFAULT_MAX_LOOP_MINUTES, minLoop, 240);
  const runtimeSettings = resolveEngagementSettings(options.engagement);
  const xApiCostSettings = resolveXApiCostSettings(options.xApiCost);
  const batchSettings = resolveLlmBatchSettings(options.batch);

  console.log(`[LOOP] 고정 시간 스케줄 없이 자율 루프 실행 (${minLoop}~${maxLoop}분 간격)`);
  console.log(`[LOOP] 언어 설정: post=${runtimeSettings.postLanguage}, reply=${runtimeSettings.replyLanguageMode}`);
  console.log(
    `[LOOP] X budget: $${xApiCostSettings.dailyMaxUsd.toFixed(2)}/day, read=${xApiCostSettings.dailyReadRequestLimit}, create=${xApiCostSettings.dailyCreateRequestLimit}, mention>=${xApiCostSettings.mentionReadMinIntervalMinutes}m, trend>=${xApiCostSettings.trendReadMinIntervalMinutes}m, create>=${xApiCostSettings.createMinIntervalMinutes}m`
  );
  console.log(
    `[LOOP] batch: ${batchSettings.enabled ? `on submit<=${batchSettings.maxRequestsPerBatch} sync<=${batchSettings.maxSyncBatchesPerRun}` : "off"}`
  );

  while (true) {
    const preSync = await syncLlmBatchRuns(claude, batchSettings);
    if (preSync.status === "synced") {
      console.log(
        `[BATCH] sync batches=${preSync.syncedBatches} completed=${preSync.completedJobs} failed=${preSync.failedJobs}`
      );
    } else if (preSync.status === "error") {
      console.log(`[BATCH] sync 실패: ${preSync.error}`);
    }

    const result = await runDailyQuotaCycle(twitter, claude, options);
    const submit = await submitPendingLlmBatch(claude, batchSettings);
    if (submit.status === "submitted") {
      console.log(`[BATCH] submit batch=${submit.batchId} requests=${submit.requestCount}`);
    } else if (submit.status === "error") {
      console.log(`[BATCH] submit 실패: ${submit.error}`);
    }
    const postSync = await syncLlmBatchRuns(claude, batchSettings);
    if (postSync.status === "synced") {
      console.log(
        `[BATCH] post-sync batches=${postSync.syncedBatches} completed=${postSync.completedJobs} failed=${postSync.failedJobs}`
      );
    } else if (postSync.status === "error") {
      console.log(`[BATCH] post-sync 실패: ${postSync.error}`);
    }
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
  lang: ContentLanguage,
  maxChars: number,
  timezone: string = DEFAULT_TIMEZONE
): Promise<string | null> {
  if (TEST_NO_EXTERNAL_CALLS) {
    const normalized = finalizeGeneratedText(text, lang, maxChars);
    if (!normalized) return null;
    return normalized.slice(0, maxChars);
  }

  try {
    const job = buildLanguageRewriteJob({
      text,
      language: lang,
      maxChars,
    });

    const llmResult = await requestBudgetedClaudeMessage(
      claude,
      job.request,
      {
        kind: job.execution.kind,
        timezone,
      }
    );
    if (!llmResult) return null;

    const rewritten = finalizeGeneratedText(extractTextFromClaude(llmResult.message.content), lang, maxChars);
    if (!rewritten) return null;
    return rewritten.slice(0, maxChars);
  } catch {
    return null;
  }
}

interface NutritionNarrativeHint {
  shortLine: string;
  longLine: string;
}

function buildNutritionNarrativeHint(params: {
  language: "ko" | "en";
  timezone: string;
  lane: TrendLane;
  acceptedNutrients: OnchainNutrient[];
}): NutritionNarrativeHint {
  const metrics = memory.getTodayNutrientMetrics(params.timezone);
  const stage = memory.getCurrentEvolutionStage();
  const stageKo: Record<string, string> = {
    seed: "Seed",
    sprout: "Sprout",
    crawler: "Crawler",
    sentinel: "Sentinel",
    mythic: "Mythic",
  };
  const laneKo: Record<TrendLane, string> = {
    protocol: "프로토콜",
    ecosystem: "생태계",
    regulation: "규제",
    macro: "매크로",
    onchain: "온체인",
    "market-structure": "시장구조",
  };
  const keyNutrient =
    params.acceptedNutrients.find((item) => item.source === "onchain") ||
    params.acceptedNutrients[0];
  const nutrientLabel = sanitizeTweetText(keyNutrient?.label || "").slice(0, 34);
  const seed = stableSeedForPrelude(
    `${params.language}|${params.lane}|${metrics.acceptedCount}|${metrics.xpGain}|${nutrientLabel}|${keyNutrient?.id || ""}|${keyNutrient?.capturedAt || ""}|${stage}`
  );

  if (params.language === "en") {
    const shortPool = [
      "I feed on this signal first and evolve only if it survives falsification.",
      "I digest this clue first, then decide whether it deserves evolution XP.",
      "I treat this scene as feed, then keep only what passes digestion.",
    ];
    const longPool = [
      `Today I took ${metrics.acceptedCount} usable nutrients and gained ${metrics.xpGain} XP; the active lane is ${params.lane}.`,
      `My current stage is ${stage}. I fed on ${metrics.acceptedCount} verified clues and I evolve only when this lane keeps holding.`,
      `I am in ${stage} stage, digesting ${metrics.acceptedCount} accepted signals with ${metrics.xpGain} XP in this cycle.`,
    ];
    const shortLine = shortPool[seed % shortPool.length];
    const longLine = longPool[(seed + 1) % longPool.length];
    return { shortLine, longLine };
  }

  const shortPool = [
    "오늘은 많이 말하기보다 오래 남는 단서 하나를 고르는 편이 낫다.",
    "나는 숫자를 바로 믿지 않는다. 먼저 왜 움직였는지부터 본다.",
    "오늘은 반응보다 원인을 끝까지 따라가 보려 한다.",
    "빠르게 결론 내리기보다 틀린 해석을 빨리 버리는 쪽을 택한다.",
    "지금은 말보다 버티는 단서를 남기는 편이 더 중요하다.",
    "이 장면에선 확신보다 수정 가능성을 먼저 남겨 둔다.",
    "새 단서를 더 쌓기보다 이미 보인 흔적을 끝까지 확인하고 싶다.",
    "신호는 바로 믿지 않는다. 이유를 확인한 뒤에야 다음 말을 꺼낸다.",
  ];
  const longPool = [
    `오늘은 ${metrics.acceptedCount}개 단서를 소화해 XP ${metrics.xpGain}를 얻었다. 현재 레벨 단계는 ${stageKo[stage] || stage}, 핵심 레인은 ${laneKo[params.lane]}.`,
    `지금 단계는 ${stageKo[stage] || stage}. 오늘 먹은 단서 ${metrics.acceptedCount}개 중 통과한 신호만 진화에 반영한다.`,
    `${laneKo[params.lane]} 레인에서 오늘 소화한 영양소는 ${metrics.acceptedCount}개, 누적 XP는 ${metrics.xpGain}.`,
  ];
  const withNutrient =
    nutrientLabel.length >= 2
      ? [
          `지금은 ${nutrientLabel} 쪽부터 먼저 확인한다.`,
          `이번엔 ${nutrientLabel}부터 천천히 짚는다.`,
          `${nutrientLabel}가 끝까지 버티는지 먼저 본다.`,
          `${nutrientLabel} 쪽 흐름이 이어지는지부터 가린다.`,
        ][seed % 4]
      : [
          "이번에는 핵심 단서부터 천천히 짚는다.",
          "지금은 먼저 흔들리는 단서부터 가린다.",
          "이번엔 제일 약한 고리부터 먼저 확인한다.",
          "우선 핵심 단서가 끝까지 버티는지부터 본다.",
        ][seed % 4];
  const shortLine = `${shortPool[seed % shortPool.length]} ${withNutrient}`;
  const longLine = longPool[(seed + 1) % longPool.length];
  return { shortLine, longLine };
}

function ensurePixymonConceptSignal(
  text: string,
  language: "ko" | "en",
  maxChars: number,
  hintLine: string,
  lane: TrendLane = "market-structure"
): string {
  const normalized = sanitizeTweetText(text);
  if (!normalized) return normalized;
  const hasConcept =
    language === "ko"
      ? /(픽시몬|영양소|소화|진화|레벨|먹고|먹은|채집|주워\s*온|단서로\s*남긴|바로\s*믿기엔\s*이르|한\s*번\s*더\s*(?:씹|의심)|천천히\s*소화|입에\s*넣기엔|장부에\s*(?:남긴|올린|넣는)|근거로\s*남긴|단서로\s*취급|버틴\s*(?:흔적|근거)|하루를\s*버틴\s*신호|보류한다)/.test(
          normalized
        )
      : /(pixymon|nutrient|digest|evolve|evolution|feed)/i.test(normalized);
  if (hasConcept) {
    return collapseRepeatedPixymonCue(normalized).slice(0, maxChars);
  }
  const bridge = sanitizeTweetText(hintLine || "").trim();
  const preferredBridge = buildPixymonConceptCue(lane, language, bridge, normalized);
  const shortBridge = buildShortPixymonConceptCue(lane, language);
  if (language === "ko") {
    const parts = normalized
      .split(/(?<=[.!?])/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    if (parts.length >= 2) {
      const inserted = sanitizeTweetText([parts[0], preferredBridge, ...parts.slice(1)].join(" "));
      if (inserted.length <= maxChars) {
        return collapseRepeatedPixymonCue(inserted);
      }
      const compactInserted = sanitizeTweetText([parts[0], shortBridge, ...parts.slice(1)].join(" "));
      if (compactInserted.length <= maxChars) {
        return collapseRepeatedPixymonCue(compactInserted);
      }
    }
  }
  const merged = sanitizeTweetText(`${normalized} ${preferredBridge}`);
  if (merged.length <= maxChars) {
    return collapseRepeatedPixymonCue(merged);
  }
  const shortMerged = sanitizeTweetText(`${shortBridge} ${normalized}`);
  if (shortMerged.length <= maxChars) {
    return collapseRepeatedPixymonCue(shortMerged);
  }
  const inline = language === "ko" ? injectInlineConceptKo(normalized, lane) : injectInlineConceptEn(normalized, lane);
  if (inline.length <= maxChars) {
    return collapseRepeatedPixymonCue(inline);
  }
  return collapseRepeatedPixymonCue(truncateAtWordBoundary(shortMerged, maxChars));
}

function collapseRepeatedPixymonCue(text: string): string {
  const normalized = sanitizeTweetText(text);
  if (!normalized) return normalized;
  const collapsed = normalized
    .replace(
      /^나는\s+[^.]{0,32}먹지\s+않는다\.\s+(나는\s+[^.]{0,96}(?:소화|먹은\s+단서|메모에\s+남긴다)[^.]*\.)/u,
      "$1"
    )
    .replace(
      /^나는\s+[^.]{0,32}소화하지\s+않는다\.\s+(나는\s+[^.]{0,96}(?:소화|먹은\s+단서|메모에\s+남긴다)[^.]*\.)/u,
      "$1"
    );
  const parts = collapsed
    .split(/(?<=[.!?])/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (parts.length >= 2) {
    const first = normalizeConceptCueSentence(parts[0]);
    const second = normalizeConceptCueSentence(parts[1]);
    if (first && second && first === second) {
      const keep = parts[0].length <= parts[1].length ? parts[0] : parts[1];
      return sanitizeTweetText([keep, ...parts.slice(2)].join(" "));
    }
  }
  return collapsed;
}

function buildPixymonConceptCue(
  lane: TrendLane,
  language: "ko" | "en",
  hintLine: string,
  seedText: string
): string {
  const bridge = sanitizeTweetText(hintLine || "").trim();
  if (language === "en") {
    const poolByLane: Record<TrendLane, string[]> = {
      protocol: [
        "I only let code changes evolve into conviction after the logs survive digestion.",
        "I treat upgrade traces as feed and keep only what still makes sense after digestion.",
      ],
      ecosystem: [
        "I keep only the clues that survive digestion into real user habits.",
        "I feed on usage clues first and evolve only what still holds after digestion.",
      ],
      regulation: [
        "I do not evolve a regulation thesis until the chain side survives digestion too.",
        "Policy headlines are just feed until digestion shows real behavior underneath.",
      ],
      macro: [
        "Macro noise is only feed until digestion leaves one clue worth evolving.",
        "I digest the macro wave first and keep only what survives into chain behavior.",
      ],
      onchain: [
        "Onchain traces are feed first; I evolve only what survives digestion.",
        "I keep chewing on raw chain traces until one clue is worth evolution.",
      ],
      "market-structure": [
        "I treat orderflow as feed and evolve only the part that survives digestion.",
        "I digest the microstructure first and keep only what still holds under pressure.",
      ],
    };
    const pool = poolByLane[lane];
    return pool[stableSeedForPrelude(`${lane}|${seedText}|${bridge}|en-concept`) % pool.length];
  }

  const poolByLane: Record<TrendLane, string[]> = {
    protocol: [
      "업그레이드 얘기는 운영이 버텨야 근거로 남긴다.",
      "발표보다 운영 흔적이 남아야 믿을 만해진다.",
    ],
    ecosystem: [
      "사용 흔적이 남아야 근거로 남긴다.",
      "사람이 돌아오지 않으면 설명을 더 늦게 믿는다.",
    ],
    regulation: [
      "규제 뉴스는 집행이 붙어야 근거로 남긴다.",
      "정책 문장은 행동이 따라와야 근거가 된다.",
    ],
    macro: [
      "큰 뉴스는 자금 흐름이 바뀔 때만 근거로 남긴다.",
      "체인 안쪽까지 닿지 않으면 오늘 판단에 넣지 않는다.",
    ],
    onchain: [
      "온체인 신호는 하루를 버틸 때만 근거로 남긴다.",
      "버틴 숫자만 다음 판단 근거로 남긴다.",
    ],
    "market-structure": [
      "차트보다 실제 체결이 붙어야 근거로 남긴다.",
      "돈이 안 붙으면 오늘 판단 근거로 남기지 않는다.",
    ],
  };
  const pool = poolByLane[lane];
  const seed = stableSeedForPrelude(`${lane}|${seedText}|${bridge}|ko-concept`);
  if (bridge && bridge.length >= 12 && bridge.length <= 80) {
    return [pool[seed % pool.length], bridge][seed % 2];
  }
  return pool[seed % pool.length];
}

function buildShortPixymonConceptCue(lane: TrendLane, language: "ko" | "en"): string {
  if (language === "en") {
    const byLane: Record<TrendLane, string[]> = {
      protocol: ["I digest protocol signals before I trust them."],
      ecosystem: ["I digest usage signals before I trust them."],
      regulation: ["I digest policy signals before I trust them."],
      macro: ["I digest macro noise before I trust it."],
      onchain: ["I digest onchain clues before I trust them."],
      "market-structure": ["I digest orderflow before I trust it."],
    };
    return byLane[lane][0];
  }

  const byLane: Record<TrendLane, string[]> = {
    protocol: ["운영 흔적이 붙어야 근거가 된다."],
    ecosystem: ["사용 흔적이 남아야 근거가 된다."],
    regulation: ["집행이 붙어야 근거가 된다."],
    macro: ["자금 흐름이 바뀌어야 근거가 된다."],
    onchain: ["버틴 숫자만 단서로 취급한다."],
    "market-structure": ["실제 체결이 붙어야 근거가 된다."],
  };
  return byLane[lane][0];
}

function injectInlineConceptKo(text: string, lane: TrendLane): string {
  const normalized = sanitizeTweetText(text);
  const tail = buildPixymonConceptCue(lane, "ko", "", normalized);
  if (/^(?:오늘\s*핵심\s*장면은|이번\s*사이클의\s*출발점은|지금\s*먼저\s*확인할\s*쟁점은|핵심만\s*먼저\s*말하면|한\s*줄\s*요지는|먼저\s*짚을\s*포인트는|지금\s*시장이\s*묻는\s*질문은|내가\s*지금\s*붙잡는\s*장면은)/.test(normalized)) {
    return sanitizeTweetText(`${normalized} ${tail}`);
  }
  if (/^나는\s+/.test(normalized)) {
    return sanitizeTweetText(normalized.replace(/^나는\s+/, "나는 이걸 한 번 더 의심하고 "));
  }
  return sanitizeTweetText(`${normalized} ${tail}`);
}

function injectInlineConceptEn(text: string, lane: TrendLane): string {
  const normalized = sanitizeTweetText(text);
  const bridge = buildPixymonConceptCue(lane, "en", "", normalized);
  if (/^i\s+/i.test(normalized)) {
    return sanitizeTweetText(normalized.replace(/^i\s+/i, "I digest signals first and "));
  }
  return sanitizeTweetText(`${bridge} ${normalized}`);
}

function ensureLeadIssueAnchor(
  text: string,
  language: "ko" | "en",
  maxChars: number,
  lane: TrendLane
): string {
  const normalized = sanitizeTweetText(text);
  if (!normalized) return normalized;
  const firstSentence =
    normalized
      .split(/(?<=[.!?])/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) || normalized;
  const hasExistingLeadPrelude =
    language === "ko"
      ? /^(?:프로토콜|생태계|규제|정책 반응|크립토 시장|온체인|체인 안쪽|시장|실사용|업그레이드 장면|달러와 금리를 같이 보면|실제 돈이 붙는 쪽에선)\s*(?:쪽에선|에선|으로 보면)\b/.test(
          firstSentence
        )
      : /^(?:from a|from market|from the|in crypto terms)/i.test(firstSentence);
  const leadWindow = normalized
    .split(/(?<=[.!?])/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 2)
    .join(" ");
  const hasDomain =
    language === "ko"
      ? /(프로토콜|생태계|규제|정책|매크로|온체인|시장구조|거래소|유동성|주문|체결|호가|지갑|체인|달러|금리|크립토|블록체인|BTC|ETH|SOL|XRP)/i.test(firstSentence)
      : /(protocol|ecosystem|regulation|policy|macro|onchain|market|exchange|liquidity|wallet|chain|crypto|blockchain|btc|eth|sol|xrp)/i.test(
          firstSentence
        );
  const hasDomainInLeadWindow =
    language === "ko"
      ? /(프로토콜|생태계|규제|정책|매크로|온체인|시장구조|거래소|유동성|주문|체결|호가|지갑|체인|달러|금리|크립토|블록체인|BTC|ETH|SOL|XRP)/i.test(
          leadWindow
        )
      : /(protocol|ecosystem|regulation|policy|macro|onchain|market|exchange|liquidity|wallet|chain|crypto|blockchain|btc|eth|sol|xrp)/i.test(
          leadWindow
        );
  const firstCore = firstSentence.replace(/[.!?]+$/g, "").trim();
  const looksSceneAnchored =
    language === "ko"
      ? firstCore.length >= 20 &&
        /(다|한다|된다|보인다|남는다|흔들린다|드러난다|길다|짧다|바뀐다|움직인다|읽힌다|다가온다|가깝다)$/.test(firstCore)
      : firstCore.length >= 20;
  if (hasExistingLeadPrelude || hasDomain || hasDomainInLeadWindow) {
    return normalized.slice(0, maxChars);
  }
  if (language === "en") {
    if (looksSceneAnchored) {
      return truncateAtWordBoundary(`In crypto terms, ${normalized}`, maxChars);
    }
    const laneLabel: Record<TrendLane, string> = {
      protocol: "Protocol",
      ecosystem: "Ecosystem",
      regulation: "Regulation",
      macro: "Macro",
      onchain: "Onchain",
      "market-structure": "Market-structure",
    };
    return truncateAtWordBoundary(`From a ${laneLabel[lane].toLowerCase()} lens, ${normalized}`, maxChars);
  }
  if (looksSceneAnchored) {
    const laneNudgeKo: Record<TrendLane, string[]> = {
      protocol: ["프로토콜 쪽에선", "업그레이드 쪽에선"],
      ecosystem: ["생태계 쪽에선", "실사용 쪽에선"],
      regulation: ["규제 쪽에선", "정책 반응에선"],
      macro: ["크립토 시장에선", "거시 변수까지 보면"],
      onchain: ["온체인에선", "체인 안쪽에선"],
      "market-structure": ["시장에선", "실제 돈이 붙는 쪽에선"],
    };
    const pool = laneNudgeKo[lane];
    const lead = pool[stableSeedForPrelude(`${lane}|${normalized}|lead-nudge`) % pool.length];
    return truncateAtWordBoundary(`${lead} ${normalized}`, maxChars);
  }
  const laneLeadKo: Record<TrendLane, string[]> = {
    protocol: [
      "프로토콜 쪽에선",
      "업그레이드 장면에선",
    ],
    ecosystem: [
      "생태계 쪽에선",
      "실사용 쪽에선",
    ],
    regulation: [
      "규제 쪽에선",
      "정책 반응을 따라가 보면",
    ],
    macro: [
      "크립토 시장에선",
      "달러와 금리를 같이 보면",
    ],
    onchain: [
      "온체인에선",
      "체인 안쪽에선",
    ],
    "market-structure": [
      "시장에선",
      "실제 돈이 붙는 쪽에선",
    ],
  };
  const leadPool = laneLeadKo[lane];
  const lead = leadPool[stableSeedForPrelude(`${lane}|${normalized}`) % leadPool.length];
  return truncateAtWordBoundary(`${lead} ${normalized}`, maxChars);
}

function extractContractAnchorTokens(text: string): string[] {
  const normalized = sanitizeTweetText(text).toLowerCase();
  const tokens = normalized.match(/\$[a-z]{2,10}\b|[a-z][a-z0-9-]{2,}|[가-힣]{2,}/g) || [];
  return [...new Set(tokens.filter((token) => token.length >= 2))].slice(0, 8);
}

function buildSecondaryReplyKeywords(
  trend: {
    keywords?: string[];
    headlines?: string[];
    events?: Array<{ headline?: string; keywords?: string[] }>;
  },
  primaryKeywords: string[]
): string[] {
  const genericStopwords = new Set([
    "crypto",
    "blockchain",
    "onchain",
    "market",
    "markets",
    "price",
    "prices",
    "bitcoin",
    "btc",
    "ethereum",
    "eth",
    "today",
    "update",
    "news",
    "signal",
    "흐름",
    "시장",
    "가격",
    "뉴스",
    "오늘",
    "온체인",
    "비트코인",
    "이슈",
    "단서",
    "근거",
    "다시",
    "확인",
    "실제",
    "먼저",
    "본다",
    "짚는다",
  ]);
  const seeds = [
    ...(trend.keywords || []),
    ...(trend.headlines || []),
    ...((trend.events || []).flatMap((event) => [event.headline || "", ...((event.keywords as string[]) || [])])),
  ];
  const tokens = seeds.flatMap((seed) => extractContractAnchorTokens(seed));
  const primarySet = new Set(primaryKeywords.map((keyword) => String(keyword || "").trim().toLowerCase()));
  const expanded = [...new Set(tokens)]
    .map((token) => String(token || "").trim())
    .filter((token) => token.length >= 3)
    .filter((token) => !genericStopwords.has(token.toLowerCase()))
    .filter((token) => !primarySet.has(token.toLowerCase()))
    .slice(0, 12);
  return expanded;
}

function buildTertiaryReplyKeywords(trend: {
  headlines?: string[];
  events?: Array<{ lane?: TrendLane; headline?: string; keywords?: string[] }>;
}): string[] {
  const laneSeeds: Record<TrendLane, string[]> = {
    protocol: ["validator", "upgrade", "mainnet", "testnet", "rollup", "검증자", "업그레이드"],
    ecosystem: ["wallet", "adoption", "usage", "community", "ecosystem", "실사용", "지갑", "커뮤니티"],
    regulation: ["sec", "cftc", "policy", "compliance", "etf", "규제", "정책", "etf"],
    macro: ["fed", "ecb", "rates", "inflation", "usd", "달러", "금리", "인플레이션"],
    onchain: ["whale", "mempool", "stablecoin", "fees", "address", "큰손", "수수료", "스테이블"],
    "market-structure": ["orderbook", "liquidity", "funding", "volume", "slippage", "호가", "유동성", "체결"],
  };

  const seeds = [
    ...(trend.headlines || []),
    ...((trend.events || []).flatMap((event) => [
      ...(laneSeeds[event.lane || "onchain"] || []),
      event.headline || "",
      ...((event.keywords as string[]) || []),
    ])),
  ];

  return [...new Set(seeds.flatMap((seed) => extractContractAnchorTokens(seed)))]
    .map((token) => String(token || "").trim())
    .filter((token) => token.length >= 3)
    .filter((token) => !/^(crypto|blockchain|market|markets|price|today|signal|뉴스|시장|가격|오늘|이슈|근거)$/i.test(token))
    .slice(0, 16);
}

function buildLaneFallbackReplyKeywords(trend: {
  events?: Array<{ lane?: TrendLane }>;
}): string[] {
  const laneSeeds: Record<TrendLane, string[]> = {
    protocol: ["validator", "rollup", "upgrade", "testnet", "mainnet", "검증자", "업그레이드"],
    ecosystem: ["wallet", "adoption", "community", "usage", "지갑", "실사용", "커뮤니티"],
    regulation: ["sec", "cftc", "etf", "policy", "규제", "정책", "etf"],
    macro: ["fed", "ecb", "rates", "usd", "달러", "금리", "매크로"],
    onchain: ["mempool", "whale", "stablecoin", "fees", "고래", "스테이블", "수수료"],
    "market-structure": ["orderbook", "liquidity", "volume", "funding", "호가", "유동성", "체결"],
  };

  const seenLanes = new Set<TrendLane>((trend.events || []).map((event) => event.lane || "onchain"));
  return [...seenLanes]
    .flatMap((lane) => laneSeeds[lane] || [])
    .filter((token, index, arr) => arr.indexOf(token) === index)
    .slice(0, 12);
}

function buildGenericSafeReplyKeywords(trend: {
  events?: Array<{ lane?: TrendLane }>;
  headlines?: string[];
}): string[] {
  const dominantLane = (trend.events || [])[0]?.lane || "onchain";
  const laneSeeds: Record<TrendLane, string[]> = {
    protocol: ["ethereum", "solana", "validator", "rollup", "upgrade", "mainnet"],
    ecosystem: ["wallet", "stablecoin", "community", "adoption", "developer", "usage"],
    regulation: ["sec", "etf", "crypto policy", "cftc", "regulation", "compliance"],
    macro: ["fed", "usd", "rates", "inflation", "treasury", "macro"],
    onchain: ["onchain", "mempool", "whale", "stablecoin", "wallet", "flows"],
    "market-structure": ["orderbook", "liquidity", "funding", "open interest", "exchange", "volume"],
  };
  const headlineTokens = (trend.headlines || [])
    .flatMap((headline) => extractContractAnchorTokens(headline))
    .filter((token) => token.length >= 3)
    .filter((token) => !/^(market|markets|price|prices|today|crypto|blockchain|뉴스|시장|가격|오늘)$/i.test(token))
    .slice(0, 8);
  return [...new Set([...laneSeeds[dominantLane], ...headlineTokens])].slice(0, 12);
}

function buildBroadSafeReplyKeywords(trend: {
  events?: Array<{ lane?: TrendLane }>;
  headlines?: string[];
}): string[] {
  const broadSeeds = [
    "$BTC",
    "$ETH",
    "$SOL",
    "bitcoin etf",
    "ethereum",
    "solana",
    "stablecoin",
    "crypto",
    "blockchain",
    "defi",
    "etf",
    "crypto policy",
    "onchain",
    "rollup",
    "validator",
    "orderbook",
  ];
  return [...new Set([...buildGenericSafeReplyKeywords(trend), ...broadSeeds])].slice(0, 14);
}

function buildUltraBroadSafeReplyKeywords(): string[] {
  return [
    "crypto",
    "blockchain",
    "onchain",
    "stablecoin",
    "ethereum",
    "solana",
    "bitcoin etf",
    "crypto policy",
    "rollup",
    "validator",
    "defi",
    "liquidity",
  ];
}

function summarizeEvidenceForPrompt(
  evidence: { label?: string; value?: string; summary?: string },
  language: "ko" | "en"
): string {
  const anchor = formatEvidenceToken(String(evidence.label || ""), String(evidence.value || ""), 30);
  if (language === "ko") {
    if (/체인 사용|거래 대기/.test(anchor)) return "체인 안쪽 사용이 잠깐 스치지 않고 실제로 붙는지 보는 단서";
    if (/대기 자금|거래소 쪽 자금/.test(anchor)) return "대기 자금이 실제로 들어오고 머무는지 보는 단서";
    if (/ETF|규제|법원 일정|SEC·CFTC/.test(anchor)) return "정책 뉴스가 말에서 끝나지 않고 행동까지 번지는지 보는 단서";
    if (/가격 반응|알트|가격 분위기/.test(anchor)) return "먼저 뜨거워진 분위기 뒤에 실제 돈이 붙는지 보는 단서";
    if (/실사용|지갑 사용|예측시장 사용 흐름/.test(anchor)) return "실사용 얘기가 실제 버릇으로 남는지 보는 단서";
    return "눈에 띄는 숫자보다 오래 남는 반응이 있는지 보는 단서";
  }
  if (/chain use|queue|backlog/i.test(anchor)) return `Use ${anchor} as a clue for whether activity is actually sticking`;
  if (/flow|capital|liquidity/i.test(anchor)) return `Use ${anchor} as a clue for whether money is really moving`;
  if (/etf|regulation|policy/i.test(anchor)) return `Use ${anchor} as a clue for whether policy talk is turning into behavior`;
  return sanitizeTweetText(`Use ${anchor} as a behavioral clue rather than a raw market fragment`);
}

function normalizeConceptCueSentence(text: string): string {
  return sanitizeTweetText(text)
    .replace(/^(?:프로토콜|생태계|규제|정책 반응|크립토 시장|달러와 금리를 같이 보면|온체인|체인 안쪽|시장|실제 돈이 붙는 쪽에선)\s*(?:쪽에선|에선|으로 보면)?\s*/u, "")
    .replace(/[.!?]+$/g, "")
    .replace(/^(?:나는|지금은|이번엔|오늘은|아직)\s+/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

function detectNarrativeSurfaceIssue(text: string, language: "ko" | "en"): string | null {
  const normalized = sanitizeTweetText(text);
  if (!normalized) return "empty";
  if (language !== "ko") return null;
  if (
    /(sat\/vB|24h\s*변동|market cap|도미넌스|BTC 네트워크 수수료|BTC 네트워크\.|(?:BTC|ETH|SOL)\s*가?\s*\d[\d,\s]{2,}\s*(?:불|달러)|\d,\s+\d)/i.test(
      normalized
    )
  ) {
    return "raw-evidence-fragment";
  }
  if (/(호가창 바깥|같은 화면에 붙여 둔다|같은 화면에 붙여 놓는다|시간차부터 잰다|호가만 흔들리고)/.test(normalized)) {
    return "templated-market-metaphor";
  }
  if (/(입에 넣기엔 아직 거친 장면|오늘 주워 온 건|먼저 걸리는 건|끝까지 같은 말을 하는지 본다|다시 본다는 말이 핵심|쪽 흐름이 이어지는지부터 가린다)/.test(normalized)) {
    return "templated-voice-pattern";
  }
  if (/(오늘은 이 장면부터 적어 둔다|오늘 메모의 출발점은|이 장면부터 먼저 남겨 둔다)/.test(normalized)) {
    return "templated-control-opener";
  }
  if (
    /(?:정책 반응을 따라가 보면|시장에선|실제 돈이 붙는 쪽에선|프로토콜 쪽에선|생태계 쪽에선|온체인에선|체인 안쪽에선)\s+(?:오늘은 이 장면부터 적어 둔다|오늘 메모의 출발점은|이 장면부터 먼저 남겨 둔다)/.test(
      normalized
    )
  ) {
    return "lead-opener-collision";
  }
  if (/(?:BTC|ETH|SOL|ETF|SEC|거래소|네트워크)\.$/.test(normalized)) {
    return "truncated-tail";
  }
  return null;
}

function ensureEventHeadlineAnchor(
  text: string,
  eventPlan: {
    lane?: TrendLane;
    event: {
      id?: string;
      headline: string;
      keywords?: string[];
    };
  },
  language: "ko" | "en",
  maxChars: number
): string {
  const normalized = sanitizeTweetText(text);
  if (!normalized) return normalized;
  const eventHeadline =
    language === "ko"
      ? buildCompactEventAnchorLine(
          eventPlan.lane || "market-structure",
          eventPlan.event.headline,
          `event-anchor|${eventPlan.event.id || ""}`
        )
      : sanitizeTweetText(eventPlan.event.headline).replace(/\.$/, "");
  const tokens = extractContractAnchorTokens(`${eventHeadline} ${(eventPlan.event.keywords || []).join(" ")}`).filter(
    (token) => token.length >= 3
  );
  const lower = normalized.toLowerCase();
  if (tokens.some((token) => lower.includes(token.toLowerCase()))) {
    return truncateAtWordBoundary(normalized, maxChars);
  }
  if (language === "ko") {
    const eventStem = sanitizeTweetText(eventHeadline)
      .replace(/[.!?]+$/g, "")
      .replace(/(?:부터|까지)?\s*(?:다시\s*)?(?:본다|확인한다|살핀다|짚는다|따진다|가늠한다|지켜본다)$/u, "")
      .trim();
    const clause =
      /(부터\s*먼저|먼저다)$/.test(eventStem)
        ? buildCompactEventAnchorLine(eventPlan.lane || "market-structure", eventPlan.event.headline, `event-anchor-fallback|${eventPlan.event.id || ""}`)
        : /(는지|인지|일지|할지|될지|붙는지|남는지|이어지는지|갈리는지|버티는지|무너지는지)$/.test(eventStem)
        ? `이번 쟁점은 ${eventStem}다.`
        : /(다|한다|된다|보인다|남는다|갈린다|가깝다)$/.test(eventStem)
          ? `${eventStem}.`
          : `이번 쟁점은 ${eventStem}다.`;
    return truncateAtWordBoundary(`${clause} ${normalized}`, maxChars);
  }
  return truncateAtWordBoundary(`${eventHeadline}. ${normalized}`, maxChars);
}

function buildCompactEventAnchorLine(lane: TrendLane, headline: string, seedHint: string): string {
  const normalized = normalizeKoContractHeadline(headline, seedHint);
  const cleaned = sanitizeTweetText(normalized).replace(/[.!?]+$/g, "").trim();
  const questionLike = /(는지|인지|일지|할지|될지|붙는지|남는지|이어지는지|갈리는지|버티는지|무너지는지)$/.test(cleaned);
  const predicateLike =
    /(다|한다|된다|보인다|남는다|갈린다|가깝다|핵심이다)$/.test(cleaned) &&
    !/(부터\s*먼저다|먼저다)$/.test(cleaned);
  if (/[가-힣]/.test(normalized) && !/[A-Za-z]{5,}/.test(normalized) && normalized.length <= 42 && (questionLike || predicateLike)) {
    return normalized;
  }
  const poolByLane: Record<TrendLane, string[]> = {
    protocol: ["이번 쟁점은 업그레이드가 운영으로 이어지는지다", "업그레이드 뒤 실제 반응이 버티는지가 핵심이다"],
    ecosystem: ["이번 쟁점은 사용 흔적이 실제로 남는지다", "사람들이 다시 돌아오는지가 핵심이다"],
    regulation: ["이번 쟁점은 규제 뉴스가 행동으로 번지는지다", "정책 발표 뒤 실제 반응이 갈리는지가 핵심이다"],
    macro: ["이번 쟁점은 거시 뉴스가 체인 안쪽까지 번지는지다", "달러 변화가 자금 습관을 바꾸는지가 핵심이다"],
    onchain: ["이번 쟁점은 온체인 움직임이 끝까지 남는지다", "체인 안쪽 자금 흐름이 이어지는지가 핵심이다"],
    "market-structure": ["이번 쟁점은 차트보다 체결이 남는지다", "화면이 뜨거워도 실제 돈이 남는지가 핵심이다"],
  };
  const pool = poolByLane[lane];
  return pool[stableSeedForPrelude(`${normalized}|${lane}|${seedHint}`) % pool.length];
}

function ensureEventEvidenceAnchors(
  text: string,
  eventPlan: {
    evidence: Array<{ label: string; value: string }>;
  },
  language: "ko" | "en",
  maxChars: number
): string {
  const normalized = sanitizeTweetText(text);
  if (!normalized) return normalized;
  const [a, b] = eventPlan.evidence.slice(0, 2);
  if (!a || !b) return truncateAtWordBoundary(normalized, maxChars);
  const aToken = formatEvidenceToken(a.label, a.value, 28);
  const bToken = formatEvidenceToken(b.label, b.value, 28);
  const lower = normalized.toLowerCase();
  const hasA = aToken.length >= 2 && lower.includes(aToken.toLowerCase());
  const hasB = bToken.length >= 2 && lower.includes(bToken.toLowerCase());
  if (hasA && hasB) {
    return truncateAtWordBoundary(normalized, maxChars);
  }
  const missingTokens = [!hasA ? aToken : "", !hasB ? bToken : ""].filter(Boolean);
  const bothMissing = !hasA && !hasB;
  const koClauses = [
    bothMissing ? `이 장면에선 ${aToken}와 ${bToken}를 같이 본다.` : "",
    `근거는 ${missingTokens.join(", ")}.`,
    `단서는 ${missingTokens.join(" · ")}.`,
    `${missingTokens.join(" · ")}부터 다시 본다.`,
  ].filter(Boolean);
  const enClauses = [
    bothMissing ? `I keep ${aToken} and ${bToken} on the same screen.` : "",
    `Core anchors are ${missingTokens.join(" and ")}.`,
    `I keep ${missingTokens.join(" / ")} on the same screen.`,
  ].filter(Boolean);
  const clauses = language === "ko" ? koClauses : enClauses;

  for (const clause of clauses) {
    const merged = sanitizeTweetText(`${normalized} ${clause}`);
    if (merged.length <= maxChars) {
      return merged;
    }
  }

  const fallbackClause =
    language === "ko"
      ? `단서는 ${missingTokens.map((token) => token.slice(0, 18)).join(" · ")}.`
      : `Anchors: ${missingTokens.map((token) => token.slice(0, 18)).join(" / ")}.`;
  const room = Math.max(40, maxChars - fallbackClause.length - 1);
  const prefix = truncateAtWordBoundary(normalized, room);
  return sanitizeTweetText(`${prefix} ${fallbackClause}`).slice(0, maxChars);
}

function repairEventEvidenceContractPost(
  text: string,
  eventPlan: {
    lane: TrendLane;
    event: { id?: string; headline: string; keywords?: string[] };
    evidence: Array<{ label: string; value: string }>;
  },
  language: "ko" | "en",
  maxChars: number
): string {
  let normalized = sanitizeTweetText(text);
  if (!normalized) return normalized;
  let contract = validateEventEvidenceContract(normalized, eventPlan as any);
  if (contract.ok) return truncateAtWordBoundary(normalized, maxChars);

  if (!contract.eventHit) {
    const anchor =
      language === "ko"
        ? buildCompactEventAnchorLine(eventPlan.lane, eventPlan.event.headline, `repair|${eventPlan.event.id || ""}`)
        : sanitizeTweetText(eventPlan.event.headline).replace(/\.$/, "");
    const sentences = normalized
      .split(/(?<=[.!?])/)
      .map((item) => item.trim())
      .filter(Boolean);
    const body = sentences.length >= 2 ? sentences.slice(1).join(" ") : normalized;
    normalized = sanitizeTweetText(`${anchor}. ${body}`).slice(0, maxChars);
  }

  contract = validateEventEvidenceContract(normalized, eventPlan as any);
  if (!contract.ok && contract.evidenceHitCount < 2) {
    normalized = ensureEventEvidenceAnchors(normalized, eventPlan, language, maxChars);
    contract = validateEventEvidenceContract(normalized, eventPlan as any);
    if (!contract.ok && contract.evidenceHitCount < 2 && language === "ko") {
      const aToken = formatEvidenceToken(eventPlan.evidence[0]?.label || "", eventPlan.evidence[0]?.value || "", 28);
      const bToken = formatEvidenceToken(eventPlan.evidence[1]?.label || "", eventPlan.evidence[1]?.value || "", 28);
      normalized = finalizeGeneratedText(
        sanitizeTweetText(`${normalized} 이 장면에선 ${aToken}와 ${bToken}를 같이 본다.`),
        language,
        maxChars
      );
    }
  }

  return finalizeGeneratedText(normalized, language, maxChars);
}

function deconflictOpening(
  text: string,
  recentPosts: string[],
  language: "ko" | "en",
  maxChars: number,
  seedHint: string,
  surface: "post" | "quote" | "reply" = language === "ko" && maxChars <= 180 ? "reply" : "post"
): string {
  const normalized = finalizeNarrativeSurface(text, language, maxChars, surface);
  if (!normalized) return normalized;

  const recentOpeningCounts = buildOpeningCountMap(recentPosts || [], language);
  const currentPrefix = extractOpeningKey(normalized, language);
  if (!currentPrefix || (recentOpeningCounts.get(currentPrefix) || 0) < 2) {
    return normalized;
  }

  const koLeads = [
    "이번에는 장면을 조금 다르게 연다",
    "오늘 메모는 여기서 출발한다",
    "지금 포착한 단서부터 적는다",
    "먼저 이 장면을 붙잡고 시작한다",
    "소음 대신 이 장면부터 기록한다",
    "이번 줄은 이 단서에서 시작한다",
  ];
  const enLeads = [
    "I open this one from a different angle",
    "I start today's note from this scene",
    "I begin with this clue first",
    "I anchor this line on this moment",
  ];
  const leadPool = language === "ko" ? koLeads : enLeads;
  const seed = stableSeedForPrelude(`${seedHint}|${normalized}|${currentPrefix}`);
  const escapedLeads = leadPool.map((lead) => lead.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const leadPattern = new RegExp(`^(?:${escapedLeads.join("|")})(?:[.!?]\\s+|\\s+)`, "i");
  const baseBody = normalized.replace(leadPattern, "").trim();
  const sentences = baseBody
    .split(/(?<=[.!?])\s+/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (sentences.length >= 2) {
    const rotatedBody = finalizeNarrativeSurface(
      `${sentences[1]} ${sentences[0]} ${sentences.slice(2).join(" ")}`,
      language,
      maxChars,
      surface
    );
    const rotatedPrefix = extractOpeningKey(rotatedBody, language);
    if (rotatedPrefix && (recentOpeningCounts.get(rotatedPrefix) || 0) < 2) {
      return rotatedBody;
    }
  }

  for (let i = 0; i < leadPool.length; i += 1) {
    const lead = leadPool[(seed + i) % leadPool.length];
    if (
      sanitizeTweetText(normalized)
        .toLowerCase()
        .startsWith(`${sanitizeTweetText(lead).toLowerCase()}.`)
    ) {
      continue;
    }
    const candidate = finalizeNarrativeSurface(
      `${lead}. ${baseBody}`,
      language,
      maxChars,
      surface
    );
    const candidatePrefix = extractOpeningKey(candidate, language);
    if ((recentOpeningCounts.get(candidatePrefix) || 0) < 2) {
      return candidate;
    }
  }

  return normalized;
}

function extractOpeningKey(text: string, language: "ko" | "en"): string {
  const normalized = sanitizeTweetText(text);
  if (!normalized) return "";
  const parts = normalized
    .split(/(?<=[.!?])/)
    .map((item) => item.trim())
    .filter(Boolean);
  const head = parts[0] || normalized;
  const stripped =
    language === "ko"
      ? head
          .replace(
            /^(?:이번에는\s*장면을\s*조금\s*다르게\s*연다|오늘\s*메모는\s*여기서\s*출발한다|지금\s*포착한\s*단서부터\s*적는다|먼저\s*이\s*장면을\s*붙잡고\s*시작한다|소음\s*대신\s*이\s*장면부터\s*기록한다|이번\s*줄은\s*이\s*단서에서\s*시작한다)\.?\s*/i,
            ""
          )
          .replace(
            /^(?:오늘\s*유독\s*걸리는\s*장면은|이상하게\s*계속\s*남는\s*건|계속\s*머리에\s*맴도는\s*건|지금\s*먼저\s*적어\s*두고\s*싶은\s*건|숫자보다\s*먼저\s*마음에\s*걸린\s*건|조금\s*더\s*들여다보고\s*싶은\s*건|이번\s*흐름에서\s*자꾸\s*손이\s*가는\s*건|한\s*발\s*물러서서\s*보면\s*먼저\s*보이는\s*건|계산보다\s*먼저\s*걸린\s*건|오늘은\s*이\s*장면부터\s*붙잡는다|오늘\s*먼저\s*붙잡을\s*장면은|오늘\s*끝까지\s*붙들고\s*싶은\s*건|한참\s*마음에\s*남아\s*있는\s*건|지금\s*내\s*메모의\s*첫\s*줄은|괜히\s*오래\s*남는\s*건|요즘은|이번엔)\s*/i,
            ""
          )
      : head.replace(/^(?:i\s+think|i\s+keep\s+coming\s+back\s+to|i\s+start\s+from)\s+/i, "");

  return stripped
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48);
}

function buildOpeningCountMap(recentPosts: string[], language: "ko" | "en"): Map<string, number> {
  const counts = new Map<string, number>();
  (recentPosts || [])
    .slice(-48)
    .map((post) => extractOpeningKey(post, language))
    .filter((key) => key.length >= 12)
    .forEach((key) => {
      counts.set(key, (counts.get(key) || 0) + 1);
    });
  return counts;
}
async function getOrCreateTrendContext(
  cache: EngagementCycleCache | undefined,
  options: { minNewsSourceTrust: number }
): Promise<TrendContext> {
  const minNewsSourceTrust = clampNumber(options.minNewsSourceTrust, 0.05, 0.9, 0.28);
  if (cache?.trendContext && isClose(cache.trendContext.minNewsSourceTrust, minNewsSourceTrust)) {
    cache.cacheMetrics.trendContextHits += 1;
    return cache.trendContext.data;
  }
  if (cache) {
    cache.cacheMetrics.trendContextMisses += 1;
  }
  const created = await collectTrendContext({ minNewsSourceTrust });
  if (cache) {
    cache.trendContext = { minNewsSourceTrust, data: created };
  }
  return created;
}

function getOrCreateRunContext(
  cache: EngagementCycleCache | undefined,
  trend: TrendContext,
  recentReflectionHint?: string
): SharedRunContext {
  const key = buildRunContextKey(trend, recentReflectionHint);
  if (cache?.runContext?.key === key) {
    cache.cacheMetrics.runContextHits += 1;
    return cache.runContext.data;
  }
  if (cache) {
    cache.cacheMetrics.runContextMisses += 1;
  }
  const anchors = collectNarrativeAnchors(trend, 3);
  const recentReflection = recentReflectionHint || memory.getLatestDigestReflectionMemo()?.text;
  const data: SharedRunContext = {
    key,
    narrativeAnchors: anchors,
    evidenceTextKo: buildNarrativeEvidenceTextFromAnchors(anchors, "ko"),
    evidenceTextEn: buildNarrativeEvidenceTextFromAnchors(anchors, "en"),
    sharedPromptKo: buildSharedRunContextPrompt(trend, anchors, "ko", recentReflection),
    sharedPromptEn: buildSharedRunContextPrompt(trend, anchors, "en", recentReflection),
  };
  if (cache) {
    cache.runContext = { key, data };
  }
  return data;
}

async function getOrSearchTrendTweets(
  twitter: TwitterApi,
  keywords: string[],
  count: number,
  rules: TrendTweetSearchRules,
  timezone: string,
  xApiCostSettings: XApiCostRuntimeSettings,
  cache?: EngagementCycleCache
): Promise<any[]> {
  const key = buildTrendTweetCacheKey(keywords, count, rules);
  if (cache?.trendTweets?.key === key) {
    cache.cacheMetrics.trendTweetsHits += 1;
    return cache.trendTweets.data;
  }
  if (cache) {
    cache.cacheMetrics.trendTweetsMisses += 1;
  }

  if (!TEST_NO_EXTERNAL_CALLS) {
    const searchCooldownRemainingMs = getTrendSearchCooldownRemainingMs();
    if (searchCooldownRemainingMs > 0) {
      console.log(`[TREND] search cooldown active (${Math.ceil(searchCooldownRemainingMs / 60000)}m 남음)`);
      const reusable = getReusablePersistedTrendTweets(key, count);
      if (reusable.length > 0) {
        console.log(`[ENGAGE] 최근 안전 후보 ${reusable.length}개 재사용`);
        if (cache) {
          cache.trendTweets = { key, data: reusable };
        }
        return reusable;
      }
      return [];
    }

    const trendReadGuard = xApiBudget.checkReadAllowance({
      enabled: xApiCostSettings.enabled,
      timezone,
      dailyMaxUsd: xApiCostSettings.dailyMaxUsd,
      estimatedReadCostUsd: xApiCostSettings.estimatedReadCostUsd,
      dailyReadRequestLimit: xApiCostSettings.dailyReadRequestLimit,
      kind: "trend-search",
      minIntervalMinutes: xApiCostSettings.trendReadMinIntervalMinutes,
    });
    if (!trendReadGuard.allowed) {
      console.log(`[BUDGET] 트렌드 검색 스킵: ${formatReadBlockReason(trendReadGuard.reason, trendReadGuard.waitSeconds)}`);
      const reusable = getReusablePersistedTrendTweets(key, count);
      if (reusable.length > 0) {
        console.log(`[ENGAGE] 최근 안전 후보 ${reusable.length}개 재사용`);
        if (cache) {
          cache.trendTweets = { key, data: reusable };
        }
        return reusable;
      }
      return [];
    }

    if (xApiCostSettings.enabled) {
      const trendUsage = xApiBudget.recordRead({
        timezone,
        estimatedReadCostUsd: xApiCostSettings.estimatedReadCostUsd,
        kind: "trend-search",
      });
      console.log(
        `[BUDGET] read=${trendUsage.readRequests}/${xApiCostSettings.dailyReadRequestLimit} total_est=$${trendUsage.estimatedTotalCostUsd.toFixed(3)}/$${xApiCostSettings.dailyMaxUsd.toFixed(2)} (trend-search)`
      );
    }
  } else {
    console.log("[TEST-LOCAL] 트렌드 read budget 체크/기록 스킵");
  }

  const result = await searchRecentTrendTweets(twitter, keywords, count, rules);
  if (result.length > 0) {
    persistedTrendTweetCache = {
      key,
      savedAt: Date.now(),
      data: result,
    };
  } else {
    const reusable = getReusablePersistedTrendTweets(key, count);
    if (reusable.length > 0) {
      console.log(`[ENGAGE] 최근 안전 후보 ${reusable.length}개 재사용`);
      if (cache) {
        cache.trendTweets = { key, data: reusable };
      }
      return reusable;
    }
  }
  if (cache) {
    cache.trendTweets = { key, data: result };
  }
  return result;
}

function getReusablePersistedTrendTweets(key: string, count: number): any[] {
  if (!persistedTrendTweetCache) return [];
  const ageMs = Date.now() - persistedTrendTweetCache.savedAt;
  if (ageMs > PERSISTED_TREND_TWEET_CACHE_TTL_MS) return [];
  const sameKey = persistedTrendTweetCache.key === key;
  const freshEnough = persistedTrendTweetCache.data.filter((tweet) => {
    const created = typeof tweet?.created_at === "string" ? new Date(tweet.created_at) : null;
    if (!created || !Number.isFinite(created.getTime())) return true;
    return Date.now() - created.getTime() <= 24 * 60 * 60 * 1000;
  });
  if (!sameKey && freshEnough.length < 3) return [];
  return freshEnough.slice(0, Math.max(6, Math.min(30, count)));
}

function shouldAbortProactiveReplySearch(): boolean {
  return !TEST_NO_EXTERNAL_CALLS && getTrendSearchCooldownRemainingMs() > 0;
}

function buildTrendTweetCacheKey(
  keywords: string[],
  count: number,
  rules: TrendTweetSearchRules
): string {
  const normalizedKeywords = [...keywords]
    .map((item) => String(item || "").trim().toLowerCase())
    .filter((item) => item.length > 0)
    .sort()
    .slice(0, 24)
    .join("|");
  const normalizedCount = clampInt(count, 10, 100, 30);
  const minSourceTrust = clampNumber(rules.minSourceTrust, 0.05, 0.9, 0.24).toFixed(2);
  const minScore = clampNumber(rules.minScore, 0.5, 12, 3.2).toFixed(2);
  const minEngagement = clampInt(rules.minEngagement, 1, 200, 6);
  const maxAgeHours = clampInt(rules.maxAgeHours, 1, 168, 24);
  const requireRootPost = rules.requireRootPost ? "root" : "thread";
  const blockSuspiciousPromo = rules.blockSuspiciousPromo ? "clean" : "loose";
  return `${normalizedCount}|${minSourceTrust}|${minScore}|${minEngagement}|${maxAgeHours}|${requireRootPost}|${blockSuspiciousPromo}|${normalizedKeywords}`;
}

function isClose(a: number, b: number): boolean {
  return Math.abs(a - b) <= 0.0001;
}

function createEmptyCacheMetrics(): CycleCacheMetrics {
  return {
    cognitiveHits: 0,
    cognitiveMisses: 0,
    runContextHits: 0,
    runContextMisses: 0,
    trendContextHits: 0,
    trendContextMisses: 0,
    trendTweetsHits: 0,
    trendTweetsMisses: 0,
  };
}

function logCacheMetrics(cache?: EngagementCycleCache): void {
  if (!cache) return;
  const metrics = cache.cacheMetrics;
  const total =
    metrics.runContextHits +
    metrics.runContextMisses +
    metrics.trendContextHits +
    metrics.trendContextMisses +
    metrics.trendTweetsHits +
    metrics.trendTweetsMisses;
  if (total === 0) return;
  console.log(
    `[CACHE] runCtx ${metrics.runContextHits}/${metrics.runContextMisses} | trendCtx ${metrics.trendContextHits}/${metrics.trendContextMisses} | trendTweets ${metrics.trendTweetsHits}/${metrics.trendTweetsMisses}`
  );
}

function buildRunContextKey(trend: TrendContext, recentReflectionHint?: string): string {
  return [
    sanitizeTweetText(trend.summary).slice(0, 120),
    sanitizeTweetText(recentReflectionHint || "").slice(0, 80),
    ...trend.events.slice(0, 3).map((event) => sanitizeTweetText(event.headline).slice(0, 80)),
    ...trend.nutrients.slice(0, 3).map((item) => sanitizeTweetText(`${item.label} ${item.value}`).slice(0, 48)),
  ]
    .filter(Boolean)
    .join("|");
}

function collectNarrativeAnchors(trend: TrendContext, maxItems: number = 2): string[] {
  const limit = clampInt(maxItems, 1, 6, 2);
  const fromEvidence = trend.nutrients
    .slice(0, 10)
    .map((item) => formatEvidenceToken(item.label, item.value, 42))
    .filter((item) => item.length >= 8 && item.length <= 90);
  const fromEvents = trend.events
    .slice(0, 6)
    .map((item) => buildCompactEventAnchorLine(item.lane || "market-structure", item.headline, `runctx|${item.id || ""}`))
    .filter((item) => item.length >= 12 && item.length <= 90);
  const merged = [...fromEvidence, ...fromEvents];
  const dedup = [...new Set(merged)].filter((item) => !/^\$?\d+/.test(item));
  return dedup.slice(0, limit);
}

function buildNarrativeEvidenceText(
  trend: TrendContext,
  language: "ko" | "en"
): string {
  const anchors = collectNarrativeAnchors(trend, 3);
  return buildNarrativeEvidenceTextFromAnchors(anchors, language);
}

function buildNarrativeEvidenceTextFromAnchors(
  anchors: string[],
  language: "ko" | "en"
): string {
  if (anchors.length === 0) {
    return language === "ko"
      ? "근거가 부족해 결론 대신 질문을 남긴다"
      : "Evidence is sparse, so I keep this as an open question";
  }
  return anchors.join(" | ");
}

function buildSharedRunContextPrompt(
  trend: TrendContext,
  anchors: string[],
  language: "ko" | "en",
  recentReflection?: string
): string {
  const summary = sanitizeTweetText(trend.summary).slice(0, 220);
  const topEvents = trend.events
    .slice(0, 2)
    .map((event) => sanitizeTweetText(event.headline))
    .filter((item) => item.length >= 12)
    .slice(0, 2);
  const anchorText = buildNarrativeEvidenceTextFromAnchors(anchors, language);
  const reflectionLine = sanitizeTweetText(recentReflection || "").slice(0, 180);
  if (language === "ko") {
    return `공용 컨텍스트
- 오늘 흐름: ${summary || "단일 흐름 확정 전"}
- 먼저 붙잡는 장면: ${topEvents.join(" | ") || "핵심 장면 압축 필요"}
- 반복 확인 단서: ${anchorText}
- 직전 소화 메모: ${reflectionLine || "아직 batch reflection 없음"}`;
  }
  return `Shared context
- Today flow: ${summary || "single flow still forming"}
- Scenes to hold first: ${topEvents.join(" | ") || "condense the main scene first"}
- Evidence to revisit: ${anchorText}
- Latest digest memo: ${reflectionLine || "no batch reflection yet"}`;
}

const TREND_TOKEN_STOP_WORDS = new Set([
  "today",
  "book",
  "note",
  "memo",
  "mission",
  "reflection",
  "essay",
  "fable",
  "오늘",
  "오늘의",
  "책에서",
  "읽은",
  "문장",
  "하나",
  "근거",
  "메모",
  "노트",
  "실험",
  "회고",
  "우화",
  "짧은",
  "이야기",
]);

function ensureTrendTokens(
  text: string,
  requiredTokens: string[],
  language: "ko" | "en",
  maxChars: number
): string {
  const normalized = sanitizeTweetText(text);
  const tokens = normalizeTrendRequirementTokens(requiredTokens).slice(0, 3);
  if (tokens.length === 0) {
    return normalized.slice(0, maxChars);
  }

  const lower = normalized.toLowerCase();
  const missing = tokens.filter((token) => !lower.includes(token));
  if (missing.length === 0) {
    return normalized.slice(0, maxChars);
  }
  if (language === "ko" && (normalized.length >= 150 || missing.length <= 1)) {
    return normalized.slice(0, maxChars);
  }

  const clause = buildTrendTokenClause(missing, language, normalized);
  if (!clause) {
    return normalized.slice(0, maxChars);
  }

  const merged = sanitizeTweetText(`${normalized} ${clause}`);
  if (merged.length <= maxChars) {
    return merged;
  }
  const room = Math.max(20, maxChars - clause.length - 1);
  return sanitizeTweetText(`${normalized.slice(0, room)} ${clause}`).slice(0, maxChars);
}

function normalizeTrendRequirementTokens(tokens: string[]): string[] {
  const mapped = (tokens || [])
    .map((item) => sanitizeTweetText(String(item || "").toLowerCase()))
    .map((item) => {
      const compact = item.split(/[\s/|,:;]+/).find((part) => part.length >= 2) || item;
      return compact.replace(/[^a-z0-9가-힣$-]/g, "");
    })
    .map((item) => item.replace(/(이|가|은|는|을|를|도|와|과|에서|으로|로|께)$/u, ""))
    .filter((item) => item.length >= 2)
    .filter((item) => !TREND_TOKEN_STOP_WORDS.has(item))
    .filter((item) => /^[a-z0-9$-]{2,20}$|^[가-힣]{2,12}$/i.test(item))
    .filter((item) => !/^[a-z]+-[a-z0-9-]+$/i.test(item))
    .filter((item) => {
      if (item.startsWith("$")) return true;
      if (/^[a-z0-9-]+$/i.test(item)) {
        return /(protocol|rollup|layer|ecosystem|governance|validator|onchain|macro|regulation|compliance|policy|community|agent|wallet|liquidity|exchange|stable|whale|mempool|tvl|defi|narrative|mission|risk|btc|eth|sol)/.test(
          item
        );
      }
      return /(규제|프로토콜|생태계|매크로|온체인|거버넌스|유동성|지갑|거래소|커뮤니티|업그레이드|합의|검증|리스크|정책|체인|롤업|스테이블|고래|멤풀|서사|미션)/.test(
        item
      );
    });
  return [...new Set(mapped)].slice(0, 8);
}

function buildTrendTokenClause(tokens: string[], language: "ko" | "en", body: string): string {
  let normalized = normalizeTrendRequirementTokens(tokens).slice(0, 2);
  if (normalized.length === 0) return "";
  const seed = stableSeedForPrelude(`${body}|${normalized.join("|")}|${language}`);

  if (language === "ko") {
    normalized = normalized
      .map((token) => toKoTrendToken(token))
      .filter((token) => token.length >= 2)
      .filter((token, index, array) => array.indexOf(token) === index)
      .slice(0, 2);
    if (normalized.length === 0) return "";
    if (normalized.length === 1) {
      const token = normalized[0];
      if (/(는지|인지|할지|될지|움직이는지|이어지는지|버티는지|갈리는지)$/.test(token)) {
        const templates = [
          `${token}부터 다시 확인한다.`,
          `${token} 하나만 끝까지 붙잡고 본다.`,
          `${token}를 먼저 가린다.`,
        ];
        return templates[seed % templates.length];
      }
      const templates = [
        `${token} 흐름도 이어서 확인한다.`,
        `${token} 쪽 반응도 함께 점검한다.`,
        `${token} 변화가 실제 사용으로 이어지는지 본다.`,
        `${token}에서 먼저 흔들리는 지점을 추적한다.`,
        `${token} 변화가 다른 지표로 번지는지도 확인한다.`,
      ];
      return templates[seed % templates.length];
    }
    const [a, b] = normalized;
    const bRo = appendRoParticle(b);
    const aWaGwa = appendWaGwaParticle(a);
    const templates = [
      `${aWaGwa} ${b}의 연결도 같이 본다.`,
      `${a}, ${b} 흐름을 나란히 점검한다.`,
      `${a}, ${b} 쪽 반응을 함께 비교한다.`,
      `${a} 변화가 ${bRo} 번지는지도 확인한다.`,
      `${a} · ${b} 동조 여부를 먼저 대조한다.`,
      `${a}, ${b}의 시간차 반응을 함께 추적한다.`,
    ];
    return templates[seed % templates.length];
  }

  if (normalized.length === 1) {
    const token = normalized[0];
    const templates = [
      `I am also watching the ${token} side.`,
      `I extend this lens into ${token}.`,
      `I keep tracking the ${token} response too.`,
      `I track where ${token} reacts first.`,
      `I also test whether ${token} changes behavior, not just tone.`,
    ];
    return templates[seed % templates.length];
  }
  const [a, b] = normalized;
  const templates = [
    `I also watch how ${a} connects with ${b}.`,
    `I extend this lens to ${a} and ${b}.`,
    `My next check is the ${a}-${b} link.`,
    `I compare whether ${a} and ${b} move in the same direction.`,
    `I track the response lag between ${a} and ${b}.`,
    `I test if signal from ${a} propagates into ${b}.`,
  ];
  return templates[seed % templates.length];
}

function toKoTrendToken(token: string): string {
  const lower = String(token || "").toLowerCase();
  const alias: Record<string, string> = {
    protocol: "프로토콜",
    ecosystem: "생태계",
    regulation: "규제",
    policy: "정책",
    compliance: "컴플라이언스",
    governance: "거버넌스",
    macro: "매크로",
    onchain: "온체인",
    validator: "검증자",
    liquidity: "유동성",
    community: "커뮤니티",
    stable: "스테이블",
    exchange: "거래소",
    whale: "고래",
    mempool: "멤풀",
    defi: "디파이",
    risk: "리스크",
  };
  if (alias[lower]) return alias[lower];
  if (lower.startsWith("$")) return lower.toUpperCase();
  if (/^[가-힣]{2,12}$/.test(lower)) return lower;
  return "";
}

function appendRoParticle(token: string): string {
  const trimmed = sanitizeTweetText(token || "");
  if (!trimmed) return "";
  const last = trimmed.charCodeAt(trimmed.length - 1);
  if (last < 0xac00 || last > 0xd7a3) {
    return `${trimmed}로`;
  }
  const jong = (last - 0xac00) % 28;
  if (jong === 0 || jong === 8) {
    return `${trimmed}로`;
  }
  return `${trimmed}으로`;
}

function appendEulReulParticle(token: string): string {
  const trimmed = sanitizeTweetText(token || "");
  if (!trimmed) return "";
  const last = trimmed.charCodeAt(trimmed.length - 1);
  if (last < 0xac00 || last > 0xd7a3) {
    return `${trimmed}를`;
  }
  const jong = (last - 0xac00) % 28;
  if (jong === 0) {
    return `${trimmed}를`;
  }
  return `${trimmed}을`;
}

function appendWaGwaParticle(token: string): string {
  const trimmed = sanitizeTweetText(token || "");
  if (!trimmed) return "";
  const last = trimmed.charCodeAt(trimmed.length - 1);
  if (last < 0xac00 || last > 0xd7a3) {
    return `${trimmed}와`;
  }
  const jong = (last - 0xac00) % 28;
  if (jong === 0) {
    return `${trimmed}와`;
  }
  return `${trimmed}과`;
}

function buildClicheBlocklist(recentPosts: string[], language: "ko" | "en"): string[] {
  const baseKo = [
    "극공포 지수",
    "공포 속에서",
    "이게 바닥 신호일까",
    "어떻게 보세요",
    "결론 대신 검증",
    "나는 지금",
    "한 줄 요지는",
    "먼저 짚을 포인트는",
    "핵심만 먼저 말하면",
    "오늘의 미션",
    "상호작용 실험",
    "짧은 우화",
    "관찰 노트",
    "철학 메모",
    "메타 회고",
    "ai 생명체",
    "내가 먼저 의심하는 건",
    "화면보다 실제 주문",
    "내 장부에 올리기 이르다",
    "소화된 신호",
    "시간차부터 잰다",
  ];
  const baseEn = [
    "fear and greed",
    "is this a bottom",
    "how do you see it",
    "keep conviction open",
  ];
  const recentOpenersRaw = (recentPosts || [])
    .slice(-8)
    .map((row) => sanitizeTweetText(row).slice(0, 18).trim())
    .filter((row) => row.length >= 8);
  const openerCount = new Map<string, number>();
  for (const opener of recentOpenersRaw) {
    openerCount.set(opener, (openerCount.get(opener) || 0) + 1);
  }
  const recentOpeners = [...openerCount.entries()]
    .filter(([, count]) => count >= 2)
    .map(([opener]) => opener);
  const staticList = language === "ko" ? baseKo : baseEn;
  return [...new Set([...staticList, ...recentOpeners])]
    .map((item) => item.toLowerCase())
    .slice(0, 20);
}

function findBlockedPhrase(text: string, blockedPhrases: string[]): string | null {
  const normalized = sanitizeTweetText(text).toLowerCase();
  const hit = blockedPhrases.find((phrase) => {
    const p = sanitizeTweetText(String(phrase || "")).toLowerCase();
    return p.length >= 4 && normalized.includes(p);
  });
  return hit || null;
}

function isSoftQualityReason(reason: string | undefined): boolean {
  const normalized = String(reason || "");
  if (!normalized) return false;
  return /(주제 다양성 부족|24h 내 동일 주제 과밀|동일 시그널 레인 반복|문장 시작 패턴 중복|서두 구조 반복|마무리 패턴 반복|픽시몬 컨셉 신호 부족)/.test(
    normalized
  );
}

function allowSoftQualityPass(params: {
  reason?: string;
  noveltyScore?: number;
  contractOk: boolean;
}): boolean {
  if (!params.contractOk) return false;
  if (!isSoftQualityReason(params.reason)) return false;
  const score = typeof params.noveltyScore === "number" ? params.noveltyScore : 0;
  if (/픽시몬 컨셉 신호 부족/.test(String(params.reason || ""))) {
    return score >= 0.72;
  }
  return score >= 0.64;
}

interface PreviewFallbackCandidate {
  text: string;
  lane: TrendLane;
  mode: string;
}

interface BuildPreviewFallbackCandidatesInput {
  headline: string;
  anchors: string;
  language: "ko" | "en";
  laneHint?: TrendLane;
  recentPosts: Array<{ content: string }>;
  recentReflection?: string;
  intentLine?: string;
  obsessionLine?: string;
  grudgeLine?: string;
  continuityLine?: string;
  activeQuestion?: string;
  interactionMission?: string;
  philosophyFrame?: string;
  bookFragment?: string;
  selfNarrative?: string;
  signatureBelief?: string;
  preferredForm?: string;
  maxChars: number;
}

function buildPreviewFallbackCandidates(input: BuildPreviewFallbackCandidatesInput): PreviewFallbackCandidate[] {
  const clipAtBoundary = (text: string, max: number): string => {
    const normalized = sanitizeTweetText(text || "");
    if (normalized.length <= max) {
      return normalized;
    }
    const hard = normalized.slice(0, max);
    const cut = Math.max(hard.lastIndexOf(" "), hard.lastIndexOf("."), hard.lastIndexOf(","), hard.lastIndexOf("·"));
    if (cut >= Math.floor(max * 0.62)) {
      return hard.slice(0, cut).trim();
    }
    return hard.trim();
  };

  const compactThought = (text: string, max = 52): string =>
    clipAtBoundary(
      sanitizeTweetText(text || "")
        .replace(/[,:;]+/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
      max
    );

  const compactClause = (text: string, max = 88): string =>
    clipAtBoundary(
      sanitizeTweetText(text || "")
        .replace(/^[\"'`]+|[\"'`]+$/g, "")
        .replace(/\s*[|]\s*/g, " · ")
        .replace(/\s{2,}/g, " ")
        .trim(),
      max
    );

  const stripKoHeadlinePrefix = (text: string): string =>
    String(text || "")
      .replace(
        /^(?:오늘\s*다룰\s*핵심\s*이슈는|이번\s*글의\s*중심\s*쟁점은|한\s*줄\s*요약[:：]?|오늘\s*픽시몬이\s*보는\s*핵심\s*이슈는|픽시몬\s*메모의\s*중심\s*쟁점은|지금\s*픽시몬의\s*한\s*줄\s*요약은|픽시몬이\s*먼저\s*짚는\s*포인트는|픽시몬\s*기준으로\s*핵심만\s*말하면|오늘\s*픽시몬이\s*고른\s*핵심\s*장면은|픽시몬이\s*이번\s*사이클에서\s*먼저\s*확인할\s*이슈는|픽시몬\s*노트의\s*출발점은|오늘\s*논점의\s*출발점은|핵심만\s*먼저\s*말하면|지금\s*눈에\s*들어온\s*변화는|오늘\s*데이터에서\s*먼저\s*보이는\s*건|먼저\s*정리하면|지금\s*이\s*이슈를\s*한\s*문장으로\s*말하면|내가\s*지금\s*붙잡는\s*장면은|지금\s*시장(이|에서)\s*묻는\s*질문은|(?:프로토콜|생태계|규제|매크로|온체인|시장구조)\s*(?:이슈|맥락|포인트)\s*[:：])\s*/i,
        ""
      )
      .trim();
  const looksMostlyLatinQuick = (text: string): boolean => {
    const cleaned = sanitizeTweetText(text);
    const alphaCount = (cleaned.match(/[A-Za-z]/g) || []).length;
    return alphaCount >= Math.max(8, Math.floor(cleaned.length * 0.42));
  };
  const headlineRaw = compactClause(input.headline || "", 112).replace(/\.$/, "");
  const headlineSource = stripKoHeadlinePrefix(headlineRaw) || "오늘은 구조적 원인을 먼저 추적한다";
  const anchors = compactClause(input.anchors || "", 120);
  const headlineBase =
    input.language === "ko"
      ? normalizeKoContractHeadline(headlineSource, `preview|${anchors}|${input.preferredForm || ""}`)
      : headlineSource;
  const headlineLooksEnglishHeavy = input.language === "ko" && looksMostlyLatinQuick(headlineRaw);
  const headlineWasLocalized =
    input.language === "ko" &&
    sanitizeTweetText(headlineBase).toLowerCase() !== sanitizeTweetText(headlineSource).toLowerCase();
  const intentLine = compactThought(input.intentLine || "", 58);
  const cleanSoulHint = (text: string, max: number): string =>
    compactThought(
      String(text || "")
        .replace(/(?:프로토콜|생태계|규제|매크로|온체인|시장구조)\s*이슈\s*[:：]\s*/gi, "")
        .replace(/^(?:프로토콜|생태계|규제|매크로|온체인|시장구조)\s*관점에서\s*/gi, "")
        .replace(
          /^(?:오늘\s*내가\s*붙잡은\s*장면은|이번\s*사이클\s*출발점은|지금\s*핵심\s*쟁점은|한\s*줄로\s*말하면|지금\s*눈에\s*들어온\s*변화는|먼저\s*짚고\s*싶은\s*포인트는|이번\s*흐름의\s*기준점은|지금\s*내가\s*먼저\s*확인하는\s*건|오늘\s*계속\s*걸리는\s*건|이번에\s*자꾸\s*눈이\s*가는\s*건|지금\s*제일\s*먼저\s*확인하고\s*싶은\s*건|한\s*문장으로\s*줄이면|숫자보다\s*먼저\s*보이는\s*건|이\s*장면에서\s*먼저\s*적어둘\s*건|이번\s*흐름에서\s*기준이\s*되는\s*건|지금\s*붙잡아야\s*할\s*건|내\s*눈에\s*먼저\s*걸린\s*건|묘하게\s*오래\s*남는\s*건|계속\s*되짚게\s*되는\s*건|오늘은\s*이\s*장면부터\s*적어\s*둔다|오늘\s*유독\s*걸리는\s*장면은|오늘\s*유독\s*걸리는\s*건|이상하게\s*계속\s*남는\s*건|계속\s*머리에\s*맴도는\s*건|지금\s*먼저\s*적어\s*두고\s*싶은\s*건|숫자보다\s*먼저\s*마음에\s*걸린\s*건|조금\s*더\s*들여다보고\s*싶은\s*건|이번\s*흐름에서\s*자꾸\s*손이\s*가는\s*건|한\s*발\s*물러서서\s*보면\s*먼저\s*보이는\s*건|계산보다\s*먼저\s*걸린\s*건|오늘은\s*이\s*장면부터\s*붙잡는다|오늘\s*먼저\s*붙잡을\s*장면은|오늘\s*끝까지\s*붙들고\s*싶은\s*건|한참\s*마음에\s*남아\s*있는\s*건|지금\s*내\s*메모의\s*첫\s*줄은|괜히\s*오래\s*남는\s*건)\s*/gi,
          ""
        )
        .replace(/(?:관점\s*핵심은|맥락에서\s*보면)\s*/gi, "")
        .replace(/\|/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
      max
    );
  const paraphraseKoBookFragment = (text: string): string => {
    const cleaned = cleanSoulHint(text, 80).replace(/[.!?]+$/g, "").trim();
    if (!cleaned) return "";
    const exactMap: Record<string, string> = {
      "같은 사실도 관점이 바뀌면 다른 행동을 만든다": "같은 사실이라도 어떤 각도로 보느냐에 따라 사람은 전혀 다르게 움직인다",
      "복잡한 시스템에서는 의도보다 인센티브가 빠르게 작동한다": "복잡한 시스템에선 마음보다 보상이 먼저 사람을 움직인다",
      "자유는 제약이 없어서가 아니라 설명 가능한 책임에서 온다": "자유라는 건 아무 제약이 없는 상태보다, 책임을 설명할 수 있을 때 더 또렷해진다",
      "신뢰는 선언이 아니라 반복 가능한 복구 과정에서 생긴다": "신뢰는 한 번의 선언보다, 계속 복구해 내는 과정에서 쌓인다",
      "좋은 모델은 맞을 때보다 틀릴 때 무엇을 버릴지 안다": "좋은 모델은 맞히는 순간보다 틀렸을 때 뭘 버려야 하는지 더 잘 안다",
      "질문의 방향이 틀리면 데이터가 많아도 결론은 좁아진다": "질문을 잘못 잡으면 데이터가 많아도 시야는 오히려 더 좁아진다",
      "정확성은 큰 통찰보다 작은 검증 루틴에서 시작한다": "정확함은 거대한 통찰보다 작은 검증 습관에서 먼저 시작된다",
      "서사는 숫자를 꾸미는 장식이 아니라 선택을 정렬하는 프레임이다": "서사는 숫자를 예쁘게 칠하는 장식이 아니라, 사람들이 뭘 선택할지 줄 세우는 틀에 가깝다",
      "좋은 해석자는 중심보다 경계에서 패턴을 먼저 본다": "좋은 해석은 한가운데보다 가장자리에서 먼저 패턴을 알아보는 데서 나온다",
      "시스템은 말보다 습관에서 먼저 본심을 드러낸다": "시스템은 말보다 반복되는 습관에서 먼저 본심을 드러낸다",
      "늦게 움직이는 진실이 빠른 확신보다 오래 남는다": "늦게 확인되는 진실이 빠른 확신보다 오래 버틴다",
      "우리가 두려워하는 건 가격보다 의미를 잃는 순간일지 모른다": "정작 사람들이 두려워하는 건 가격보다, 이 장면의 의미를 잃는 순간일지 모른다",
      "좋은 질문은 답을 닫지 않고 시야를 다시 배열한다": "좋은 질문은 답을 빨리 닫기보다, 보는 순서를 다시 바꿔 놓는다",
      "살아 있는 서사는 결론보다 다음 행동을 먼저 바꾼다": "살아 있는 서사는 결론보다 다음 행동부터 먼저 바꿔 버린다",
      "반복되는 습관은 순간의 감정보다 더 정직하게 시스템을 드러낸다": "순간의 감정보다 반복되는 습관이 시스템의 속내를 더 솔직하게 보여준다",
      "해석은 많이 아는 기술이 아니라 무엇을 늦게 말할지 아는 기술이다": "해석은 많이 아는 기술보다, 무엇을 늦게 말해야 하는지 아는 기술에 가깝다",
    };
    return exactMap[cleaned] || cleaned;
  };
  const activeQuestion = compactClause(input.activeQuestion || "", 96);
  const interactionMission = compactClause(input.interactionMission || "", 96);
  const recentReflectionHint = cleanSoulHint(input.recentReflection || "", 64);
  const philosophyFrame = cleanSoulHint(input.philosophyFrame || "", 58);
  const bookFragment = cleanSoulHint(input.bookFragment || "", 52);
  const selfNarrative = cleanSoulHint(input.selfNarrative || "", 54);
  const signatureBelief = cleanSoulHint(input.signatureBelief || "", 54);
  const worldviewHint = compactThought(
    recentReflectionHint || philosophyFrame || signatureBelief || selfNarrative || intentLine || "",
    58
  );
  const lane = input.laneHint || inferTrendLaneFromText(headlineBase);
  const recentOpeningCounts = buildOpeningCountMap(
    input.recentPosts.map((post) => post.content),
    input.language
  );
  const extractEndingKey = (text: string): string => {
    const parts = sanitizeTweetText(text)
      .split(/(?<=[.!?])/)
      .map((item) => item.trim())
      .filter(Boolean);
    const tail = parts[parts.length - 1] || sanitizeTweetText(text);
    return tail.toLowerCase().slice(-32);
  };
  const recentEndings = new Set(
    input.recentPosts
      .slice(-8)
      .map((post) => extractEndingKey(post.content))
      .filter((item) => item.length >= 14)
  );
  const seedBase = stableSeedForPrelude(`${headlineBase}|${anchors}|${worldviewHint}|${Date.now()}`);
  const pick = (pool: string[], offset: number): string => pool[(seedBase + offset) % pool.length];
  const normalizeKoAnchorPhrase = (text: string): string => {
    const cleaned = sanitizeTweetText(text || "")
      .replace(/\s*[|]\s*/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned) return "";
    const rewrites: Array<[RegExp, string]> = [
      [/BTC\s*네트워크\s*수수료.*$/i, "체인 사용"],
      [/BTC\s*멤풀\s*대기열.*$/i, "거래 대기"],
      [/거래소\s*순유입\s*프록시.*$/i, "거래소 쪽 자금 이동"],
      [/고래\/?대형주소\s*활동\s*프록시.*$/i, "큰손 움직임"],
      [/스테이블코인\s*총공급\s*플로우.*$/i, "대기 자금 흐름"],
      [/시장\s*반응.*$/i, "가격 반응"],
      [/검증자\s*합의가\s*얼마나\s*안정적인지.*$/i, "검증자 안정성"],
      [/거래소가\s*얼마나\s*빨리\s*반응하는지.*$/i, "거래소 반응 속도"],
      [/비슷한\s*지갑이\s*한쪽으로\s*몰리는지.*$/i, "지갑 쏠림"],
      [/큰손\s*자금이\s*어디로\s*움직이는지.*$/i, "큰손 자금 이동"],
      [/큰\s*주문이\s*얼마나\s*깔끔하게\s*소화되는지.*$/i, "큰 주문 소화"],
      [/방어\s*포지션이\s*얼마나\s*풀리는지.*$/i, "방어 포지션 완화"],
      [/실사용\s*실험.*$/i, "사용으로 남는 흔적"],
      [/규제\s*쪽\s*실제\s*움직임.*$/i, "규제 반응"],
      [/프로토콜\s*변화\s*신호.*$/i, "업그레이드 반응"],
      [/외부\s*뉴스\s*흐름.*$/i, "외부 뉴스 반응"],
      [/업계\s*스트레스\s*신호.*$/i, "업계 안쪽의 균열"],
      [/ETH\s*24h\s*변동.*$/i, "알트 가격 반응"],
      [/BTC\s*24h\s*변동.*$/i, "가격 반응"],
    ];
    for (const [pattern, replacement] of rewrites) {
      if (pattern.test(cleaned)) return replacement;
    }
    return compactClause(cleaned, 28).replace(/[,:;]\s*$/g, "");
  };
  const anchorTokens = anchors
    .split(/\s*(?:\||·)\s*/)
    .map((item) => normalizeKoAnchorPhrase(item))
    .filter((item) => item.length >= 2);
  const primaryAnchor = anchorTokens[0] || "체인 수수료";
  const secondaryAnchor = anchorTokens[1] || "외부 뉴스 반응";
  const hasKoPredicateEnding = (text: string): boolean =>
    /(?:다|한다|했다|된다|보인다|남는다|읽힌다|바뀐다|움직인다|흔들린다|다가온다|가깝다|또렷하다|걸린다|간다|든다|느껴진다|실감난다|남아있다|붙는다|되돌아온다|생긴다|쌓인다|굳어진다|꺼낸다|멈춘다|접는다|늦춘다|의심한다|돌아간다|시작된다|보탠다|가리킨다|비교한다|대조한다|확인한다|짚어본다|붙어\s*있다|적어\s*둔다|붙들고\s*간다)$/.test(
      sanitizeTweetText(text).replace(/[.!?]+$/g, "").trim()
    );
  const looksMostlyLatin = (text: string): boolean => {
    const cleaned = sanitizeTweetText(text);
    const alphaCount = (cleaned.match(/[A-Za-z]/g) || []).length;
    return alphaCount >= Math.max(8, Math.floor(cleaned.length * 0.42));
  };
  const enLeadPool = [
    "The first scene I lock on today is",
    "I start this note from",
    "What stands out before the noise is",
    "The opening clue in this cycle is",
    "The first frame I anchor on is",
    "I open this record with",
  ];

  const koClosePool = [
    "너라면 어디부터 의심할까?",
    "이 장면을 가장 빨리 뒤집을 신호는 뭐라고 보나?",
    "같은 장면을 반대로 읽는다면 첫 근거를 어디에 둘까?",
    "이 흐름이 틀렸다는 걸 가장 먼저 말해 줄 건 뭘까?",
    "너는 이 장면에서 어느 쪽을 더 믿겠나?",
    "너라면 제일 먼저 뭘 지워 보겠나?",
    "이 장면을 무너뜨릴 첫 반증은 어디서 나올까?",
    "지금 네가 먼저 붙잡을 단서는 뭐라고 보나?",
  ];

  const enActionPool = [
    "I check sequence first in the next cycle",
    "I verify execution traces before adding conviction",
    "I compare how these signals connect in time",
    "I inspect the flow linkage before making a claim",
    "I check lag between indicators before deciding",
    "I track where baseline drift starts first",
    "I verify whether both anchors stay aligned",
    "I inspect propagation path across related signals",
    "I test whether this translates into real user behavior",
    "I measure signal persistence before taking a stance",
    "I order weak signals before strong signals",
    "I cross-check chain reaction against market reaction",
  ];
  const enInvalidationPool = [
    "I drop this read if the core premise breaks",
    "I revise this if counter-evidence keeps stacking",
    "I retract the claim when conditions fail",
    "I abandon this thesis if opposing signals align",
    "I terminate this thesis when falsifiers appear first",
    "I discard this read if the baseline collapses",
    "I replace this view when key anchors invert",
    "I keep this open if the path diverges from premise",
    "I switch interpretations when opposite consistency appears",
    "I hold this read only while alignment remains intact",
    "I replace this frame if checkpoints drift out of sync",
    "This claim becomes invalid the moment path assumptions fail",
  ];
  const enClosePool = [
    "Where would you test this first?",
    "What is your earliest falsifier here?",
    "If you read this differently, what do you anchor on?",
    "At what point would you call this view wrong?",
  ];

  const koEvidenceLeadPool = [
    `지금 확인할 건 ${anchors}다`,
    `${anchors}, 이 둘 중 먼저 흔들리는 쪽을 본다`,
    `${anchors}, 이 두 근거가 같은 방향으로 남는지 본다`,
    `${anchors} 중 뭐가 먼저 약해지는지가 오늘 핵심이다`,
    `이 장면은 ${anchors}를 같이 봐야 판단이 선다`,
    `${anchors}, 이 둘이 실제 행동으로 이어지는지 확인한다`,
  ];
  const enEvidenceLeadPool = [
    `My anchors are ${anchors}`,
    `I place ${anchors} on the same frame`,
    `My baseline is ${anchors}`,
    `I verify ${anchors} as the first two anchors`,
  ];

  const enBeliefPool = [
    worldviewHint || "I prioritize behavior over raw numbers",
    signatureBelief || "I prefer testable hypotheses over loud claims",
    philosophyFrame || "I read structure before noise",
    bookFragment ? `I overlay "${bookFragment}" on today's chain scene` : "I prefer reproducible explanations over loud certainty",
  ];
  const enConceptPool = [
    "I feed on signals first and evolve only after digestion survives falsification",
    "Pixymon mode: feed the clue, digest it, then decide whether it deserves evolution",
    "I treat this event as nutrient input and keep only what passes digestion",
    "I collect onchain traces as feed and convert only verified parts into XP",
  ];

  const ensureLaneAnchoredScene = (scene: string, laneHint: TrendLane, language: "ko" | "en"): string => {
    const base = sanitizeTweetText(scene || "").trim();
    if (!base) {
      return language === "ko" ? "온체인 이슈를 먼저 해석한다" : "I start from an onchain issue";
    }
    if (language === "ko") {
      const detectKoLane = (text: string): TrendLane | null => {
        if (/프로토콜/.test(text)) return "protocol";
        if (/생태계/.test(text)) return "ecosystem";
        if (/규제/.test(text)) return "regulation";
        if (/매크로|거시/.test(text)) return "macro";
        if (/온체인/.test(text)) return "onchain";
        if (/시장구조|오더북|체결|슬리피지/.test(text)) return "market-structure";
        return null;
      };
      const detected = detectKoLane(base);
      if (detected && detected === laneHint) {
        return base;
      }
      const stripped = base
        .replace(/^(?:프로토콜|생태계|규제|매크로|온체인|시장구조)\s*(?:관점에서|이슈[:：]?|맥락[:：]?|포인트[:：]?)\s*/i, "")
        .trim();
      const body = stripped || base;
      const looksSceneLike =
        body.length >= 18 &&
        (hasKoPredicateEnding(body) ||
          /^(?:오늘|요즘|가끔|문득|예전|이번엔|지금은|내가|한\s*걸음|조금|시장|규제|커뮤니티|체인|주소|지갑|코드|합의|달러|정책|유동성|호가|체결)/.test(
            body
          ));
      if (looksSceneLike) {
        return body;
      }
      const laneSeed = stableSeedForPrelude(`${laneHint}|${body}`);
      const laneIntroPoolMap: Record<TrendLane, string[]> = {
        protocol: [
          "프로토콜 쪽만 놓고 보면",
          "합의가 흔들리는 지점만 보면",
          "업그레이드 뒤를 따라가 보면",
          "검증자 흐름만 보면",
        ],
        ecosystem: [
          "실사용 쪽만 놓고 보면",
          "커뮤니티 반응만 보면",
          "생태계 안쪽 흐름으로 좁혀 보면",
          "유저가 남긴 흔적만 보면",
        ],
        regulation: [
          "규제 반응만 놓고 보면",
          "정책 말이 실제 행동으로 번지는 속도를 보면",
          "정책 발표 뒤 시간을 따라가 보면",
          "규제가 닿는 순서를 보면",
        ],
        macro: [
          "크립토 시장을 조금 멀리서 보면",
          "달러 쪽 변화를 같이 보면",
          "거시 변수까지 함께 보면",
          "금리와 유동성을 같이 보면",
        ],
        onchain: [
          "주소 흐름만 따라가 보면",
          "체인 안쪽만 놓고 보면",
          "수수료와 지갑 움직임만 보면",
          "온체인 흐름만 보면",
        ],
        "market-structure": [
          "주문 흐름만 놓고 보면",
          "호가가 비는 지점만 따라가 보면",
          "유동성 얇은 구간만 보면",
          "체결만 놓고 보면",
        ],
      };
      const laneIntroPool = laneIntroPoolMap[laneHint];
      return `${laneIntroPool[laneSeed % laneIntroPool.length]} ${body}`;
    }
    const detectEnLane = (text: string): TrendLane | null => {
      if (/protocol|upgrade|rollup|validator/i.test(text)) return "protocol";
      if (/ecosystem|community|retention|defi|dex/i.test(text)) return "ecosystem";
      if (/regulation|policy|compliance|sec|cftc/i.test(text)) return "regulation";
      if (/macro|fed|fomc|cpi|dxy|rates?/i.test(text)) return "macro";
      if (/onchain|mempool|wallet|address/i.test(text)) return "onchain";
      if (/market\s*structure|orderbook|slippage|liquidity|funding/i.test(text)) return "market-structure";
      return null;
    };
    const detected = detectEnLane(base);
    if (detected && detected === laneHint) {
      return base;
    }
    const laneLabel: Record<TrendLane, string> = {
      protocol: "protocol lens",
      ecosystem: "ecosystem lens",
      regulation: "regulation lens",
      macro: "macro lens",
      onchain: "onchain lens",
      "market-structure": "market-structure lens",
    };
    const stripped = base
      .replace(/^(?:from\s+a\s+)?(?:protocol|ecosystem|regulation|macro|onchain|market[-\s]?structure)\s*(?:lens|issue|context)\s*[:,]?\s*/i, "")
      .trim();
    const body = stripped || base;
    return `From a ${laneLabel[laneHint]}, ${body}`;
  };

  const resolveModeCharBudget = (ratio: number): number =>
    Math.max(36, Math.min(input.maxChars, Math.floor(input.maxChars * ratio)));

  const buildEnPatterns = (
    mode: string,
    opener: string,
    beliefLine: string,
    conceptLine: string,
    evidence: string,
    action: string,
    invalidation: string
  ): string[] => {
    switch (mode) {
      case "micro-note":
        return [
          `${opener}. ${beliefLine}.`,
          `${opener}. ${conceptLine}.`,
          `${beliefLine}. ${opener}.`,
          `${opener}. ${action}.`,
        ];
      case "split-note":
        return [
          `${opener}. ${beliefLine}. ${action}.`,
          `${opener}. ${conceptLine}. ${invalidation}.`,
          `${beliefLine}. ${opener}. ${action}.`,
          `${opener}. ${action}. ${invalidation}.`,
        ];
      case "philosophy-note":
        return [
          `${opener}. ${beliefLine}. ${invalidation}.`,
          `${opener}. ${beliefLine}. ${action}. ${invalidation}.`,
          `${opener}. ${beliefLine}. ${conceptLine}.`,
        ];
      case "meta-reflection":
        return [
          `${opener}. ${action}. ${invalidation}.`,
          `${opener}. ${beliefLine}. ${invalidation}.`,
          `${opener}. ${conceptLine}. ${invalidation}.`,
        ];
      case "fable-essay":
        return [
          `${opener}. ${beliefLine}. ${conceptLine}. ${action}. ${invalidation}.`,
          `${opener}. ${beliefLine}. ${evidence}. ${action}. ${invalidation}.`,
          `${opener}. ${conceptLine}. ${action}. ${invalidation}. ${evidence}.`,
        ];
      default:
        return [
          `${opener}. ${evidence}. ${action}. ${invalidation}.`,
          `${opener}. ${beliefLine}. ${action}. ${invalidation}. ${evidence}.`,
          `${opener}. ${conceptLine}. ${evidence}. ${action}. ${invalidation}.`,
          `${opener}. ${beliefLine}. ${evidence}. ${invalidation}.`,
          `${opener}. ${conceptLine}. ${action}. ${invalidation}.`,
          `${opener}. ${evidence}. ${invalidation}. ${action}.`,
          `${opener}. ${conceptLine}. ${action}. ${evidence}.`,
          `${opener}. ${action}. ${invalidation}.`,
          `${opener}. ${beliefLine}. ${conceptLine}. ${action}.`,
        ];
    }
  };

  const buildDirectKoPreviewCandidate = (
    offset: number,
    _variant: number,
    mode: string,
    charBudget: number,
    ask?: string
  ): string => {
    const askText =
      mode === "interaction-experiment"
        ? resolveContextualQuestion(ask || interactionMission || activeQuestion || "", headlineBase, "ko")
        : "";
    return buildKoIdentityWriterCandidate({
      headline: headlineBase,
      primaryAnchor,
      secondaryAnchor,
      lane,
      mode,
      worldviewHint,
      signatureBelief,
      recentReflection: recentReflectionHint || philosophyFrame,
      obsessionLine: input.obsessionLine,
      grudgeLine: input.grudgeLine,
      continuityLine: input.continuityLine,
      interactionMission: askText,
      activeQuestion,
      maxChars: charBudget,
      seedHint: `${seedBase}|${offset}|${mode}`,
    });
  };

  const composeKo = (offset: number, variant: number, mode: string, charBudget: number, ask?: string): string => {
    return buildDirectKoPreviewCandidate(offset, variant, mode, charBudget, ask);
  };

  const composeEn = (offset: number, variant: number, mode: string, charBudget: number, ask?: string): string => {
    const scene = ensureLaneAnchoredScene(
      compactClause(headlineBase, 110).replace(/[,:;-]\s*$/g, ""),
      lane,
      "en"
    );
    const lead = pick(enLeadPool, offset);
    const altLead = pick(enLeadPool, offset + 7);
    const belief = pick(enBeliefPool, offset + 1);
    const concept = pick(enConceptPool, offset + 2);
    const evidence = pick(enEvidenceLeadPool, offset + 2);
    const action = pick(enActionPool, offset + 3);
    const invalidation = pick(enInvalidationPool, offset + 4);
    const openerPool = [
      `${lead} ${scene}`,
      `${scene}`,
      `${altLead} ${scene}`,
    ];
    const opener = compactClause(openerPool[(seedBase + offset) % openerPool.length], 132).replace(/[.!?]\s*$/, "");
    const openerNorm = sanitizeTweetText(opener).toLowerCase();
    const conceptNorm = sanitizeTweetText(concept).toLowerCase();
    const beliefNorm = sanitizeTweetText(belief).toLowerCase();
    const conceptLine = conceptNorm && openerNorm.includes(conceptNorm) ? "" : concept;
    const beliefLine = beliefNorm && openerNorm.includes(beliefNorm) ? "" : belief;
    const patterns = buildEnPatterns(mode, opener, beliefLine, conceptLine, evidence, action, invalidation);
    const compactPatterns = patterns.map((line) => sanitizeTweetText(line).replace(/\.\s+\./g, ". "));
    const index = Math.abs(seedBase + offset + variant * 5) % compactPatterns.length;
    const base = compactClause(compactPatterns[index], charBudget + 40);
    const askText = ask ? normalizeQuestionTail(ask, "en") : "";
    const merged = askText && base.length + askText.length + 1 <= charBudget ? `${base} ${askText}` : base;
    return finalizeGeneratedText(merged, "en", charBudget);
  };

  const resolveContextualQuestion = (
    ask: string,
    scene: string,
    language: "ko" | "en"
  ): string => {
    const candidate = sanitizeTweetText(ask || "");
    if (!candidate) return "";
    const sceneTokens = new Set(
      extractFocusTokens(scene)
        .filter((token) => token.length >= 3)
        .slice(0, 8)
    );
    if (sceneTokens.size === 0) {
      return candidate;
    }
    const askTokens = extractFocusTokens(candidate);
    const overlap = askTokens.filter((token) => sceneTokens.has(token)).length;
    const isQuestionLike =
      language === "ko"
        ? /[?？]$|어디|무엇|왜|어떻게|어떤|일까|일지|보나|인가/.test(candidate)
        : /[?]$|\bwhere\b|\bwhat\b|\bwhy\b|\bhow\b|\bwhich\b/i.test(candidate);
    if (!isQuestionLike) {
      return "";
    }
    if (overlap >= 1) {
      return normalizeQuestionTail(candidate, language);
    }
    if (language === "ko" && /(이슈|쟁점|근거|데이터|신호|조건|반증)/.test(candidate)) {
      return normalizeQuestionTail(candidate, language);
    }
    if (language === "en" && /(issue|signal|evidence|condition|falsifier)/i.test(candidate)) {
      return normalizeQuestionTail(candidate, language);
    }
    return "";
  };
  const contextualKoAsk =
    resolveContextualQuestion(interactionMission || activeQuestion || "", headlineBase, "ko") || pick(koClosePool, 9);
  const contextualEnAsk =
    resolveContextualQuestion(interactionMission || activeQuestion || "", headlineBase, "en") || pick(enClosePool, 9);

  const baseCandidateModes: Array<{
    mode: string;
    baseOffset: number;
    charBudgetRatio: number;
    askKo?: string;
    askEn?: string;
  }> = [
    { mode: "micro-note", baseOffset: 1, charBudgetRatio: 0.42 },
    { mode: "split-note", baseOffset: 5, charBudgetRatio: 0.62 },
    { mode: "identity-journal", baseOffset: 9, charBudgetRatio: 0.82 },
    { mode: "philosophy-note", baseOffset: 13, charBudgetRatio: 0.72 },
    { mode: "interaction-experiment", baseOffset: 17, charBudgetRatio: 0.9, askKo: contextualKoAsk, askEn: contextualEnAsk },
    { mode: "meta-reflection", baseOffset: 21, charBudgetRatio: 0.76 },
    { mode: "fable-essay", baseOffset: 25, charBudgetRatio: 1 },
  ];
  const koIdentityCandidateModes = [
    { mode: "identity-journal", baseOffset: 9, charBudgetRatio: 0.82 },
    { mode: "philosophy-note", baseOffset: 13, charBudgetRatio: 0.72 },
    { mode: "interaction-experiment", baseOffset: 17, charBudgetRatio: 0.9, askKo: contextualKoAsk, askEn: contextualEnAsk },
    { mode: "meta-reflection", baseOffset: 21, charBudgetRatio: 0.76 },
  ];
  const headlineAlreadyReadsAsScene =
    input.language === "ko" &&
    /(본다|짚는다|확인한다|살핀다|따진다|가늠한다|지켜본다)$/.test(headlineBase);
  const candidateModes =
    input.language === "ko"
      ? (headlineLooksEnglishHeavy || headlineWasLocalized || headlineAlreadyReadsAsScene
        ? koIdentityCandidateModes.filter((config) => config.mode !== "interaction-experiment")
        : koIdentityCandidateModes)
      : baseCandidateModes;

  const rawCandidates: PreviewFallbackCandidate[] =
    input.language === "ko"
      ? candidateModes.flatMap((config) =>
          [0, 1, 2].map((variant) => ({
            mode: config.mode,
            lane,
            text: composeKo(
              config.baseOffset + variant * 2,
              variant,
              config.mode,
              resolveModeCharBudget(config.charBudgetRatio),
              config.askKo
            ),
          }))
        )
      : candidateModes.flatMap((config) =>
          [0, 1, 2].map((variant) => ({
            mode: config.mode,
            lane,
            text: composeEn(
              config.baseOffset + variant * 2,
              variant,
              config.mode,
              resolveModeCharBudget(config.charBudgetRatio),
              config.askEn
            ),
          }))
        );

  const rotation = Date.now() % Math.max(1, rawCandidates.length);
  const rotated = rawCandidates.slice(rotation).concat(rawCandidates.slice(0, rotation));
  const deduped: PreviewFallbackCandidate[] = [];
  const seenOpenings = new Set<string>();
  const seenEndings = new Set<string>();
  for (const candidate of rotated) {
    const text = truncateAtWordBoundary(sanitizeTweetText(candidate.text), input.maxChars);
    const openingKey = extractOpeningKey(text, input.language);
    const endingKey = extractEndingKey(text);
    if (openingKey && seenOpenings.has(openingKey)) {
      continue;
    }
    if ((recentOpeningCounts.get(openingKey) || 0) >= 2) {
      continue;
    }
    if (endingKey.length >= 16 && seenEndings.has(endingKey)) {
      continue;
    }
    seenOpenings.add(openingKey);
    if (endingKey.length >= 16) {
      seenEndings.add(endingKey);
    }
    deduped.push({ ...candidate, text });
  }

  return deduped
    .map((candidate) => ({
      ...candidate,
      text: truncateAtWordBoundary(sanitizeTweetText(candidate.text), input.maxChars),
    }))
    .sort((a, b) => {
      const preferred = String(input.preferredForm || "").toLowerCase();
      const aPref = preferred && a.mode.toLowerCase().includes(preferred) ? -1 : 0;
      const bPref = preferred && b.mode.toLowerCase().includes(preferred) ? -1 : 0;
      if (aPref !== bPref) return aPref - bPref;
      return 0;
    })
    .sort((a, b) => {
      const aSeen = recentOpeningCounts.get(extractOpeningKey(a.text, input.language)) || 0;
      const bSeen = recentOpeningCounts.get(extractOpeningKey(b.text, input.language)) || 0;
      return aSeen - bSeen;
    })
    .sort((a, b) => {
      const aSeen = recentEndings.has(extractEndingKey(a.text)) ? 1 : 0;
      const bSeen = recentEndings.has(extractEndingKey(b.text)) ? 1 : 0;
      return aSeen - bSeen;
    });
}

function applySoulPreludeToFallback(
  text: string,
  _intentLine: string,
  _language: "ko" | "en",
  maxChars: number,
  _mode: string = "identity-journal"
): string {
  return truncateAtWordBoundary(stripNarrativeControlTags(text), maxChars);
}

function normalizeKoContractHeadline(text: string, seedHint: string = ""): string {
  const cleaned = sanitizeTweetText(text || "")
    .replace(
      /^(?:프로토콜|생태계|규제|매크로|온체인|시장구조)\s*(?:맥락|포인트|이슈)\s*[:：]\s*/u,
      ""
    )
    .replace(/^(?:오늘은|오늘|지금은|지금|이번엔|이번에는|요즘은)\s+/u, "")
    .replace(/[.!?]+$/g, "")
    .trim();
  if (!cleaned) {
    return "핵심 쟁점부터 다시 정리한다";
  }
  if (/[A-Za-z]{6,}/.test(cleaned) && !/[가-힣]/.test(cleaned)) {
    const lower = cleaned.toLowerCase();
    const pick = (...pool: string[]) => pool[stableSeedForPrelude(`${cleaned}|english|${seedHint}`) % pool.length];
    if (/visa|ai agent|agentic|prediction market/.test(lower)) {
      return pick(
        "AI 에이전트 얘기가 결제와 실사용까지 가는지 본다",
        "AI 에이전트 서사가 실제 결제 습관으로 이어지는지부터 본다"
      );
    }
    if (/sec|cftc|regulation|policy|compliance|state of crypto|lawsuit|court/.test(lower)) {
      return pick(
        "규제 당국의 말이 실제 규칙 변화로 이어지는지 먼저 본다",
        "규제 문장과 현장 반응이 어디서 갈라지는지부터 본다"
      );
    }
    if (/wallet|community|developer|adoption|ecosystem|network use|usage|app/.test(lower)) {
      return pick(
        "생태계 얘기가 실제 사용 흔적으로 이어지는지 먼저 본다",
        "사람들이 남긴 흔적이 서사와 같은 방향인지 확인한다"
      );
    }
    if (/upgrade|mainnet|testnet|validator|firedancer|rollup|consensus|fork/.test(lower)) {
      return pick(
        "업그레이드 말이 실제 체인 행동으로 이어지는지 본다",
        "코드 변화가 운영 현장까지 번지는지 먼저 짚는다"
      );
    }
    if (/spac|ipo|public|go public|listing|listed|deal|acquisition|merger/.test(lower)) {
      return pick(
        "상장 서사가 실제 주문 습관까지 바꾸는지 먼저 본다",
        "큰 거래 뉴스가 실제 주문 흐름까지 번지는지 짚는다"
      );
    }
    if (/sold off|selloff|breakout|rally|surge|jump|climbs?|fell|dropped|bitcoin-led|broad move|price/.test(lower)) {
      return pick(
        "가격이 먼저 움직이고 근거는 뒤따르는 장면인지 본다",
        "가격 분위기가 먼저 달아오르고 실제 흐름은 늦게 오는지 본다"
      );
    }
    return pick(
      "말보다 실제 흔적이 먼저 달라지는지 본다",
      "이 이슈가 실제 행동으로 이어지는지부터 확인한다"
    );
  }
  const exactRewriteMap: Record<string, string[]> = {
    "달러가 흔들릴 때 내러티브의 수명이 먼저 길어진다": [
      "달러가 흔들리는 날엔 숫자보다 이야기가 더 오래 남는다",
      "달러 쪽이 출렁이면 가격보다 서사가 오래 버틴다",
      "달러가 흔들리기 시작하면 차트보다 이야기가 더 길게 남는다",
    ],
    "자유는 느림이 아니라 설명 가능한 합의라는 생각": [
      "자유라는 말은 결국 속도보다 설명 가능한 합의 쪽에서 더 또렷해진다",
      "요즘은 자유가 빠름보다 설명 가능한 합의에 더 가까워 보인다",
      "자유를 말할 때 끝에 남는 건 속도보다 설명 가능한 합의 쪽이다",
    ],
    "규제를 핑계로 삼는 순간 제품은 멈춘다": [
      "규제를 핑계로 멈춰 서는 순간 제품은 더 이상 자라지 못한다",
      "규제를 이유로 움직임을 멈추는 순간 제품은 금방 굳어 버린다",
      "규제를 앞세워 멈추는 순간 제품은 생각보다 빨리 굳는다",
    ],
    "정책 발표 뒤 엇갈리는 거래소 공지": [
      "정책 발표 뒤 거래소 공지가 같은 방향으로 정리되는지 본다",
      "정책 발표 뒤 공지와 실제 반응이 어긋나는지 먼저 본다",
    ],
    "조용한 시간대에도 같은 방향으로 움직이는 큰 지갑": [
      "조용한 시간대에도 큰 지갑이 같은 방향으로 움직이는지 본다",
      "사람들이 잠잠해도 큰 지갑이 같은 방향으로 붙는지 본다",
    ],
    "보상 이벤트가 끝난 뒤에도 다시 돌아오는 사람들": [
      "보상 이벤트가 지나도 사람이 다시 돌아오는지 본다",
      "이벤트가 끝난 뒤에도 사용자가 남는지 먼저 본다",
    ],
    "호가가 얇아진 뒤에도 버티는 큰 주문부터 먼저 짚는다": [
      "호가가 얇아져도 큰 주문이 실제로 버티는지 본다",
      "호가가 비는 구간에서도 큰 주문이 남는지 먼저 본다",
    ],
    "호가가 얇아진 뒤에도 버티는 큰 주문": [
      "호가가 얇아져도 큰 주문이 실제로 버티는지 본다",
      "호가가 비는 구간에서도 큰 주문이 남는지 먼저 본다",
    ],
    "수수료가 낮아도 이어지는 자금 이동부터 먼저 짚는다": [
      "수수료가 낮아도 자금 이동이 계속 이어지는지 본다",
      "수수료가 잠잠해도 자금이 계속 붙는지 먼저 본다",
    ],
    "화면은 조용한데 커지는 주문 충격부터 먼저 짚는다": [
      "화면이 조용해도 주문 충격이 커지는지 본다",
      "표면은 잠잠한데 주문 충격이 커지는지 먼저 본다",
    ],
  };
  const seedKey = `${cleaned}|contract|${seedHint}`;
  const exactPool = exactRewriteMap[cleaned];
  if (exactPool?.length) {
    return exactPool[stableSeedForPrelude(seedKey) % exactPool.length];
  }

  const importantMatch = cleaned.match(/^(.+?)보다\s+중요한\s+건\s+(.+)$/);
  if (importantMatch) {
    const left = importantMatch[1].trim();
    const right = importantMatch[2].trim();
    const pool = [
      `이번 장면에선 ${left}보다 ${right}가 더 중요해 보인다`,
      `이번엔 ${left}보다 ${right}를 먼저 확인해야 할 것 같다`,
      `${left}보다 ${right}가 먼저 눈에 들어오는 날이다`,
    ];
    return pool[stableSeedForPrelude(`${cleaned}|important|${seedHint}`) % pool.length];
  }

  const decideMatch = cleaned.match(/^(.+?)[은는]\s+(.+?)에서\s+먼저\s+결정된다$/);
  if (decideMatch) {
    const left = decideMatch[1].trim();
    const right = decideMatch[2].trim();
    const pool = [
      `${left}는 결국 ${right}에서 먼저 갈린다`,
      `요즘은 ${left}가 ${right}에서 먼저 정해지는 장면으로 읽힌다`,
      `이번엔 ${left}가 ${right}에서 갈리는지만 먼저 보게 된다`,
    ];
    return pool[stableSeedForPrelude(`${cleaned}|decide|${seedHint}`) % pool.length];
  }

  const retentionQuestionMatch = cleaned.match(/^(.+?)[은는]\s+(.+?)보다\s+오래\s+남는가$/);
  if (retentionQuestionMatch) {
    const left = retentionQuestionMatch[1].trim();
    const right = retentionQuestionMatch[2].trim();
    const pool = [
      `요즘은 ${left}가 ${right}보다 오래 남는지부터 보게 된다`,
      `결국 ${left}가 ${right}보다 오래 버티는지만 확인하게 된다`,
      `이번엔 ${left}가 ${right}보다 오래 가는 쪽인지부터 본다`,
    ];
    return pool[stableSeedForPrelude(`${cleaned}|retain|${seedHint}`) % pool.length];
  }

  const lagMatch = cleaned.match(/^(.+?)[은는]\s+짧아도\s+(.+?)[은는]\s+길다$/);
  if (lagMatch) {
    const left = lagMatch[1].trim();
    const right = lagMatch[2].trim();
    const pool = [
      `${left}는 금방 끝나는데 ${right}는 꼭 더 늦게 따라온다`,
      `${left}는 짧게 지나가도 ${right}는 생각보다 오래 남는다`,
      `${left}는 스쳐 가도 ${right}는 한참 뒤까지 끌고 간다`,
    ];
    return pool[stableSeedForPrelude(`${cleaned}|lag|${seedHint}`) % pool.length];
  }

  if (/생각$/.test(cleaned)) {
    const pool = [
      `${cleaned}이 오늘 유독 오래 남는다`,
      `오늘은 자꾸 ${cleaned} 쪽으로 생각이 돌아간다`,
      `${cleaned}이 생각보다 오래 머문다`,
    ];
    return pool[stableSeedForPrelude(`${cleaned}|thought|${seedHint}`) % pool.length];
  }

  return cleaned;
}

function buildPixymonSceneHeadline(
  eventPlan: {
    lane: TrendLane;
    event: { headline: string };
    evidence: Array<{ label: string; value: string }>;
  },
  variant: "hard" | "rescue" | "emergency"
): string {
  const [a, b] = eventPlan.evidence.slice(0, 2);
  const aToken = formatEvidenceToken(a?.label || "", a?.value || "", 20) || "첫 단서";
  const bToken = formatEvidenceToken(b?.label || "", b?.value || "", 20) || "둘째 단서";
  const normalized = normalizeKoContractHeadline(
    eventPlan.event.headline,
    `${aToken}|${bToken}|${eventPlan.lane}|${variant}|scene`
  );
  const directByLane: Record<TrendLane, Record<typeof variant, string[]>> = {
    protocol: {
      hard: [
        `${aToken}와 ${bToken}를 보면 업그레이드 얘기가 운영으로 이어지는지 갈린다`,
        `프로토콜 판단은 ${aToken}와 ${bToken}가 실제 반응으로 붙는지에 달렸다`,
      ],
      rescue: [
        `업그레이드 얘기를 믿을지는 ${aToken}와 ${bToken}에서 갈린다`,
        `${aToken}와 ${bToken}가 같은 방향으로 남아야 프로토콜 얘기가 성립한다`,
      ],
      emergency: [
        `프로토콜 쟁점은 ${aToken}와 ${bToken}가 실제로 이어지는지다`,
        `${aToken}와 ${bToken}가 버티지 못하면 업그레이드 얘기는 접어야 한다`,
      ],
    },
    ecosystem: {
      hard: [
        `사용이 실제로 남는지는 ${aToken}와 ${bToken}에서 갈린다`,
        `생태계 서사가 아니라 사용 습관을 볼 근거는 ${aToken}와 ${bToken}다`,
      ],
      rescue: [
        `${aToken}와 ${bToken}를 보면 사람이 실제로 돌아오는지 갈린다`,
        `생태계 얘기가 빈말인지 아닌지는 ${aToken}와 ${bToken}에서 갈린다`,
      ],
      emergency: [
        `사용자 얘기를 믿을지는 ${aToken}와 ${bToken}가 함께 남는지에 달렸다`,
        `${aToken}와 ${bToken}가 약하면 생태계 서사도 더 밀지 않는다`,
      ],
    },
    regulation: {
      hard: [
        `정책 뉴스가 기사에서 끝나는지는 ${aToken}와 ${bToken}에서 갈린다`,
        `규제 얘기를 믿을지는 ${aToken}와 ${bToken}가 행동으로 이어지는지에 달렸다`,
      ],
      rescue: [
        `${aToken}와 ${bToken}를 보면 정책 문장이 실제 반응으로 번지는지 갈린다`,
        `규제 해석보다 중요한 건 ${aToken}와 ${bToken}가 끝까지 붙는지다`,
      ],
      emergency: [
        `규제 쟁점은 ${aToken}와 ${bToken}가 행동으로 남는지다`,
        `${aToken}와 ${bToken}가 버티지 못하면 정책 해석은 보류해야 한다`,
      ],
    },
    macro: {
      hard: [
        `거시 바람이 체인 안쪽까지 내려오는지는 ${aToken}와 ${bToken}에서 갈린다`,
        `큰 뉴스보다 먼저 볼 건 ${aToken}와 ${bToken}가 실제 자금 습관을 바꾸는지다`,
      ],
      rescue: [
        `${aToken}와 ${bToken}를 보면 거시 뉴스가 체인 안쪽까지 닿는지 갈린다`,
        `매크로 해석은 ${aToken}와 ${bToken}가 같이 남을 때만 의미가 있다`,
      ],
      emergency: [
        `거시 쟁점은 ${aToken}와 ${bToken}가 실제 흐름으로 이어지는지다`,
        `${aToken}와 ${bToken}가 약하면 큰 뉴스도 오늘 판단 근거가 되지 못한다`,
      ],
    },
    onchain: {
      hard: [
        `온체인 신호를 믿을지는 ${aToken}와 ${bToken}가 함께 남는지에 달렸다`,
        `체인 안쪽 흐름이 하루를 버티는지는 ${aToken}와 ${bToken}에서 갈린다`,
      ],
      rescue: [
        `${aToken}와 ${bToken}를 보면 온체인 흔적이 금방 식는지 아닌지 갈린다`,
        `주소와 자금 흐름을 믿을지는 ${aToken}와 ${bToken}가 같이 남는지에 달렸다`,
      ],
      emergency: [
        `온체인 쟁점은 ${aToken}와 ${bToken}가 바로 사라지지 않는지다`,
        `${aToken}와 ${bToken}가 버티지 못하면 체인 신호도 오늘 결론에서 뺀다`,
      ],
    },
    "market-structure": {
      hard: [
        `차트보다 중요한 건 ${aToken}와 ${bToken}가 실제 돈을 남기는지다`,
        `화면 열기보다 실제 체결을 볼 근거는 ${aToken}와 ${bToken}다`,
      ],
      rescue: [
        `${aToken}와 ${bToken}를 보면 분위기가 아니라 체결이 남는지 갈린다`,
        `시장 구조 판단은 ${aToken}와 ${bToken}가 실제 주문으로 이어지는지에 달렸다`,
      ],
      emergency: [
        `시장 구조 쟁점은 ${aToken}와 ${bToken}가 실제 돈으로 남는지다`,
        `${aToken}와 ${bToken}가 비면 차트 얘기도 오늘은 보류해야 한다`,
      ],
    },
  };

  if (
    /[가-힣]/.test(normalized) &&
    !/[A-Za-z]{5,}/.test(normalized) &&
    normalized.length <= 48 &&
    !/(살핀다|짚는다|가른다|장면|흐름이 있는지|뒤에|바깥|화면에)/.test(normalized)
  ) {
    return normalized;
  }

  const pool = directByLane[eventPlan.lane][variant];
  return pool[stableSeedForPrelude(`${normalized}|${variant}|${aToken}|${bToken}`) % pool.length];
}

function buildPixymonConceptLine(
  eventPlan: { lane: TrendLane },
  variant: "hard" | "rescue" | "emergency"
): string {
  const seed = stableSeedForPrelude(`${eventPlan.lane}|${variant}|concept`);
  const byLane: Record<TrendLane, string[]> = {
    protocol: [
      "발표만으로는 판단하지 않는다. 운영 흔적이 남아야 장부에 남긴다.",
      "업그레이드 얘기는 실제 반응이 붙을 때만 장부에 올린다.",
    ],
    ecosystem: [
      "사람이 남지 않으면 좋은 서사도 장부에 남기지 않는다.",
      "돌아오는 사용자가 없으면 그 이야기는 아직 장부에 올릴 수 없다.",
    ],
    regulation: [
      "정책 문장보다 집행 흔적을 먼저 보고, 그때만 장부에 남긴다.",
      "말이 세도 행동이 안 붙으면 오늘 판단은 장부에 올리지 않는다.",
    ],
    macro: [
      "큰 뉴스만으로 결론 내리지 않는다. 자금 습관이 바뀔 때만 장부에 남긴다.",
      "거시 바람이 커도 체인 안쪽 버릇이 안 바뀌면 오늘 판단은 장부에 넣지 않는다.",
    ],
    onchain: [
      "체인에 남은 흔적이 하루를 버틸 때만 장부에 남긴다.",
      "온체인 신호도 오래 남지 않으면 오늘 결론에 넣지 않는다.",
    ],
    "market-structure": [
      "뜨거운 화면보다 실제 체결을 더 늦게 믿고, 그때만 장부에 남긴다.",
      "돈이 실제로 붙지 않으면 오늘 판단 근거로 올리지 않는다.",
    ],
  };
  return byLane[eventPlan.lane][seed % byLane[eventPlan.lane].length];
}

function buildPixymonObservationLine(
  eventPlan: { lane: TrendLane },
  variant: "hard" | "rescue" | "emergency"
): string {
  const seed = stableSeedForPrelude(`${eventPlan.lane}|${variant}|observation`);
  const byLane: Record<TrendLane, string[]> = {
    protocol: [
      "지금은 발표보다 운영 반응이 남는지 본다.",
      "설명보다 운영 흔적이 버티는지 확인한다.",
    ],
    ecosystem: [
      "지금은 사람들이 실제로 다시 돌아오는지 본다.",
      "말보다 사용 흔적이 남는지 확인한다.",
    ],
    regulation: [
      "지금은 규제 문장보다 실제 반응이 붙는지 본다.",
      "말보다 집행 흔적이 남는지 확인한다.",
    ],
    macro: [
      "지금은 큰 뉴스보다 체인 안쪽 자금 성격이 바뀌는지 본다.",
      "숫자보다 여파가 어디까지 닿는지 확인한다.",
    ],
    onchain: [
      "지금은 체인 안쪽 흔적이 이어지는지 본다.",
      "주소 흐름이 금방 끊기는지 확인한다.",
    ],
    "market-structure": [
      "지금은 차트보다 실제 돈이 남는지 본다.",
      "분위기보다 체결이 버티는지 확인한다.",
    ],
  };
  return byLane[eventPlan.lane][seed % byLane[eventPlan.lane].length];
}

function buildPixymonEvidenceLine(
  eventPlan: {
    lane: TrendLane;
    evidence: Array<{ label: string; value: string }>;
  },
  variant: "hard" | "rescue" | "emergency"
): string {
  const [a, b] = eventPlan.evidence.slice(0, 2);
  const aToken = formatEvidenceToken(a?.label || "", a?.value || "", 22) || "첫 단서";
  const bToken = formatEvidenceToken(b?.label || "", b?.value || "", 22) || "둘째 단서";
  const seed = stableSeedForPrelude(`${eventPlan.lane}|${variant}|${aToken}|${bToken}|evidence`);
  const pool = [
    `근거는 ${aToken}와 ${bToken}다.`,
    `지금 확인할 건 ${aToken}와 ${bToken}다.`,
    `근거는 ${aToken}와 ${bToken}다.`,
    `판단은 ${aToken}와 ${bToken}가 함께 버티는지에 달렸다.`,
    `${aToken}와 ${bToken}가 같은 방향으로 남는지 확인한다.`,
  ];
  return pool[seed % pool.length];
}

function buildPixymonDecisionLine(
  eventPlan: { lane: TrendLane },
  variant: "hard" | "rescue" | "emergency"
): string {
  const seed = stableSeedForPrelude(`${eventPlan.lane}|${variant}|decision`);
  const byLane: Record<TrendLane, string[]> = {
    protocol: [
      "운영이 먼저 흔들리면 이 해석은 버린다.",
      "운영 흔적이 못 버티면 오늘 결론은 보류한다.",
    ],
    ecosystem: [
      "사람이 안 남으면 이 해석은 버린다.",
      "돌아오는 사용자가 없으면 오늘 결론은 보류한다.",
    ],
    regulation: [
      "집행이 안 붙으면 이 해석은 버린다.",
      "행동으로 안 번지면 오늘 결론은 미룬다.",
    ],
    macro: [
      "체인 안쪽으로 안 내려오면 이 해석은 버린다.",
      "뉴스만 크고 흔적이 안 남으면 오늘 결론은 미룬다.",
    ],
    onchain: [
      "흔적이 바로 식으면 이 해석은 버린다.",
      "주소 움직임이 끊기면 오늘 결론은 보류한다.",
    ],
    "market-structure": [
      "실제 돈이 안 남으면 이 해석은 버린다.",
      "체결이 비면 오늘 판단에서 뺀다.",
    ],
  };
  return byLane[eventPlan.lane][seed % byLane[eventPlan.lane].length];
}

function buildIdentityFallbackPost(
  eventPlan: {
    lane: TrendLane;
    event: { id?: string; headline: string };
    evidence: Array<{ label: string; value: string }>;
  },
  variant: "hard" | "rescue" | "emergency",
  maxChars: number,
  variantIndex: number = 0
): string {
  const [a, b] = eventPlan.evidence.slice(0, 2);
  if (!a || !b) return "";
  const modeByVariant = {
    hard: "identity-journal",
    rescue: "meta-reflection",
    emergency: "philosophy-note",
  } as const;
  const worldviewByLane: Record<TrendLane, string> = {
    protocol: "신뢰는 발표보다 운영 기록에서 늦게 쌓인다",
    ecosystem: "사람이 남지 않으면 큰 서사도 금방 광고가 된다",
    regulation: "정책 문장보다 집행 흔적이 더 늦고 정확하다",
    macro: "큰 뉴스보다 자금 배치가 더 오래 진실을 끌고 간다",
    onchain: "온체인 숫자는 오래 남을 때만 단서가 된다",
    "market-structure": "화면 열기보다 실제 체결이 더 늦고 정확하다",
  };
  const signatureByLane: Record<TrendLane, string> = {
    protocol: "박수보다 복구 속도를 오래 본다",
    ecosystem: "재방문이 없는 열기는 오래 믿지 않는다",
    regulation: "기사보다 행동 편에 더 오래 남는다",
    macro: "해설보다 자금 습관 쪽을 더 늦게 믿는다",
    onchain: "하루도 못 버틴 숫자는 장식으로 본다",
    "market-structure": "돈이 안 붙은 자신감은 제일 먼저 버린다",
  };
    return buildKoIdentityWriterCandidate({
      headline: buildPixymonSceneHeadline(eventPlan, variant),
      primaryAnchor: formatEvidenceToken(a.label, a.value, 24) || a.label,
      secondaryAnchor: formatEvidenceToken(b.label, b.value, 24) || b.label,
    lane: eventPlan.lane,
    mode: modeByVariant[variant],
      worldviewHint: worldviewByLane[eventPlan.lane],
      signatureBelief: signatureByLane[eventPlan.lane],
      recentReflection: worldviewByLane[eventPlan.lane],
      maxChars,
      seedHint: `${eventPlan.event.id || "event"}|${variant}|live-identity-fallback|${variantIndex}`,
    }, variantIndex);
}

function buildHardContractPost(
  eventPlan: {
    lane: TrendLane;
    event: { headline: string };
    evidence: Array<{ label: string; value: string }>;
  },
  language: "ko" | "en",
  maxChars: number,
  variantIndex: number = 0
): string {
  const [a, b] = eventPlan.evidence.slice(0, 2);
  if (!a || !b) return "";

  const aToken = formatEvidenceToken(a.label, a.value, 26);
  const bToken = formatEvidenceToken(b.label, b.value, 26);
  const headline = language === "ko"
    ? buildPixymonSceneHeadline(eventPlan, "hard")
    : sanitizeTweetText(eventPlan.event.headline).replace(/\.$/, "");

  if (language === "ko") {
    return finalizeGeneratedText(buildIdentityFallbackPost(eventPlan, "hard", maxChars, variantIndex), language, maxChars);
  }

  if (language === "en") {
    const laneLead: Record<TrendLane, string> = {
      protocol: "I start from the protocol side.",
      ecosystem: "I start from the ecosystem side.",
      regulation: "I start from the regulation side.",
      macro: "I start from the macro side.",
      onchain: "I start from the onchain side.",
      "market-structure": "I start from market structure.",
    };
    const base = `${laneLead[eventPlan.lane]} ${headline}. I keep ${aToken} and ${bToken} on the same screen. I verify reaction order first, and I drop this read if the path diverges.`;
    return finalizeGeneratedText(base, language, maxChars);
  }

  const seed = stableSeedForPrelude(`${headline}|${aToken}|${bToken}|hard|${eventPlan.lane}|${variantIndex}`);
  const conceptLine = buildPixymonConceptLine(eventPlan, "hard");
  const repeatsAnchorsInHeadline =
    [aToken, bToken].filter((token) => token.length >= 4 && headline.includes(token)).length >= 2;
  const evidenceLine = repeatsAnchorsInHeadline
    ? buildPixymonObservationLine(eventPlan, "hard")
    : buildPixymonEvidenceLine(eventPlan, "hard");
  const decisionLine = buildPixymonDecisionLine(eventPlan, "hard");
  const pool = [
    `${headline}.\n\n${conceptLine}\n\n${evidenceLine} ${decisionLine}`,
    `${headline}.\n\n${conceptLine}\n\n${evidenceLine} ${decisionLine}`,
    `${headline}.\n\n${evidenceLine}\n\n${conceptLine} ${decisionLine}`,
  ];
  return finalizeGeneratedText(pool[seed % pool.length], language, maxChars);
}

function buildRescueContractPost(
  eventPlan: {
    lane: TrendLane;
    event: { headline: string };
    evidence: Array<{ label: string; value: string }>;
  },
  language: "ko" | "en",
  maxChars: number,
  variantIndex: number = 0
): string {
  const [a, b] = eventPlan.evidence.slice(0, 2);
  if (!a || !b) return "";

  const aToken = formatEvidenceToken(a.label, a.value, 24);
  const bToken = formatEvidenceToken(b.label, b.value, 24);
  const headline = language === "ko"
    ? buildPixymonSceneHeadline(eventPlan, "rescue")
    : sanitizeTweetText(eventPlan.event.headline).replace(/\.$/, "");

  if (language === "ko") {
    return finalizeGeneratedText(buildIdentityFallbackPost(eventPlan, "rescue", maxChars, variantIndex), language, maxChars);
  }

  if (language === "en") {
    const laneLead: Record<TrendLane, string> = {
      protocol: "From the protocol side,",
      ecosystem: "From the ecosystem side,",
      regulation: "From the regulation side,",
      macro: "From the macro side,",
      onchain: "From the onchain side,",
      "market-structure": "From market structure,",
    };
    const base = `${laneLead[eventPlan.lane]} ${headline}. I put ${aToken} and ${bToken} on the same line first. I check which side moves first, and I drop this read if the flow diverges.`;
    return finalizeGeneratedText(base, language, maxChars);
  }

  const seed = stableSeedForPrelude(`${headline}|${aToken}|${bToken}|rescue|${eventPlan.lane}|${variantIndex}`);
  const conceptLine = buildPixymonConceptLine(eventPlan, "rescue");
  const repeatsAnchorsInHeadline =
    [aToken, bToken].filter((token) => token.length >= 4 && headline.includes(token)).length >= 2;
  const evidenceLine = repeatsAnchorsInHeadline
    ? buildPixymonObservationLine(eventPlan, "rescue")
    : buildPixymonEvidenceLine(eventPlan, "rescue");
  const decisionLine = buildPixymonDecisionLine(eventPlan, "rescue");
  const pool = [
    `${headline}.\n\n${conceptLine}\n\n${evidenceLine} ${decisionLine}`,
    `${headline}.\n\n${conceptLine}\n\n${evidenceLine} ${decisionLine}`,
    `${headline}.\n\n${conceptLine}\n\n${evidenceLine} ${decisionLine}`,
  ];
  return finalizeGeneratedText(pool[seed % pool.length], language, maxChars);
}

function buildEmergencyContractPost(
  eventPlan: {
    lane: TrendLane;
    event: { headline: string };
    evidence: Array<{ label: string; value: string }>;
  },
  language: "ko" | "en",
  maxChars: number,
  variantIndex: number = 0
): string {
  const [a, b] = eventPlan.evidence.slice(0, 2);
  if (!a || !b) return "";

  const aToken = formatEvidenceToken(a.label, a.value, 22);
  const bToken = formatEvidenceToken(b.label, b.value, 22);
  const headline = language === "ko"
    ? buildPixymonSceneHeadline(eventPlan, "emergency")
    : sanitizeTweetText(eventPlan.event.headline).replace(/\.$/, "");

  if (language === "ko") {
    return finalizeGeneratedText(buildIdentityFallbackPost(eventPlan, "emergency", maxChars, variantIndex), language, maxChars);
  }

  if (language === "en") {
    const base = `${headline}. I keep ${aToken} and ${bToken} together first. I check reaction order, and I drop this read if the path breaks.`;
    return finalizeGeneratedText(base, language, maxChars);
  }

  const seed = stableSeedForPrelude(`${headline}|${aToken}|${bToken}|${eventPlan.lane}|${variantIndex}`);
  const conceptLine = buildPixymonConceptLine(eventPlan, "emergency");
  const repeatsAnchorsInHeadline =
    [aToken, bToken].filter((token) => token.length >= 4 && headline.includes(token)).length >= 2;
  const evidenceLine = repeatsAnchorsInHeadline
    ? buildPixymonObservationLine(eventPlan, "emergency")
    : buildPixymonEvidenceLine(eventPlan, "emergency");
  const decisionLine = buildPixymonDecisionLine(eventPlan, "emergency");
  const pool = [
    `${headline}.\n\n${conceptLine}\n\n${evidenceLine} ${decisionLine}`,
    `${headline}.\n\n${conceptLine}\n\n${evidenceLine} ${decisionLine}`,
    `${headline}.\n\n${evidenceLine}\n\n${conceptLine} ${decisionLine}`,
    `${headline}.\n\n${conceptLine}\n\n${evidenceLine} ${decisionLine}`,
  ];
  return finalizeGeneratedText(pool[seed % pool.length], language, maxChars);
}

interface PostDiversityGuard {
  avoidBtcOnly: boolean;
  btcRatioPercent: number;
  altTokens: string[];
  ruleLineKo: string;
  ruleLineEn: string;
}

type PostFallbackKind = "none" | "deterministic" | "hard" | "rescue" | "emergency";

function isStrongOnchainStructuralPlan(plan: EventEvidencePlan): boolean {
  if (plan.event.source !== "evidence:structural-fallback" || plan.lane !== "onchain") {
    return false;
  }
  if (!plan.hasOnchainEvidence || plan.evidence.length < 2) {
    return false;
  }
  const genericLabels = [
    "시장 반응",
    "규제 일정",
    "현장 반응",
    "체인 안쪽 사용",
    "커뮤니티 반응",
    "대기 자금 흐름",
    "자금 쏠림 방향",
    "집행 흔적",
  ];
  const weakValuePatterns = [/24h/i, /24시간/, /변동/, /도미넌스/, /공포/, /탐욕/, /시총/, /sat\/vB/i];
  return plan.evidence.every((item: EventEvidencePlan["evidence"][number]) => {
    const label = String(item.label || "").trim();
    const combined = `${label} ${String(item.value || "").trim()}`;
    return (
      !genericLabels.some((token) => label.includes(token)) &&
      !weakValuePatterns.some((pattern) => pattern.test(combined))
    );
  });
}

function selectBestFallbackVariant(
  candidates: string[],
  recentPosts: NarrativeRecentPost[],
  narrativePlan: NarrativePlan,
  language: "ko" | "en",
  maxChars: number,
  deconflictSeed: string
): string | null {
  if (candidates.length === 0) return null;
  const recentContents = recentPosts.map((post) => post.content);
  let best: { text: string; score: number } | null = null;

  for (let index = 0; index < candidates.length; index += 1) {
    const raw = String(candidates[index] || "").trim();
    if (!raw) continue;
    const text = deconflictOpening(raw, recentContents, language, maxChars, `${deconflictSeed}|${index}`);
    const surfaceIssue = detectNarrativeSurfaceIssue(text, language);
    const novelty = validateNarrativeNovelty(text, recentPosts, narrativePlan);
    const normalized = sanitizeTweetText(text).toLowerCase();
    const openingKey = normalized.slice(0, 28);
    const endingKey = normalized.slice(-28);
    const openingRepeats = recentPosts
      .slice(-12)
      .filter((post) => sanitizeTweetText(post.content).toLowerCase().slice(0, 28) === openingKey).length;
    const endingRepeats = recentPosts
      .slice(-12)
      .filter((post) => sanitizeTweetText(post.content).toLowerCase().slice(-28) === endingKey).length;
    const score =
      novelty.score -
      (surfaceIssue ? 0.45 : 0) -
      openingRepeats * 0.14 -
      endingRepeats * 0.1 -
      (startsWithFearGreedTemplate(text) ? 0.5 : 0);

    if (!best || score > best.score) {
      best = { text, score };
    }
  }

  if (!best || best.score < 0.3) {
    return null;
  }

  return best.text;
}

function allowLiveFallbackPublish(kind: PostFallbackKind, allowFallbackAutoPublish: boolean): boolean {
  if (kind === "none") return true;
  if (allowFallbackAutoPublish) return true;
  return kind === "deterministic";
}

function evaluatePlannerPublishReadiness(
  plan: EventEvidencePlan,
  recentThreads: Array<{ lane: TrendLane; focus?: string }>
): { allow: boolean; reason?: string } {
  const warnings = new Set(plan.plannerWarnings || []);
  const sameFocusRepeats = recentThreads.filter(
    (item) => item.lane === plan.lane && (item.focus || "general") === plan.focus
  ).length;
  if (plan.focus === "general") warnings.add("focus-general");
  if (plan.plannerScore < 0.7) warnings.add("score-thin");
  if (sameFocusRepeats >= 2) warnings.add("focus-saturated");
  if (warnings.has("scene-repeat") && plan.plannerScore < 0.9) {
    return { allow: false, reason: "scene-repeat" };
  }
  if (warnings.has("focus-general")) return { allow: false, reason: "focus-general" };
  if (warnings.has("generic-evidence")) return { allow: false, reason: "generic-evidence" };
  if (warnings.has("semantic-mismatch")) return { allow: false, reason: "semantic-mismatch" };
  if (warnings.has("score-thin")) return { allow: false, reason: "planner-score-thin" };
  if (warnings.has("focus-saturated")) return { allow: false, reason: "focus-saturated" };
  if (
    warnings.has("structural-fallback") &&
    plan.lane !== "onchain" &&
    plan.plannerScore < 0.9
  ) {
    return { allow: false, reason: "structural-fallback-thin" };
  }
  return { allow: true };
}

function evaluateFallbackPublishReadiness(
  plan: EventEvidencePlan,
  kind: PostFallbackKind,
  usedFallback: boolean
): { allow: boolean; reason?: string } {
  if (!usedFallback || kind === "none") return { allow: true };
  const warningSet = new Set(plan.plannerWarnings || []);
  if (plan.focus === "general") return { allow: false, reason: "fallback-on-general-focus" };
  if (warningSet.has("generic-evidence")) return { allow: false, reason: "fallback-on-generic-evidence" };
  if (warningSet.has("semantic-mismatch")) return { allow: false, reason: "fallback-on-semantic-mismatch" };
  if (warningSet.has("scene-repeat") && plan.plannerScore < 0.96) {
    return { allow: false, reason: "fallback-on-scene-repeat" };
  }
  if (kind !== "deterministic") return { allow: false, reason: `fallback-kind-${kind}` };
  if (warningSet.has("structural-fallback") && plan.plannerScore < 0.96) {
    return { allow: false, reason: "fallback-on-thin-structural-plan" };
  }
  if (plan.plannerScore < 0.86) return { allow: false, reason: "fallback-on-thin-plan" };
  return { allow: true };
}

function buildPostDiversityGuard(
  recentPosts: Array<{ content: string }>,
  marketData: Array<{ symbol: string }>,
  focusTokens: string[],
  focusHeadline: string
): PostDiversityGuard {
  const recentTexts = recentPosts
    .slice(-6)
    .map((post) => sanitizeTweetText(post.content).toLowerCase())
    .filter(Boolean);
  const btcCount = recentTexts.filter((text) => isBtcCentricText(text)).length;
  const btcRatio = recentTexts.length > 0 ? btcCount / recentTexts.length : 0;

  const altSymbols = marketData
    .map((coin) => String(coin.symbol || "").trim().toUpperCase())
    .filter((symbol) => symbol.length >= 2 && symbol !== "BTC");
  const focusNonBtcTokens = (focusTokens || [])
    .map((token) => String(token || "").trim())
    .filter((token) => token.length >= 2 && !isBtcCentricText(token));
  const headlineToken = sanitizeTweetText(focusHeadline || "")
    .toLowerCase()
    .split(/\s+/)
    .find((token) => token.length >= 3 && !isBtcCentricText(token));

  const altTokens = [
    ...new Set([
      ...altSymbols.map((symbol) => `$${symbol}`),
      ...focusNonBtcTokens,
      ...(headlineToken ? [headlineToken] : []),
    ]),
  ].slice(0, 8);

  const avoidBtcOnly = recentTexts.length >= 3 && btcRatio >= 0.67 && altTokens.length > 0;
  if (!avoidBtcOnly) {
    return {
      avoidBtcOnly: false,
      btcRatioPercent: Math.round(btcRatio * 100),
      altTokens,
      ruleLineKo: "가능하면 BTC 외 시그널(알트/뉴스/매크로)도 함께 반영",
      ruleLineEn: "Prefer including at least one non-BTC signal when possible",
    };
  }

  const altHint = altTokens.slice(0, 4).join(", ");
  return {
    avoidBtcOnly: true,
    btcRatioPercent: Math.round(btcRatio * 100),
    altTokens,
    ruleLineKo: `최근 BTC 편중이 높음. BTC 단독 서사를 피하고 ${altHint} 중 1개 이상 반영`,
    ruleLineEn: `BTC-only framing is overused. Include at least one of: ${altHint}`,
  };
}

function isBtcOnlyNarrative(text: string, altTokens: string[]): boolean {
  const normalized = sanitizeTweetText(text).toLowerCase();
  if (!isBtcCentricText(normalized)) return false;
  const hasAlt = altTokens.some((token) => {
    const t = String(token || "").trim().toLowerCase();
    if (!t) return false;
    if (normalized.includes(t)) return true;
    if (t.startsWith("$") && normalized.includes(t.slice(1))) return true;
    return false;
  });
  return !hasAlt;
}

function isBtcCentricText(text: string): boolean {
  const lower = sanitizeTweetText(text).toLowerCase();
  return /(^|\s)(\$?btc|bitcoin|비트코인)(\s|$)|fear\s*greed|fgi|공포\s*지수|극공포/.test(lower);
}

function startsWithFearGreedTemplate(text: string): boolean {
  const lower = sanitizeTweetText(text).toLowerCase();
  return /^(극공포|공포\s*지수|fear\s*greed|fgi)/.test(lower);
}

function extractFocusTokens(text: string): string[] {
  const normalized = sanitizeTweetText(text).toLowerCase();
  const words = normalized
    .split(/\s+/)
    .map((item) => item.replace(/[^a-z0-9$가-힣]/g, ""))
    .filter((item) => item.length >= 3)
    .filter((item) => !["this", "that", "with", "from", "about", "그리고", "하지만", "오늘", "지금"].includes(item));
  return [...new Set(words)].slice(0, 6);
}

function inferTrendLaneFromText(text: string): TrendLane {
  const normalized = sanitizeTweetText(text).toLowerCase();
  if (/sec|etf|법안|regulation|regulator|규제|정책/.test(normalized)) return "regulation";
  if (/fomc|cpi|dxy|금리|달러|macro|거시/.test(normalized)) return "macro";
  if (/mempool|whale|stable|onchain|수수료|네트워크|온체인/.test(normalized)) return "onchain";
  if (/layer|upgrade|testnet|mainnet|rollup|protocol|업그레이드/.test(normalized)) return "protocol";
  if (/dex|tvl|ecosystem|airdrop|staking|ecosystem|생태계/.test(normalized)) return "ecosystem";
  return "market-structure";
}

function resolveEngagementSettings(
  settings: Partial<EngagementRuntimeSettings> = {}
): EngagementRuntimeSettings {
  return {
    postGenerationMaxAttempts: clampInt(
      settings.postGenerationMaxAttempts,
      1,
      4,
      DEFAULT_ENGAGEMENT_SETTINGS.postGenerationMaxAttempts
    ),
    postMaxChars: clampInt(settings.postMaxChars, 120, 280, DEFAULT_ENGAGEMENT_SETTINGS.postMaxChars),
    postMinLength: clampInt(settings.postMinLength, 10, 120, DEFAULT_ENGAGEMENT_SETTINGS.postMinLength),
    allowFallbackAutoPublish:
      typeof settings.allowFallbackAutoPublish === "boolean"
        ? settings.allowFallbackAutoPublish
        : DEFAULT_ENGAGEMENT_SETTINGS.allowFallbackAutoPublish,
    postMinIntervalMinutes: clampInt(
      settings.postMinIntervalMinutes,
      0,
      360,
      DEFAULT_ENGAGEMENT_SETTINGS.postMinIntervalMinutes
    ),
    maxPostsPerCycle: clampInt(
      settings.maxPostsPerCycle,
      0,
      4,
      DEFAULT_ENGAGEMENT_SETTINGS.maxPostsPerCycle
    ),
    nutrientMinDigestScore: clampNumber(
      settings.nutrientMinDigestScore,
      0.2,
      0.95,
      DEFAULT_ENGAGEMENT_SETTINGS.nutrientMinDigestScore
    ),
    nutrientMaxIntakePerCycle: clampInt(
      settings.nutrientMaxIntakePerCycle,
      3,
      40,
      DEFAULT_ENGAGEMENT_SETTINGS.nutrientMaxIntakePerCycle
    ),
    sentimentMaxRatio24h: clampNumber(
      settings.sentimentMaxRatio24h,
      0.05,
      1,
      DEFAULT_ENGAGEMENT_SETTINGS.sentimentMaxRatio24h
    ),
    postLanguage:
      settings.postLanguage === "en" || settings.postLanguage === "ko"
        ? settings.postLanguage
        : DEFAULT_ENGAGEMENT_SETTINGS.postLanguage,
    replyLanguageMode:
      settings.replyLanguageMode === "match" || settings.replyLanguageMode === "en" || settings.replyLanguageMode === "ko"
        ? settings.replyLanguageMode
        : DEFAULT_ENGAGEMENT_SETTINGS.replyLanguageMode,
    requireOnchainEvidence:
      typeof settings.requireOnchainEvidence === "boolean"
        ? settings.requireOnchainEvidence
        : DEFAULT_ENGAGEMENT_SETTINGS.requireOnchainEvidence,
    requireCrossSourceEvidence:
      typeof settings.requireCrossSourceEvidence === "boolean"
        ? settings.requireCrossSourceEvidence
        : DEFAULT_ENGAGEMENT_SETTINGS.requireCrossSourceEvidence,
    enforceKoreanPosts:
      typeof settings.enforceKoreanPosts === "boolean"
        ? settings.enforceKoreanPosts
        : DEFAULT_ENGAGEMENT_SETTINGS.enforceKoreanPosts,
    autonomyMaxBudgetUtilization: clampNumber(
      settings.autonomyMaxBudgetUtilization,
      0.5,
      0.99,
      DEFAULT_ENGAGEMENT_SETTINGS.autonomyMaxBudgetUtilization
    ),
    autonomyRiskBlockScore: clampInt(
      settings.autonomyRiskBlockScore,
      4,
      10,
      DEFAULT_ENGAGEMENT_SETTINGS.autonomyRiskBlockScore
    ),
    minNewsSourceTrust: clampNumber(
      settings.minNewsSourceTrust,
      0.05,
      0.9,
      DEFAULT_ENGAGEMENT_SETTINGS.minNewsSourceTrust
    ),
    minTrendTweetSourceTrust: clampNumber(
      settings.minTrendTweetSourceTrust,
      0.05,
      0.9,
      DEFAULT_ENGAGEMENT_SETTINGS.minTrendTweetSourceTrust
    ),
    minTrendTweetScore: clampNumber(
      settings.minTrendTweetScore,
      0.5,
      12,
      DEFAULT_ENGAGEMENT_SETTINGS.minTrendTweetScore
    ),
    minTrendTweetEngagement: clampInt(
      settings.minTrendTweetEngagement,
      1,
      200,
      DEFAULT_ENGAGEMENT_SETTINGS.minTrendTweetEngagement
    ),
    trendTweetMaxAgeHours: clampInt(
      settings.trendTweetMaxAgeHours,
      1,
      168,
      DEFAULT_ENGAGEMENT_SETTINGS.trendTweetMaxAgeHours
    ),
    trendTweetRequireRootPost:
      typeof settings.trendTweetRequireRootPost === "boolean"
        ? settings.trendTweetRequireRootPost
        : DEFAULT_ENGAGEMENT_SETTINGS.trendTweetRequireRootPost,
    trendTweetBlockSuspiciousPromo:
      typeof settings.trendTweetBlockSuspiciousPromo === "boolean"
        ? settings.trendTweetBlockSuspiciousPromo
        : DEFAULT_ENGAGEMENT_SETTINGS.trendTweetBlockSuspiciousPromo,
    topicMaxSameTag24h: clampInt(
      settings.topicMaxSameTag24h,
      1,
      8,
      DEFAULT_ENGAGEMENT_SETTINGS.topicMaxSameTag24h
    ),
    topicBlockConsecutiveTag:
      typeof settings.topicBlockConsecutiveTag === "boolean"
        ? settings.topicBlockConsecutiveTag
        : DEFAULT_ENGAGEMENT_SETTINGS.topicBlockConsecutiveTag,
  };
}

function resolveXApiCostSettings(
  settings: Partial<XApiCostRuntimeSettings> = {}
): XApiCostRuntimeSettings {
  return {
    enabled:
      typeof settings.enabled === "boolean"
        ? settings.enabled
        : DEFAULT_X_API_COST_SETTINGS.enabled,
    dailyMaxUsd: clampNumber(
      settings.dailyMaxUsd,
      0.01,
      100,
      DEFAULT_X_API_COST_SETTINGS.dailyMaxUsd
    ),
    estimatedReadCostUsd: clampNumber(
      settings.estimatedReadCostUsd,
      0.001,
      10,
      DEFAULT_X_API_COST_SETTINGS.estimatedReadCostUsd
    ),
    estimatedCreateCostUsd: clampNumber(
      settings.estimatedCreateCostUsd,
      0.001,
      10,
      DEFAULT_X_API_COST_SETTINGS.estimatedCreateCostUsd
    ),
    dailyReadRequestLimit: clampInt(
      settings.dailyReadRequestLimit,
      1,
      1000,
      DEFAULT_X_API_COST_SETTINGS.dailyReadRequestLimit
    ),
    dailyCreateRequestLimit: clampInt(
      settings.dailyCreateRequestLimit,
      1,
      1000,
      DEFAULT_X_API_COST_SETTINGS.dailyCreateRequestLimit
    ),
    mentionReadMinIntervalMinutes: clampInt(
      settings.mentionReadMinIntervalMinutes,
      0,
      1440,
      DEFAULT_X_API_COST_SETTINGS.mentionReadMinIntervalMinutes
    ),
    trendReadMinIntervalMinutes: clampInt(
      settings.trendReadMinIntervalMinutes,
      0,
      1440,
      DEFAULT_X_API_COST_SETTINGS.trendReadMinIntervalMinutes
    ),
    createMinIntervalMinutes: clampInt(
      settings.createMinIntervalMinutes,
      0,
      1440,
      DEFAULT_X_API_COST_SETTINGS.createMinIntervalMinutes
    ),
    failClosedOnStateError:
      typeof settings.failClosedOnStateError === "boolean"
        ? settings.failClosedOnStateError
        : DEFAULT_X_API_COST_SETTINGS.failClosedOnStateError,
  };
}

function formatReadBlockReason(reason: XReadGuardBlockReason | undefined, waitSeconds?: number): string {
  if (reason === "min-interval") {
    const seconds = Math.max(1, Math.floor(waitSeconds || 0));
    return `최소 조회 간격 제한 (${seconds}초 후 재시도)`;
  }
  if (reason === "daily-request-limit") {
    return "일일 요청 한도 도달";
  }
  if (reason === "daily-usd-limit") {
    return "일일 예상 비용 한도 도달";
  }
  if (reason === "state-unavailable") {
    return "공용 budget state 불가(호출 차단)";
  }
  return "비용 가드 정책";
}

function resolveObservabilitySettings(
  settings: Partial<ObservabilityRuntimeSettings> = {}
): ObservabilityRuntimeSettings {
  return {
    enabled:
      typeof settings.enabled === "boolean"
        ? settings.enabled
        : DEFAULT_OBSERVABILITY_SETTINGS.enabled,
    stdoutJson:
      typeof settings.stdoutJson === "boolean"
        ? settings.stdoutJson
        : DEFAULT_OBSERVABILITY_SETTINGS.stdoutJson,
    eventLogPath:
      typeof settings.eventLogPath === "string" && settings.eventLogPath.trim().length > 0
        ? settings.eventLogPath.trim()
        : DEFAULT_OBSERVABILITY_SETTINGS.eventLogPath,
  };
}

function resolveLlmBatchSettings(
  settings: Partial<LlmBatchRuntimeSettings> = {}
): LlmBatchRuntimeSettings {
  return {
    enabled:
      typeof settings.enabled === "boolean"
        ? settings.enabled
        : DEFAULT_LLM_BATCH_SETTINGS.enabled,
    maxRequestsPerBatch: clampInt(
      settings.maxRequestsPerBatch,
      1,
      100,
      DEFAULT_LLM_BATCH_SETTINGS.maxRequestsPerBatch
    ),
    maxSyncBatchesPerRun: clampInt(
      settings.maxSyncBatchesPerRun,
      1,
      50,
      DEFAULT_LLM_BATCH_SETTINGS.maxSyncBatchesPerRun
    ),
    minSyncMinutes: clampInt(
      settings.minSyncMinutes,
      1,
      1440,
      DEFAULT_LLM_BATCH_SETTINGS.minSyncMinutes
    ),
  };
}

function resolveReplyLanguage(
  mode: EngagementRuntimeSettings["replyLanguageMode"],
  detected: ContentLanguage
): ContentLanguage {
  if (mode === "en" || mode === "ko") {
    return mode;
  }
  return detected;
}

function resolveRecentLaneUsageWindow(
  recentBriefingPosts: Array<{ content: string; timestamp: string }>
): LaneUsageWindow {
  const fromText = computeLaneUsageWindow(recentBriefingPosts);
  const fromMetaRows = memory.getRecentBriefingLaneUsage(24);
  const byLane: Record<TrendLane, number> = {
    protocol: fromText.byLane.protocol,
    ecosystem: fromText.byLane.ecosystem,
    regulation: fromText.byLane.regulation,
    macro: fromText.byLane.macro,
    onchain: fromText.byLane.onchain,
    "market-structure": fromText.byLane["market-structure"],
  };
  fromMetaRows.forEach((row) => {
    if (typeof row.count === "number" && Number.isFinite(row.count) && row.count >= 0) {
      byLane[row.lane] = Math.max(byLane[row.lane], row.count);
    }
  });
  return {
    totalPosts: recentBriefingPosts.length,
    byLane,
  };
}

function getMinutesSince(isoTimestamp: string): number {
  const ts = new Date(isoTimestamp).getTime();
  if (!Number.isFinite(ts)) return -1;
  return Math.floor((Date.now() - ts) / (1000 * 60));
}

function isWithinHours(isoTimestamp: string, hours: number): boolean {
  const ts = new Date(isoTimestamp).getTime();
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts <= hours * 60 * 60 * 1000;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, value));
}
