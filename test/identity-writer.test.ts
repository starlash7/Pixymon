import test from "node:test";
import assert from "node:assert/strict";
import { buildKoIdentityWriterCandidate } from "../src/services/engagement/identity-writer.ts";

const baseInput = {
  headline: "규제 해석과 현장 움직임 사이에 틈이 나는지 살핀다",
  primaryAnchor: "체인 안쪽 사용",
  secondaryAnchor: "규제 쪽 일정",
  lane: "regulation" as const,
  mode: "identity-journal",
  worldviewHint: "신뢰는 선언보다 반복 가능한 복구에서 쌓인다",
  signatureBelief: "강한 주장보다 검증 가능한 가설을 우선한다",
  recentReflection: "좋아 보이는 설명보다 오래 버티는 근거 하나가 낫다",
  maxChars: 280,
};

test("buildKoIdentityWriterCandidate writes direct korean prose without raw fragment boilerplate", () => {
  const text = buildKoIdentityWriterCandidate({
    ...baseInput,
    seedHint: "identity-writer:direct",
  });

  assert.match(text, /(집행|행동|믿는다|결론|흔적|근거)/);
  assert.doesNotMatch(text, /sat\/vB|Bitcoin sold off first|시간차부터 잰다|호가창 바깥/);
  assert.doesNotMatch(text, /오늘 주워 온 건|입에 넣기엔 아직 거친 장면|장부에|먹은 단서|다음 판단 재료|얘기가 자꾸 돌아온다|값이 빠진다/);
});

test("buildKoIdentityWriterCandidate can end with a concrete audience question in interaction mode", () => {
  const text = buildKoIdentityWriterCandidate({
    ...baseInput,
    mode: "interaction-experiment",
    interactionMission: "너라면 여기서 어떤 근거를 먼저 지워 보겠나",
    seedHint: "identity-writer:question",
  });

  assert.match(text, /\?$/);
  assert.match(text, /너라면|어떤 근거/);
});

test("buildKoIdentityWriterCandidate keeps market-structure prose thesis-driven", () => {
  const text = buildKoIdentityWriterCandidate({
    ...baseInput,
    lane: "market-structure",
    mode: "meta-reflection",
    primaryAnchor: "큰 주문 소화",
    secondaryAnchor: "거래소 반응 속도",
    seedHint: "identity-writer:market-structure",
  });

  assert.match(text, /(주문|체결|거래소)/);
  assert.match(text, /(오래 남는 흔적|끝까지 남는 근거|쉽게 삼켜지는 설명|늦게 틀리는 편|믿지 않는다|화면 반응보다 오래 보는 건 결국 체결이다|겉이 맞아 보여도 밑단이 비면 금방 티가 난다|자금이 안 남은 자신감은 오래 못 간다|결국 오래 보는 건 호가가 아니라 체결 잔상이다|대충 맞은 설명일수록 현장에선 빨리 들통난다|결국 빈칸은 늘 제일 늦게 붙(?:는|은) 자리에서 커진다|돈이 붙은 자리는 화면보다 늦게 보이고 그래서 더 정확하다|해설이 멀쩡해 보여도 끝내 비는 자리가 이 장면의 값을 깎는다)/);
  assert.doesNotMatch(text, /장부에|먹은 단서|다음 판단 재료|다시 읽는다/);
  assert.doesNotMatch(text, /차트보다 실제 체결이 남아야 판단할 수 있다\.\s+차트보다 실제 체결이 남아야 판단할 수 있다/);
});

test("buildKoIdentityWriterCandidate rewrites clause-like anchors into natural noun phrases", () => {
  const text = buildKoIdentityWriterCandidate({
    ...baseInput,
    lane: "ecosystem",
    mode: "interaction-experiment",
    primaryAnchor: "체인 안쪽 사용",
    secondaryAnchor: "실제 사용자가 다시 돌아오는지",
    seedHint: "identity-writer:ecosystem-anchor",
  });

  assert.match(text, /(재방문 흐름|돌아오는 사람이|남는 사람 수|사용이 남는지)/);
  assert.doesNotMatch(text, /는지가 남는지|가까가|돌아오는지가/);
});


test("buildKoIdentityWriterCandidate uses evaluative voice instead of checklist verbs in ecosystem mode", () => {
  const text = buildKoIdentityWriterCandidate({
    ...baseInput,
    lane: "ecosystem",
    mode: "identity-journal",
    primaryAnchor: "체인 안쪽 사용",
    secondaryAnchor: "실제 사용자가 다시 돌아오는지",
    seedHint: "identity-writer:ecosystem-evaluative",
  });

  assert.match(text, /(홍보 문구|광고 냄새|과열이지 성장은 아니다|좋은 포스터여도 오래 못 간다|절반짜리다|사람을 못 붙잡|오래 못 간다|힘을 잃는다|사람이 남는지 못 남는지|생태계 서사에 쉽게 속는다|잔류가 비는 순간 그 열기는 오래 못 버틴다|재방문이 빠진 열기는 대개 캠페인으로 끝난다|남는 사람이 사라지는 순간 그 생태계 얘기도 절반이 날아간다)/);
  assert.doesNotMatch(text, /먼저 본다\.\s*확인한다\.\s*미룬다/);
});

