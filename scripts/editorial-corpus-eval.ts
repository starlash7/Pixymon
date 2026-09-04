import os from "node:os";
import path from "node:path";

process.env.TEST_MODE = "true";
process.env.TEST_NO_EXTERNAL_CALLS = "true";
process.env.ACTION_MODE = "observe";
process.env.PIXYMON_DATA_DIR ||= path.join(os.tmpdir(), `pixymon-v2-corpus-eval-${process.pid}`);
process.env.MEMORY_DATA_PATH ||= path.join(process.env.PIXYMON_DATA_DIR, "memory.json");

function option(name: string): string | undefined {
  const direct = process.argv.find((argument) => argument.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const inputPath = option("--input");
const seed = option("--seed") || "pixymon-v2-r0";
const originalFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  throw new Error("corpus evaluation blocked an unexpected network call");
}) as typeof fetch;

try {
  const {
    assertEditorialCorpusGatesV2,
    evaluateRealReplayCorpusV2,
    evaluateSyntheticCorpusV2,
  } = await import("../eval/editorial-v2-corpus.js");
  const report = inputPath
    ? evaluateRealReplayCorpusV2(inputPath)
    : await evaluateSyntheticCorpusV2(seed);

  console.log(`Pixymon V2 corpus — ${report.corpusKind}`);
  console.log(`source: ${report.sourceLabel}`);
  console.log(`candidates: ${report.candidateCount}`);
  console.log(`named subject coverage: ${(report.namedSubjectCoverage * 100).toFixed(1)}%`);
  console.log(`numeric coverage: ${(report.numericCoverage * 100).toFixed(1)}%`);
  console.log(`source time coverage: ${(report.sourceTimeCoverage * 100).toFixed(1)}%`);
  console.log(
    `exact sentence duplicates: first=${report.exactFirstSentenceDuplicates}, second=${report.exactSecondSentenceDuplicates}`
  );
  console.log(
    `semantic near-duplicates: ${report.semanticNearDuplicates}/${report.candidateCount} (${(
      report.semanticNearDuplicateRate * 100
    ).toFixed(1)}%, threshold=${report.nearDuplicateThreshold})`
  );
  console.log(
    `malformed=${report.malformedCount}, contract failures=${report.contractFailureCount}`
  );
  console.log(
    `phrase rates: 결국=${(report.phraseRates.eventually * 100).toFixed(1)}%, 장면=${(
      report.phraseRates.scene * 100
    ).toFixed(1)}%, 눕=${(report.phraseRates.lyingMetaphor * 100).toFixed(1)}%`
  );
  console.log(
    `determinism: ${report.determinism.passed ? "PASS" : "FAIL"} (${report.determinism.runs} runs)`
  );
  assertEditorialCorpusGatesV2(report);
  console.log("corpus gates: PASS (network/X/LLM disabled)");
} finally {
  globalThis.fetch = originalFetch;
}
