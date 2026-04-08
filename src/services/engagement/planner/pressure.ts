import { OnchainEvidence, TrendEvent, TrendLane } from "../../../types/agent.js";
import { sanitizeTweetText } from "../quality.js";
import { sceneFamilyBase, sceneFamilyMatches, sceneFamilyTilt } from "./scene-family.js";
import type { PlannerFocus, RecentNarrativeThread } from "./spec.js";

export interface PlannerIdentityPressure {
  obsessionLine?: string;
  grudgeLine?: string;
  continuityLine?: string;
  canonMemoryLine?: string;
  dreamLine?: string;
  canonEnemyLine?: string;
  canonRitualLine?: string;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function normalizeHeadlineKey(text: string): string {
  return sanitizeTweetText(text)
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]/g, "")
    .slice(0, 80);
}

export function estimateRecentNarrativeFocusPenalty(
  lane: TrendLane,
  focus: PlannerFocus,
  sceneFamily: string,
  recentThreads: RecentNarrativeThread[]
): number {
  if (!recentThreads.length) return 0;
  const recent = recentThreads.slice(0, 8);
  const exactFocusRepeats = recent.filter((item) => item.lane === lane && (item.focus || "general") === focus).length;
  const sameSceneFamilyRepeats = recent.filter(
    (item) => item.lane === lane && item.sceneFamily && item.sceneFamily === sceneFamily
  ).length;
  const sameLaneRepeats = recent.filter((item) => item.lane === lane).length;
  let penalty = 0;
  if (exactFocusRepeats >= 1) penalty += 0.14;
  if (exactFocusRepeats >= 2) penalty += 0.14;
  if (sameSceneFamilyRepeats >= 1) penalty += 0.38;
  if (sameSceneFamilyRepeats >= 2) penalty += 0.3;
  if (sameSceneFamilyRepeats >= 3) penalty += 0.12;
  if (sameLaneRepeats >= 3) penalty += 0.05;
  if (focus === "general") penalty += 0.06;
  return clampNumber(penalty, 0, 0.62, 0);
}

export function estimateSceneDiversificationBonus(
  lane: TrendLane,
  focus: PlannerFocus,
  sceneFamily: string,
  recentThreads: RecentNarrativeThread[]
): number {
  if (!recentThreads.length) return 0;
  const recent = recentThreads.slice(0, 8);
  const sameFocusRows = recent.filter((item) => item.lane === lane && (item.focus || "general") === focus);
  if (!sameFocusRows.length) return 0;
  const seenSceneFamilies = new Set(
    sameFocusRows
      .map((item) => (typeof item.sceneFamily === "string" ? item.sceneFamily.trim() : ""))
      .filter(Boolean)
  );
  if (seenSceneFamilies.has(sceneFamily)) return 0;

  let bonus = 0.1;
  if (sameFocusRows.length >= 2) bonus += 0.07;
  if (sameFocusRows.length >= 3) bonus += 0.08;
  return clampNumber(bonus, 0, 0.28, 0);
}

