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
  focus: string;
  sceneFamily: string;
  plannerScore: number;
  plannerWarnings: string[];
  text: string;
  firstSentence: string;
  secondSentence: string;
};

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
      evidence("reg-court-b", "regulation", "onchain", "대기 자금 흐름", "관망", "Waiting capital stayed cautious despite the legal excitement."),
      evidence("reg-court-c", "regulation", "market", "ETF 대기 주문", "정체", "ETF-related waiting orders did not expand with the court headline.", 0.77, 0.86, 0.69),
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
    ],
  },
  {
    id: "protocol-launch",
    lane: "protocol",
    mode: "identity-journal",
    events: [
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
      evidence("protocol-launch-c", "protocol", "market", "배포 큐", "증가", "Release queue activity outpaced actual capital return.", 0.75, 0.84, 0.68),
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

function generateSamples(variantCount: number): PlannerSample[] {
  const samples: PlannerSample[] = [];

  for (const item of cases) {
    const structuralEvents = buildStructuralFallbackEventsFromEvidence(item.evidence, createdAt, 3).filter(
      (candidate) => candidate.lane === item.lane
    );
    const plan = planEventEvidenceAct({
      events: [...structuralEvents, ...item.events],
      evidence: item.evidence,
      recentPosts: item.recentPosts || [],
      recentNarrativeThreads: item.recentNarrativeThreads || [],
    });

    if (!plan) {
      throw new Error(`planner returned null for case ${item.id}`);
    }

    for (let variant = 0; variant < variantCount; variant += 1) {
      const text = buildEventEvidenceFallbackPost(plan, "ko", 260, item.mode, variant);
      const sentences = splitSentences(text);
      samples.push({
        caseId: item.id,
        lane: item.lane,
        mode: item.mode,
        variant,
        focus: plan.focus,
        sceneFamily: plan.sceneFamily || "",
        plannerScore: plan.plannerScore,
        plannerWarnings: plan.plannerWarnings,
        text,
        firstSentence: sentences[0] || "",
        secondSentence: sentences[1] || "",
      });
    }
  }

  return samples;
}

function buildMarkdown(samples: PlannerSample[]): string {
  const lines: string[] = ["# Pixymon Planner-Aware Samples", ""];
  for (const sample of samples) {
    lines.push(
      `## ${sample.caseId} / ${sample.lane} / ${sample.mode} / ${sample.focus} / ${sample.sceneFamily || "none"} / v${sample.variant}`
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
  const focusTop = countTop(samples.map((sample) => sample.focus)).slice(0, 10);
  const sceneFamilyTop = countTop(samples.map((sample) => sample.sceneFamily)).slice(0, 10);
  const warningTop = countTop(samples.flatMap((sample) => sample.plannerWarnings)).slice(0, 10);

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
        topFocuses: focusTop,
        topSceneFamilies: sceneFamilyTop,
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
