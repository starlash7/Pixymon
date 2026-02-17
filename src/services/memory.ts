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
const MEMORY_SAVE_DEBOUNCE_MS = 250;
const MAX_REPLIED_TWEETS = 500;
const DUPLICATE_STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "by",
  "for",
  "to",
  "of",
  "and",
  "in",
  "on",
  "at",
]);

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

type CognitiveActivityType = "signal" | "social" | "reasoning";

interface AgentState {
  level: number;
  readiness: number;
  signalXp: number;
  socialXp: number;
  reasoningXp: number;
  unlockedAbilities: string[];
  lastEvolutionAt?: string;
  lastUpdated: string;
}

interface PostGenerationMetrics {
  dateKey: string;
  postRuns: number;
  postSuccesses: number;
  postFailures: number;
  totalRetries: number;
  fallbackUsed: number;
  failReasons: Record<string, number>;
  updatedAt: string;
}

interface SourceTrustRecord {
  key: string;
  score: number;
  observations: number;
  lastReason?: string;
  lastUpdated: string;
}

interface QualityTelemetry {
  postGenerationByDate: Record<string, PostGenerationMetrics>;
  sourceTrust: Record<string, SourceTrustRecord>;
}

interface MemoryData {
  tweets: Tweet[];
  predictions: Prediction[];
  followers: Record<string, Follower>;
  lastProcessedMentionId?: string;  // 마지막 처리한 멘션 ID
  repliedTweets: string[];  // 댓글 단 트윗 ID들 (중복 방지)
  agentState: AgentState;
  qualityTelemetry: QualityTelemetry;
  lastUpdated: string;
}

function createEmptyAgentState(): AgentState {
  return {
    level: 1,
    readiness: 0,
    signalXp: 0,
    socialXp: 0,
    reasoningXp: 0,
    unlockedAbilities: ["뉴스 요약", "기본 마켓 분석", "멘션 응답"],
    lastUpdated: new Date().toISOString(),
  };
}

function createEmptyQualityTelemetry(): QualityTelemetry {
  return {
    postGenerationByDate: {},
    sourceTrust: {},
  };
}

function createEmptyMemoryData(): MemoryData {
  return {
    tweets: [],
    predictions: [],
    followers: {},
    repliedTweets: [],
    agentState: createEmptyAgentState(),
    qualityTelemetry: createEmptyQualityTelemetry(),
    lastUpdated: new Date().toISOString(),
  };
}

// 초기 데이터
const EMPTY_MEMORY: MemoryData = createEmptyMemoryData();

export class MemoryService {
  private data: MemoryData;
  private dataPath: string;
  private saveTimer: NodeJS.Timeout | null = null;
  private repliedTweetSet = new Set<string>();

  constructor() {
    this.dataPath = path.join(DATA_DIR, "memory.json");
    this.data = this.load();
    this.repliedTweetSet = new Set(this.data.repliedTweets || []);
    process.once("exit", () => {
      this.flushSave();
    });
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
        const empty = createEmptyMemoryData();
        this.save(empty, true);
        console.log("[MEMORY] 새 메모리 파일 생성됨");
        return empty;
      }

