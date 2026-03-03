import { NarrativeMode, TrendLane } from "../types/agent.js";
import { sanitizeTweetText } from "./engagement/quality.js";
import { EventEvidencePlan } from "./engagement/types.js";

export interface NarrativePostMeta {
  lane?: TrendLane;
  narrativeMode?: NarrativeMode;
}

export interface NarrativeRecentPost {
  content: string;
  timestamp: string;
  meta?: NarrativePostMeta;
}

export interface NarrativePlan {
  lane: TrendLane;
  mode: NarrativeMode;
  openingDirective: string;
  bodyDirective: string;
  endingDirective: string;
  bannedOpeners: string[];
}

interface BuildNarrativePlanInput {
  eventPlan: EventEvidencePlan;
  recentPosts: NarrativeRecentPost[];
  language: "ko" | "en";
}

interface NarrativeNoveltyPenalty {
  code: string;
  weight: number;
}

export interface NarrativeNoveltyResult {
  ok: boolean;
  score: number;
  reason?: string;
  penalties: NarrativeNoveltyPenalty[];
}

const MODE_ORDER: NarrativeMode[] = [
  "identity-journal",
  "philosophy-note",
  "interaction-experiment",
  "meta-reflection",
  "fable-essay",
];

const MODE_BY_LANE: Record<TrendLane, NarrativeMode[]> = {
  protocol: ["philosophy-note", "identity-journal", "interaction-experiment", "meta-reflection", "fable-essay"],
  ecosystem: ["interaction-experiment", "identity-journal", "fable-essay", "philosophy-note", "meta-reflection"],
  regulation: ["philosophy-note", "meta-reflection", "identity-journal", "interaction-experiment", "fable-essay"],
  macro: ["meta-reflection", "philosophy-note", "identity-journal", "fable-essay", "interaction-experiment"],
  onchain: ["identity-journal", "meta-reflection", "interaction-experiment", "philosophy-note", "fable-essay"],
  "market-structure": ["philosophy-note", "meta-reflection", "interaction-experiment", "identity-journal", "fable-essay"],
};

const OPENING_BY_MODE_KO: Record<NarrativeMode, string[]> = {
  "identity-journal": [
    "오늘 내가 붙잡은 장면은",
    "지금 내가 집요하게 보는 건",
    "이 장면이 오늘 내 정체성을 드러낸다",
  ],
  "philosophy-note": [
    "이 장면을 사유의 프레임으로 옮기면",
    "읽던 문장을 체인 위로 옮기면",
    "한 줄 관점으로 요약하면",
  ],
  "interaction-experiment": [
    "여기서 네 시선을 빌리고 싶은 장면은",
    "이 대목에서 사람들이 다르게 읽는 지점은",
    "지금 함께 확인하고 싶은 장면은",
  ],
  "meta-reflection": [
    "먼저 내가 틀릴 지점부터 적는다",
    "확신 전에 의심부터 남긴다",
    "오늘 내가 경계하는 실패 패턴은",
  ],
  "fable-essay": [
    "이 장면을 이야기로 풀어 쓰면",
    "한 문단으로 정리해 보면",
    "비유 하나를 빌리면",
  ],
};

const OPENING_BY_MODE_EN: Record<NarrativeMode, string[]> = {
  "identity-journal": [
    "My identity log for today starts here:",
    "The thing I keep chasing today is this:",
    "If I write one line about who I am today:",
  ],
  "philosophy-note": [
    "If I translate this through a worldview lens:",
    "If I map a book fragment to today's tape:",
    "One worldview line for this moment:",
  ],
  "interaction-experiment": [
    "Here is the point where I need a second perspective:",
    "This is where people may read the same signal differently:",
    "The scene I want to test with the community is this:",
  ],
  "meta-reflection": [
    "I start by naming where I can be wrong:",
    "Before conviction, I leave room for doubt:",
    "Before a claim, I log this mistake pattern:",
  ],
  "fable-essay": [
    "If I unfold this scene as a short story:",
    "If I leave this in one paragraph:",
    "If I borrow one metaphor first:",
  ],
};

