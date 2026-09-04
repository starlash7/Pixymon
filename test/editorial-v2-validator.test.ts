import assert from "node:assert/strict";
import test from "node:test";
import { validateEditorialDraftV2 } from "../src/services/editorial-v2/validator.ts";

test("editorial V2 validator accepts grounded two-sentence Korean prose", () => {
  const text =
    "Ethereum TVL은 24시간 동안 +3.20% 늘었지만, 나는 이 숫자를 반등의 시작으로 바로 삼키진 않는다. 72시간 뒤에도 자금이 같은 방향으로 남는다면 그때는 사용 회복 쪽에 한 표를 주겠다.";
  const result = validateEditorialDraftV2({
    text,
    subject: "Ethereum TVL",
    displayValue: "+3.20%",
    factIds: ["fact-1"],
    usedFactIds: ["fact-1"],
    allowedNumericValues: ["24시간", "72시간"],
    allowedNamedTokens: ["TVL"],
    metricDirection: "increase",
  });
  assert.equal(result.ok, true, result.reasons.join(","));
});

test("editorial V2 validator rejects a reversed signed fact and fabricated Korean entity", () => {
  const result = validateEditorialDraftV2({
    text: "Aave의 TVL은 24시간 동안 +8.4% 줄었고 이더리움 회복도 확인됐다. 72시간 뒤에도 같은 흐름이면 현재 판정을 승인하겠다.",
    subject: "Aave",
    displayValue: "+8.4%",
    factIds: ["fact-1"],
    usedFactIds: ["fact-1"],
    allowedNumericValues: ["24시간", "72시간"],
    allowedNamedTokens: ["TVL"],
    metricDirection: "increase",
  });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes("metric-direction-conflict"));
  assert.ok(result.reasons.includes("unsupported-korean-entity"));
});

test("editorial V2 validator rejects unsupported numbers and known malformed Korean", () => {
  const text =
    "Ethereum TVL은 24시간 동안 +3.20% 늘었다. 돈이 안 눕은 순간이라 72시간 뒤 +9.00%까지 간다고 본다.";
  const result = validateEditorialDraftV2({
    text,
    subject: "Ethereum TVL",
    displayValue: "+3.20%",
    factIds: ["fact-1"],
    usedFactIds: ["fact-1"],
    allowedNumericValues: ["24시간", "72시간"],
    allowedNamedTokens: ["TVL"],
  });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes("malformed-nuun"));
  assert.ok(result.reasons.includes("unsupported-number"));
});

test("editorial V2 validator limits character cues to one per post", () => {
  const result = validateEditorialDraftV2({
    text: "Aave의 TVL은 24시간 동안 +8.4% 늘어 이 숫자를 먼저 물고 본다. 아직 소화 중이라 72시간 뒤 같은 수치가 유지될 때만 판정을 승인하겠다.",
    subject: "Aave",
    displayValue: "+8.4%",
    factIds: ["fact-1"],
    usedFactIds: ["fact-1"],
    allowedNumericValues: ["24시간", "72시간"],
    allowedNamedTokens: ["TVL"],
  });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes("character-cue-overuse"));
});

test("editorial V2 validator rejects an unsupported named entity", () => {
  const result = validateEditorialDraftV2({
    text: "Aave의 TVL은 24시간 동안 +8.4% 늘었고 Ethereum도 같은 방향이라고 본다. 72시간 뒤 Aave 수치가 유지될 때만 현재 판정을 승인하겠다.",
    subject: "Aave",
    displayValue: "+8.4%",
    factIds: ["fact-1"],
    usedFactIds: ["fact-1"],
    allowedNumericValues: ["24시간", "72시간"],
    allowedNamedTokens: ["TVL"],
  });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes("unsupported-name"));
});

test("publishable V2 copy must retain the exact source time and a closing judgment", () => {
  const common = {
    subject: "Aave",
    displayValue: "+8.4%",
    factIds: ["fact-1"],
    usedFactIds: ["fact-1"],
    allowedNumericValues: ["24시간", "72시간"],
    allowedNamedTokens: ["TVL"],
    sourceTimeToken: "2026-08-28 09:30 UTC",
    requireJudgment: true,
    metricName: "tvl-change-24h",
  };
  const missing = validateEditorialDraftV2({
    ...common,
    text: "Aave의 TVL은 24시간 동안 +8.4% 늘었다. 이 수치가 다음 관측에서도 같은지 차분하게 다시 살펴볼 예정이다.",
  });
  assert.ok(missing.reasons.includes("source-time-missing"));
  assert.ok(missing.reasons.includes("final-judgment-missing"));

  const grounded = validateEditorialDraftV2({
    ...common,
    text: "Aave의 TVL은 2026-08-28 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 숫자는 기록하되 바로 승인하지 않는다. 72시간 뒤 변동 전 수준을 잃으면 이 판정을 철회한다.",
  });
  assert.equal(grounded.ok, true, grounded.reasons.join(","));
});

