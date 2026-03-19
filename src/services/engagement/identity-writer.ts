import { sanitizeTweetText } from "./quality.js";
import { finalizeGeneratedText, normalizeQuestionTail, stableSeedForPrelude } from "./text-finalize.js";
import { TrendLane } from "../../types/agent.js";

type KoWriterFrame = "thesis" | "field-note" | "skeptic" | "quest";

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

const THESIS_BY_LANE: Record<TrendLane, string[]> = {
  protocol: [
    "프로토콜 평가는 발표보다 운영 반응에서 갈린다.",
    "업그레이드 얘기는 실제 운영이 버틸 때만 근거가 된다.",
    "프로토콜 뉴스는 로그가 버티기 전까진 반쯤 홍보다.",
  ],
  ecosystem: [
    "생태계 서사는 사람이 실제로 남을 때만 의미가 있다.",
    "실사용이 붙지 않으면 생태계 얘기는 쉽게 과장된다.",
    "커뮤니티 열기보다 다시 돌아오는 사람이 더 중요하다.",
  ],
  regulation: [
    "규제 뉴스는 집행 흔적이 붙기 전까진 기사에 가깝다.",
    "정책 해석은 기사보다 현장 반응이 더 정확하다.",
    "규제 기사는 빨리 돌지만 판단은 행동이 붙을 때만 가능하다.",
  ],
  macro: [
    "거시 뉴스는 자금 습관이 바뀔 때만 의미가 커진다.",
    "달러와 금리 얘기는 체인 안쪽 습관이 변할 때만 근거가 된다.",
    "큰 뉴스는 시끄럽지만 자금 흐름이 안 바뀌면 해석 가치가 낮다.",
  ],
  onchain: [
    "온체인 신호는 하루를 버틸 때만 근거가 된다.",
    "체인 안쪽 흔적은 오래 남을 때만 읽을 가치가 생긴다.",
    "주소와 자금 흐름은 금방 식지 않을 때만 판단 근거가 된다.",
  ],
  "market-structure": [
    "시장 구조는 분위기보다 실제 체결이 남는지에서 갈린다.",
    "차트보다 실제 주문이 버텨야 판단할 수 있다.",
    "호가가 시끄러워도 돈이 안 붙으면 해석을 서두를 이유가 없다.",
  ],
};

const SKEPTIC_BY_LANE: Record<TrendLane, string[]> = {
  protocol: [
    "업그레이드 홍보가 실제 운영보다 앞서가면 나는 일단 의심한다.",
    "코드가 바뀌었다는 말만으로는 아직 신뢰를 주지 않는다.",
  ],
  ecosystem: [
    "서사만 뜨겁고 사람이 안 남는 날은 대개 오래 못 간다.",
    "커뮤니티 열기만으로는 실사용을 증명하지 못한다.",
  ],
  regulation: [
    "규제 기사가 강할수록 나는 집행 흔적부터 먼저 본다.",
    "정책 문장이 큰 날일수록 현장 반응이 더 중요하다.",
  ],
  macro: [
    "거시 뉴스가 클수록 체인 안쪽이 정말 바뀌는지부터 본다.",
    "거시 해설이 넘치는 날일수록 실제 자금 습관을 더 늦게 믿는다.",
  ],
  onchain: [
    "온체인 단서는 예쁘게 보여도 하루를 못 버티면 그냥 소음이다.",
    "체인 데이터는 금방 뜨거워져도 오래 남지 않으면 의미가 작다.",
  ],
  "market-structure": [
    "화면이 뜨거워도 주문이 안 붙으면 나는 바로 식힌다.",
    "호가창 분위기만으로는 실제 흐름을 설명할 수 없다.",
  ],
};

