import fs from "node:fs";
import path from "node:path";
import { buildKoIdentityWriterCandidate } from "../src/services/engagement/identity-writer.ts";
import type { TrendLane } from "../src/types/agent.ts";

type SampleCase = {
  id: string;
  lane: TrendLane;
  mode: string;
  headline: string;
  primaryAnchor: string;
  secondaryAnchor: string;
  worldviewHint: string;
  signatureBelief: string;
  recentReflection: string;
};

const cases: SampleCase[] = [
  {
    id: "eco-retention",
    lane: "ecosystem",
    mode: "identity-journal",
    headline: "사람들이 실제로 머무는 체인과 밖에서 도는 서사가 맞물리는지 살핀다",
    primaryAnchor: "체인 안쪽 사용",
    secondaryAnchor: "재방문 흐름",
    worldviewHint: "사람이 남지 않으면 큰 서사도 금방 광고가 된다",
    signatureBelief: "재방문이 없는 열기는 오래 믿지 않는다",
    recentReflection: "좋은 해설보다 오래 남는 흔적 하나가 훨씬 정확하다",
  },
  {
    id: "eco-hype",
    lane: "ecosystem",
    mode: "identity-journal",
    headline: "서사만 커지고 실제 사용은 비는 날이 아닌지 살핀다",
    primaryAnchor: "커뮤니티 열기",
    secondaryAnchor: "체인 안쪽 사용",
    worldviewHint: "사람이 남지 않으면 큰 서사도 금방 광고가 된다",
    signatureBelief: "광고가 사람보다 먼저 커지는 장면은 오래 믿지 않는다",
    recentReflection: "서사만 부풀수록 실제 사용 흔적은 더 차갑게 봐야 한다",
  },
  {
    id: "reg-execution",
    lane: "regulation",
    mode: "meta-reflection",
    headline: "정책 문장보다 실제 반응이 어디서 갈라지는지 먼저 본다",
    primaryAnchor: "규제 반응",
    secondaryAnchor: "대기 자금 흐름",
    worldviewHint: "정책 문장보다 집행 흔적이 더 늦고 정확하다",
    signatureBelief: "기사보다 행동 편에 더 오래 남는다",
    recentReflection: "행동이 따라오지 않는 순간 해설은 금방 얇아진다",
  },
  {
    id: "mkt-liquidity",
    lane: "market-structure",
    mode: "philosophy-note",
    headline: "호가보다 체결이 늦게 진실을 말하는 날인지 본다",
    primaryAnchor: "큰 주문 소화",
    secondaryAnchor: "자금 쏠림 방향",
    worldviewHint: "화면 열기보다 실제 체결이 더 늦고 정확하다",
    signatureBelief: "돈이 안 붙은 자신감은 제일 먼저 버린다",
    recentReflection: "좋은 해설보다 오래 남는 흔적 하나가 훨씬 정확하다",
  },
  {
    id: "protocol-ops",
    lane: "protocol",
    mode: "philosophy-note",
    headline: "업그레이드 발표가 운영 흔적으로 이어지는지 본다",
    primaryAnchor: "검증자 안정성",
    secondaryAnchor: "복구 속도",
    worldviewHint: "신뢰는 선언보다 반복 가능한 복구에서 쌓인다",
    signatureBelief: "로그보다 박수가 먼저 나오는 업그레이드는 늘 경계한다",
    recentReflection: "복구 기록은 늘 약속보다 늦게 나오지만 훨씬 오래 남는다",
  },
  {
    id: "onchain-durability",
    lane: "onchain",
    mode: "meta-reflection",
    headline: "튀는 숫자와 오래 버티는 흔적이 같은 편인지 본다",
    primaryAnchor: "주소 이동",
    secondaryAnchor: "대기 자금 흐름",
    worldviewHint: "온체인 숫자는 오래 남을 때만 단서가 된다",
    signatureBelief: "하루도 못 버틴 온체인 숫자는 장식에 가깝다",
    recentReflection: "한입에 설명되는 장면일수록 한 번 더 의심한다",
  },
];

type Sample = {
  caseId: string;
  lane: TrendLane;
  mode: string;
  variant: number;
  text: string;
  firstSentence: string;
  secondSentence: string;
};

function parseVariantCount(argv: string[]): number {
  const raw = argv.find((arg) => arg.startsWith("--variants="))?.split("=")[1];
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 4;
  return Math.max(1, Math.min(16, Math.trunc(parsed)));
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function generateSamples(variantCount: number): Sample[] {
  const samples: Sample[] = [];
  for (const item of cases) {
    for (let variant = 0; variant < variantCount; variant += 1) {
      const text = buildKoIdentityWriterCandidate(
        {
          ...item,
          maxChars: 260,
          seedHint: `identity-sample:${item.id}:${variant}`,
        },
        variant
      );
      const sentences = splitSentences(text);
      samples.push({
        caseId: item.id,
        lane: item.lane,
        mode: item.mode,
        variant,
        text,
        firstSentence: sentences[0] || "",
        secondSentence: sentences[1] || "",
      });
    }
  }
  return samples;
}

function countTop(items: string[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const item of items.filter(Boolean)) {
    counts.set(item, (counts.get(item) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function buildMarkdown(samples: Sample[]): string {
  const lines: string[] = ["# Pixymon Identity Writer Samples", ""];
  for (const sample of samples) {
    lines.push(`## ${sample.caseId} / ${sample.lane} / ${sample.mode} / v${sample.variant}`);
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

  const outDir = path.resolve(".test-data");
  fs.mkdirSync(outDir, { recursive: true });

  const markdownPath = path.join(outDir, "identity-samples.latest.md");
  const summaryPath = path.join(outDir, "identity-samples.summary.json");

  fs.writeFileSync(markdownPath, buildMarkdown(samples), "utf8");
  fs.writeFileSync(
    summaryPath,
    JSON.stringify(
      {
        sampleCount: samples.length,
        variantCount,
        topFirstSentences: firstSentenceTop,
        topSecondSentences: secondSentenceTop,
      },
      null,
      2
    ),
    "utf8"
  );

  console.log(`wrote ${samples.length} samples -> ${path.relative(process.cwd(), markdownPath)}`);
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
