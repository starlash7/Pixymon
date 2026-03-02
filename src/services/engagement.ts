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
  DEFAULT_OBSERVABILITY_SETTINGS,
  DEFAULT_X_API_COST_SETTINGS,
} from "../config/runtime.js";
import {
  ContentLanguage,
  EngagementRuntimeSettings,
  ObservabilityRuntimeSettings,
  XApiCostRuntimeSettings,
} from "../types/runtime.js";
import {
  collectTrendContext,
  formatMarketAnchors,
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
  evaluatePostQuality,
  evaluateReplyQuality,
  resolveContentQualityRules,
  sanitizeTweetText,
} from "./engagement/quality.js";
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

interface EngagementCycleCache {
  trendContext?: CachedTrendContext;
  trendTweets?: CachedTrendTweets;
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
}

const onchainDataService = new OnchainDataService();

export async function checkAndReplyMentions(
  twitter: TwitterApi,
  claude: Anthropic,
  maxMentionsToProcess: number = 5,
  timezone: string = DEFAULT_TIMEZONE,
  xApiCostSettings: XApiCostRuntimeSettings = DEFAULT_X_API_COST_SETTINGS
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
  cache?: EngagementCycleCache
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
- 확신이 낮으면 질문형으로 끝낸다.`;

      const userPrompt =
        lang === "ko"
          ? `아래 컨텍스트로 답글 1개 작성.

오늘 트렌드 요약:
${trend.summary}

타겟 트윗:
\"${text}\"

규칙:
- 180자 이내
- 톤 가이드:
${toneGuide}
- 해시태그/이모지 금지
- 숫자 왜곡 금지
- 본문만 출력`
          : `Write one concise reply using this context.

Trend summary:
${trend.summary}

Target tweet:
\"${text}\"

Rules:
- Max 180 chars
- Tone guide:
${toneGuide}
- No hashtags or emoji
- Do not invent numbers
- Output reply text only`;

      const message = await claude.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 220,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      });

      let replyText = sanitizeTweetText(extractTextFromClaude(message.content));
      if (!replyText || replyText.length < 5) continue;

      if (detectLanguage(replyText) !== lang) {
        const rewritten = await rewriteByLanguage(claude, replyText, lang, 180);
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
  feedNutrients: OnchainNutrient[] = []
): Promise<boolean> {
  console.log("\n[POST] 트렌드 요약 글 작성 시작...");
  const runtimeSettings = resolveEngagementSettings(settings);

  try {
    const trend = await getOrCreateTrendContext(cache, {
      minNewsSourceTrust: runtimeSettings.minNewsSourceTrust,
    });

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
        const previewAnchors = formatMarketAnchors(trend.marketData);
        const previewCandidates = buildPreviewFallbackCandidates({
          headline: previewHeadline,
          anchors: previewAnchors,
          language: runtimeSettings.postLanguage,
          recentPosts: recentBriefingPosts,
          intentLine: soulIntent.intentLine,
          activeQuestion: soulIntent.activeQuestion,
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
          return evaluatePostQuality(candidate.text, trend.marketData, [], previewPolicy, previewBaseQuality).ok;
        });
        if (!selectedPreview) {
          console.log("[POST] TEST_MODE preview fallback 스킵: 품질 게이트 통과 후보 없음");
          return false;
        }
        const previewId = await postTweet(twitter, selectedPreview.text, "briefing", {
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
    const requiredTrendTokens = [...new Set([...trendFocus.requiredTokens, ...eventPlan.event.keywords])].slice(0, 6);
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
    const soulContext = memory.getSoulPromptContext(runtimeSettings.postLanguage);
    const autonomyContext = memory.getAutonomyPromptContext(runtimeSettings.postLanguage);

    if (TEST_NO_EXTERNAL_CALLS) {
      const localFallback = buildEventEvidenceFallbackPost(
        eventPlan,
        runtimeSettings.postLanguage,
        runtimeSettings.postMaxChars
      );
      if (localFallback) {
        let localPost = applySoulPreludeToFallback(
          localFallback,
          soulIntent.intentLine,
          runtimeSettings.postLanguage,
          runtimeSettings.postMaxChars
        );
        if (startsWithFearGreedTemplate(localPost)) {
          localPost = `오늘 핵심 이벤트는 ${eventPlan.event.headline}. ${localPost}`.slice(0, runtimeSettings.postMaxChars);
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
          { requiredTrendTokens }
        );

        if (localContract.ok && localNovelty.ok && localQuality.ok) {
          postText = localPost;
          usedFallback = true;
          generationAttempts = 1;
          console.log("[POST] TEST-LOCAL deterministic 본문 사용 (LLM 외부 호출 없음)");
        } else {
          latestFailReason = [
            localContract.ok ? "" : `contract:${localContract.reason}`,
            localNovelty.ok ? "" : `novelty:${localNovelty.reason}`,
            localQuality.ok ? "" : `quality:${localQuality.reason}`,
          ]
            .filter(Boolean)
            .join("|");
          console.log(`[POST] TEST-LOCAL fallback 실패: ${latestFailReason}`);
        }
      } else {
        latestFailReason = "local-fallback-empty";
        console.log("[POST] TEST-LOCAL fallback 실패: 텍스트 생성 불가");
      }
    } else {
      for (let attempt = 0; attempt < runtimeSettings.postGenerationMaxAttempts; attempt++) {
        generationAttempts = attempt + 1;
        const userPrompt =
        runtimeSettings.postLanguage === "ko"
          ? `아래 컨텍스트로 오늘의 트렌드 글 1개 작성.

캐릭터 인텐트(최우선):
- 욕구: ${soulIntent.primaryDesire}
- 보조 욕구: ${soulIntent.secondaryDesire}
- 두려움: ${soulIntent.fear}
- 회피 패턴: ${soulIntent.avoidancePattern}
- 열린 질문: ${soulIntent.activeQuestion}
- 서사 폼: ${soulIntent.narrativeForm}
- 아크 단계: ${soulIntent.arcStage}
- 문체 지시: ${soulIntent.styleDirective}

핵심 이벤트(1개 고정):
${eventPlan.event.headline}

근거 2개(둘 다 필수):
1) ${eventPlan.evidence[0].label} ${eventPlan.evidence[0].value}
2) ${eventPlan.evidence[1].label} ${eventPlan.evidence[1].value}