export function buildNarrativePlan(input: BuildNarrativePlanInput): NarrativePlan {
  const lane = input.eventPlan.lane;
  const mode = pickNarrativeMode(lane, input.recentPosts);
  const bannedOpeners = buildBannedOpeners(input.recentPosts);
  const openingPool = input.language === "ko" ? OPENING_BY_MODE_KO[mode] : OPENING_BY_MODE_EN[mode];
  const openingDirective = pickFirstNonBanned(openingPool, bannedOpeners) || openingPool[0];

  const bodyDirective = buildBodyDirective(mode, input.language);
  const endingDirective = buildEndingDirective(mode, input.language);

  return {
    lane,
    mode,
    openingDirective,
    bodyDirective,
    endingDirective,
    bannedOpeners,
  };
}

export function validateNarrativeNovelty(
  text: string,
  recentPosts: NarrativeRecentPost[],
  plan: NarrativePlan
): NarrativeNoveltyResult {
  const normalized = normalizeNarrativeText(text);
  const penalties: NarrativeNoveltyPenalty[] = [];

  if (!normalized) {
    return {
      ok: false,
      score: 0,
      reason: "empty-text",
      penalties: [{ code: "empty-text", weight: 1 }],
    };
  }

  const samePrefix = recentPosts
    .slice(-10)
    .map((post) => normalizeNarrativeText(post.content))
    .find((row) => row.slice(0, 24) === normalized.slice(0, 24));
  if (samePrefix) {
    penalties.push({ code: "opening-pattern-repeat", weight: 0.45 });
  }

  if (plan.bannedOpeners.some((opener) => normalized.startsWith(normalizeNarrativeText(opener)))) {
    penalties.push({ code: "banned-opener-used", weight: 0.35 });
  }

  const skeleton = buildNarrativeSkeleton(normalized);
  const similar = recentPosts
    .slice(-14)
    .map((post) => buildNarrativeSkeleton(normalizeNarrativeText(post.content)))
    .some((candidate) => candidate === skeleton);
  if (similar) {
    penalties.push({ code: "narrative-skeleton-repeat", weight: 0.4 });
  }

  const recentModeRepeats = recentPosts
    .slice(-2)
    .filter((post) => post.meta?.narrativeMode === plan.mode).length;
  if (recentModeRepeats >= 2) {
    penalties.push({ code: "mode-overuse", weight: 0.18 });
  }

  const penaltyScore = penalties.reduce((sum, penalty) => sum + penalty.weight, 0);
  const score = roundScore(1 - penaltyScore);
  const ok = score >= 0.62;

  if (!ok) {
    const topPenalty = [...penalties].sort((a, b) => b.weight - a.weight)[0];
    return {
      ok,
      score,
      reason: topPenalty?.code || "novelty-low",
      penalties,
    };
  }

  return {
    ok,
    score,
    penalties,
  };
}

function pickNarrativeMode(lane: TrendLane, recentPosts: NarrativeRecentPost[]): NarrativeMode {
  const ordered = MODE_BY_LANE[lane] || MODE_ORDER;
  const usage = new Map<NarrativeMode, number>();
  MODE_ORDER.forEach((mode) => usage.set(mode, 0));

  for (const post of recentPosts.slice(-20)) {
    const mode = post.meta?.narrativeMode;
    if (mode) {
      usage.set(mode, (usage.get(mode) || 0) + 1);
      continue;
    }
    const inferred = inferModeFromText(post.content);
    usage.set(inferred, (usage.get(inferred) || 0) + 1);
  }

  const ranked = ordered
    .map((mode, index) => ({ mode, score: (usage.get(mode) || 0) + index * 0.05 }))
    .sort((a, b) => a.score - b.score);

  const best = ranked[0];
  if (!best) return ordered[0];
  const nearBest = ranked.filter((item) => item.score <= best.score + 0.08);
  if (nearBest.length === 1) {
    return best.mode;
  }
  return nearBest[Math.floor(Math.random() * nearBest.length)]?.mode || best.mode;
}

