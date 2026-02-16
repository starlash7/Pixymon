/**
 * 블록체인 뉴스 아이템 타입
 */
export interface NewsItem {
  title: string;
  summary: string;
  source: string;
  category: string;
  importance: "high" | "medium" | "low";
  url?: string;
}

/**
 * 마켓 데이터 타입
 */
export interface MarketData {
  symbol: string;
  name: string;
  price: number;
  change24h: number;
}

/**
 * CoinGecko 트렌딩 코인 타입
 */
interface TrendingCoin {
  item: {
    id: string;
    name: string;
    symbol: string;
    market_cap_rank: number;
    price_btc: number;
    data: {
      price_change_percentage_24h: { usd: number };
    };
  };
}

interface CryptoCompareArticle {
  title: string;
  body?: string;
  source_info?: { name?: string };
  url?: string;
}

interface CryptoCompareNewsResponse {
  Data?: CryptoCompareArticle[];
}

interface CoinGeckoTrendingResponse {
  coins?: TrendingCoin[];
}

interface CoinGeckoGlobalResponse {
  data?: {
    market_cap_percentage?: { btc?: number };
    total_market_cap?: { usd?: number };
    market_cap_change_percentage_24h_usd?: number;
  };
}

interface CoinGeckoMarketCoin {
  symbol: string;
  name: string;
  current_price: number;
  price_change_percentage_24h?: number;
}

type CoinGeckoSimplePriceResponse = Record<
  string,
  {
    usd?: number;
    usd_24h_change?: number;
  }
>;

interface FearGreedApiResponse {
  data?: Array<{
    value: string;
    value_classification: string;
  }>;
}

let lastKnownMarketData: MarketData[] = [];

/**
 * 블록체인 뉴스 수집 서비스
 * - CoinGecko API (트렌딩, 마켓 데이터)
 * - CryptoPanic API (실시간 뉴스)
 * - 실시간 데이터 기반
 */
export class BlockchainNewsService {
  
  /**
   * CryptoCompare 뉴스 가져오기 (무료 API)
   */
  async getCryptoNews(limit: number = 10): Promise<NewsItem[]> {
    console.log("[FETCH] 크립토 뉴스 수집 중...");

    try {
      // CryptoCompare 무료 뉴스 API
      const response = await fetch(
        `https://min-api.cryptocompare.com/data/v2/news/?lang=EN&sortOrder=popular`
      );

      if (!response.ok) {
        throw new Error(`CryptoCompare API error: ${response.status}`);
      }

      const data = (await response.json()) as CryptoCompareNewsResponse;
      const articles = data.Data?.slice(0, limit) || [];

      return articles.map((article: any, index: number) => ({
        title: article.title,
        summary: article.body?.substring(0, 100) || "",
        source: article.source_info?.name || "CryptoCompare",
        category: "news",
        importance: index < 3 ? "high" : "medium",
        url: article.url,
      }));
    } catch (error) {
      console.error("[WARN] 크립토 뉴스 API 실패");
      return [];
    }
  }

  /**
   * CoinGecko 트렌딩 코인 기반 핫이슈 생성
   */
  async getTodayHotNews(): Promise<NewsItem[]> {
    console.log("[FETCH] 트렌딩 데이터 수집 중...");

    try {
      // CoinGecko 트렌딩 API (무료, 키 불필요)
      const response = await fetch(
        "https://api.coingecko.com/api/v3/search/trending"
      );

      if (!response.ok) {
        throw new Error(`CoinGecko API error: ${response.status}`);
      }

      const data = (await response.json()) as CoinGeckoTrendingResponse;
      const trendingCoins: TrendingCoin[] = data.coins?.slice(0, 5) || [];

      // 트렌딩 코인을 뉴스 형식으로 변환
      const news: NewsItem[] = trendingCoins.map((coin, index) => {
        const change = coin.item.data?.price_change_percentage_24h?.usd || 0;
        const direction = change >= 0 ? "상승" : "하락";
        
        return {
          title: `${coin.item.name} (${coin.item.symbol.toUpperCase()}) 트렌딩 ${index + 1}위`,
          summary: `24h ${direction} ${Math.abs(change).toFixed(1)}% | 시총 순위 #${coin.item.market_cap_rank || "N/A"}`,
          source: "CoinGecko Trending",
          category: "trending",
          importance: index < 2 ? "high" : "medium",
        };
      });

      // 글로벌 마켓 상태 추가
      const globalNews = await this.getGlobalMarketNews();
      if (globalNews) {
        news.unshift(globalNews);
      }

      return news.slice(0, 5);
    } catch (error) {
      console.error("[WARN] 트렌딩 데이터 실패, 마켓 데이터만 사용");
      
      // 실패 시 마켓 데이터 기반 뉴스 생성
      return this.getMarketBasedNews();
    }
  }

  /**
   * 글로벌 마켓 상태 뉴스
   */
  async getGlobalMarketNews(): Promise<NewsItem | null> {
    try {
      const response = await fetch(
        "https://api.coingecko.com/api/v3/global"
      );

      if (!response.ok) return null;

      const data = (await response.json()) as CoinGeckoGlobalResponse;
      const global = data.data;
      if (!global) return null;

      const totalMcapUsd = global.total_market_cap?.usd;
      if (typeof totalMcapUsd !== "number") return null;
      
      const btcDom = typeof global.market_cap_percentage?.btc === "number"
        ? global.market_cap_percentage.btc.toFixed(1)
        : "N/A";
      const totalMcap = (totalMcapUsd / 1e12).toFixed(2);
      const mcapChange = global.market_cap_change_percentage_24h_usd?.toFixed(1) || "0";

      return {
        title: `크립토 시총 $${totalMcap}T | BTC 도미넌스 ${btcDom}%`,
        summary: `24h 시총 변화: ${parseFloat(mcapChange) >= 0 ? "+" : ""}${mcapChange}%`,
        source: "CoinGecko Global",
        category: "market",
        importance: "high",
      };
    } catch {
      return null;
    }
  }

