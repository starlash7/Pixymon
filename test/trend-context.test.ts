import test from "node:test";
import assert from "node:assert/strict";
import { buildTrendNutrients, pickTrendFocus } from "../src/services/engagement/trend-context.ts";

test("pickTrendFocus prefers headline with lower overlap against recent posts", () => {
  const focus = pickTrendFocus(
    [
      "Bitcoin ETF flows stay flat as fear index drops",
      "Solana Firedancer upgrade testnet milestone reached",
    ],
    [
      {
        content: "Bitcoin ETF 유입이 둔화되고 공포 지수가 내려오는 구간을 추적 중.",
        timestamp: new Date().toISOString(),
      },
    ]
  );

  assert.equal(focus.headline, "Solana Firedancer upgrade testnet milestone reached");
  assert.equal(focus.reason, "novelty");
  assert.ok(focus.requiredTokens.length > 0);
});

test("pickTrendFocus returns fallback when headline list is empty", () => {
  const focus = pickTrendFocus([], []);
  assert.equal(typeof focus.headline, "string");
  assert.ok(focus.headline.length > 0);
  assert.equal(focus.reason, "fallback");
});

test("buildTrendNutrients normalizes market/news into nutrient packets", () => {
  const nutrients = buildTrendNutrients({
    createdAt: new Date().toISOString(),
    marketData: [
      { symbol: "BTC", name: "Bitcoin", price: 100000, change24h: 1.2 },
      { symbol: "ETH", name: "Ethereum", price: 4200, change24h: -0.8 },
    ],
    newsRows: [
      {
        item: {
          title: "ECB rate pause surprises markets",
          summary: "EUR volatility rises after ECB comments",
          source: "Reuters",
          category: "macro",
          importance: "high",
        },
        sourceKey: "news:reuters",
        trust: 0.74,
      },
    ],
  });

  assert.ok(nutrients.length >= 3);
  assert.ok(nutrients.some((item) => item.source === "market"));
  assert.ok(nutrients.some((item) => item.source === "news"));
});
