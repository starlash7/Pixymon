import test from "node:test";
import assert from "node:assert/strict";
import { applyKoNarrativeLexicon, detectNarrativeFlagHits } from "../src/services/narrative-lexicon.ts";

test("applyKoNarrativeLexicon rewrites internal analyst terms", () => {
  const input = "헤지 포지셔닝 변화와 거래소 대응 속도, 지갑 군집 변화를 같이 본다.";
  const output = applyKoNarrativeLexicon(input);
  assert.equal(
    output,
    "방어 포지션이 얼마나 풀리는지와 거래소가 얼마나 빨리 반응하는지, 비슷한 지갑이 한쪽으로 몰리는 모습을 같이 본다."
  );
});

test("applyKoNarrativeLexicon rewrites leftover metaphor phrases into plain korean", () => {
  const input = "큰손의 발자국과 대기하던 현금의 냄새를 같이 본다. 업그레이드 뒤의 몸짓이 남는지도 본다.";
  const output = applyKoNarrativeLexicon(input);
  assert.equal(output, "큰손 움직임과 대기 자금 흐름을 같이 본다. 업그레이드 뒤 실제 움직임이 남는지도 본다.");
});

test("applyKoNarrativeLexicon rewrites staged screen phrases and time-gap boilerplate", () => {
  const input = "체인 수수료와 가격 서사, 이 둘을 같은 화면에 붙여 둔다. 시간차부터 잰다.";
  const output = applyKoNarrativeLexicon(input);
  assert.equal(output, "체인 사용과 가격 분위기, 이 둘을 나란히 놓고 본다. 어느 쪽이 먼저 움직이는지 본다.");
});

test("applyKoNarrativeLexicon rewrites brittle orderbook boilerplate", () => {
  const input = "호가창 바깥에서 먼저 새는 신호가 있는지 짚는다. 호가만 흔들리고 실제 흐름이 안 따라오면 여기서 멈춘다.";
  const output = applyKoNarrativeLexicon(input);
  assert.equal(output, "화면 분위기보다 실제 돈이 먼저 붙는지 살핀다. 화면만 흔들리고 실제 돈이 안 붙으면 여기서 멈춘다.");
});

test("detectNarrativeFlagHits reports rewrite-source and suspicious patterns", () => {
  const input = "헤지 포지셔닝 변화 쪽부터 다시 본다. 끝까지 남는 근거 하나만 붙잡는다.";
  const hits = detectNarrativeFlagHits(input, "ko");
  assert.ok(hits.some((hit) => hit.label === "hedge-positioning" && hit.kind === "rewrite-source"));
  assert.ok(hits.some((hit) => hit.label === "awkward-anchor-suffix" && hit.kind === "suspicious-pattern"));
  assert.ok(hits.some((hit) => hit.label === "templated-closing" && hit.kind === "suspicious-pattern"));
});
