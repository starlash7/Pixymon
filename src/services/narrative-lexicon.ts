import { sanitizeTweetText } from "./engagement/quality.js";

export interface NarrativeFlagHit {
  label: string;
  match: string;
  replacement?: string;
  kind: "rewrite-source" | "suspicious-pattern";
}

interface NarrativeRewriteRule {
  label: string;
  pattern: RegExp;
  replacement: string;
}

interface NarrativePatternRule {
  label: string;
  pattern: RegExp;
}

const KO_NARRATIVE_REWRITE_RULES: NarrativeRewriteRule[] = [
  { label: "wallet-cluster", pattern: /지갑 군집 변화/g, replacement: "비슷한 지갑이 한쪽으로 몰리는 모습" },
  { label: "validator-retention", pattern: /검증자 참여율 변화/g, replacement: "검증자가 얼마나 남아 있는지" },
  { label: "capital-destination", pattern: /거래 목적지 집중도/g, replacement: "자금이 어느 쪽으로 몰리는지" },
  { label: "client-concentration", pattern: /클라이언트 다양성/g, replacement: "구현체가 한쪽에만 쏠리는지" },
  { label: "risk-asset-sensitivity", pattern: /리스크 자산 민감도/g, replacement: "위험자산 반응이 얼마나 예민한지" },
  { label: "risk-appetite-shift", pattern: /리스크 선호 전환 신호/g, replacement: "사람들이 다시 위험을 감수하려는지" },
  { label: "hedge-positioning", pattern: /헤지 포지셔닝 변화/g, replacement: "방어 포지션이 얼마나 풀리는지" },
  { label: "validator-consensus", pattern: /검증자 합의 안정성/g, replacement: "검증자 합의가 얼마나 안정적인지" },
  { label: "recovery-distribution", pattern: /복구 시간 분포/g, replacement: "장애 뒤 얼마나 빨리 복구되는지" },
  { label: "risk-disclosure", pattern: /리스크 공개 원칙/g, replacement: "위험을 얼마나 솔직히 드러내는지" },
  { label: "transparency-reporting", pattern: /투명성 보고 체계/g, replacement: "얼마나 투명하게 설명하는지" },
  { label: "exchange-response-speed", pattern: /거래소 대응 속도/g, replacement: "거래소가 얼마나 빨리 반응하는지" },
  { label: "transaction-audit-log", pattern: /트랜잭션 감사 로그/g, replacement: "거래 기록이 얼마나 투명하게 남는지" },
  { label: "execution-failure-pattern", pattern: /체결 실패 패턴/g, replacement: "주문이 어디서 자꾸 미끄러지는지" },
  { label: "slippage-zone", pattern: /슬리피지 민감 구간/g, replacement: "주문 충격에 약한 구간" },
  { label: "spread-stability", pattern: /호가 간격 안정성/g, replacement: "호가 간격이 얼마나 안정적인지" },
  { label: "block-execution-quality", pattern: /대량 주문 체결 품질/g, replacement: "큰 주문이 얼마나 깔끔하게 소화되는지" },
  { label: "whale-netflow", pattern: /대형 주소 순이동/g, replacement: "큰손 자금이 어디로 움직이는지" },
  { label: "depth-recovery", pattern: /호가 깊이 회복 속도/g, replacement: "유동성이 얼마나 빨리 돌아오는지" },
  { label: "jurisdiction-mapping", pattern: /관할별 요구사항 매핑/g, replacement: "규제가 어디서 갈리는지" },
  { label: "cohort-retention", pattern: /커뮤니티 코호트 유지율/g, replacement: "들어온 사람들이 얼마나 남는지" },
  { label: "whale-footprints", pattern: /큰손의 발자국/g, replacement: "큰손 움직임" },
  { label: "cash-scent", pattern: /대기하던 현금의 냄새/g, replacement: "대기 자금 흐름" },
  { label: "heated-face", pattern: /먼저 달아오른 표정/g, replacement: "먼저 뜨거워진 시장 반응" },
  { label: "protocol-body-language", pattern: /업그레이드 뒤의 몸짓/g, replacement: "업그레이드 뒤 실제 움직임" },
  { label: "outside-ripple", pattern: /바깥 뉴스의 파문/g, replacement: "외부 뉴스 반응" },
  { label: "real-use-warmth", pattern: /실사용의 온기/g, replacement: "실사용 흐름" },
  { label: "regulatory-shadow", pattern: /규제 문장의 그림자/g, replacement: "규제 반응" },
  { label: "chain-quiet", pattern: /체인 안쪽의 조용함/g, replacement: "체인 수수료" },
  { label: "backlog-shadow", pattern: /밀린 거래의 그림자/g, replacement: "밀린 거래량" },
  { label: "inside-smell", pattern: /체인 안쪽 냄새/g, replacement: "체인 안쪽 흐름" },
  { label: "footprints", pattern: /발자국/g, replacement: "움직임" },
  { label: "body-language", pattern: /몸짓/g, replacement: "실제 반응" },
  { label: "facial-expression", pattern: /표정/g, replacement: "반응" },
  { label: "hand-movement", pattern: /손놀림/g, replacement: "움직임" },
  { label: "ripple", pattern: /파문/g, replacement: "반응" },
  { label: "shadow", pattern: /그림자/g, replacement: "흐름" },
  { label: "warmth", pattern: /온기/g, replacement: "흐름" },
  { label: "life-feel", pattern: /생활감/g, replacement: "실사용" },
  { label: "same-screen-attach", pattern: /같은 화면에 붙여 둔다/g, replacement: "나란히 놓고 본다" },
  { label: "same-screen", pattern: /같은 화면에 둔다/g, replacement: "나란히 놓고 본다" },
  { label: "same-screen-place", pattern: /같은 화면에 붙여 놓는다/g, replacement: "나란히 놓고 본다" },
  { label: "timing-gap", pattern: /시간차부터 잰다/g, replacement: "어느 쪽이 먼저 움직이는지 본다" },
  { label: "timing-gap-pair", pattern: /이 둘의 시간차부터 잰다/g, replacement: "이 둘 중 뭐가 먼저 움직이는지 본다" },
  { label: "price-narrative", pattern: /가격 서사/g, replacement: "가격 분위기" },
  { label: "rough-scene", pattern: /입에 넣기엔 아직 거친 장면이다/g, replacement: "아직 바로 믿기엔 이른 장면이다" },
  {
    label: "outside-orderbook-full",
    pattern: /호가창 바깥에서 먼저 새는 신호가 있는지 짚는다/g,
    replacement: "화면 분위기보다 실제 돈이 먼저 붙는지 살핀다",
  },
  { label: "outside-orderbook", pattern: /호가창 바깥/g, replacement: "화면 밖" },
  {
    label: "orderbook-wobble",
    pattern: /호가만 흔들리고 실제 흐름이 안 따라오면 여기서 멈춘다/g,
    replacement: "화면만 흔들리고 실제 돈이 안 붙으면 여기서 멈춘다",
  },
  { label: "actual-flow", pattern: /실제 흐름/g, replacement: "실제 움직임" },
  { label: "fee-raw", pattern: /체인 수수료/g, replacement: "체인 사용" },
  { label: "btc-fee-raw", pattern: /BTC\s*(?:네트워크\s*)?수수료\s*\d+(?:[.,]\d+)?\s*sat\/vB/gi, replacement: "BTC 체인 사용" },
  { label: "btc-chain-satvb", pattern: /BTC\s*체인(?:은|이)?\s*\d+(?:[.,]\d+)?\s*sat\/vB(?:로)?\s*(?:조용하다|한산하다)?/gi, replacement: "BTC 체인이 아직 조용하다" },
  { label: "generic-satvb", pattern: /\b\d+(?:[.,]\d+)?\s*sat\/vB\b/gi, replacement: "낮은 체인 사용" },
  { label: "reaction-overheat", pattern: /가격 분위기 과열 가능성/g, replacement: "먼저 달아오른 가격 분위기" },
  { label: "carry-over", pattern: /버틴 쪽만 소화된 신호로 남긴다/g, replacement: "오래 남는 쪽만 오늘 단서로 남긴다" },
  { label: "bookkeeping", pattern: /내 장부에 올린다/g, replacement: "오늘 단서로 남긴다" },
  { label: "bookkeeping-early", pattern: /내 장부에 올리기 이르다/g, replacement: "아직 바로 믿기엔 이르다" },
  { label: "real-orderbook", pattern: /화면보다 실제 주문을 더 믿는다/g, replacement: "차트보다 실제 돈이 붙는 쪽을 더 믿는다" },
  { label: "digested-signal", pattern: /붙은 쪽만 소화된 신호로 남긴다/g, replacement: "끝까지 남는 쪽만 오늘 단서로 남긴다" },
  { label: "doubt-opener", pattern: /내가 먼저 의심하는 건/g, replacement: "먼저 걸리는 건" },
  {
    label: "lead-opener-collision",
    pattern: /(?:정책 반응을 따라가 보면|시장에선|실제 돈이 붙는 쪽에선|프로토콜 쪽에선|생태계 쪽에선|온체인에선|체인 안쪽에선)\s+(오늘은 이 장면부터 적어 둔다|오늘 메모의 출발점은|이 장면부터 먼저 남겨 둔다)/g,
    replacement: "$1",
  },
  {
    label: "raw-network-tail",
    pattern: /(?:이번엔|지금은)\s+BTC\s*네트워크\.?$/g,
    replacement: "이번엔 체인 안쪽 반응부터 다시 본다",
  },
];

