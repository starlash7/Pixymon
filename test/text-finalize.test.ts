import test from "node:test";
import assert from "node:assert/strict";
import {
  applyNarrativeLayout,
  finalizeGeneratedText,
  normalizeQuestionTail,
  truncateAtWordBoundary,
} from "../src/services/engagement/text-finalize.ts";

test("normalizeQuestionTail appends question mark when missing", () => {
  assert.equal(normalizeQuestionTail("이 가설의 반증은 어디서 보나", "ko"), "이 가설의 반증은 어디서 보나?");
  assert.equal(normalizeQuestionTail("Already done.", "en"), "Already done.");
});

test("truncateAtWordBoundary avoids cutting too early", () => {
  const text = "픽시몬은 근거를 먼저 먹고 소화한 뒤에만 진화 방향을 고른다.";
  const truncated = truncateAtWordBoundary(text, 22);
  assert.ok(truncated.length <= 22);
  assert.ok(!truncated.endsWith(" "));
});

test("finalizeGeneratedText removes repeated lane lead and dangling tail", () => {
  const input =
    "시장구조 관점에서 얕은 호가는 공포보다 실행 전략의 문제를 먼저 보여준다. 시장구조 관점에서 얕은 호가는 공포보다 실행 전략의 문제를 먼저 보여준다. 근거는";
  const output = finalizeGeneratedText(input, "ko", 220);
  assert.equal(
    output,
    "시장구조 관점에서 얕은 호가는 공포보다 실행 전략의 문제를 먼저 보여준다."
  );
});

test("finalizeGeneratedText drops truncated evidence list without predicate", () => {
  const input =
    "좋은 해석은 세게 말하는 데서 나오지 않는다. 근거는 자금 이동 서사, 클라이언트 다양성";
  const output = finalizeGeneratedText(input, "ko", 220);
  assert.equal(output, "좋은 해석은 세게 말하는 데서 나오지 않는다.");
});

test("applyNarrativeLayout inserts breathable blank lines for multi-sentence korean text", () => {
  const input =
    "오늘 계속 걸리는 건 규제 문장이 짧아도 행동의 지연 시간은 길다는 점이다. 먼저 거래소 대응 속도를 다시 본다. 이 조건이 깨지면 해석을 접는다.";
  const output = applyNarrativeLayout(input, "ko", 220);
  assert.match(output, /\n\n|\n/);
  assert.ok(output.includes("먼저 거래소 대응 속도를 다시 본다."));
});

test("finalizeGeneratedText removes incomplete middle sentence fragments", () => {
  const input =
    "좋은 해석은 세게 말하는 데서 나오지 않는다. 급히 삼키면 말도. 지금은 거래소 대응 속도 쪽부터 다시 확인한다.";
  const output = finalizeGeneratedText(input, "ko", 220);
  assert.equal(output, "좋은 해석은 세게 말하는 데서 나오지 않는다. 지금은 거래소 대응 속도 쪽부터 다시 확인한다.");
});

test("finalizeGeneratedText softens explicit pixymon self-reference in korean", () => {
  const input =
    "픽시몬은 신호를 바로 믿지 않는다. 픽시몬의 메모는 오래 버티는 근거만 남긴다.";
  const output = finalizeGeneratedText(input, "ko", 220);
  assert.equal(output, "나는 신호를 바로 믿지 않는다. 내 메모는 오래 버티는 근거만 남긴다.");
});

test("finalizeGeneratedText corrects broken korean particles in generated fallback text", () => {
  const input =
    "정책 문장는 짧게 지나가도 시장 행동의 지연 시간는 생각보다 오래 남는다. 문장를 급히 닫지 않는다.";
  const output = finalizeGeneratedText(input, "ko", 220);
  assert.equal(output, "정책 문장은 짧게 지나가도 시장 행동의 지연 시간은 생각보다 오래 남는다. 문장을 급히 닫지 않는다.");
});

test("finalizeGeneratedText removes dangling thesis tails like 기대는 순간", () => {
  const input =
    "내가 자주 틀리는 건 예쁘게 맞아 보이는 숫자 하나에 기대는 순간이다. 맞았던 기억에 기대는 순간.";
  const output = finalizeGeneratedText(input, "ko", 220);
  assert.equal(output, "내가 자주 틀리는 건 예쁘게 맞아 보이는 숫자 하나에 기대는 순간이다.");
});

test("finalizeGeneratedText removes dangling command tails like 넘기지", () => {
  const input =
    "좋은 해석은 버티는 근거 하나에서 나온다. 단서를 급히 넘기지.";
  const output = finalizeGeneratedText(input, "ko", 220);
  assert.equal(output, "좋은 해석은 버티는 근거 하나에서 나온다.");
});
