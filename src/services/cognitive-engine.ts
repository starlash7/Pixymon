import Anthropic from "@anthropic-ai/sdk";
import { BlockchainNewsService, MarketData } from "./blockchain-news.js";
import { memory } from "./memory.js";
import { OnchainDataService } from "./onchain-data.js";
import { ReflectionService } from "./reflection.js";
import { ResearchEngine } from "./research-engine.js";
import { CLAUDE_RESEARCH_MODEL } from "./llm.js";
import {
  BeliefHypothesis,
  ClusterSentiment,
  CognitiveActionPlan,
  CognitiveObjective,
  CognitivePacket,
  CognitiveRunContext,
  MomentumCluster,
} from "../types/agent.js";
import { detectLanguage } from "../utils/mood.js";

interface AnalyzeTargetInput {
  objective: CognitiveObjective;
  text: string;
  author?: string;
  language?: "ko" | "en";
  runContext?: CognitiveRunContext;
}

interface FearGreedPoint {
  value: number;
  label: string;
}

const TOPIC_KEYWORDS: Record<string, string[]> = {
  bitcoin: ["btc", "bitcoin", "etf", "halving", "mempool"],
  ethereum: ["eth", "ethereum", "l2", "layer2", "rollup", "blob", "gas"],
  defi: ["defi", "tvl", "yield", "dex", "lending", "liquidity"],
  perp: ["perp", "futures", "funding", "open interest", "oi", "liquidation"],
  ai: ["ai", "agent", "inference", "gpu", "compute"],
  meme: ["meme", "memecoin", "degen", "pump", "narrative"],
  macro: ["fed", "rates", "dxy", "macro", "inflation", "liquidity"],
};

const POSITIVE_WORDS = ["up", "surge", "bull", "breakout", "rebound", "strong", "상승", "강세", "돌파", "유입"];
const NEGATIVE_WORDS = ["down", "dump", "bear", "sell", "weak", "drop", "하락", "약세", "이탈", "유출"];

export class FiveLayerCognitiveEngine {
  private readonly newsService: BlockchainNewsService;
  private readonly onchainService: OnchainDataService;
  private readonly reflectionService: ReflectionService;
  private readonly researchEngine: ResearchEngine;

  constructor(
    claude: Anthropic,
    model: string,
    baseSystemPrompt: string,
    researchModel: string = CLAUDE_RESEARCH_MODEL
  ) {
    this.newsService = new BlockchainNewsService();
    this.onchainService = new OnchainDataService();
    this.reflectionService = new ReflectionService();
    this.researchEngine = new ResearchEngine(claude, researchModel || model, baseSystemPrompt);
  }

  async prepareRunContext(objective: CognitiveObjective): Promise<CognitiveRunContext> {
    const [marketData, fearGreed, onchainSnapshot] = await Promise.all([
      this.newsService.getMarketData(),
      this.newsService.getFearGreedIndex(),
      this.onchainService.buildSnapshot(),
    ]);

    const marketContext = this.buildMarketContext(marketData, fearGreed);
    const onchainContext = this.onchainService.formatSnapshotForPrompt(onchainSnapshot);
    const reflectionContext = this.buildReflectionContext();
    const evolutionContext = memory.getAgentStateContext();

    // Layer 1 실행 자체를 signal 학습으로 반영
    memory.recordCognitiveActivity("signal", 1);

    return {
      objective,
      createdAt: new Date().toISOString(),
      marketContext,
      onchainContext,
      reflectionContext,
      evolutionContext,
    };
  }

  async analyzeTarget(input: AnalyzeTargetInput): Promise<CognitivePacket> {
    const runContext = input.runContext || (await this.prepareRunContext(input.objective));
    const language = input.language || detectLanguage(input.text);
    const clusters = this.buildMomentumClusters(input.text, runContext.marketContext);
    const topic = this.buildTopic(input.text, input.author, clusters);

    const insight = await this.researchEngine.generateInsight({
      objective: input.objective,
      language,
      topic,
      marketContext: runContext.marketContext,
      onchainContext: runContext.onchainContext,
      influencerContext: this.buildSourceContext(input.text, input.author, clusters),
      memoryContext: `${memory.getContext()}\n\n${runContext.reflectionContext}\n${runContext.evolutionContext}`,
    });

    const beliefs = this.buildBeliefs(clusters, insight.claim, insight.counterpoint, insight.confidence);
    const action = this.decideAction(input.objective, clusters, insight.confidence, insight.actionStyle);
    const promptContext = this.formatPromptContext(runContext, clusters, beliefs, insight, action);

    // Layer 3(가설) + Layer 4(행동결정) 실행을 reasoning 학습으로 반영
    const reasoningGain = insight.confidence >= 0.65 ? 2 : 1;
    memory.recordCognitiveActivity("reasoning", reasoningGain);

    return {
      objective: input.objective,
      language,
      clusters,
      beliefs,
      insight,
      action,
      promptContext,
    };
  }

