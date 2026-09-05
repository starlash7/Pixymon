import assert from "node:assert/strict";
import test from "node:test";
import {
  formatEvidenceSourceTimeV2,
  validateEditorialDraftV2,
} from "../src/services/editorial-v2/validator.ts";

const SOURCE_TIME = "8월 28일 09:30 UTC";
const BASE_TEXT =
  "Aave의 TVL은 8월 28일 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 규모 측면의 변화는 분명하지만, 이 한 번의 관측만으로 더 큰 서사까지 승인하진 않는다.";

function validate(text: string) {
  return validateEditorialDraftV2({
    text,
    subject: "Aave",
    displayValue: "+8.4%",
    factIds: ["fact-1"],
    usedFactIds: ["fact-1"],
    allowedNumericValues: ["24시간", "72시간"],
    allowedNamedTokens: ["TVL"],
    sourceTimeToken: SOURCE_TIME,
    requireJudgment: true,
    metricName: "tvl-change-24h",
    metricDirection: "increase",
    forbidFutureRecheck: true,
  });
}

test("source time uses a minute-precise Korean display instead of ISO metadata", () => {
  assert.equal(
    formatEvidenceSourceTimeV2("2026-08-28T09:30:00.000Z"),
    SOURCE_TIME
  );
});

test("non-Revisit copy accepts a grounded present-tense judgment containing 측면", () => {
  const result = validate(BASE_TEXT);
  assert.equal(result.ok, true, result.reasons.join(","));
});

test("non-Revisit copy may reject an unsupported premise without creating a condition", () => {
  const result = validate(
    "Aave의 TVL은 8월 28일 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 원시 변화만 인정하며, 그 배경과 지속성까지 전제하지 않는다는 판단을 남긴다."
  );
  assert.equal(result.ok, true, result.reasons.join(","));
});

for (const benign of [
  "Aave의 TVL은 8월 28일 09:30 UTC 기준 24시간 동안 +8.4% 늘어나면서 변화를 드러냈다. 수치를 확인하면서도, 이 한 번의 관측만으로 더 큰 서사까지 승인하진 않는다는 판단이다.",
  "Aave의 TVL은 8월 28일 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 올해도 원인과 지속성은 이 숫자만으로 확정하지 않고, 현재 관측 범위의 판단만 남긴다.",
]) {
  test(`non-Revisit copy allows a benign connective: ${benign}`, () => {
    const result = validate(benign);
    assert.equal(result.ok, true, result.reasons.join(","));
  });
}

test("validator rejects a reversed signed fact and fabricated Korean entity", () => {
  const result = validate(
    "Aave의 TVL은 8월 28일 09:30 UTC 기준 24시간 동안 +8.4% 줄었고 이더리움 회복도 확인됐다. 이 한 번의 관측으로 회복을 승인할 수 없다는 판단이다."
  );
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes("metric-direction-conflict"));
  assert.ok(result.reasons.includes("unsupported-korean-entity"));
});

test("validator rejects unsupported numbers and known malformed Korean", () => {
  const result = validate(
    "Aave의 TVL은 8월 28일 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 돈이 안 눕은 순간이라 +9.0%까지 이어진다는 과한 해석은 보류한다."
  );
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes("malformed-nuun"));
  assert.ok(result.reasons.includes("unsupported-number"));
});

test("validator limits character cues to one per post", () => {
  const result = validate(
    "Aave의 TVL은 8월 28일 09:30 UTC 기준 24시간 동안 +8.4% 늘어 이 숫자를 먼저 물고 본다. 아직 소화 중인 한 번의 관측이라 더 큰 서사에 대한 판단은 보류한다."
  );
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes("character-cue-overuse"));
});

test("validator rejects an unsupported named entity", () => {
  const result = validate(
    "Aave의 TVL은 8월 28일 09:30 UTC 기준 24시간 동안 +8.4% 늘었고 Ethereum도 같은 방향이라고 본다. 이 한 번의 수치로 시장 전체를 승인하진 않는다는 판단이다."
  );
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes("unsupported-name"));
});

