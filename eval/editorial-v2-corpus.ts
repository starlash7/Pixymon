import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type {
  EditorialFormatV2,
  MachineComparatorV2,
} from "../src/services/editorial-v2/contracts.js";
import type { EvidenceCardV2 } from "../src/services/editorial-v2/evidence.js";
import { assessTierAEligibilityV2 } from "../src/services/editorial-v2/evidence.js";
import { planEditorialV2 } from "../src/services/editorial-v2/planner.js";
import {
  formatEvidenceSourceTimeV2,
  inferMetricDirectionV2,
  splitEditorialSentencesV2,
  validateEditorialDraftV2,
} from "../src/services/editorial-v2/validator.js";
import { writeEditorialDraftV2 } from "../src/services/editorial-v2/writer.js";
import type { EditorialClaimKindV2 } from "../src/services/editorial-v2/writer.js";

const NOW = "2026-08-28T10:00:00.000Z";
const SYNTHETIC_COUNT = 100;
const DETERMINISM_RUNS = 100;
const NEAR_DUPLICATE_THRESHOLD = 0.78;

export type CorpusKindV2 = "synthetic" | "real-replay";

export interface EditorialCorpusCandidateV2 {
  corpusKind: CorpusKindV2;
  id: string;
  subject: string;
  displayValue: string;
  factIds: readonly string[];
  usedFactIds: readonly string[];
  sourceTimeToken: string;
  format: EditorialFormatV2;
  falsifierComparator: MachineComparatorV2;
  metricName: string;
  metricValue: number;
  metricUnit: string;
  metricPeriod: string;
  text: string;
}

export interface EditorialCorpusReportV2 {
  corpusKind: CorpusKindV2;
  sourceLabel: string;
  candidateCount: number;
  namedSubjectCoverage: number;
  numericCoverage: number;
  sourceTimeCoverage: number;
  exactFirstSentenceDuplicates: number;
  exactSecondSentenceDuplicates: number;
  semanticNearDuplicates: number;
  semanticNearDuplicateRate: number;
  nearDuplicateThreshold: number;
  malformedCount: number;
  contractFailureCount: number;
  phraseRates: {
    eventually: number;
    scene: number;
    lyingMetaphor: number;
  };
  determinism: {
    runs: number;
    passed: boolean;
  };
  passed: boolean;
  failures: string[];
}

const SUBJECT_PREFIXES = [
  "가온",
  "나래",
  "다온",
  "라온",
  "마루",
  "바다",
  "새봄",
  "아라",
  "여울",
  "이든",
] as const;

const SUBJECT_SUFFIXES = [
  "유동성",
  "결제망",
  "스테이킹",
  "롤업",
  "브리지",
  "대출",
  "거래소",
  "금고",
  "오라클",
  "체인",
] as const;

const METRICS = [
  "총예치 변화",
  "활성 주소 변화",
  "순유입 변화",
  "거래량 변화",
  "예치자 변화",
  "수수료 변화",
  "검증자 변화",
  "브리지 잔고 변화",
  "대출 잔액 변화",
  "스테이킹 잔고 변화",
] as const;

type SentenceTemplate = (input: {
  subject: string;
  metric: string;
  displayValue: string;
  sourceTime: string;
}) => string;

