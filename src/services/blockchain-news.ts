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

/**
 * 블록체인 뉴스 수집 서비스
 * - CoinGecko API (트렌딩, 마켓 데이터)
 * - 실시간 데이터 기반
 */
export class BlockchainNewsService {
  
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

      const data = await response.json();
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

      const data = await response.json();
      const global = data.data;
      
      const btcDom = global.market_cap_percentage?.btc?.toFixed(1) || "N/A";
      const totalMcap = (global.total_market_cap?.usd / 1e12).toFixed(2);
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

      const data = await response.json();

      return data.map((coin: any) => ({
        symbol: coin.symbol.toUpperCase(),
        name: coin.name,
        price: coin.current_price,
        change24h: coin.price_change_percentage_24h || 0,
      }));
    } catch (error) {
      console.error("⚠️ 마켓 데이터 조회 실패, 기본값 사용");
      // 실패 시 기본값 반환
      return [
        { symbol: "BTC", name: "Bitcoin", price: 100000, change24h: 2.5 },
        { symbol: "ETH", name: "Ethereum", price: 3500, change24h: 1.8 },
        { symbol: "SOL", name: "Solana", price: 180, change24h: 5.2 },
      ];
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
      
      const data = await response.json();
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
