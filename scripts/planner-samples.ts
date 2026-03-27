import fs from "node:fs";
import path from "node:path";
import {
  buildEventEvidenceFallbackPost,
  buildStructuralFallbackEventsFromEvidence,
  planEventEvidenceAct,
} from "../src/services/engagement/event-evidence.ts";
import type { OnchainEvidence, TrendEvent, TrendLane, NarrativeMode } from "../src/types/agent.ts";
import type { RecentPostRecord } from "../src/services/engagement/types.ts";

type PlannerThread = {
  lane: TrendLane;
  focus?: string;
  sceneFamily?: string;
  headline?: string;
};

type PlannerSampleCase = {
  id: string;
  lane: TrendLane;
  mode: NarrativeMode;
  events: TrendEvent[];
  evidence: OnchainEvidence[];
  recentPosts?: RecentPostRecord[];
  recentNarrativeThreads?: PlannerThread[];
};

type PlannerSample = {
  caseId: string;
  lane: TrendLane;
  mode: NarrativeMode;
  variant: number;
  lengthProfile: string;
  maxChars: number;
  charCount: number;
  eventSource: string;
  focus: string;
  sceneFamily: string;
  plannerScore: number;
  plannerWarnings: string[];
  text: string;
  firstSentence: string;
  secondSentence: string;
};

type LengthProfile = {
  label: "flash" | "short" | "standard" | "long" | "essay";
  maxChars: number;
};

const LENGTH_PROFILES: LengthProfile[] = [
  { label: "flash", maxChars: 104 },
  { label: "short", maxChars: 142 },
  { label: "standard", maxChars: 196 },
  { label: "long", maxChars: 248 },
  { label: "essay", maxChars: 320 },
];

function sceneFamilyBase(sceneFamily: string): string {
  const parts = String(sceneFamily || "")
    .split(":")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length <= 3) return parts.join(":");
  return parts.slice(0, 3).join(":");
}

function sceneFamilyTilt(sceneFamily: string): string {
  const parts = String(sceneFamily || "")
    .split(":")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length <= 3) return "";
  return parts.slice(3).join(":");
}

function identityPressureForLane(lane: TrendLane) {
  const map: Record<
    TrendLane,
    { obsessionLine: string; grudgeLine: string; continuityLine: string }
  > = {
    protocol: {
      obsessionLine: "지금 픽시몬이 끝까지 붙드는 건 릴리스보다 운영 로그다.",
      grudgeLine: "운영이 비어 있는데 릴리스 노트만 큰 서사를 제일 싫어한다.",
      continuityLine: '직전 스레드 "릴리스 박수보다 복구 태도"에서 걸린 지점을 이번에도 다시 확인한다.',
    },
    ecosystem: {
      obsessionLine: "지금 픽시몬이 끝까지 붙드는 건 재방문과 잔류다.",
      grudgeLine: "사람은 안 남는데 커뮤니티 열기만 큰 얘기를 제일 싫어한다.",
      continuityLine: '직전 스레드 "서사보다 남은 사람 수"에서 걸린 지점을 이번에도 다시 확인한다.',
    },
    regulation: {
      obsessionLine: "지금 픽시몬이 끝까지 붙드는 건 기사보다 집행 흔적이다.",
      grudgeLine: "집행은 없는데 기사만 큰 규제 해설을 제일 싫어한다.",
      continuityLine: '직전 스레드 "판결 기사보다 실제 자금 반응"에서 걸린 지점을 이번에도 다시 확인한다.',
    },
    macro: {
      obsessionLine: "지금 픽시몬이 끝까지 붙드는 건 큰 해설보다 자금 습관 변화다.",
      grudgeLine: "배치가 안 바뀌는데 거시 해설만 커지는 장면을 제일 싫어한다.",
      continuityLine: '직전 스레드 "해설보다 자금 습관"에서 걸린 지점을 이번에도 다시 확인한다.',
    },
    onchain: {
      obsessionLine: "지금 픽시몬이 끝까지 붙드는 건 하루를 버틴 온체인 신호다.",
      grudgeLine: "하루도 못 버티는 온체인 숫자를 제일 안 믿는다.",
      continuityLine: '직전 스레드 "튀는 숫자보다 남은 흔적"에서 걸린 지점을 이번에도 다시 확인한다.',
    },
    "market-structure": {
      obsessionLine: "지금 픽시몬이 끝까지 붙드는 건 분위기보다 실제 돈이다.",
      grudgeLine: "체결은 없는데 자신감만 큰 화면을 제일 싫어한다.",
      continuityLine: '직전 스레드 "호가보다 실제 체결"에서 걸린 지점을 이번에도 다시 확인한다.',
    },
  };
  return map[lane];
}

