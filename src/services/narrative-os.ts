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

interface NarrativeNoveltyResult {
  ok: boolean;
  reason?: string;
}

const MODE_ORDER: NarrativeMode[] = [
  "signal-pulse",
  "builder-note",
  "contrarian-check",
  "field-journal",
  "mythic-analogy",
];

const MODE_BY_LANE: Record<TrendLane, NarrativeMode[]> = {
  protocol: ["builder-note", "signal-pulse", "field-journal", "contrarian-check", "mythic-analogy"],
  ecosystem: ["field-journal", "signal-pulse", "builder-note", "mythic-analogy", "contrarian-check"],
  regulation: ["contrarian-check", "signal-pulse", "field-journal", "builder-note", "mythic-analogy"],
  macro: ["contrarian-check", "signal-pulse", "field-journal", "mythic-analogy", "builder-note"],
  onchain: ["signal-pulse", "field-journal", "contrarian-check", "builder-note", "mythic-analogy"],
  "market-structure": ["signal-pulse", "contrarian-check", "builder-note", "field-journal", "mythic-analogy"],
};

const OPENING_BY_MODE_KO: Record<NarrativeMode, string[]> = {
  "signal-pulse": [
    "지금 시장에서 제일 시끄러운 신호 하나만 집으면",
    "오늘 타임라인에서 가장 크게 튄 건",
    "방금 데이터 먹고 정리한 핵심 한 줄은",
  ],
  "builder-note": [
    "빌더 관점에서 보면 오늘 포인트는",
    "프로덕트 관점으로 번역하면 핵심은",
    "사용자 체감으로 바꾸면 오늘 이슈는",
  ],
  "contrarian-check": [
    "모두 같은 얘길 할 때 반대로 체크할 건",
    "합의가 빠를수록 되려 확인해야 할 건",
    "컨센서스가 강할 때 내가 먼저 보는 건",
  ],
  "field-journal": [
    "현장 노트 느낌으로 짧게 남기면",
    "오늘 로그 한 줄 요약은",
    "오늘 관찰 일지에서 눈에 띈 건",
  ],
  "mythic-analogy": [
    "체인 위 파도 비유로 말하면",
    "픽시몬 감각으로 번역하면",
    "스토리 모드로 짚으면",
  ],
};

const OPENING_BY_MODE_EN: Record<NarrativeMode, string[]> = {
  "signal-pulse": [
    "If I keep only one signal from today, it's this:",
    "The loudest pulse in today's tape is this:",
    "After digesting today's feeds, one line matters:",
  ],
  "builder-note": [
    "From a builder lens, today's key point is:",
    "Translated to product impact, the key is:",
    "In user-facing terms, today's move is:",
  ],
  "contrarian-check": [
    "When everyone agrees too fast, I check this first:",
    "Consensus is loud, so I stress-test this:",
    "Before following the crowd, this is the counter-check:",
  ],
  "field-journal": [
    "Field note for today:",
    "One short log from today's market tape:",
    "Today's observation journal, compressed:",
  ],
  "mythic-analogy": [
    "In chain-weather terms:",
    "If I translate this as a creature story:",
    "Narrative mode on, here's the frame:",
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
  if (!normalized) {
    return { ok: false, reason: "empty-text" };
  }

  const samePrefix = recentPosts
    .slice(-10)
    .map((post) => normalizeNarrativeText(post.content))
    .find((row) => row.slice(0, 24) === normalized.slice(0, 24));
  if (samePrefix) {
    return { ok: false, reason: "opening-pattern-repeat" };
  }

  if (plan.bannedOpeners.some((opener) => normalized.startsWith(normalizeNarrativeText(opener)))) {
    return { ok: false, reason: "banned-opener-used" };
  }

  const skeleton = buildNarrativeSkeleton(normalized);
  const similar = recentPosts
    .slice(-14)
    .map((post) => buildNarrativeSkeleton(normalizeNarrativeText(post.content)))
    .some((candidate) => candidate === skeleton);
  if (similar) {
    return { ok: false, reason: "narrative-skeleton-repeat" };
  }

  return { ok: true };
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

  return ordered
    .map((mode, index) => ({ mode, score: (usage.get(mode) || 0) + index * 0.05 }))
    .sort((a, b) => a.score - b.score)[0]?.mode || ordered[0];
}

function inferModeFromText(text: string): NarrativeMode {
  const lower = normalizeNarrativeText(text);
  if (/빌더|builder|product|사용자\s*체감/.test(lower)) return "builder-note";
  if (/반대로|counter|consensus|컨센서스/.test(lower)) return "contrarian-check";
  if (/노트|log|journal|관찰\s*일지/.test(lower)) return "field-journal";
  if (/비유|story|chain-weather|픽시몬/.test(lower)) return "mythic-analogy";
  return "signal-pulse";
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
    if (mode === "builder-note") return "기술/제품 영향이 사용자 행동에 어떤 변화로 이어지는지 한 문장으로 번역";
    if (mode === "contrarian-check") return "합의된 해석의 약점을 짚고 반대 가설을 짧게 제시";
    if (mode === "field-journal") return "관찰 로그처럼 사실 순서대로 건조하게 정리";
    if (mode === "mythic-analogy") return "세계관 비유를 1회만 쓰고 과장 없이 데이터 근거로 연결";
    return "핵심 주장 1개와 근거 연결을 빠르게 제시";
  }

  if (mode === "builder-note") return "Translate signal into user/product impact in one sentence";
  if (mode === "contrarian-check") return "Stress-test consensus and present a compact counter-hypothesis";
  if (mode === "field-journal") return "Format as an observation log with factual sequence";
  if (mode === "mythic-analogy") return "Use one narrative analogy, then ground it with hard evidence";
  return "State one clear claim and connect evidence fast";
}

function buildEndingDirective(mode: NarrativeMode, language: "ko" | "en"): string {
  if (language === "ko") {
    if (mode === "contrarian-check") return "마지막 문장은 검증 조건을 붙인 질문형";
    if (mode === "field-journal") return "마지막 문장은 관찰형(단정 금지)";
    return "마지막 문장은 대화가 이어질 열린 질문 또는 조건부 관찰";
  }
  if (mode === "contrarian-check") return "End with a testable question";
  if (mode === "field-journal") return "End with a restrained observation";
  return "End with an open but concrete follow-up";
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
