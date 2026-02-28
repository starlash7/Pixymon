import fs from "fs";
import path from "path";
import {
  AutonomyContext,
  AbilityUnlock,
  ClaimResolution,
  DigestScore,
  EvolutionStage,
  HypothesisStatus,
  NarrativeMode,
  NarrativeThread,
  NutrientLedgerEntry,
  OpenHypothesis,
  OnchainNutrient,
  ResolvedClaim,
  TrendLane,
} from "../types/agent.js";

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
  meta?: TweetMeta;
  coins?: string[];  // 언급된 코인들
}

interface TweetMeta {
  lane?: TrendLane;
  eventId?: string;
  eventHeadline?: string;
  evidenceIds?: string[];
  narrativeMode?: string;
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

interface SignalFingerprintRecord {
  key: string;
  signature: string;
  context?: string;
  capturedAt: string;
}

interface FearGreedHistoryRecord {
  value: number;
  label?: string;
  capturedAt: string;
}

interface EvolutionHistoryRecord {
  from: EvolutionStage;
  to: EvolutionStage;
  reason: string;
  totalXp: number;
  unlockedAbilities: AbilityUnlock[];
  capturedAt: string;
}

interface XpGainBySourceRecord {
  dateKey: string;
  onchain: number;
  market: number;
  news: number;
  total: number;
  updatedAt: string;
}

interface QualityTelemetry {
  postGenerationByDate: Record<string, PostGenerationMetrics>;
  sourceTrust: Record<string, SourceTrustRecord>;
  signalFingerprints: SignalFingerprintRecord[];
  fearGreedHistory: FearGreedHistoryRecord[];
  nutrientLedger: NutrientLedgerEntry[];
  xpGainBySource: Record<string, XpGainBySourceRecord>;
  evolutionHistory: EvolutionHistoryRecord[];
}

interface MemoryData {
  tweets: Tweet[];
  predictions: Prediction[];
  followers: Record<string, Follower>;
  lastProcessedMentionId?: string;  // 마지막 처리한 멘션 ID
  repliedTweets: string[];  // 댓글 단 트윗 ID들 (중복 방지)
  agentState: AgentState;
  qualityTelemetry: QualityTelemetry;
  autonomyContext: AutonomyContext;
  lastUpdated: string;
}

interface RecordNarrativeOutcomeInput {
  lane: TrendLane;
  eventId: string;
  eventHeadline: string;
  evidenceIds: string[];
  mode?: NarrativeMode;
  postText: string;
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
    signalFingerprints: [],
    fearGreedHistory: [],
    nutrientLedger: [],
    xpGainBySource: {},
    evolutionHistory: [],
  };
}

