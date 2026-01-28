import fs from "fs";
import path from "path";

/**
 * Pixymon Memory Service
 * 로컬 JSON 파일 기반 메모리 시스템
 * - 트윗 기록 저장
 * - 코인 예측 추적
 * - 팔로워 상호작용 기억
 * - 중복 방지
 */

// 데이터 디렉토리
const DATA_DIR = path.join(process.cwd(), "data");

// 데이터 타입 정의
interface Tweet {
  id: string;
  content: string;
  timestamp: string;
  type: "briefing" | "reply" | "quote";
  coins?: string[];  // 언급된 코인들
}

interface Prediction {
  coin: string;
  mentionedAt: string;
  priceAtMention: number;
  tweetId: string;
  followedUp: boolean;
  followUpResult?: {
    priceAfter: number;
    changePercent: number;
    checkedAt: string;
  };
}

interface Follower {
  userId: string;
  username: string;
  mentionCount: number;
  lastMention: string;
  sentiment: "positive" | "neutral" | "negative";
}

interface MemoryData {
  tweets: Tweet[];
  predictions: Prediction[];
  followers: Record<string, Follower>;
  lastProcessedMentionId?: string;  // 마지막 처리한 멘션 ID
  repliedTweets: string[];  // 댓글 단 트윗 ID들 (중복 방지)
  lastUpdated: string;
}

// 초기 데이터
const EMPTY_MEMORY: MemoryData = {
  tweets: [],
  predictions: [],
  followers: {},
  repliedTweets: [],
  lastUpdated: new Date().toISOString(),
};

export class MemoryService {
  private data: MemoryData;
  private dataPath: string;

  constructor() {
    this.dataPath = path.join(DATA_DIR, "memory.json");
    this.data = this.load();
  }