Narrative lane: ${eventPlan.lane}
Narrative mode: ${narrativePlan.mode}
오프닝 가이드: ${narrativePlan.openingDirective}
본문 가이드: ${narrativePlan.bodyDirective}
엔딩 가이드: ${narrativePlan.endingDirective}

트렌드 요약:
${trend.summary}

이벤트 키워드:
${focusTokensLine}

최근 작성 글(반복 금지):
${recentContext}

자율성 메모리(열린 스레드/가설):
${autonomyContext}

Soul 상태:
${soulContext}

직전 실패 원인:
${rejectionFeedback || "없음"}

규칙:
- ${runtimeSettings.postMaxChars}자 이내
- 반드시 한국어
- 반드시 1인칭 캐릭터 시점
- 해시태그/이모지 금지
- 과장/확정적 투자 조언 금지
- 금기 없이 자유롭게 상상해도 되지만 숫자/사실 왜곡 금지
- 반드시 \"이벤트 1개 + 근거 2개\" 구조 유지
- 같은 시작 문장/템플릿 반복 금지
- \"극공포/FGI\"로 문장 시작 금지
- ${postDiversityGuard.ruleLineKo}
- 트윗 본문만 출력`
          : `Write one trend post for today.

Character intent (highest priority):
- Primary desire: ${soulIntent.primaryDesire}
- Secondary desire: ${soulIntent.secondaryDesire}
- Fear: ${soulIntent.fear}
- Avoidance pattern: ${soulIntent.avoidancePattern}
- Open question: ${soulIntent.activeQuestion}
- Narrative form: ${soulIntent.narrativeForm}
- Arc stage: ${soulIntent.arcStage}
- Voice directive: ${soulIntent.styleDirective}

Primary event (exactly one):
${eventPlan.event.headline}

Required evidence (must include both):
1) ${eventPlan.evidence[0].label} ${eventPlan.evidence[0].value}
2) ${eventPlan.evidence[1].label} ${eventPlan.evidence[1].value}

