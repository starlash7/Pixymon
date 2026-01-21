import { AgentRuntime, elizaLogger } from "@elizaos/core";
import { BlockchainNewsService } from "./blockchain-news.js";

/**
 * 스케줄러 서비스
 *
 * 정해진 시간에 자동으로 뉴스를 수집하고 트윗을 발행합니다.
 */
export class SchedulerService {
  private runtime: AgentRuntime;
  private newsService: BlockchainNewsService;
  private isRunning: boolean = false;
  private intervalId: NodeJS.Timeout | null = null;

  // 기본 설정: 매일 오전 9시, 오후 6시에 포스팅
  private postingHours: number[] = [9, 18];

  constructor(runtime: AgentRuntime, newsService: BlockchainNewsService) {
    this.runtime = runtime;
    this.newsService = newsService;
  }

  /**
   * 스케줄러 시작
   */
  start(): void {
    if (this.isRunning) {
      elizaLogger.warn("⚠️ 스케줄러가 이미 실행 중입니다.");
      return;
    }

    this.isRunning = true;
    elizaLogger.info("⏰ 뉴스 포스팅 스케줄러 시작");
    elizaLogger.info(`   포스팅 시간: ${this.postingHours.map((h) => `${h}:00`).join(", ")}`);

    // 매 분마다 체크 (더 정밀한 스케줄링을 위해)
    this.intervalId = setInterval(() => this.checkAndPost(), 60 * 1000);

    // 시작 시 즉시 한 번 체크
    this.checkAndPost();
  }

  /**
   * 스케줄러 중지
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    elizaLogger.info("⏹️ 뉴스 포스팅 스케줄러 중지");
  }

  /**
   * 현재 시간이 포스팅 시간인지 확인하고 포스팅
   */
  private async checkAndPost(): Promise<void> {
    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();

    // 정각(00분)에만 포스팅
    if (currentMinute !== 0) {
      return;
    }

    // 포스팅 시간인지 확인
    if (!this.postingHours.includes(currentHour)) {
      return;
    }

    elizaLogger.info(`📢 정기 뉴스 포스팅 시간입니다 (${currentHour}:00)`);
    await this.postDailyNews();
  }

  /**
   * 일일 뉴스 포스팅
   */
  async postDailyNews(): Promise<void> {
    try {
      elizaLogger.info("📰 일일 뉴스 요약 생성 중...");

      // 뉴스 및 마켓 데이터 수집
      const [news, marketData] = await Promise.all([
        this.newsService.getTodayHotNews(),
        this.newsService.getMarketData(),
      ]);

      if (news.length === 0) {
        elizaLogger.warn("⚠️ 수집된 뉴스가 없습니다.");
        return;
      }

      // 트윗 포맷팅
      const tweetContent = this.newsService.formatNewsForTweet(news, marketData);

      elizaLogger.info("📝 생성된 트윗 내용:");
      elizaLogger.info(tweetContent);

      // TODO: 실제 트윗 발행
      // await this.runtime.clients.twitter?.post(tweetContent);

      elizaLogger.success("✅ 뉴스 포스팅 완료!");

      // 상세 뉴스 스레드 작성 (선택적)
      if (news.length > 3) {
        await this.postNewsThread(news.slice(3, 6));
      }
    } catch (error) {
      elizaLogger.error("❌ 뉴스 포스팅 실패:", error);
    }
  }

  /**
   * 뉴스 스레드 작성 (추가 뉴스가 있을 경우)
   */
  private async postNewsThread(additionalNews: any[]): Promise<void> {
    elizaLogger.info("🧵 추가 뉴스 스레드 작성 중...");

    for (const news of additionalNews) {
      const threadTweet = `📌 ${news.title}\n\n${news.summary}\n\n🔗 ${news.source}`;

      // TODO: 스레드로 연결하여 트윗 발행
      elizaLogger.info(`   - ${news.title}`);
    }
  }

  /**
   * 수동 포스팅 트리거
   */
  async triggerManualPost(): Promise<void> {
    elizaLogger.info("🔄 수동 뉴스 포스팅 시작...");
    await this.postDailyNews();
  }

  /**
   * 포스팅 시간 설정 변경
   */
  setPostingHours(hours: number[]): void {
    this.postingHours = hours.filter((h) => h >= 0 && h <= 23);
    elizaLogger.info(`⏰ 포스팅 시간 변경: ${this.postingHours.map((h) => `${h}:00`).join(", ")}`);
  }

  /**
   * 현재 상태 조회
   */
  getStatus(): {
    isRunning: boolean;
    postingHours: number[];
    nextPostTime: Date | null;
  } {
    let nextPostTime: Date | null = null;

    if (this.isRunning && this.postingHours.length > 0) {
      const now = new Date();
      const currentHour = now.getHours();

      // 다음 포스팅 시간 계산
      const nextHour = this.postingHours.find((h) => h > currentHour);

      if (nextHour !== undefined) {
        nextPostTime = new Date(now);
        nextPostTime.setHours(nextHour, 0, 0, 0);
      } else {
        // 다음 날 첫 포스팅 시간
        nextPostTime = new Date(now);
        nextPostTime.setDate(nextPostTime.getDate() + 1);
        nextPostTime.setHours(this.postingHours[0], 0, 0, 0);
      }
    }

    return {
      isRunning: this.isRunning,
      postingHours: this.postingHours,
      nextPostTime,
    };
  }
}

export default SchedulerService;