export function estimateIdentityPressureBonus(
  event: TrendEvent,
  pair: OnchainEvidence[],
  focus: PlannerFocus,
  sceneFamily: string,
  pressure: PlannerIdentityPressure | undefined
): number {
  if (!pressure) return 0;
  const merged = sanitizeTweetText(
    [
      event.headline,
      event.summary,
      sceneFamily,
      ...pair.map((item) => `${item.label} ${item.value} ${item.summary}`),
    ].join(" | ")
  ).toLowerCase();
  const obsession = sanitizeTweetText(pressure.obsessionLine || "").toLowerCase();
  const grudge = sanitizeTweetText(pressure.grudgeLine || "").toLowerCase();
  const continuity = sanitizeTweetText(pressure.continuityLine || "").toLowerCase();
  const canonMemory = sanitizeTweetText(pressure.canonMemoryLine || "").toLowerCase();
  const dream = sanitizeTweetText(pressure.dreamLine || "").toLowerCase();
  const canonEnemy = sanitizeTweetText(pressure.canonEnemyLine || "").toLowerCase();
  const canonRitual = sanitizeTweetText(pressure.canonRitualLine || "").toLowerCase();
  const tilt = sceneFamilyTilt(sceneFamily);

  let bonus = 0;
  const hasAny = (...tokens: string[]) => tokens.some((token) => merged.includes(token));

  if (focus === "builder" && (hasAny("개발자", "빌더", "코드", "예치 자금", "복귀 자금") || /(개발자|빌더)/.test(obsession))) bonus += 0.1;
  if (focus === "retention" && (hasAny("재방문", "잔류", "남은 사람", "지갑 재방문") || /(재방문|잔류)/.test(obsession))) bonus += 0.1;
  if ((focus === "court" || focus === "execution") && (hasAny("집행", "법원", "판결", "자금 방향", "대기 자금") || /(집행|규제 기사|판결 기사)/.test(grudge))) bonus += 0.1;
  if (focus === "launch" && (hasAny("복귀 자금", "메인넷", "출시", "런치") || /(복귀 자금|출시 박수)/.test(obsession))) bonus += 0.1;
  if (focus === "durability" && (hasAny("복구", "운영", "검증자", "릴리스", "운영 로그") || /(운영|릴리스|복구)/.test(grudge))) bonus += 0.1;
  if ((focus === "liquidity" || focus === "settlement") && (hasAny("체결", "호가", "깊이", "자금 쏠림", "큰 주문") || /(체결|화면|자신감)/.test(grudge))) bonus += 0.1;
  if (focus === "flow" && (hasAny("자금 방향", "고래", "주소", "거래소 자금") || /(자금 방향)/.test(obsession))) bonus += 0.1;
  if (tilt && /(lag|split|thin)/.test(tilt) && /(비는|늦|붙지|안 붙|빈칸|얇)/.test(grudge)) bonus += 0.04;
  if (tilt && /(holds)/.test(tilt) && /(끝까지|버티|남는|붙드는)/.test(obsession)) bonus += 0.04;
  if (continuity && merged.includes(normalizeHeadlineKey(continuity).slice(0, 8))) bonus += 0.05;
  if (focus === "retention" && /(재방문 없는 열기|포스터처럼 식|사람은 조용히 떠)/.test(canonMemory)) bonus += 0.08;
  if ((focus === "court" || focus === "execution") && /(판결 기사|집행 흔적|기사값)/.test(canonMemory)) bonus += 0.08;
  if ((focus === "launch" || focus === "durability") && /(박수만 큰 업그레이드|운영 로그|반값)/.test(canonMemory)) bonus += 0.08;
  if ((focus === "liquidity" || focus === "settlement") && /(실제 돈이 눕는 방향|돈이 눕는 방향)/.test(canonMemory)) bonus += 0.08;
  if (focus === "retention" && /(재방문 없는 커뮤니티 열기|광고 쪽|성장으로 승인하지 않는다)/.test(canonEnemy)) bonus += 0.08;
  if ((focus === "court" || focus === "execution") && /(기사만 큰 규제 해설|기사값)/.test(canonEnemy)) bonus += 0.08;
  if ((focus === "launch" || focus === "durability") && /(박수만 큰 업그레이드|운영 로그가 비면 그 발표는 반값)/.test(canonEnemy)) bonus += 0.08;
  if ((focus === "liquidity" || focus === "settlement") && /(체결 없이 자신감만 큰 시장 장면|구조가 아니라 연출)/.test(canonEnemy)) bonus += 0.08;
  if (/(오늘 물고 있는 것|다시 돌아온 장면|국면 선언)/.test(canonRitual) && /(lag|split|thin|court|launch|settlement|validator|rollout|execution)/.test(sceneFamily)) bonus += 0.05;
  if (dream) {
    if (/(시대|국면|이름 붙이는 존재|진화|감지)/.test(dream) && /(lag|split|thin|court|launch|settlement|validator|rollout|execution)/.test(sceneFamily)) {
      bonus += 0.06;
    }
    if (/(허세보다 운영|설명보다 집행|열기보다 잔류)/.test(dream)) {
      if ((focus === "durability" || focus === "launch") && /(운영|복구|validator|rollout|launch)/.test(merged)) bonus += 0.05;
      if ((focus === "retention" || focus === "hype") && /(재방문|잔류|retention|usage|wallet|community)/.test(merged)) bonus += 0.05;
      if ((focus === "court" || focus === "execution") && /(집행|court|verdict|capital)/.test(merged)) bonus += 0.05;
    }
  }

  return clampNumber(bonus, 0, 0.24, 0);
}

