import fs from "fs";
import path from "path";
import { TwitterApi } from "twitter-api-v2";
import Anthropic from "@anthropic-ai/sdk";
import { memory } from "./memory.js";
import {
  CLAUDE_MODEL,
  PIXYMON_SYSTEM_PROMPT,
  extractTextFromClaude,
  getReplyToneGuide,
  requestBudgetedClaudeMessage,
} from "./llm.js";
import { TrendLane } from "../types/agent.js";
import { detectLanguage } from "../utils/mood.js";
import { evaluateTrendCandidate } from "./content-guard.js";
import { TrendTweetSearchRules } from "./engagement/types.js";
import { sanitizeTweetText } from "./engagement/quality.js";
import { finalizeNarrativeSurface } from "./engagement/text-finalize.js";
import { buildReplyRewriteJob } from "./llm-batch.js";
import { XApiCostRuntimeSettings } from "../types/runtime.js";
import { DEFAULT_X_API_COST_SETTINGS } from "../config/runtime.js";
import { XCreateGuardBlockReason, xApiBudget } from "./x-api-budget.js";
import { recordNarrativeObservation } from "./narrative-observer.js";

export const TEST_MODE = process.env.TEST_MODE === "true";
export const TEST_NO_EXTERNAL_CALLS =
  TEST_MODE && String(process.env.TEST_NO_EXTERNAL_CALLS ?? "true").trim().toLowerCase() !== "false";
const ACTION_TWO_PHASE_COMMIT = String(process.env.ACTION_TWO_PHASE_COMMIT || "true").trim().toLowerCase() === "true";
const DEFAULT_TREND_TWEET_SEARCH_RULES: TrendTweetSearchRules = {
  minSourceTrust: 0.45,
  minScore: 3.2,
  minEngagement: 12,
  maxAgeHours: 24,
  requireRootPost: true,
  blockSuspiciousPromo: true,
};

interface MentionReplyOptions {
  timezone?: string;
  xApiCostSettings?: Partial<XApiCostRuntimeSettings>;
  recentReflectionHint?: string;
}

interface PostTweetOptions {
  timezone?: string;
  xApiCostSettings?: Partial<XApiCostRuntimeSettings>;
  createKind?: string;
  quoteTweetId?: string;
  metadata?: PostTweetMetadata;
}

interface PostTweetMetadata {
  lane?: TrendLane;
  eventId?: string;
  eventHeadline?: string;
  evidenceIds?: string[];
  narrativeMode?: string;
  quoteTweetId?: string;
}

interface PostDispatchState {
  lastBriefingAt?: string;
  lastBriefingFingerprint?: string;
}

interface PostDispatchLock {
  acquired: boolean;
  release: () => void;
}

const DISPATCH_LOCK_STALE_MS = 5 * 60 * 1000;
const DISPATCH_MIN_GAP_MS = 8 * 60 * 1000;
const DISPATCH_DUPLICATE_WINDOW_MS = 2 * 60 * 60 * 1000;
const DISPATCH_LOCK_PATH =
  process.env.POST_DISPATCH_LOCK_PATH || path.join(process.cwd(), "data", "pixymon-post-dispatch.lock");
const DISPATCH_STATE_PATH =
  process.env.POST_DISPATCH_STATE_PATH || path.join(process.cwd(), "data", "pixymon-post-dispatch.json");