test("buildKoIdentityWriterCandidate splits ecosystem voice by retention versus hype focus", () => {
  const retention = buildKoIdentityWriterCandidate({
    ...baseInput,
    lane: "ecosystem",
    mode: "identity-journal",
    headline: "사람들이 실제로 머무는 체인과 밖에서 도는 서사가 맞물리는지 살핀다",
    primaryAnchor: "체인 안쪽 사용",
    secondaryAnchor: "재방문 흐름",
    seedHint: "identity-writer:ecosystem-retention",
  });

  const hype = buildKoIdentityWriterCandidate({
    ...baseInput,
    lane: "ecosystem",
    mode: "identity-journal",
    headline: "서사만 커지고 실제 사용은 비는 날이 아닌지 살핀다",
    primaryAnchor: "커뮤니티 열기",
    secondaryAnchor: "체인 안쪽 사용",
    seedHint: "identity-writer:ecosystem-hype",
  });

  assert.notEqual(retention.split(".")[0]?.trim(), hype.split(".")[0]?.trim());
  assert.notEqual(retention.split(".")[1]?.trim(), hype.split(".")[1]?.trim());
  assert.match(retention, /(재방문|잔류|사람이 남|사용자|돌아오는 사람)/);
  assert.match(hype, /(홍보|광고|서사|캠페인)/);
});

test("buildKoIdentityWriterCandidate repairs trailing 먼저 headline into direct regulation prose", () => {
  const text = buildKoIdentityWriterCandidate({
    ...baseInput,
    lane: "regulation",
    mode: "meta-reflection",
    headline: "정책 문장보다 실제 반응이 어디서 갈라지는지 먼저 본다",
    primaryAnchor: "규제 반응",
    secondaryAnchor: "대기 자금 흐름",
    worldviewHint: "정책 문장보다 집행 흔적이 더 늦고 정확하다",
    signatureBelief: "기사보다 행동 편에 더 오래 남는다",
    recentReflection: "행동이 따라오지 않는 순간 해설은 금방 얇아진다",
    seedHint: "identity-writer:regulation-direct",
  });

  assert.doesNotMatch(text, /먼저\.\s*$/);
  assert.doesNotMatch(text, /기사보다 집행 흔적을 먼저 본다|실제 행동은 더 늦게 확인한다/);
  assert.match(text, /(기사|집행|행동|현장)/);
});

test("buildKoIdentityWriterCandidate gives market-structure liquidity focus a money-first ending", () => {
  const text = buildKoIdentityWriterCandidate({
    ...baseInput,
    lane: "market-structure",
    mode: "philosophy-note",
    headline: "호가보다 체결이 늦게 진실을 말하는 날인지 본다",
    primaryAnchor: "큰 주문 소화",
    secondaryAnchor: "자금 쏠림 방향",
    worldviewHint: "화면 열기보다 실제 체결이 더 늦고 정확하다",
    signatureBelief: "돈이 안 붙은 자신감은 제일 먼저 버린다",
    recentReflection: "좋은 해설보다 오래 남는 흔적 하나가 훨씬 정확하다",
    seedHint: "identity-writer:liquidity-ending",
  });

  assert.match(text, /(돈|체결|연출|화면값|장면)/);
});

test("buildKoIdentityWriterCandidate varies layout and cadence across variants", () => {
  const variants = new Set(
    Array.from({ length: 4 }, (_, variant) =>
      buildKoIdentityWriterCandidate({
        ...baseInput,
        lane: "market-structure",
        mode: "identity-journal",
        primaryAnchor: "큰 주문 소화",
        secondaryAnchor: "돈이 어디로 몰리는지",
        seedHint: "identity-writer:variation",
      }, variant)
    )
  );

  assert.ok(variants.size >= 3);
});

test("buildKoIdentityWriterCandidate diversifies second-sentence families across variants", () => {
  const secondSentences = new Set(
    Array.from({ length: 4 }, (_, variant) => {
      const text = buildKoIdentityWriterCandidate(
        {
          ...baseInput,
          lane: "ecosystem",
          mode: "identity-journal",
          headline: "서사만 커지고 실제 사용은 비는 날이 아닌지 살핀다",
          primaryAnchor: "커뮤니티 열기",
          secondaryAnchor: "체인 안쪽 사용",
          seedHint: "identity-writer:second-sentence-diversity",
        },
        variant
      );
      return (text.split(/(?<=[.!?])\s+/u)[1] || "").trim();
    }).filter(Boolean)
  );

  assert.ok(secondSentences.size >= 3);
});

