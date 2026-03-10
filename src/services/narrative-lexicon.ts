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
];

const KO_SUSPICIOUS_PATTERNS: NarrativePatternRule[] = [
  { label: "awkward-anchor-suffix", pattern: /(?:는지|모습|원칙|체계|과정|변동성|규칙|서사|변화|속도|로그|문서)\s+쪽(?:부터|을|이|만)/g },
  { label: "templated-closing", pattern: /(?:끝까지\s*(?:남는|버틴)\s*(?:근거|단서)|(?:끝까지|마지막까지).{0,18}(?:근거|단서).{0,12}(?:버티|메모|적))/g },
  { label: "staged-screen-metaphor", pattern: /이 둘을 같은 화면에 둔다/g },
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
      .replace(/모습를/g, "모습을")
      .replace(/모습가/g, "모습이")
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
