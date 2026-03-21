import { sanitizeTweetText } from "./quality.js";
import { finalizeGeneratedText, normalizeQuestionTail, stableSeedForPrelude } from "./text-finalize.js";
import { TrendLane } from "../../types/agent.js";

type KoWriterFrame = "claim-note" | "field-note" | "cross-exam" | "quest";

export interface KoIdentityWriterInput {
  headline: string;
  primaryAnchor: string;
  secondaryAnchor: string;
  lane: TrendLane;
  mode: string;
  worldviewHint?: string;
  signatureBelief?: string;
  recentReflection?: string;
  interactionMission?: string;
  activeQuestion?: string;
  maxChars: number;
  seedHint?: string;
}

const CLAIM_BY_LANE: Record<TrendLane, string[]> = {
  protocol: [
    "릴리스 노트는 금방 나오지만 신뢰는 운영 로그가 만든다.",
    "코드가 바뀌었다는 사실과 시스템이 버틴다는 사실은 다르다.",
    "업그레이드 발표는 쉽고 운영 신뢰는 느리게 쌓인다.",
  ],
  ecosystem: [
    "생태계 서사는 뜨거워지기 쉽지만 사용자는 훨씬 차갑게 움직인다.",
    "커뮤니티 열기만으로는 실사용을 증명하지 못한다.",
    "이용자가 빠져나간 생태계는 홍보 문구에 더 가깝다.",
  ],
  regulation: [
    "규제 뉴스는 빨리 돌지만 시장을 바꾸는 건 집행이다.",
    "정책 문장이 커도 실제 방향은 현장 집행이 정한다.",
    "기사로 긴장감은 만들 수 있어도 돈은 집행을 보고 움직인다.",
  ],
  macro: [
    "거시 뉴스는 소음을 크게 만들고 자금 습관은 훨씬 늦게 움직인다.",
    "큰 뉴스보다 느린 자금 이동이 더 오래 남는다.",
    "거시 해설은 넘치지만 실제 배치는 늘 더 늦게 바뀐다.",
  ],
  onchain: [
    "온체인 데이터는 숫자보다 지속 시간이 먼저 말을 건다.",
    "체인 안쪽 신호는 오래 남을 때만 믿을 만해진다.",
    "주소 움직임은 쉽게 과장되지만 지속성은 속이기 어렵다.",
  ],
  "market-structure": [
    "호가가 요란한 날일수록 실제 체결은 더 조용히 진실을 말한다.",
    "화면 분위기와 구조 변화는 전혀 다른 문제다.",
    "호가가 아니라 체결이 남아야 구조 변화라고 부를 수 있다.",
  ],
};

const CROSS_EXAM_BY_LANE: Record<TrendLane, string[]> = {
  protocol: [
    "운영이 비는데도 업그레이드 서사만 커지면 나는 바로 경계한다.",
    "테스트넷의 박수와 메인넷의 신뢰를 같은 값으로 치지 않는다.",
  ],
  ecosystem: [
    "사람이 빠지는데도 커뮤니티 서사만 커지면 대개 오래 못 간다.",
    "열기만 남고 재방문이 비는 날은 홍보가 사용을 이긴 날이다.",
  ],
  regulation: [
    "정책 문장이 큰 날일수록 나는 기사보다 집행 흔적을 먼저 본다.",
    "규제 해석이 화려할수록 실제 행동은 더 늦게 확인한다.",
  ],
  macro: [
    "거시 해설이 넘칠수록 체인 안쪽 습관이 정말 바뀌는지 더 늦게 믿는다.",
    "큰 뉴스가 나왔다고 바로 방향을 바꾸지 않는다. 자금은 늘 더 느리다.",
  ],
  onchain: [
    "예쁘게 튄 온체인 숫자는 쉽게 믿지 않는다. 오래 남는 쪽만 본다.",
    "온체인 신호가 반짝일수록 하루 뒤에 남는지부터 다시 확인한다.",
  ],
  "market-structure": [
    "화면만 뜨거운 날은 구조 변화보다 연출일 때가 많다.",
    "호가창이 시끄럽다고 실제 돈까지 움직였다고 보지 않는다.",
  ],
};