test("buildKoIdentityWriterCandidate avoids onchain second-sentence collapse across variants", () => {
  const secondSentences = new Set(
    Array.from({ length: 4 }, (_, variant) => {
      const text = buildKoIdentityWriterCandidate(
        {
          ...baseInput,
          lane: "onchain",
          mode: "meta-reflection",
          headline: "튀는 숫자와 오래 버티는 흔적이 같은 편인지 본다",
          primaryAnchor: "주소 이동",
          secondaryAnchor: "대기 자금 흐름",
          seedHint: "identity-writer:onchain-second-sentence",
        },
        variant
      );
      return (text.split(/(?<=[.!?])\s+/u)[1] || "").trim();
    }).filter(Boolean)
  );

  assert.ok(secondSentences.size >= 3);
});

test("buildKoIdentityWriterCandidate uses lane-aware question prompts", () => {
  const text = buildKoIdentityWriterCandidate({
    ...baseInput,
    lane: "protocol",
    mode: "interaction-experiment",
    primaryAnchor: "검증자 안정성",
    secondaryAnchor: "복구 시간 분포",
    seedHint: "identity-writer:protocol-question",
  });

  assert.match(text, /\?$/);
  assert.match(text, /(로그|운영 흔적|약속)/);
  assert.doesNotMatch(text, /어떤 근거를 먼저 버리겠나/);
});

test("buildKoIdentityWriterCandidate can surface lane fixation instead of generic instinct", () => {
  const text = buildKoIdentityWriterCandidate({
    ...baseInput,
    lane: "market-structure",
    mode: "meta-reflection",
    primaryAnchor: "큰 주문 소화",
    secondaryAnchor: "돈이 어디로 몰리는지",
    seedHint: "identity-writer:fixation",
  }, 2);

  assert.match(text, /(체결|돈이 안 붙은 자신감|화면 열기보다 오래 보는 건 결국 체결|돈이 남는지 여부가 이 과열의 본색을 가른다)/);
});

test("buildKoIdentityWriterCandidate surfaces mode-specific stamp in philosophy mode", () => {
  const text = buildKoIdentityWriterCandidate({
    ...baseInput,
    lane: "protocol",
    mode: "philosophy-note",
    primaryAnchor: "검증자 안정성",
    secondaryAnchor: "복구 시간 분포",
    seedHint: "identity-writer:mode-stamp",
  }, 0);

  assert.match(text, /(신뢰는 결국 배포 문장이 아니라 장애 뒤 태도로 정산된다|업그레이드의 값은 발표 속도가 아니라 복구 기록이 다시 매긴다|박수보다 오래 남는 건 결국 복구 로그 쪽이다|복구 기록이 비면 좋은 업그레이드 문장도 금방 종이처럼 얇아진다|결국 배포 공지보다 오래 남는 건 장애 뒤의 운영 태도다|결국 남은 건 발표가 아니라 장애 뒤 복구 기록 쪽이다|신뢰는 배포 공지보다 복구 기록에서 더 느리게 쌓인다|업그레이드는 박수보다 장애 뒤의 태도로 평가된다|운영이 비면 좋은 릴리스 노트도 금방 종이처럼 얇아진다|설명보다 오래 가는 건 결국 복구 속도다|장애 뒤 태도가 비는 업그레이드는 박수부터 의심한다|길게 보면|오래 남는 건 해설보다 반복되는 습관|오래 남은 건 해설보다 반복되는 습관|결국 구조는 화려한 설명보다 느린 반복)/);
});

test("buildKoIdentityWriterCandidate avoids stale ledger/value-drop phrasing in onchain mode", () => {
  const text = buildKoIdentityWriterCandidate({
    ...baseInput,
    lane: "onchain",
    mode: "meta-reflection",
    headline: "튀는 숫자와 오래 남는 흔적이 같은 편인지 본다",
    primaryAnchor: "낮아진 체인 사용 압박",
    secondaryAnchor: "관망 자금 이탈",
    seedHint: "identity-writer:no-stale-phrases",
  }, 3);

  assert.doesNotMatch(text, /장부에|값이 빠진다|얘기가 자꾸 돌아온다/);
});

test("buildKoIdentityWriterCandidate honors preferred focus when planner already chose builder", () => {
  const text = buildKoIdentityWriterCandidate({
    ...baseInput,
    lane: "ecosystem",
    mode: "identity-journal",
    headline: "업그레이드 뒤 실제 움직임이 이어지는지 본다",
    primaryAnchor: "사용으로 남은 흔적",
    secondaryAnchor: "업그레이드 뒤 실제 움직임",
    preferredFocus: "builder",
    seedHint: "identity-writer:preferred-builder",
  }, 1);

  assert.match(text, /(개발자|빌드|코드|자금 복귀|예치 자금|빌더)/);
  assert.doesNotMatch(text, /광고 냄새|홍보 문구|과열이지 성장은 아니다/);
});
