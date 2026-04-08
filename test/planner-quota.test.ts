import test from "node:test";
import assert from "node:assert/strict";

import { resolveCourtSceneBase } from "../src/services/engagement/planner/scene-bases/court.ts";
import { resolveRetentionSceneBase } from "../src/services/engagement/planner/scene-bases/retention.ts";

test("resolveCourtSceneBase rotates away from hot court+execution base under quota pressure", () => {
  const recentThreads = [
    {
      lane: "regulation" as const,
      focus: "court",
      sceneFamily: "regulation:court:court+execution:capital-lag:verdict-gap",
      headline: "직전 판결 뉴스",
    },
    {
      lane: "regulation" as const,
      focus: "court",
      sceneFamily: "regulation:court:court+execution:verdict-gap:headline-gap",
      headline: "또 다른 판결 뉴스",
    },
  ];

  const base = resolveCourtSceneBase(
    "판결 기사와 자금 반응이 엇갈리고 주문이 늦게 눕는 장면",
    ["capital", "execution", "order"],
    recentThreads
  );

  assert.notEqual(base, "court+execution");
  assert.match(base, /order\+capital|capital\+execution|capital\+court|verdict\+execution|briefing\+execution/);
});

test("resolveRetentionSceneBase rotates away from hot retention+usage base under quota pressure", () => {
  const recentThreads = [
    {
      lane: "ecosystem" as const,
      focus: "retention",
      sceneFamily: "ecosystem:retention:retention+usage:retention-holds:cohort-thin",
      headline: "직전 잔류 장면",
    },
    {
      lane: "ecosystem" as const,
      focus: "retention",
      sceneFamily: "ecosystem:retention:retention+usage:habit-gap:wallet-thins",
      headline: "또 다른 잔류 장면",
    },
  ];

  const base = resolveRetentionSceneBase(
    "실사용은 남는데 지갑 재방문과 생활 흔적이 얇아지는 장면",
    ["usage", "wallet", "retention", "cohort"],
    recentThreads
  );

  assert.notEqual(base, "retention+usage");
  assert.match(base, /wallet\+retention|retention\+wallet|cohort\+retention|retention\+cohort|usage\+wallet|cohort\+usage|habit\+retention|return\+habit/);
});