const KO_SUSPICIOUS_PATTERNS: NarrativePatternRule[] = [
  { label: "awkward-anchor-suffix", pattern: /(?:는지|모습|원칙|체계|과정|변동성|규칙|서사|변화|속도|로그|문서)\s+쪽(?:부터|을|이|만)/g },
  { label: "templated-closing", pattern: /(?:끝까지\s*(?:남는|버틴)\s*(?:근거|단서)|(?:끝까지|마지막까지).{0,18}(?:근거|단서).{0,12}(?:버티|메모|적))/g },
  { label: "staged-screen-metaphor", pattern: /이 둘을 같은 화면에 둔다/g },
  { label: "timing-gap-boilerplate", pattern: /(?:이\s*둘의\s*)?시간차부터\s*잰다/g },
  { label: "wobble-stop-closing", pattern: /호가만\s*흔들리고\s*실제\s*(?:흐름|움직임)이\s*안\s*따라오면\s*여기서\s*멈춘다/g },
];

export function applyKoNarrativeLexicon(text: string): string {
  const normalized = sanitizeTweetText(text);
  if (!normalized) return normalized;

  let output = normalized;
  for (const rule of KO_NARRATIVE_REWRITE_RULES) {
    output = output.replace(rule.pattern, rule.replacement);
  }
  return sanitizeTweetText(
    output
      .replace(/빈\s*반응다/g, "빈 반응이다")
      .replace(/체결\s*없은/g, "체결 없는")
      .replace(/반응보다\s*잔류가/g, "열기보다 잔류가")
      .replace(/사용와/g, "사용과")
      .replace(/사용를/g, "사용을")
      .replace(/사용가/g, "사용이")
      .replace(/모습를/g, "모습을")
      .replace(/모습가/g, "모습이")
      .replace(/흐름를/g, "흐름을")
      .replace(/흐름가/g, "흐름이")
      .replace(/움직임를/g, "움직임을")
      .replace(/움직임가/g, "움직임이")
  );
}

export function detectNarrativeFlagHits(text: string, language: "ko" | "en"): NarrativeFlagHit[] {
  const normalized = sanitizeTweetText(text);
  if (!normalized || language !== "ko") {
    return [];
  }

  const hits: NarrativeFlagHit[] = [];

  for (const rule of KO_NARRATIVE_REWRITE_RULES) {
    const matches = normalized.match(rule.pattern) || [];
    matches.forEach((match) => {
      hits.push({
        label: rule.label,
        match,
        replacement: rule.replacement,
        kind: "rewrite-source",
      });
    });
  }

  for (const rule of KO_SUSPICIOUS_PATTERNS) {
    const matches = normalized.match(rule.pattern) || [];
    matches.forEach((match) => {
      hits.push({
        label: rule.label,
        match,
        kind: "suspicious-pattern",
      });
    });
  }

  return hits;
}