for (const unsupported of [
  "Aave의 TVL은 8월 28일 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 유니스왑과 아비트럼도 같은 방향이라 시장 회복까지 확인됐다는 판단이다.",
  "Aave의 TVL은 8월 28일 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 커브와 메이커다오의 자금도 돌아와 생태계가 회복됐다는 판단이다.",
]) {
  test(`validator rejects an unsupported Korean crypto entity: ${unsupported}`, () => {
    const result = validate(unsupported);
    assert.equal(result.ok, false);
    assert.ok(result.reasons.includes("unsupported-korean-entity"));
  });
}

test("validator rejects unsupported TVL causes", () => {
  const result = validate(
    "Aave의 TVL은 8월 28일 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 고래 지갑의 매수와 기관 복귀가 원인이라는 해석은 근거 밖이라는 판단이다."
  );
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes("metric-semantic-scope"));
});

for (const unsupportedQuantity of [
  "예치 규모가 두 배로 늘었다는 해석은 보류한다.",
  "수백만 달러의 신규 예치가 들어왔다는 해석은 보류한다.",
]) {
  test(`validator rejects an unsupported Korean quantity: ${unsupportedQuantity}`, () => {
    const result = validate(
      `Aave의 TVL은 8월 28일 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. ${unsupportedQuantity}`
    );
    assert.equal(result.ok, false);
    assert.ok(result.reasons.includes("unsupported-number-word"));
  });
}

for (const caveat of [
  "신규 자금 유입이나 사용자 복귀를 뜻하지 않는다",
  "채택이나 구조적 성장을 증명하지 않는다",
  "거래량과 매출까지 늘었다고 보장하지 않는다",
]) {
  test(`validator allows an evidence-bounded caveat: ${caveat}`, () => {
    const result = validate(
      `Aave의 TVL은 8월 28일 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 이 숫자는 ${caveat}. 현재 관측 범위의 판단만 남긴다.`
    );
    assert.equal(result.ok, true, result.reasons.join(","));
  });
}

for (const mixedClaim of [
  "사용자 복귀를 뜻하고 채택을 증명하지 않는다",
  "신규 자금 유입이 확인됐고 구조적 성장을 증명하지 않는다",
  "기관 복귀를 의미하나 수익을 보장하지 않는다",
]) {
  test(`validator does not let one negation shield a positive TVL claim: ${mixedClaim}`, () => {
    const result = validate(
      `Aave의 TVL은 8월 28일 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 이 숫자는 ${mixedClaim}는 판단이며, 현재 관측 범위를 벗어난다.`
    );
    assert.equal(result.ok, false);
    assert.ok(result.reasons.includes("metric-semantic-scope"));
  });
}

for (const scopeLeak of [
  "사용자 복귀를 뜻하지 않고, 자금 유입이 이미 확인됐다는 강한 판정이다",
  "사용자 복귀를 뜻하지 않는데, 자금 유입이 이미 확인됐다는 강한 판정이다",
  "사용자 복귀를 뜻하지 않으면서 자금 유입이 이미 확인됐다는 강한 판정이다",
]) {
  test(`a TVL caveat cannot shield a later unsupported assertion: ${scopeLeak}`, () => {
    const result = validate(
      `Aave의 TVL은 8월 28일 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 이 수치는 ${scopeLeak}.`
    );
    assert.equal(result.ok, false);
    assert.ok(result.reasons.includes("metric-semantic-scope"));
  });
}

test("publishable copy must retain the exact source time", () => {
  const missing = validateEditorialDraftV2({
    text: "Aave의 TVL은 24시간 동안 +8.4% 늘었다. 원시 수치의 변화는 분명하지만, 이 한 번의 관측만으로 더 큰 서사까지 승인하진 않는다.",
    subject: "Aave",
    displayValue: "+8.4%",
    factIds: ["fact-1"],
    usedFactIds: ["fact-1"],
    allowedNumericValues: ["24시간"],
    allowedNamedTokens: ["TVL"],
    sourceTimeToken: SOURCE_TIME,
    requireJudgment: true,
    metricName: "tvl-change-24h",
  });
  assert.ok(missing.reasons.includes("source-time-missing"));
});

