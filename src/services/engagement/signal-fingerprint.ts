import crypto from "crypto";

interface SignalFingerprintInput {
  marketContext: string;
  onchainContext: string;
  trendSummary?: string;
  focusHeadline?: string;
}

interface SignalFingerprintResult {
  key: string;
  signature: string;
}

const MARKET_PRIORITY = ["BTC", "ETH", "SOL"];
const TOKEN_STOP_WORDS = new Set([
  "today",
  "market",
  "markets",
  "news",
  "crypto",
  "coin",
  "coins",
  "blockchain",
  "트렌드",
  "시장",
  "뉴스",
  "코인",
]);

export function buildSignalFingerprint(input: SignalFingerprintInput): SignalFingerprintResult {
  const fearGreedRegime = extractFearGreedRegime(input.marketContext);
  const marketRegime = extractMarketRegime(input.marketContext);
  const onchainRegime = extractOnchainRegime(input.onchainContext);
  const focusRegime = extractFocusRegime(input.focusHeadline, input.trendSummary);
  const signature = [fearGreedRegime, marketRegime, onchainRegime, focusRegime].join("|");
  const key = crypto.createHash("sha1").update(signature).digest("hex").slice(0, 16);
  return { key, signature };
}

function extractFearGreedRegime(marketContext: string): string {
  const match = marketContext.match(/FearGreed\s+(\d{1,3})/i);
  if (!match) return "fg:na";
  const value = Number.parseInt(match[1], 10);
  if (!Number.isFinite(value)) return "fg:na";
  if (value < 20) return "fg:extreme-fear";
  if (value < 40) return "fg:fear";
  if (value < 60) return "fg:neutral";
  if (value < 80) return "fg:greed";
  return "fg:extreme-greed";
}

function extractMarketRegime(marketContext: string): string {
  const rows = marketContext
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "));
  const parsed: Array<{ symbol: string; changeBucket: string }> = [];
  for (const row of rows) {
    const match = row.match(/^-+\s*([A-Z0-9]{2,10})\s+\$[\d,]+(?:\.\d+)?\s+\(([+-]?\d+(?:\.\d+)?)%\)/);
    if (!match) continue;
    const symbol = match[1].toUpperCase();
    const change = Number.parseFloat(match[2]);
    parsed.push({ symbol, changeBucket: toChangeBucket(change) });
  }
  if (parsed.length === 0) return "market:na";

  const prioritized = [
    ...MARKET_PRIORITY.flatMap((symbol) => parsed.filter((row) => row.symbol === symbol)),
    ...parsed.filter((row) => !MARKET_PRIORITY.includes(row.symbol)),
  ].slice(0, 3);

  return `market:${prioritized.map((row) => `${row.symbol}-${row.changeBucket}`).join(",")}`;
}

function extractOnchainRegime(onchainContext: string): string {
  const rows = onchainContext
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- ") && line.includes(":"))
    .slice(0, 6);
  if (rows.length === 0) return "onchain:na";

  const signals = rows
    .map((line) => {
      const match = line.match(/^-+\s*([^:]+):\s*([^|]+)(?:\||$)/);
      if (!match) return null;
      const label = normalizeLabel(match[1]);
      const valueBucket = normalizeValueBucket(match[2]);
      return `${label}-${valueBucket}`;
    })
    .filter((item): item is string => Boolean(item))
    .slice(0, 4);

  if (signals.length === 0) return "onchain:na";
  return `onchain:${signals.join(",")}`;
}

function extractFocusRegime(focusHeadline?: string, trendSummary?: string): string {
  const candidate = String(focusHeadline || trendSummary || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}\s$-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!candidate) return "focus:na";

  const words = (candidate.match(/[a-z][a-z0-9-]{2,}|[가-힣]{2,}/g) || [])
    .filter((word) => !TOKEN_STOP_WORDS.has(word))
    .slice(0, 8);
  if (words.length === 0) return "focus:na";
  const unique = [...new Set(words)].slice(0, 2);
  return `focus:${unique.join(",")}`;
}

function toChangeBucket(change: number): string {
  if (!Number.isFinite(change)) return "na";
  if (change >= 3) return "up-strong";
  if (change >= 0.5) return "up-mild";
  if (change <= -3) return "down-strong";
  if (change <= -0.5) return "down-mild";
  return "flat";
}

function normalizeLabel(label: string): string {
  const lower = label.trim().toLowerCase();
  if (/수수료|fee/.test(lower)) return "fee";
  if (/멤풀|mempool/.test(lower)) return "mempool";
  if (/순유입|netflow|exchange/.test(lower)) return "exchange";
  if (/고래|whale|대형/.test(lower)) return "whale";
  if (/스테이블|stable/.test(lower)) return "stable";
  if (/tvl/.test(lower)) return "tvl";
  return lower
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, "-")
    .slice(0, 16);
}

function normalizeValueBucket(value: string): string {
  const text = value.toLowerCase().replace(/\s+/g, " ").trim();
  if (!text) return "na";

  const satMatch = text.match(/(\d+(?:\.\d+)?)\s*sat\/vb/);
  if (satMatch) {
    const sat = Number.parseFloat(satMatch[1]);
    if (!Number.isFinite(sat)) return "fee-na";
    if (sat <= 10) return "fee-low";
    if (sat <= 30) return "fee-mid";
    return "fee-high";
  }

  const txMatch = text.match(/([\d,]+)\s*tx/);
  if (txMatch) {
    const tx = Number.parseInt(txMatch[1].replace(/,/g, ""), 10);
    if (!Number.isFinite(tx)) return "tx-na";
    if (tx < 80000) return "tx-low";
    if (tx < 160000) return "tx-mid";
    return "tx-high";
  }

  const pctMatch = text.match(/([+-]?\d+(?:\.\d+)?)\s*%/);
  if (pctMatch) {
    const pct = Number.parseFloat(pctMatch[1]);
    if (!Number.isFinite(pct)) return "pct-na";
    const abs = Math.abs(pct);
    const scale = abs >= 25 ? "high" : abs >= 5 ? "mid" : "low";
    return `${pct >= 0 ? "up" : "down"}-${scale}`;
  }

  const usdMatch = text.match(/([+-]?)\$(\d+(?:\.\d+)?)([kmbt])?/);
  if (usdMatch) {
    const sign = usdMatch[1] === "-" ? "down" : "up";
    const amount = Number.parseFloat(usdMatch[2]);
    const unit = usdMatch[3] || "";
    if (!Number.isFinite(amount)) return "usd-na";
    if (unit === "t" || unit === "b") return `${sign}-usd-large`;
    if (unit === "m") return `${sign}-usd-mid`;
    return `${sign}-usd-small`;
  }

  const compact = text
    .replace(/\d[\d,]*(?:\.\d+)?/g, " num ")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, "-")
    .slice(0, 18);
  return compact || "na";
}
