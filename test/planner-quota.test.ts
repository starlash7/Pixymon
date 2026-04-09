import test from "node:test";
import assert from "node:assert/strict";

import { resolveCourtSceneBase } from "../src/services/engagement/planner/scene-bases/court.ts";
import { resolveRetentionSceneBase } from "../src/services/engagement/planner/scene-bases/retention.ts";
import { resolveLaunchSceneBase } from "../src/services/engagement/planner/scene-bases/launch.ts";
import { resolveSettlementSceneBase } from "../src/services/engagement/planner/scene-bases/settlement.ts";
import { resolveBuilderSceneBase } from "../src/services/engagement/planner/scene-bases/builder.ts";

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

test("resolveLaunchSceneBase rotates away from hot return+launch base under quota pressure", () => {
  const recentThreads = [
    {
      lane: "protocol" as const,
      focus: "launch",
      sceneFamily: "protocol:launch:return+launch:return-lag:briefing-gap",
      headline: "직전 런치 장면",
    },
    {
      lane: "protocol" as const,
      focus: "launch",
      sceneFamily: "protocol:launch:return+launch:ops-cold:return-lag",
      headline: "또 다른 런치 장면",
    },
  ];

  const base = resolveLaunchSceneBase(
    "메인넷 뉴스는 뜨거운데 운영과 복귀 자금이 같이 머뭇거리는 장면",
    ["return", "ops", "capital", "launch"],
    recentThreads
  );

  assert.notEqual(base, "return+launch");
  assert.match(base, /return\+ops|return\+showcase|return\+announcement|launch\+ops|capital\+launch|capital\+rollout|launch\+audience|launch\+showcase/);
});

test("resolveSettlementSceneBase rotates away from hot fill+book base under quota pressure", () => {
  const recentThreads = [
    {
      lane: "market-structure" as const,
      focus: "settlement",
      sceneFamily: "market-structure:settlement:fill+book:execution-thin:book-thin",
      headline: "직전 정산 장면",
    },
    {
      lane: "market-structure" as const,
      focus: "settlement",
      sceneFamily: "market-structure:settlement:fill+book:size-only:settlement-lag",
      headline: "또 다른 정산 장면",
    },
  ];

  const base = resolveSettlementSceneBase(
    "현물 체결은 붙는데 호가 책과 깊이가 비면서 거래량만 커지는 장면",
    ["execution", "depth", "volume", "settlement"],
    recentThreads
  );

  assert.notEqual(base, "fill+book");
  assert.match(base, /volume\+book|execution\+settlement|fill\+depth|depth\+settlement|execution\+depth|volume\+settlement|depth\+heat/);
});

test("resolveBuilderSceneBase rotates away from hot builder+return base under quota pressure", () => {
  const recentThreads = [
    {
      lane: "ecosystem" as const,
      focus: "builder",
      sceneFamily: "ecosystem:builder:builder+return:return-lag:usage-thin",
      headline: "직전 빌더 장면",
    },
    {
      lane: "ecosystem" as const,
      focus: "builder",
      sceneFamily: "ecosystem:builder:builder+return:treasury-lag:return-lag",
      headline: "또 다른 빌더 장면",
    },
  ];

  const base = resolveBuilderSceneBase(
    "개발자 잔류는 버티는데 복귀 자금과 사용 흔적이 같이 늦는 장면",
    ["builder", "return", "usage", "capital"],
    recentThreads
  );

  assert.notEqual(base, "builder+return");
  assert.match(base, /builder\+usage|builder\+treasury|builder\+inside/);
});
