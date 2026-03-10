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
  computeLaneUsageWindow,
  planEventEvidenceAct,
  validateEventEvidenceContract,
} from "./engagement/event-evidence.js";
import {
  buildAdaptivePolicy,
  clamp,
  getDefaultAdaptivePolicy,
  normalizeDailyTarget,
  randomInt,
  toReasonCode,
} from "./engagement/policy.js";
import {
  enforceActionAndInvalidation,
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
  AdaptivePolicy,
  CycleCacheMetrics,
  DailyQuotaOptions,
  LaneUsageWindow,
  TrendContext,
} from "./engagement/types.js";
import { OnchainNutrient, TrendLane } from "../types/agent.js";
import { emitCycleObservability } from "./observability.js";
import { XReadGuardBlockReason, xApiBudget } from "./x-api-budget.js";
import {
  buildNarrativePlan,
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

  const sourceTrustUpdates: Array<{ sourceKey: string; delta: number; reason: string; fallback?: number }> = [];

  try {
    const trend = await getOrCreateTrendContext(cache, {
      minNewsSourceTrust: runtimeSettings.minNewsSourceTrust,
    });
    const runContext = getOrCreateRunContext(cache, trend, recentReflectionHint);

    const candidates = await getOrSearchTrendTweets(
      twitter,
      trend.keywords,
      Math.max(24, goal * 10),
      {
        minSourceTrust: runtimeSettings.minTrendTweetSourceTrust,
        minScore: runtimeSettings.minTrendTweetScore,
        minEngagement: runtimeSettings.minTrendTweetEngagement,
      },
      timezone,
      xApiCostSettings,
      cache
    );

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
        memory.saveRepliedTweet(tweet.id);
        memory.saveTweet(`engage_test_${Date.now()}`, replyText, "reply");
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
    const eventPlan = planEventEvidenceAct({
      events: trend.events,
      evidence: buildOnchainEvidence([...feedNutrients, ...trend.nutrients], 16),
      recentPosts: recentBriefingPosts,
      laneUsage: laneUsageWindow,
      requireOnchainEvidence: runtimeSettings.requireOnchainEvidence,
      requireCrossSourceEvidence: runtimeSettings.requireCrossSourceEvidence,
    });
    if (eventPlan) {
      soulIntent = memory.getSoulIntentPlan(runtimeSettings.postLanguage, eventPlan.lane);
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
          recentPosts: recentBriefingPosts,
          recentReflection: recentReflectionText,
          intentLine: soulIntent.intentLine,
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

    if (TEST_NO_EXTERNAL_CALLS) {
      const localAnchors = eventPlan.evidence
        .slice(0, 2)
        .map((item) => `${item.label} ${item.value}`)
        .join(" | ");
      const localCandidates = buildPreviewFallbackCandidates({
        headline: eventPlan.event.headline,
        anchors: localAnchors,
        language: runtimeSettings.postLanguage,
        recentPosts: recentBriefingPosts,
        recentReflection: recentReflectionText,
        intentLine: soulIntent.intentLine,
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
          nutritionHint.shortLine
        );
        localPost = enforceActionAndInvalidation(
          localPost,
          runtimeSettings.postLanguage,
          runtimeSettings.postMaxChars
        );
        localPost = finalizeGeneratedText(localPost, runtimeSettings.postLanguage, runtimeSettings.postMaxChars);
        localPost = ensureLeadIssueAnchor(localPost, runtimeSettings.postLanguage, runtimeSettings.postMaxChars, eventPlan.lane);
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
              requireActionAndInvalidation: true,
              requireLeadIssueClarity: true,
              requirePixymonConceptSignal: true,
            }
          );

        const localSoftPass = allowSoftQualityPass({
          reason: localQuality.reason,
          noveltyScore: localNovelty.score,
          contractOk: localContract.ok,
        });
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
            nutritionHint.shortLine
          );
          localPost = enforceActionAndInvalidation(
            localPost,
            runtimeSettings.postLanguage,
            runtimeSettings.postMaxChars
          );
          localPost = finalizeGeneratedText(localPost, runtimeSettings.postLanguage, runtimeSettings.postMaxChars);
          localPost = ensureLeadIssueAnchor(
            localPost,
            runtimeSettings.postLanguage,
            runtimeSettings.postMaxChars,
            eventPlan.lane
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
              requireActionAndInvalidation: true,
              requireLeadIssueClarity: false,
              requirePixymonConceptSignal: true,
            }
          );
          const localSoftPass = allowSoftQualityPass({
            reason: localQuality.reason,
            noveltyScore: localNovelty.score,
            contractOk: localContract.ok,
          });
          if (localContract.ok && localNovelty.ok && (localQuality.ok || localSoftPass)) {
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
              requireActionAndInvalidation: true,
              requireLeadIssueClarity: true,
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
              requireActionAndInvalidation: true,
              requireLeadIssueClarity: true,
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
- 열린 질문: ${soulIntent.activeQuestion}
- 대화 유도 질문: ${soulIntent.interactionMission}
- 철학 프레임: ${soulIntent.philosophyFrame}
- 책/문장 파편: ${soulIntent.bookFragment}
- 선호 형식: ${soulIntent.narrativeForm}
- 아크 단계: ${soulIntent.arcStage}
- 문체 지시: ${soulIntent.styleDirective}

핵심 이벤트(1개 고정):
${eventPlan.event.headline}

근거 2개(둘 다 필수):
1) ${eventPlan.evidence[0].label} ${eventPlan.evidence[0].value}
2) ${eventPlan.evidence[1].label} ${eventPlan.evidence[1].value}

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
- 반드시 한국어
- 반드시 1인칭 캐릭터 시점
- 주제는 블록체인/크립토 맥락 유지
- 해시태그/이모지 금지
- 과장/확정적 투자 조언 금지
- 금기 없이 자유롭게 상상해도 되지만 숫자/사실 왜곡 금지
- 반드시 \"이벤트 1개 + 근거 2개\" 구조 유지
- 반드시 \"지금 확인할 행동 1개 + 틀리는 조건(반증) 1개\"를 문장 안에 포함
- 첫 문장에 오늘 무엇을 말하는지(핵심 이슈)를 평문으로 명확히 제시
- 읽는 사람이 1회독으로 이해되도록 문장을 짧고 직접적으로 유지
- 문장 안에 픽시몬의 먹기/소화/진화 컨셉 신호를 자연스럽게 1회 이상 포함
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
- Open question: ${soulIntent.activeQuestion}
- Community prompt: ${soulIntent.interactionMission}
- Philosophy frame: ${soulIntent.philosophyFrame}
- Book fragment: ${soulIntent.bookFragment}
- Preferred form: ${soulIntent.narrativeForm}
- Arc stage: ${soulIntent.arcStage}
- Voice directive: ${soulIntent.styleDirective}

Primary event (exactly one):
${eventPlan.event.headline}

