import { assertExternalCallsAllowed } from "../external-call-policy.js";
import type { EditorialContextItemV2 } from "./contracts.js";

/**
 * Free, keyless market data Pixymon can hand to people: what is trending, what moved most among the
 * top 100, what Koreans trade most on Upbit, and a lookup for a coin someone asked about.
 * Every item becomes material, so numbers in a post can only come from here.
 */

const COINGECKO = "https://api.coingecko.com/api/v3";
const UPBIT = "https://api.upbit.com/v1";
const STABLES = new Set(["USDT", "USDC", "DAI", "FDUSD", "USDE", "TUSD", "USDD", "PYUSD", "USDS"]);

type Fetch = typeof fetch;

/** GET JSON with a timeout, three attempts and an explicit 429 backoff; null when it never succeeds. */
export async function fetchJsonV2(url: string, fetchImpl: Fetch = fetch, timeoutMs = 8000): Promise<unknown | null> {
  // The real network is policy-gated; an injected transport (tests) is self-contained.
  if (fetchImpl === globalThis.fetch) assertExternalCallsAllowed("market pulse");
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { signal: controller.signal, headers: { accept: "application/json" } });
      if (response.status === 429) {
        await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
        continue;
      }
      if (!response.ok) return null;
      return await response.json();
    } catch {
      if (attempt === 3) return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

function signed(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function usd(value: number): string {
  return value >= 1 ? `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : `$${value.toPrecision(4)}`;
}

function krwEok(value: number): string {
  return `${Math.round(value / 100_000_000).toLocaleString("en-US")}억원`;
}

interface MarketRow { id: string; symbol: string; name: string; current_price: number; price_change_percentage_24h?: number | null; market_cap_rank?: number | null }

function marketRows(value: unknown): MarketRow[] {
  return Array.isArray(value)
    ? value.filter((row): row is MarketRow => !!row && typeof row.id === "string" && typeof row.symbol === "string" &&
      typeof row.current_price === "number" && Number.isFinite(row.current_price))
    : [];
}

function marketItem(id: string, label: string, row: MarketRow): EditorialContextItemV2 {
  const change = row.price_change_percentage_24h;
  return { id, kind: "market", label, provider: "coingecko",
    text: `${row.name}($${row.symbol.toUpperCase()}) ${usd(row.current_price)}${typeof change === "number" ? `, 24시간 ${signed(change)}` : ""}${row.market_cap_rank ? `, 시총 ${row.market_cap_rank}위` : ""}` };
}

/** Trending searches, biggest movers among the top 100 and Upbit's busiest KRW markets. */
export async function collectMarketPulseV2(fetchImpl: Fetch = fetch): Promise<EditorialContextItemV2[]> {
  const items: EditorialContextItemV2[] = [];
  const [trending, markets, upbit, upbitNames] = await Promise.all([
    fetchJsonV2(`${COINGECKO}/search/trending`, fetchImpl),
    fetchJsonV2(`${COINGECKO}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&price_change_percentage=24h`, fetchImpl),
    fetchJsonV2(`${UPBIT}/ticker/all?quote_currencies=KRW`, fetchImpl),
    fetchJsonV2(`${UPBIT}/market/all?isDetails=false`, fetchImpl),
  ]);
  // Korean names let a post name a coin without spending X's one-cashtag allowance.
  const koreanNames = new Map(Array.isArray(upbitNames)
    ? (upbitNames as Array<{ market?: string; korean_name?: string }>).filter((row) => row.market && row.korean_name).map((row) => [row.market!, row.korean_name!])
    : []);
  const coins = (trending as { coins?: Array<{ item?: { symbol?: string; name?: string; market_cap_rank?: number | null; data?: { price?: number; price_change_percentage_24h?: { usd?: number } } } }> } | null)?.coins ?? [];
  for (const [index, entry] of coins.slice(0, 4).entries()) {
    const item = entry.item;
    if (!item?.symbol || !item.name) continue;
    const change = item.data?.price_change_percentage_24h?.usd;
    items.push({ id: `pulse:trending:${index}`, kind: "market", label: "CoinGecko 검색 트렌딩", provider: "coingecko",
      text: `${item.name}($${item.symbol.toUpperCase()})${item.market_cap_rank ? `, 시총 ${item.market_cap_rank}위` : ""}${typeof change === "number" && Number.isFinite(change) ? `, 24시간 ${signed(change)}` : ""}` });
  }
  const rows = marketRows(markets).filter((row) => !STABLES.has(row.symbol.toUpperCase()) && typeof row.price_change_percentage_24h === "number");
  const sorted = [...rows].sort((a, b) => b.price_change_percentage_24h! - a.price_change_percentage_24h!);
  for (const [index, row] of sorted.slice(0, 2).entries()) items.push(marketItem(`pulse:gainer:${index}`, "시총 상위 100 중 24시간 상승 상위", row));
  for (const [index, row] of sorted.slice(-2).reverse().entries()) items.push(marketItem(`pulse:loser:${index}`, "시총 상위 100 중 24시간 하락 상위", row));
  const tickers = Array.isArray(upbit)
    ? (upbit as Array<{ market?: string; trade_price?: number; acc_trade_price_24h?: number; signed_change_rate?: number }>)
      .filter((row) => typeof row.market === "string" && typeof row.acc_trade_price_24h === "number" && typeof row.trade_price === "number")
    : [];
  for (const [index, row] of [...tickers].sort((a, b) => b.acc_trade_price_24h! - a.acc_trade_price_24h!).slice(0, 3).entries()) {
    items.push({ id: `pulse:upbit:${index}`, kind: "market", label: "업비트 원화 거래대금 상위(24시간)", provider: "upbit",
      text: `${koreanNames.get(row.market!) ? `${koreanNames.get(row.market!)}(${row.market!.replace("KRW-", "$")})` : row.market!.replace("KRW-", "$")} ${row.trade_price!.toLocaleString("en-US")}원, 거래대금 ${krwEok(row.acc_trade_price_24h!)}${typeof row.signed_change_rate === "number" ? `, ${signed(row.signed_change_rate * 100)}` : ""}` });
  }
  return items;
}

/** Coins someone named ($BCH, BCH, 비트코인캐시…): looked up by symbol, best market-cap match first. */
export async function lookupMentionedCoinsV2(text: string, fetchImpl: Fetch = fetch, limit = 2): Promise<EditorialContextItemV2[]> {
  const symbols = [...new Set([...text.matchAll(/(?<![A-Za-z0-9@_])\$?([A-Za-z]{2,10})(?![A-Za-z0-9])/gu)]
    .map((match) => match[1].toUpperCase())
    .filter((symbol) => /^[A-Z]+$/u.test(symbol) && !["PIXY", "MON", "AI", "OK", "LOL", "KOL", "DM", "X"].includes(symbol)))].slice(0, limit);
  const items: EditorialContextItemV2[] = [];
  for (const symbol of symbols) {
    const search = await fetchJsonV2(`${COINGECKO}/search?query=${encodeURIComponent(symbol)}`, fetchImpl) as { coins?: Array<{ id?: string; symbol?: string }> } | null;
    const match = search?.coins?.find((coin) => coin.symbol?.toUpperCase() === symbol);
    if (!match?.id) continue;
    const [row] = marketRows(await fetchJsonV2(`${COINGECKO}/coins/markets?vs_currency=usd&ids=${encodeURIComponent(match.id)}&price_change_percentage=24h`, fetchImpl));
    if (row) items.push(marketItem(`lookup:${symbol.toLowerCase()}`, `요청받은 코인 ${symbol}`, row));
  }
  return items;
}