function createEmptyAutonomyContext(): AutonomyContext {
  return {
    openHypotheses: [],
    narrativeThreads: [],
    resolvedClaims: [],
    lastUpdated: new Date().toISOString(),
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
    autonomyContext: createEmptyAutonomyContext(),
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
    const autonomyContext = this.normalizeAutonomyContext(raw.autonomyContext);
    return {
      tweets: this.normalizeTweets(raw.tweets),
      predictions: Array.isArray(raw.predictions) ? raw.predictions : [],
      followers: this.normalizeFollowers(raw.followers),
      lastProcessedMentionId: typeof raw.lastProcessedMentionId === "string" ? raw.lastProcessedMentionId : undefined,
      repliedTweets: this.normalizeRepliedTweets(raw.repliedTweets),
      agentState,
      qualityTelemetry,
      autonomyContext,
      lastUpdated: typeof raw.lastUpdated === "string" ? raw.lastUpdated : new Date().toISOString(),
    };
  }

  private normalizeAutonomyContext(raw: unknown): AutonomyContext {
    if (!raw || typeof raw !== "object") {
      return createEmptyAutonomyContext();
    }
    const row = raw as Partial<AutonomyContext>;
    return {
      openHypotheses: this.normalizeOpenHypotheses(row.openHypotheses),
      narrativeThreads: this.normalizeNarrativeThreads(row.narrativeThreads),
      resolvedClaims: this.normalizeResolvedClaims(row.resolvedClaims),
      lastUpdated: typeof row.lastUpdated === "string" ? row.lastUpdated : new Date().toISOString(),
    };
  }

  private normalizeOpenHypotheses(raw: unknown): OpenHypothesis[] {
    if (!Array.isArray(raw)) return [];
    const output: OpenHypothesis[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const row = item as Partial<OpenHypothesis>;
      const id = typeof row.id === "string" ? row.id.trim().slice(0, 64) : "";
      const lane = this.normalizeTrendLane(row.lane);
      const statement = typeof row.statement === "string" ? row.statement.trim().slice(0, 180) : "";
      const status = this.normalizeHypothesisStatus(row.status);
      if (!id || !lane || !statement || !status) continue;
      output.push({
        id,
        lane,
        statement,
        confidence: this.clamp(typeof row.confidence === "number" ? row.confidence : 0.5, 0, 1),
        status,
        evidenceIds: this.normalizeEvidenceIds(row.evidenceIds),
        createdAt: typeof row.createdAt === "string" ? row.createdAt : new Date().toISOString(),
        updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : new Date().toISOString(),
      });
    }
    return output
      .sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime())
      .slice(-90);
  }

  private normalizeNarrativeThreads(raw: unknown): NarrativeThread[] {
    if (!Array.isArray(raw)) return [];
    const output: NarrativeThread[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const row = item as Partial<NarrativeThread>;
      const id = typeof row.id === "string" ? row.id.trim().slice(0, 64) : "";
      const lane = this.normalizeTrendLane(row.lane);
      const eventId = typeof row.eventId === "string" ? row.eventId.trim().slice(0, 80) : "";
      const headline = typeof row.headline === "string" ? row.headline.trim().slice(0, 180) : "";
      if (!id || !lane || !eventId || !headline) continue;
      output.push({
        id,
        lane,
        eventId,
        headline,
        mode: this.normalizeNarrativeMode(row.mode),
        activityCount: this.clampInt(row.activityCount, 1, 1000, 1),
        evidenceIds: this.normalizeEvidenceIds(row.evidenceIds),
        openedAt: typeof row.openedAt === "string" ? row.openedAt : new Date().toISOString(),
        updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : new Date().toISOString(),
      });
    }
    return output
      .sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime())
      .slice(-140);
  }

  private normalizeResolvedClaims(raw: unknown): ResolvedClaim[] {
    if (!Array.isArray(raw)) return [];
    const output: ResolvedClaim[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const row = item as Partial<ResolvedClaim>;
      const id = typeof row.id === "string" ? row.id.trim().slice(0, 64) : "";
      const lane = this.normalizeTrendLane(row.lane);
      const claim = typeof row.claim === "string" ? row.claim.trim().slice(0, 180) : "";
      const resolution = this.normalizeClaimResolution(row.resolution);
      if (!id || !lane || !claim || !resolution) continue;
      output.push({
        id,
        lane,
        claim,
        resolution,
        confidence: this.clamp(typeof row.confidence === "number" ? row.confidence : 0.5, 0, 1),
        evidenceIds: this.normalizeEvidenceIds(row.evidenceIds),
        resolvedAt: typeof row.resolvedAt === "string" ? row.resolvedAt : new Date().toISOString(),
      });
    }
    return output
      .sort((a, b) => new Date(a.resolvedAt).getTime() - new Date(b.resolvedAt).getTime())
      .slice(-220);
  }

  private normalizeEvidenceIds(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    return [...new Set(raw.map((item) => String(item || "").trim()).filter((item) => item.length > 0))].slice(0, 8);
  }

  private normalizeTweets(raw: unknown): Tweet[] {
    if (!Array.isArray(raw)) {
      return [];
    }
    const output: Tweet[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const row = item as Partial<Tweet>;
      const id = typeof row.id === "string" ? row.id.trim() : "";
      const content = typeof row.content === "string" ? row.content.trim() : "";
      if (!id || !content) continue;
      output.push({
        id,
        content,
        timestamp: typeof row.timestamp === "string" ? row.timestamp : new Date().toISOString(),
        type: row.type === "reply" || row.type === "quote" || row.type === "briefing" ? row.type : "briefing",
        meta: this.normalizeTweetMeta(row.meta),
        coins: Array.isArray(row.coins)
          ? [...new Set(row.coins.map((coin) => String(coin || "").toUpperCase()).filter(Boolean))]
          : this.extractCoins(content),
      });
    }
    return output.slice(-300);
  }

  private normalizeTweetMeta(raw: unknown): TweetMeta | undefined {
    if (!raw || typeof raw !== "object") {
      return undefined;
    }
    const row = raw as Partial<TweetMeta>;
    const lane = this.normalizeTrendLane(row.lane);
    const eventId = typeof row.eventId === "string" && row.eventId.trim() ? row.eventId.trim().slice(0, 80) : undefined;
    const eventHeadline =
      typeof row.eventHeadline === "string" && row.eventHeadline.trim()
        ? row.eventHeadline.trim().slice(0, 160)
        : undefined;
    const evidenceIds = Array.isArray(row.evidenceIds)
      ? [...new Set(row.evidenceIds.map((id) => String(id || "").trim()).filter((id) => id.length > 0))].slice(0, 6)
      : undefined;
    const narrativeMode =
      typeof row.narrativeMode === "string" && row.narrativeMode.trim()
        ? row.narrativeMode.trim().slice(0, 40)
        : undefined;
    if (!lane && !eventId && !eventHeadline && (!evidenceIds || evidenceIds.length === 0) && !narrativeMode) {
      return undefined;
    }
    return {
      lane,
      eventId,
      eventHeadline,
      evidenceIds: evidenceIds && evidenceIds.length > 0 ? evidenceIds : undefined,
      narrativeMode,
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
    const signalFingerprints = this.normalizeSignalFingerprints(telemetry.signalFingerprints);
    const fearGreedHistory = this.normalizeFearGreedHistory(telemetry.fearGreedHistory);
    const nutrientLedger = this.normalizeNutrientLedger(telemetry.nutrientLedger);
    const xpGainBySource = this.normalizeXpGainBySource(telemetry.xpGainBySource);
    const evolutionHistory = this.normalizeEvolutionHistory(telemetry.evolutionHistory);

    return {
      postGenerationByDate,
      sourceTrust,
      signalFingerprints,
      fearGreedHistory,
      nutrientLedger,
      xpGainBySource,
      evolutionHistory,
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

  private normalizeSignalFingerprints(raw: unknown): SignalFingerprintRecord[] {
    if (!Array.isArray(raw)) {
      return [];
    }
    const output: SignalFingerprintRecord[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const row = item as Partial<SignalFingerprintRecord>;
      const key = this.normalizeSignalFingerprintKey(row.key);
      const signature = this.normalizeSignalFingerprintSignature(row.signature);
      const capturedAt = typeof row.capturedAt === "string" ? row.capturedAt : new Date().toISOString();
      if (!key || !signature) continue;
      output.push({
        key,
        signature,
        context: typeof row.context === "string" && row.context.trim() ? row.context.trim().slice(0, 180) : undefined,
        capturedAt,
      });
    }
    return output
      .sort((a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime())
      .slice(-500);
  }

  private normalizeFearGreedHistory(raw: unknown): FearGreedHistoryRecord[] {
    if (!Array.isArray(raw)) return [];
    const output: FearGreedHistoryRecord[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const row = item as Partial<FearGreedHistoryRecord>;
      const value = this.clampInt(row.value, 0, 100, -1);
      if (value < 0) continue;
      output.push({
        value,
        label: typeof row.label === "string" && row.label.trim() ? row.label.trim().slice(0, 40) : undefined,
        capturedAt: typeof row.capturedAt === "string" ? row.capturedAt : new Date().toISOString(),
      });
    }
    return output
      .sort((a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime())
      .slice(-500);
  }

  private normalizeNutrientLedger(raw: unknown): NutrientLedgerEntry[] {
    if (!Array.isArray(raw)) return [];
    const output: NutrientLedgerEntry[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const row = item as Partial<NutrientLedgerEntry>;
      const digest = row.digestScore as Partial<DigestScore> | undefined;
      const source = row.source === "onchain" || row.source === "market" || row.source === "news" ? row.source : null;
      if (!source) continue;
      const nutrientId = typeof row.nutrientId === "string" ? row.nutrientId.trim() : "";
      if (!nutrientId) continue;
      output.push({
        id: typeof row.id === "string" && row.id.trim() ? row.id.trim() : `ledger_${Date.now()}`,
        nutrientId,
        source,
        category: typeof row.category === "string" && row.category.trim() ? row.category.trim().slice(0, 64) : "unknown",
        label: typeof row.label === "string" ? row.label.trim().slice(0, 160) : "",
        digestScore: {
          trust: this.clamp(typeof digest?.trust === "number" ? digest.trust : 0.5, 0, 1),
          freshness: this.clamp(typeof digest?.freshness === "number" ? digest.freshness : 0.5, 0, 1),
          consistency: this.clamp(typeof digest?.consistency === "number" ? digest.consistency : 0.5, 0, 1),
          total: this.clamp(typeof digest?.total === "number" ? digest.total : 0.5, 0, 1),
          reasonCodes: Array.isArray(digest?.reasonCodes)
            ? digest!.reasonCodes
                .map((code) => String(code || "").trim().slice(0, 40))
                .filter((code) => code.length > 0)
                .slice(0, 8)
            : [],
        },
        xpGain: this.clampInt(row.xpGain, 0, 100, 0),
        accepted: typeof row.accepted === "boolean" ? row.accepted : false,
        capturedAt: typeof row.capturedAt === "string" ? row.capturedAt : new Date().toISOString(),
      });
    }
    return output
      .sort((a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime())
      .slice(-1200);
  }

  private normalizeXpGainBySource(raw: unknown): Record<string, XpGainBySourceRecord> {
    if (!raw || typeof raw !== "object") return {};
    const output: Record<string, XpGainBySourceRecord> = {};
    const now = new Date().toISOString();
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const row = value as Partial<XpGainBySourceRecord>;
      output[key] = {
        dateKey: typeof row.dateKey === "string" && row.dateKey ? row.dateKey : key,
        onchain: this.clampInt(row.onchain, 0, Number.MAX_SAFE_INTEGER, 0),
        market: this.clampInt(row.market, 0, Number.MAX_SAFE_INTEGER, 0),
        news: this.clampInt(row.news, 0, Number.MAX_SAFE_INTEGER, 0),
        total: this.clampInt(row.total, 0, Number.MAX_SAFE_INTEGER, 0),
        updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : now,
      };
    }
    return output;
  }

  private normalizeEvolutionHistory(raw: unknown): EvolutionHistoryRecord[] {
    if (!Array.isArray(raw)) return [];
    const output: EvolutionHistoryRecord[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const row = item as Partial<EvolutionHistoryRecord>;
      const from = this.normalizeEvolutionStage(row.from);
      const to = this.normalizeEvolutionStage(row.to);
      if (!from || !to) continue;
      output.push({
        from,
        to,
        reason: typeof row.reason === "string" && row.reason.trim() ? row.reason.trim().slice(0, 80) : "level-up",
        totalXp: this.clampInt(row.totalXp, 0, Number.MAX_SAFE_INTEGER, 0),
        unlockedAbilities: this.normalizeAbilityUnlocks(row.unlockedAbilities),
        capturedAt: typeof row.capturedAt === "string" ? row.capturedAt : new Date().toISOString(),
      });
    }
    return output
      .sort((a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime())
      .slice(-300);
  }

  private normalizeAbilityUnlocks(raw: unknown): AbilityUnlock[] {
    if (!Array.isArray(raw)) return [];
    const output: AbilityUnlock[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const row = item as Partial<AbilityUnlock>;
      const stage = this.normalizeEvolutionStage(row.unlockedAt);
      if (!stage) continue;
      const id = typeof row.id === "string" ? row.id.trim().slice(0, 40) : "";
      const name = typeof row.name === "string" ? row.name.trim().slice(0, 80) : "";
      if (!id || !name) continue;
      output.push({
        id,
        name,
        description: typeof row.description === "string" ? row.description.trim().slice(0, 140) : name,
        unlockedAt: stage,
      });
    }
    return output.slice(0, 20);
  }

  // ============================================
  // 트윗 기록
  // ============================================

  // 트윗 저장
  saveTweet(
    id: string,
    content: string,
    type: Tweet["type"] = "briefing",
    meta?: TweetMeta
  ): void {
    // 코인 티커 추출 ($BTC, $ETH 등)
    const coins = this.extractCoins(content);

    const tweet: Tweet = {
      id,
      content,
      timestamp: new Date().toISOString(),
      type,
      meta: this.normalizeTweetMeta(meta),
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
    const autonomySummary = this.getAutonomyPromptContext("ko");

    let context = "## 내 기억 (참고용, 강제로 언급할 필요 없음)\n\n";
    context += `${this.getAgentStateContext()}\n\n`;
    context += `${autonomySummary}\n\n`;

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

  getAutonomyContext(): AutonomyContext {
    const row = this.data.autonomyContext;
    return {
      openHypotheses: row.openHypotheses.map((item) => ({ ...item, evidenceIds: [...item.evidenceIds] })),
      narrativeThreads: row.narrativeThreads.map((item) => ({ ...item, evidenceIds: [...item.evidenceIds] })),
      resolvedClaims: row.resolvedClaims.map((item) => ({ ...item, evidenceIds: [...item.evidenceIds] })),
      lastUpdated: row.lastUpdated,
    };
  }

  getAutonomyPromptContext(language: "ko" | "en" = "ko"): string {
    const autonomy = this.data.autonomyContext;
    const openHypotheses = autonomy.openHypotheses
      .filter((item) => item.status === "open" || item.status === "watching")
      .slice(-4)
      .reverse();
    const activeThreads = autonomy.narrativeThreads.slice(-4).reverse();
    const recentResolved = autonomy.resolvedClaims.slice(-3).reverse();

    if (language === "en") {
      const lines: string[] = ["### Autonomy Memory"];
      lines.push(`- Active threads: ${activeThreads.length}`);
      for (const thread of activeThreads) {
        lines.push(`  - [${thread.lane}] ${thread.headline}`);
      }
      if (openHypotheses.length > 0) {
        lines.push("- Open hypotheses:");
        for (const hypo of openHypotheses) {
          lines.push(`  - (${hypo.status}) ${hypo.statement}`);
        }
      }
      if (recentResolved.length > 0) {
        lines.push("- Recently resolved:");
        for (const claim of recentResolved) {
          lines.push(`  - ${claim.claim} (${claim.resolution})`);
        }
      }
      return lines.join("\n");
    }

    const lines: string[] = ["### 자율성 메모리"];
    lines.push(`- 활성 스레드: ${activeThreads.length}개`);
    for (const thread of activeThreads) {
      lines.push(`  - [${thread.lane}] ${thread.headline}`);
    }
    if (openHypotheses.length > 0) {
      lines.push("- 열린 가설:");
      for (const hypo of openHypotheses) {
        lines.push(`  - (${hypo.status}) ${hypo.statement}`);
      }
    }
    if (recentResolved.length > 0) {
      lines.push("- 최근 정리된 주장:");
      for (const claim of recentResolved) {
        lines.push(`  - ${claim.claim} (${claim.resolution})`);
      }
    }
    return lines.join("\n");
  }

  recordNarrativeOutcome(input: RecordNarrativeOutcomeInput): void {
    const lane = this.normalizeTrendLane(input.lane);
    if (!lane) return;
    const eventId = String(input.eventId || "").trim().slice(0, 80);
    const eventHeadline = String(input.eventHeadline || "").trim().slice(0, 180);
    const postText = String(input.postText || "").trim().slice(0, 500);
    if (!eventId || !eventHeadline || !postText) return;

    this.upsertNarrativeThread({
      lane,
      eventId,
      headline: eventHeadline,
      evidenceIds: this.normalizeEvidenceIds(input.evidenceIds),
      mode: this.normalizeNarrativeMode(input.mode),
    });

    const normalizedText = postText.replace(/\s+/g, " ").trim();
    const hypothesisStatement = this.extractHypothesisStatement(normalizedText);
    const isHypothesis = this.looksLikeHypothesis(normalizedText);

    if (isHypothesis && hypothesisStatement) {
      this.upsertOpenHypothesis({
        lane,
        statement: hypothesisStatement,
        evidenceIds: this.normalizeEvidenceIds(input.evidenceIds),
      });
    } else if (hypothesisStatement) {
      this.appendResolvedClaim({
        lane,
        claim: hypothesisStatement,
        evidenceIds: this.normalizeEvidenceIds(input.evidenceIds),
        resolution: "supported",
      });
    }

    this.compactAutonomyContext();
    this.data.autonomyContext.lastUpdated = new Date().toISOString();
    this.save();
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

  getCurrentEvolutionStage(): EvolutionStage {
    return this.levelToEvolutionStage(this.data.agentState.level);
  }

  getTotalXp(): number {
    const state = this.data.agentState;
    return state.signalXp + state.socialXp + state.reasoningXp;
  }

  recordNutrientIntake(params: {
    nutrient: OnchainNutrient;
    digest: DigestScore;
    xpGain: number;
    accepted: boolean;
    timezone?: string;
  }): { evolved: boolean; from: EvolutionStage; to: EvolutionStage; xpGain: number } {
    const outcomes = this.recordNutrientBatchIntake([params], params.timezone);
    const fallbackStage = this.getCurrentEvolutionStage();
    return (
      outcomes[0] || {
        evolved: false,
        from: fallbackStage,
        to: fallbackStage,
        xpGain: this.clampInt(params.xpGain, 0, 20, 0),
      }
    );
  }

  recordNutrientBatchIntake(
    rows: Array<{
      nutrient: OnchainNutrient;
      digest: DigestScore;
      xpGain: number;
      accepted: boolean;
    }>,
    timezone: string = "Asia/Seoul"
  ): Array<{ evolved: boolean; from: EvolutionStage; to: EvolutionStage; xpGain: number }> {
    if (!Array.isArray(rows) || rows.length === 0) {
      return [];
    }

    const outcomes = rows.map((row) => this.applyNutrientIntake(row, timezone));
    this.compactNutrientLedger(1200, 21);
    this.compactXpGainBySource(31);
    this.compactEvolutionHistory(300, 120);
    this.save();
    return outcomes;
  }

  private applyNutrientIntake(params: {
    nutrient: OnchainNutrient;
    digest: DigestScore;
    xpGain: number;
    accepted: boolean;
  }, timezone: string): { evolved: boolean; from: EvolutionStage; to: EvolutionStage; xpGain: number } {
    const before = this.getCurrentEvolutionStage();
    const key = this.getDateKey(new Date(), timezone);
    const boundedXp = this.clampInt(params.xpGain, 0, 20, 0);

    this.data.qualityTelemetry.nutrientLedger.push({
      id: `nutrient_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      nutrientId: params.nutrient.id,
      source: params.nutrient.source,
      category: params.nutrient.category || "unknown",
      label: params.nutrient.label || params.nutrient.id,
      digestScore: {
        trust: this.clamp(params.digest.trust, 0, 1),
        freshness: this.clamp(params.digest.freshness, 0, 1),
        consistency: this.clamp(params.digest.consistency, 0, 1),
        total: this.clamp(params.digest.total, 0, 1),
        reasonCodes: Array.isArray(params.digest.reasonCodes) ? params.digest.reasonCodes.slice(0, 8) : [],
      },
      xpGain: boundedXp,
      accepted: params.accepted,
      capturedAt: params.nutrient.capturedAt || new Date().toISOString(),
    });

    if (!this.data.qualityTelemetry.xpGainBySource[key]) {
      this.data.qualityTelemetry.xpGainBySource[key] = {
        dateKey: key,
        onchain: 0,
        market: 0,
        news: 0,
        total: 0,
        updatedAt: new Date().toISOString(),
      };
    }
    const dailyXp = this.data.qualityTelemetry.xpGainBySource[key];
    dailyXp[params.nutrient.source] += boundedXp;
    dailyXp.total += boundedXp;
    dailyXp.updatedAt = new Date().toISOString();

    if (params.accepted && boundedXp > 0) {
      const state = this.data.agentState;
      if (params.nutrient.source === "onchain") {
        state.signalXp += boundedXp;
      } else if (params.nutrient.source === "market") {
        state.reasoningXp += boundedXp;
      } else {
        state.socialXp += boundedXp;
      }
      state.readiness = this.calculateReadiness(state.signalXp, state.socialXp, state.reasoningXp);
      state.lastUpdated = new Date().toISOString();

      if (state.readiness >= 1 && state.level < 5) {
        const previousAbilities = [...state.unlockedAbilities];
        state.level += 1;
        state.lastEvolutionAt = new Date().toISOString();
        state.unlockedAbilities = this.getAbilitiesForLevel(state.level);
        state.signalXp = Math.round(state.signalXp * 0.45);
        state.socialXp = Math.round(state.socialXp * 0.45);
        state.reasoningXp = Math.round(state.reasoningXp * 0.45);
        state.readiness = this.calculateReadiness(state.signalXp, state.socialXp, state.reasoningXp);

        const unlocked = this.buildUnlockedAbilities(previousAbilities, state.unlockedAbilities, state.level);
        this.data.qualityTelemetry.evolutionHistory.push({
          from: before,
          to: this.levelToEvolutionStage(state.level),
          reason: "nutrient-xp-threshold",
          totalXp: this.getTotalXp(),
          unlockedAbilities: unlocked,
          capturedAt: new Date().toISOString(),
        });
      }
    }

    const after = this.getCurrentEvolutionStage();
    return {
      evolved: before !== after,
      from: before,
      to: after,
      xpGain: boundedXp,
    };
  }

  getRecentNutrientLedger(count: number = 120): NutrientLedgerEntry[] {
    const size = this.clampInt(count, 1, 1200, 120);
    return this.data.qualityTelemetry.nutrientLedger.slice(-size);
  }

  getTodayNutrientMetrics(timezone: string = "Asia/Seoul"): {
    nutrientIntake: number;
    acceptedCount: number;
    avgDigestScore: number;
    xpGain: number;
    xpGainBySource: { onchain: number; market: number; news: number };
    evolutionEvent: number;
  } {
    const todayKey = this.getDateKey(new Date(), timezone);
    const todayRows = this.data.qualityTelemetry.nutrientLedger.filter((row) =>
      this.isTodayByTimezone(row.capturedAt, timezone)
    );
    const acceptedCount = todayRows.filter((row) => row.accepted).length;
    const avgDigestScore =
      todayRows.length > 0
        ? Math.round((todayRows.reduce((sum, row) => sum + row.digestScore.total, 0) / todayRows.length) * 100) / 100
        : 0;
    const xpBucket = this.data.qualityTelemetry.xpGainBySource[todayKey];
    const evolutionEvent = this.data.qualityTelemetry.evolutionHistory.filter((row) =>
      this.isTodayByTimezone(row.capturedAt, timezone)
    ).length;

    return {
      nutrientIntake: todayRows.length,
      acceptedCount,
      avgDigestScore,
      xpGain: xpBucket?.total || 0,
      xpGainBySource: {
        onchain: xpBucket?.onchain || 0,
        market: xpBucket?.market || 0,
        news: xpBucket?.news || 0,
      },
      evolutionEvent,
    };
  }

  // 오늘 댓글 단 개수
  getTodayReplyCount(timezone: string = "Asia/Seoul"): number {
    return this.data.tweets.filter((tweet) => this.isTodayByTimezone(tweet.timestamp, timezone) && tweet.type === "reply").length;
  }

  // 오늘 글(원글/브리핑) 개수
  getTodayPostCount(timezone: string = "Asia/Seoul"): number {
    return this.data.tweets.filter((tweet) => this.isTodayByTimezone(tweet.timestamp, timezone) && tweet.type === "briefing").length;
  }

  getRecentBriefingLaneUsage(hours: number = 24): Array<{ lane: TrendLane; count: number }> {
    const safeHours = this.clampInt(hours, 1, 240, 24);
    const threshold = Date.now() - safeHours * 60 * 60 * 1000;
    const counter: Record<TrendLane, number> = {
      protocol: 0,
      ecosystem: 0,
      regulation: 0,
      macro: 0,
      onchain: 0,
      "market-structure": 0,
    };

    for (const tweet of this.data.tweets) {
      if (tweet.type !== "briefing") continue;
      const ts = new Date(tweet.timestamp).getTime();
      if (!Number.isFinite(ts) || ts < threshold) continue;
      const lane = this.normalizeTrendLane(tweet.meta?.lane);
      if (!lane) continue;
      counter[lane] += 1;
    }

    return Object.entries(counter)
      .map(([lane, count]) => ({ lane: lane as TrendLane, count }))
      .sort((a, b) => b.count - a.count);
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

  hasRecentSignalFingerprint(key: string, withinHours: number = 8): boolean {
    const normalizedKey = this.normalizeSignalFingerprintKey(key);
    if (!normalizedKey) return false;
    const hours = this.clamp(Number.isFinite(withinHours) ? withinHours : 8, 1, 72);
    const threshold = Date.now() - hours * 60 * 60 * 1000;
    return this.data.qualityTelemetry.signalFingerprints.some((row) => {
      if (row.key !== normalizedKey) return false;
      const ts = new Date(row.capturedAt).getTime();
      return Number.isFinite(ts) && ts >= threshold;
    });
  }

  recordSignalFingerprint(input: { key: string; signature: string; context?: string }): void {
    const key = this.normalizeSignalFingerprintKey(input.key);
    const signature = this.normalizeSignalFingerprintSignature(input.signature);
    if (!key || !signature) return;

    this.data.qualityTelemetry.signalFingerprints.push({
      key,
      signature,
      context: typeof input.context === "string" && input.context.trim() ? input.context.trim().slice(0, 180) : undefined,
      capturedAt: new Date().toISOString(),
    });
    this.compactSignalFingerprints(500, 14);
    this.save();
  }

  getRecentSignalFingerprints(count: number = 20): SignalFingerprintRecord[] {
    const size = this.clampInt(count, 1, 200, 20);
    return this.data.qualityTelemetry.signalFingerprints.slice(-size);
  }

  recordFearGreedPoint(value: number, label?: string): void {
    const normalized = this.clampInt(value, 0, 100, -1);
    if (normalized < 0) return;
    this.data.qualityTelemetry.fearGreedHistory.push({
      value: normalized,
      label: typeof label === "string" && label.trim() ? label.trim().slice(0, 40) : undefined,
      capturedAt: new Date().toISOString(),
    });
    this.compactFearGreedHistory(500, 21);
    this.save();
  }

  getLatestFearGreedPoint(withinHours: number = 72): FearGreedHistoryRecord | null {
    const hours = this.clamp(Number.isFinite(withinHours) ? withinHours : 72, 1, 720);
    const threshold = Date.now() - hours * 60 * 60 * 1000;
    const history = this.data.qualityTelemetry.fearGreedHistory;
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const item = history[i];
      const ts = new Date(item.capturedAt).getTime();
      if (!Number.isFinite(ts)) continue;
      if (ts >= threshold) {
        return item;
      }
      break;
    }
    return null;
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

  private upsertNarrativeThread(input: {
    lane: TrendLane;
    eventId: string;
    headline: string;
    evidenceIds: string[];
    mode?: NarrativeMode;
  }): void {
    const now = new Date().toISOString();
    const existing = this.data.autonomyContext.narrativeThreads.find((item) => item.eventId === input.eventId);
    if (existing) {
      existing.lane = input.lane;
      existing.headline = input.headline;
      existing.mode = input.mode || existing.mode;
      existing.activityCount += 1;
      existing.updatedAt = now;
      existing.evidenceIds = [...new Set([...existing.evidenceIds, ...input.evidenceIds])].slice(0, 8);
      return;
    }

    this.data.autonomyContext.narrativeThreads.push({
      id: `thread_${this.normalizeSignalFingerprintKey(input.eventId)}_${Date.now()}`,
      lane: input.lane,
      eventId: input.eventId,
      headline: input.headline,
      mode: input.mode,
      activityCount: 1,
      evidenceIds: input.evidenceIds.slice(0, 8),
      openedAt: now,
      updatedAt: now,
    });
  }

  private upsertOpenHypothesis(input: { lane: TrendLane; statement: string; evidenceIds: string[] }): void {
    const now = new Date().toISOString();
    const key = this.normalizeStatementKey(input.statement);
    const existing = this.data.autonomyContext.openHypotheses.find(
      (item) => this.normalizeStatementKey(item.statement) === key && (item.status === "open" || item.status === "watching")
    );
    if (existing) {
      existing.status = "watching";
      existing.confidence = this.clamp(existing.confidence + 0.06, 0.2, 0.95);
      existing.updatedAt = now;
      existing.evidenceIds = [...new Set([...existing.evidenceIds, ...input.evidenceIds])].slice(0, 8);
      return;
    }

    this.data.autonomyContext.openHypotheses.push({
      id: `hyp_${key.slice(0, 28)}_${Date.now()}`,
      lane: input.lane,
      statement: input.statement,
      confidence: 0.55,
      status: "open",
      evidenceIds: input.evidenceIds.slice(0, 8),
      createdAt: now,
      updatedAt: now,
    });
  }

  private appendResolvedClaim(input: {
    lane: TrendLane;
    claim: string;
    evidenceIds: string[];
    resolution: ClaimResolution;
  }): void {
    const now = new Date().toISOString();
    const key = this.normalizeStatementKey(input.claim);
    const hasRecentDuplicate = this.data.autonomyContext.resolvedClaims
      .slice(-20)
      .some((item) => this.normalizeStatementKey(item.claim) === key);
    if (hasRecentDuplicate) return;

    this.data.autonomyContext.openHypotheses = this.data.autonomyContext.openHypotheses.map((item) => {
      if (this.normalizeStatementKey(item.statement) === key && (item.status === "open" || item.status === "watching")) {
        return {
          ...item,
          status: "resolved",
          updatedAt: now,
        };
      }
      return item;
    });

    this.data.autonomyContext.resolvedClaims.push({
      id: `claim_${key.slice(0, 28)}_${Date.now()}`,
      lane: input.lane,
      claim: input.claim,
      resolution: input.resolution,
      confidence: 0.63,
      evidenceIds: input.evidenceIds.slice(0, 8),
      resolvedAt: now,
    });
  }

  private compactAutonomyContext(): void {
    this.data.autonomyContext.openHypotheses = this.data.autonomyContext.openHypotheses
      .sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime())
      .slice(-90);
    this.data.autonomyContext.narrativeThreads = this.data.autonomyContext.narrativeThreads
      .sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime())
      .slice(-140);
    this.data.autonomyContext.resolvedClaims = this.data.autonomyContext.resolvedClaims
      .sort((a, b) => new Date(a.resolvedAt).getTime() - new Date(b.resolvedAt).getTime())
      .slice(-220);
  }

  private extractHypothesisStatement(text: string): string {
    return text
      .replace(/\s+/g, " ")
      .split(/(?<=[.!?])\s+/)
      .map((line) => line.trim())
      .filter((line) => line.length >= 24)
      .map((line) => line.replace(/[?!.]+$/g, ""))
      .map((line) => line.replace(/^[-*]\s*/, ""))
      .find((line) => line.length >= 24) || "";
  }

  private looksLikeHypothesis(text: string): boolean {
    const lower = text.toLowerCase();
    if (lower.includes("?")) return true;
    return /(일까|인가|가능성|확인 필요|could|might|whether|if)/.test(lower);
  }

  private normalizeStatementKey(raw: string): string {
    return String(raw || "")
      .toLowerCase()
      .replace(/\$[a-z]{2,10}/g, "token")
      .replace(/[+-]?\d+(?:[.,]\d+)?%/g, "pct")
      .replace(/\d[\d,]*(?:\.\d+)?/g, "num")
      .replace(/[^a-z0-9가-힣\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
  }

  private buildUnlockedAbilities(previous: string[], current: string[], level: number): AbilityUnlock[] {
    const previousSet = new Set(previous.map((item) => item.trim()).filter(Boolean));
    const stage = this.levelToEvolutionStage(level);
    const unlocked = current
      .filter((item) => !previousSet.has(item))
      .map((name, index) => ({
        id: `ability_${stage}_${index + 1}`.toLowerCase(),
        name,
        description: `${name} 능력이 ${stage} 단계에서 해금됨`,
        unlockedAt: stage,
      }));
    return unlocked.slice(0, 8);
  }

  private levelToEvolutionStage(level: number): EvolutionStage {
    if (level >= 5) return "mythic";
    if (level === 4) return "sentinel";
    if (level === 3) return "crawler";
    if (level === 2) return "sprout";
    return "seed";
  }

  private normalizeEvolutionStage(raw: unknown): EvolutionStage | null {
    if (raw === "seed" || raw === "sprout" || raw === "crawler" || raw === "sentinel" || raw === "mythic") {
      return raw;
    }
    return null;
  }

  private normalizeTrendLane(raw: unknown): TrendLane | undefined {
    if (
      raw === "protocol" ||
      raw === "ecosystem" ||
      raw === "regulation" ||
      raw === "macro" ||
      raw === "onchain" ||
      raw === "market-structure"
    ) {
      return raw;
    }
    return undefined;
  }

  private normalizeNarrativeMode(raw: unknown): NarrativeMode | undefined {
    if (
      raw === "signal-pulse" ||
      raw === "builder-note" ||
      raw === "contrarian-check" ||
      raw === "field-journal" ||
      raw === "mythic-analogy"
    ) {
      return raw;
    }
    return undefined;
  }

  private normalizeHypothesisStatus(raw: unknown): HypothesisStatus | null {
    if (raw === "open" || raw === "watching" || raw === "resolved" || raw === "dropped") {
      return raw;
    }
    return null;
  }

  private normalizeClaimResolution(raw: unknown): ClaimResolution | null {
    if (raw === "supported" || raw === "invalidated" || raw === "superseded") {
      return raw;
    }
    return null;
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

  private normalizeSignalFingerprintKey(raw: unknown): string {
    if (typeof raw !== "string") return "";
    return raw.trim().toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 64);
  }

  private normalizeSignalFingerprintSignature(raw: unknown): string {
    if (typeof raw !== "string") return "";
    return raw.trim().replace(/\s+/g, " ").slice(0, 600);
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

  private compactSignalFingerprints(keepItems: number, keepDays: number): void {
    const now = Date.now();
    const keepMs = Math.max(1, keepDays) * 24 * 60 * 60 * 1000;
    const filtered = this.data.qualityTelemetry.signalFingerprints
      .filter((row) => {
        const ts = new Date(row.capturedAt).getTime();
        if (!Number.isFinite(ts)) return false;
        return now - ts <= keepMs;
      })
      .sort((a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime());
    this.data.qualityTelemetry.signalFingerprints = filtered.slice(-Math.max(1, keepItems));
  }

  private compactFearGreedHistory(keepItems: number, keepDays: number): void {
    const now = Date.now();
    const keepMs = Math.max(1, keepDays) * 24 * 60 * 60 * 1000;
    const filtered = this.data.qualityTelemetry.fearGreedHistory
      .filter((row) => {
        const ts = new Date(row.capturedAt).getTime();
        if (!Number.isFinite(ts)) return false;
        return now - ts <= keepMs;
      })
      .sort((a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime());
    this.data.qualityTelemetry.fearGreedHistory = filtered.slice(-Math.max(1, keepItems));
  }

  private compactNutrientLedger(keepItems: number, keepDays: number): void {
    const now = Date.now();
    const keepMs = Math.max(1, keepDays) * 24 * 60 * 60 * 1000;
    const filtered = this.data.qualityTelemetry.nutrientLedger
      .filter((row) => {
        const ts = new Date(row.capturedAt).getTime();
        if (!Number.isFinite(ts)) return false;
        return now - ts <= keepMs;
      })
      .sort((a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime());
    this.data.qualityTelemetry.nutrientLedger = filtered.slice(-Math.max(1, keepItems));
  }

  private compactXpGainBySource(keepDays: number): void {
    const entries = Object.entries(this.data.qualityTelemetry.xpGainBySource);
    if (entries.length <= keepDays) return;
    entries
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .slice(0, Math.max(0, entries.length - keepDays))
      .forEach(([key]) => {
        delete this.data.qualityTelemetry.xpGainBySource[key];
      });
  }

  private compactEvolutionHistory(keepItems: number, keepDays: number): void {
    const now = Date.now();
    const keepMs = Math.max(1, keepDays) * 24 * 60 * 60 * 1000;
    const filtered = this.data.qualityTelemetry.evolutionHistory
      .filter((row) => {
        const ts = new Date(row.capturedAt).getTime();
        if (!Number.isFinite(ts)) return false;
        return now - ts <= keepMs;
      })
      .sort((a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime());
    this.data.qualityTelemetry.evolutionHistory = filtered.slice(-Math.max(1, keepItems));
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