      const raw = fs.readFileSync(this.dataPath, "utf-8");
      const data = this.normalizeMemoryData(JSON.parse(raw) as Partial<MemoryData>);
      console.log(`[MEMORY] 로드됨 - 트윗: ${data.tweets.length}, 예측: ${data.predictions.length}`);
      return data;
    } catch (error) {
      console.error("[MEMORY] 로드 실패, 초기화:", error);
      return createEmptyMemoryData();
    }
  }

  // 데이터 저장
  private save(data?: MemoryData, immediate: boolean = false): void {
    if (data) {
      this.data = data;
      this.repliedTweetSet = new Set(this.data.repliedTweets || []);
    }
    if (immediate) {
      this.flushSave();
      return;
    }
    if (this.saveTimer) {
      return;
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flushSave();
    }, MEMORY_SAVE_DEBOUNCE_MS);
  }

  private flushSave(): void {
    try {
      if (this.saveTimer) {
        clearTimeout(this.saveTimer);
        this.saveTimer = null;
      }
      this.data.lastUpdated = new Date().toISOString();
      fs.writeFileSync(this.dataPath, JSON.stringify(this.data, null, 2));
    } catch (error) {
      console.error("[MEMORY] 저장 실패:", error);
    }
  }

  private normalizeMemoryData(raw: Partial<MemoryData>): MemoryData {
    const agentState = this.normalizeAgentState(raw.agentState);
    const qualityTelemetry = this.normalizeQualityTelemetry(raw.qualityTelemetry);
    return {
      tweets: Array.isArray(raw.tweets) ? raw.tweets : [],
      predictions: Array.isArray(raw.predictions) ? raw.predictions : [],
      followers: this.normalizeFollowers(raw.followers),
      lastProcessedMentionId: typeof raw.lastProcessedMentionId === "string" ? raw.lastProcessedMentionId : undefined,
      repliedTweets: this.normalizeRepliedTweets(raw.repliedTweets),
      agentState,
      qualityTelemetry,
      lastUpdated: typeof raw.lastUpdated === "string" ? raw.lastUpdated : new Date().toISOString(),
    };
  }

  private normalizeRepliedTweets(raw: unknown): string[] {
    if (!Array.isArray(raw)) {
      return [];
    }
    const normalized = raw
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter((item) => item.length > 0);
    return [...new Set(normalized)].slice(-MAX_REPLIED_TWEETS);
  }

  private normalizeAgentState(raw?: Partial<AgentState>): AgentState {
    const now = new Date().toISOString();
    const level = this.clampInt(raw?.level, 1, 5, 1);
    const signalXp = this.toSafeNumber(raw?.signalXp);
    const socialXp = this.toSafeNumber(raw?.socialXp);
    const reasoningXp = this.toSafeNumber(raw?.reasoningXp);
    const readinessFromXp = this.calculateReadiness(signalXp, socialXp, reasoningXp);
    const readiness = typeof raw?.readiness === "number"
      ? this.clamp(raw.readiness, 0, 1)
      : readinessFromXp;

    const unlocked = Array.isArray(raw?.unlockedAbilities) && raw?.unlockedAbilities.length > 0
      ? [...new Set(raw.unlockedAbilities.filter((ability): ability is string => typeof ability === "string" && ability.trim().length > 0))]
      : this.getAbilitiesForLevel(level);

    return {
      level,
      readiness,
      signalXp,
      socialXp,
      reasoningXp,
      unlockedAbilities: unlocked,
      lastEvolutionAt: typeof raw?.lastEvolutionAt === "string" ? raw.lastEvolutionAt : undefined,
      lastUpdated: typeof raw?.lastUpdated === "string" ? raw.lastUpdated : now,
    };
  }

  private normalizeFollowers(raw: unknown): Record<string, Follower> {
    if (!raw || typeof raw !== "object") {
      return {};
    }

    const output: Record<string, Follower> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (!value || typeof value !== "object") {
        continue;
      }
      const follower = value as Partial<Follower>;
      output[key] = {
        userId: typeof follower.userId === "string" ? follower.userId : key,
        username: typeof follower.username === "string" ? follower.username : `user_${key}`,
        mentionCount: this.clampInt(follower.mentionCount, 0, Number.MAX_SAFE_INTEGER, 0),
        lastMention: typeof follower.lastMention === "string" ? follower.lastMention : "",
        sentiment:
          follower.sentiment === "positive" || follower.sentiment === "negative" || follower.sentiment === "neutral"
            ? follower.sentiment
            : "neutral",
      };
    }

    return output;
  }

  private normalizeQualityTelemetry(raw: unknown): QualityTelemetry {
    if (!raw || typeof raw !== "object") {
      return createEmptyQualityTelemetry();
    }

    const telemetry = raw as Partial<QualityTelemetry>;
    const postGenerationByDate = this.normalizePostGenerationByDate(telemetry.postGenerationByDate);
    const sourceTrust = this.normalizeSourceTrustMap(telemetry.sourceTrust);

    return {
      postGenerationByDate,
      sourceTrust,
    };
  }

  private normalizePostGenerationByDate(raw: unknown): Record<string, PostGenerationMetrics> {
    if (!raw || typeof raw !== "object") {
      return {};
    }

    const now = new Date().toISOString();
    const output: Record<string, PostGenerationMetrics> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const entry = value as Partial<PostGenerationMetrics>;
      const dateKey = typeof entry.dateKey === "string" && entry.dateKey ? entry.dateKey : key;
      output[key] = {
        dateKey,
        postRuns: this.clampInt(entry.postRuns, 0, Number.MAX_SAFE_INTEGER, 0),
        postSuccesses: this.clampInt(entry.postSuccesses, 0, Number.MAX_SAFE_INTEGER, 0),
        postFailures: this.clampInt(entry.postFailures, 0, Number.MAX_SAFE_INTEGER, 0),
        totalRetries: this.clampInt(entry.totalRetries, 0, Number.MAX_SAFE_INTEGER, 0),
        fallbackUsed: this.clampInt(entry.fallbackUsed, 0, Number.MAX_SAFE_INTEGER, 0),
        failReasons: this.normalizeFailReasons(entry.failReasons),
        updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : now,
      };
    }
    return output;
  }

  private normalizeSourceTrustMap(raw: unknown): Record<string, SourceTrustRecord> {
    if (!raw || typeof raw !== "object") {
      return {};
    }

    const now = new Date().toISOString();
    const output: Record<string, SourceTrustRecord> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const entry = value as Partial<SourceTrustRecord>;
      output[key] = {
        key,
        score: this.clamp(typeof entry.score === "number" ? entry.score : 0.5, 0.05, 0.95),
        observations: this.clampInt(entry.observations, 0, Number.MAX_SAFE_INTEGER, 0),
        lastReason: typeof entry.lastReason === "string" ? entry.lastReason : undefined,
        lastUpdated: typeof entry.lastUpdated === "string" ? entry.lastUpdated : now,
      };
    }
    return output;
  }

  private normalizeFailReasons(raw: unknown): Record<string, number> {
    if (!raw || typeof raw !== "object") {
      return {};
    }
    const output: Record<string, number> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      output[key] = this.clampInt(value, 0, Number.MAX_SAFE_INTEGER, 0);
    }
    return output;
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
    const words = text
      .toLowerCase()
      .replace(/[^\w\s$]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !DUPLICATE_STOP_WORDS.has(w));
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
    context += `${this.getAgentStateContext()}\n\n`;

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
    if (this.repliedTweetSet.size !== this.data.repliedTweets.length) {
      this.repliedTweetSet = new Set(this.data.repliedTweets);
    }
    return this.repliedTweetSet.has(tweetId);
  }

  // 댓글 단 트윗 저장
  saveRepliedTweet(tweetId: string): void {
    if (!this.data.repliedTweets) {
      this.data.repliedTweets = [];
    }
    if (this.repliedTweetSet.has(tweetId)) {
      return;
    }
    this.data.repliedTweets.push(tweetId);
    this.repliedTweetSet.add(tweetId);
    
    // 최근 MAX_REPLIED_TWEETS개만 유지 (메모리 관리)
    if (this.data.repliedTweets.length > MAX_REPLIED_TWEETS) {
      const overflow = this.data.repliedTweets.length - MAX_REPLIED_TWEETS;
      const dropped = this.data.repliedTweets.splice(0, overflow);
      dropped.forEach((id) => this.repliedTweetSet.delete(id));
    }
    
    this.save();
  }

  // ============================================
  // 인지/진화 상태
  // ============================================

  getAgentState(): AgentState {
    return {
      ...this.data.agentState,
      unlockedAbilities: [...this.data.agentState.unlockedAbilities],
    };
  }

  getAgentStateContext(): string {
    const state = this.getAgentState();
    const readinessPercent = Math.round(state.readiness * 100);
    const unlocked = state.unlockedAbilities.slice(0, 4).join(", ") || "없음";

    return [
      "## 진화 상태",
      `- Lv.${state.level} | readiness ${readinessPercent}%`,
      `- XP(signal/social/reasoning): ${state.signalXp}/${state.socialXp}/${state.reasoningXp}`,
      `- 활성 능력: ${unlocked}`,
    ].join("\n");
  }

  recordCognitiveActivity(type: CognitiveActivityType, amount: number = 1): AgentState {
    const state = this.data.agentState;
    const gain = this.clampInt(amount, 1, 10, 1);

    if (type === "signal") state.signalXp += gain;
    if (type === "social") state.socialXp += gain;
    if (type === "reasoning") state.reasoningXp += gain;

    state.readiness = this.calculateReadiness(state.signalXp, state.socialXp, state.reasoningXp);
    state.lastUpdated = new Date().toISOString();

    // readiness가 100%면 레벨업
    if (state.readiness >= 1 && state.level < 5) {
      state.level += 1;
      state.lastEvolutionAt = new Date().toISOString();
      state.unlockedAbilities = this.getAbilitiesForLevel(state.level);

      // 레벨업 후 일부 경험치는 다음 단계로 carry
      state.signalXp = Math.round(state.signalXp * 0.45);
      state.socialXp = Math.round(state.socialXp * 0.45);
      state.reasoningXp = Math.round(state.reasoningXp * 0.45);
      state.readiness = this.calculateReadiness(state.signalXp, state.socialXp, state.reasoningXp);
    }

    this.save();
    return this.getAgentState();
  }

  // 오늘 댓글 단 개수
  getTodayReplyCount(timezone: string = "Asia/Seoul"): number {
    return this.data.tweets.filter((tweet) => this.isTodayByTimezone(tweet.timestamp, timezone) && tweet.type === "reply").length;
  }

  // 오늘 글(원글/브리핑) 개수
  getTodayPostCount(timezone: string = "Asia/Seoul"): number {
    return this.data.tweets.filter((tweet) => this.isTodayByTimezone(tweet.timestamp, timezone) && tweet.type === "briefing").length;
  }

  // 오늘 총 활동 개수 (댓글 + 글 + quote)
  getTodayActivityCount(timezone: string = "Asia/Seoul"): number {
    return this.data.tweets.filter((tweet) => this.isTodayByTimezone(tweet.timestamp, timezone)).length;
  }

  getTodayPostGenerationMetrics(timezone: string = "Asia/Seoul"): {
    postRuns: number;
    postSuccesses: number;
    postFailures: number;
    totalRetries: number;
    avgRetries: number;
    fallbackRate: number;
    failReasons: Record<string, number>;
  } {
    const key = this.getDateKey(new Date(), timezone);
    const bucket = this.data.qualityTelemetry.postGenerationByDate[key];
    if (!bucket) {
      return {
        postRuns: 0,
        postSuccesses: 0,
        postFailures: 0,
        totalRetries: 0,
        avgRetries: 0,
        fallbackRate: 0,
        failReasons: {},
      };
    }

    const avgRetries = bucket.postRuns > 0 ? bucket.totalRetries / bucket.postRuns : 0;
    const fallbackRate = bucket.postRuns > 0 ? bucket.fallbackUsed / bucket.postRuns : 0;

    return {
      postRuns: bucket.postRuns,
      postSuccesses: bucket.postSuccesses,
      postFailures: bucket.postFailures,
      totalRetries: bucket.totalRetries,
      avgRetries: Math.round(avgRetries * 100) / 100,
      fallbackRate: Math.round(fallbackRate * 100) / 100,
      failReasons: { ...bucket.failReasons },
    };
  }

  recordPostGeneration(params: {
    timezone?: string;
    retryCount: number;
    usedFallback: boolean;
    success: boolean;
    failReason?: string;
  }): void {
    const timezone = params.timezone || "Asia/Seoul";
    const key = this.getDateKey(new Date(), timezone);
    if (!this.data.qualityTelemetry.postGenerationByDate[key]) {
      this.data.qualityTelemetry.postGenerationByDate[key] = {
        dateKey: key,
        postRuns: 0,
        postSuccesses: 0,
        postFailures: 0,
        totalRetries: 0,
        fallbackUsed: 0,
        failReasons: {},
        updatedAt: new Date().toISOString(),
      };
    }

    const bucket = this.data.qualityTelemetry.postGenerationByDate[key];
    bucket.postRuns += 1;
    bucket.totalRetries += this.clampInt(params.retryCount, 0, 10, 0);
    if (params.usedFallback) {
      bucket.fallbackUsed += 1;
    }
    if (params.success) {
      bucket.postSuccesses += 1;
    } else {
      bucket.postFailures += 1;
      const reasonKey = this.normalizeFailReason(params.failReason || "unknown");
      bucket.failReasons[reasonKey] = (bucket.failReasons[reasonKey] || 0) + 1;
    }
    bucket.updatedAt = new Date().toISOString();

    this.compactPostGenerationMetrics(14);
    this.save();
  }

  getSourceTrustScore(sourceKey: string, fallback: number = 0.5): number {
    const key = this.normalizeSourceKey(sourceKey);
    if (!key) return this.clamp(fallback, 0.05, 0.95);
    const existing = this.data.qualityTelemetry.sourceTrust[key];
    if (!existing) {
      return this.clamp(fallback, 0.05, 0.95);
    }
    return this.clamp(existing.score, 0.05, 0.95);
  }

  adjustSourceTrust(sourceKey: string, delta: number, reason: string, fallback: number = 0.5): number {
    return this.applySourceTrustDelta(sourceKey, delta, reason, fallback, true);
  }

  applySourceTrustDeltaBatch(
    updates: Array<{ sourceKey: string; delta: number; reason: string; fallback?: number }>
  ): void {
    if (!Array.isArray(updates) || updates.length === 0) return;

    let changed = false;
    for (const update of updates) {
      const result = this.applySourceTrustDelta(
        update.sourceKey,
        update.delta,
        update.reason,
        typeof update.fallback === "number" ? update.fallback : 0.5,
        false
      );
      if (Number.isFinite(result)) {
        changed = true;
      }
    }

    if (!changed) return;
    this.compactSourceTrust(500);
    this.save();
  }

  private applySourceTrustDelta(
    sourceKey: string,
    delta: number,
    reason: string,
    fallback: number,
    persist: boolean
  ): number {
    const key = this.normalizeSourceKey(sourceKey);
    if (!key) return this.clamp(fallback, 0.05, 0.95);

    const existing = this.data.qualityTelemetry.sourceTrust[key];
    const baseScore = existing ? existing.score : this.clamp(fallback, 0.05, 0.95);
    const nextScore = this.clamp(baseScore + delta, 0.05, 0.95);
    const now = new Date().toISOString();

    this.data.qualityTelemetry.sourceTrust[key] = {
      key,
      score: nextScore,
      observations: (existing?.observations || 0) + 1,
      lastReason: this.normalizeFailReason(reason),
      lastUpdated: now,
    };

    if (persist) {
      this.compactSourceTrust(500);
      this.save();
    }
    return nextScore;
  }

  getSourceTrustSnapshot(sourceKeys: string[]): Array<{ key: string; score: number; observations: number }> {
    const output: Array<{ key: string; score: number; observations: number }> = [];
    for (const sourceKey of sourceKeys) {
      const key = this.normalizeSourceKey(sourceKey);
      if (!key) continue;
      const row = this.data.qualityTelemetry.sourceTrust[key];
      if (!row) continue;
      output.push({ key, score: row.score, observations: row.observations });
    }
    return output;
  }

  private getAbilitiesForLevel(level: number): string[] {
    if (level >= 5) {
      return [
        "멀티시나리오 추론",
        "온체인/소셜 공진화 분석",
        "고신뢰 반론 설계",
        "자율 전략 전환",
      ];
    }
    if (level === 4) {
      return [
        "서사형 마켓 해석",
        "리스크 플래그 우선경보",
        "논점별 신뢰도 제어",
        "고래 행위 탐지 강화",
      ];
    }
    if (level === 3) {
      return [
        "클러스터 모멘텀 추적",
        "가설-반가설 비교",
        "질문형 토론 유도",
        "맥락 기반 답글 최적화",
      ];
    }
    if (level === 2) {
      return [
        "온체인 데이터 분석",
        "지갑/플로우 프록시 추적",
        "리서치 레이어 적용",
        "회고 정책 반영",
      ];
    }
    return ["뉴스 요약", "기본 마켓 분석", "멘션 응답"];
  }

  private calculateReadiness(signalXp: number, socialXp: number, reasoningXp: number): number {
    const weightedScore = signalXp * 0.35 + socialXp * 0.35 + reasoningXp * 0.3;
    const readiness = weightedScore / 120;
    return this.clamp(Math.round(readiness * 100) / 100, 0, 1);
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
  }

  private clampInt(value: unknown, min: number, max: number, fallback: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return fallback;
    }
    return Math.floor(this.clamp(value, min, max));
  }

  private toSafeNumber(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return 0;
    }
    if (value < 0) {
      return 0;
    }
    return Math.floor(value);
  }

  private normalizeSourceKey(raw: string): string {
    return String(raw || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9:_-]/g, "");
  }

  private normalizeFailReason(reason: string): string {
    return String(reason || "unknown")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "_")
      .replace(/[^a-z0-9_:-]/g, "")
      .slice(0, 64) || "unknown";
  }

  private compactPostGenerationMetrics(keepDays: number): void {
    const entries = Object.entries(this.data.qualityTelemetry.postGenerationByDate);
    if (entries.length <= keepDays) return;

    entries
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .slice(0, Math.max(0, entries.length - keepDays))
      .forEach(([key]) => {
        delete this.data.qualityTelemetry.postGenerationByDate[key];
      });
  }

  private compactSourceTrust(keepItems: number): void {
    const entries = Object.entries(this.data.qualityTelemetry.sourceTrust);
    if (entries.length <= keepItems) return;

    entries
      .sort((a, b) => {
        const aTs = new Date(a[1].lastUpdated).getTime();
        const bTs = new Date(b[1].lastUpdated).getTime();
        return aTs - bTs;
      })
      .slice(0, Math.max(0, entries.length - keepItems))
      .forEach(([key]) => {
        delete this.data.qualityTelemetry.sourceTrust[key];
      });
  }

  private isTodayByTimezone(isoTimestamp: string, timezone: string): boolean {
    const date = new Date(isoTimestamp);
    if (Number.isNaN(date.getTime())) {
      return false;
    }
    const today = this.getDateKey(new Date(), timezone);
    const target = this.getDateKey(date, timezone);
    return target === today;
  }

  private getDateKey(date: Date, timezone: string): string {
    return date.toLocaleDateString("en-CA", { timeZone: timezone });
  }
}

// 싱글톤 인스턴스
export const memory = new MemoryService();
