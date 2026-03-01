import test from "node:test";
import assert from "node:assert/strict";
import {
  buildImageConceptSeed,
  buildQuoteReplySeed,
  buildStoryArcSeed,
} from "../src/services/creative-studio.ts";

test("buildQuoteReplySeed returns compact korean seed with evidence anchors", () => {
  const seed = buildQuoteReplySeed({
    lane: "protocol",
    language: "ko",
    eventHeadline: "Solana Firedancer testnet milestone reached",
    evidence: ["Validator queue normalized", "Throughput benchmark +18%"],
  });
  assert.ok(seed.includes("근거"));
  assert.ok(seed.includes("Firedancer"));
  assert.ok(seed.length <= 220);
});

test("buildImageConceptSeed includes character and lane context", () => {
  const seed = buildImageConceptSeed({
    lane: "ecosystem",
    characterName: "Pixymon",
    eventHeadline: "TON gaming activity accelerates",
    evidence: ["Active users +12%", "Volume +18%"],
  });
  assert.ok(seed.includes("Pixymon"));
  assert.ok(seed.includes("ecosystem"));
  assert.ok(seed.length <= 320);
});

test("buildStoryArcSeed returns korean chapter scaffold", () => {
  const seed = buildStoryArcSeed({
    lane: "onchain",
    language: "ko",
    eventHeadline: "Stablecoin liquidity rotates into alt ecosystem",
    evidence: ["Stable supply +240M", "Whale transfer +21%"],
    hypothesis: "유동성 선행 후 가격 반영 지연",
  });
  assert.ok(seed.includes("챕터 시드"));
  assert.ok(seed.includes("관찰-검증-회고"));
  assert.ok(seed.length <= 420);
});
