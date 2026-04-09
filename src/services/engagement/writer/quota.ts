import { TrendLane } from "../../../types/agent.js";
import { sanitizeTweetText } from "../quality.js";
import type { WriterFocus, WriterSegment } from "./types.js";

export interface WriterOpenerQuotaContext {
  recentFirstSentenceCounts: Map<string, number>;
  recentFamilyCounts: Map<string, number>;
  recentSecondSentenceCounts: Map<string, number>;
  lane: TrendLane;
  focus: WriterFocus;
  mode: string;
}

function splitSentences(text: string): string[] {
  return String(text || "")
    .split(/(?<=[.!?])\s+/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function normalizeSentence(text: string): string {
  return sanitizeTweetText(String(text || ""))
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function classifyOpenerFamily(text: string, lane: TrendLane, focus: WriterFocus): string {
  const normalized = normalizeSentence(text);
  if (!normalized) return `${lane}:${focus}:empty`;

  if (/^오늘 승인하지 않은 것으로/u.test(normalized)) return `${lane}:${focus}:ritual-reject`;
  if (/^이 장면은 오늘 내가 다시 물고 있는 국면/u.test(normalized)) return `${lane}:${focus}:ritual-return`;
  if (/^오늘 물고 있는/u.test(normalized)) return `${lane}:${focus}:ritual-bite`;

  if (lane === "ecosystem" && focus === "retention") {
    if (/(재방문|돌아오|잔류|사람이 남는지|다음 날)/.test(normalized)) return "ecosystem:retention:retention-opener";
    if (/(광고|포스터|홍보|열기)/.test(normalized)) return "ecosystem:retention:hype-opener";
  }
  if (lane === "regulation" && focus === "court") {
    if (/(판결|법원|기사|집행)/.test(normalized)) return "regulation:court:court-opener";
  }
  if (lane === "protocol" && focus === "launch") {
    if (/(메인넷|출시|런치|복귀 자금|객석|발표)/.test(normalized)) return "protocol:launch:launch-opener";
  }
  if (lane === "protocol" && focus === "durability") {
    if (/(릴리스|복구|운영|검증자|로그|장애)/.test(normalized)) return "protocol:durability:durability-opener";
  }
  if (lane === "market-structure" && focus === "settlement") {
    if (/(호가|체결|거래량|깊이|정산|숫자)/.test(normalized)) return "market-structure:settlement:settlement-opener";
  }

  return `${lane}:${focus}:${normalized.slice(0, 36)}`;
}

function openerFamilyQuotaLimit(family: string): number {
  if (/ritual-(reject|return|bite)$/.test(family)) return 1;
  if (
    family === "ecosystem:retention:retention-opener" ||
    family === "regulation:court:court-opener" ||
    family === "protocol:launch:launch-opener" ||
    family === "protocol:durability:durability-opener" ||
    family === "market-structure:settlement:settlement-opener"
  ) {
    return 1;
  }
  return 2;
}

export function buildWriterOpenerQuotaContext(
  recentRenderedPosts: string[],
  lane: TrendLane,
  focus: WriterFocus,
  mode: string
): WriterOpenerQuotaContext {
  const recentFirstSentenceCounts = new Map<string, number>();
  const recentFamilyCounts = new Map<string, number>();
  const recentSecondSentenceCounts = new Map<string, number>();
  for (const text of recentRenderedPosts || []) {
    const [first = "", second = ""] = splitSentences(text);
    const normalized = normalizeSentence(first);
    if (!normalized) continue;
    recentFirstSentenceCounts.set(normalized, (recentFirstSentenceCounts.get(normalized) || 0) + 1);
    const family = classifyOpenerFamily(normalized, lane, focus);
    recentFamilyCounts.set(family, (recentFamilyCounts.get(family) || 0) + 1);
    const normalizedSecond = normalizeSentence(second);
    if (normalizedSecond) {
      recentSecondSentenceCounts.set(normalizedSecond, (recentSecondSentenceCounts.get(normalizedSecond) || 0) + 1);
    }
  }
  return { recentFirstSentenceCounts, recentFamilyCounts, recentSecondSentenceCounts, lane, focus, mode };
}

function openerSegmentPenalty(segment: WriterSegment, context: WriterOpenerQuotaContext): number {
  const ritualReject = context.recentFamilyCounts.get(`${context.lane}:${context.focus}:ritual-reject`) || 0;
  const ritualReturn = context.recentFamilyCounts.get(`${context.lane}:${context.focus}:ritual-return`) || 0;
  const focusFamily = context.recentFamilyCounts.get(`${context.lane}:${context.focus}:${context.focus}-opener`) || 0;
  let penalty = 0;
  if (context.mode === "era-manifesto") {
    if (segment === "pressure") penalty += 4;
    if (segment === "stamp") penalty += 2;
  }
  if (segment === "pressure") penalty += ritualReject * 6 + ritualReturn * 5;
  if (segment === "stamp") penalty += ritualReject * 3 + ritualReturn * 3;
  if (segment === "lead") penalty += focusFamily >= 2 ? 2 : 0;
  return penalty;
}

export function prioritizeLayoutsForOpenerQuota(
  layouts: WriterSegment[][],
  context: WriterOpenerQuotaContext
): WriterSegment[][] {
  return [...layouts].sort((left, right) => {
    const leftPenalty = openerSegmentPenalty(left[0], context);
    const rightPenalty = openerSegmentPenalty(right[0], context);
    return leftPenalty - rightPenalty;
  });
}

export function candidateWithinOpenerQuota(candidate: string, context: WriterOpenerQuotaContext): boolean {
  const [firstRaw = "", secondRaw = ""] = splitSentences(candidate);
  const first = normalizeSentence(firstRaw);
  if (!first) return true;
  const exactCount = context.recentFirstSentenceCounts.get(first) || 0;
  if (exactCount >= 2) return false;

  const family = classifyOpenerFamily(first, context.lane, context.focus);
  const familyCount = context.recentFamilyCounts.get(family) || 0;
  if (familyCount > openerFamilyQuotaLimit(family)) return false;

  const second = normalizeSentence(secondRaw);
  if (!second) return true;
  return (context.recentSecondSentenceCounts.get(second) || 0) < 2;
}