const createdAt = new Date().toISOString();

function event(
  id: string,
  lane: TrendLane,
  headline: string,
  summary: string,
  source: string,
  keywords: string[],
  trust = 0.82,
  freshness = 0.91
): TrendEvent {
  return {
    id,
    lane,
    headline,
    summary,
    source,
    trust,
    freshness,
    capturedAt: createdAt,
    keywords,
  };
}

function evidence(
  id: string,
  lane: TrendLane,
  source: "onchain" | "market" | "news",
  label: string,
  value: string,
  summary: string,
  trust = 0.82,
  freshness = 0.9,
  digestScore = 0.74
): OnchainEvidence {
  return {
    id,
    lane,
    nutrientId: `nutrient:${id}`,
    source,
    label,
    value,
    summary,
    trust,
    freshness,
    digestScore,
    capturedAt: createdAt,
  };
}

const cases: PlannerSampleCase[] = [
  {
    id: "eco-builder",
    lane: "ecosystem",
    mode: "identity-journal",
    events: [
      event(
        "eco-builder-sharp",
        "ecosystem",
        "개발자 잔류는 남는데 예치 자금 복귀가 늦는 구간",
        "Builder retention holds while deposited capital returns more slowly than narrative momentum.",
        "evidence:structural-fallback",
        ["개발자", "예치", "복귀"]
      ),
      event(
        "eco-builder-generic",
        "ecosystem",
        "커뮤니티 열기만 커지는 날",
        "Community excitement rises faster than actual builder retention.",
        "news:desk",
        ["커뮤니티", "열기"]
      ),
    ],
    evidence: [
      evidence("eco-builder-a", "ecosystem", "onchain", "개발자 잔류", "유지", "Developer retention stayed firm across the release window."),
      evidence("eco-builder-b", "ecosystem", "market", "예치 자금 복귀", "지연", "Deposited capital returned slower than expected after the upgrade cycle."),
      evidence("eco-builder-c", "ecosystem", "news", "빌더 업데이트", "지속", "Builder update cadence stayed active across ecosystem channels.", 0.79, 0.87, 0.71),
      evidence("eco-builder-d", "ecosystem", "news", "커뮤니티 반응", "과열", "Community response ran ahead of actual builder participation.", 0.71, 0.84, 0.64),
    ],
    recentNarrativeThreads: [
      { lane: "ecosystem", focus: "builder", sceneFamily: "ecosystem:builder:builder+usage", headline: "이전 빌더 장면" },
    ],
  },
  {
    id: "eco-retention",
    lane: "ecosystem",
    mode: "meta-reflection",
    events: [
      event(
        "eco-retention-explicit",
        "ecosystem",
        "지갑 재방문은 남는데 커뮤니티 열기만 먼저 식는 구간",
        "Wallet return survives after community heat fades, exposing whether the ecosystem can hold people.",
        "analysis:sharp",
        ["재방문", "지갑", "커뮤니티"]
      ),
      event(
        "eco-retention-sharp",
        "ecosystem",
        "생태계 서사가 실제 잔류로 이어지는지 본다",
        "Usage retention matters more than loud narrative.",
        "evidence:structural-fallback",
        ["생태계", "잔류"]
      ),
    ],
    evidence: [
      evidence("eco-retention-a", "onchain", "onchain", "지갑 재방문", "확대", "실사용 흔적이 초기 서사 뒤에도 남아 있는지 보는 단서다."),
      evidence("eco-retention-b", "ecosystem", "news", "사용자 재방문 흐름", "확대", "서사 이후에도 다시 돌아오는 사용자가 실제로 늘었는지 보는 단서다."),
      evidence("eco-retention-c", "ecosystem", "news", "커뮤니티 반응", "과열", "커뮤니티 반응만 뜨거워진 구간이다.", 0.68, 0.8, 0.55),
      evidence("eco-retention-d", "ecosystem", "onchain", "체인 안쪽 사용", "유지", "체인 안쪽 사용은 유지되지만 반응의 온도는 먼저 식고 있는 장면이다.", 0.8, 0.88, 0.72),
    ],
  },
  {
    id: "eco-retention-usage",
    lane: "ecosystem",
    mode: "interaction-experiment",
    events: [
      event(
        "eco-retention-usage-explicit",
        "ecosystem",
        "재방문은 남는데 생활 흔적이 다음 날까지 못 이어지는 구간",
        "People return, but the habit does not persist into the next day.",
        "analysis:sharp",
        ["재방문", "생활 흔적", "다음 날"]
      ),
    ],
    evidence: [
      evidence("eco-retention-usage-a", "ecosystem", "news", "사용자 재방문 흐름", "유지", "사람은 다시 들어오지만 다음 날까지 머무는 습관은 아직 얕다."),
      evidence("eco-retention-usage-b", "ecosystem", "onchain", "체인 안쪽 사용", "둔화", "생활 흔적은 생기지만 다음 날로 이어지는 강도는 아직 얕다."),
      evidence("eco-retention-usage-c", "ecosystem", "onchain", "지갑 재방문", "확대", "지갑은 돌아오지만 사용 습관은 아직 납작하게 남는 장면이다.", 0.8, 0.88, 0.72),
    ],
  },
  {
    id: "reg-court",
    lane: "regulation",
    mode: "interaction-experiment",
    events: [
      event(
        "reg-court-sharp",
        "regulation",
        "판결 기사와 자금 방향이 다른 구간",
        "Court headlines and actual capital direction diverge.",
        "evidence:structural-fallback",
        ["판결", "자금"]
      ),
    ],
    evidence: [
      evidence("reg-court-a", "regulation", "news", "법원 일정", "집중", "Court calendar coverage dominated the news cycle."),
      evidence("reg-court-b", "regulation", "news", "집행 흔적", "지연", "Actual enforcement traces lagged behind the court-driven narrative.", 0.82, 0.88, 0.76),
      evidence("reg-court-c", "regulation", "onchain", "대기 자금 흐름", "관망", "Waiting capital stayed cautious despite the legal excitement.", 0.78, 0.87, 0.7),
      evidence("reg-court-d", "regulation", "market", "ETF 대기 주문", "정체", "ETF-related waiting orders did not expand with the court headline.", 0.75, 0.85, 0.67),
    ],
  },
  {
    id: "reg-court-order",
    lane: "regulation",
    mode: "meta-reflection",
    events: [
      event(
        "reg-court-order-explicit",
        "regulation",
        "판결 기사보다 ETF 대기 주문이 늦게 눕는 구간",
        "Court coverage runs ahead of actual ETF bid placement.",
        "analysis:sharp",
        ["판결", "ETF", "주문"]
      ),
    ],
    evidence: [
      evidence("reg-court-order-a", "regulation", "market", "ETF 대기 주문", "지연", "판결 기사에 비해 실제 주문은 아직 늦게 깔리는 장면이다."),
      evidence("reg-court-order-b", "regulation", "news", "법원 일정", "집중", "법원 일정은 길게 회자되지만 주문과 자금은 아직 같은 편이 아니다."),
      evidence("reg-court-order-c", "regulation", "onchain", "대기 자금 흐름", "관망", "대기 자금도 판결 기사보다 늦게 몸을 싣는 구간이다.", 0.78, 0.87, 0.7),
    ],
  },
  {
    id: "protocol-durability",
    lane: "protocol",
    mode: "philosophy-note",
    events: [
      event(
        "protocol-durability-sharp",
        "protocol",
        "업그레이드 박수보다 복구 기록이 늦게 나오는 구간",
        "Upgrade praise arrives before recovery behavior proves itself.",
        "evidence:structural-fallback",
        ["업그레이드", "복구"]
      ),
    ],
    evidence: [
      evidence("protocol-durability-a", "protocol", "onchain", "검증자 안정성", "유지", "Validator stability held during the rollout window."),
      evidence("protocol-durability-b", "protocol", "news", "복구 속도", "둔화", "Recovery speed lagged the celebratory rollout narrative."),
      evidence("protocol-durability-c", "protocol", "market", "운영 반응", "신중", "Operational response remained cautious despite headline optimism.", 0.76, 0.85, 0.7),
      evidence("protocol-durability-d", "protocol", "news", "업그레이드 배포", "지연", "Upgrade rollout slipped behind the initial operator applause.", 0.79, 0.87, 0.73),
    ],
  },
  {
    id: "protocol-durability-ops",
    lane: "protocol",
    mode: "meta-reflection",
    events: [
      event(
        "protocol-durability-ops-explicit",
        "protocol",
        "복구 속도보다 운영 로그가 늦게 붙는 구간",
        "Operational logs arrive after the recovery story is already being sold.",
        "analysis:sharp",
        ["복구", "운영", "로그"]
      ),
    ],
    evidence: [
      evidence("protocol-durability-ops-a", "protocol", "market", "운영 로그", "지연", "복구 설명보다 운영 기록이 한 박자 늦게 붙는 장면이다."),
      evidence("protocol-durability-ops-b", "protocol", "news", "복구 속도", "둔화", "장애 뒤 복구 속도는 좋아 보이지만 운영 기록은 아직 얇다."),
      evidence("protocol-durability-ops-c", "protocol", "onchain", "검증자 안정성", "유지", "검증자 수치는 버티지만 운영 태도는 아직 느리게 남는 구간이다.", 0.79, 0.87, 0.73),
    ],
  },
  {
    id: "protocol-launch",
    lane: "protocol",
    mode: "identity-journal",
    events: [
      event(
        "protocol-launch-explicit",
        "protocol",
        "메인넷 준비도는 오르는데 복귀 자금이 늦는 출시",
        "Launch confidence rises while returning capital still hesitates to follow.",
        "analysis:sharp",
        ["메인넷", "복귀", "출시"]
      ),
      event(
        "protocol-launch-sharp",
        "protocol",
        "메인넷 발표보다 늦게 붙는 건 복귀 자금이다",
        "Mainnet launch applause arrives before returning capital.",
        "evidence:structural-fallback",
        ["메인넷", "복귀"]
      ),
    ],
    evidence: [
      evidence("protocol-launch-a", "protocol", "news", "메인넷 준비도", "상승", "Mainnet readiness looked stronger across operator notes."),
      evidence("protocol-launch-b", "protocol", "onchain", "복귀 자금", "지연", "Returning capital did not re-enter at the same speed as launch headlines."),
      evidence("protocol-launch-c", "protocol", "market", "업그레이드 배포 큐", "증가", "Upgrade rollout queue activity outpaced actual capital return.", 0.78, 0.86, 0.72),
    ],
  },
  {
    id: "protocol-launch-showcase",
    lane: "protocol",
    mode: "philosophy-note",
    events: [
      event(
        "protocol-launch-showcase-explicit",
        "protocol",
        "메인넷 무대는 뜨거운데 복귀 자금은 아직 객석에 남은 장면",
        "The mainnet showcase is loud, but returning capital still stays in the audience.",
        "analysis:sharp",
        ["메인넷", "쇼케이스", "복귀"]
      ),
    ],
    evidence: [
      evidence("protocol-launch-showcase-a", "protocol", "news", "메인넷 준비도", "상승", "메인넷 준비도는 강조되지만 운영 반응은 아직 조심스럽다."),
      evidence("protocol-launch-showcase-b", "protocol", "onchain", "복귀 자금", "지연", "돌아오는 돈은 아직 발표장의 기세를 그대로 따라오지 않는다."),
      evidence("protocol-launch-showcase-c", "protocol", "market", "쇼케이스 반응", "과열", "무대 반응은 뜨겁지만 실제 복귀 자금은 객석 근처에서 머뭇거린다.", 0.77, 0.85, 0.69),
    ],
  },
  {
    id: "market-liquidity",
    lane: "market-structure",
    mode: "philosophy-note",
    events: [
      event(
        "market-liquidity-sharp",
        "market-structure",
        "호가 두께와 큰 주문 소화가 따로 놀면 과열은 구조보다 연출 쪽이다",
        "Orderbook heat outruns actual settlement.",
        "evidence:structural-fallback",
        ["호가", "체결"]
      ),
    ],
    evidence: [
      evidence("market-liquidity-a", "market-structure", "onchain", "큰 주문 소화", "둔화", "Large order absorption slowed beneath the heat on screen."),
      evidence("market-liquidity-b", "market-structure", "market", "자금 쏠림 방향", "분산", "Capital concentration stayed scattered instead of confirming the move."),
      evidence("market-liquidity-c", "market-structure", "market", "호가 두께", "약화", "Orderbook depth thinned despite louder reaction.", 0.79, 0.88, 0.72),
      evidence("market-liquidity-d", "market-structure", "market", "현물 체결", "지연", "Spot settlement stayed slow even as the screen heat expanded.", 0.8, 0.89, 0.74),
    ],
  },
  {
    id: "market-settlement-depth",
    lane: "market-structure",
    mode: "identity-journal",
    events: [
      event(
        "market-settlement-depth-explicit",
        "market-structure",
        "거래량 숫자는 사는데 호가 두께가 같이 안 눕는 구간",
        "Printed size runs ahead of actual book depth.",
        "analysis:sharp",
        ["거래량", "호가", "깊이"]
      ),
    ],
    evidence: [
      evidence("market-settlement-depth-a", "market-structure", "market", "거래량 반응", "확대", "숫자는 살아도 깊이는 아직 같은 편으로 안 눕는 장면이다."),
      evidence("market-settlement-depth-b", "market-structure", "market", "호가 두께", "약화", "호가 두께가 비면서 실제 깊이가 숫자를 못 받치는 구간이다."),
      evidence("market-settlement-depth-c", "market-structure", "market", "현물 체결", "지연", "체결은 늦게 붙고 화면 열기만 먼저 커지는 장면이다.", 0.8, 0.88, 0.74),
      evidence("market-settlement-depth-d", "market-structure", "onchain", "큰 주문 소화", "둔화", "큰 주문 소화가 늦게 붙으면서 화면 숫자만 먼저 살아난 구간이다.", 0.79, 0.87, 0.72),
    ],
  },
];