  // 데이터 로드
  private load(): MemoryData {
    try {
      // 디렉토리 없으면 생성
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        console.log("[MEMORY] 데이터 디렉토리 생성됨");
      }

      // 파일 없으면 초기화
      if (!fs.existsSync(this.dataPath)) {
        this.save(EMPTY_MEMORY);
        console.log("[MEMORY] 새 메모리 파일 생성됨");
        return EMPTY_MEMORY;
      }

      const raw = fs.readFileSync(this.dataPath, "utf-8");
      const data = JSON.parse(raw) as MemoryData;
      console.log(`[MEMORY] 로드됨 - 트윗: ${data.tweets.length}, 예측: ${data.predictions.length}`);
      return data;
    } catch (error) {
      console.error("[MEMORY] 로드 실패, 초기화:", error);
      return EMPTY_MEMORY;
    }
  }

  // 데이터 저장
  private save(data?: MemoryData): void {
    try {
      const toSave = data || this.data;
      toSave.lastUpdated = new Date().toISOString();
      fs.writeFileSync(this.dataPath, JSON.stringify(toSave, null, 2));
    } catch (error) {
      console.error("[MEMORY] 저장 실패:", error);
    }
  }

  // ============================================
  // 트윗 기록
  // ============================================

  // 트윗 저장
  saveTweet(id: string, content: string, type: Tweet["type"] = "briefing"): void {
    // 코인 티커 추출 ($BTC, $ETH 등)
    const coins = this.extractCoins(content);

    const tweet: Tweet = {
      id,
      content,
      timestamp: new Date().toISOString(),
      type,
      coins,
    };

    this.data.tweets.push(tweet);

    // 최근 100개만 유지
    if (this.data.tweets.length > 100) {
      this.data.tweets = this.data.tweets.slice(-100);
    }

    this.save();
    console.log(`[MEMORY] 트윗 저장됨: ${id}`);

    // 코인 언급 시 예측으로 기록
    if (coins.length > 0) {
      // 예측 저장은 별도로 처리 (가격 정보 필요)
    }
  }

  // 최근 트윗 가져오기
  getRecentTweets(count: number = 10): Tweet[] {
    return this.data.tweets.slice(-count);
  }

  // 코인 티커 추출
  private extractCoins(content: string): string[] {
    const regex = /\$([A-Z]{2,10})/g;
    const matches = content.match(regex) || [];
    return [...new Set(matches.map(m => m.toUpperCase()))];
  }

  // ============================================
  // 중복 방지
  // ============================================

  // 유사도 체크 (간단한 단어 겹침 기반)
  checkDuplicate(newContent: string, threshold: number = 0.6): { isDuplicate: boolean; similarTweet?: Tweet } {
    const recentTweets = this.getRecentTweets(20);
    const newWords = this.getWords(newContent);

    for (const tweet of recentTweets) {
      const existingWords = this.getWords(tweet.content);
      const similarity = this.calculateSimilarity(newWords, existingWords);

      if (similarity > threshold) {
        return { isDuplicate: true, similarTweet: tweet };
      }
    }

    return { isDuplicate: false };
  }

  // 단어 추출 (불용어 제거)
  private getWords(text: string): Set<string> {
    const stopWords = new Set(["the", "a", "an", "is", "are", "was", "were", "by", "for", "to", "of", "and", "in", "on", "at"]);
    const words = text
      .toLowerCase()
      .replace(/[^\w\s$]/g, "")
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w));
    return new Set(words);
  }

  // Jaccard 유사도
  private calculateSimilarity(set1: Set<string>, set2: Set<string>): number {
    const intersection = new Set([...set1].filter(x => set2.has(x)));
    const union = new Set([...set1, ...set2]);
    return intersection.size / union.size;
  }

  // ============================================
  // 예측 추적
  // ============================================

  // 코인 예측 저장
  savePrediction(coin: string, price: number, tweetId: string): void {
    const prediction: Prediction = {
      coin: coin.toUpperCase(),
      mentionedAt: new Date().toISOString(),
      priceAtMention: price,
      tweetId,
      followedUp: false,
    };

    this.data.predictions.push(prediction);

    // 최근 50개만 유지
    if (this.data.predictions.length > 50) {
      this.data.predictions = this.data.predictions.slice(-50);
    }

    this.save();
    console.log(`[MEMORY] 예측 저장: ${coin} @ $${price}`);
  }

  // 팔로업 안 된 예측 가져오기
  getPendingPredictions(hoursAgo: number = 24): Prediction[] {
    const cutoff = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);
    
    return this.data.predictions.filter(p => 
      !p.followedUp && 
      new Date(p.mentionedAt) < cutoff
    );
  }

  // 예측 결과 업데이트
  updatePrediction(coin: string, currentPrice: number): Prediction | null {
    const prediction = this.data.predictions.find(p => 
      p.coin === coin.toUpperCase() && !p.followedUp
    );

    if (!prediction) return null;

    const changePercent = ((currentPrice - prediction.priceAtMention) / prediction.priceAtMention) * 100;

    prediction.followedUp = true;
    prediction.followUpResult = {
      priceAfter: currentPrice,
      changePercent: Math.round(changePercent * 100) / 100,
      checkedAt: new Date().toISOString(),
    };

    this.save();
    console.log(`[MEMORY] 예측 업데이트: ${coin} ${changePercent > 0 ? "+" : ""}${changePercent.toFixed(2)}%`);

    return prediction;
  }

  // ============================================
  // 팔로워 기억
  // ============================================

  // 멘션 기록
  recordMention(userId: string, username: string): void {
    if (!this.data.followers[userId]) {
      this.data.followers[userId] = {
        userId,
        username,
        mentionCount: 0,
        lastMention: "",
        sentiment: "neutral",
      };
    }

    this.data.followers[userId].mentionCount++;
    this.data.followers[userId].lastMention = new Date().toISOString();
    this.data.followers[userId].username = username; // 이름 변경 대응

    this.save();
  }

  // 팔로워 정보 가져오기
  getFollower(userId: string): Follower | null {
    return this.data.followers[userId] || null;
  }

  // 자주 멘션하는 팔로워 (VIP)
  getTopFollowers(count: number = 10): Follower[] {
    return Object.values(this.data.followers)
      .sort((a, b) => b.mentionCount - a.mentionCount)
      .slice(0, count);
  }

  // ============================================
  // 컨텍스트 생성 (Claude에게 전달)
  // ============================================

  // 최근 활동 요약
  getContext(): string {
    const recentTweets = this.getRecentTweets(5);
    const recentPredictions = this.data.predictions.slice(-5);

    let context = "## 내 기억 (참고용, 강제로 언급할 필요 없음)\n\n";

    // 최근 트윗 (중복 방지)
    if (recentTweets.length > 0) {
      context += "### 최근 내 트윗 (비슷한 내용 피하기)\n";
      recentTweets.forEach(t => {
        context += `- ${t.content.substring(0, 60)}...\n`;
      });
      context += "\n";
    }

    // 과거에 언급한 코인들 (자연스럽게 연결 가능)
    if (recentPredictions.length > 0) {
      context += "### 전에 언급한 코인 (관련 있으면 자연스럽게 연결해도 됨)\n";
      recentPredictions.forEach(p => {
        const daysAgo = Math.floor((Date.now() - new Date(p.mentionedAt).getTime()) / (1000 * 60 * 60 * 24));
        const timeAgo = daysAgo === 0 ? "오늘" : daysAgo === 1 ? "어제" : `${daysAgo}일 전`;
        context += `- ${p.coin} ${timeAgo} $${p.priceAtMention.toLocaleString()}에 언급\n`;
      });
      context += "\n";
    }

    return context;
  }

  // 통계
  getStats(): { tweets: number; predictions: number; followers: number } {
    return {
      tweets: this.data.tweets.length,
      predictions: this.data.predictions.length,
      followers: Object.keys(this.data.followers).length,
    };
  }

  // ============================================
  // 멘션 ID 추적 (중복 답글 방지)
  // ============================================

  // 마지막 처리한 멘션 ID 가져오기
  getLastProcessedMentionId(): string | undefined {
    return this.data.lastProcessedMentionId;
  }

  // 마지막 처리한 멘션 ID 저장
  setLastProcessedMentionId(mentionId: string): void {
    this.data.lastProcessedMentionId = mentionId;
    this.save();
    console.log(`[MEMORY] 마지막 멘션 ID 저장: ${mentionId}`);
  }

  // ============================================
  // 댓글 단 트윗 추적 (프로액티브 인게이지먼트)
  // ============================================

  // 이미 댓글 달았는지 확인
  hasRepliedTo(tweetId: string): boolean {
    if (!this.data.repliedTweets) {
      this.data.repliedTweets = [];
    }
    return this.data.repliedTweets.includes(tweetId);
  }

  // 댓글 단 트윗 저장
  saveRepliedTweet(tweetId: string): void {
    if (!this.data.repliedTweets) {
      this.data.repliedTweets = [];
    }
    this.data.repliedTweets.push(tweetId);
    
    // 최근 500개만 유지 (메모리 관리)
    if (this.data.repliedTweets.length > 500) {
      this.data.repliedTweets = this.data.repliedTweets.slice(-500);
    }
    
    this.save();
  }

  // 오늘 댓글 단 개수
  getTodayReplyCount(): number {
    // 오늘 날짜 기준으로 답글 트윗 수 계산
    const today = new Date().toISOString().split("T")[0];
    const todayReplies = this.data.tweets.filter(t => 
      t.type === "reply" && t.timestamp.startsWith(today)
    );
    return todayReplies.length;
  }
}

// 싱글톤 인스턴스
export const memory = new MemoryService();