Narrative lane: ${eventPlan.lane}
Narrative mode: ${narrativePlan.mode}
Opening directive: ${narrativePlan.openingDirective}
Body directive: ${narrativePlan.bodyDirective}
Ending directive: ${narrativePlan.endingDirective}

Trend summary:
${trend.summary}

Event tokens:
${focusTokensLine}

Recent posts (avoid repetition):
${recentContext}

Autonomy memory (active threads/hypotheses):
${autonomyContext}

Soul snapshot:
${soulContext}

Last rejection reason:
${rejectionFeedback || "none"}

Rules:
- Max ${runtimeSettings.postMaxChars} chars
- Write in English
- Keep first-person character perspective
- No hashtags or emoji
- No financial certainty claims
- You can be imaginative, but do not fabricate numbers/facts
- Keep strict structure: one event + two evidence anchors
- Avoid repeated opening templates
- Do not start with fear/greed index phrasing
- ${postDiversityGuard.ruleLineEn}
- Output tweet text only`;

        const message = await claude.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 340,
        system: `${PIXYMON_SYSTEM_PROMPT}

추가 운영 규칙:
- 스토리텔링은 허용하지만 수치/사실은 입력 근거에서만 사용.
- 문장 반복, 클리셰 오프너, 포맷 복붙을 피한다.
- 오늘은 lane과 mode를 따라 글 톤을 바꾼다.`,
        messages: [{ role: "user", content: userPrompt }],
      });

        let candidate = sanitizeTweetText(extractTextFromClaude(message.content));
        if (!candidate || candidate.length < runtimeSettings.postMinLength) {
          rejectionFeedback = "문장이 비어있거나 너무 짧음";
          continue;
        }

        if (detectLanguage(candidate) !== runtimeSettings.postLanguage) {
          const rewritten = await rewriteByLanguage(
            claude,
            candidate,
            runtimeSettings.postLanguage,
            runtimeSettings.postMaxChars
          );
          if (rewritten) {
            candidate = rewritten;
          }
        }

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
      let fallbackPost: string | null = buildEventEvidenceFallbackPost(
        eventPlan,
        runtimeSettings.postLanguage,
        runtimeSettings.postMaxChars
      );
      if (fallbackPost) {
        fallbackPost = applySoulPreludeToFallback(
          fallbackPost,
          soulIntent.intentLine,
          runtimeSettings.postLanguage,
          runtimeSettings.postMaxChars
        );
      }
      if (fallbackPost && !TEST_NO_EXTERNAL_CALLS && detectLanguage(fallbackPost) !== runtimeSettings.postLanguage) {
        const rewrittenFallback = await rewriteByLanguage(
          claude,
          fallbackPost,
          runtimeSettings.postLanguage,
          runtimeSettings.postMaxChars
        );
        if (rewrittenFallback) {
          fallbackPost = rewrittenFallback;
        }
      }
      if (fallbackPost && startsWithFearGreedTemplate(fallbackPost)) {
        fallbackPost = `오늘 핵심 이벤트는 ${eventPlan.event.headline}. ${fallbackPost}`.slice(0, runtimeSettings.postMaxChars);
      }
      if (fallbackPost) {
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
        if (!fallbackNovelty.ok || fallbackNovelty.score < 0.55) {
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
          { requiredTrendTokens }
        );
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
  cache?: EngagementCycleCache
): Promise<boolean> {
  console.log("\n[QUOTE] 트렌드 인용 글 작성 시작...");
  const runtimeSettings = resolveEngagementSettings(settings);
  const quoteLanguage: ContentLanguage =
    runtimeSettings.enforceKoreanPosts ? "ko" : runtimeSettings.postLanguage;

  try {
    const trend = await getOrCreateTrendContext(cache, {
      minNewsSourceTrust: runtimeSettings.minNewsSourceTrust,
    });
    const candidates = await getOrSearchTrendTweets(
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
    const marketAnchors = formatMarketAnchors(trend.marketData)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 2);

    for (const target of candidates) {
      const targetId = String(target.id || "").trim();
      const targetText = sanitizeTweetText(String(target.text || ""));
      if (!targetId || targetText.length < 25) continue;
      if (memory.hasRepliedTo(targetId)) continue;

      const lane = inferTrendLaneFromText(targetText);
      const seed = buildQuoteReplySeed({
        lane,
        eventHeadline: targetText,
        evidence: marketAnchors,
        language: quoteLanguage,
      });

      const userPrompt =
        quoteLanguage === "ko"
          ? `아래 트윗을 인용해서 Pixymon 스타일 코멘트 1개 작성.