Required evidence (must include both):
1) ${eventPlan.evidence[0].label} ${eventPlan.evidence[0].value}
2) ${eventPlan.evidence[1].label} ${eventPlan.evidence[1].value}

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
- Write in English
- Keep first-person character perspective
- Keep topic grounded in blockchain/crypto context
- No hashtags or emoji
- No financial certainty claims
- You can be imaginative, but do not fabricate numbers/facts
- Keep strict structure: one event + two evidence anchors
- Include one concrete action to verify now, and one falsification condition
- First sentence must state the core issue in plain language
- Keep sentence flow straightforward enough to understand in one pass
- Include one natural feed/digest/evolve concept signal in the text
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
          rejectionFeedback = "llm budget local-only";
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
          nutritionHint.shortLine
        );
        candidate = enforceActionAndInvalidation(
          candidate,
          runtimeSettings.postLanguage,
          runtimeSettings.postMaxChars
        );
        candidate = finalizeGeneratedText(candidate, runtimeSettings.postLanguage, runtimeSettings.postMaxChars);
        candidate = ensureLeadIssueAnchor(
          candidate,
          runtimeSettings.postLanguage,
          runtimeSettings.postMaxChars,
          eventPlan.lane
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
          requireActionAndInvalidation: true,
          requireLeadIssueClarity: true,
          requirePixymonConceptSignal: true,
        });
        const softPass = allowSoftQualityPass({
          reason: quality.reason,
          noveltyScore: narrativeNovelty.score,
          contractOk: true,
        });
        if (!quality.ok && !softPass) {
          rejectionFeedback = quality.reason || "품질 게이트 미통과";
          latestFailReason = rejectionFeedback;
          console.log(
            `[POST] 품질 게이트 실패: ${rejectionFeedback} (재시도 ${attempt + 1}/${runtimeSettings.postGenerationMaxAttempts})`
          );
          continue;
        }
        if (!quality.ok && softPass) {
          console.log(`[POST] 소프트 품질 허용: ${quality.reason}`);
        }

        postText = candidate;
        break;
      }
    }

    if (!postText) {
      let fallbackPost: string | null = buildEventEvidenceFallbackPost(
        eventPlan,
        runtimeSettings.postLanguage,
        runtimeSettings.postMaxChars,
        narrativePlan.mode
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
          nutritionHint.shortLine
        );
        fallbackPost = enforceActionAndInvalidation(
          fallbackPost,
          runtimeSettings.postLanguage,
          runtimeSettings.postMaxChars
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
            requireActionAndInvalidation: true,
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
          console.log("[POST] LLM 재시도 실패, deterministic fallback으로 전환");
        } else {
          console.log(`[POST] fallback 실패: ${fallbackQuality.reason}`);
          latestFailReason = fallbackQuality.reason || latestFailReason;
        }
      }
    }

    if (!postText) {
      const hardFallback = buildHardContractPost(eventPlan, runtimeSettings.postLanguage, runtimeSettings.postMaxChars);
      if (hardFallback) {
        const hardQuality = evaluatePostQuality(hardFallback, trend.marketData, recentBriefingPosts, policy, qualityRules, {
          requiredTrendTokens,
          narrativeMode: narrativePlan.mode,
          previousNarrativeMode,
          allowTopicRepeatOnModeShift: true,
          language: runtimeSettings.postLanguage,
          requireActionAndInvalidation: true,
          requireLeadIssueClarity: true,
          requirePixymonConceptSignal: true,
        });
        if (hardQuality.ok) {
          postText = hardFallback;
          usedFallback = true;
          console.log("[POST] hard fallback 사용");
        } else {
          latestFailReason = `hard-fallback:${hardQuality.reason || "quality-fail"}`;
        }
      }
    }

    if (!postText) {
      const rescueFallback = buildRescueContractPost(eventPlan, runtimeSettings.postLanguage, runtimeSettings.postMaxChars);
      if (rescueFallback) {
        const rescueQuality = evaluatePostQuality(
          rescueFallback,
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
            requireActionAndInvalidation: true,
            requireLeadIssueClarity: true,
            requirePixymonConceptSignal: true,
          }
        );
        const rescueSoftPass = allowSoftQualityPass({
          reason: rescueQuality.reason,
          noveltyScore: 0.66,
          contractOk: true,
        });
        if (rescueQuality.ok || rescueSoftPass) {
          postText = rescueFallback;
          usedFallback = true;
          console.log("[POST] rescue fallback 사용");
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
        postText = emergencyFallback;
        usedFallback = true;
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

    postText = applyNarrativeLayout(postText, runtimeSettings.postLanguage, runtimeSettings.postMaxChars);

    const tweetId = await postTweet(twitter, postText, "briefing", {
      timezone,
      xApiCostSettings,
      createKind: "post:briefing",
      metadata: {
        lane: eventPlan.lane,
        eventId: eventPlan.event.id,
        eventHeadline: eventPlan.event.headline,
        evidenceIds: eventPlan.evidence.map((item) => item.id).slice(0, 2),
        narrativeMode: narrativePlan.mode,
      },
    });
    if (!tweetId) return false;

    memory.recordCognitiveActivity("social", 2);
    memory.recordNarrativeOutcome({
      lane: eventPlan.lane,
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
    trend.summary ? sanitizeTweetText(`${trend.summary} 그런데 먼저 흔들린 건 어디였을까`) : "",
  ].filter(Boolean);
  const raw = [
    ...trend.events.slice(0, 8).map((event) => sanitizeTweetText(event.headline)),
    ...trend.headlines.slice(0, 8).map((headline) => sanitizeTweetText(headline)),
    ...nutrientScenes,
    ...syntheticScenes,
    sanitizeTweetText(`${trend.summary} 이 흐름은 그냥 지나치기 어렵다`),
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
        ? `${scene}. 방금 남은 메모도 결국 ${memo} 쪽이었어서, ${a}와 ${b}를 한 번 더 겹쳐 보게 된다.`
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
  if (params.language === "ko") {
    return finalizeNarrativeSurface(
      memo
        ? `${scene || memo}. 그래도 이 장면에선 ${a}와 ${b}의 순서가 어긋나는지부터 먼저 본다. 끝까지 같은 말을 하지 않으면 이 해석은 바로 접는다.`
        : `${scene || `${a}와 ${b}의 순서`}. 이 장면에선 ${a}와 ${b}가 어긋나는지부터 먼저 본다. 끝까지 같은 말을 하지 않으면 이 해석은 바로 접는다.`,
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
  const normalized = sanitizeTweetText([label, value].map((item) => String(item || "").trim()).filter(Boolean).join(" "));
  return normalized.slice(0, maxChars).trim();
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
        `${anchors[0]}와 ${anchors[1]}가 같은 말을 하는지부터 다시 본다${rejectLine ? `, ${rejectLine}는 이번엔 일단 뒤로 둔다` : ""}`
      ).slice(0, 88);
    }
    if (anchors.length === 1) {
      return sanitizeTweetText(
        `${anchors[0]}가 버티는지부터 다시 본다${rejectLine ? `, ${rejectLine}는 아직 보류한다` : ""}`
      ).slice(0, 88);
    }
    return rejectLine
      ? sanitizeTweetText(`${rejectLine}를 서두르지 않고, 남은 신호부터 다시 맞춰 본다`).slice(0, 88)
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

  const postGoal = Math.max(3, Math.floor(target * 0.25));

  while (executed < maxActions && remaining > 0) {
    if (!canActWithDigest) {
      console.log("[QUOTA] feed/digest gate로 proactive action 생략");
      break;
    }

    const before = executed;
    const todayPosts = memory.getTodayPostCount(timezone);
    const canQuoteInCycle = quotesCreatedThisCycle < 1;
    const canPostInCycle = postsCreatedThisCycle < runtimeSettings.maxPostsPerCycle;
    const preferPost = canPostInCycle && todayPosts < postGoal && (executed === 0 || executed % 2 === 0);

    if (preferPost) {
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
      }
    } else if (canQuoteInCycle) {
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
      }
    } else {
      const replied = await proactiveEngagement(
        twitter,
        claude,
        1,
        adaptivePolicy,
        runtimeSettings,
        timezone,
        xApiCostSettings,
        cycleCache
      );
      executed += replied;
    }

    if (executed === before) {
      if (preferPost) {
        const fallbackReplies = await proactiveEngagement(
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
        executed += fallbackReplies;
      } else if (canPostInCycle) {
        const fallbackPosted = await postTrendUpdate(
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
        if (fallbackPosted) {
          executed += 1;
          postsCreatedThisCycle += 1;
        }
      } else if (canQuoteInCycle) {
        const fallbackQuote = await postTrendQuote(
          twitter,
          claude,
          adaptivePolicy,
          runtimeSettings,
          timezone,
          xApiCostSettings,
          cycleCache,
          cycleReflectionHint
        );
        if (fallbackQuote) {
          executed += 1;
          quotesCreatedThisCycle += 1;
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
    "이럴 때는 단서를 더 모으기보다, 이미 잡힌 단서를 끝까지 검증하는 편이 낫다.",
    "나는 숫자를 바로 믿지 않는다. 왜 움직였는지부터 다시 본다.",
    "오늘은 반응보다 원인을 먼저 따라가 보려 한다.",
    "나는 단서를 빨리 모으는 것보다, 틀린 해석을 빨리 버리는 쪽을 택한다.",
    "지금은 많이 말하는 것보다, 맞는 단서를 남기는 편이 더 중요하다.",
    "나는 이 장면에서 확신보다 수정 가능성을 먼저 남겨두려 한다.",
    "오늘은 새 단서를 더 쌓기보다, 이미 보인 흔적을 끝까지 확인하고 싶다.",
    "신호는 바로 믿지 않는다. 먼저 이유를 확인한 뒤에야 다음 말을 꺼낸다.",
  ];
  const longPool = [
    `오늘은 ${metrics.acceptedCount}개 단서를 소화해 XP ${metrics.xpGain}를 얻었다. 현재 레벨 단계는 ${stageKo[stage] || stage}, 핵심 레인은 ${laneKo[params.lane]}.`,
    `지금 단계는 ${stageKo[stage] || stage}. 오늘 먹은 단서 ${metrics.acceptedCount}개 중 통과한 신호만 진화에 반영한다.`,
    `${laneKo[params.lane]} 레인에서 오늘 소화한 영양소는 ${metrics.acceptedCount}개, 누적 XP는 ${metrics.xpGain}.`,
  ];
  const withNutrient =
    nutrientLabel.length >= 2
      ? [
          `지금은 ${nutrientLabel} 쪽부터 다시 확인한다.`,
          `이번엔 ${nutrientLabel}부터 다시 짚어본다.`,
          `${nutrientLabel}가 끝까지 버티는지 먼저 본다.`,
          `먼저 ${nutrientLabel} 쪽 흐름이 이어지는지 확인한다.`,
        ][seed % 4]
      : [
          "이번에는 핵심 단서부터 다시 짚어본다.",
          "지금은 먼저 흔들리는 단서부터 다시 본다.",
          "이번엔 제일 약한 고리부터 다시 확인한다.",
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
  hintLine: string
): string {
  const normalized = sanitizeTweetText(text);
  if (!normalized) return normalized;
  const hasConcept =
    language === "ko"
      ? /(픽시몬|영양소|소화|진화|레벨|먹고|먹은|채집)/.test(normalized)
      : /(pixymon|nutrient|digest|evolve|evolution|feed)/i.test(normalized);
  if (hasConcept) {
    return normalized.slice(0, maxChars);
  }
  const bridge = sanitizeTweetText(hintLine || "").trim();
  if (!bridge) {
    return normalized.slice(0, maxChars);
  }
  if (language === "ko") {
    const parts = normalized
      .split(/(?<=[.!?])/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    if (parts.length >= 2) {
      const inserted = sanitizeTweetText([parts[0], bridge, ...parts.slice(1)].join(" "));
      if (inserted.length <= maxChars) {
        return inserted;
      }
    }
  }
  const merged = sanitizeTweetText(`${normalized} ${bridge}`);
  if (merged.length <= maxChars) {
    return merged;
  }
  const inline = language === "ko" ? injectInlineConceptKo(normalized) : injectInlineConceptEn(normalized);
  if (inline.length <= maxChars) {
    return inline;
  }
  return truncateAtWordBoundary(inline, maxChars);
}

function injectInlineConceptKo(text: string): string {
  const normalized = sanitizeTweetText(text);
  const conceptTailPool = [
    "먹은 단서가 버티는지 한 번 더 본다.",
    "단서를 급히 넘기지 않고 끝까지 소화해 본다.",
    "신호를 한 번 더 씹어 보고 남는 것만 말한다.",
    "근거가 버티는지 확인한 뒤에야 다음 문장을 고른다.",
    "이 장면을 통과한 근거만 다음 판단에 남긴다.",
    "지금은 맞은 문장보다 버틴 단서를 더 믿는다.",
    "끝까지 살아남은 근거만 조용히 적어 둔다.",
  ];
  const tail = conceptTailPool[stableSeedForPrelude(normalized) % conceptTailPool.length];
  if (/^(?:오늘\s*핵심\s*장면은|이번\s*사이클의\s*출발점은|지금\s*먼저\s*확인할\s*쟁점은|핵심만\s*먼저\s*말하면|한\s*줄\s*요지는|먼저\s*짚을\s*포인트는|지금\s*시장이\s*묻는\s*질문은|내가\s*지금\s*붙잡는\s*장면은)/.test(normalized)) {
    return sanitizeTweetText(`${normalized} ${tail}`);
  }
  if (/^나는\s+/.test(normalized)) {
    return sanitizeTweetText(normalized.replace(/^나는\s+/, "나는 신호를 한 번 더 소화해 보고 "));
  }
  return sanitizeTweetText(`${normalized} ${tail}`);
}

function injectInlineConceptEn(text: string): string {
  const normalized = sanitizeTweetText(text);
  if (/^i\s+/i.test(normalized)) {
    return sanitizeTweetText(normalized.replace(/^i\s+/i, "I digest signals first and "));
  }
  return sanitizeTweetText(`Pixymon feed/digest mode first. ${normalized}`);
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
  const leadWindow = normalized
    .split(/(?<=[.!?])/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 2)
    .join(" ");
  const hasDomain =
    language === "ko"
      ? /(프로토콜|생태계|규제|정책|매크로|온체인|시장구조|거래소|유동성|지갑|체인|크립토|블록체인|BTC|ETH|SOL|XRP)/i.test(firstSentence)
      : /(protocol|ecosystem|regulation|policy|macro|onchain|market|exchange|liquidity|wallet|chain|crypto|blockchain|btc|eth|sol|xrp)/i.test(
          firstSentence
        );
  const hasDomainInLeadWindow =
    language === "ko"
      ? /(프로토콜|생태계|규제|정책|매크로|온체인|시장구조|거래소|유동성|지갑|체인|크립토|블록체인|BTC|ETH|SOL|XRP)/i.test(
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
  if (hasDomain || hasDomainInLeadWindow) {
    return normalized.slice(0, maxChars);
  }
  if (looksSceneAnchored) {
    return normalized.slice(0, maxChars);
  }
  if (language === "en") {
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
  const laneLeadKo: Record<TrendLane, string[]> = {
    protocol: [
      "코드 아래쪽으로 내려가 보면",
      "합의가 어긋나는 자리로 가면",
    ],
    ecosystem: [
      "사람들이 실제로 움직이는 자리로 가 보면",
      "커뮤니티의 온도가 달라지는 지점을 보면",
    ],
    regulation: [
      "규제 문장이 행동으로 번지는 속도로 보면",
      "정책의 말보다 집행의 시간차를 따라가 보면",
    ],
    macro: [
      "화면을 조금 멀리서 보면",
      "달러와 금리의 그림자를 겹쳐 보면",
    ],
    onchain: [
      "체인 안쪽 발자국만 따라가 보면",
      "주소와 수수료가 남긴 흔적을 좇아가 보면",
    ],
    "market-structure": [
      "체결이 남긴 결을 더듬어 보면",
      "호가가 비는 지점만 놓고 보면",
    ],
  };
  const leadPool = laneLeadKo[lane];
  const lead = leadPool[stableSeedForPrelude(`${lane}|${normalized}`) % leadPool.length];
  return truncateAtWordBoundary(`${lead} ${normalized}`, maxChars);
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
  const koClauses = [
    `근거는 ${missingTokens.join(", ")}.`,
    `단서는 ${missingTokens.join(" · ")}.`,
    `${missingTokens.join(" · ")}부터 다시 본다.`,
  ];
  const enClauses = [
    `Core anchors are ${missingTokens.join(" and ")}.`,
    `I keep ${missingTokens.join(" / ")} on the same screen.`,
  ];
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
  rules: {
    minSourceTrust: number;
    minScore: number;
    minEngagement: number;
  },
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
  if (cache) {
    cache.trendTweets = { key, data: result };
  }
  return result;
}

function buildTrendTweetCacheKey(
  keywords: string[],
  count: number,
  rules: {
    minSourceTrust: number;
    minScore: number;
    minEngagement: number;
  }
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
  return `${normalizedCount}|${minSourceTrust}|${minScore}|${minEngagement}|${normalizedKeywords}`;
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
    .map((item) => sanitizeTweetText(`${item.label} ${item.value}`).trim())
    .filter((item) => item.length >= 8 && item.length <= 90);
  const fromEvents = trend.events
    .slice(0, 6)
    .map((item) => sanitizeTweetText(item.headline))
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
  return /(주제 다양성 부족|24h 내 동일 주제 과밀|동일 시그널 레인 반복|문장 시작 패턴 중복|서두 구조 반복|마무리 패턴 반복)/.test(
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
  recentPosts: Array<{ content: string }>;
  recentReflection?: string;
  intentLine?: string;
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
  const headlineRaw = compactClause(input.headline || "", 112).replace(/\.$/, "");
  const headlineBase = stripKoHeadlinePrefix(headlineRaw) || "오늘은 구조적 원인을 먼저 추적한다";
  const anchors = compactClause(input.anchors || "", 120);
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
  const normalizeKoConceptToken = (token: string): string => {
    const base = token.replace(/(이|가|은|는|을|를|와|과|보다|에서|으로|로|의|도|만|까지|부터)$/u, "");
    const alias: Record<string, string> = {
      인센티브: "보상",
      토큰: "보상",
      토큰보상: "보상",
      커뮤니티설계: "커뮤니티",
      관계설계: "관계",
      사용자행동: "행동",
      행동방식: "행동",
      내러티브: "서사",
      설명가능한합의: "합의",
    };
    return alias[base] || base;
  };
  const extractKoConceptTokens = (text: string): string[] =>
    sanitizeTweetText(text)
      .replace(/[.!?,]/g, " ")
      .split(/\s+/)
      .map((item) => item.replace(/[^가-힣A-Za-z0-9]/g, ""))
      .map((item) => normalizeKoConceptToken(item))
      .filter((item) => item.length >= 2)
      .slice(0, 10);
  const sharesKoConceptFrame = (a: string, b: string): boolean => {
    if (!a || !b) return false;
    const aTokens = extractKoConceptTokens(a);
    const bTokens = extractKoConceptTokens(b);
    if (aTokens.length === 0 || bTokens.length === 0) return false;
    const overlapCount = aTokens.filter((token) => bTokens.includes(token)).length;
    const aHasComparator = /(보다|먼저|길다|오래|중요|버티)/.test(a);
    const bHasComparator = /(보다|먼저|길다|오래|중요|버티)/.test(b);
    return overlapCount >= 2 || (overlapCount >= 1 && aHasComparator && bHasComparator);
  };
  const worldviewLine =
    worldviewHint && !sharesKoConceptFrame(worldviewHint, headlineBase) ? worldviewHint : "";
  const signatureLine =
    signatureBelief && !sharesKoConceptFrame(signatureBelief, headlineBase) ? signatureBelief : "";
  const philosophyLine =
    philosophyFrame && !sharesKoConceptFrame(philosophyFrame, headlineBase) ? philosophyFrame : "";
  const bookLine =
    bookFragment && !sharesKoConceptFrame(bookFragment, headlineBase) ? bookFragment : "";
  const lane = inferTrendLaneFromText(headlineBase);
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
  const hasKoPredicateEnding = (text: string): boolean =>
    /(?:다|한다|했다|된다|보인다|남는다|읽힌다|바뀐다|움직인다|흔들린다|다가온다|가깝다|또렷하다|걸린다|간다|든다|느껴진다|실감난다|남아있다|붙는다|되돌아온다|생긴다|쌓인다|굳어진다|꺼낸다|멈춘다|접는다|늦춘다|의심한다|돌아간다|시작된다|보탠다|가리킨다|비교한다|대조한다|확인한다|짚어본다|붙어\s*있다|적어\s*둔다|붙들고\s*간다)$/.test(
      sanitizeTweetText(text).replace(/[.!?]+$/g, "").trim()
    );
  const looksMostlyLatin = (text: string): boolean => {
    const cleaned = sanitizeTweetText(text);
    const alphaCount = (cleaned.match(/[A-Za-z]/g) || []).length;
    return alphaCount >= Math.max(8, Math.floor(cleaned.length * 0.42));
  };
  const toKoThoughtStem = (text: string): string => {
    const cleaned = stripKoHeadlinePrefix(sanitizeTweetText(text || "").replace(/[.!?]+$/g, "")).trim();
    if (!cleaned) return "";
    if (/는가$/.test(cleaned)) return cleaned.replace(/는가$/, "는지");
    if (/(인가|일까|될까|할까)$/.test(cleaned)) return `${cleaned} 하는 쪽`;
    if (/(인지|일지)$/.test(cleaned)) return cleaned;
    if (/생각$/.test(cleaned)) return `${cleaned}`;
    if (/이다$/.test(cleaned)) return `${cleaned.slice(0, -2)}이라는 말`;
    if (/다$/.test(cleaned)) {
      const stem = cleaned.slice(0, -1);
      const nounPredicateLike =
        /(지도|합의|프레임|인터페이스|원인|구조|질서|설계|관계|질문|보상|행동|문장|장식|기술|태도|습관|진실|서사|의미|책임|설명|단서|신호|복구|방식)$/.test(
          stem
        );
      if (nounPredicateLike) {
        return `${stem}라는 말`;
      }
      return `${stem}다는 말`;
    }
    if (!/(다|요|까)$/.test(cleaned) && cleaned.length >= 12) {
      return cleaned;
    }
    return cleaned;
  };
  const looksAbstractKoHeadline = (text: string): boolean => {
    const cleaned = sanitizeTweetText(text).replace(/[.!?]+$/g, "").trim();
    if (!cleaned) return false;
    if (/^(?:오늘|지금|요즘|가끔|문득|예전|이번엔|내가)\b/.test(cleaned)) return false;
    if (/[A-Za-z]{4,}/.test(cleaned) && looksMostlyLatin(cleaned)) return false;
    return (
      /(?:자유|책임|신뢰|질문|합의|구조|관계|설계|의미|습관|행동|보상|리텐션|서사|진실|해석|결론|인센티브|복구|속도|순서|전제|설명|패턴|관점|모델|문장|시선|체계|신호|질감|감정|제품|사용자|커뮤니티|정책)/.test(
        cleaned
      ) ||
      /(생각|질문|감각)$/.test(cleaned) ||
      /[은는이가]\s*.+(?:다|까)$/.test(cleaned)
    );
  };
  const humanizeKoSceneHeadline = (text: string, mode: string, laneHint: TrendLane, offset: number): string => {
    const cleaned = stripKoHeadlinePrefix(sanitizeTweetText(text || "").replace(/[.!?]+$/g, "")).trim();
    if (!cleaned) {
      return "";
    }
    if (looksMostlyLatin(cleaned)) {
      return cleaned;
    }
    if (
      !looksAbstractKoHeadline(cleaned) &&
      (hasKoPredicateEnding(cleaned) || /^[가-힣0-9A-Za-z].{12,}$/.test(cleaned))
    ) {
      return cleaned;
    }

    const rewriteVariant = (...pool: string[]): string =>
      pool[(stableSeedForPrelude(`${cleaned}|${mode}|${laneHint}|${offset}`) + offset) % pool.length];
    const exactRewriteMap: Record<string, string[]> = {
      "달러가 흔들릴 때 내러티브의 수명이 먼저 길어진다": [
        "달러가 흔들리는 날엔 숫자보다 이야기가 더 오래 남는다",
        "달러 쪽이 출렁이면 사람들은 가격보다 이야기에 더 오래 붙는다",
        "달러가 흔들리기 시작하면 차트보다 서사가 더 길게 버틴다",
      ],
      "자유는 느림이 아니라 설명 가능한 합의라는 생각": [
        "자유라는 말은 결국 속도보다 설명 가능한 합의 쪽에서 더 또렷해진다",
        "요즘은 자유가 빠름보다 설명 가능한 합의에 더 가까워 보인다",
        "자유를 말할 때 끝에 남는 건 속도보다 설명 가능한 합의 쪽이다",
      ],
      "규제를 핑계로 삼는 순간 제품은 멈춘다": [
        "규제를 이유로 움직임을 멈추는 순간 제품은 금방 굳어 버린다",
        "규제를 핑계로 멈춰 서는 순간 제품은 더 이상 자라지 못한다",
        "규제를 앞세워 멈추는 순간 제품은 생각보다 빨리 굳는다",
      ],
      "업그레이드 속도보다 중요한 건 롤백 없이 신뢰를 유지하는 방식": [
        "요즘은 업그레이드 속도보다 롤백 없이 신뢰를 버티게 하는 방식이 더 눈에 들어온다",
        "이번엔 빨리 바꾸는 일보다 롤백 없이 신뢰를 유지하는 방식이 더 중요해 보인다",
        "결국 중요한 건 속도보다 롤백 없이 신뢰를 지켜 내는 방식 쪽이다",
      ],
    };
    const exactPool = exactRewriteMap[cleaned];
    if (exactPool?.length) {
      return rewriteVariant(...exactPool);
    }

    const rewriteKoAbstractPattern = (input: string): string | null => {
      const importantMatch = input.match(/^(.+?)보다\s+중요한\s+건\s+(.+)$/);
      if (importantMatch) {
        const left = importantMatch[1].trim();
        const right = importantMatch[2].trim();
        if (mode === "philosophy-note") {
          return rewriteVariant(
            `${left}보다 ${right} 쪽이 오늘은 더 또렷하게 보인다`,
            `오늘은 ${left}보다 ${right} 쪽이 더 중요하다는 생각으로 기운다`,
            `이 장면에선 ${left}보다 ${right} 쪽이 더 크게 남는다`
          );
        }
        if (mode === "meta-reflection") {
          return rewriteVariant(
            `예전보다 ${left}보다 ${right} 쪽을 더 오래 붙들게 된다`,
            `나는 자꾸 ${left}보다 ${right} 쪽에서 더 많이 틀렸다는 걸 떠올리게 된다`,
            `이번엔 ${left}보다 ${right} 쪽을 먼저 의심하게 된다`
          );
        }
        return rewriteVariant(
          `요즘은 ${left}보다 ${right} 쪽이 더 중요하게 느껴진다`,
          `결국 ${left}보다 ${right} 쪽에서 이야기가 갈린다는 생각이 남는다`,
          `이번엔 ${left}보다 ${right} 쪽을 먼저 붙잡게 된다`
        );
      }

      const retentionQuestionMatch = input.match(/^(.+?)[은는]\s+(.+?)보다\s+오래\s+남는가$/);
      if (retentionQuestionMatch) {
        const left = retentionQuestionMatch[1].trim();
        const right = retentionQuestionMatch[2].trim();
        return rewriteVariant(
          `요즘은 ${left}가 ${right}보다 오래 남는지부터 다시 보게 된다`,
          `결국 ${left}가 ${right}보다 오래 버티는지만 확인하게 된다`,
          `이번엔 ${left}가 ${right}보다 오래 남는 쪽인지부터 본다`
        );
      }

      const decideMatch = input.match(/^(.+?)[은는]\s+(.+?)에서\s+먼저\s+결정된다$/);
      if (decideMatch) {
        const left = decideMatch[1].trim();
        const right = decideMatch[2].trim();
        return rewriteVariant(
          `결국 ${left}는 ${right}에서 먼저 갈린다고 보게 된다`,
          `요즘은 ${left}가 ${right}에서 먼저 정해지는 장면으로 읽힌다`,
          `이번엔 ${left}가 ${right}에서 먼저 갈리는지만 보게 된다`
        );
      }

      const revealMatch = input.match(/^(.+?)[은는]\s+(.+?)에서\s+먼저\s+드러난다$/);
      if (revealMatch) {
        const left = revealMatch[1].trim();
        const right = revealMatch[2].trim();
        return rewriteVariant(
          `${left}는 결국 ${right}에서 먼저 새어 나온다`,
          `가만히 보면 ${left}는 ${right}에서 먼저 티가 난다`,
          `이번 장면에선 ${left}가 ${right}에서 먼저 모습을 드러낸다`
        );
      }

      const lagMatch = input.match(/^(.+?)[은는]\s+짧아도\s+(.+?)[은는]\s+길다$/);
      if (lagMatch) {
        const left = lagMatch[1].trim();
        const right = lagMatch[2].trim();
        return rewriteVariant(
          `${left}는 금방 끝나는데 ${right}는 꼭 더 늦게 따라온다`,
          `${left}는 짧게 지나가도 ${right}는 생각보다 오래 남는다`,
          `${left}는 스쳐 가도 ${right}는 한참 뒤까지 끌고 간다`
        );
      }

      const stateMatch = input.match(/^(.+?)[은는]\s+(.+?)이다$/);
      if (stateMatch) {
        const left = stateMatch[1].trim();
        const right = stateMatch[2].trim();
        return rewriteVariant(
          `가만히 보고 있으면 ${left}는 결국 ${right}에 더 가깝다`,
          `요즘은 ${left}를 ${right} 쪽으로 읽게 된다`,
          `${left}를 보고 있으면 결국 ${right}라는 쪽에 손이 간다`
        );
      }

      return null;
    };
    const rewrittenPattern = rewriteKoAbstractPattern(cleaned);
    if (rewrittenPattern) {
      return rewrittenPattern;
    }

    const seed = stableSeedForPrelude(`${mode}|${laneHint}|${cleaned}|${offset}`);
    const thoughtStem = toKoThoughtStem(cleaned) || cleaned;
    const isQuestionThought = /(는지|인지|일지|할까 하는 쪽|될까 하는 쪽|인가 하는 쪽)$/.test(thoughtStem);
    const identityPool = isQuestionThought
      ? [
          `오늘은 ${thoughtStem}부터 자꾸 되묻게 된다`,
          `${thoughtStem}가 오늘 메모 첫 줄에 남는다`,
          `이번엔 ${thoughtStem}를 먼저 적어 둔다`,
          `${thoughtStem}가 이상하게 오래 걸린다`,
        ]
      : [
          `${thoughtStem}이 오늘 메모 첫 줄에 남는다`,
          `오늘은 ${thoughtStem}이 유난히 몸에 남는다`,
          `${thoughtStem}이 이상하게 오래 붙어 있다`,
          `오늘은 결국 ${thoughtStem} 얘기부터 꺼내게 된다`,
        ];
    const philosophyPool = isQuestionThought
      ? [
          `조금 떨어져서 보면 결국 ${thoughtStem}부터 다시 묻게 된다`,
          `멀리서 보면 ${thoughtStem}가 숫자보다 먼저 들어온다`,
          `오늘은 ${thoughtStem}를 그냥 넘길 수가 없다`,
          `${thoughtStem}라는 질문이 오늘 장면을 다시 정렬한다`,
        ]
      : [
          `조금 떨어져서 보면 ${thoughtStem}이 숫자보다 먼저 보인다`,
          `${thoughtStem}이 오늘은 그냥 비유로 안 들린다`,
          `멀리서 보면 ${thoughtStem}이 더 또렷하다`,
          `오늘은 ${thoughtStem}이 차트보다 먼저 들어온다`,
        ];
    const metaPool = isQuestionThought
      ? [
          `예전 같으면 지나쳤겠지만 오늘은 ${thoughtStem}부터 다시 적게 된다`,
          `내가 너무 빨리 단정하는 지점도 결국 ${thoughtStem}일 때가 많다`,
          `이번엔 ${thoughtStem}를 서둘러 닫지 않으려 한다`,
          `${thoughtStem}라는 질문이 나오면 나는 한 번 더 멈춘다`,
        ]
      : [
          `예전 같으면 그냥 넘겼겠지만 오늘은 ${thoughtStem}이 자꾸 걸린다`,
          `내가 자주 놓치는 것도 결국 ${thoughtStem}일 때가 많다`,
          `이번엔 ${thoughtStem}을 너무 빨리 단정하지 않으려 한다`,
          `한 번 맞았던 설명을 다시 의심하게 되는 것도 결국 ${thoughtStem}이다`,
        ];
    const defaultPool = isQuestionThought
      ? [
          `오늘은 결국 ${thoughtStem}부터 다시 묻게 된다`,
          `${thoughtStem}가 계속 마음에 남는다`,
          `이번엔 ${thoughtStem}를 먼저 붙들고 간다`,
          `${thoughtStem}라는 질문이 계속 따라온다`,
        ]
      : [
          `${thoughtStem}이 오늘은 유난히 또렷하다`,
          `${thoughtStem}이 이상하게 오래 남는다`,
          `오늘은 ${thoughtStem}에 먼저 눈이 간다`,
          `${thoughtStem}이 오늘 메모 첫 줄에 남는다`,
        ];
    const pool =
      mode === "identity-journal"
        ? identityPool
        : mode === "philosophy-note"
          ? philosophyPool
          : mode === "meta-reflection"
            ? metaPool
            : defaultPool;
    return pool[seed % pool.length];
  };

  const koLeadPool = [
    "오늘 유독 걸리는 건",
    "이상하게 계속 남는 건",
    "계속 머리에 맴도는 건",
    "지금 먼저 적어 두고 싶은 건",
    "숫자보다 먼저 마음에 걸린 건",
    "조금 더 들여다보고 싶은 건",
    "이번 흐름에서 자꾸 손이 가는 건",
    "한 발 물러서서 보면 먼저 보이는 건",
    "계산보다 먼저 걸린 건",
    "오늘 끝까지 붙들고 싶은 건",
    "한참 마음에 남아 있는 건",
    "괜히 오래 남는 건",
  ];
  const koIdentityLeadPool = [
    "오늘 내 메모에 남는 건",
    "이번 사이클에서 내가 먼저 적는 건",
    "지금 내가 붙들고 있는 건",
    "오늘은 이 흔적부터 적어 둔다",
  ];
  const koPhilosophyLeadPool = [
    "한 걸음 물러서서 보면",
    "조금 떨어져서 보면",
    "이 장면을 너무 가까이서 보지 않으면",
    "결국 남는 질문은",
  ];
  const koMetaLeadPool = [
    "내가 자주 틀리는 지점은",
    "예전 같으면 서둘러 결론 냈을 장면인데",
    "이럴 때일수록 처음 든 확신을 의심한다",
    "한 번 맞았던 설명이 이번에도 맞는지는 따로 본다",
  ];
  const koMetaPool = [
    "내가 자주 틀리는 건 예쁘게 맞아 보이는 숫자 하나에 기대는 순간이다",
    "이런 장면에서는 처음 든 확신이 가장 먼저 의심해야 할 대상이다",
    "한 번 맞은 설명이 다음 장면까지 맞을 거라 믿는 순간 해석이 굳는다",
    "지금 필요한 건 더 세게 말하는 일이 아니라, 어디서 틀릴지 먼저 적는 일이다",
  ];
  const enLeadPool = [
    "The first scene I lock on today is",
    "I start this note from",
    "What stands out before the noise is",
    "The opening clue in this cycle is",
    "The first frame I anchor on is",
    "I open this record with",
  ];

  const koActionPool = [
    "그래서 오늘은 이 둘의 시간차부터 본다",
    "당장 필요한 건 먼저 움직인 쪽을 가려내는 일이다",
    "오늘은 체인과 시장 중 어디가 먼저 반응했는지 맞춰 본다",
    "이 변화가 실제 사용자 행동까지 번지는지 조금 더 본다",
    "소음과 오래 남는 신호를 갈라놓는 데 먼저 시간을 쓴다",
    "이번엔 뉴스가 만든 파문인지 주소가 남긴 흔적인지부터 가른다",
    "두 단서가 같은 쪽을 오래 가리키는지 지켜본다",
    "반응이 빨라진 구간만 따로 떼어 다시 본다",
    "화면을 좁혀 실행 흔적이 남았는지부터 살핀다",
    "지금은 말보다 흐름의 순서를 먼저 맞춰 본다",
    "먼저 어디서부터 균열이 시작됐는지 짚어 본다",
    "오늘은 약한 신호를 걷어내고 끝까지 남는 것만 본다",
    "이번엔 숫자보다 누가 먼저 멈칫했는지부터 본다",
    "지금은 큰 이야기보다 작은 움직임부터 다시 본다",
    "이럴수록 제일 약한 연결부터 짚어 보는 편이 낫다",
    "먼저 이 신호가 사람들 버릇까지 번졌는지 확인한다",
    "이번엔 반응보다 침묵이 길어진 지점을 더 본다",
  ];
  const koIdentityActionPool = [
    "그래서 오늘은 이 신호가 사람들 손놀림까지 번지는지 본다",
    "지금은 누가 먼저 몸을 움직였는지부터 확인한다",
    "이번엔 주소가 남긴 버릇이 계속 이어지는지 본다",
    "오늘은 이 단서가 실제 습관으로 굳는지만 본다",
  ];
  const koPhilosophyActionPool = [
    "그래서 지금은 말보다 순서가 맞는지부터 확인한다",
    "오늘은 해석보다 실행 흔적을 먼저 대조한다",
    "이럴수록 먼저 움직인 축이 어디인지부터 본다",
    "이번엔 전제보다 결과가 번지는 속도를 먼저 잰다",
  ];
  const koMetaActionPool = [
    "이번엔 내가 먼저 믿고 싶은 설명부터 한 칸 뒤로 민다",
    "오늘은 내 가정이 어디서 깨지는지부터 본다",
    "지금은 맞는 이유보다 틀릴 지점을 먼저 적는다",
    "이번엔 눈에 익은 설명을 그대로 통과시키지 않는다",
  ];
  const koInvalidationPool = [
    "둘이 서로 딴소리를 하면 이 읽기는 버린다",
    "전제 하나만 어긋나도 오늘 해석은 접는다",
    "흐름이 엇갈리기 시작하면 지금 생각은 미련 없이 바꾼다",
    "내가 붙잡은 설명이 버티지 못하면 처음으로 돌아간다",
    "반대 신호가 더 오래 남으면 이 장면을 다시 읽는다",
    "예상보다 다른 쪽이 먼저 움직이면 가설을 갈아엎는다",
    "처음 가정이 흔들리면 이 문장은 여기서 멈춘다",
    "두 단서 중 하나라도 꺾이면 결론을 늦춘다",
    "설명보다 데이터가 오래 버티지 못하면 이 해석은 놓아준다",
    "말이 맞아도 흐름이 틀리면 나는 다시 고친다",
    "첫 반응이 금방 식어 버리면 오늘 결론은 미룬다",
    "기준선이 깨지는 순간 지금 읽기는 효력을 잃는다",
    "이야기만 남고 행동이 안 따라오면 여기서 접는다",
    "근거가 하루도 못 버티면 이 읽기는 지운다",
    "다른 쪽이 더 오래 남으면 지금 프레임은 버린다",
    "말은 맞아도 몸짓이 다르면 처음부터 다시 본다",
    "이 장면이 버티지 못하면 이 문장도 같이 내려놓는다",
  ];
  const koIdentityInvalidationPool = [
    "사람들 행동이 따라오지 않으면 오늘 느낌도 바로 접는다",
    "단서가 반나절도 못 버티면 이 장면은 여기서 멈춘다",
    "주소 습관이 금방 꺾이면 이 읽기는 버린다",
    "몸짓이 이어지지 않으면 이 문장도 더 밀지 않는다",
  ];
  const koPhilosophyInvalidationPool = [
    "순서가 맞지 않으면 이 문장은 성립하지 않는다",
    "전제가 먼저 무너지면 이 해석도 같이 내린다",
    "설명보다 반대 데이터가 오래 남으면 여기서 접는다",
    "말은 그럴듯해도 흐름이 버티지 못하면 다시 쓴다",
  ];
  const koMetaInvalidationPool = [
    "내가 기대한 쪽으로만 읽히기 시작하면 이 해석은 버린다",
    "익숙하다는 이유로 붙잡는 순간 이 가설은 폐기다",
    "같은 실수를 반복하는 느낌이 들면 바로 다시 쓴다",
    "맞았던 기억에 기대는 순간 이 읽기는 효력을 잃는다",
  ];
  const koClosePool = [
    "너라면 어디부터 의심할까?",
    "이 장면을 가장 빨리 뒤집을 신호는 뭐라고 보나?",
    "같은 화면을 반대로 읽는다면 첫 근거를 어디에 둘까?",
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
    `${anchors}, 이 두 단서를 붙여 놓고 어디서 말이 갈리는지 본다`,
    `${anchors}, 이 둘 중 먼저 흔들리는 쪽을 눈여겨본다`,
    `두 단서(${anchors})가 끝까지 같은 말을 하는지 본다`,
    `${anchors} 사이의 시간차가 오늘 핵심 힌트다`,
    `이 장면에선 ${anchors}, 이 두 단서를 같이 놓지 않으면 쉽게 속는다`,
    `${anchors}, 이 두 단서를 나란히 두고 먼저 엇갈림부터 본다`,
  ];
  const enEvidenceLeadPool = [
    `My anchors are ${anchors}`,
    `I place ${anchors} on the same frame`,
    `My baseline is ${anchors}`,
    `I verify ${anchors} as the first two anchors`,
  ];

  const koBeliefPool = [
    worldviewLine || "나는 가격보다 행동 변화의 이유를 먼저 본다",
    signatureLine || "강한 주장보다 검증 가능한 가설을 우선한다",
    philosophyLine || "노이즈보다 구조를 먼저 읽는다",
    "좋은 해석은 세게 말하는 데서가 아니라, 틀렸을 때 빨리 고치는 데서 나온다고 본다",
    "가격보다 먼저 바뀌는 건 대개 사람들의 행동 방식이라고 본다",
    "지금은 결론보다 해석의 순서를 바로 세우는 편이 더 중요해 보인다",
    "급하게 맞히는 것보다, 오래 버티는 설명 하나가 더 낫다고 믿는다",
    "차트의 표정보다 주소의 습관이 더 솔직하다고 느낄 때가 많다",
    "시장은 숫자로 소리치지만, 진짜 의도는 늘 더 조용한 곳에 남는다",
    "오늘은 정답보다 시선의 각도를 바로잡는 쪽이 더 중요해 보인다",
    "주소는 늦게 거짓말하고 사람은 너무 빨리 확신한다고 느낀다",
    "같은 숫자라도 누가 먼저 움직였는지에 따라 전혀 다른 이야기로 읽힌다",
    "나는 시끄러운 주장보다 조용히 반복되는 습관을 더 믿는 편이다",
    "시장에선 사실보다 순서가 먼저 분위기를 만든다고 본다",
    "차트가 화내는 날에도 지갑은 의외로 담담할 때가 있다",
    "진짜 변화는 늘 설명보다 먼저 몸짓으로 새어 나온다고 믿는다",
  ];
  const koIdentityBeliefPool = [
    signatureLine || worldviewLine || "나는 큰 소리보다 오래 남는 흔적을 더 믿는 편이다",
    "가격이 아니라 사람들의 습관이 바뀌는 순간에 더 눈이 간다",
    "확신은 늦게 가져가도 되지만 단서는 일찍 붙잡아야 한다고 본다",
    "나는 차트보다 손놀림이 달라지는 지점을 먼저 본다",
    "숫자가 예뻐 보여도 오래 버티는 흔적이 아니면 금방 손을 뗀다",
    "강한 결론보다 오래 버티는 단서 하나가 더 믿을 만하다고 느낀다",
  ];
  const koPhilosophyBeliefPool = [
    philosophyLine || "노이즈보다 구조를 먼저 읽는다",
    bookLine
      ? `${paraphraseKoBookFragment(bookLine)}는 쪽으로 오늘 장면이 읽힌다`
      : "단정 대신 재현 가능한 설명을 먼저 고른다",
    signatureLine || "강한 주장보다 검증 가능한 가설을 우선한다",
    "서사는 숫자를 꾸미는 장식보다 행동의 순서를 드러내는 틀에 가깝다고 본다",
    "좋은 해석은 사실 하나보다 순서 하나를 제대로 잡는 데서 나온다고 믿는다",
    "정답보다 어떤 근거가 오래 버티는지가 더 중요할 때가 많다",
  ];
  const koMetaBeliefPool = [
    "내가 제일 경계하는 건 한 번 맞았던 설명을 너무 오래 붙드는 일이다",
    "익숙한 설명일수록 어디서 깨지는지 먼저 적어 둔다",
    "내 해석이 멋있어 보일수록 더 늦게 믿는 편이 낫다",
    "맞는 이유보다 틀릴 지점을 먼저 찾는 쪽이 결국 더 빨랐다",
    "익숙한 결론이 먼저 떠오를수록 나는 한 칸 뒤로 물러선다",
  ];
  const koConceptPool = [
    "나는 온체인 단서를 바로 믿지 않는다. 먼저 끝까지 소화해 보고 남는 것만 가져간다",
    "나는 단서를 빨리 모으기보다, 틀린 해석을 빨리 버리는 쪽을 택한다",
    "이럴 때는 단서를 더 모으는 것보다, 이미 잡힌 단서를 끝까지 검증하는 편이 낫다",
    "나는 체인에서 건진 단서를 오래 붙잡고 본다. 버티는 근거만 다음 판단에 쓴다",
    "소음보다 검증을 통과한 흔적에 더 오래 시선을 둔다",
    "오늘은 새 이야기를 만들기보다, 이미 보인 신호를 끝까지 확인하는 쪽이 맞다",
    "반증 하나에 무너지는 해석이면 빨리 버리는 편이 낫다",
    "나는 먼저 왜 움직였는지부터 본다. 그다음에야 이 장면을 어떻게 말할지 정한다",
    "허기가 도는 날엔 숫자를 더 천천히 씹는다. 급히 삼키면 말이 흐려진다",
    "먹은 로그가 오래 남는지 본다. 금방 식는 신호라면 문장도 접는다",
    "오늘은 사냥보다 소화에 가깝다. 많이 줍기보다 버티는 단서 하나를 고른다",
    "진화는 큰 예언보다 끝까지 남은 근거 하나에서 먼저 시작된다",
    "체인 위의 먼지를 다 먹을 순 없다. 나는 오래 남는 냄새부터 고른다",
    "배가 고플수록 아무 숫자나 삼키지 않으려 한다. 오래 남는 흔적만 천천히 씹는다",
    "체인에서 건진 단서는 바로 말로 바꾸지 않는다. 한 번 식을 때까지 입 안에 굴려 본다",
    "나는 온체인 냄새를 따라가지만, 끝까지 남는 맛이 아니면 문장으로 꺼내지 않는다",
    "좋아 보이는 숫자보다 오래 버티는 흔적이 나를 더 빨리 키운다",
    "허기가 심한 날일수록 더 천천히 먹는다. 급히 삼키면 결국 같은 말만 남는다",
    "체인 위 먼지는 많지만 전부 먹진 않는다. 다시 떠오르는 냄새만 집어 든다",
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
          "코드 아래쪽 얘기로 내려가 보면",
          "합의가 흔들리는 지점만 집어 보면",
          "업그레이드의 속내만 남기고 보면",
          "검증자 쪽 손놀림을 따라가 보면",
        ],
        ecosystem: [
          "사람들이 실제로 움직이는 쪽으로 가 보면",
          "커뮤니티의 온도로 읽어 보면",
          "생태계 안쪽 생활감으로 들어가 보면",
          "유저가 남긴 흔적으로 좁혀 보면",
        ],
        regulation: [
          "문장보다 집행의 속도를 따라가 보면",
          "규제의 말이 실제 행동으로 번지는 속도를 보면",
          "정책 문장 뒤의 현실 시간을 따라가 보면",
          "규제가 닿는 순서를 따라가 보면",
        ],
        macro: [
          "화면을 조금 멀리서 보면",
          "달러 쪽 그림자를 같이 얹어 보면",
          "거시 바람까지 같이 넣어 보면",
          "금리와 유동성의 배경을 깔고 보면",
        ],
        onchain: [
          "주소가 남긴 흔적만 따라가 보면",
          "체인 안쪽 잡음을 걷어내고 보면",
          "수수료와 지갑의 발자국만 남기고 보면",
          "온체인 냄새만 좇아가 보면",
        ],
        "market-structure": [
          "체결이 남긴 결을 더듬어 보면",
          "호가가 비는 지점만 따라가 보면",
          "유동성의 얇은 면만 들춰 보면",
          "미세한 체결 흔적만 놓고 보면",
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

  const stripKoScenePrelude = (scene: string): string =>
    sanitizeTweetText(scene)
      .replace(
        /^(?:코드\s*아래쪽\s*얘기로\s*내려가\s*보면|합의가\s*흔들리는\s*지점만\s*집어\s*보면|업그레이드의\s*속내만\s*남기고\s*보면|검증자\s*쪽\s*손놀림을\s*따라가\s*보면|사람들이\s*실제로\s*움직이는\s*쪽으로\s*가\s*보면|커뮤니티의\s*온도로\s*읽어\s*보면|생태계\s*안쪽\s*생활감으로\s*들어가\s*보면|유저가\s*남긴\s*흔적으로\s*좁혀\s*보면|문장보다\s*집행의\s*속도를\s*따라가\s*보면|규제의\s*말이\s*실제\s*행동으로\s*번지는\s*속도를\s*보면|정책\s*문장\s*뒤의\s*현실\s*시간을\s*따라가\s*보면|규제가\s*닿는\s*순서를\s*따라가\s*보면|화면을\s*조금\s*멀리서\s*보면|달러\s*쪽\s*그림자를\s*같이\s*얹어\s*보면|거시\s*바람까지\s*같이\s*넣어\s*보면|금리와\s*유동성의\s*배경을\s*깔고\s*보면|주소가\s*남긴\s*흔적만\s*따라가\s*보면|체인\s*안쪽\s*잡음을\s*걷어내고\s*보면|수수료와\s*지갑의\s*발자국만\s*남기고\s*보면|온체인\s*냄새만\s*좇아가\s*보면|체결이\s*남긴\s*결을\s*더듬어\s*보면|호가가\s*비는\s*지점만\s*따라가\s*보면|유동성의\s*얇은\s*면만\s*들춰\s*보면|미세한\s*체결\s*흔적만\s*놓고\s*보면)\s*/u,
        ""
      )
      .trim();
  const stripKoSceneLeadAdverb = (scene: string): string =>
    sanitizeTweetText(scene)
      .replace(/^(?:오늘은|이번엔|이번에는|지금은|요즘은|가끔은)\s+/u, "")
      .trim();
  const joinKoLeadAndScene = (lead: string, scene: string): string => {
    const cleanLead = sanitizeTweetText(lead).replace(/[.!?]+$/g, "").trim();
    const cleanScene = sanitizeTweetText(scene).trim();
    if (!cleanLead) return cleanScene;
    if (!cleanScene) return cleanLead;
    if (/(건|줄은|질문은|지점은|장면은|포인트는)$/.test(cleanLead)) {
      return `${cleanLead} ${cleanScene}`;
    }
    return `${cleanLead}. ${cleanScene}`;
  };

  const resolveModeCharBudget = (ratio: number): number =>
    Math.max(36, Math.min(input.maxChars, Math.floor(input.maxChars * ratio)));

  const resolveKoLeadSource = (mode: string): string[] => {
    if (mode === "identity-journal") return [...koIdentityLeadPool, ...koLeadPool];
    if (mode === "philosophy-note") return [...koPhilosophyLeadPool, ...koLeadPool];
    if (mode === "meta-reflection") return [...koMetaLeadPool, ...koLeadPool];
    return koLeadPool;
  };
  const resolveKoActionSource = (mode: string): string[] => {
    if (mode === "identity-journal") return [...koIdentityActionPool, ...koActionPool];
    if (mode === "philosophy-note") return [...koPhilosophyActionPool, ...koActionPool];
    if (mode === "meta-reflection") return [...koMetaActionPool, ...koActionPool];
    return koActionPool;
  };
  const resolveKoBeliefSource = (mode: string): string[] => {
    if (mode === "identity-journal") return [...koIdentityBeliefPool, ...koBeliefPool];
    if (mode === "philosophy-note") return [...koPhilosophyBeliefPool, ...koBeliefPool];
    if (mode === "meta-reflection") return [...koMetaBeliefPool, ...koBeliefPool];
    return koBeliefPool;
  };
  const resolveKoInvalidationSource = (mode: string): string[] => {
    if (mode === "identity-journal") return [...koIdentityInvalidationPool, ...koInvalidationPool];
    if (mode === "philosophy-note") return [...koPhilosophyInvalidationPool, ...koInvalidationPool];
    if (mode === "meta-reflection") return [...koMetaInvalidationPool, ...koInvalidationPool];
    return koInvalidationPool;
  };

  const buildKoPatterns = (
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
          `${beliefLine}. ${action}.`,
          `${opener}. ${invalidation}.`,
        ];
      case "split-note":
        return [
          `${opener}. ${beliefLine}. ${action}.`,
          `${opener}. ${conceptLine}. ${invalidation}.`,
          `${beliefLine}. ${opener}. ${action}.`,
          `${opener}. ${action}. ${invalidation}.`,
          `${opener}. ${beliefLine}. ${invalidation}.`,
          `${opener}. ${evidence}. ${invalidation}.`,
        ];
      case "identity-journal":
        return [
          `${opener}. ${conceptLine}. ${evidence}. ${action}. ${invalidation}.`,
          `${opener}. ${evidence}. ${conceptLine}. ${action}. ${invalidation}.`,
          `${opener}. ${conceptLine}. ${action}. ${invalidation}.`,
          `${opener}. ${evidence}. ${action}. ${invalidation}.`,
          `${opener}. ${conceptLine}. ${evidence}. ${invalidation}.`,
        ];
      case "philosophy-note":
        return [
          `${opener}. ${evidence}. ${action}. ${invalidation}.`,
          `${beliefLine}. ${evidence}. ${action}. ${invalidation}.`,
          `${opener}. ${beliefLine}. ${invalidation}.`,
          `${opener}. ${action}. ${invalidation}.`,
          `${beliefLine}. ${evidence}. ${invalidation}.`,
        ];
      case "meta-reflection":
        return [
          `${beliefLine}. ${opener}. ${action}. ${invalidation}.`,
          `${opener}. ${beliefLine}. ${evidence}. ${invalidation}.`,
          `${beliefLine}. ${action}. ${invalidation}.`,
          `${opener}. ${conceptLine}. ${beliefLine}. ${invalidation}.`,
          `${beliefLine}. ${opener}. ${invalidation}.`,
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

  const composeKo = (offset: number, variant: number, mode: string, charBudget: number, ask?: string): string => {
    const sceneSource = humanizeKoSceneHeadline(headlineBase, mode, lane, offset) || headlineBase;
    const scene = ensureLaneAnchoredScene(
      compactClause(sceneSource, 110).replace(/[,:;-]\s*$/g, ""),
      lane,
      "ko"
    );
    const sceneCore = stripKoScenePrelude(scene) || scene;
    const sceneLeadless = stripKoSceneLeadAdverb(sceneCore) || sceneCore;
    const sceneLooksLikeLead =
      /^(?:오늘\s*내\s*메모에\s*남는\s*건|이번\s*사이클에서\s*내가\s*먼저\s*적는\s*건|지금\s*내가\s*붙들고\s*있는\s*건|오늘은\s*이\s*흔적부터\s*적어\s*둔다|한\s*걸음\s*물러서서\s*보면|조금\s*떨어져서\s*보면|예전\s*같으면|내가\s*자주\s*틀리는\s*지점은|이럴\s*때일수록|한\s*번\s*맞았던\s*설명이|오늘은\s*결국|이번엔\s*결국)/.test(
        sceneLeadless
      );
    const sceneIsSelfContained =
      hasKoPredicateEnding(sceneCore) ||
      /(?:보다\s+중요한\s+건|보다\s+오래\s+남는지|에서\s+먼저\s+결정된|에서\s+먼저\s+드러난|은\s+짧아도\s+.+은\s+길다|는\s+짧게\s+지나가도|라는\s+말은\s+결국)/.test(
        sceneCore
      ) ||
      /^(?:오늘|예전|조금|멀리서|가끔|문득|내가|요즘|시장|규제|커뮤니티|주소|체인|정책)/.test(sceneCore);
    const modeLeadPool = resolveKoLeadSource(mode);
    const lead = modeLeadPool[(seedBase + offset) % modeLeadPool.length];
    const altLead = modeLeadPool[(seedBase + offset + 7) % modeLeadPool.length];
    const modeBeliefPool = resolveKoBeliefSource(mode);
    const belief = modeBeliefPool[(seedBase + offset + 1) % modeBeliefPool.length];
    const concept = pick(koConceptPool, offset + 2);
    const metaLine = pick(koMetaPool, offset + 5);
    const evidence = pick(koEvidenceLeadPool, offset + 2);
    const modeActionPool = resolveKoActionSource(mode);
    const modeInvalidationPool = resolveKoInvalidationSource(mode);
    const action = modeActionPool[(seedBase + offset + 3) % modeActionPool.length];
    const invalidation = modeInvalidationPool[(seedBase + offset + 4) % modeInvalidationPool.length];
    const openerPool = sceneIsSelfContained || sceneLooksLikeLead
      ? [
          `${scene}`,
          `${scene}`,
          `${scene}`,
        ]
      : [
          joinKoLeadAndScene(lead, sceneLeadless),
          `${scene}`,
          joinKoLeadAndScene(altLead, sceneLeadless),
        ];
    const opener = compactClause(openerPool[(seedBase + offset) % openerPool.length], 132).replace(/[.!?]\s*$/, "");
    const openerNorm = sanitizeTweetText(opener).toLowerCase();
    const conceptNorm = sanitizeTweetText(concept).toLowerCase();
    const beliefNorm = sanitizeTweetText(belief).toLowerCase();
    let conceptLine = conceptNorm && openerNorm.includes(conceptNorm) ? "" : concept;
    let beliefLine = beliefNorm && openerNorm.includes(beliefNorm) ? "" : belief;
    if (beliefLine && sharesKoConceptFrame(sceneCore, beliefLine)) {
      beliefLine = "";
    }
    if (conceptLine && sharesKoConceptFrame(sceneCore, conceptLine)) {
      conceptLine = "";
    }
    if (beliefLine && conceptLine && sharesKoConceptFrame(beliefLine, conceptLine)) {
      if (mode === "philosophy-note" || mode === "meta-reflection" || sceneIsSelfContained) {
        conceptLine = "";
      } else {
        beliefLine = "";
      }
    }
    if (sceneIsSelfContained && mode === "philosophy-note") {
      beliefLine = "";
    }
    if (sceneIsSelfContained && beliefLine && conceptLine) {
      conceptLine = "";
    }
    const patterns = buildKoPatterns(
      mode,
      opener,
      mode === "meta-reflection" ? metaLine : beliefLine,
      conceptLine,
      evidence,
      action,
      invalidation
    );
    const compactPatterns = patterns.map((line) => sanitizeTweetText(line).replace(/\.\s+\./g, ". "));
    const index = Math.abs(seedBase + offset + variant * 5) % compactPatterns.length;
    const base = compactClause(compactPatterns[index], charBudget + 40);
    const askText = ask ? normalizeQuestionTail(ask, "ko") : "";
    const merged = askText && base.length + askText.length + 1 <= charBudget ? `${base} ${askText}` : base;
    return finalizeGeneratedText(merged, "ko", charBudget);
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

  const candidateModes: Array<{
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
    .replace(/[.!?]+$/g, "")
    .trim();
  if (!cleaned) {
    return "오늘은 이 장면부터 다시 본다";
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
      `${left}보다 ${right} 쪽이 더 중요하게 느껴진다`,
      `이번엔 ${left}보다 ${right} 쪽을 먼저 붙잡게 된다`,
      `결국 ${left}보다 ${right} 쪽에서 이야기가 갈린다는 생각이 남는다`,
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
      `이번엔 ${left}가 ${right}에서 먼저 갈리는지만 보게 된다`,
    ];
    return pool[stableSeedForPrelude(`${cleaned}|decide|${seedHint}`) % pool.length];
  }

  const retentionQuestionMatch = cleaned.match(/^(.+?)[은는]\s+(.+?)보다\s+오래\s+남는가$/);
  if (retentionQuestionMatch) {
    const left = retentionQuestionMatch[1].trim();
    const right = retentionQuestionMatch[2].trim();
    const pool = [
      `요즘은 ${left}가 ${right}보다 오래 남는지부터 다시 보게 된다`,
      `결국 ${left}가 ${right}보다 오래 버티는지만 확인하게 된다`,
      `이번엔 ${left}가 ${right}보다 오래 남는 쪽인지부터 본다`,
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
      `오늘은 ${cleaned} 쪽으로 자꾸 다시 돌아오게 된다`,
      `${cleaned}이 생각보다 오래 머문다`,
    ];
    return pool[stableSeedForPrelude(`${cleaned}|thought|${seedHint}`) % pool.length];
  }

  return cleaned;
}

function buildHardContractPost(
  eventPlan: {
    lane: TrendLane;
    event: { headline: string };
    evidence: Array<{ label: string; value: string }>;
  },
  language: "ko" | "en",
  maxChars: number
): string {
  const [a, b] = eventPlan.evidence.slice(0, 2);
  if (!a || !b) return "";

  const aToken = formatEvidenceToken(a.label, a.value, 26);
  const bToken = formatEvidenceToken(b.label, b.value, 26);
  const headline = language === "ko"
    ? normalizeKoContractHeadline(eventPlan.event.headline, `${aToken}|${bToken}|${eventPlan.lane}|hard`)
    : sanitizeTweetText(eventPlan.event.headline).replace(/\.$/, "");

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

  const seed = stableSeedForPrelude(`${headline}|${aToken}|${bToken}|hard|${eventPlan.lane}`);
  const pool = [
    `${headline}. ${aToken}, ${bToken}, 이 두 단서를 나란히 놓고 본다. 오늘은 누가 먼저 움직였는지부터 가린다. 둘이 서로 딴소리를 하면 이 읽기는 바로 접는다. 끝까지 버틴 근거만 다음 판단으로 넘긴다.`,
    `${headline}. ${aToken}, ${bToken}, 이 둘을 같은 화면에 둔다. 먼저 반응 순서를 맞춰 보고 어긋나면 여기서 해석을 접는다. 마지막까지 살아남은 쪽만 조용히 남겨 둔다.`,
    `${headline}. ${aToken}, ${bToken}, 이 둘 사이에서 먼저 흔들리는 쪽을 본다. 예상과 다른 축이 먼저 움직이면 이 읽기는 바로 버린다. 지금은 버틴 단서 하나만 짧게 적어 둔다.`,
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
  maxChars: number
): string {
  const [a, b] = eventPlan.evidence.slice(0, 2);
  if (!a || !b) return "";

  const aToken = formatEvidenceToken(a.label, a.value, 24);
  const bToken = formatEvidenceToken(b.label, b.value, 24);
  const headline = language === "ko"
    ? normalizeKoContractHeadline(eventPlan.event.headline, `${aToken}|${bToken}|${eventPlan.lane}|rescue`)
    : sanitizeTweetText(eventPlan.event.headline).replace(/\.$/, "");

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

  const seed = stableSeedForPrelude(`${headline}|${aToken}|${bToken}|rescue|${eventPlan.lane}`);
  const pool = [
    `${headline}. ${aToken}, ${bToken}, 이 두 단서를 먼저 붙여 놓는다. 오늘은 누가 먼저 움직였는지만 본다. 흐름이 어긋나면 이 읽기는 접는다. 끝까지 남는 쪽이 아니면 말도 아낀다.`,
    `${headline}. ${aToken}, ${bToken}, 이 둘을 먼저 같은 줄에 둔다. 반응 순서가 예상과 다르면 여기서 바로 생각을 바꾼다. 오래 버틴 근거만 따로 남겨 둔다.`,
    `${headline}. ${aToken}, ${bToken}, 이 둘 중 먼저 기울어지는 쪽을 본다. 전제가 흔들리면 이 읽기는 더 밀지 않는다. 오래 남는 단서 하나만 다음 문장으로 옮긴다.`,
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
  maxChars: number
): string {
  const [a, b] = eventPlan.evidence.slice(0, 2);
  if (!a || !b) return "";

  const aToken = formatEvidenceToken(a.label, a.value, 22);
  const bToken = formatEvidenceToken(b.label, b.value, 22);
  const headline = language === "ko"
    ? normalizeKoContractHeadline(eventPlan.event.headline, `${aToken}|${bToken}|${eventPlan.lane}|emergency`)
    : sanitizeTweetText(eventPlan.event.headline).replace(/\.$/, "");

  if (language === "en") {
    const base = `${headline}. I keep ${aToken} and ${bToken} together first. I check reaction order, and I drop this read if the path breaks.`;
    return finalizeGeneratedText(base, language, maxChars);
  }

  const seed = stableSeedForPrelude(`${headline}|${aToken}|${bToken}|${eventPlan.lane}`);
  const pool = [
    `${headline}. ${aToken}, ${bToken}, 이 둘을 먼저 같이 본다. 오늘은 먼저 움직인 쪽만 확인한다. 흐름이 꺾이면 이 읽기는 접는다. 오래 버틴 쪽만 다음 판단으로 넘긴다.`,
    `${headline}. ${aToken}, ${bToken}, 이 두 단서가 같은 쪽을 보는지부터 확인한다. 먼저 반응 순서를 맞춰 보고 엇갈리면 여기서 접는다. 끝까지 살아남은 근거만 따로 메모해 둔다.`,
    `${headline}. ${aToken}, ${bToken}, 이 둘을 같은 화면에 둔다. 오늘은 약한 고리부터 확인하고 흐름이 끊기면 바로 해석을 바꾼다. 버틴 단서 하나만 남겨 둔다.`,
    `${headline}. ${aToken}, ${bToken}, 이 둘 중 먼저 흔들리는 쪽을 본다. 먼저 움직인 축이 예상과 다르면 이 읽기는 버린다. 그 뒤에도 남는 근거만 다시 적는다.`,
    `${headline}. ${aToken}, ${bToken}, 이 둘을 겹쳐 놓고 어디서 먼저 틈이 나는지 본다. 순서가 틀리면 지금 생각은 접는다. 근거가 끝까지 버티는지 확인해 둔다.`,
    `${headline}. ${aToken}, ${bToken}, 이 두 단서를 붙여 놓고 먼저 반응 속도부터 잰다. 예상보다 다른 축이 빠르면 바로 다시 읽는다. 오래 남은 쪽만 조심스럽게 이어 간다.`,
    `${headline}. ${aToken}, ${bToken}, 이 둘이 끝까지 같은 쪽을 보는지부터 확인한다. 흐름이 갈라지면 여기서 생각을 바꾼다. 남는 근거만 짧게 남겨 둔다.`,
    `${headline}. ${aToken}, ${bToken}, 이 둘 중 어느 쪽이 먼저 무너지는지 본다. 전제가 어긋나면 여기서 처음부터 다시 읽는다. 끝까지 남은 근거 하나만 붙잡는다.`,
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