test("plain review and publish validation reject an explicit inverted falsifier", () => {
  const result = validateEditorialDraftV2({
    text: "Aave의 TVL은 2026-08-28 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 72시간 뒤 기준 이상으로 늘어나면 이 판정을 철회한다.",
    subject: "Aave",
    displayValue: "+8.4%",
    factIds: ["fact-1"],
    usedFactIds: ["fact-1"],
    allowedNumericValues: ["24시간", "72시간"],
    allowedNamedTokens: ["TVL"],
    sourceTimeToken: "2026-08-28 09:30 UTC",
    requireJudgment: true,
    metricName: "tvl-change-24h",
    metricDirection: "increase",
    falsifierComparator: "lte",
  });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes("falsifier-direction-mismatch"));
});

for (const inverted of [
  "72시간 뒤 TVL이 기준 미만이 아니어도 이 판정을 철회한다.",
  "72시간 뒤 TVL이 기준 미만을 제외한 값일 경우 이 판정을 철회한다.",
  "72시간 뒤 TVL이 기준 미만 범위를 벗어날 때 이 판정을 철회한다.",
  "72시간 뒤 TVL이 기준 미만의 반대편에 설 경우 이 판정을 철회한다.",
  "72시간 뒤 TVL이 기준 미만일 때를 빼고 이 판정을 철회한다.",
]) {
  test(`plain review and publish validation reject non-canonical falsifier: ${inverted}`, () => {
    const result = validateEditorialDraftV2({
      text: `Aave의 TVL은 2026-08-28 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 이 한 번의 관측만으로 더 큰 서사를 승인하진 않는다. ${inverted}`,
      subject: "Aave",
      displayValue: "+8.4%",
      factIds: ["fact-1"],
      usedFactIds: ["fact-1"],
      allowedNumericValues: ["24시간", "72시간"],
      allowedNamedTokens: ["TVL"],
      sourceTimeToken: "2026-08-28 09:30 UTC",
      requireJudgment: true,
      metricName: "tvl-change-24h",
      metricDirection: "increase",
      falsifierComparator: "lt",
    });
    assert.equal(result.ok, false);
    assert.ok(result.reasons.includes("falsifier-language-not-canonical"));
  });
}

test("plain review and publish validation accept the comparator's canonical falsifier", () => {
  const result = validateEditorialDraftV2({
    text: "Aave의 TVL은 2026-08-28 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 이 한 번의 관측만으로 더 큰 서사를 승인하진 않는다. 72시간 뒤 같은 지표의 관측값이 기준 미만이면 이 판정을 철회한다.",
    subject: "Aave",
    displayValue: "+8.4%",
    factIds: ["fact-1"],
    usedFactIds: ["fact-1"],
    allowedNumericValues: ["24시간", "72시간"],
    allowedNamedTokens: ["TVL"],
    sourceTimeToken: "2026-08-28 09:30 UTC",
    requireJudgment: true,
    metricName: "tvl-change-24h",
    metricDirection: "increase",
    falsifierComparator: "lt",
  });
  assert.equal(result.ok, true, result.reasons.join(","));
});

for (const text of [
  "Aave의 TVL은 2026-08-28 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 이 한 번의 관측만으로 더 큰 서사를 승인하진 않는다. 72시간 뒤 TVL 관측값이 기준선을 웃도는 때 이 판정을 철회한다.",
  "Aave의 TVL은 2026-08-28 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 72시간 뒤 기준 이상으로 늘어나면 이 판정을 철회한다. 72시간 뒤 같은 지표의 관측값이 기준 미만이면 이 판정을 철회한다.",
  "Aave의 TVL은 2026-08-28 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 다음 관측값이 기준선을 웃돌 때 이 판정을 폐기한다. 72시간 뒤 같은 지표의 관측값이 기준 미만이면 이 판정을 철회한다.",
  "Aave의 TVL은 2026-08-28 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 이 수치가 유지될 때 판정은 유지한다. 72시간 뒤 같은 지표의 관측값이 기준 미만이면 이 판정을 철회한다.",
  "Aave의 TVL은 2026-08-28 09:30 UTC 기준 24시간 동안 +8.4% 늘었다. 사흘 후 수치가 경계보다 높아지면 이 판정을 취소한다. 72시간 뒤 같은 지표의 관측값이 기준 미만이면 이 판정을 철회한다.",
]) {
  test("required canonical falsifier cannot be hidden or duplicated", () => {
    const result = validateEditorialDraftV2({
      text,
      subject: "Aave",
      displayValue: "+8.4%",
      factIds: ["fact-1"],
      usedFactIds: ["fact-1"],
      allowedNumericValues: ["24시간", "72시간"],
      allowedNamedTokens: ["TVL"],
      sourceTimeToken: "2026-08-28 09:30 UTC",
      requireJudgment: true,
      metricName: "tvl-change-24h",
      metricDirection: "increase",
      falsifierComparator: "lt",
      requireCanonicalFalsifier: true,
    });
    assert.equal(result.ok, false);
    assert.ok(result.reasons.some((reason) =>
      ["falsifier-language-not-canonical", "falsifier-deadline-not-isolated", "falsifier-condition-outside-final", "falsifier-action-outside-final", "falsifier-language-outside-final"].includes(reason)
    ));
  });
}