원문:
\"${targetText}\"

시드:
${seed}

트렌드 요약:
${trend.summary}

규칙:
- ${runtimeSettings.postMaxChars}자 이내
- 한국어
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
${trend.summary}

Rules:
- Max ${runtimeSettings.postMaxChars} chars
- English only
- Do not fabricate numbers/facts
- No certainty investment claims
- No hashtags or emoji
- Output quote text only`;

      const message = await claude.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 280,
        system: PIXYMON_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
      });

      let quoteText = sanitizeTweetText(extractTextFromClaude(message.content));
      if (!quoteText || quoteText.length < runtimeSettings.postMinLength) continue;

      if (detectLanguage(quoteText) !== quoteLanguage) {
        const rewritten = await rewriteByLanguage(
          claude,
          quoteText,
          quoteLanguage,
          runtimeSettings.postMaxChars
        );
        if (rewritten) {
          quoteText = rewritten;
        }
      }

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

    console.log("[QUOTE] 품질 기준을 만족하는 인용 글 생성 실패");
    return false;
  } catch (error) {
    console.error("[ERROR] 인용 글 작성 실패:", error);
    return false;
  }
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

    return {
      intakeCount: digested.intakeCount,
      acceptedCount: digested.acceptedCount,
      avgDigestScore: digested.avgDigestScore,
      xpGainTotal: digested.xpGainTotal,
      evolvedCount,
      rejectReasonsTop,
      acceptedNutrients: digested.records
        .filter((row) => row.accepted)
        .map((row) => ({
          ...row.nutrient,
          metadata: {
            ...(row.nutrient.metadata || {}),
            digestScore: row.digest.total,
          },
        })),
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
    xApiCostSettings
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
        feedDigest.acceptedNutrients
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
        cycleCache
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
          cycleCache
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
          feedDigest.acceptedNutrients
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
          cycleCache
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

  console.log(`[LOOP] 고정 시간 스케줄 없이 자율 루프 실행 (${minLoop}~${maxLoop}분 간격)`);
  console.log(`[LOOP] 언어 설정: post=${runtimeSettings.postLanguage}, reply=${runtimeSettings.replyLanguageMode}`);
  console.log(
    `[LOOP] X budget: $${xApiCostSettings.dailyMaxUsd.toFixed(2)}/day, read=${xApiCostSettings.dailyReadRequestLimit}, create=${xApiCostSettings.dailyCreateRequestLimit}, mention>=${xApiCostSettings.mentionReadMinIntervalMinutes}m, trend>=${xApiCostSettings.trendReadMinIntervalMinutes}m, create>=${xApiCostSettings.createMinIntervalMinutes}m`
  );

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
  lang: ContentLanguage,
  maxChars: number
): Promise<string | null> {
  if (TEST_NO_EXTERNAL_CALLS) {
    const normalized = sanitizeTweetText(text);
    if (!normalized) return null;
    return normalized.slice(0, maxChars);
  }

  try {
    const prompt =
      lang === "ko"
        ? `아래 문장을 자연스러운 한국어 한 줄로 다시 써줘.

원문:\n${text}

규칙:
- ${maxChars}자 이내
- 의미 유지
- 해시태그/이모지 금지
- 최종 문장만 출력`
        : `Rewrite the text in natural English, one line.

Original:\n${text}

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
    metrics.trendContextHits +
    metrics.trendContextMisses +
    metrics.trendTweetsHits +
    metrics.trendTweetsMisses;
  if (total === 0) return;
  console.log(
    `[CACHE] trendCtx ${metrics.trendContextHits}/${metrics.trendContextMisses} | trendTweets ${metrics.trendTweetsHits}/${metrics.trendTweetsMisses}`
  );
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
  intentLine?: string;
  activeQuestion?: string;
  preferredForm?: string;
  maxChars: number;
}