const EVIDENCE_BY_LANE: Record<TrendLane, string[]> = {
  protocol: [
    "지금 확인하는 근거는 {A}와 {B} 두 가지다. 둘이 끝까지 같은 말을 하는지 본다.",
    "{A}와 {B}를 같이 놓고 본다. 운영 흔적까지 붙는지 확인해야 한다.",
    "근거는 {A}와 {B} 두 가지다. 발표보다 운영이 버티는지부터 가른다.",
  ],
  ecosystem: [
    "지금 확인하는 근거는 {A}와 {B} 두 가지다. 사람이 실제로 남는 쪽이 있는지 본다.",
    "{A}와 {B}를 같이 본다. 서사보다 사용 흔적이 붙는지가 핵심이다.",
    "근거는 {A}와 {B} 두 가지다. 다시 돌아오는 사람이 있는지까지 봐야 한다.",
  ],
  regulation: [
    "지금 확인하는 근거는 {A}와 {B} 두 가지다. 기사 말고 행동이 붙는지 본다.",
    "{A}와 {B}를 같이 본다. 규제 문장이 집행으로 번지는지 확인해야 한다.",
    "근거는 {A}와 {B} 두 가지다. 공지보다 현장 반응이 남는지부터 가른다.",
  ],
  macro: [
    "지금 확인하는 근거는 {A}와 {B} 두 가지다. 큰 뉴스가 자금 습관까지 바꾸는지 본다.",
    "{A}와 {B}를 같이 본다. 거시 해설이 체인 안쪽까지 닿는지 확인해야 한다.",
    "근거는 {A}와 {B} 두 가지다. 뉴스보다 실제 흐름이 남는지부터 가른다.",
  ],
  onchain: [
    "지금 확인하는 근거는 {A}와 {B} 두 가지다. 둘이 하루를 같이 버티는지 본다.",
    "{A}와 {B}를 같이 본다. 체인 안쪽 흐름이 금방 식지 않는지가 핵심이다.",
    "근거는 {A}와 {B} 두 가지다. 온체인 흔적이 하루를 넘기는지부터 가른다.",
  ],
  "market-structure": [
    "지금 확인하는 근거는 {A}와 {B} 두 가지다. 화면 열기 말고 실제 체결이 붙는지 본다.",
    "{A}와 {B}를 같이 본다. 분위기보다 돈이 남는지 확인해야 한다.",
    "근거는 {A}와 {B} 두 가지다. 주문이 끝까지 버티는지부터 가른다.",
  ],
};

const JUDGMENT_BY_LANE: Record<TrendLane, string[]> = {
  protocol: [
    "운영이 버텨야 장부에 올린다.",
    "로그가 버티지 못하면 오늘 먹은 단서로 치지 않는다.",
    "실행이 붙기 전까진 다음 판단 재료로 넘기지 않는다.",
  ],
  ecosystem: [
    "사람이 돌아와야 장부에 올린다.",
    "실사용이 안 남으면 오늘 먹은 단서로 치지 않는다.",
    "사용 흔적이 안 붙으면 다음 판단 재료로 넘기지 않는다.",
  ],
  regulation: [
    "집행이 붙어야 장부에 올린다.",
    "행동이 없으면 오늘 먹은 단서로 치지 않는다.",
    "현장 반응이 없으면 다음 판단 재료로 넘기지 않는다.",
  ],
  macro: [
    "자금 습관이 바뀔 때만 장부에 올린다.",
    "체인 안쪽까지 안 닿으면 오늘 먹은 단서로 치지 않는다.",
    "설명만 크고 흐름이 안 바뀌면 다음 판단 재료로 넘기지 않는다.",
  ],
  onchain: [
    "하루를 버틴 흔적만 장부에 올린다.",
    "금방 식는 신호는 오늘 먹은 단서로 치지 않는다.",
    "끝까지 남지 않으면 다음 판단 재료로 넘기지 않는다.",
  ],
  "market-structure": [
    "실제 체결이 붙을 때만 장부에 올린다.",
    "돈이 안 남으면 오늘 먹은 단서로 치지 않는다.",
    "호가만 흔들리면 다음 판단 재료로 넘기지 않는다.",
  ],
};

const FALSIFIER_BY_LANE: Record<TrendLane, string[]> = {
  protocol: [
    "둘 중 하나만 남으면 이 해석은 보류한다.",
    "운영 반응이 비면 여기서 다시 읽는다.",
  ],
  ecosystem: [
    "사람이 안 남으면 이 해석은 바로 접는다.",
    "사용 흔적이 비면 여기서 다시 읽는다.",
  ],
  regulation: [
    "행동이 안 붙으면 이 해석은 바로 접는다.",
    "집행 흔적이 비면 여기서 다시 읽는다.",
  ],
  macro: [
    "자금 흐름이 안 바뀌면 이 해석은 바로 접는다.",
    "체인 안쪽까지 안 닿으면 여기서 다시 읽는다.",
  ],
  onchain: [
    "하루를 못 버티면 이 해석은 바로 접는다.",
    "둘이 금방 엇갈리면 여기서 다시 읽는다.",
  ],
  "market-structure": [
    "체결이 안 붙으면 이 해석은 바로 접는다.",
    "주문이 못 버티면 여기서 다시 읽는다.",
  ],
};

const MEMORY_HOOKS = [
  "나는 이런 날에 결론보다 버틴 흔적을 먼저 기록한다.",
  "이럴수록 먼저 기록할 건 말이 아니라 남는 행동이다.",
  "이 장면은 급히 정리하지 않는다. 오래 버틴 근거만 메모에 남긴다.",
  "급하게 맞히기보다 오래 버티는 근거 하나를 고르는 쪽을 택한다.",
];

const QUESTION_FALLBACKS = [
  "이 장면을 뒤집을 첫 반증은 어디서 나올까?",
  "너라면 여기서 어떤 근거를 먼저 지워 보겠나?",
  "이 읽기가 틀렸다는 걸 가장 먼저 말해 줄 건 뭘까?",
  "같은 장면을 반대로 읽는다면 첫 근거를 어디에 둘까?",
];