  private buildMarketContext(
    marketData: MarketData[],
    fearGreed: FearGreedPoint | null
  ): string {
    const topCoins = marketData.slice(0, 5);
    const marketLines = topCoins.map((coin) => {
      const sign = coin.change24h >= 0 ? "+" : "";
      return `- ${coin.symbol} $${coin.price.toLocaleString()} (${sign}${coin.change24h.toFixed(2)}%)`;
    });

    const fearGreedLine = fearGreed
      ? `FearGreed ${fearGreed.value} (${fearGreed.label})`
      : "FearGreed unavailable";

    return [
      "## Market Snapshot",
      fearGreedLine,
      ...marketLines,
    ].join("\n");
  }

  private buildReflectionContext(): string {
    const recentTweets = memory.getRecentTweets(80);
    if (recentTweets.length >= 8) {
      this.reflectionService.runAndSave(recentTweets, 48, {});
    }
    return this.reflectionService.getLatestPolicyContext();
  }

  private buildMomentumClusters(text: string, marketContext: string): MomentumCluster[] {
    const combinedText = `${text}\n${marketContext}`;
    const textLower = combinedText.toLowerCase();
    const tickers = this.extractTickers(combinedText);
    const clusters: MomentumCluster[] = [];

    let idx = 0;
    for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
      const keywordHits = keywords.reduce((count, keyword) => count + this.countSubstring(textLower, keyword), 0);
      const topicTickers = tickers.filter((ticker) => this.tickerMatchesTopic(ticker, topic));
      const evidenceCount = keywordHits + topicTickers.length;
      if (evidenceCount === 0) {
        continue;
      }

      const sentiment = this.estimateSentiment(textLower);
      const intensityBonus = this.getIntensityBonus(text);
      const score = Math.min(1, Math.round((0.18 * evidenceCount + intensityBonus) * 100) / 100);
      clusters.push({
        id: `cluster-${idx++}-${topic}`,
        topic,
        tickers: topicTickers,
        score,
        sentiment,
        evidenceCount,
        summary: `${topic} 관련 키워드 ${keywordHits}회 + 티커 ${topicTickers.length}개`,
      });
    }

    if (clusters.length === 0) {
      const fallbackSentiment = this.estimateSentiment(textLower);
      clusters.push({
        id: "cluster-fallback-general",
        topic: "general-market",
        tickers: tickers.slice(0, 3),
        score: 0.35,
        sentiment: fallbackSentiment,
        evidenceCount: Math.max(1, tickers.length),
        summary: "명확한 내러티브 클러스터가 없어 일반 시장 관찰로 분류",
      });
    }