function parseVariantCount(argv: string[]): number {
  const raw = argv.find((arg) => arg.startsWith("--variants="))?.split("=")[1];
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 6;
  return Math.max(1, Math.min(16, Math.trunc(parsed)));
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function countTop(items: string[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const item of items.filter(Boolean)) {
    counts.set(item, (counts.get(item) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function resolveLengthProfile(variant: number): LengthProfile {
  return LENGTH_PROFILES[variant % LENGTH_PROFILES.length];
}

function generateSamples(variantCount: number): PlannerSample[] {
  const samples: PlannerSample[] = [];

  for (const item of cases) {
    const structuralEvents = buildStructuralFallbackEventsFromEvidence(item.evidence, createdAt, 3).filter(
      (candidate) => candidate.lane === item.lane
    );
    const syntheticThreads: PlannerThread[] = [...(item.recentNarrativeThreads || [])];
    const syntheticRecentPosts: RecentPostRecord[] = [...(item.recentPosts || [])];

    for (let variant = 0; variant < variantCount; variant += 1) {
      const profile = resolveLengthProfile(variant);
      const rotatedStructuralEvents = structuralEvents.length
        ? structuralEvents.slice(variant % structuralEvents.length).concat(structuralEvents.slice(0, variant % structuralEvents.length))
        : [];
      const rotatedEvents = item.events.length
        ? item.events.slice(variant % item.events.length).concat(item.events.slice(0, variant % item.events.length))
        : [];
        const plan = planEventEvidenceAct({
          events: [...rotatedStructuralEvents, ...rotatedEvents],
          evidence: item.evidence,
          recentPosts: syntheticRecentPosts.slice(-8),
          recentNarrativeThreads: syntheticThreads.slice(-8),
          identityPressure: identityPressureForLane(item.lane),
        });

      if (!plan) {
        throw new Error(`planner returned null for case ${item.id} variant ${variant}`);
      }

      const text = buildEventEvidenceFallbackPost(plan, "ko", profile.maxChars, item.mode, variant);
      const sentences = splitSentences(text);
      samples.push({
        caseId: item.id,
        lane: item.lane,
        mode: item.mode,
        variant,
        lengthProfile: profile.label,
        maxChars: profile.maxChars,
        charCount: text.length,
        eventSource: plan.event.source,
        focus: plan.focus,
        sceneFamily: plan.sceneFamily || "",
        plannerScore: plan.plannerScore,
        plannerWarnings: plan.plannerWarnings,
        text,
        firstSentence: sentences[0] || "",
        secondSentence: sentences[1] || "",
      });
      syntheticThreads.push({
        lane: plan.lane,
        focus: plan.focus,
        sceneFamily: plan.sceneFamily || "",
        headline: plan.event.headline,
      });
      syntheticRecentPosts.push({
        content: text,
        timestamp: createdAt,
      });
    }
  }

  return samples;
}

function buildMarkdown(samples: PlannerSample[]): string {
  const lines: string[] = ["# Pixymon Planner-Aware Samples", ""];
  for (const sample of samples) {
    lines.push(
      `## ${sample.caseId} / ${sample.lane} / ${sample.mode} / ${sample.focus} / ${sample.sceneFamily || "none"} / ${sample.lengthProfile}(${sample.charCount}/${sample.maxChars}) / v${sample.variant}`
    );
    lines.push("");
    lines.push(`- plannerScore: ${sample.plannerScore}`);
    lines.push(`- plannerWarnings: ${sample.plannerWarnings.join(",") || "none"}`);
    lines.push("");
    lines.push(sample.text);
    lines.push("");
  }
  return `${lines.join("\n").trim()}\n`;
}

function main() {
  const variantCount = parseVariantCount(process.argv.slice(2));
  const samples = generateSamples(variantCount);
  const firstSentenceTop = countTop(samples.map((sample) => sample.firstSentence)).slice(0, 10);
  const secondSentenceTop = countTop(samples.map((sample) => sample.secondSentence)).slice(0, 10);
  const lengthProfileTop = countTop(samples.map((sample) => sample.lengthProfile)).slice(0, 10);
  const focusTop = countTop(samples.map((sample) => sample.focus)).slice(0, 10);
  const eventSourceTop = countTop(samples.map((sample) => sample.eventSource)).slice(0, 10);
  const sceneFamilyTop = countTop(samples.map((sample) => sample.sceneFamily)).slice(0, 10);
  const sceneFamilyBaseTop = countTop(samples.map((sample) => sceneFamilyBase(sample.sceneFamily))).slice(0, 10);
  const sceneFamilyTiltTop = countTop(samples.map((sample) => sceneFamilyTilt(sample.sceneFamily))).slice(0, 10);
  const warningTop = countTop(samples.flatMap((sample) => sample.plannerWarnings)).slice(0, 10);
  const lengthSummary = Object.fromEntries(
    LENGTH_PROFILES.map((profile) => {
      const bucket = samples.filter((sample) => sample.lengthProfile === profile.label);
      const avgChars =
        bucket.length > 0
          ? Math.round(bucket.reduce((sum, sample) => sum + sample.charCount, 0) / bucket.length)
          : 0;
      return [profile.label, { maxChars: profile.maxChars, avgChars, count: bucket.length }];
    })
  );

  const outDir = path.resolve(".test-data");
  fs.mkdirSync(outDir, { recursive: true });

  const markdownPath = path.join(outDir, "planner-samples.latest.md");
  const summaryPath = path.join(outDir, "planner-samples.summary.json");

  fs.writeFileSync(markdownPath, buildMarkdown(samples), "utf8");
  fs.writeFileSync(
    summaryPath,
    JSON.stringify(
      {
        sampleCount: samples.length,
        variantCount,
        topFirstSentences: firstSentenceTop,
        topSecondSentences: secondSentenceTop,
        topLengthProfiles: lengthProfileTop,
        lengthSummary,
        topFocuses: focusTop,
        topEventSources: eventSourceTop,
        topSceneFamilies: sceneFamilyTop,
        topSceneFamilyBases: sceneFamilyBaseTop,
        topSceneFamilyTilts: sceneFamilyTiltTop,
        topPlannerWarnings: warningTop,
      },
      null,
      2
    ),
    "utf8"
  );

  console.log(`wrote ${samples.length} planner-aware samples -> ${path.relative(process.cwd(), markdownPath)}`);
  console.log(`wrote summary -> ${path.relative(process.cwd(), summaryPath)}`);
  console.log("");
  console.log("length profiles:");
  for (const [text, count] of lengthProfileTop.slice(0, 5)) {
    console.log(`- ${count}x ${text}`);
  }
  console.log("");
  console.log("top first sentences:");
  for (const [text, count] of firstSentenceTop.slice(0, 5)) {
    console.log(`- ${count}x ${text}`);
  }
  console.log("");
  console.log("top second sentences:");
  for (const [text, count] of secondSentenceTop.slice(0, 5)) {
    console.log(`- ${count}x ${text}`);
  }
}

main();