const FIELD_NOTES_BY_LANE: Record<TrendLane, string[]> = {
  protocol: [
    "발표와 운영이 다른 말을 하는 날이 있다.",
    "코드보다 운영 흔적이 더 늦게 진실을 말한다.",
  ],
  ecosystem: [
    "열기와 잔류가 다른 길을 가는 날이 있다.",
    "커뮤니티의 소음보다 재방문이 훨씬 정확하다.",
  ],
  regulation: [
    "기사와 집행 사이엔 늘 시차가 남는다.",
    "정책 문장보다 현장 행동이 훨씬 비싸다.",
  ],
  macro: [
    "해설보다 자금 습관이 훨씬 늦게 방향을 바꾼다.",
    "헤드라인이 커질수록 실제 배치는 더 느리게 바뀐다.",
  ],
  onchain: [
    "튀는 숫자와 버티는 흔적은 늘 같은 편이 아니다.",
    "온체인에선 속도보다 지속 시간이 더 솔직하다.",
  ],
  "market-structure": [
    "화면 열기와 실제 돈은 자주 갈라진다.",
    "분위기와 체결이 같은 말을 하는 날은 생각보다 적다.",
  ],
};

const EVIDENCE_BY_LANE: Record<TrendLane, string[]> = {
  protocol: [
    "{A}와 {B}를 같이 놓고 보면 발표가 운영으로 이어지는지 드러난다.",
    "{A}는 살아 있는데 {B}가 비면 나는 그 업그레이드를 절반만 믿는다.",
    "{A}가 앞서도 {B}가 늦으면 그 발표는 아직 반쪽이다.",
  ],
  ecosystem: [
    "{A}와 {B}를 같이 보면 서사와 사용이 같은 방향인지 드러난다.",
    "{A}가 살아 있어도 {B}가 비면 그 생태계 얘기는 절반짜리다.",
    "{A}가 뜨거워도 {B}가 비면 그 반응은 오래 못 간다.",
  ],
  regulation: [
    "{A}와 {B}를 같이 보면 기사와 행동 사이의 간격이 드러난다.",
    "{A}가 움직여도 {B}가 비면 그 뉴스는 아직 현장에 닿지 않은 셈이다.",
    "{A}가 커져도 {B}가 비면 그 뉴스는 아직 현장 밖에 머문다.",
  ],
  macro: [
    "{A}와 {B}를 같이 보면 해설과 자금 습관이 같은 쪽을 가리키는지 드러난다.",
    "{A}가 시끄러워도 {B}가 안 바뀌면 나는 그 거시 해설을 늦게 믿는다.",
    "{A}가 커도 {B}가 그대로면 돈은 아직 움직이지 않은 셈이다.",
  ],
  onchain: [
    "{A}와 {B}를 함께 보면 숫자보다 지속성이 어디에 붙는지 드러난다.",
    "{A}가 튀어도 {B}가 금방 꺼지면 그 신호는 아직 잡음에 가깝다.",
    "{A}가 살아도 {B}가 못 버티면 신호보다 잡음 쪽이다.",
  ],
  "market-structure": [
    "{A}와 {B}를 같이 보면 화면 열기와 실제 돈이 같은 편인지 드러난다.",
    "{A}가 살아 있는데 {B}가 비면 나는 그 과열을 믿지 않는다.",
    "{A}가 출렁여도 {B}가 비면 그 과열은 화면 안에서만 돈다.",
  ],
};

