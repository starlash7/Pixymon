import { sanitizeTweetText } from "./quality.js";
import { finalizeGeneratedText, normalizeQuestionTail, stableSeedForPrelude } from "./text-finalize.js";
import { TrendLane } from "../../types/agent.js";

type KoWriterFrame = "claim-note" | "field-note" | "cross-exam" | "quest";
type WriterFocus = "retention" | "hype" | "execution" | "liquidity" | "durability" | "general";
type WriterSegment =
  | "scene"
  | "lead"
  | "stamp"
  | "evidence"
  | "instinct"
  | "attitude"
  | "fixation"
  | "decision"
  | "consequence"
  | "question";

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
    "{A}가 살아도 {B}가 비면 그 업그레이드는 아직 운영까지 못 내려왔다.",
    "{A}는 살아 있는데 {B}가 비면 나는 그 업그레이드를 절반만 믿는다.",
    "{A}가 앞서도 {B}가 늦으면 그 발표는 아직 반쪽이다.",
    "{A}만 번쩍이고 {B}가 비면 그 발표는 박수에서 멈춘다.",
  ],
  ecosystem: [
    "{A}가 뜨거워도 {B}가 비면 그 열기는 사람을 못 붙잡는다.",
    "{A}가 살아 있어도 {B}가 비면 그 생태계 얘기는 절반짜리다.",
    "{A}가 뜨거워도 {B}가 비면 그 반응은 오래 못 간다.",
    "{A}만 커지고 {B}가 비면 그 서사는 결국 홍보로 돌아간다.",
  ],
  regulation: [
    "{A}가 움직여도 {B}가 비면 그 뉴스는 아직 기사 단계에 머문다.",
    "{A}가 움직여도 {B}가 비면 그 뉴스는 아직 현장에 닿지 않은 셈이다.",
    "{A}가 커져도 {B}가 비면 그 뉴스는 아직 현장 밖에 머문다.",
    "{A}만 커지고 {B}가 안 붙으면 해설이 행동보다 앞서간다.",
  ],
  macro: [
    "{A}가 커도 {B}가 그대로면 큰 뉴스는 아직 배치까지 못 건드렸다.",
    "{A}가 시끄러워도 {B}가 안 바뀌면 나는 그 거시 해설을 늦게 믿는다.",
    "{A}가 커도 {B}가 그대로면 돈은 아직 움직이지 않은 셈이다.",
    "{A}만 요란하고 {B}가 가만하면 돈은 아직 다른 말을 한다.",
  ],
  onchain: [
    "{A}가 튀어도 {B}가 금방 꺼지면 그 숫자는 아직 하루를 못 넘긴다.",
    "{A}가 튀어도 {B}가 금방 꺼지면 그 신호는 아직 잡음에 가깝다.",
    "{A}가 살아도 {B}가 못 버티면 신호보다 잡음 쪽이다.",
    "{A}가 예뻐도 {B}가 비면 그 온체인 숫자는 아직 장식이다.",
  ],
  "market-structure": [
    "{A}가 살아 있는데 {B}가 비면 그 과열은 아직 화면 바깥으로 못 나왔다.",
    "{A}가 살아 있는데 {B}가 비면 나는 그 과열을 믿지 않는다.",
    "{A}가 출렁여도 {B}가 비면 그 과열은 화면 안에서만 돈다.",
    "{A}만 튀고 {B}가 비면 그 자신감은 체결 없는 연출이다.",
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
    "복구 흔적이 비면 이 발표는 금방 낡은 문장이 된다.",
  ],
  ecosystem: [
    "재방문이 꺼지는 순간 그 서사는 바로 식는다.",
    "사용 흔적이 끊기면 미련 없이 지운다.",
    "사람이 흩어지는 순간 그 열기는 포스터 값밖에 못 한다.",
  ],
  regulation: [
    "반대편이 더 오래 버티면 기사보다 행동 편을 든다.",
    "집행이 비는 순간 해설은 힘을 잃는다.",
    "행동이 안 남는 순간 이 뉴스는 금방 낡은 기사로 돌아간다.",
  ],
  macro: [
    "자금 흐름이 안 붙으면 거시 해설은 여기서 멈춘다.",
    "체인 안쪽이 그대로면 이 장면은 뉴스 이상이 아니다.",
    "배치가 그대로면 큰 해설도 금방 공기처럼 흩어진다.",
  ],
  onchain: [
    "하루를 못 넘기면 나는 이 숫자를 그냥 흘려보낸다.",
    "둘이 엇갈리면 오래 붙잡지 않는다.",
    "다음 날까지 못 남으면 그 숫자는 그냥 스쳐 간다.",
  ],
  "market-structure": [
    "체결이 못 버티면 화면 열기도 함께 값이 떨어진다.",
    "주문이 비면 이 과열은 금방 가벼워진다.",
    "돈이 빠지는 순간 그 자신감은 바로 얇아진다.",
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


const ATTITUDE_BY_LANE: Record<TrendLane, string[]> = {
  protocol: [
    "나는 박수보다 복구 기록에 더 오래 매달린다.",
    "로그보다 박수가 먼저 나오는 업그레이드는 늘 경계한다.",
  ],
  ecosystem: [
    "재방문이 비는 커뮤니티 열기는 대개 캠페인으로 끝난다.",
    "사람이 남지 않는데 서사만 큰 생태계는 오래 기억할 가치가 없다.",
  ],
  regulation: [
    "기사만 큰 규제 해설은 제일 먼저 의심한다.",
    "집행 흔적조차 안 남은 규제 논평은 오래 붙잡지 않는다.",
  ],
  macro: [
    "배치가 안 바뀌는데 해설만 큰 날은 오래 말할 가치가 없다.",
    "돈이 안 움직인 거시 해설은 절반쯤 소음으로 본다.",
  ],
  onchain: [
    "하루도 못 버틴 온체인 숫자는 장식에 가깝다.",
    "예쁜 수치가 빨리 식는 날은 더 오래 의심한다.",
  ],
  "market-structure": [
    "체결이 빠진 자신감은 화면 안에서만 커진다.",
    "돈이 안 붙은 과열은 제일 빨리 버린다.",
    "체결보다 분위기가 먼저 커진 과열은 오래 붙잡지 않는다.",
  ],
};

const FIXATION_BY_LANE: Record<TrendLane, string[]> = {
  protocol: [
    "끝내 믿는 쪽은 발표가 아니라 복구 속도다.",
    "업그레이드 서사보다 오래 보는 건 결국 운영 기록이다.",
  ],
  ecosystem: [
    "열기보다 오래 붙잡는 건 결국 재방문이다.",
    "사람을 남기지 못한 서사는 대개 홍보 문구로 끝난다.",
  ],
  regulation: [
    "규제 뉴스보다 오래 남는 건 결국 집행 흔적이다.",
    "기사 한 장보다 집행 하나가 훨씬 늦고 정확하다.",
  ],
  macro: [
    "큰 뉴스보다 끝까지 보는 건 결국 자금 배치다.",
    "거시 해설보다 오래 남는 건 자금 습관 쪽이다.",
  ],
  onchain: [
    "하루를 넘기는 숫자만 겨우 단서 취급을 한다.",
    "온체인에선 결국 오래 버틴 흔적만 내 손에 남는다.",
  ],
  "market-structure": [
    "화면 열기보다 오래 보는 건 결국 체결이다.",
    "돈이 안 붙은 자신감은 늘 제일 먼저 버린다.",
    "끝까지 확인하는 건 결국 체결이 남는지 여부다.",
  ],
};

const FOCUS_ATTITUDE_BY_LANE: Partial<Record<TrendLane, Partial<Record<WriterFocus, string[]>>>> = {
  ecosystem: {
    retention: [
      "사람이 남는지부터 보지 않으면 생태계 서사에 쉽게 속는다.",
      "재방문이 빠진 열기는 대개 캠페인으로 끝난다.",
      "잔류를 못 만드는 열기는 결국 포스터처럼 식는다.",
    ],
    hype: [
      "서사만 큰 생태계는 대개 광고 문구부터 진해진다.",
      "홍보가 사용보다 먼저 커지는 날은 오래 믿지 않는다.",
      "커뮤니티 열기만 요란한 날은 제일 늦게 믿는다.",
    ],
  },
  regulation: {
    execution: [
      "집행이 없는 규제 해설은 결국 기사 톤만 남긴다.",
      "현장 흔적이 비는 규제 논평은 오래 붙잡지 않는다.",
      "정책 문장이 커질수록 집행 빈칸부터 더 세게 본다.",
    ],
  },
  "market-structure": {
    liquidity: [
      "체결보다 호가가 먼저 커진 과열은 금방 값이 빠진다.",
      "돈이 안 붙은 열기는 대부분 화면에서 끝난다.",
      "자금이 안 남는 자신감은 오래 못 간다.",
    ],
  },
};

const FOCUS_FIXATION_BY_LANE: Partial<Record<TrendLane, Partial<Record<WriterFocus, string[]>>>> = {
  ecosystem: {
    retention: [
      "결국 오래 붙드는 건 재방문과 잔류다.",
      "남는 사람 수가 이 생태계 얘기의 값을 정한다.",
      "재방문이 없으면 큰 서사도 반쪽이다.",
    ],
    hype: [
      "서사가 커질수록 실제 사용 흔적은 더 차갑게 본다.",
      "홍보보다 늦게 남는 사용 흔적만 손에 남긴다.",
      "광고 냄새가 짙어질수록 사람 흔적부터 다시 센다.",
    ],
  },
  regulation: {
    execution: [
      "결국 기사보다 오래 남는 건 집행 흔적 쪽이다.",
      "규제 뉴스의 값은 집행이 붙는 순간에야 정해진다.",
      "행동으로 안 번지면 규제 뉴스는 대개 기사로 남는다.",
    ],
  },
  "market-structure": {
    liquidity: [
      "결국 오래 보는 건 호가가 아니라 체결 잔상이다.",
      "돈이 남는지 여부가 이 과열의 본색을 가른다.",
      "자금이 붙지 않으면 그 자신감은 장면값밖에 없다.",
    ],
  },
};

const FOCUS_CLAIM_BY_LANE: Partial<Record<TrendLane, Partial<Record<WriterFocus, string[]>>>> = {
  ecosystem: {
    retention: [
      "사람이 남는지 못 남는지가 결국 생태계 얘기의 값을 정한다.",
      "생태계가 오래 가는지 아닌지는 결국 재방문에서 갈린다.",
      "커뮤니티의 진짜 온도는 결국 돌아오는 사람 수에서 드러난다.",
    ],
    hype: [
      "서사만 불어나고 사용이 비면 그 생태계는 금방 종이처럼 얇아진다.",
      "열기만 큰 생태계는 결국 홍보 문구와 구별이 안 간다.",
      "광고가 사람보다 먼저 커지는 생태계는 오래 못 간다.",
    ],
  },
  regulation: {
    execution: [
      "규제 뉴스의 값은 결국 기사보다 집행에서 다시 매겨진다.",
      "정책 문장과 실제 행동이 갈라지는 순간 해설은 값이 빠진다.",
      "규제 얘기는 길어도 결국 집행이 붙지 않으면 기사로 남는다.",
    ],
  },
  "market-structure": {
    liquidity: [
      "호가보다 체결이 늦게 진실을 말하는 날이 있다.",
      "분위기가 아니라 실제 돈이 남아야 구조 변화라고 부를 수 있다.",
      "유동성이 안 붙은 과열은 결국 화면 장면으로 끝난다.",
    ],
  },
};

const FOCUS_EVIDENCE_BY_LANE: Partial<Record<TrendLane, Partial<Record<WriterFocus, string[]>>>> = {
  ecosystem: {
    retention: [
      "{A}가 살아 있어도 {B}가 비면 결국 사람은 남지 않는다.",
      "{A}가 뜨거워도 {B}가 비면 그 반응은 잔류로 이어지지 않는다.",
      "{A}가 살아 있어도 {B}가 식으면 그 생태계는 겉열기만 남는다.",
    ],
    hype: [
      "{A}만 커지고 {B}가 비면 그 열기는 결국 홍보 문장으로 돌아간다.",
      "{A}가 요란해도 {B}가 비면 그 생태계는 포스터만 커진 셈이다.",
      "{A}가 앞서도 {B}가 안 붙으면 사용보다 캠페인이 커진 날이다.",
    ],
  },
  regulation: {
    execution: [
      "{A}가 움직여도 {B}가 안 붙으면 그 뉴스는 아직 기사값밖에 못 한다.",
      "{A}만 커지고 {B}가 비면 정책 해설이 현장보다 앞서간다.",
      "{A}가 보여도 {B}가 비면 그 규제 뉴스는 아직 바깥에서만 돈다.",
    ],
  },
  "market-structure": {
    liquidity: [
      "{A}가 살아도 {B}가 비면 그 과열은 실제 돈까지 번진 게 아니다.",
      "{A}가 보여도 {B}가 비면 화면 열기만 커졌다고 보는 편이 맞다.",
      "{A}가 살아도 {B}가 안 붙으면 그 자신감은 체결 없는 분위기다.",
    ],
  },
};

const FOCUS_DECISION_BY_LANE: Partial<Record<TrendLane, Partial<Record<WriterFocus, string[]>>>> = {
  ecosystem: {
    retention: [
      "사람이 안 남으면 이 생태계 서사는 바로 값이 떨어진다.",
      "잔류가 비면 좋은 설명도 여기서 힘을 잃는다.",
      "돌아오는 사람이 없으면 이 얘기는 성장 대신 과열로 남는다.",
    ],
    hype: [
      "사용이 안 붙으면 그 열기는 광고 쪽으로 분류한다.",
      "홍보만 크면 이 서사는 미련 없이 과열 편에 둔다.",
      "사람보다 서사가 먼저 커지면 이 얘기는 믿지 않는다.",
    ],
  },
  regulation: {
    execution: [
      "집행이 안 붙으면 이 뉴스는 기사 단계에서 멈춘다.",
      "행동이 비면 그 규제 해설은 여기서 바로 힘을 잃는다.",
      "현장 반응이 없으면 그 정책 얘기는 아직 반쪽이다.",
    ],
  },
  "market-structure": {
    liquidity: [
      "돈이 안 붙으면 이 과열은 화면값밖에 못 한다.",
      "체결이 비면 그 자신감은 구조 변화 대신 장면으로 남는다.",
      "실제 돈이 안 남으면 이 장면은 연출 편에 둔다.",
    ],
  },
};

const FOCUS_SCENE_OPENERS_BY_LANE: Partial<Record<TrendLane, Partial<Record<WriterFocus, string[]>>>> = {
  ecosystem: {
    retention: [
      "결국 걸리는 건 {Q} 쪽이다.",
      "{Q} 문제가 오늘 생태계 얘기의 핵심이다.",
      "오늘은 {Q} 지점이 제일 크게 남는다.",
    ],
    hype: [
      "{Q} 장면에서 서사와 사용이 갈린다.",
      "오늘은 {Q} 쪽의 허세가 더 크게 보인다.",
      "{Q} 문제부터 걷어내야 생태계 얘기가 맑아진다.",
    ],
  },
  regulation: {
    execution: [
      "{Q} 지점에서 기사와 행동이 갈린다.",
      "오늘은 {Q} 쪽의 빈칸이 더 크게 보인다.",
      "{Q} 문제를 보면 규제 뉴스의 값이 보인다.",
    ],
  },
  "market-structure": {
    liquidity: [
      "{Q} 장면에서 분위기와 돈이 갈린다.",
      "오늘은 {Q} 쪽에서 과열의 속내가 드러난다.",
      "{Q} 문제를 보면 화면 열기의 한계가 보인다.",
    ],
  },
};

const QUESTION_FALLBACKS = [
  "이 장면을 뒤집는 첫 신호를 어디서 찾겠나?",
  "너라면 여기서 먼저 믿지 않을 근거는 뭐겠나?",
  "같은 장면을 반대로 읽는다면 어느 쪽부터 의심하겠나?",
  "이 읽기가 틀렸다면 가장 먼저 무너질 건 무엇 같나?",
];

const QUESTION_BY_LANE: Record<TrendLane, string[]> = {
  protocol: [
    "이 업그레이드가 빈말이 아니려면 어떤 로그가 먼저 남아야 한다고 보나?",
    "너라면 여기서 발표보다 먼저 붙잡을 운영 흔적을 무엇으로 잡겠나?",
    "이 약속이 진짜라면 가장 늦게까지 버텨야 할 근거는 뭐라고 보나?",
  ],
  ecosystem: [
    "너라면 여기서 사람을 붙잡는 근거와 홍보 문구를 어떻게 가르겠나?",
    "이 장면이 성장인지 과열인지 가르는 첫 기준은 뭐라고 보나?",
    "사용이 남는지 보려면 어느 흔적부터 지워 보겠나?",
  ],
  regulation: [
    "기사와 행동이 갈릴 때 너는 어느 쪽부터 버리겠나?",
    "이 규제 뉴스가 기사 이상이 되려면 어떤 집행이 먼저 붙어야 한다고 보나?",
    "해설 대신 행동을 보려면 여기서 무엇부터 의심하겠나?",
  ],
  macro: [
    "이 거시 해설이 진짜 방향이라면 어느 자금 습관이 먼저 바뀌어야 한다고 보나?",
    "큰 뉴스 말고 배치 변화를 본다면 어디서부터 잘라 보겠나?",
    "이 장면을 거꾸로 읽는다면 어떤 자금 흐름부터 의심하겠나?",
  ],
  onchain: [
    "이 숫자가 잡음이 아니라 신호라면 무엇이 하루 뒤에도 남아야 한다고 보나?",
    "온체인 숫자를 믿기 전에 여기서 먼저 떨어져 나갈 근거는 뭐라고 보나?",
    "이 장면이 진짜라면 끝까지 버텨야 할 흔적은 어디라고 보나?",
  ],
  "market-structure": [
    "이 과열이 연출이 아니라면 어떤 체결이 마지막까지 남아야 한다고 보나?",
    "화면 열기 말고 진짜 돈을 보려면 여기서 뭘 먼저 버리겠나?",
    "이 자신감이 빈 껍데기라면 가장 먼저 빠질 흔적은 뭐라고 보나?",
  ],
};

const MODE_STAMP_BY_MODE: Record<string, string[]> = {
  "identity-journal": [
    "결국 메모에 남는 건 끝까지 버틴 쪽뿐이다.",
    "내가 오래 붙드는 건 늘 늦게 남는 쪽이다.",
    "급하게 좋아 보인 장면은 늘 한 번 더 접어 둔다.",
  ],
  "meta-reflection": [
    "대충 맞는 설명일수록 현장에선 빨리 들통난다.",
    "문제는 늘 제일 늦게 붙는 곳에서 커진다.",
    "겉이 맞아 보여도 밑단이 비면 금방 티가 난다.",
  ],
  "philosophy-note": [
    "길게 보면 서사는 결국 운영 앞에서 값을 다시 매긴다.",
    "오래 남는 건 해설보다 반복되는 습관 쪽이다.",
    "결국 구조는 화려한 설명보다 느린 반복을 닮는다.",
  ],
  "interaction-experiment": [
    "그래서 마지막에 남는 질문은 늘 하나뿐이다.",
    "결국 여기서 갈리는 건 한 줄짜리 설명이 아니다.",
    "그래서 이 장면은 질문으로 다시 물어야 한다.",
  ],
};

const SCENE_OPENERS = [
  "지금 자꾸 눈에 밟히는 건 {Q} 점이다.",
  "오늘 오래 남는 건 {Q} 사실이다.",
  "이번 흐름에서 제일 걸리는 건 {Q} 문제다.",
  "지금 적어 둘 만한 건 {Q} 신호다.",
  "{Q} 쪽에서 말과 흐름이 갈린다.",
  "오늘은 {Q} 장면부터 적어 둔다.",
  "{Q} 이야기가 이상하리만치 오래 남는다.",
];

const ANCHOR_SCENE_BY_LANE: Record<TrendLane, string[]> = {
  protocol: [
    "{A}와 {B}의 연결",
    "{A}와 {B}가 엇갈리는 지점",
    "{A}와 {B} 사이의 느린 차이",
  ],
  ecosystem: [
    "{A}와 {B}의 온도 차",
    "{A}와 {B}가 따로 노는 장면",
    "{A}와 {B} 사이의 거리",
  ],
  regulation: [
    "{A}와 {B} 사이의 틈",
    "{A}와 {B}가 따로 움직이는 장면",
    "{A}와 {B}의 시차",
  ],
  macro: [
    "{A}와 {B}의 시차",
    "{A}와 {B}가 다른 속도로 움직이는 장면",
    "{A}와 {B} 사이의 느린 간격",
  ],
  onchain: [
    "{A}와 {B}의 지속성 차이",
    "{A}와 {B}가 하루 뒤에 갈리는 장면",
    "{A}와 {B} 중 더 오래 남는 쪽",
  ],
  "market-structure": [
    "{A}와 {B}의 엇갈림",
    "{A}와 {B} 사이의 균열",
    "{A}와 {B}가 다른 편에 선 장면",
  ],
};

const SOUL_HINT_POOLS = {
  recovery: [
    "무너진 뒤에 무엇이 복구되는지가 결국 신뢰를 가른다.",
    "복구 기록은 늘 약속보다 늦게 나오지만 훨씬 오래 남는다.",
    "회복 방식이 엉키면 좋은 설명도 금방 값을 잃는다.",
  ],
  evidence: [
    "근사한 설명보다 끝까지 버티는 근거 하나가 훨씬 낫다.",
    "좋은 해설보다 오래 남는 흔적 하나가 훨씬 정확하다.",
    "보기 좋은 문장보다 끝까지 안 무너지는 근거가 더 쓸모 있다.",
  ],
  action: [
    "말보다 행동이 늦게 붙는 날엔 결론도 늦게 내린다.",
    "실행이 안 붙으면 좋은 설명도 절반쯤은 광고다.",
    "행동이 따라오지 않는 순간 해설은 금방 얇아진다.",
  ],
  caution: [
    "빨리 맞히는 것보다 늦게 틀리는 편이 낫다고 본다.",
    "서둘러 맞는 척하는 것보다 늦게 인정하는 쪽이 덜 틀린다.",
    "확신을 서두르는 날일수록 틀린 해설이 오래 남는다.",
  ],
  creature: [
    "쉽게 삼켜지는 설명은 대개 다시 뱉게 된다.",
    "한입에 삼켜지는 서사는 오래 못 버틴다.",
    "너무 잘 삼켜지는 설명은 대개 다시 올라온다.",
  ],
  default: PIXYMON_INSTINCTS,
};

const FOCUS_SOUL_HINT_POOLS: Partial<Record<TrendLane, Partial<Record<WriterFocus, string[]>>>> = {
  ecosystem: {
    retention: [
      "좋은 서사보다 다시 돌아오는 사람이 훨씬 정직하다.",
      "열기보다 잔류가 더 오래 진실을 끌고 간다.",
      "사용자가 돌아오지 않으면 멋진 설명도 오래 못 버틴다.",
    ],
    hype: [
      "서사만 부풀수록 실제 사용 흔적은 더 차갑게 봐야 한다.",
      "광고가 앞설수록 남는 건 대개 빈 열기다.",
      "사람보다 문구가 먼저 커지는 장면은 오래 믿지 않는다.",
    ],
  },
  regulation: {
    execution: [
      "규제 뉴스는 집행이 붙기 전까지 늘 반쪽짜리다.",
      "행동이 안 붙은 정책 해설은 기사 톤을 벗어나지 못한다.",
      "집행 빈칸이 큰 날일수록 좋은 해설도 얇아진다.",
    ],
  },
  "market-structure": {
    liquidity: [
      "분위기보다 돈이 어디에 남는지가 결국 더 정확하다.",
      "호가보다 체결이 늦게 남기는 흔적이 훨씬 정직하다.",
      "자금이 안 붙은 열기는 오래 믿을 이유가 없다.",
    ],
  },
};


const ANCHOR_REWRITES: Array<[RegExp, string]> = [
  [/^체인\s*안쪽\s*사용$/u, "체인 안쪽 사용"],
  [/^체인\s*사용$/u, "체인 안쪽 사용"],
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

function hasBatchim(text: string): boolean {
  const last = text[text.length - 1];
  const code = last?.charCodeAt(0) ?? 0;
  if (code < 0xac00 || code > 0xd7a3) return false;
  return (code - 0xac00) % 28 !== 0;
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
    .replace(/\s*(포착|살아남|확대|증가|감소|회복|유지|급등|급락)$/u, "")
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

function summarizeHeadline(headline: string): string {
  const cleaned = sanitizeClause(headline)
    .replace(/^오늘\s+/u, "")
    .replace(/^지금\s+/u, "")
    .replace(/^이번\s+/u, "")
    .trim();
  if (!cleaned) return "";
  return cleaned
    .replace(/사이에\s+틈이\s+나는지$/u, "사이의 틈")
    .replace(/같은\s+방향으로\s+가는지$/u, "의 방향")
    .replace(/같은\s+편인지$/u, "의 정렬")
    .replace(/운영\s+흔적으로\s+이어지는지$/u, "와 운영 흔적의 연결")
    .replace(/실제로\s+따라오는지$/u, "의 추종")
    .replace(/먼저\s+달아오르는지$/u, "의 과열")
    .replace(/살핀다$|짚는다$|본다$|의심한다$|경계한다$|가른다$|묻는다$/u, "")
    .replace(/는지$/u, "는 장면")
    .replace(/인지$/u, "인 장면")
    .replace(/일지$/u, "일 장면")
    .replace(/될지$/u, "될 장면")
    .replace(/붙는지$/u, "붙는 장면")
    .replace(/남는지$/u, "남는 장면")
    .replace(/갈리는지$/u, "갈리는 장면")
    .replace(/버티는지$/u, "버티는 장면")
    .replace(/무너지는지$/u, "무너지는 장면")
    .replace(/\s*먼저$/u, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function resolveWriterFrame(mode: string, focus: WriterFocus, seed: number): KoWriterFrame {
  if (mode === "interaction-experiment") return "quest";
  if (mode === "meta-reflection") return "cross-exam";
  if (mode === "identity-journal" && focus === "retention") return "field-note";
  if (mode === "identity-journal" && focus === "hype") return "claim-note";
  if (mode === "meta-reflection" && focus === "execution") return "cross-exam";
  if (mode === "philosophy-note" && focus === "liquidity") return "claim-note";
  if (mode === "identity-journal") return seed % 2 === 0 ? "field-note" : "claim-note";
  if (mode === "philosophy-note") return seed % 2 === 0 ? "claim-note" : "cross-exam";
  return ["claim-note", "field-note", "cross-exam"][(seed % 3)] as KoWriterFrame;
}

function hasSimilarCadence(left: string, right: string): boolean {
  const normalize = (text: string) => sanitizeClause(text).replace(/\s+/g, " ");
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return false;
  const aTail = a.split(" ").slice(-1)[0];
  const bTail = b.split(" ").slice(-1)[0];
  if (aTail && aTail === bTail) return true;
  return /(경계한다|의심한다|믿지 않는다|힘을 잃는다|오래 못 간다|가깝다|멈춘다)$/.test(a) && /(경계한다|의심한다|믿지 않는다|힘을 잃는다|오래 못 간다|가깝다|멈춘다)$/.test(b) && aTail === bTail;
}

function resolveWriterFocus(input: KoIdentityWriterInput, primaryAnchor: string, secondaryAnchor: string): WriterFocus {
  const merged = sanitizeTweetText(
    [input.headline, primaryAnchor, secondaryAnchor, input.worldviewHint, input.signatureBelief, input.recentReflection]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
  );

  if (input.lane === "ecosystem") {
    if (/(재방문|돌아오|머무|잔류|사용자|이용자|유저|실사용)/.test(merged)) return "retention";
    if (/(서사|홍보|광고|커뮤니티|열기|캠페인)/.test(merged)) return "hype";
  }
  if (input.lane === "regulation" && /(집행|현장|행동|기사|정책|규제|논평|해설)/.test(merged)) {
    return "execution";
  }
  if (input.lane === "market-structure" && /(호가|체결|주문|자금|과열|유동성|돈)/.test(merged)) {
    return "liquidity";
  }
  if (input.lane === "onchain" && /(지속|하루|버티|숫자|신호|흔적)/.test(merged)) {
    return "durability";
  }
  return "general";
}

function pickAttitudeLine(lane: TrendLane, focus: WriterFocus, seed: number, lead: string): string {
  const focusPool = FOCUS_ATTITUDE_BY_LANE[lane]?.[focus] || [];
  const pool = [...focusPool, ...ATTITUDE_BY_LANE[lane]];
  const first = pick(pool, seed, 21);
  if (!hasSimilarCadence(first, lead)) return first;
  return pick(pool, seed + 1, 21);
}

function pickFixationLine(lane: TrendLane, focus: WriterFocus, seed: number, lead: string, attitude: string): string {
  const focusPool = FOCUS_FIXATION_BY_LANE[lane]?.[focus] || [];
  const pool = [...focusPool, ...FIXATION_BY_LANE[lane]];
  const first = pick(pool, seed, 25);
  if (!hasSimilarCadence(first, lead) && !hasSimilarCadence(first, attitude)) return first;
  return pick(pool, seed + 1, 25);
}

function rewriteSoulHint(input: KoIdentityWriterInput, focus: WriterFocus, seed: number): string {
  const source = sanitizeClause(input.recentReflection || input.signatureBelief || input.worldviewHint || "");
  const focusPool = FOCUS_SOUL_HINT_POOLS[input.lane]?.[focus];
  if (focusPool?.length) {
    return pick(focusPool, seed, 2);
  }
  if (!source) {
    return pick(SOUL_HINT_POOLS.default, seed, 3);
  }
  if (/복구|회복|recovery/i.test(source)) {
    return pick(SOUL_HINT_POOLS.recovery, seed, 5);
  }
  if (/설명|서사/.test(source) && /근거|흔적|행동/.test(source)) {
    return pick(SOUL_HINT_POOLS.evidence, seed, 7);
  }
  if (/행동|집행|실행/.test(source)) {
    return pick(SOUL_HINT_POOLS.action, seed, 11);
  }
  if (/믿|서두르|보류/.test(source)) {
    return pick(SOUL_HINT_POOLS.caution, seed, 13);
  }
  if (/장부|먹은 단서|진화/.test(source)) {
    return pick(SOUL_HINT_POOLS.creature, seed, 17);
  }
  if (source.length <= 38 && !/[A-Za-z]{5,}/.test(source)) {
    return source.endsWith("다") ? `${source}.` : `${source}다.`;
  }
  return pick(SOUL_HINT_POOLS.default, seed, 19);
}

function pickModeStamp(mode: string, seed: number, lead: string, attitude: string): string {
  const pool = MODE_STAMP_BY_MODE[mode];
  if (!pool?.length) return "";
  const first = pick(pool, seed, 31);
  if (!hasSimilarCadence(first, lead) && !hasSimilarCadence(first, attitude)) return first;
  return pick(pool, seed + 1, 31);
}

function buildSceneLine(
  input: KoIdentityWriterInput,
  focus: WriterFocus,
  seed: number,
  primaryAnchor: string,
  secondaryAnchor: string
): string {
  const scene = summarizeHeadline(input.headline);
  const needsAnchorFallback =
    !scene ||
    /(는지|인지|일지|될지|붙는지|남는지|갈리는지|버티는지|무너지는지|먼저)$/.test(scene);
  const sceneCore = needsAnchorFallback
    ? fill(pick(ANCHOR_SCENE_BY_LANE[input.lane], seed, 29), primaryAnchor, secondaryAnchor)
    : scene;
  if (!needsAnchorFallback && sceneCore.length <= 42 && !/(사실|문제|신호|장면|지점|거리|온도 차|시차|틈|엇갈림|균열)$/.test(sceneCore)) {
    return sceneCore;
  }
  const quoted = `${sceneCore}${hasBatchim(sceneCore) ? "이라는" : "라는"}`;
  const focusPool = FOCUS_SCENE_OPENERS_BY_LANE[input.lane]?.[focus] || [];
  return pick([...focusPool, ...SCENE_OPENERS], seed, 23).replaceAll("{Q}", quoted);
}

function buildQuestion(input: KoIdentityWriterInput, seed: number): string {
  const raw = sanitizeTweetText(input.interactionMission || input.activeQuestion || "").trim();
  if (raw) {
    const compact = raw.length > 68 ? `${raw.slice(0, 64).trim()}...` : raw;
    return normalizeQuestionTail(compact, "ko");
  }
  const lanePool = QUESTION_BY_LANE[input.lane];
  if (lanePool?.length) {
    return pick(lanePool, seed, 13);
  }
  return pick(QUESTION_FALLBACKS, seed, 17);
}

function joinCandidate(lines: string[], maxChars: number): string {
  return finalizeGeneratedText(lines.filter(Boolean).join(" "), "ko", maxChars);
}

function materializeLayout(layout: WriterSegment[], segments: Record<WriterSegment, string>, maxChars: number): string[] {
  const lines: string[] = [];
  for (const key of layout) {
    const candidate = sanitizeClause(segments[key] || "");
    if (!candidate) continue;
    const previous = lines[lines.length - 1] || "";
    if (previous && (previous === candidate || hasSimilarCadence(previous, candidate))) continue;
    lines.push(candidate.endsWith("?") ? candidate : `${candidate}.`);
    if (joinCandidate(lines, maxChars).length > maxChars) {
      lines.pop();
      break;
    }
  }
  return lines;
}

function rotateLayouts(layouts: WriterSegment[][], seed: number): WriterSegment[][] {
  const offset = seed % layouts.length;
  return [...layouts.slice(offset), ...layouts.slice(0, offset)];
}

function buildFrameLayouts(frame: KoWriterFrame, mode: string): WriterSegment[][] {
  if (frame === "quest") {
    return [
      ["scene", "stamp", "attitude", "question"],
      ["lead", "fixation", "decision", "question"],
      ["scene", "instinct", "decision", "question"],
      ["fixation", "evidence", "question"],
    ];
  }

  if (mode === "meta-reflection") {
    return frame === "cross-exam"
      ? [
          ["attitude", "stamp", "evidence", "consequence"],
          ["scene", "attitude", "evidence", "consequence"],
          ["lead", "fixation", "decision", "consequence"],
          ["scene", "stamp", "fixation", "decision"],
        ]
      : [
          ["scene", "attitude", "evidence", "decision"],
          ["lead", "stamp", "fixation", "consequence"],
          ["attitude", "evidence", "fixation", "decision"],
        ];
  }

  if (mode === "philosophy-note") {
    return [
      ["lead", "stamp", "evidence", "decision"],
      ["scene", "fixation", "evidence", "consequence"],
      ["attitude", "instinct", "evidence", "decision"],
      ["lead", "evidence", "stamp", "consequence"],
    ];
  }

  if (mode === "identity-journal") {
    return frame === "field-note"
      ? [
          ["scene", "instinct", "evidence", "decision"],
          ["lead", "stamp", "attitude", "consequence"],
          ["scene", "fixation", "evidence", "decision"],
          ["lead", "instinct", "evidence", "consequence"],
        ]
      : [
          ["scene", "attitude", "evidence", "decision"],
          ["lead", "instinct", "evidence", "consequence"],
          ["scene", "stamp", "fixation", "consequence"],
          ["attitude", "evidence", "instinct", "decision"],
        ];
  }

  return [
    ["scene", "evidence", "decision", "consequence"],
    ["lead", "stamp", "evidence", "decision"],
    ["lead", "instinct", "evidence", "consequence"],
    ["fixation", "evidence", "decision", "consequence"],
  ];
}

export function buildKoIdentityWriterCandidate(input: KoIdentityWriterInput, variant = 0): string {
  const seed = stableSeedForPrelude(
    `${input.seedHint || input.headline}|${input.primaryAnchor}|${input.secondaryAnchor}|${input.mode}|${input.lane}|${variant}`
  );
  const primaryAnchor = summarizeAnchor(input.primaryAnchor);
  const secondaryAnchor = summarizeAnchor(input.secondaryAnchor);
  const focus = resolveWriterFocus(input, primaryAnchor, secondaryAnchor);
  const frame = resolveWriterFrame(input.mode, focus, seed + variant);
  const focusLeadPool = FOCUS_CLAIM_BY_LANE[input.lane]?.[focus] || [];
  const leadPool =
    frame === "cross-exam"
      ? CROSS_EXAM_BY_LANE[input.lane]
      : frame === "field-note"
        ? [...focusLeadPool, ...FIELD_NOTES_BY_LANE[input.lane]]
        : [...focusLeadPool, ...CLAIM_BY_LANE[input.lane]];
  const lead = pick(leadPool, seed, variant);
  const scene = buildSceneLine(input, focus, seed + variant, primaryAnchor, secondaryAnchor);
  const focusEvidencePool = FOCUS_EVIDENCE_BY_LANE[input.lane]?.[focus] || [];
  const evidence = fill(pick([...focusEvidencePool, ...EVIDENCE_BY_LANE[input.lane]], seed, variant + 3), primaryAnchor, secondaryAnchor);
  const instinct = rewriteSoulHint(input, focus, seed + 17);
  const attitude = pickAttitudeLine(input.lane, focus, seed + variant, lead);
  const fixation = pickFixationLine(input.lane, focus, seed + variant, lead, attitude);
  const stamp = pickModeStamp(input.mode, seed + variant, lead, attitude);
  const focusDecisionPool = FOCUS_DECISION_BY_LANE[input.lane]?.[focus] || [];
  const decision = pick([...focusDecisionPool, ...DECISION_BY_LANE[input.lane]], seed, variant + 5);
  const consequence = pick(CONSEQUENCE_BY_LANE[input.lane], seed, variant + 9);
  const question = buildQuestion(input, seed + 19);
  const segments: Record<WriterSegment, string> = {
    scene,
    lead,
    stamp,
    evidence,
    instinct,
    attitude,
    fixation,
    decision,
    consequence,
    question,
  };

  const layouts = rotateLayouts(buildFrameLayouts(frame, input.mode), seed + variant);
  let candidate = "";
  for (const layout of layouts) {
    const lines = materializeLayout(layout, segments, input.maxChars);
    if (!lines.length) continue;
    const draft = joinCandidate(lines, input.maxChars);
    if (draft) {
      candidate = draft;
      break;
    }
  }
  if (!candidate) {
    const fallbackLines = materializeLayout(["lead", "evidence", "decision", frame === "quest" ? "question" : "consequence"], segments, input.maxChars);
    candidate = joinCandidate(fallbackLines, input.maxChars);
  }

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
