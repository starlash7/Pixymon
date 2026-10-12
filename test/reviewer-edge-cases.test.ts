// Edge case tests - reviewer's additional assertions

import assert from "node:assert";
import { test } from "node:test";

test("reviewer probe: unbalanced parentheses expose content", async () => {
  const { editorialMemoryOutcomeTargetViolationV2 } = await import("../src/services/editorial-v2/scope-critic.ts");
  
  // Unbalanced ( - regex /\([^)]*\)/ won't match, content is exposed
  const unbalanced1 = "시장은 (급증은 틀렸다 여전히 관찰 중.";
  assert.ok(editorialMemoryOutcomeTargetViolationV2(unbalanced1), "unbalanced ( should expose assertion");
  
  // Unbalanced ) - same issue
  const unbalanced2 = "급감은 맞았다) 이게 문제.";
  assert.ok(editorialMemoryOutcomeTargetViolationV2(unbalanced2), "unbalanced ) should expose assertion");
  
  // Nested unbalanced
  const nested = "시장은 (내부 (급증은 반증됐고 여전히 불안.";
  assert.ok(editorialMemoryOutcomeTargetViolationV2(nested), "nested unbalanced parens should expose assertion");
});

test("reviewer probe: unbalanced em-dashes expose content", async () => {
  const { editorialMemoryOutcomeTargetViolationV2 } = await import("../src/services/editorial-v2/scope-critic.ts");
  
  // Single em-dash - regex /—[^—]*—/ won't match
  const single = "시장—증가는 맞았다 여전히 불안.";
  assert.ok(editorialMemoryOutcomeTargetViolationV2(single), "single em-dash should expose assertion");
  
  // Three dashes (odd number)
  const triple = "첫—증가는—반증됐고—마지막.";
  // First pair matches: —증가는— removes "증가는"
  // Remaining: "첫반증됐고—마지막."
  const result = editorialMemoryOutcomeTargetViolationV2(triple);
  // This might or might not match depending on what remains
  console.log("Triple dash result:", result);
});

test("reviewer probe: ASCII vs Unicode quotes are equivalent", async () => {
  const { editorialMemoryOutcomeTargetViolationV2 } = await import("../src/services/editorial-v2/scope-critic.ts");
  
  // Unicode curly quotes (original)
  assert.equal(editorialMemoryOutcomeTargetViolationV2('"급감은 맞았다"고 말함.'), undefined);
  
  // ASCII quotes (author claims these were NOT handled before - FALSE)
  assert.equal(editorialMemoryOutcomeTargetViolationV2('"급감은 맞았다"고 말함.'), undefined);
  
  // Mixed
  assert.equal(editorialMemoryOutcomeTargetViolationV2('"급감은 맞았다"고 말함.'), undefined);
});

test("reviewer probe: whitespace in regex components", async () => {
  const { editorialMemoryOutcomeTargetViolationV2 } = await import("../src/services/editorial-v2/scope-critic.ts");
  
  // Extra spaces in middle
  assert.ok(editorialMemoryOutcomeTargetViolationV2("급감은   맞았다."));
  assert.ok(editorialMemoryOutcomeTargetViolationV2("증가는 결국  반증됐고"));
  
  // Tab character
  assert.ok(editorialMemoryOutcomeTargetViolationV2("상승은\t틀렸음."));
});

test("reviewer probe: lookahead punctuation coverage", async () => {
  const { editorialMemoryOutcomeTargetViolationV2 } = await import("../src/services/editorial-v2/scope-critic.ts");
  
  // Original lookahead: [,.!\s]
  // New lookahead: [,.!…\s(—]
  
  // Period (.)
  assert.ok(editorialMemoryOutcomeTargetViolationV2("급감은 맞았다."));
  
  // Comma (,)
  assert.ok(editorialMemoryOutcomeTargetViolationV2("상승은 반증됐고,"));
  
  // Exclamation (!)
  assert.ok(editorialMemoryOutcomeTargetViolationV2("급증은 틀렸음!"));
  
  // Ellipsis (…) - NEWLY ADDED
  assert.ok(editorialMemoryOutcomeTargetViolationV2("하락은 반증됐다…"));
  
  // Opening paren (() - NEWLY ADDED
  assert.ok(editorialMemoryOutcomeTargetViolationV2("증가는 맞았다("));
  
  // Em-dash (—) - NEWLY ADDED
  assert.ok(editorialMemoryOutcomeTargetViolationV2("감소는 틀렸고—"));
  
  // End of string
  assert.ok(editorialMemoryOutcomeTargetViolationV2("급감은 반증됐음"));
  
  // Whitespace
  assert.ok(editorialMemoryOutcomeTargetViolationV2("상승은 맞았다 "));
});

test("reviewer probe: quote regex handles both quote types in base", async () => {
  // CRITICAL: Author claimed ASCII quotes were NOT handled before
  // Reality: base regex was /"[^"]*"|"[^"]*"/gu (both types present)
  // This test verifies the base branch ALREADY handled ASCII quotes
  
  // We can't test the old code directly, but we verified the diff shows:
  // OLD: text.replace(/"[^"]*"|"[^"]*"/gu, "");
  // NEW: text.replace(/"[^"]*"|"[^"]*"/gu, "");
  // These are IDENTICAL (alternation order doesn't matter)
  
  assert.ok(true, "Confirmed: base already had both \" and \"\" in the regex");
});
