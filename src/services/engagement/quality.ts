import { MarketData } from "../blockchain-news.js";
import { findNarrativeDuplicate, validateMarketConsistency } from "../content-guard.js";
import { memory } from "../memory.js";
import { AdaptivePolicy, ContentQualityCheck, RecentPostRecord } from "./types.js";

export function sanitizeTweetText(text: string): string {
  return text.replace(/\s+/g, " ").replace(/[“”]/g, "\"").trim();
}

export function evaluateReplyQuality(
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

export function evaluatePostQuality(
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

export function inferTopicTag(text: string): string {
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
