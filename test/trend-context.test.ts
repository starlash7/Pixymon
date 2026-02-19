import test from "node:test";
import assert from "node:assert/strict";
import { buildFallbackPost, buildTrendNutrients, pickTrendFocus } from "../src/services/engagement/trend-context.ts";

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

test("pickTrendFocus downranks btc-centric headline when recent btc saturation is high", () => {
  const recent = Array.from({ length: 6 }).map(() => ({
    content: "극공포 구간에서 BTC 수수료와 멤풀, 스테이블 유입을 계속 추적 중.",
    timestamp: new Date().toISOString(),
  }));

  const focus = pickTrendFocus(
    [
      "Bitcoin fear index rebounds as ETF flow uncertainty persists",
      "Solana Firedancer client performance milestone update",
    ],
    recent
  );

  assert.equal(focus.headline, "Solana Firedancer client performance milestone update");
});

test("buildFallbackPost prefers non-btc market anchor when recent posts are btc-heavy", () => {
  const text = buildFallbackPost(
    {
      keywords: ["onchain", "solana", "liquidity"],
      summary: "market summary",
      marketData: [
        { symbol: "BTC", name: "Bitcoin", price: 66304, change24h: 2.5 },
        { symbol: "ETH", name: "Ethereum", price: 3320, change24h: 1.1 },
        { symbol: "SOL", name: "Solana", price: 210, change24h: 3.2 },
      ],
      headlines: ["L2 throughput upgrade sparks developer activity"],
      newsSources: [],
      nutrients: [],
    },
    "오늘 나온 기술/업그레이드 이슈의 실사용 영향",
    220,
    null,
    {
      recentPosts: Array.from({ length: 5 }).map(() => ({
        content: "BTC 공포지수와 수수료, 고래 흐름을 계속 확인 중.",
        timestamp: new Date().toISOString(),
      })),
    }
  );

  assert.ok(text);
  assert.equal(/ETH|SOL/.test(text || ""), true);
});
