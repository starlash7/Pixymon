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

test("detectNarrativeFlagHits reports rewrite-source and suspicious patterns", () => {
  const input = "헤지 포지셔닝 변화 쪽부터 다시 본다. 끝까지 남는 근거 하나만 붙잡는다.";
  const hits = detectNarrativeFlagHits(input, "ko");
  assert.ok(hits.some((hit) => hit.label === "hedge-positioning" && hit.kind === "rewrite-source"));
  assert.ok(hits.some((hit) => hit.label === "awkward-anchor-suffix" && hit.kind === "suspicious-pattern"));
  assert.ok(hits.some((hit) => hit.label === "templated-closing" && hit.kind === "suspicious-pattern"));
});