    return clusters
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
  }

  private buildTopic(text: string, author: string | undefined, clusters: MomentumCluster[]): string {
    const lead = clusters[0];
    const authorPart = author ? `@${author}` : "unknown-author";
    const tickerPart = lead?.tickers.slice(0, 2).join(", ") || "no-ticker";
    return `${lead?.topic || "general-market"} | source:${authorPart} | tickers:${tickerPart} | text:${text.slice(0, 120)}`;
  }

  private buildSourceContext(text: string, author: string | undefined, clusters: MomentumCluster[]): string {
    const clusterText = clusters
      .map((cluster) => `- ${cluster.topic} score ${cluster.score} (${cluster.summary})`)
      .join("\n");

    return [
      `source: ${author ? `@${author}` : "unknown"}`,
      `raw: ${text.slice(0, 260)}`,
      "cluster-summary:",
      clusterText,
    ].join("\n");
  }

  private buildBeliefs(
    clusters: MomentumCluster[],
    claim: string,
    counterpoint: string,
    confidence: number
  ): BeliefHypothesis[] {
    const leadClusters = clusters.slice(0, 2);
    const beliefs: BeliefHypothesis[] = [
      {
        id: "belief-main",
        statement: claim,
        probability: this.clamp(Math.round(confidence * 100) / 100, 0.2, 0.95),
        basedOnClusterIds: leadClusters.map((cluster) => cluster.id),
        contradictingSignals: counterpoint ? [counterpoint] : [],
      },
    ];

    if (counterpoint) {
      beliefs.push({
        id: "belief-counter",
        statement: counterpoint,
        probability: this.clamp(Math.round((1 - confidence) * 100) / 100, 0.05, 0.8),
        basedOnClusterIds: leadClusters.map((cluster) => cluster.id),
        contradictingSignals: [claim],
      });
    }

    return beliefs;
  }

  private decideAction(
    objective: CognitiveObjective,
    clusters: MomentumCluster[],
    confidence: number,
    style: CognitiveActionPlan["style"]
  ): CognitiveActionPlan {
    const lead = clusters[0];
    const hasRiskTone = lead?.sentiment === "bearish" || lead?.topic === "macro";

    let intent: CognitiveActionPlan["intent"] = "probe";
    if (confidence >= 0.72 && style === "assertive") {
      intent = "thesis";
    } else if (confidence >= 0.55) {
      intent = "challenge";
    }

    const maxChars = objective === "engagement" ? 200 : objective === "reply" ? 120 : 220;
    const shouldEndWithQuestion = intent !== "thesis" || confidence < 0.67;
    const riskMode: CognitiveActionPlan["riskMode"] = hasRiskTone
      ? "defensive"
      : confidence > 0.75
        ? "aggressive"
        : "balanced";

    return {
      intent,
      style,
      shouldReply: true,
      shouldEndWithQuestion,
      maxChars,
      riskMode,
      rationale: `lead:${lead?.topic || "general"} conf:${Math.round(confidence * 100)}% style:${style}`,
    };
  }

  private formatPromptContext(
    runContext: CognitiveRunContext,
    clusters: MomentumCluster[],
    beliefs: BeliefHypothesis[],
    insight: CognitivePacket["insight"],
    action: CognitiveActionPlan
  ): string {
    const clusterText = clusters
      .map(
        (cluster) =>
          `- ${cluster.topic} | score ${cluster.score} | sentiment ${cluster.sentiment} | ${cluster.summary}`
      )
      .join("\n");

    const beliefText = beliefs
      .map(
        (belief) =>
          `- ${belief.statement} (p=${Math.round(belief.probability * 100)}%, basedOn=${belief.basedOnClusterIds.join(",")})`
      )
      .join("\n");

    return [
      "## Layer1 Signals",
      runContext.marketContext,
      runContext.onchainContext,
      "",
      "## Layer2 Clusters",
      clusterText,
      "",
      "## Layer3 Beliefs",
      beliefText,
      "",
      "## Layer3 Insight",
      this.researchEngine.formatInsightForPrompt(insight),
      "",
      "## Layer4 Action Plan",
      `- intent: ${action.intent}`,
      `- style: ${action.style}`,
      `- riskMode: ${action.riskMode}`,
      `- maxChars: ${action.maxChars}`,
      `- questionEnding: ${action.shouldEndWithQuestion}`,
      `- rationale: ${action.rationale}`,
      "",
      "## Layer5 Reflection",
      runContext.reflectionContext,
      runContext.evolutionContext,
    ]
      .filter(Boolean)
      .join("\n");
  }

  private extractTickers(text: string): string[] {
    const matches = text.match(/\$[A-Za-z]{2,10}/g) || [];
    const normalized = matches.map((item) => item.toUpperCase());
    return [...new Set(normalized)];
  }

  private tickerMatchesTopic(ticker: string, topic: string): boolean {
    if (topic === "bitcoin") return ticker === "$BTC";
    if (topic === "ethereum") return ticker === "$ETH" || ticker === "$ARB" || ticker === "$OP";
    if (topic === "defi") return ticker === "$UNI" || ticker === "$AAVE" || ticker === "$CRV" || ticker === "$GMX";
    if (topic === "perp") return ticker === "$HYPE" || ticker === "$DYDX" || ticker === "$GMX";
    if (topic === "ai") return ticker === "$TAO" || ticker === "$RNDR" || ticker === "$FET";
    if (topic === "meme") return ticker === "$DOGE" || ticker === "$SHIB" || ticker === "$PEPE";
    return true;
  }

  private countSubstring(text: string, token: string): number {
    if (!token) return 0;
    let count = 0;
    let cursor = 0;
    while (cursor < text.length) {
      const idx = text.indexOf(token, cursor);
      if (idx === -1) break;
      count++;
      cursor = idx + token.length;
    }
    return count;
  }

  private getIntensityBonus(text: string): number {
    const upper = (text.match(/[A-Z]{3,}/g) || []).length;
    const punctuation = (text.match(/[!?]/g) || []).length;
    const bonus = upper * 0.03 + punctuation * 0.02;
    return this.clamp(Math.round(bonus * 100) / 100, 0, 0.25);
  }

  private estimateSentiment(textLower: string): ClusterSentiment {
    const positive = POSITIVE_WORDS.reduce((count, token) => count + this.countSubstring(textLower, token), 0);
    const negative = NEGATIVE_WORDS.reduce((count, token) => count + this.countSubstring(textLower, token), 0);
    if (positive > negative + 1) return "bullish";
    if (negative > positive + 1) return "bearish";
    if (positive === 0 && negative === 0) return "neutral";
    return "mixed";
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
  }
}

export default FiveLayerCognitiveEngine;
