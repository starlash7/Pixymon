/**
 * 블록체인 뉴스 아이템 타입
 */
export interface NewsItem {
  title: string;
  summary: string;
  source: string;
  category: string;
  importance: "high" | "medium" | "low";
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
 * 블록체인 뉴스 수집 서비스
 */
export class BlockchainNewsService {
  /**
   * 오늘의 핫이슈 수집
   */
  async getTodayHotNews(): Promise<NewsItem[]> {
    console.log("📰 블록체인 뉴스 수집 중...");

    // TODO: 실제 뉴스 API 연동 (CoinDesk, The Block 등)
    // 현재는 예시 데이터
    const news: NewsItem[] = [
      {
        title: "Bitcoin ETF 거래량 사상 최고치 기록",
        summary: "미국 Bitcoin 현물 ETF의 일일 거래량이 50억 달러를 돌파",
        source: "CoinDesk",
        category: "bitcoin",
        importance: "high",
      },
      {
        title: "Ethereum Dencun 업그레이드 성공",
        summary: "이더리움 레이어2 가스비 90% 절감 예상",
        source: "The Block",
        category: "ethereum",
        importance: "high",
      },
      {
        title: "Solana DeFi TVL 사상 최고치",
        summary: "솔라나 생태계 TVL 100억 달러 돌파",
        source: "DeFi Llama",
        category: "defi",
        importance: "medium",
      },
    ];

    return news;
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
    const today = new Date().toLocaleDateString("ko-KR", {
      month: "numeric",
      day: "numeric",
    });

    let text = `📅 ${today} 블록체인 핫이슈\n\n`;

    // 뉴스 항목
    news.slice(0, 3).forEach((item, index) => {
      text += `${index + 1}. ${item.title}\n`;
    });

    // 마켓 데이터
    text += "\n📊 마켓:\n";
    marketData.slice(0, 3).forEach((coin) => {
      const emoji = coin.change24h >= 0 ? "📈" : "📉";
      const sign = coin.change24h >= 0 ? "+" : "";
      text += `${coin.symbol}: $${coin.price.toLocaleString()} ${emoji}${sign}${coin.change24h.toFixed(1)}%\n`;
    });

    return text;
  }
}

export default BlockchainNewsService;
