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
  assert.doesNotMatch(text, /오늘 주워 온 건|입에 넣기엔 아직 거친 장면|장부에|먹은 단서|다음 판단 재료/);
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
  assert.match(text, /(오래 남는 흔적|끝까지 남는 근거|쉽게 삼켜지는 설명|늦게 틀리는 편|믿지 않는다|화면 반응보다 오래 보는 건 결국 체결이다|겉이 맞아 보여도 밑단이 비면 금방 티가 난다)/);
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

  assert.match(text, /재방문 흐름/);
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

  assert.match(text, /(홍보 문구|광고 냄새|과열이지 성장은 아니다|좋은 포스터여도 오래 못 간다|절반짜리다)/);
  assert.doesNotMatch(text, /먼저 본다\.\s*확인한다\.\s*미룬다/);
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

  assert.match(text, /(체결|돈이 안 붙은 자신감|화면 열기보다 오래 보는 건 결국 체결)/);
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

  assert.match(text, /(길게 보면|오래 남는 건 해설보다 반복되는 습관|오래 남은 건 해설보다 반복되는 습관|결국 구조는 화려한 설명보다 느린 반복)/);
});