function buildPreviewFallbackCandidates(input: BuildPreviewFallbackCandidatesInput): PreviewFallbackCandidate[] {
  const headline = sanitizeTweetText(input.headline || "").replace(/\.$/, "") || "단일 이벤트 확정이 어려운 장세";
  const anchors = sanitizeTweetText(input.anchors || "");
  const intentLine = sanitizeTweetText(input.intentLine || "");
  const activeQuestion = sanitizeTweetText(input.activeQuestion || "");
  const lane = inferTrendLaneFromText(headline);
  const recentOpeners = new Set(
    input.recentPosts
      .slice(-6)
      .map((post) => sanitizeTweetText(post.content).slice(0, 24).toLowerCase())
      .filter(Boolean)
  );

  const rawCandidates: PreviewFallbackCandidate[] =
    input.language === "ko"
      ? [
          {
            mode: "field-journal",
            lane,
            text: `나는 지금 ${intentLine || "핵심 신호를 찾아내고 싶다"}. 관찰 노트: ${headline}. ${anchors} 기준으로 먼저 검증 포인트를 쌓는다.`,
          },
          {
            mode: "hypothesis-lab",
            lane,
            text: `가설 메모: ${headline}. ${anchors}에서 동시 확인되는 신호가 늘면 다음 사이클에 강한 주장으로 전환한다. 질문: ${activeQuestion || "지금 신호는 노이즈일까?"}`,
          },
          {
            mode: "risk-radar",
            lane,
            text: `리스크 체크: ${headline}. ${anchors}. 아직 이벤트 하나로 수렴되지 않아 과도한 확신은 보류한다. ${activeQuestion || ""}`,
          },
          {
            mode: "quest-log",
            lane,
            text: `퀘스트 로그: ${headline}. ${anchors}. 다음 업데이트에서는 근거 2개 이상 합치면 방향성을 확정하겠다.`,
          },
        ]
      : [
          {
            mode: "field-journal",
            lane,
            text: `I am tracking this on purpose: ${intentLine || "find the dominant signal before the crowd"}. Field note: ${headline}. ${anchors}.`,
          },
          {
            mode: "hypothesis-lab",
            lane,
            text: `Hypothesis lab: ${headline}. ${anchors}. I will escalate conviction only when two anchors align. Question: ${activeQuestion || "signal or noise?"}`,
          },
          {
            mode: "risk-radar",
            lane,
            text: `Risk radar: ${headline}. ${anchors}. Signals are still fragmented, so confidence stays capped. ${activeQuestion || ""}`,
          },
          {
            mode: "quest-log",
            lane,
            text: `Quest log: ${headline}. ${anchors}. Next cycle I will confirm whether this turns into a dominant event.`,
          },
        ];

  return rawCandidates
    .map((candidate) => ({
      ...candidate,
      text: sanitizeTweetText(candidate.text).slice(0, input.maxChars),
    }))
    .sort((a, b) => {
      const preferred = String(input.preferredForm || "").toLowerCase();
      const aPref = preferred && a.mode.toLowerCase().includes(preferred) ? -1 : 0;
      const bPref = preferred && b.mode.toLowerCase().includes(preferred) ? -1 : 0;
      if (aPref !== bPref) return aPref - bPref;
      return 0;
    })
    .sort((a, b) => {
      const aSeen = recentOpeners.has(a.text.slice(0, 24).toLowerCase()) ? 1 : 0;
      const bSeen = recentOpeners.has(b.text.slice(0, 24).toLowerCase()) ? 1 : 0;
      return aSeen - bSeen;
    });
}

function applySoulPreludeToFallback(
  text: string,
  intentLine: string,
  language: "ko" | "en",
  maxChars: number
): string {
  const body = sanitizeTweetText(text);
  const intent = sanitizeTweetText(intentLine || "");
  if (!intent) {
    return body.slice(0, maxChars);
  }
  const prelude = language === "ko" ? `나는 ${intent}.` : `I am focused on this: ${intent}.`;
  return sanitizeTweetText(`${prelude} ${body}`).slice(0, maxChars);
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