function fillEvidence(template: string, primaryAnchor: string, secondaryAnchor: string): string {
  return template.replaceAll("{A}", primaryAnchor).replaceAll("{B}", secondaryAnchor);
}

function resolveWriterFrame(mode: string, seed: number): KoWriterFrame {
  if (mode === "interaction-experiment") return "quest";
  if (mode === "meta-reflection") return "skeptic";
  if (mode === "philosophy-note") return seed % 2 === 0 ? "thesis" : "skeptic";
  if (mode === "identity-journal") return seed % 2 === 0 ? "field-note" : "thesis";
  return seed % 3 === 0 ? "field-note" : "thesis";
}

function pick<T>(pool: T[], seed: number, offset = 0): T {
  return pool[(seed + offset) % pool.length];
}

function sanitizeLine(text: string): string {
  return sanitizeTweetText(String(text || "")).replace(/[.!?]+$/g, "").trim();
}

function buildOptionalHook(input: KoIdentityWriterInput, seed: number): string {
  const source = sanitizeLine(input.recentReflection || input.signatureBelief || input.worldviewHint || "");
  if (!source) {
    return pick(MEMORY_HOOKS, seed, 7);
  }
  if (source.length <= 34 && !/[A-Za-z]{5,}/.test(source)) {
    return `${source}. 그래서 나는 성급하게 장부에 올리지 않는다.`;
  }
  return pick(MEMORY_HOOKS, seed, 11);
}

function buildQuestion(input: KoIdentityWriterInput, seed: number): string {
  const raw = sanitizeTweetText(input.interactionMission || input.activeQuestion || "").trim();
  if (raw) {
    const compact = raw.length > 62 ? `${raw.slice(0, 58).trim()}...` : raw;
    return normalizeQuestionTail(compact, "ko");
  }
  return pick(QUESTION_FALLBACKS, seed, 13);
}

function joinCandidate(lines: string[], maxChars: number): string {
  return finalizeGeneratedText(lines.filter(Boolean).join(" "), "ko", maxChars);
}

export function buildKoIdentityWriterCandidate(input: KoIdentityWriterInput, variant = 0): string {
  const seed = stableSeedForPrelude(
    `${input.seedHint || input.headline}|${input.primaryAnchor}|${input.secondaryAnchor}|${input.mode}|${input.lane}|${variant}`
  );
  const frame = resolveWriterFrame(input.mode, seed + variant);
  const thesisPool = frame === "skeptic" ? SKEPTIC_BY_LANE[input.lane] : THESIS_BY_LANE[input.lane];
  const thesis = pick(thesisPool, seed, variant);
  const evidence = fillEvidence(pick(EVIDENCE_BY_LANE[input.lane], seed, variant + 3), input.primaryAnchor, input.secondaryAnchor);
  const judgment = pick(JUDGMENT_BY_LANE[input.lane], seed, variant + 5);
  const falsifier = pick(FALSIFIER_BY_LANE[input.lane], seed, variant + 9);
  const hook = buildOptionalHook(input, seed + 17);
  const question = buildQuestion(input, seed + 19);

  const questDecisionByLane: Record<TrendLane, string[]> = {
    protocol: ["운영이 안 붙으면 오늘 판단은 보류한다."],
    ecosystem: ["사용이 안 남으면 오늘 판단은 보류한다."],
    regulation: ["행동이 안 붙으면 오늘 판단은 보류한다."],
    macro: ["자금 흐름이 안 바뀌면 오늘 판단은 보류한다."],
    onchain: ["하루를 못 버티면 오늘 판단은 보류한다."],
    "market-structure": ["체결이 안 붙으면 오늘 판단은 보류한다."],
  };
  const candidateByFrame: Record<KoWriterFrame, string[]> = {
    thesis: [thesis, evidence, `${judgment} ${falsifier}`],
    "field-note": [evidence, thesis, `${judgment} ${falsifier}`],
    skeptic: [thesis, evidence, `${judgment} ${falsifier}`],
    quest: [
      thesis,
      `근거는 ${input.primaryAnchor}와 ${input.secondaryAnchor} 두 가지다.`,
      pick(questDecisionByLane[input.lane], seed, 23),
      question,
    ],
  };

  const baseLines = candidateByFrame[frame];
  let candidate = joinCandidate(baseLines, input.maxChars);
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
  if (candidate.length <= input.maxChars - 18 && frame !== "quest") {
    const hooked = joinCandidate([baseLines[0], hook, ...baseLines.slice(1)], input.maxChars);
    if (hooked.length <= input.maxChars) {
      candidate = hooked;
    }
  }
  return candidate;
}