for (const conditional of [
  "지속성까지 판단하려면 추가 관측이 필요하므로, 지금은 이 수치의 변화만 인정한다는 판단이다.",
  "이 변화가 유지되더라도 원인까지 확인된 것은 아니므로, 현재 수치 범위의 판단만 남긴다.",
  "추가 근거 없이는 더 큰 서사를 승인하지 않고, 현재 관측한 변화에 한정한 판단만 남긴다.",
  "이 숫자가 눈에 띄는 경우에도 지속성까지 확정할 근거는 없으므로, 더 큰 서사의 승인은 보류한다.",
]) {
  test(`ordinary conditionals do not trigger a blanket expression ban: ${conditional}`, () => {
    const result = validate(
      `Aave의 TVL은 8월 28일 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. ${conditional}`
    );
    assert.equal(result.ok, true, result.reasons.join(","));
  });
}

test("Revisit allows a resolved historical checkpoint", () => {
  const result = validate(
    "Aave의 현재 TVL은 8월 28일 09:30 UTC 기준 +8.4% 수준이다. 24시간 재검증에서 이전 기준이 유지됐으므로, 처음 기록한 변화는 아직 유효하다는 판정을 지지한다."
  );
  assert.equal(result.ok, true, result.reasons.join(","));
});

for (const resolved of [
  "다음 관측에서 판단을 갱신했다",
  "후속 데이터가 도착해 판정을 업데이트했다",
]) {
  test(`Revisit allows a completed follow-up statement: ${resolved}`, () => {
    const result = validate(
      `Aave의 현재 TVL은 8월 28일 09:30 UTC 기준 +8.4% 수준이다. ${resolved}; 이전 판정은 여전히 유효하고 추가 서사를 보태지 않는다는 판단을 남긴다.`
    );
    assert.equal(result.ok, true, result.reasons.join(","));
  });
}

for (const promise of [
  "72시간 뒤 같은 지표를 다시 확인하겠다는 판단이며, 현재 관측한 변화에 한정해서 기록을 남긴다.",
  "24시간 뒤 같은 지표를 확인할 예정이라는 판단이며, 현재 관측한 변화에 한정해서 기록을 남긴다.",
  "하루 뒤 같은 값을 점검할 계획이라는 판단이며, 현재 관측한 변화에 한정해서 기록을 남긴다.",
  "이번 판정은 아직 미결로 남기고, 다음 관측에서 같은 지표를 다시 확인하겠다.",
  "이번 판정은 아직 미결로 남기고, 다음 관측에서 판단을 갱신하겠다.",
  "이번 판정은 아직 미결로 남기고, 후속 데이터가 오면 업데이트한다.",
  "이번 판정은 아직 미결로 남기고, 새 숫자가 오면 다시 쓰겠다.",
  "이번 판정은 아직 미결로 남기며, 다음 관측에서 판단을 재평가할 생각이다.",
  "이번 판정은 아직 미결로 남기며, 후속 수치가 나오면 결론을 바꿀 계획이다.",
  "이번 판정은 아직 미결로 남기며, 새 데이터가 오면 이전 판정을 고칠 예정이다.",
  "이번 판정은 아직 미결로 남기며, 다음 기록으로 기존 해석을 고쳐 쓸 생각이다.",
]) {
  test(`public copy cannot promise another future check: ${promise}`, () => {
    const result = validate(
      `Aave의 현재 TVL은 8월 28일 09:30 UTC 기준 +8.4% 수준이다. ${promise}`
    );
    assert.equal(result.ok, false);
    assert.ok(result.reasons.includes("future-recheck-promise"));
  });
}