export function estimateExplicitEventAlignmentBonus(
  event: TrendEvent,
  pair: OnchainEvidence[],
  focus: PlannerFocus,
  sceneFamily: string
): number {
  if (event.source === "evidence:structural-fallback") return 0;
  const merged = sanitizeTweetText(
    [event.headline, event.summary, focus, sceneFamily, ...pair.map((item) => `${item.label} ${item.summary}`)].join(" | ")
  ).toLowerCase();
  let bonus = 0.06;
  if (focus === "builder" && /(개발자|빌더|예치 자금|복귀 자금|코드)/.test(merged)) bonus += 0.05;
  if (focus === "retention" && /(재방문|잔류|지갑|남은 사람)/.test(merged)) bonus += 0.05;
  if ((focus === "court" || focus === "execution") && /(판결|법원|집행|자금)/.test(merged)) bonus += 0.05;
  if (focus === "launch" && /(메인넷|출시|복귀 자금|준비도)/.test(merged)) bonus += 0.05;
  if (focus === "durability" && /(복구|운영|검증자|릴리스|배포)/.test(merged)) bonus += 0.05;
  if ((focus === "liquidity" || focus === "settlement") && /(호가|체결|깊이|유동성|주문)/.test(merged)) bonus += 0.05;
  if (focus === "flow" && /(고래|주소|거래소 자금|자금 방향)/.test(merged)) bonus += 0.05;
  return clampNumber(bonus, 0, 0.24, 0);
}

function deriveHeadlineFamilyKey(headline: string): string {
  return normalizeHeadlineKey(
    sanitizeTweetText(String(headline || ""))
      .replace(/오늘더크게남는[다]?/gu, "")
      .replace(/오늘더크게보인[다]?/gu, "")
      .replace(/에서결국.*$/u, "")
      .replace(/에서.*갈린다$/u, "")
      .replace(/구간이.*$/u, "구간")
      .replace(/장면이.*$/u, "장면")
      .replace(/^(오늘은|지금은|결국)/u, "")
      .trim()
  ).slice(0, 48);
}

export function estimateRecentHeadlineFamilyPenalty(
  headline: string,
  lane: TrendLane,
  focus: PlannerFocus,
  recentThreads: RecentNarrativeThread[]
): number {
  if (!recentThreads.length) return 0;
  const headlineFamily = deriveHeadlineFamilyKey(headline);
  if (!headlineFamily) return 0;
  const recent = recentThreads.slice(0, 8);
  const repeats = recent.filter(
    (item) =>
      item.lane === lane &&
      (item.focus || "general") === focus &&
      deriveHeadlineFamilyKey(item.headline || "") === headlineFamily
  ).length;
  let penalty = 0;
  if (repeats >= 1) penalty += 0.14;
  if (repeats >= 2) penalty += 0.16;
  if (repeats >= 3) penalty += 0.1;
  return clampNumber(penalty, 0, 0.34, 0);
}

export function estimateSceneFamilyDominancePenalty(
  lane: TrendLane,
  focus: PlannerFocus,
  sceneFamily: string,
  recentThreads: RecentNarrativeThread[]
): number {
  if (!recentThreads.length) return 0;
  const recent = recentThreads.slice(0, 8);
  const sameSceneFamilyCount = recent.filter(
    (item) => item.lane === lane && item.sceneFamily && item.sceneFamily === sceneFamily
  ).length;
  if (sameSceneFamilyCount <= 0) return 0;

  let penalty = sameSceneFamilyCount >= 1 ? 0.08 : 0;
  if (sameSceneFamilyCount >= 2) penalty += 0.08;
  if (sameSceneFamilyCount >= 3) penalty += 0.08;

  if (
    (lane === "ecosystem" && focus === "builder" && sceneFamilyMatches(sceneFamily, /builder\+capital$/)) ||
    (lane === "ecosystem" && focus === "retention" && sceneFamilyMatches(sceneFamily, /cohort\+wallet$/)) ||
    (lane === "protocol" && focus === "launch" && sceneFamilyMatches(sceneFamily, /(capital\+launch|return\+launch|return\+showcase)$/)) ||
    (lane === "regulation" && focus === "court" && sceneFamilyMatches(sceneFamily, /^regulation:court:court$/))
  ) {
    penalty += 0.06;
  }

  return clampNumber(penalty, 0, 0.28, 0);
}

