import { TwitterApi } from "twitter-api-v2";
import Anthropic from "@anthropic-ai/sdk";
import { BlockchainNewsService } from "./blockchain-news.js";
import { memory } from "./memory.js";
import { generateNewsSummary } from "./llm.js";
import { getInfluencerTweets, postTweet, TEST_MODE } from "./twitter.js";
import { detectMood } from "../utils/mood.js";

// 마켓 브리핑 포스팅
export async function postMarketBriefing(
  twitter: TwitterApi | null,
  claude: Anthropic,
  newsService: BlockchainNewsService,
  timeSlot: "morning" | "evening" = "morning"
) {
  const now = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
  const slotLabel = timeSlot === "morning" ? "모닝 브리핑" : "이브닝 리캡";
  console.log(`\n[${now}] ${slotLabel} 시작...`);

  try {
    // 기본 마켓 데이터 수집
    const [news, marketData, fng, cryptoNews] = await Promise.all([
      newsService.getTodayHotNews(),
      newsService.getMarketData(),
      newsService.getFearGreedIndex(),
      newsService.getCryptoNews(5)
    ]);

    // 인플루언서 트윗 수집 (알파/밈 정보)
    let influencerContent = "";
    if (twitter && !TEST_MODE) {
      console.log("[FETCH] 인플루언서 트윗 수집 중...");
      influencerContent = await getInfluencerTweets(twitter, 5);
    }

    // Pixymon 무드 감지
    const btcData = marketData?.find((c: any) => c.symbol === "btc");
    const priceChange24h = btcData?.change24h;
    const { mood, moodText } = detectMood(fng?.value, priceChange24h);
    console.log(`[MOOD] ${mood} - F&G: ${fng?.value}, BTC 24h: ${priceChange24h?.toFixed(1)}%`);

    let newsText = newsService.formatNewsForTweet(news, marketData);

    if (fng) {
      newsText += `\nFear & Greed: ${fng.value} (${fng.label})`;
    }

    if (cryptoNews.length > 0) {
      newsText += "\n\n핫뉴스:\n";
      cryptoNews.slice(0, 3).forEach((item, i) => {
        newsText += `${i + 1}. ${item.title}\n`;
      });
    }

    // 인플루언서 알파 추가
    if (influencerContent) {
      newsText += "\n\n인플루언서 동향 (알파/밈):\n";
      newsText += influencerContent;
    }

    // 메모리 컨텍스트 추가 (중복 방지용)
    const memoryContext = memory.getContext();
    newsText += `\n\n${memoryContext}`;

    console.log("[DATA] 수집 완료");

    // 트윗 생성 (무드 반영)
    let summary = await generateNewsSummary(claude, newsText, timeSlot, moodText);

    // 중복 체크
    const { isDuplicate, similarTweet } = memory.checkDuplicate(summary);
    if (isDuplicate && similarTweet) {
      console.log("[WARN] 유사한 트윗 감지, 재생성 시도...");
      console.log(`  └─ 유사 트윗: "${similarTweet.content.substring(0, 40)}..."`);

      // 다시 생성 (다른 앵글로)
      newsText += "\n\n주의: 방금 생성한 내용이 최근 트윗과 너무 유사함. 완전히 다른 앵글로 작성할 것. 또는 나의 상태/성장에 대해 말해볼 것.";
      summary = await generateNewsSummary(claude, newsText, timeSlot, moodText);
    }

    console.log("[POST] " + summary.substring(0, 50) + "...");

    const tweetId = await postTweet(twitter, summary);

    // 코인 예측 저장 (가격 추적용)
    if (tweetId && marketData) {
      const coins = summary.match(/\$([A-Z]{2,10})/g) || [];
      for (const coin of coins) {
        const symbol = coin.replace("$", "").toUpperCase();
        const coinData = marketData.find((c: any) => c.symbol.toUpperCase() === symbol);
        if (coinData) {
          memory.savePrediction(coin, coinData.price, tweetId);
        }
      }
    }
  } catch (error) {
    console.error("[ERROR] 마켓 브리핑 실패:", error);
  }
}