const FIRST_SENTENCES: readonly SentenceTemplate[] = [
  ({ subject, metric, displayValue, sourceTime }) =>
    `${subject}의 ${metric}는 ${sourceTime} 기준 ${displayValue}다; 원시 수치를 고정했다.`,
  ({ subject, metric, displayValue, sourceTime }) =>
    `${sourceTime}에 본 ${subject}의 ${metric}는 ${displayValue}였다; 제목보다 변화폭을 읽었다.`,
  ({ subject, metric, displayValue, sourceTime }) =>
    `${subject}에서 확인한 ${metric}는 ${sourceTime} 기준 ${displayValue}다; 측정 구간을 분리했다.`,
  ({ subject, metric, displayValue, sourceTime }) =>
    `${subject}의 ${metric}를 ${sourceTime}에 고정한 값은 ${displayValue}다; 서사는 덜어냈다.`,
  ({ subject, metric, displayValue, sourceTime }) =>
    `${subject}의 ${metric}가 ${sourceTime} 기준 ${displayValue}를 가리킨다; 변화폭부터 적었다.`,
  ({ subject, metric, displayValue, sourceTime }) =>
    `${subject}의 공급자 원값은 ${sourceTime} 기준 ${metric} ${displayValue}다; 추측은 섞지 않았다.`,
  ({ subject, metric, displayValue, sourceTime }) =>
    `${subject}의 ${metric}는 ${sourceTime}에 ${displayValue}였다; 비교의 출발값으로 남겼다.`,
  ({ subject, metric, displayValue, sourceTime }) =>
    `${subject}의 숫자에서 ${sourceTime} 기준 ${metric}는 ${displayValue}다; 변화 하나만 우선했다.`,
  ({ subject, metric, displayValue, sourceTime }) =>
    `${subject}을 특정한 ${metric}는 ${sourceTime} 기준 ${displayValue}다; 시장 요약과 분리했다.`,
  ({ subject, metric, displayValue, sourceTime }) =>
    `${subject}의 ${metric}는 ${sourceTime} 기준 ${displayValue}다; 출발값으로 저장했다.`,
] as const;

const SECOND_SENTENCES: readonly SentenceTemplate[] = [
  ({ subject }) => `${subject}의 변화 가능성만 열어 두고, 원인과 지속성에 대한 결론은 아직 보류한다.`,
  ({ subject }) => `${subject}에 대한 큰 결론은 아직 보류하며, 지금은 확인된 변화폭만 판단에 남긴다.`,
  ({ subject }) => `${subject}의 한 번의 움직임을 추세로 승인하진 않고, 관측 범위 안의 판단만 남긴다.`,
  ({ subject }) => `${subject}의 변화폭은 인정하되 원인까지 확인된 확정 신호로 해석하지 않는다.`,
  ({ subject }) => `${subject}의 방향성에는 잠정 판정만 남기고, 더 넓은 서사는 아직 승인하지 않는다.`,
  ({ subject }) => `${subject}의 수치는 받아들이되 원인과 지속성에 대한 더 넓은 서사는 유예한다.`,
  ({ subject }) => `${subject}의 측정값만 판단에 반영하고, 관측되지 않은 원인에 대한 결론은 보류한다.`,
  ({ subject }) => `${subject}의 한 번의 관측을 확대 해석하지 않고, 확인된 변화의 범위만 승인한다.`,
  ({ subject }) => `나는 ${subject}의 숫자를 기억하되, 아직 확인되지 않은 원인에 대한 확신은 유예한다.`,
  ({ subject }) => `${subject}의 판정은 숫자가 보여 준 범위까지만 유효하고, 그 밖의 서사는 보류한다.`,
] as const;