const DECISION_BY_LANE: Record<TrendLane, string[]> = {
  protocol: [
    "운영이 따라붙지 않으면 이건 릴리스 노트로만 남는다.",
    "로그가 비면 그 약속은 아직 문장값밖에 못 한다.",
    "실행이 약하면 나는 이 얘기를 반쯤 덜어낸다.",
  ],
  ecosystem: [
    "재방문이 비면 그 서사는 곧 광고 냄새를 낸다.",
    "사용이 안 남으면 이 얘기는 과열이지 성장은 아니다.",
    "사람이 비면 좋은 포스터여도 오래 못 간다.",
  ],
  regulation: [
    "집행이 안 붙으면 이건 변화가 아니라 기사다.",
    "행동이 비면 화려한 해설도 값이 급격히 떨어진다.",
    "현장 흔적이 없으면 이 뉴스는 아직 반쪽이다.",
  ],
  macro: [
    "자금 습관이 안 바뀌면 이건 전환이 아니라 해설이다.",
    "체인 안쪽이 그대로면 큰 뉴스도 아직 바깥 공기다.",
    "배치가 안 달라지면 그 거시 해설은 아직 멀리 있다.",
  ],
  onchain: [
    "지속 시간이 안 붙으면 이건 신호보다 잡음에 가깝다.",
    "하루를 못 넘기면 숫자는 예뻐도 근거는 얇다.",
    "끝까지 못 남으면 오늘 단서로 채택하지 않는다.",
  ],
  "market-structure": [
    "체결이 안 남으면 이건 구조 변화가 아니라 화면 효과다.",
    "돈이 끝까지 안 붙으면 그 과열은 연출 쪽이다.",
    "주문이 비면 그 뜨거움은 구조가 아니라 장식이다.",
  ],
};

const CONSEQUENCE_BY_LANE: Record<TrendLane, string[]> = {
  protocol: [
    "반대편이 더 오래 버티면 설명을 갈아엎는다.",
    "운영 반응이 비는 순간 이 얘기는 효력을 잃는다.",
  ],
  ecosystem: [
    "재방문이 꺼지는 순간 그 서사는 바로 식는다.",
    "사용 흔적이 끊기면 미련 없이 지운다.",
  ],
  regulation: [
    "반대편이 더 오래 버티면 기사보다 행동 편을 든다.",
    "집행이 비는 순간 해설은 힘을 잃는다.",
  ],
  macro: [
    "자금 흐름이 안 붙으면 거시 해설은 여기서 멈춘다.",
    "체인 안쪽이 그대로면 이 장면은 뉴스 이상이 아니다.",
  ],
  onchain: [
    "하루를 못 넘기면 나는 이 숫자를 그냥 흘려보낸다.",
    "둘이 엇갈리면 오래 붙잡지 않는다.",
  ],
  "market-structure": [
    "체결이 못 버티면 화면 열기도 함께 값이 떨어진다.",
    "주문이 비면 이 과열은 금방 가벼워진다.",
  ],
};

const PIXYMON_INSTINCTS = [
  "쉽게 삼켜지는 설명은 대개 다시 뱉게 된다.",
  "나는 반짝이는 서사보다 오래 남는 흔적을 더 믿는다.",
  "한입에 설명되는 장면일수록 한 번 더 의심한다.",
  "좋아 보이는 문장보다 끝까지 남는 근거 하나가 훨씬 쓸모 있다.",
  "빨리 맞히는 것보다 늦게 틀리는 편이 낫다고 본다.",
  "말보다 행동이 늦게 붙는 날엔 결론도 늦게 내린다.",
];

const QUESTION_FALLBACKS = [
  "이 장면을 뒤집는 첫 신호를 어디서 찾겠나?",
  "너라면 여기서 먼저 믿지 않을 근거는 뭐겠나?",
  "같은 장면을 반대로 읽는다면 어느 쪽부터 의심하겠나?",
  "이 읽기가 틀렸다면 가장 먼저 무너질 건 무엇 같나?",
];