  /**
   * 마켓 데이터 기반 뉴스 생성 (폴백)
   */
  async getMarketBasedNews(): Promise<NewsItem[]> {
    const marketData = await this.getMarketData();
    
    return marketData.slice(0, 3).map((coin, index) => ({
      title: `${coin.name} $${coin.price.toLocaleString()}`,
      summary: `24h ${coin.change24h >= 0 ? "+" : ""}${coin.change24h.toFixed(1)}%`,
      source: "CoinGecko",
      category: coin.symbol.toLowerCase(),
      importance: index === 0 ? "high" : "medium",
    }));
  }

  /**
   * 실시간 마켓 데이터 조회 (CoinGecko API)
   */
  async getMarketData(): Promise<MarketData[]> {
    console.log("📊 마켓 데이터 조회 중...");

    try {
      const response = await fetch(
        "https://api.coingecko.com/api/v3/coins/markets?" +
          new URLSearchParams({
            vs_currency: "usd",
            order: "market_cap_desc",
            per_page: "5",
            page: "1",
            sparkline: "false",
            price_change_percentage: "24h",
          })
      );

      if (!response.ok) {
        throw new Error(`CoinGecko API error: ${response.status}`);
      }

      const data = (await response.json()) as CoinGeckoMarketCoin[];
      const normalized = data.map((coin) => ({
        symbol: coin.symbol.toUpperCase(),
        name: coin.name,
        price: coin.current_price,
        change24h: coin.price_change_percentage_24h || 0,
      }));
      lastKnownMarketData = normalized;
      return normalized;
    } catch (error) {
      if (lastKnownMarketData.length > 0) {
        console.error("⚠️ 마켓 데이터 조회 실패, 마지막 성공 스냅샷 사용");
        return lastKnownMarketData.map((coin) => ({ ...coin }));
      }
      console.error("⚠️ 마켓 데이터 조회 실패, 스냅샷 없음");
      return [];
    }
  }

  /**
   * 특정 코인 가격 조회 (심볼로)
   */
  async getCoinPrice(symbol: string): Promise<{ price: number; change24h: number } | null> {
    try {
      // CoinGecko ID 매핑 (주요 코인들)
      const idMap: Record<string, string> = {
        BTC: "bitcoin",
        ETH: "ethereum",
        SOL: "solana",
        XRP: "ripple",
        BNB: "binancecoin",
        ADA: "cardano",
        DOGE: "dogecoin",
        AVAX: "avalanche-2",
        DOT: "polkadot",
        MATIC: "matic-network",
        LINK: "chainlink",
        SHIB: "shiba-inu",
        LTC: "litecoin",
        ATOM: "cosmos",
        UNI: "uniswap",
        ARB: "arbitrum",
        OP: "optimism",
        APT: "aptos",
        SUI: "sui",
        PEPE: "pepe",
      };

      const coinId = idMap[symbol.toUpperCase()];
      if (!coinId) {
        console.log(`[PRICE] ${symbol} ID 매핑 없음`);
        return null;
      }

      const response = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd&include_24hr_change=true`
      );

      if (!response.ok) return null;

      const data = (await response.json()) as CoinGeckoSimplePriceResponse;
      const coinData = data[coinId];

      if (!coinData) return null;
      if (typeof coinData.usd !== "number") return null;

      return {
        price: coinData.usd,
        change24h: coinData.usd_24h_change || 0,
      };
    } catch (error) {
      console.error(`[PRICE] ${symbol} 조회 실패:`, error);
      return null;
    }
  }

  /**
   * 뉴스를 트윗 형식으로 포맷팅
   */
  formatNewsForTweet(news: NewsItem[], marketData: MarketData[]): string {
    let text = "";

    // 글로벌/마켓 뉴스 (첫 번째)
    const marketNews = news.find(n => n.category === "market");
    if (marketNews) {
      text += `${marketNews.title}\n${marketNews.summary}\n\n`;
    }

    // Top 3 마켓 데이터
    text += "주요 코인:\n";
    marketData.slice(0, 3).forEach((coin) => {
      const sign = coin.change24h >= 0 ? "+" : "";
      text += `${coin.symbol}: $${coin.price.toLocaleString()} (${sign}${coin.change24h.toFixed(1)}%)\n`;
    });

    // 트렌딩 코인
    const trending = news.filter(n => n.category === "trending").slice(0, 3);
    if (trending.length > 0) {
      text += "\n트렌딩:\n";
      trending.forEach((item, index) => {
        text += `${index + 1}. ${item.title.split(" 트렌딩")[0]}\n`;
      });
    }

    return text;
  }

  /**
   * Fear & Greed Index 조회
   */
  async getFearGreedIndex(): Promise<{ value: number; label: string } | null> {
    try {
      const response = await fetch(
        "https://api.alternative.me/fng/?limit=1"
      );
      
      if (!response.ok) return null;
      
      const data = (await response.json()) as FearGreedApiResponse;
      const fng = data.data?.[0];
      
      return fng ? {
        value: parseInt(fng.value),
        label: fng.value_classification
      } : null;
    } catch {
      return null;
    }
  }
}

export default BlockchainNewsService;
