/**
 * Pixymon 타입 정의
 */

/**
 * 뉴스 카테고리
 */
export type NewsCategory =
  | "defi"
  | "nft"
  | "layer2"
  | "bitcoin"
  | "ethereum"
  | "altcoin"
  | "regulation"
  | "general";

/**
 * 뉴스 중요도
 */
export type NewsImportance = "high" | "medium" | "low";

/**
 * 뉴스 아이템 인터페이스
 */
export interface NewsItem {
  id?: string;
  title: string;
  summary: string;
  source: string;
  url: string;
  category: NewsCategory;
  importance: NewsImportance;
  publishedAt: Date;
  tags?: string[];
}

/**
 * 마켓 데이터 인터페이스
 */
export interface MarketData {
  symbol: string;
  name: string;
  price: number;
  change24h: number;
  change7d?: number;
  marketCap: number;
  volume24h?: number;
}

/**
 * 에이전트 설정
 */
export interface AgentConfig {
  // Twitter 설정
  twitter: {
    username: string;
    password: string;
    apiKey: string;
    apiSecret: string;
    accessToken: string;
    accessSecret: string;
  };

  // Anthropic 설정
  anthropic: {
    apiKey: string;
    model?: string;
    maxTokens?: number;
    temperature?: number;
  };

  // 스케줄러 설정
  scheduler: {
    postingHours: number[];
    timezone?: string;
  };

  // 뉴스 소스 설정
  newsSources?: {
    coinGeckoApiKey?: string;
    etherscanApiKey?: string;
  };
}

/**
 * 트윗 컨텐츠
 */
export interface TweetContent {
  text: string;
  mediaUrls?: string[];
  replyToId?: string;
  threadId?: string;
}

/**
 * 질문 컨텍스트
 */
export interface QuestionContext {
  question: string;
  userId: string;
  tweetId: string;
  relatedNews?: NewsItem[];
  relatedMarketData?: MarketData[];
  previousConversation?: string[];
}

/**
 * 답변 결과
 */
export interface AnswerResult {
  success: boolean;
  answer: string;
  sources?: string[];
  confidence?: number;
  error?: string;
}