const ANCHOR_REWRITES: Array<[RegExp, string]> = [
  [/^체인\s*안쪽\s*사용$/u, "체인 안쪽 사용"],
  [/^규제\s*쪽\s*일정$/u, "규제 일정"],
  [/^실제\s*사용자가\s*다시\s*돌아오는지$/u, "재방문 흐름"],
  [/^다시\s*돌아오는\s*사람/u, "재방문 흐름"],
  [/^돈이\s*어디로\s*몰리는지$/u, "자금 쏠림 방향"],
  [/^큰\s*주문\s*소화$/u, "큰 주문 소화"],
  [/^거래소\s*반응\s*속도$/u, "거래소 반응 속도"],
  [/^집행\s*흔적$/u, "집행 흔적"],
  [/^체인\s*수수료$/u, "체인 수수료"],
  [/^주소\s*이동/u, "주소 이동"],
  [/^검증자\s*안정성$/u, "검증자 안정성"],
  [/^복구\s*시간\s*분포$/u, "복구 속도"],
  [/^자금\s*흐름$/u, "자금 흐름"],
];

function pick<T>(pool: T[], seed: number, offset = 0): T {
  return pool[(seed + offset) % pool.length];
}

function sanitizeClause(text: string): string {
  return sanitizeTweetText(String(text || "")).replace(/[.!?]+$/g, "").trim();
}

function fill(template: string, primaryAnchor: string, secondaryAnchor: string): string {
  return template.replaceAll("{A}", primaryAnchor).replaceAll("{B}", secondaryAnchor);
}

function summarizeAnchor(anchor: string): string {
  const cleaned = sanitizeClause(anchor)
    .replace(/\s*쪽\s*일정$/u, " 일정")
    .replace(/\s*쪽\s*움직임$/u, " 움직임")
    .replace(/\s*쪽\s*흐름$/u, " 흐름")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!cleaned) return "";
  for (const [pattern, replacement] of ANCHOR_REWRITES) {
    if (pattern.test(cleaned)) return replacement;
  }
  if (/는지$|인지$|일지$|할지$|될지$|붙는지$|남는지$|갈리는지$|버티는지$|무너지는지$/u.test(cleaned)) {
    return cleaned
      .replace(/^실제\s*사용자가\s*다시\s*돌아오는지$/u, "재방문 흐름")
      .replace(/^돈이\s*어디로\s*몰리는지$/u, "자금 쏠림 방향")
      .replace(/^가격\s*서사가\s*먼저\s*달아오르는지$/u, "가격 서사 과열")
      .replace(/^체인\s*수수료가\s*실제로\s*따라오는지$/u, "체인 수수료 추종")
      .replace(/는지$|인지$|일지$|할지$|될지$|붙는지$|남는지$|갈리는지$|버티는지$|무너지는지$/u, "")
      .trim();
  }
  return cleaned;
}

function resolveWriterFrame(mode: string, seed: number): KoWriterFrame {
  if (mode === "interaction-experiment") return "quest";
  if (mode === "meta-reflection") return "cross-exam";
  if (mode === "identity-journal") return seed % 2 === 0 ? "field-note" : "claim-note";
  if (mode === "philosophy-note") return seed % 2 === 0 ? "claim-note" : "cross-exam";
  return ["claim-note", "field-note", "cross-exam"][(seed % 3)] as KoWriterFrame;
}

function rewriteSoulHint(input: KoIdentityWriterInput, seed: number): string {
  const source = sanitizeClause(input.recentReflection || input.signatureBelief || input.worldviewHint || "");
  if (!source) {
    return pick(PIXYMON_INSTINCTS, seed, 3);
  }
  if (/복구|회복|recovery/i.test(source)) {
    return "무너진 뒤 어떻게 복구하는지가 결국 신뢰를 만든다.";
  }
  if (/설명|서사/.test(source) && /근거|흔적|행동/.test(source)) {
    return "근사한 설명보다 끝까지 버티는 근거 하나가 훨씬 낫다.";
  }
  if (/행동|집행|실행/.test(source)) {
    return "말보다 행동이 늦게 붙는 날엔 결론도 늦게 내린다.";
  }
  if (/믿|서두르|보류/.test(source)) {
    return "빨리 맞히는 것보다 늦게 틀리는 편이 낫다고 본다.";
  }
  if (/장부|먹은 단서|진화/.test(source)) {
    return pick(PIXYMON_INSTINCTS, seed, 7);
  }
  if (source.length <= 38 && !/[A-Za-z]{5,}/.test(source)) {
    return source.endsWith("다") ? `${source}.` : `${source}다.`;
  }
  return pick(PIXYMON_INSTINCTS, seed, 11);
}