function inferModeFromText(text: string): NarrativeMode {
  const lower = normalizeNarrativeText(text);
  if (/철학|philosophy|책|book|사상|worldview/.test(lower)) return "philosophy-note";
  if (/실험|experiment|미션|mission|댓글로/.test(lower)) return "interaction-experiment";
  if (/회고|reflection|실수|failure|오판|mistake/.test(lower)) return "meta-reflection";
  if (/우화|fable|에세이|essay|비유|metaphor/.test(lower)) return "fable-essay";
  return "identity-journal";
}

function buildBannedOpeners(recentPosts: NarrativeRecentPost[]): string[] {
  const rows = recentPosts
    .slice(-8)
    .map((post) => sanitizeTweetText(post.content).slice(0, 26).trim())
    .filter((row) => row.length >= 8);
  return [...new Set(rows)].slice(0, 8);
}

function pickFirstNonBanned(pool: string[], banned: string[]): string | null {
  const normalizedBanned = banned.map((item) => normalizeNarrativeText(item));
  for (const candidate of pool) {
    const normalized = normalizeNarrativeText(candidate);
    if (!normalizedBanned.includes(normalized)) {
      return candidate;
    }
  }
  return null;
}

function buildBodyDirective(mode: NarrativeMode, language: "ko" | "en"): string {
  if (language === "ko") {
    if (mode === "identity-journal") return "1인칭 자아 문장 1개로 시작하고, 이벤트 1개와 근거 2개를 연결";
    if (mode === "philosophy-note") return "철학/책에서 가져온 프레임 1개를 현재 크립토 맥락으로 번역";
    if (mode === "interaction-experiment") return "팔로워가 바로 답할 수 있는 질문 1개를 넣고 근거를 제시";
    if (mode === "meta-reflection") return "내가 틀릴 수 있는 지점을 먼저 고백하고 검증 조건을 밝힘";
    return "짧은 에세이 톤을 쓰되, 은유는 1회만 사용하고 근거 2개로 고정";
  }

  if (mode === "identity-journal") return "Open in first person, then connect one event with two evidence points";
  if (mode === "philosophy-note") return "Use one philosophy/book frame and translate it into current crypto context";
  if (mode === "interaction-experiment") return "Include one concrete audience question and attach evidence";
  if (mode === "meta-reflection") return "State your potential failure mode first, then define verification condition";
  return "Keep essay tone with one metaphor max, grounded by two evidence points";
}

function buildEndingDirective(mode: NarrativeMode, language: "ko" | "en"): string {
  if (language === "ko") {
    if (mode === "interaction-experiment") return "마지막 문장은 팔로워가 답할 수 있는 열린 질문";
    if (mode === "meta-reflection") return "마지막 문장은 내가 틀릴 조건을 명시한 열린 질문";
    return "마지막 문장은 대화를 여는 질문형 또는 관찰형";
  }

  if (mode === "interaction-experiment") return "End with an open question that invites a direct reply";
  if (mode === "meta-reflection") return "End with a falsifiable open question";
  return "End with an open dialogue invitation";
}

function normalizeNarrativeText(text: string): string {
  return sanitizeTweetText(String(text || ""))
    .toLowerCase()
    .replace(/[“”]/g, "\"")
    .replace(/\s+/g, " ")
    .trim();
}

function buildNarrativeSkeleton(text: string): string {
  return normalizeNarrativeText(text)
    .replace(/\$[a-z]{2,10}/g, " token ")
    .replace(/[+-]?\d+(?:[.,]\d+)?%/g, " pct ")
    .replace(/\d[\d,]*(?:\.\d+)?/g, " num ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function roundScore(value: number): number {
  const bounded = Math.min(1, Math.max(0, value));
  return Math.round(bounded * 100) / 100;
}