// 환경 변수 검증
export function validateEnvironment() {
  const required: string[] = [];

  if (!TEST_NO_EXTERNAL_CALLS) {
    required.push("ANTHROPIC_API_KEY");
  }

  if (!TEST_MODE && !TEST_NO_EXTERNAL_CALLS) {
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
export function initTwitterClient(): TwitterApi | null {
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

// 멘션 가져오기
export async function getMentions(twitter: TwitterApi, sinceId?: string): Promise<any[]> {
  if (TEST_NO_EXTERNAL_CALLS) {
    console.log("[TEST-LOCAL] 멘션 조회 외부 호출 스킵");
    return [];
  }

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

// 트렌드 키워드 기반 최근 트윗 검색
export async function searchRecentTrendTweets(
  twitter: TwitterApi,
  keywords: string[],
  count: number = 30,
  rules: Partial<TrendTweetSearchRules> = {}
): Promise<any[]> {
  if (TEST_NO_EXTERNAL_CALLS) {
    console.log("[TEST-LOCAL] 트렌드 검색 외부 호출 스킵");
    return [];
  }

  try {
    const minSourceTrust = clampNumber(
      rules.minSourceTrust,
      0.05,
      0.9,
      DEFAULT_TREND_TWEET_SEARCH_RULES.minSourceTrust
    );
    const minScore = clampNumber(rules.minScore, 0.5, 12, DEFAULT_TREND_TWEET_SEARCH_RULES.minScore);
    const minEngagement = clampNumber(
      rules.minEngagement,
      1,
      200,
      DEFAULT_TREND_TWEET_SEARCH_RULES.minEngagement
    );
    const maxAgeHours = clampNumber(
      rules.maxAgeHours,
      1,
      168,
      DEFAULT_TREND_TWEET_SEARCH_RULES.maxAgeHours
    );
    const requireRootPost =
      typeof rules.requireRootPost === "boolean"
        ? rules.requireRootPost
        : DEFAULT_TREND_TWEET_SEARCH_RULES.requireRootPost;
    const blockSuspiciousPromo =
      typeof rules.blockSuspiciousPromo === "boolean"
        ? rules.blockSuspiciousPromo
        : DEFAULT_TREND_TWEET_SEARCH_RULES.blockSuspiciousPromo;
    const cleaned = sanitizeTrendKeywords(keywords).slice(0, 12);

    const keywordQuery = cleaned.length > 0
      ? cleaned.map((keyword) => `"${keyword}"`).join(" OR ")
      : "crypto OR blockchain OR onchain OR layer2";

    const query = `(${keywordQuery}) -is:retweet -is:reply -is:quote`;
    const maxResults = Math.max(10, Math.min(100, count));

    const result = await twitter.v2.search(query, {
      max_results: maxResults,
      start_time: new Date(Date.now() - maxAgeHours * 60 * 60 * 1000).toISOString(),
      "tweet.fields": ["created_at", "text", "author_id", "lang", "public_metrics", "conversation_id", "referenced_tweets"],
      "user.fields": ["username", "verified", "public_metrics", "description", "url"],
      expansions: ["author_id"],
    });

    const rows = result.data?.data || [];
    const users = (((result as unknown as { includes?: { users?: any[] } }).includes?.users) || []) as any[];
    const userMap = new Map(users.map((user) => [String(user.id || ""), user]));

    const ranked = rows
      .map((tweet) => {
        const authorId = String(tweet.author_id || "");
        const user = userMap.get(authorId);
        const sourceKey = buildXSourceKey(user?.username, authorId);
        const baseTrust = memory.getSourceTrustScore(
          sourceKey,
          estimateXSourceFallbackTrust(Boolean(user?.verified), user?.public_metrics?.followers_count)
        );
        const blendedTrust = blendXSourceTrust(baseTrust, Boolean(user?.verified), user?.public_metrics?.followers_count);
        const evaluation = evaluateTrendCandidate({
          text: String(tweet.text || ""),
          keywordHints: cleaned,
          metrics: tweet.public_metrics,
          author: {
            followers_count: user?.public_metrics?.followers_count,
            verified: Boolean(user?.verified),
          },
        });
        return { tweet, user, evaluation, sourceKey, sourceTrust: blendedTrust };
      })
      .filter((item) => !item.evaluation.isLowSignal && item.sourceTrust >= minSourceTrust)
      .sort((a, b) => (b.evaluation.score + b.sourceTrust * 2.2) - (a.evaluation.score + a.sourceTrust * 2.2));

    const selected: any[] = [];
    const seenAuthors = new Set<string>();
    for (const item of ranked) {
      const authorId = String(item.tweet.author_id || "");
      if (authorId && seenAuthors.has(authorId)) continue;
      if (
        !isPreferredTrendReplyTarget(item.tweet, item.user, item.evaluation, item.sourceTrust, {
          minSourceTrust,
          minScore,
          minEngagement,
          maxAgeHours,
          requireRootPost,
          blockSuspiciousPromo,
        })
      ) {
        continue;
      }
      if (item.evaluation.engagementRaw < minEngagement || item.evaluation.score < minScore) continue;
      selected.push({
        ...item.tweet,
        __trendScore: item.evaluation.score,
        __trendEngagement: item.evaluation.engagementRaw,
        __sourceKey: item.sourceKey,
        __sourceTrustScore: item.sourceTrust,
        __authorFollowers: item.user?.public_metrics?.followers_count || 0,
        __authorVerified: Boolean(item.user?.verified),
        __authorUsername: String(item.user?.username || ""),
      });
      if (authorId) {
        seenAuthors.add(authorId);
      }
      if (selected.length >= maxResults) break;
    }

    return selected.slice(0, maxResults);
  } catch (error: any) {
    console.log(`[TREND] 검색 실패: ${error.message || "unknown"}`);
    return [];
  }
}

function isPreferredTrendReplyTarget(
  tweet: {
    id?: string;
    text?: string;
    created_at?: string;
    conversation_id?: string;
    referenced_tweets?: Array<{ type?: string }>;
  },
  user: {
    verified?: boolean;
    username?: string;
    description?: string;
    url?: string;
    public_metrics?: { followers_count?: number };
  } | undefined,
  evaluation: { engagementRaw: number; score: number },
  sourceTrust: number,
  rules: TrendTweetSearchRules
): boolean {
  const text = String(tweet?.text || "").trim();
  const createdAt = parseTweetDate(tweet?.created_at);
  const rawFollowers = user?.public_metrics?.followers_count;
  const followers =
    typeof rawFollowers === "number" && Number.isFinite(rawFollowers)
      ? Math.max(0, Math.floor(rawFollowers))
      : 0;
  const verified = Boolean(user?.verified);
  const cashtagCount = (text.match(/\$[A-Za-z]{2,10}/g) || []).length;
  const urlCount = (text.match(/https?:\/\//gi) || []).length;
  const hardMinTrust = Math.max(rules.minSourceTrust, 0.45);
  const hardMinEngagement = Math.max(rules.minEngagement, 12);
  const hardMinScore = Math.max(rules.minScore, 3.2);
  const maxAgeHours = Math.max(1, Math.min(168, Number.isFinite(rules.maxAgeHours) ? rules.maxAgeHours : 24));
  const isRootPost = !tweet?.conversation_id || !tweet?.id || String(tweet.conversation_id) === String(tweet.id);
  const isReferenced = Array.isArray(tweet?.referenced_tweets) && tweet.referenced_tweets.length > 0;

  if (sourceTrust < hardMinTrust) return false;
  if (evaluation.engagementRaw < hardMinEngagement) return false;
  if (evaluation.score < hardMinScore) return false;
  if (!createdAt || getTweetAgeHours(createdAt) > maxAgeHours) return false;
  if (rules.requireRootPost && (!isRootPost || isReferenced)) return false;
  if (text.length < 30) return false;
  if (cashtagCount >= 3 || urlCount >= 1) return false;
  if (rules.blockSuspiciousPromo && isSuspiciousTrendReplyTarget(tweet, user)) return false;
  if (!verified) {
    const exceptionalSmallAccount =
      followers >= 1200 &&
      sourceTrust >= Math.max(0.58, hardMinTrust + 0.08) &&
      evaluation.score >= Math.max(4.2, hardMinScore + 0.7) &&
      evaluation.engagementRaw >= Math.max(20, hardMinEngagement + 8);
    if (!exceptionalSmallAccount && followers < 3000) return false;
  }
  if (verified && followers < 300) return false;
  return true;
}

function parseTweetDate(value: string | undefined): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function getTweetAgeHours(createdAt: Date): number {
  return Math.max(0, (Date.now() - createdAt.getTime()) / (60 * 60 * 1000));
}

function isSuspiciousTrendReplyTarget(
  tweet: { text?: string },
  user: { username?: string; description?: string; url?: string } | undefined
): boolean {
  const haystack = [
    String(tweet?.text || ""),
    String(user?.username || ""),
    String(user?.description || ""),
    String(user?.url || ""),
  ]
    .join(" ")
    .toLowerCase();

  return (
    /(t\.me|telegram|telegram\.me|discord\.gg|discord\.com\/invite|whatsapp|linktr\.ee|beacons\.ai)/i.test(haystack) ||
    /(join (my|our) (telegram|discord|channel|group)|vip group|alpha group|free signal|dm me|check bio|link in bio)/i.test(haystack)
  );
}

// 멘션에 답글 달기
export async function replyToMention(
  twitter: TwitterApi,
  claude: Anthropic,
  mention: any,
  options?: MentionReplyOptions
): Promise<boolean> {
  try {
    if (TEST_NO_EXTERNAL_CALLS) {
      const mentionText = String(mention?.text || "").replace(/@\w+/g, "").trim();
      const lang = detectLanguage(mentionText);
      const recentReflection = sanitizeTweetText(
        options?.recentReflectionHint || memory.getLatestDigestReflectionMemo()?.text || ""
      ).slice(0, 60);
      const localReply = finalizeNarrativeSurface(
        lang === "en"
          ? /\?$/.test(mentionText)
            ? "That is a fair question. I would watch the onchain trail before pretending the answer is obvious."
            : "That part caught me too. I would rather check the onchain trail once more than force a conclusion."
          : /\?$|어떻게|왜|뭐|무엇|어디/.test(mentionText)
            ? recentReflection
              ? `${recentReflection}. 그래서 나도 방향 단정보다 먼저 움직인 흔적부터 다시 볼 것 같다.`
              : "그 질문은 괜찮다. 나도 방향 단정보다 먼저 움직인 흔적부터 다시 볼 것 같다."
            : recentReflection
              ? `${recentReflection}. 그 장면도 섣불리 결론 내리기보다 먼저 움직인 단서부터 더 보게 된다.`
              : "그 장면은 나도 걸렸다. 섣불리 결론 내리기보다 먼저 움직인 단서부터 더 볼 것 같다.",
        lang,
        160,
        "reply"
      ).slice(0, 160);
      console.log(`🧪 [테스트-로컬] 멘션 답글 시뮬레이션: ${localReply}`);
      recordNarrativeObservation({
        surface: "reply",
        text: localReply,
        language: lang,
        fallbackKind: "mention:test-local",
      });
      return true;
    }

    const timezone = normalizeTimezone(options?.timezone);
    const xApiCostSettings = resolveXApiCostSettings(options?.xApiCostSettings);

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

    // 언어 감지
    const cleanedMentionText = String(mention.text || "").replace(/@\w+/g, "").trim();
    const lang = detectLanguage(cleanedMentionText);
    const isEnglish = lang === "en";

    // 팔로워 컨텍스트 가져오기
    const follower = mention.author_id ? memory.getFollower(mention.author_id) : null;
    const followerContext = follower && follower.mentionCount > 1
      ? `\n(이 사람은 ${follower.mentionCount}번째 멘션, 친근하게)`
      : "";
    const toneGuide = getReplyToneGuide(lang);
    const recentReflection = sanitizeTweetText(
      options?.recentReflectionHint || memory.getLatestDigestReflectionMemo()?.text || ""
    ).slice(0, 100);

    const maxChars = 160;
    const shouldEndWithQuestion = /\?$|질문|어떻게|왜|is it|what|how|why/i.test(cleanedMentionText);

    const llmResult = await requestBudgetedClaudeMessage(
      claude,
      {
        model: CLAUDE_MODEL,
        max_tokens: 260,
        system: PIXYMON_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `멘션에 답글 작성.

- ${maxChars}자 이내
- ${isEnglish ? '영어로 답변' : '한국어로 답변'}
- 질문이면 답변, 아니면 짧은 리액션
- 톤 가이드:
${toneGuide}
- 원문을 그대로 다시 요약하지 말 것
- 길어도 2문장
- 첫 문장은 반응/관찰/짧은 답변으로 시작
- 한국어면 말하듯 자연스럽게
- 단정적 투자 표현 금지
- 마지막 문장 ${shouldEndWithQuestion ? "질문형" : "관찰형"}
- 해시태그 X, 이모지 X${followerContext}
- 최근 소화 메모: ${recentReflection || (isEnglish ? "none" : "없음")}

멘션 내용:
${mention.text}`,
          },
        ],
      },
      {
        kind: "reply:mention-generate",
        timezone,
      }
    );
    if (!llmResult) {
      return false;
    }

    let replyText = extractTextFromClaude(llmResult.message.content);

    if (!replyText) return false;

    if (detectLanguage(replyText) !== lang) {
      const rewritten = await rewriteReplyByLanguage(claude, replyText, lang, maxChars, timezone);
      if (rewritten) {
        replyText = rewritten;
      }
    }
    replyText = finalizeNarrativeSurface(replyText, lang, maxChars, "reply").slice(0, maxChars);

    if (TEST_MODE) {
      console.log(`🧪 [테스트] 멘션 답글 시뮬레이션: ${replyText}`);
      recordNarrativeObservation({
        surface: "reply",
        text: replyText,
        language: lang,
        fallbackKind: "mention:test",
      });
      return true;
    }

    const createGuard = xApiBudget.checkCreateAllowance({
      enabled: xApiCostSettings.enabled,
      timezone,
      dailyMaxUsd: xApiCostSettings.dailyMaxUsd,
      estimatedCreateCostUsd: xApiCostSettings.estimatedCreateCostUsd,
      dailyCreateRequestLimit: xApiCostSettings.dailyCreateRequestLimit,
      kind: "reply:mention",
      minIntervalMinutes: xApiCostSettings.createMinIntervalMinutes,
    });
    if (!createGuard.allowed) {
      console.log(`[BUDGET] 멘션 답글 스킵: ${formatCreateBlockReason(createGuard.reason, createGuard.waitSeconds)}`);
      return false;
    }

    if (xApiCostSettings.enabled) {
      const createUsage = xApiBudget.recordCreate({
        timezone,
        estimatedCreateCostUsd: xApiCostSettings.estimatedCreateCostUsd,
        kind: "reply:mention",
      });
      console.log(
        `[BUDGET] create=${createUsage.createRequests}/${xApiCostSettings.dailyCreateRequestLimit} total_est=$${createUsage.estimatedTotalCostUsd.toFixed(3)}/$${xApiCostSettings.dailyMaxUsd.toFixed(2)} (mention-reply)`
      );
    }

    const reply = await twitter.v2.reply(replyText, mention.id);
    console.log(`[OK] 멘션 답글: ${reply.data.id}`);

    // 답글도 메모리에 저장
    memory.saveTweet(reply.data.id, replyText, "reply");
    recordNarrativeObservation({
      surface: "reply",
      text: replyText,
      language: lang,
      fallbackKind: "mention:live",
    });
    memory.recordCognitiveActivity("social", 2);
    return true;
  } catch (error: any) {
    console.error(`[ERROR] 멘션 답글 실패:`, error.message);
    return false;
  }
}

export function isRateLimitError(error: unknown): boolean {
  const err = error as { code?: number; status?: number; data?: { status?: number; title?: string } };
  const title = err?.data?.title?.toLowerCase() ?? "";
  return (
    err?.code === 429 ||
    err?.status === 429 ||
    err?.data?.status === 429 ||
    title.includes("rate")
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rewriteReplyByLanguage(
  claude: Anthropic,
  text: string,
  lang: "ko" | "en",
  maxChars: number,
  timezone: string = "Asia/Seoul"
): Promise<string | null> {
  try {
    const job = buildReplyRewriteJob({
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

    const rewritten = finalizeNarrativeSurface(extractTextFromClaude(llmResult.message.content), lang, maxChars, "reply").trim();
    if (!rewritten) return null;
    return rewritten.slice(0, maxChars);
  } catch {
    return null;
  }
}

function sanitizeTrendKeywords(keywords: string[]): string[] {
  return [...new Set(
    keywords
      .map((keyword) => String(keyword || "").trim())
      .filter((keyword) => keyword.length >= 2 && keyword.length <= 30)
      .filter((keyword) => !/^[0-9]+$/.test(keyword))
      .filter((keyword) => !/^(http|https)/i.test(keyword))
      .filter((keyword) => !/^[@#]/.test(keyword))
  )];
}

function buildXSourceKey(username: string | undefined, authorId: string): string {
  const normalized = String(username || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "");
  if (normalized) {
    return `x:${normalized}`;
  }
  return `x:${String(authorId || "unknown").toLowerCase()}`;
}

function estimateXSourceFallbackTrust(verified: boolean, followersCount: unknown): number {
  const followers = typeof followersCount === "number" && Number.isFinite(followersCount) ? followersCount : 0;
  if (verified && followers >= 30000) return 0.66;
  if (verified) return 0.58;
  if (followers >= 100000) return 0.62;
  if (followers >= 10000) return 0.56;
  if (followers >= 3000) return 0.5;
  return 0.42;
}

function blendXSourceTrust(baseTrust: number, verified: boolean, followersCount: unknown): number {
  const followers = typeof followersCount === "number" && Number.isFinite(followersCount) ? followersCount : 0;
  const followerBoost = Math.min(0.14, Math.log10(followers + 10) * 0.03);
  const verifiedBoost = verified ? 0.06 : 0;
  const blended = baseTrust * 0.8 + 0.2 * (baseTrust + followerBoost + verifiedBoost);
  return Math.min(0.95, Math.max(0.05, Math.round(blended * 100) / 100));
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function normalizeTimezone(raw: string | undefined): string {
  const value = String(raw || "").trim();
  return value || "Asia/Seoul";
}

function resolveXApiCostSettings(
  settings: Partial<XApiCostRuntimeSettings> | undefined
): XApiCostRuntimeSettings {
  const source = settings || {};
  return {
    enabled:
      typeof source.enabled === "boolean"
        ? source.enabled
        : DEFAULT_X_API_COST_SETTINGS.enabled,
    dailyMaxUsd: clampNumber(
      source.dailyMaxUsd,
      0.01,
      100,
      DEFAULT_X_API_COST_SETTINGS.dailyMaxUsd
    ),
    estimatedReadCostUsd: clampNumber(
      source.estimatedReadCostUsd,
      0.001,
      10,
      DEFAULT_X_API_COST_SETTINGS.estimatedReadCostUsd
    ),
    estimatedCreateCostUsd: clampNumber(
      source.estimatedCreateCostUsd,
      0.001,
      10,
      DEFAULT_X_API_COST_SETTINGS.estimatedCreateCostUsd
    ),
    dailyReadRequestLimit: Math.floor(
      clampNumber(
        source.dailyReadRequestLimit,
        1,
        1000,
        DEFAULT_X_API_COST_SETTINGS.dailyReadRequestLimit
      )
    ),
    dailyCreateRequestLimit: Math.floor(
      clampNumber(
        source.dailyCreateRequestLimit,
        1,
        1000,
        DEFAULT_X_API_COST_SETTINGS.dailyCreateRequestLimit
      )
    ),
    mentionReadMinIntervalMinutes: Math.floor(
      clampNumber(
        source.mentionReadMinIntervalMinutes,
        0,
        1440,
        DEFAULT_X_API_COST_SETTINGS.mentionReadMinIntervalMinutes
      )
    ),
    trendReadMinIntervalMinutes: Math.floor(
      clampNumber(
        source.trendReadMinIntervalMinutes,
        0,
        1440,
        DEFAULT_X_API_COST_SETTINGS.trendReadMinIntervalMinutes
      )
    ),
    createMinIntervalMinutes: Math.floor(
      clampNumber(
        source.createMinIntervalMinutes,
        0,
        1440,
        DEFAULT_X_API_COST_SETTINGS.createMinIntervalMinutes
      )
    ),
  };
}

function formatCreateBlockReason(reason: XCreateGuardBlockReason | undefined, waitSeconds?: number): string {
  if (reason === "min-interval") {
    const seconds = Math.max(1, Math.floor(waitSeconds || 0));
    return `최소 간격 제한 (${seconds}초 후 재시도)`;
  }
  if (reason === "daily-request-limit") {
    return "일일 요청 한도 도달";
  }
  if (reason === "daily-usd-limit") {
    return "일일 예상 비용 한도 도달";
  }
  return "비용 가드 정책";
}

function acquirePostDispatchLock(): PostDispatchLock {
  try {
    fs.mkdirSync(path.dirname(DISPATCH_LOCK_PATH), { recursive: true });
  } catch {
    return { acquired: false, release: () => {} };
  }

  let fd: number | null = null;
  try {
    fd = fs.openSync(DISPATCH_LOCK_PATH, "wx");
    return {
      acquired: true,
      release: () => {
        try {
          if (fd !== null) {
            fs.closeSync(fd);
            fd = null;
          }
        } catch {
          // no-op
        }
        try {
          fs.unlinkSync(DISPATCH_LOCK_PATH);
        } catch {
          // no-op
        }
      },
    };
  } catch (error: any) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // no-op
      }
    }
    if (error?.code === "EEXIST") {
      tryClearStaleDispatchLock();
      try {
        fd = fs.openSync(DISPATCH_LOCK_PATH, "wx");
        return {
          acquired: true,
          release: () => {
            try {
              if (fd !== null) {
                fs.closeSync(fd);
                fd = null;
              }
            } catch {
              // no-op
            }
            try {
              fs.unlinkSync(DISPATCH_LOCK_PATH);
            } catch {
              // no-op
            }
          },
        };
      } catch {
        return { acquired: false, release: () => {} };
      }
    }
    return { acquired: false, release: () => {} };
  }
}

function tryClearStaleDispatchLock(): void {
  try {
    const stat = fs.statSync(DISPATCH_LOCK_PATH);
    if (Date.now() - stat.mtimeMs > DISPATCH_LOCK_STALE_MS) {
      fs.unlinkSync(DISPATCH_LOCK_PATH);
    }
  } catch {
    // no-op
  }
}

function getPostDispatchBlockReason(content: string): string | null {
  const state = readPostDispatchState();
  const now = Date.now();
  const lastMs = state.lastBriefingAt ? new Date(state.lastBriefingAt).getTime() : NaN;
  if (Number.isFinite(lastMs)) {
    const elapsed = now - (lastMs as number);
    if (elapsed >= 0 && elapsed < DISPATCH_MIN_GAP_MS) {
      return `최근 글 발행 직후(${Math.floor(elapsed / 1000)}초 경과)`;
    }
  }

  const fingerprint = buildPostFingerprint(content);
  if (
    state.lastBriefingFingerprint &&
    state.lastBriefingAt &&
    Number.isFinite(lastMs) &&
    now - (lastMs as number) < DISPATCH_DUPLICATE_WINDOW_MS &&
    state.lastBriefingFingerprint === fingerprint
  ) {
    return "동일/유사 글 지문 중복";
  }
  return null;
}

function persistPostDispatchState(content: string): void {
  const nextState: PostDispatchState = {
    lastBriefingAt: new Date().toISOString(),
    lastBriefingFingerprint: buildPostFingerprint(content),
  };
  try {
    fs.mkdirSync(path.dirname(DISPATCH_STATE_PATH), { recursive: true });
    fs.writeFileSync(DISPATCH_STATE_PATH, JSON.stringify(nextState, null, 2), "utf-8");
  } catch {
    // no-op
  }
}

function readPostDispatchState(): PostDispatchState {
  try {
    const raw = fs.readFileSync(DISPATCH_STATE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as PostDispatchState;
    return {
      lastBriefingAt: typeof parsed.lastBriefingAt === "string" ? parsed.lastBriefingAt : undefined,
      lastBriefingFingerprint:
        typeof parsed.lastBriefingFingerprint === "string" ? parsed.lastBriefingFingerprint : undefined,
    };
  } catch {
    return {};
  }
}

function buildPostFingerprint(content: string): string {
  return String(content || "")
    .toLowerCase()
    .replace(/\$[a-z]{2,10}/g, "$token")
    .replace(/[+-]?\d+(?:[.,]\d+)?%/g, "%")
    .replace(/\d[\d,]*(?:\.\d+)?/g, "#")
    .replace(/[^\p{L}\p{N}\s$%#]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

export const __postDispatchTest = {
  acquirePostDispatchLock,
  getPostDispatchBlockReason,
  persistPostDispatchState,
  readPostDispatchState,
  buildPostFingerprint,
};

export const __trendTargetTest = {
  isPreferredTrendReplyTarget,
};

// 트윗 발행 (Twitter API v2 only)
export async function postTweet(
  twitter: TwitterApi | null,
  content: string,
  type: "briefing" | "reply" | "quote" = "briefing",
  options: PostTweetOptions = {}
): Promise<string | null> {
  if (TEST_MODE || !twitter) {
    console.log("🧪 [테스트 모드] 트윗 발행 시뮬레이션:");
    console.log("─".repeat(40));
    console.log(content);
    console.log("─".repeat(40));
    console.log("✅ (실제 트윗은 발행되지 않음)\n");

    const testId = `test_${Date.now()}`;
    recordNarrativeObservation({
      surface: type === "quote" ? "quote" : "post",
      text: content,
      language: detectLanguage(content),
      lane: options.metadata?.lane,
      narrativeMode: options.metadata?.narrativeMode,
      fallbackKind: TEST_MODE ? "post:test" : "post:no-twitter",
    });
    return testId;
  }

  let lastError: unknown;
  const maxAttempts = 3;
  const timezone = normalizeTimezone(options.timezone);
  const xApiCostSettings = resolveXApiCostSettings(options.xApiCostSettings);
  const actionMode = String(process.env.ACTION_MODE || "observe").trim().toLowerCase();
  const commitId = `tw_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const createKind = options.createKind || `post:${type}`;
  const quoteTweetId = type === "quote" ? normalizeQuoteTweetId(options.quoteTweetId) : undefined;
  const dispatchLock = type === "briefing" ? acquirePostDispatchLock() : { acquired: true, release: () => {} };
  if (!dispatchLock.acquired) {
    console.log("[POST-GUARD] 다른 인스턴스가 글 발행 중이라 이번 발행을 스킵합니다.");
    return null;
  }

  try {
    if (type === "quote" && !quoteTweetId) {
      console.log("[POST-GUARD] quote 발행 스킵: quoteTweetId 누락");
      return null;
    }

    if (type === "briefing") {
      const dispatchBlock = getPostDispatchBlockReason(content);
      if (dispatchBlock) {
        console.log(`[POST-GUARD] 글 발행 스킵: ${dispatchBlock}`);
        return null;
      }
    }

    if (ACTION_TWO_PHASE_COMMIT) {
      console.log(`[2PC] prepare id=${commitId} mode=${actionMode} kind=${createKind}`);
    }

    const createGuard = xApiBudget.checkCreateAllowance({
      enabled: xApiCostSettings.enabled,
      timezone,
      dailyMaxUsd: xApiCostSettings.dailyMaxUsd,
      estimatedCreateCostUsd: xApiCostSettings.estimatedCreateCostUsd,
      dailyCreateRequestLimit: xApiCostSettings.dailyCreateRequestLimit,
      kind: createKind,
      minIntervalMinutes: xApiCostSettings.createMinIntervalMinutes,
    });
    if (!createGuard.allowed) {
      console.log(`[BUDGET] 글 발행 스킵: ${formatCreateBlockReason(createGuard.reason, createGuard.waitSeconds)}`);
      return null;
    }

    if (xApiCostSettings.enabled) {
      const createUsage = xApiBudget.recordCreate({
        timezone,
        estimatedCreateCostUsd: xApiCostSettings.estimatedCreateCostUsd,
        kind: createKind,
      });
      console.log(
        `[BUDGET] create=${createUsage.createRequests}/${xApiCostSettings.dailyCreateRequestLimit} total_est=$${createUsage.estimatedTotalCostUsd.toFixed(3)}/$${xApiCostSettings.dailyMaxUsd.toFixed(2)} (${createKind})`
      );
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const tweet = quoteTweetId
          ? await twitter.v2.tweet({ text: content, quote_tweet_id: quoteTweetId })
          : await twitter.v2.tweet(content);
        if (ACTION_TWO_PHASE_COMMIT) {
          if (!tweet?.data?.id || String(tweet.data.id).trim().length === 0) {
            throw new Error("two-phase post-check failed: invalid tweet id");
          }
        }
        console.log("✅ 트윗 발행 완료! (v2)");
        console.log(`   ID: ${tweet.data.id}`);
        console.log(`   URL: https://twitter.com/Pixy_mon/status/${tweet.data.id}`);

        memory.saveTweet(tweet.data.id, content, type, {
          ...(options.metadata || {}),
          ...(quoteTweetId ? { quoteTweetId } : {}),
        });
        recordNarrativeObservation({
          surface: type === "quote" ? "quote" : "post",
          text: content,
          language: detectLanguage(content),
          lane: options.metadata?.lane,
          narrativeMode: options.metadata?.narrativeMode,
          fallbackKind: createKind,
        });
        if (type === "briefing") {
          persistPostDispatchState(content);
        }
        if (ACTION_TWO_PHASE_COMMIT) {
          console.log(`[2PC] commit id=${commitId} tweet=${tweet.data.id}`);
        }
        return tweet.data.id;
      } catch (error) {
        lastError = error;
        const rateLimited = isRateLimitError(error);
        const delayMs = rateLimited ? 60000 * attempt : 2000 * attempt;

        if (attempt === maxAttempts) {
          break;
        }

        console.error(
          `⚠️ 트윗 발행 실패 (시도 ${attempt}/${maxAttempts})${rateLimited ? " [rate limit]" : ""}`
        );
        if (ACTION_TWO_PHASE_COMMIT) {
          console.error(`[2PC] retry id=${commitId} attempt=${attempt}`);
        }
        await sleep(delayMs);
      }
    }

    if (ACTION_TWO_PHASE_COMMIT) {
      console.error(`[2PC] abort id=${commitId}`);
    }
    console.error("❌ 트윗 발행 실패:", lastError);
    throw lastError;
  } finally {
    dispatchLock.release();
  }
}

function normalizeQuoteTweetId(raw: string | undefined): string | undefined {
  const normalized = String(raw || "").trim();
  if (!normalized) return undefined;
  return /^[0-9]+$/.test(normalized) ? normalized : undefined;
}
