import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  evaluateRealReplayCorpusV2,
  generateSyntheticCorpusV2,
} from "../eval/editorial-v2-corpus.ts";

const NOW = "2026-08-28T10:00:00.000Z";

async function realReplayRows() {
  const candidates = await generateSyntheticCorpusV2("real-replay-fixture");
  const rows = candidates.map((candidate) => ({
    id: candidate.id,
    format: candidate.format,
    subject: candidate.subject,
    factIds: [...candidate.factIds],
    usedFactIds: [...candidate.usedFactIds],
    facts: [{
      factId: candidate.factIds[0],
      subject: candidate.subject,
      metric: {
        name: candidate.metricName,
        value: candidate.metricValue,
        raw: candidate.displayValue,
        unit: candidate.metricUnit,
        period: candidate.metricPeriod,
      },
      source: {
        provider: "defillama",
        url: "https://api.llama.fi/protocols",
        publishedAt: null,
        observedAt: NOW,
      },
    }],
    falsifier: {
      metric: candidate.metricName,
      comparator: candidate.falsifierComparator,
      threshold: candidate.metricValue,
      deadline: "2026-08-31T10:00:00.000Z",
      unit: candidate.metricUnit,
    },
    draft: candidate.text,
  }));

  const tvl = rows[0];
  tvl.facts[0].metric.name = "tvl-change-24h";
  tvl.facts[0].metric.unit = "%";
  tvl.falsifier.metric = "tvl-change-24h";
  tvl.draft = [
    `${tvl.subject}의 TVL은 8월 28일 10:00 UTC 기준 ${tvl.facts[0].metric.raw}다; 원시 수치와 측정 구간만 고정했다.`,
    `${tvl.subject}에 대한 원인과 지속성의 큰 결론은 아직 보류한다.`,
  ].join(" ");
  return rows;
}

function withReplayFile<T>(rows: unknown[], run: (inputPath: string) => T): T {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pixymon-v2-real-replay-"));
  const inputPath = path.join(directory, "corpus.json");
  try {
    fs.writeFileSync(inputPath, JSON.stringify(rows));
    return run(inputPath);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("real replay accepts a deterministic 100-row corpus and allows grounded TVL names", async () => {
  const report = withReplayFile(await realReplayRows(), evaluateRealReplayCorpusV2);

  assert.equal(report.corpusKind, "real-replay");
  assert.equal(report.candidateCount, 100);
  assert.deepEqual(report.determinism, { runs: 100, passed: true });
  assert.equal(report.contractFailureCount, 0);
  assert.equal(report.passed, true, report.failures.join(","));
});

test("real replay keeps the machine falsifier metadata but rejects public follow-up copy", async () => {
  const rows = await realReplayRows();
  const first = rows[0];
  assert.ok(["gt", "gte", "lt", "lte", "eq"].includes(first.falsifier.comparator));
  first.draft = `${first.draft} 72시간 뒤 같은 지표가 기준 미만이면 이 판정을 철회한다.`;

  const report = withReplayFile(rows, evaluateRealReplayCorpusV2);
  assert.equal(report.determinism.passed, true);
  assert.equal(report.contractFailureCount, 1);
  assert.ok(report.failures.includes("contract-failures:1"));
  assert.equal(report.passed, false);
});
