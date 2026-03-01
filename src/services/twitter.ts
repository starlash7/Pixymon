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
} from "./llm.js";
import { TrendLane } from "../types/agent.js";
import { detectLanguage } from "../utils/mood.js";
import { evaluateTrendCandidate } from "./content-guard.js";
import { TrendTweetSearchRules } from "./engagement/types.js";
import { XApiCostRuntimeSettings } from "../types/runtime.js";
import { DEFAULT_X_API_COST_SETTINGS } from "../config/runtime.js";
import { XCreateGuardBlockReason, xApiBudget } from "./x-api-budget.js";

export const TEST_MODE = process.env.TEST_MODE === "true";
const DEFAULT_TREND_TWEET_SEARCH_RULES: TrendTweetSearchRules = {
  minSourceTrust: 0.24,
  minScore: 3.2,
  minEngagement: 6,
};

interface MentionReplyOptions {
  timezone?: string;
  xApiCostSettings?: Partial<XApiCostRuntimeSettings>;
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
  sourceAuthorId?: string;
  targetTweetId?: string;
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
    const cleaned = sanitizeTrendKeywords(keywords).slice(0, 12);

    const keywordQuery = cleaned.length > 0
      ? cleaned.map((keyword) => `"${keyword}"`).join(" OR ")
      : "crypto OR blockchain OR onchain OR layer2";

    const query = `(${keywordQuery}) -is:retweet -is:reply -is:quote`;
    const maxResults = Math.max(10, Math.min(100, count));

    const result = await twitter.v2.search(query, {
      max_results: maxResults,
      "tweet.fields": ["created_at", "text", "author_id", "lang", "public_metrics"],
      "user.fields": ["username", "verified", "public_metrics"],
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
      if (item.evaluation.engagementRaw < minEngagement || item.evaluation.score < minScore) continue;
      selected.push({
        ...item.tweet,
        __trendScore: item.evaluation.score,
        __trendEngagement: item.evaluation.engagementRaw,
        __sourceKey: item.sourceKey,
        __sourceTrustScore: item.sourceTrust,
        __authorFollowers: item.user?.public_metrics?.followers_count || 0,
      });
      if (authorId) {
        seenAuthors.add(authorId);
      }
      if (selected.length >= maxResults) break;
    }

    if (selected.length > 0) {
      return selected.slice(0, maxResults);
    }

    // 품질 필터가 너무 엄격해 후보가 없을 때는 저점수지만 스팸 아닌 순서로 fallback
    return ranked.slice(0, Math.min(12, ranked.length)).map((item) => ({
      ...item.tweet,
      __trendScore: item.evaluation.score,
      __trendEngagement: item.evaluation.engagementRaw,
      __sourceKey: item.sourceKey,
      __sourceTrustScore: item.sourceTrust,
      __authorFollowers: item.user?.public_metrics?.followers_count || 0,
    }));
  } catch (error: any) {
    console.log(`[TREND] 검색 실패: ${error.message || "unknown"}`);
    return [];
  }
}

// 멘션에 답글 달기
export async function replyToMention(
  twitter: TwitterApi,
  claude: Anthropic,
  mention: any,
  options?: MentionReplyOptions
): Promise<boolean> {
  try {
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

    const maxChars = 160;
    const shouldEndWithQuestion = /\?$|질문|어떻게|왜|is it|what|how|why/i.test(cleanedMentionText);

    const message = await claude.messages.create({
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
- 단정적 투자 표현 금지
- 마지막 문장 ${shouldEndWithQuestion ? "질문형" : "관찰형"}
- 해시태그 X, 이모지 X${followerContext}

멘션 내용:
${mention.text}`,
        },
      ],
    });

    let replyText = extractTextFromClaude(message.content);

    if (!replyText) return false;

    if (detectLanguage(replyText) !== lang) {
      const rewritten = await rewriteReplyByLanguage(claude, replyText, lang, maxChars);
      if (rewritten) {
        replyText = rewritten;
      }
    }
    replyText = replyText.slice(0, maxChars);

    if (TEST_MODE) {
      console.log(`🧪 [테스트] 멘션 답글 시뮬레이션: ${replyText}`);
      memory.saveTweet(`mention_test_${Date.now()}`, replyText, "reply");
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

    const createUsage = xApiBudget.recordCreate({
      timezone,
      estimatedCreateCostUsd: xApiCostSettings.estimatedCreateCostUsd,
      kind: "reply:mention",
    });
    console.log(
      `[BUDGET] create=${createUsage.createRequests}/${xApiCostSettings.dailyCreateRequestLimit} total_est=$${createUsage.estimatedTotalCostUsd.toFixed(3)}/$${xApiCostSettings.dailyMaxUsd.toFixed(2)} (mention-reply)`
    );

    const reply = await twitter.v2.reply(replyText, mention.id);
    console.log(`[OK] 멘션 답글: ${reply.data.id}`);

    // 답글도 메모리에 저장
    memory.saveTweet(reply.data.id, replyText, "reply");
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
  maxChars: number
): Promise<string | null> {
  try {
    const prompt =
      lang === "ko"
        ? `아래 문장을 한국어 한 줄 답글로 다시 써줘.

원문:
${text}

규칙:
- ${maxChars}자 이내
- 의미 유지
- 해시태그/이모지 금지
- 문장만 출력`
        : `Rewrite this as a one-line English reply.

Original:
${text}

Rules:
- Max ${maxChars} chars
- Keep meaning
- No hashtags or emoji
- Output sentence only`;

    const message = await claude.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 220,
      system: PIXYMON_SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
    });

    const rewritten = extractTextFromClaude(message.content).trim();
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

    // 테스트 모드에서도 메모리에 저장
    const testId = `test_${Date.now()}`;
    memory.saveTweet(testId, content, type, options.metadata);
    return testId;
  }

  let lastError: unknown;
  const maxAttempts = 3;
  const timezone = normalizeTimezone(options.timezone);
  const xApiCostSettings = resolveXApiCostSettings(options.xApiCostSettings);
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

    const createUsage = xApiBudget.recordCreate({
      timezone,
      estimatedCreateCostUsd: xApiCostSettings.estimatedCreateCostUsd,
      kind: createKind,
    });
    console.log(
      `[BUDGET] create=${createUsage.createRequests}/${xApiCostSettings.dailyCreateRequestLimit} total_est=$${createUsage.estimatedTotalCostUsd.toFixed(3)}/$${xApiCostSettings.dailyMaxUsd.toFixed(2)} (${createKind})`
    );

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const tweet = quoteTweetId
          ? await twitter.v2.tweet({ text: content, quote_tweet_id: quoteTweetId })
          : await twitter.v2.tweet(content);
        console.log("✅ 트윗 발행 완료! (v2)");
        console.log(`   ID: ${tweet.data.id}`);
        console.log(`   URL: https://twitter.com/Pixy_mon/status/${tweet.data.id}`);

        memory.saveTweet(tweet.data.id, content, type, {
          ...(options.metadata || {}),
          ...(quoteTweetId ? { quoteTweetId } : {}),
        });
        if (type === "briefing") {
          persistPostDispatchState(content);
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
        await sleep(delayMs);
      }
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