function buildQuestion(input: KoIdentityWriterInput, seed: number): string {
  const raw = sanitizeTweetText(input.interactionMission || input.activeQuestion || "").trim();
  if (raw) {
    const compact = raw.length > 68 ? `${raw.slice(0, 64).trim()}...` : raw;
    return normalizeQuestionTail(compact, "ko");
  }
  return pick(QUESTION_FALLBACKS, seed, 13);
}

function joinCandidate(lines: string[], maxChars: number): string {
  return finalizeGeneratedText(lines.filter(Boolean).join(" "), "ko", maxChars);
}

function maybeAddInstinct(baseLines: string[], instinct: string, maxChars: number, seed: number): string[] {
  if (!instinct || seed % 5 === 0) return baseLines;
  const next = seed % 2 === 0
    ? [baseLines[0], instinct, ...baseLines.slice(1)]
    : [...baseLines.slice(0, 2), instinct, ...baseLines.slice(2)];
  const candidate = joinCandidate(next, maxChars);
  return candidate.length <= maxChars ? next : baseLines;
}

export function buildKoIdentityWriterCandidate(input: KoIdentityWriterInput, variant = 0): string {
  const seed = stableSeedForPrelude(
    `${input.seedHint || input.headline}|${input.primaryAnchor}|${input.secondaryAnchor}|${input.mode}|${input.lane}|${variant}`
  );
  const primaryAnchor = summarizeAnchor(input.primaryAnchor);
  const secondaryAnchor = summarizeAnchor(input.secondaryAnchor);
  const frame = resolveWriterFrame(input.mode, seed + variant);
  const leadPool = frame === "cross-exam" ? CROSS_EXAM_BY_LANE[input.lane] : frame === "field-note" ? FIELD_NOTES_BY_LANE[input.lane] : CLAIM_BY_LANE[input.lane];
  const lead = pick(leadPool, seed, variant);
  const evidence = fill(pick(EVIDENCE_BY_LANE[input.lane], seed, variant + 3), primaryAnchor, secondaryAnchor);
  const instinct = rewriteSoulHint(input, seed + 17);
  const decision = pick(DECISION_BY_LANE[input.lane], seed, variant + 5);
  const consequence = pick(CONSEQUENCE_BY_LANE[input.lane], seed, variant + 9);
  const question = buildQuestion(input, seed + 19);

  const frameLines: Record<KoWriterFrame, string[]> = {
    "claim-note": [lead, evidence, `${decision} ${consequence}`],
    "field-note": [lead, evidence, `${decision} ${consequence}`],
    "cross-exam": [lead, evidence, `${decision} ${consequence}`],
    quest: [lead, evidence, decision, question],
  };

  const enriched = frame === "quest" ? frameLines[frame] : maybeAddInstinct(frameLines[frame], instinct, input.maxChars, seed + variant);
  let candidate = joinCandidate(enriched, input.maxChars);

  if (frame === "quest" && !/[?؟]$/.test(candidate)) {
    const appended = sanitizeTweetText(`${candidate} ${question}`);
    if (appended.length <= input.maxChars) {
      candidate = appended;
    } else {
      const budget = Math.max(24, input.maxChars - question.length - 1);
      const trimmedBase = finalizeGeneratedText(candidate, "ko", budget);
      candidate = sanitizeTweetText(`${trimmedBase} ${question}`);
    }
  }

  return candidate;
}