function stableHash(value: string): number {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function syntheticEvidence(index: number, seed: string): EvidenceCardV2 {
  const row = Math.floor(index / 10);
  const column = index % 10;
  const subject = `${SUBJECT_PREFIXES[row]}${SUBJECT_SUFFIXES[column]}`;
  const metric = METRICS[(row + column) % METRICS.length];
  const hashed = stableHash(`${seed}:${index}`);
  const magnitude = ((hashed % 180) + 10) / 10;
  const value = index % 4 === 0 ? -magnitude : magnitude;
  const displayValue = `${value >= 0 ? "+" : "-"}${Math.abs(value).toFixed(1)}%`;
  const id = `synthetic:${seed}:${index}`;
  return {
    schemaVersion: 2,
    id,
    lane: ["onchain", "protocol", "ecosystem"][index % 3] as EvidenceCardV2["lane"],
    kind: "signal",
    subject,
    metric: {
      name: metric,
      value,
      raw: displayValue,
      unit: "%",
      period: "24h",
    },
    source: {
      provider: "defillama",
      url: `https://fixtures.invalid/pixymon-v2/${encodeURIComponent(id)}`,
      publishedAt: null,
      observedAt: NOW,
      origin: "direct",
      role: "primary",
    },
    freshness: {
      kind: "signal",
      measuredAt: NOW,
      maxAgeMs: 2 * 60 * 60 * 1000,
      ageMs: 0,
      state: "fresh",
    },
    providerHealth: {
      provider: "defillama",
      state: "green",
      reason: "ok",
      checkedAt: NOW,
      latencyMs: 1,
      itemCount: 1,
    },
    provenance: { kind: "onchain-nutrient", sourceId: id },
  };
}

function renderSyntheticText(
  index: number,
  seed: string,
  evidence: EvidenceCardV2
): string {
  const offsetA = stableHash(`${seed}:first`) % FIRST_SENTENCES.length;
  const offsetB = stableHash(`${seed}:second`) % SECOND_SENTENCES.length;
  const firstIndex = (index + offsetA) % FIRST_SENTENCES.length;
  const secondIndex = (Math.floor(index / 10) + offsetB) % SECOND_SENTENCES.length;
  const input = {
    subject: evidence.subject,
    metric: evidence.metric.name,
    displayValue: evidence.metric.raw,
    sourceTime: formatEvidenceSourceTimeV2(evidence.source.observedAt),
  };
  return `${FIRST_SENTENCES[firstIndex](input)} ${SECOND_SENTENCES[secondIndex](input)}`;
}

function claimsForSyntheticText(text: string, factId: string) {
  return splitEditorialSentencesV2(text).map((sentence, index) => ({
    kind: (index === 0 ? "observation" : "judgment") as EditorialClaimKindV2,
    text: sentence,
    factIds: [factId],
  }));
}

export async function generateSyntheticCorpusV2(
  seed = "pixymon-v2-r0"
): Promise<EditorialCorpusCandidateV2[]> {
  const candidates: EditorialCorpusCandidateV2[] = [];
  for (let index = 0; index < SYNTHETIC_COUNT; index += 1) {
    const evidence = syntheticEvidence(index, seed);
    const eligibility = assessTierAEligibilityV2(evidence, NOW);
    if (!eligibility.eligible) {
      throw new Error(`synthetic evidence ${evidence.id} is not Tier A: ${eligibility.reasons.join(",")}`);
    }
    const planning = planEditorialV2({
      evidence: [evidence],
      now: NOW,
      selectionSeed: `${seed}:${index}`,
    });
    if (planning.status !== "planned") {
      throw new Error(`synthetic plan ${evidence.id} blocked at ${planning.stage}:${planning.reason}`);
    }
    const text = renderSyntheticText(index, seed, evidence);
    const writing = await writeEditorialDraftV2({
      plan: planning.plan,
      evidence,
      model: {
        async generate() {
          return JSON.stringify({
            draft: text,
            usedFactIds: [evidence.id],
            claims: claimsForSyntheticText(text, evidence.id),
          });
        },
      },
    });
    if (writing.status !== "generated") {
      throw new Error(
        `synthetic writer ${evidence.id} blocked: ${writing.validationReasons.join(",")}`
      );
    }
    candidates.push({
      corpusKind: "synthetic",
      id: `synthetic-candidate-${index + 1}`,
      subject: evidence.subject,
      displayValue: evidence.metric.raw,
      factIds: planning.plan.factIds,
      usedFactIds: writing.payload.usedFactIds,
      sourceTimeToken: formatEvidenceSourceTimeV2(evidence.source.observedAt),
      format: planning.plan.format,
      falsifierComparator: planning.plan.falsifier.comparator,
      metricName: evidence.metric.name,
      metricValue: evidence.metric.value,
      metricUnit: evidence.metric.unit,
      metricPeriod: evidence.metric.period,
      text: writing.payload.draft,
    });
  }
  return candidates;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEditorialFormat(value: unknown): value is EditorialFormatV2 {
  return ["bite", "withhold", "revisit", "evolution"].includes(String(value));
}

function isMachineComparator(value: unknown): value is MachineComparatorV2 {
  return ["gt", "gte", "lt", "lte", "eq"].includes(String(value));
}

function normalizeRealReplayRow(value: unknown, index: number): EditorialCorpusCandidateV2 {
  if (!isRecord(value)) {
    throw new Error(`real replay row ${index + 1} must be an object`);
  }
  const row = value;
  const facts = Array.isArray(row.facts) ? row.facts : [];
  const firstFact = isRecord(facts[0]) ? facts[0] : undefined;
  const metric = isRecord(firstFact?.metric) ? firstFact.metric : undefined;
  const source = isRecord(firstFact?.source) ? firstFact.source : undefined;
  const falsifier = isRecord(row.falsifier) ? row.falsifier : undefined;
  const factIds = stringArray(row.factIds).length > 0
    ? stringArray(row.factIds)
    : facts.flatMap((fact) => isRecord(fact) && fact.factId ? [String(fact.factId)] : []);
  const usedFactIds = stringArray(row.usedFactIds).length > 0
    ? stringArray(row.usedFactIds)
    : factIds;
  const format = row.format;
  const falsifierComparator = row.falsifierComparator ?? row.comparator ?? falsifier?.comparator;
  const metricName = String(row.metricName ?? metric?.name ?? "").trim();
  const metricValue = row.metricValue ?? metric?.value;
  const metricUnit = String(row.metricUnit ?? metric?.unit ?? "").trim();
  const metricPeriod = String(row.metricPeriod ?? metric?.period ?? "").trim();
  const observedAt = typeof source?.observedAt === "string" ? source.observedAt : undefined;
  const candidate: EditorialCorpusCandidateV2 = {
    corpusKind: "real-replay",
    id: String(row.id || `real-replay-${index + 1}`),
    subject: String(row.subject || firstFact?.subject || "").trim(),
    displayValue: String(row.displayValue || metric?.raw || "").trim(),
    factIds,
    usedFactIds,
    sourceTimeToken: observedAt
      ? formatEvidenceSourceTimeV2(observedAt)
      : String(row.sourceTimeToken || "").trim(),
    format: format as EditorialFormatV2,
    falsifierComparator: falsifierComparator as MachineComparatorV2,
    metricName,
    metricValue: metricValue as number,
    metricUnit,
    metricPeriod,
    text: String(row.text || row.draft || "").replace(/\s+/g, " ").trim(),
  };
  if (
    !candidate.subject ||
    !candidate.displayValue ||
    !candidate.sourceTimeToken ||
    !candidate.text ||
    candidate.factIds.length === 0 ||
    !isEditorialFormat(format) ||
    !isMachineComparator(falsifierComparator) ||
    !candidate.metricName ||
    !Number.isFinite(metricValue) ||
    !candidate.metricUnit ||
    !candidate.metricPeriod
  ) {
    throw new Error(
      `real replay row ${index + 1} needs subject, numeric fact metadata, source time, factIds, format, falsifier comparator, and text/draft`
    );
  }
  return candidate;
}

export function loadRealReplayCorpusV2(inputPath: string): EditorialCorpusCandidateV2[] {
  const resolved = path.resolve(inputPath);
  const raw = JSON.parse(fs.readFileSync(resolved, "utf8")) as unknown;
  if (!Array.isArray(raw)) throw new Error("real replay corpus must be a JSON array");
  return raw.map(normalizeRealReplayRow);
}

function normalizedSentence(sentence: string): string {
  return sentence.toLowerCase().replace(/\s+/g, " ").trim();
}

function duplicateExtras(values: readonly string[]): number {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
}

function semanticTokens(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[-+]?\d+(?:[,.]\d+)*(?:%|시간)?/gu, " <number> ")
    .replace(/[^a-z가-힣<>\s]/gu, " ")
    .split(/\s+/u)
    .map((word) => word.trim())
    .filter(Boolean);
  const tokens = new Set(words);
  for (let index = 0; index + 1 < words.length; index += 1) {
    tokens.add(`${words[index]}::${words[index + 1]}`);
  }
  return tokens;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap += 1;
  return overlap / (left.size + right.size - overlap);
}

function semanticNearDuplicateCount(candidates: readonly EditorialCorpusCandidateV2[]): number {
  const tokenSets = candidates.map((candidate) => semanticTokens(candidate.text));
  let count = 0;
  for (let right = 1; right < tokenSets.length; right += 1) {
    let duplicate = false;
    for (let left = 0; left < right && !duplicate; left += 1) {
      duplicate = jaccard(tokenSets[left], tokenSets[right]) >= NEAR_DUPLICATE_THRESHOLD;
    }
    if (duplicate) count += 1;
  }
  return count;
}

function phraseRate(
  candidates: readonly EditorialCorpusCandidateV2[],
  pattern: RegExp
): number {
  if (candidates.length === 0) return 0;
  return candidates.filter((candidate) => pattern.test(candidate.text)).length / candidates.length;
}

function evaluateRows(
  candidates: readonly EditorialCorpusCandidateV2[],
  sourceLabel: string,
  determinism: EditorialCorpusReportV2["determinism"]
): EditorialCorpusReportV2 {
  const sentenceRows = candidates.map((candidate) => splitEditorialSentencesV2(candidate.text));
  const validations = candidates.map((candidate) =>
    validateEditorialDraftV2({
      text: candidate.text,
      subject: candidate.subject,
      displayValue: candidate.displayValue,
      factIds: candidate.factIds,
      usedFactIds: candidate.usedFactIds,
      allowedNumericValues: [candidate.metricPeriod, "24시간", "72시간"],
      allowedNamedTokens: [
        ...candidate.metricName
          .split(/[^a-zA-Z0-9]+/)
          .filter(Boolean)
          .map((token) => token.toUpperCase()),
        candidate.metricUnit,
      ],
      sourceTimeToken: candidate.sourceTimeToken,
      requireJudgment: true,
      metricName: candidate.metricName,
      metricDirection: inferMetricDirectionV2(
        candidate.metricName,
        candidate.displayValue,
        candidate.metricValue
      ),
      forbidPublicFollowUp: false,
      forbidFutureRecheck: true,
    })
  );
  const namedCount = candidates.filter((candidate, index) => {
    const subject = candidate.subject.trim();
    return subject.length >= 2 && sentenceRows[index][0]?.includes(subject);
  }).length;
  const numericCount = candidates.filter((candidate, index) =>
    /\d/u.test(candidate.displayValue) &&
    sentenceRows[index].slice(0, 2).join(" ").includes(candidate.displayValue)
  ).length;
  const sourceTimeCount = candidates.filter((candidate) =>
    candidate.text.includes(candidate.sourceTimeToken)
  ).length;
  const firstDuplicates = duplicateExtras(
    sentenceRows.map((sentences) => normalizedSentence(sentences[0] || ""))
  );
  const secondDuplicates = duplicateExtras(
    sentenceRows.map((sentences) => normalizedSentence(sentences[1] || ""))
  );
  const semanticNearDuplicates = semanticNearDuplicateCount(candidates);
  const malformedCount = validations.filter((validation) =>
    validation.reasons.some((reason) => reason.startsWith("malformed-") || reason === "scene-boilerplate")
  ).length;
  const contractFailureCount = validations.filter((validation) => !validation.ok).length;
  const count = candidates.length;
  const phraseRates = {
    eventually: phraseRate(candidates, /결국/u),
    scene: phraseRate(candidates, /장면/u),
    lyingMetaphor: phraseRate(candidates, /눕(?:기|는|은|다|혀|힌|었|어)?/u),
  };
  const failures: string[] = [];
  if (count !== SYNTHETIC_COUNT) failures.push(`candidate-count:${count}`);
  if (namedCount !== count) failures.push(`named-subject-coverage:${namedCount}/${count}`);
  if (numericCount !== count) failures.push(`numeric-coverage:${numericCount}/${count}`);
  if (sourceTimeCount !== count) failures.push(`source-time-coverage:${sourceTimeCount}/${count}`);
  if (firstDuplicates !== 0) failures.push(`first-sentence-duplicates:${firstDuplicates}`);
  if (secondDuplicates !== 0) failures.push(`second-sentence-duplicates:${secondDuplicates}`);
  const nearRate = count > 0 ? semanticNearDuplicates / count : 0;
  if (nearRate >= 0.08) failures.push(`semantic-near-duplicate-rate:${nearRate.toFixed(4)}`);
  if (malformedCount !== 0) failures.push(`malformed:${malformedCount}`);
  if (contractFailureCount !== 0) failures.push(`contract-failures:${contractFailureCount}`);
  if (phraseRates.eventually >= 0.15) failures.push(`eventually-rate:${phraseRates.eventually.toFixed(4)}`);
  if (phraseRates.scene >= 0.15) failures.push(`scene-rate:${phraseRates.scene.toFixed(4)}`);
  if (phraseRates.lyingMetaphor >= 0.05) failures.push(`lying-metaphor-rate:${phraseRates.lyingMetaphor.toFixed(4)}`);
  if (!determinism.passed) failures.push("determinism");

  return {
    corpusKind: candidates[0]?.corpusKind || "synthetic",
    sourceLabel,
    candidateCount: count,
    namedSubjectCoverage: count > 0 ? namedCount / count : 0,
    numericCoverage: count > 0 ? numericCount / count : 0,
    sourceTimeCoverage: count > 0 ? sourceTimeCount / count : 0,
    exactFirstSentenceDuplicates: firstDuplicates,
    exactSecondSentenceDuplicates: secondDuplicates,
    semanticNearDuplicates,
    semanticNearDuplicateRate: nearRate,
    nearDuplicateThreshold: NEAR_DUPLICATE_THRESHOLD,
    malformedCount,
    contractFailureCount,
    phraseRates,
    determinism,
    passed: failures.length === 0,
    failures,
  };
}

export async function evaluateSyntheticCorpusV2(
  seed = "pixymon-v2-r0"
): Promise<EditorialCorpusReportV2> {
  const baseline = await generateSyntheticCorpusV2(seed);
  const serialized = JSON.stringify(baseline);
  let deterministic = true;
  for (let run = 1; run < DETERMINISM_RUNS; run += 1) {
    if (JSON.stringify(await generateSyntheticCorpusV2(seed)) !== serialized) {
      deterministic = false;
      break;
    }
  }
  return evaluateRows(baseline, `synthetic seed=${seed} (not production replay)`, {
    runs: DETERMINISM_RUNS,
    passed: deterministic,
  });
}

export function evaluateRealReplayCorpusV2(inputPath: string): EditorialCorpusReportV2 {
  const candidates = loadRealReplayCorpusV2(inputPath);
  const serialized = JSON.stringify(candidates);
  let deterministic = true;
  for (let run = 1; run < DETERMINISM_RUNS; run += 1) {
    if (JSON.stringify(loadRealReplayCorpusV2(inputPath)) !== serialized) {
      deterministic = false;
      break;
    }
  }
  return evaluateRows(candidates, `real replay file=${path.resolve(inputPath)}`, {
    runs: DETERMINISM_RUNS,
    passed: deterministic,
  });
}

export function assertEditorialCorpusGatesV2(report: EditorialCorpusReportV2): void {
  assert.equal(
    report.passed,
    true,
    `editorial corpus gates failed: ${report.failures.join(", ")}`
  );
}
