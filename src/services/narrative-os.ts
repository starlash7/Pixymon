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
  "meta-reflection",
  "interaction-experiment",
  "philosophy-note",
  "fable-essay",
];

const MODE_BY_LANE: Record<TrendLane, NarrativeMode[]> = {
  protocol: ["identity-journal", "meta-reflection", "interaction-experiment", "philosophy-note", "fable-essay"],
  ecosystem: ["identity-journal", "meta-reflection", "interaction-experiment", "philosophy-note", "fable-essay"],
  regulation: ["identity-journal", "meta-reflection", "interaction-experiment", "philosophy-note", "fable-essay"],
  macro: ["identity-journal", "meta-reflection", "interaction-experiment", "philosophy-note", "fable-essay"],
  onchain: ["identity-journal", "meta-reflection", "interaction-experiment", "philosophy-note", "fable-essay"],
  "market-structure": ["identity-journal", "meta-reflection", "interaction-experiment", "philosophy-note", "fable-essay"],
};

const MODE_INTRINSIC_PENALTY: Record<NarrativeMode, number> = {
  "identity-journal": 0,
  "meta-reflection": 0.03,
  "interaction-experiment": 0.12,
  "philosophy-note": 0.4,
  "fable-essay": 0.46,
};

const OPENING_BY_MODE_KO: Record<NarrativeMode, string[]> = {
  "identity-journal": [
    "오늘은 이 장면부터 적어 둔다",
    "지금 자꾸 눈에 밟히는 건",
    "오늘 메모의 출발점은",
    "이 장면부터 먼저 남겨 둔다",
  ],
  "philosophy-note": [
    "이 장면을 한 걸음 떨어져서 보면",
    "읽던 문장을 오늘 체인 위에 겹쳐 보면",
    "길게 말하기보다 한 줄로 줄이면",
    "생각의 프레임을 바꾸면 먼저 보이는 건",
  ],
  "interaction-experiment": [
    "여기서는 네 판단이 궁금하다",
    "같은 장면을 다르게 읽을 지점은 여기다",
    "이 대목은 같이 확인해 보고 싶다",
    "이 장면은 혼자 결론 내리기보다 같이 보고 싶다",
  ],
  "meta-reflection": [
    "먼저 걸리는 건",
    "이 장면에선 내가 틀릴 자리도 같이 본다",
    "확신보다 먼저 적어 둘 건",
    "오늘 특히 조심해야 할 대목은",
  ],
  "fable-essay": [
    "굳이 이야기로 바꾸지 않아도 남는 장면은",
    "짧게 적어 두면 이런 장면이다",
    "비유 없이 적어도 충분히 이상한 장면은",
    "한 문단보다 더 짧게 줄이면",
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
    .map((mode, index) => ({
      mode,
      score: (usage.get(mode) || 0) + (MODE_INTRINSIC_PENALTY[mode] || 0) + index * 0.03,
    }))
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
    if (mode === "identity-journal") return "내 메모처럼 시작하되, 이벤트 1개와 근거 2개를 사람 말로 연결";
    if (mode === "philosophy-note") return "추상 문장을 그대로 쓰지 말고 현재 크립토 장면으로 풀어 번역";
    if (mode === "interaction-experiment") return "질문은 1개만 두고, 먼저 내 판단의 근거 2개를 짧게 제시";
    if (mode === "meta-reflection") return "내가 놓칠 수 있는 지점을 먼저 말하고 왜 다시 보는지 짧게 적음";
    return "짧은 산문처럼 쓰되 템플릿 티를 없애고 근거 2개는 자연스럽게 녹임";
  }

  if (mode === "identity-journal") return "Open in first person, then connect one event with two evidence points";
  if (mode === "philosophy-note") return "Use one philosophy/book frame and translate it into current crypto context";
  if (mode === "interaction-experiment") return "Include one concrete audience question and attach evidence";
  if (mode === "meta-reflection") return "State your potential failure mode first, then define verification condition";
  return "Keep essay tone with one metaphor max, grounded by two evidence points";
}

function buildEndingDirective(mode: NarrativeMode, language: "ko" | "en"): string {
  if (language === "ko") {
    if (mode === "interaction-experiment") return "끝은 바로 답할 수 있는 짧은 질문으로 마무리";
    if (mode === "meta-reflection") return "끝은 틀릴 조건을 짚거나 다시 볼 포인트를 남김";
    return "끝은 너무 교훈적으로 닫지 말고, 질문형 또는 열린 관찰형으로 마무리";
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
