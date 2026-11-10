import assert from "node:assert/strict";
import test from "node:test";
import { collectMarketPulseV2, lookupMentionedCoinsV2 } from "../src/services/editorial-v2/market-pulse.ts";

function fakeFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (url: string | URL) => {
    const key = Object.keys(routes).find((prefix) => String(url).includes(prefix));
    return key ? new Response(JSON.stringify(routes[key]), { status: 200 }) : new Response("{}", { status: 404 });
  }) as typeof fetch;
}

test("the pulse turns trending, movers and Upbit volume into material", async () => {
  const items = await collectMarketPulseV2(fakeFetch({
    "/search/trending": { coins: [{ item: { symbol: "dac", name: "Dacity", market_cap_rank: 900, data: { price_change_percentage_24h: { usd: 114.68 } } } }] },
    "/coins/markets": [
      { id: "a", symbol: "aaa", name: "Alpha", current_price: 2, price_change_percentage_24h: 12, market_cap_rank: 50 },
      { id: "b", symbol: "bbb", name: "Beta", current_price: 3, price_change_percentage_24h: -9, market_cap_rank: 60 },
      { id: "t", symbol: "usdt", name: "Tether", current_price: 1, price_change_percentage_24h: 0.1, market_cap_rank: 3 },
    ],
    "/ticker/all": [{ market: "KRW-XRP", trade_price: 3100, acc_trade_price_24h: 184_400_000_000, signed_change_rate: 0.012 }],
    "/market/all": [{ market: "KRW-XRP", korean_name: "엑스알피" }],
  }));
  const text = items.map((item) => `${item.label}: ${item.text}`).join("\n");
  assert.match(text, /CoinGecko 검색 트렌딩: Dacity\(\$DAC\), 시총 900위, 24시간 \+114\.68%/);
  assert.match(text, /상승 상위: Alpha\(\$AAA\) \$2, 24시간 \+12\.00%/);
  assert.match(text, /하락 상위: Beta\(\$BBB\) \$3, 24시간 -9\.00%/);
  assert.doesNotMatch(text, /Tether/);
  assert.match(text, /업비트 원화 거래대금 상위\(24시간\): 엑스알피\(\$XRP\) 3,100원, 거래대금 1,844억원, \+1\.20%/);
});

test("a coin named in a mention is looked up by exact symbol", async () => {
  const items = await lookupMentionedCoinsV2("@Pixy_mon BCH 현황체크하고 의견 알려줘", fakeFetch({
    "/search?query=BCH": { coins: [{ id: "bitcoin-cash", symbol: "BCH" }] },
    "/coins/markets": [{ id: "bitcoin-cash", symbol: "bch", name: "Bitcoin Cash", current_price: 412.5, price_change_percentage_24h: 3.1, market_cap_rank: 21 }],
  }));
  assert.deepEqual(items.map((item) => item.text), ["Bitcoin Cash($BCH) $412.5, 24시간 +3.10%, 시총 21위"]);
});
