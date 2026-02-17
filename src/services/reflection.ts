import fs from "fs";
import path from "path";
import { ReflectionPolicy } from "../types/agent.js";

interface ReflectionStore {
  notes: ReflectionPolicy[];
  updatedAt: string;
}

interface ReflectionTweet {
  id: string;
  content: string;
  timestamp: string;
  type: "briefing" | "reply" | "quote";
}

interface TweetPublicMetrics {
  like_count?: number;
  reply_count?: number;
  retweet_count?: number;
  quote_count?: number;
  impression_count?: number;
}

type TweetEngagementMap = Record<string, TweetPublicMetrics>;

const DATA_DIR = path.join(process.cwd(), "data");
const REFLECTION_PATH = path.join(DATA_DIR, "reflection.json");
const REFLECTION_SAVE_DEBOUNCE_MS = 350;

const EMPTY_STORE: ReflectionStore = {
  notes: [],
  updatedAt: new Date().toISOString(),
};

export class ReflectionService {
  private store: ReflectionStore;
  private writeTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.store = this.load();
    process.once("exit", () => {
      this.flushWrite();
    });
  }

  createPolicyFromTweets(
    tweets: ReflectionTweet[],
    windowHours: number = 24,
    engagementMap: TweetEngagementMap = {}
  ): ReflectionPolicy {
    const now = Date.now();
    const cutoffMs = now - windowHours * 60 * 60 * 1000;
    const recentTweets = tweets.filter((tweet) => new Date(tweet.timestamp).getTime() >= cutoffMs);

    const totalTweets = recentTweets.length;
    const replyCount = recentTweets.filter((tweet) => tweet.type === "reply").length;
    const avgLength =
      totalTweets > 0
        ? recentTweets.reduce((acc, tweet) => acc + tweet.content.length, 0) / totalTweets
        : 0;
    const tickerMentions = recentTweets.filter((tweet) => /\$[A-Z]{2,10}/.test(tweet.content)).length;
    const questionEndings = recentTweets.filter((tweet) => /[?？]\s*$/.test(tweet.content)).length;

    const replyRatio = totalTweets > 0 ? replyCount / totalTweets : 0;
    const tickerMentionRatio = totalTweets > 0 ? tickerMentions / totalTweets : 0;
    const questionEndingRatio = totalTweets > 0 ? questionEndings / totalTweets : 0;
    const engagementMetrics = this.computeEngagementMetrics(recentTweets, engagementMap);

    const strengths: string[] = [];
    const gaps: string[] = [];
    const policyAdjustments: string[] = [];

    if (replyRatio >= 0.45) {
      strengths.push("대화형 응답 비중이 높아 커뮤니티 접점이 잘 유지됨");
    } else {
      gaps.push("대화형 응답 비중이 낮아 토론 확장성이 떨어짐");
      policyAdjustments.push("인플루언서 댓글은 질문형 마무리 비중을 늘려 토론 길이 확보");
    }

    if (tickerMentionRatio >= 0.35) {
      strengths.push("티커 언급 비율이 높아 데이터 기반 문맥이 유지됨");
    } else {
      gaps.push("티커 근거가 약해 의견형 문장으로 보일 위험");
      policyAdjustments.push("주장마다 최소 1개 티커/수치 근거를 포함");
    }

    if (avgLength > 185) {
      gaps.push("평균 길이가 길어 가독성이 떨어질 수 있음");
      policyAdjustments.push("핵심 주장 1개 + 근거 1~2개로 압축");
    } else if (avgLength >= 90) {
      strengths.push("평균 길이가 논점 전달에 적절한 범위");
    } else {
      gaps.push("너무 짧은 답변 비중이 높아 깊이 있는 토론이 부족");
      policyAdjustments.push("핵심 주장과 반론을 최소 1문장씩 포함");
    }

    if (questionEndingRatio < 0.2) {
      gaps.push("질문형 마무리가 부족해 대화 지속성이 약함");
      policyAdjustments.push("댓글/답글의 30% 이상은 열린 질문으로 종료");
    } else {
      strengths.push("질문형 마무리가 있어 토론 유도력이 확보됨");
    }

    if (engagementMetrics.engagementCoverage >= 0.5) {
      if (engagementMetrics.likeRate >= 0.012) {
        strengths.push("좋아요 비율이 준수하여 메시지 수용도가 높음");
      } else {
        gaps.push("좋아요 비율이 낮아 후킹 문장/첫 문장 개선 필요");
        policyAdjustments.push("첫 문장에 주장과 수치를 함께 배치해 스크롤 정지율 강화");
      }

      if (engagementMetrics.replyReceiveRate >= 0.002) {
        strengths.push("답글 유입률이 있어 토론 확장성이 확인됨");
      } else {
        gaps.push("답글 유입률이 낮아 논쟁적 질문 설계가 약함");
        policyAdjustments.push("assertive 톤에서도 마지막 문장은 반론 유도 질문으로 마무리");
      }
    } else {
      gaps.push("X 반응 데이터 커버리지가 낮아 회고 신뢰도가 제한됨");
      policyAdjustments.push("트윗 ID 기반 public_metrics 수집률을 70% 이상으로 확보");
    }

    if (totalTweets < 8) {
      gaps.push("회고 샘플 수가 작아 정책 신뢰도가 낮음");
      policyAdjustments.push("샘플이 충분할 때까지 보수적 톤 유지");
    }

    if (policyAdjustments.length === 0) {
      policyAdjustments.push("현재 톤 유지, 다만 확신도 70% 미만 주장은 질문형으로 제한");
    }

    return {
      createdAt: new Date().toISOString(),
      windowHours,
      summary: this.buildSummary(totalTweets, replyRatio, tickerMentionRatio, questionEndingRatio),
      strengths,
      gaps,
      policyAdjustments: policyAdjustments.slice(0, 4),
      metrics: {
        totalTweets,
        replyRatio: this.roundTwo(replyRatio),
        averageLength: this.roundTwo(avgLength),
        tickerMentionRatio: this.roundTwo(tickerMentionRatio),
        questionEndingRatio: this.roundTwo(questionEndingRatio),
        averageLikes: this.roundTwo(engagementMetrics.averageLikes),
        averageRepliesReceived: this.roundTwo(engagementMetrics.averageRepliesReceived),
        likeRate: this.roundFour(engagementMetrics.likeRate),
        replyReceiveRate: this.roundFour(engagementMetrics.replyReceiveRate),
        engagementCoverage: this.roundTwo(engagementMetrics.engagementCoverage),
      },
    };
  }

  savePolicy(policy: ReflectionPolicy): void {
    this.store.notes.push(policy);
    if (this.store.notes.length > 60) {
      this.store.notes = this.store.notes.slice(-60);
    }
    this.store.updatedAt = new Date().toISOString();
    this.write(this.store);
  }

  runAndSave(
    tweets: ReflectionTweet[],
    windowHours: number = 24,
    engagementMap: TweetEngagementMap = {}
  ): ReflectionPolicy {
    const policy = this.createPolicyFromTweets(tweets, windowHours, engagementMap);
    this.savePolicy(policy);
    return policy;
  }

  getLatestPolicy(): ReflectionPolicy | null {
    if (this.store.notes.length === 0) {
      return null;
    }
    return this.store.notes[this.store.notes.length - 1];
  }

  getLatestPolicyContext(): string {
    const latest = this.getLatestPolicy();
    if (!latest) {
      return "## 최근 회고 정책\n- 아직 회고 데이터가 없음. 단정 대신 관찰 중심으로 진행";
    }

    const lines = [
      "## 최근 회고 정책",
      `- 요약: ${latest.summary}`,
      `- 반응지표: LikeRate ${Math.round(latest.metrics.likeRate * 10000) / 100}% | ReplyRate ${Math.round(latest.metrics.replyReceiveRate * 10000) / 100}%`,
      ...latest.policyAdjustments.slice(0, 3).map((item) => `- 정책: ${item}`),
    ];
    return lines.join("\n");
  }

  private load(): ReflectionStore {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }

      if (!fs.existsSync(REFLECTION_PATH)) {
        this.write(EMPTY_STORE, true);
        return EMPTY_STORE;
      }

      const raw = fs.readFileSync(REFLECTION_PATH, "utf-8");
      const parsed = JSON.parse(raw) as ReflectionStore;
      if (!Array.isArray(parsed.notes)) {
        return EMPTY_STORE;
      }
      return parsed;
    } catch (error) {
      console.error("[REFLECTION] 로드 실패:", error);
      return EMPTY_STORE;
    }
  }

  private write(store: ReflectionStore, immediate: boolean = false): void {
    this.store = store;
    if (immediate) {
      this.flushWrite();
      return;
    }
    if (this.writeTimer) {
      return;
    }
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.flushWrite();
    }, REFLECTION_SAVE_DEBOUNCE_MS);
  }

  private flushWrite(): void {
    try {
      if (this.writeTimer) {
        clearTimeout(this.writeTimer);
        this.writeTimer = null;
      }
      fs.writeFileSync(REFLECTION_PATH, JSON.stringify(this.store, null, 2));
    } catch (error) {
      console.error("[REFLECTION] 저장 실패:", error);
    }
  }

  private buildSummary(
    totalTweets: number,
    replyRatio: number,
    tickerRatio: number,
    questionRatio: number
  ): string {
    return [
      `최근 ${totalTweets}개 발화 기준`,
      `대화 비중 ${Math.round(replyRatio * 100)}%`,
      `티커 근거 ${Math.round(tickerRatio * 100)}%`,
      `질문형 마무리 ${Math.round(questionRatio * 100)}%`,
    ].join(" | ");
  }

  private computeEngagementMetrics(
    tweets: ReflectionTweet[],
    engagementMap: TweetEngagementMap
  ): {
    averageLikes: number;
    averageRepliesReceived: number;
    likeRate: number;
    replyReceiveRate: number;
    engagementCoverage: number;
  } {
    if (tweets.length === 0) {
      return {
        averageLikes: 0,
        averageRepliesReceived: 0,
        likeRate: 0,
        replyReceiveRate: 0,
        engagementCoverage: 0,
      };
    }

    const withMetrics = tweets
      .map((tweet) => {
        const metrics = engagementMap[tweet.id];
        if (!metrics) return null;
        const likes = metrics.like_count ?? 0;
        const replies = metrics.reply_count ?? 0;
        const impressions = metrics.impression_count ?? 0;
        return { likes, replies, impressions };
      })
      .filter((item): item is { likes: number; replies: number; impressions: number } => item !== null);

    if (withMetrics.length === 0) {
      return {
        averageLikes: 0,
        averageRepliesReceived: 0,
        likeRate: 0,
        replyReceiveRate: 0,
        engagementCoverage: 0,
      };
    }

    const likesTotal = withMetrics.reduce((acc, item) => acc + item.likes, 0);
    const repliesTotal = withMetrics.reduce((acc, item) => acc + item.replies, 0);
    const impressionsTotal = withMetrics.reduce((acc, item) => acc + item.impressions, 0);

    const averageLikes = likesTotal / withMetrics.length;
    const averageRepliesReceived = repliesTotal / withMetrics.length;

    let likeRate = 0;
    let replyReceiveRate = 0;

    if (impressionsTotal > 0) {
      likeRate = likesTotal / impressionsTotal;
      replyReceiveRate = repliesTotal / impressionsTotal;
    } else {
      // impression metric이 없을 때 보수적으로 트윗당 평균값을 pseudo-rate로 사용
      likeRate = averageLikes / 100;
      replyReceiveRate = averageRepliesReceived / 100;
    }

    return {
      averageLikes,
      averageRepliesReceived,
      likeRate,
      replyReceiveRate,
      engagementCoverage: withMetrics.length / tweets.length,
    };
  }

  private roundTwo(value: number): number {
    return Math.round(value * 100) / 100;
  }

  private roundFour(value: number): number {
    return Math.round(value * 10000) / 10000;
  }
}

export default ReflectionService;