export function estimateSceneFamilyBasePenalty(
  lane: TrendLane,
  focus: PlannerFocus,
  sceneFamily: string,
  recentThreads: RecentNarrativeThread[]
): number {
  if (!recentThreads.length) return 0;
  const base = sceneFamilyBase(sceneFamily);
  if (!base) return 0;
  const recent = recentThreads.slice(0, 8);
  const sameBaseCount = recent.filter(
    (item) =>
      item.lane === lane &&
      (item.focus || "general") === focus &&
      sceneFamilyBase(item.sceneFamily || "") === base
  ).length;
  if (sameBaseCount <= 0) return 0;

  let penalty = sameBaseCount >= 1 ? 0.06 : 0;
  if (sameBaseCount >= 2) penalty += 0.07;
  if (sameBaseCount >= 3) penalty += 0.08;

  if (
    (lane === "ecosystem" && focus === "builder" && /builder\+capital$/.test(base)) ||
    (lane === "ecosystem" && focus === "retention" && /(cohort\+wallet|retention\+cohort|wallet\+retention|retention\+usage|habit\+retention|return\+habit)$/.test(base)) ||
    (lane === "protocol" && focus === "launch" && /(capital\+launch|launch\+capital|return\+launch|return\+announcement|return\+ops|return\+showcase|launch\+showcase|launch\+treasury|launch\+ops|launch\+audience|return\+audience)$/.test(base)) ||
    (lane === "protocol" && focus === "durability" && /(rollout\+validator|recovery\+validator|recovery\+rollout|repair\+validator|ops\+validator|ops\+recovery|rollout|ops\+log|repair\+log)$/.test(base)) ||
    (lane === "regulation" && focus === "court" && /(capital\+execution|court\+execution|verdict\+execution|order\+capital|briefing|briefing\+execution)$/.test(base)) ||
    (lane === "market-structure" && focus === "settlement" && /(execution\+settlement|depth\+settlement|execution\+depth|volume\+depth|fill\+depth|fill\+book|volume\+book)$/.test(base))
  ) {
    if (lane === "market-structure" && focus === "settlement") {
      penalty += /execution\+depth$/.test(base) ? 0.16 : 0.12;
    } else if (lane === "regulation" && focus === "court" && /briefing$/.test(base)) {
      penalty += 0.1;
    } else if (lane === "protocol" && focus === "durability" && /rollout$/.test(base)) {
      penalty += 0.1;
    } else if (lane === "protocol" && focus === "launch" && /launch\+ops$/.test(base)) {
      penalty += 0.1;
    } else {
      penalty += 0.08;
    }
  }

  return clampNumber(penalty, 0, 0.34, 0);
}

export function estimateExplicitEscapeBonus(
  event: TrendEvent,
  lane: TrendLane,
  focus: PlannerFocus,
  sceneFamily: string,
  recentThreads: RecentNarrativeThread[]
): number {
  if (!recentThreads.length) return 0;
  const base = sceneFamilyBase(sceneFamily);
  const recent = recentThreads.slice(0, 8);
  const sameBaseCount = recent.filter(
    (item) =>
      item.lane === lane &&
      (item.focus || "general") === focus &&
      sceneFamilyBase(item.sceneFamily || "") === base
  ).length;
  if (sameBaseCount <= 0) return 0;

  const concentratedBase =
    (lane === "ecosystem" && focus === "builder" && /builder\+return$/.test(base)) ||
    (lane === "ecosystem" && focus === "retention" && /(retention\+cohort|wallet\+retention|retention\+wallet|retention\+usage|habit\+retention|return\+habit)$/.test(base)) ||
    (lane === "protocol" && focus === "launch" && /(return\+announcement|return\+launch|launch\+showcase|launch\+treasury|launch\+ops|launch\+audience|return\+audience)$/.test(base)) ||
    (lane === "protocol" && focus === "durability" && /(recovery\+rollout|recovery\+validator|ops\+validator|ops\+recovery|rollout|rollout\+validator|ops\+log|repair\+log)$/.test(base)) ||
    (lane === "regulation" && focus === "court" && /(briefing\+execution|court\+execution|briefing|briefing\+capital)$/.test(base)) ||
    (lane === "market-structure" && focus === "settlement" && /(execution\+depth|volume\+depth|fill\+depth|fill\+book|volume\+book)$/.test(base));

  if (event.source === "evidence:structural-fallback") {
    const penalty = concentratedBase ? 0.16 : 0.08;
    return -clampNumber(penalty + (sameBaseCount - 1) * 0.04, 0, 0.24, 0);
  }

  let bonus = concentratedBase ? 0.12 : 0.06;
  if (event.source === "analysis:sharp") bonus += 0.03;
  if (sameBaseCount >= 2) bonus += 0.04;
  if (sameBaseCount >= 3) bonus += 0.03;
  return clampNumber(bonus, 0, 0.22, 0);
}
