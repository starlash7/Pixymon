import { OnchainSignal, OnchainSnapshot, SignalDirection, SignalImportance } from "../types/agent.js";

interface DefiLlamaChain {
  name?: string;
  tvl?: number;
  change_1d?: number;
  change_7d?: number;
}

interface MempoolFeesResponse {
  fastestFee?: number;
  halfHourFee?: number;
  hourFee?: number;
  economyFee?: number;
  minimumFee?: number;
}

interface MempoolStatsResponse {
  count?: number;
  vsize?: number;
  total_fee?: number;
}

interface BlockchainChartPoint {
  x?: number;
  y?: number;
}

interface BlockchainChartResponse {
  status?: string;
  values?: BlockchainChartPoint[];
}

interface StablecoinChartPoint {
  date?: string;
  totalCirculatingUSD?: {
    peggedUSD?: number;
  };
}

export class OnchainDataService {
  private readonly llamaChainsUrl = "https://api.llama.fi/v2/chains";
  private readonly stablecoinTotalUrl = "https://stablecoins.llama.fi/stablecoincharts/all";
  private readonly mempoolFeesUrl = "https://mempool.space/api/v1/fees/recommended";
  private readonly mempoolStatsUrl = "https://mempool.space/api/mempool";
  private readonly blockchainChartBaseUrl = "https://api.blockchain.info/charts";

  async buildSnapshot(): Promise<OnchainSnapshot> {
    const [feeSignal, mempoolSignal, exchangeFlowSignal, whaleSignal, stablecoinSignal, tvlSignals] = await Promise.all([
      this.getBtcFeeSignal(),
      this.getMempoolPressureSignal(),
      this.getExchangeNetflowProxySignal(),
      this.getWhaleMovementSignal(),
      this.getStablecoinFlowSignal(),
      this.getTvlMomentumSignals(3),
    ]);

    const signals = [
      ...(feeSignal ? [feeSignal] : []),
      ...(mempoolSignal ? [mempoolSignal] : []),
      ...(exchangeFlowSignal ? [exchangeFlowSignal] : []),
      ...(whaleSignal ? [whaleSignal] : []),
      ...(stablecoinSignal ? [stablecoinSignal] : []),
      ...tvlSignals,
    ];

    if (signals.length === 0) {
      signals.push({
        id: "fallback-neutral",
        label: "온체인 데이터",
        value: "중립",
        source: "system",
        direction: "flat",
        importance: "low",
        summary: "현재 수집 가능한 온체인 시그널이 제한적이라 보수적으로 해석 필요",
      });
    }

    const highlights = signals
      .filter((signal) => signal.importance === "high" || signal.direction === "up")
      .slice(0, 3)
      .map((signal) => `${signal.label} ${signal.value}: ${signal.summary}`);

    const riskFlags = signals
      .filter((signal) => signal.importance === "high" && signal.direction === "down")
      .slice(0, 3)
      .map((signal) => `${signal.label} ${signal.value}`);

    return {
      createdAt: new Date().toISOString(),
      signals,
      highlights,
      riskFlags,
    };
  }

  formatSnapshotForPrompt(snapshot: OnchainSnapshot): string {
    let text = "## 온체인/플로우 시그널\n";

    snapshot.signals.forEach((signal) => {
      text += `- ${signal.label}: ${signal.value} | ${signal.summary} (source: ${signal.source})\n`;
    });

    if (snapshot.highlights.length > 0) {
      text += "\n### 하이라이트\n";
      snapshot.highlights.forEach((highlight) => {
        text += `- ${highlight}\n`;
      });
    }

    if (snapshot.riskFlags.length > 0) {
      text += "\n### 리스크 플래그\n";
      snapshot.riskFlags.forEach((risk) => {
        text += `- ${risk}\n`;
      });
    }

    return text.trim();
  }

  private async getBtcFeeSignal(): Promise<OnchainSignal | null> {
    try {
      const response = await fetch(this.mempoolFeesUrl);
      if (!response.ok) {
        return null;
      }

      const data = (await response.json()) as MempoolFeesResponse;
      if (typeof data.fastestFee !== "number" || typeof data.hourFee !== "number") {
        return null;
      }

      const fastestFee = data.fastestFee;
      const hourFee = data.hourFee;
      const feeSpread = fastestFee - hourFee;

      const direction: SignalDirection = fastestFee >= 35 ? "up" : fastestFee <= 10 ? "down" : "flat";
      const importance: SignalImportance =
        fastestFee >= 60 ? "high" : fastestFee >= 30 || feeSpread >= 20 ? "medium" : "low";

      return {
        id: "btc-fee-market",
        label: "BTC 네트워크 수수료",
        value: `${fastestFee} sat/vB`,
        source: "mempool.space",
        direction,
        importance,
        summary:
          fastestFee >= 60
            ? "온체인 혼잡이 강해서 단기적으로 과열 심리 가능성"
            : fastestFee <= 10
              ? "네트워크 혼잡이 완화되어 단기 과열은 제한적"
              : "수수료가 중립권, 급격한 과열/공포 신호는 아님",
      };
    } catch {
      return null;
    }
  }

  private async getMempoolPressureSignal(): Promise<OnchainSignal | null> {
    try {
      const response = await fetch(this.mempoolStatsUrl);
      if (!response.ok) {
        return null;
      }

      const data = (await response.json()) as MempoolStatsResponse;
      if (typeof data.count !== "number" || typeof data.vsize !== "number") {
        return null;
      }

      const txCount = data.count;
      const vsizeMb = data.vsize / 1_000_000;
      const direction: SignalDirection = txCount > 150000 ? "up" : txCount < 60000 ? "down" : "flat";
      const importance: SignalImportance =
        txCount > 220000 || vsizeMb > 140 ? "high" : txCount > 120000 || vsizeMb > 90 ? "medium" : "low";

      return {
        id: "btc-mempool-pressure",
        label: "BTC 멤풀 대기열",
        value: `${txCount.toLocaleString()} tx`,
        source: "mempool.space",
        direction,
        importance,
        summary:
          direction === "up"
            ? `대기 트랜잭션이 많아 체결 지연/수수료 경쟁 가능성 (vsize ${vsizeMb.toFixed(1)} MB)`
            : direction === "down"
              ? `대기열이 낮아 거래 처리 압력이 완만함 (vsize ${vsizeMb.toFixed(1)} MB)`
              : `대기열이 중립권 (vsize ${vsizeMb.toFixed(1)} MB)`,
      };
    } catch {
      return null;
    }
  }

  private async getTvlMomentumSignals(limit: number): Promise<OnchainSignal[]> {
    try {
      const response = await fetch(this.llamaChainsUrl);
      if (!response.ok) {
        return [];
      }

      const chains = (await response.json()) as DefiLlamaChain[];
      const ranked = chains
        .filter(
          (chain) =>
            typeof chain.name === "string" &&
            typeof chain.tvl === "number" &&
            chain.tvl > 500_000_000 &&
            typeof chain.change_1d === "number"
        )
        .sort((a, b) => Math.abs((b.change_1d as number) || 0) - Math.abs((a.change_1d as number) || 0))
        .slice(0, limit);

      return ranked.map((chain) => {
        const name = chain.name as string;
        const tvl = chain.tvl as number;
        const change1d = chain.change_1d as number;
        const change7d = typeof chain.change_7d === "number" ? chain.change_7d : 0;
        const direction: SignalDirection = change1d > 0.3 ? "up" : change1d < -0.3 ? "down" : "flat";
        const importance = this.classifyImportanceByAbsChange(Math.abs(change1d));
        const sign = change1d >= 0 ? "+" : "";

        return {
          id: `tvl-${name.toLowerCase().replace(/\s+/g, "-")}`,
          label: `${name} TVL`,
          value: `${sign}${change1d.toFixed(2)}% (24h)`,
          source: "DefiLlama",
          direction,
          importance,
          summary: `TVL ${(tvl / 1e9).toFixed(2)}B, 7d ${change7d >= 0 ? "+" : ""}${change7d.toFixed(2)}%`,
        };
      });
    } catch {
      return [];
    }
  }

  private async getExchangeNetflowProxySignal(): Promise<OnchainSignal | null> {
    try {
      const [tradeSeries, transferSeries] = await Promise.all([
        this.fetchBlockchainChartValues("trade-volume", "7days"),
        this.fetchBlockchainChartValues("estimated-transaction-volume-usd", "7days"),
      ]);

      if (tradeSeries.length < 2 || transferSeries.length < 2) {
        return null;
      }

      const currentTrade = tradeSeries[tradeSeries.length - 1].y;
      const previousTrade = tradeSeries[tradeSeries.length - 2].y;
      const currentTransfer = transferSeries[transferSeries.length - 1].y;
      const previousTransfer = transferSeries[transferSeries.length - 2].y;

      const currentRatio = currentTrade / Math.max(currentTransfer, 1);
      const previousRatio = previousTrade / Math.max(previousTransfer, 1);
      const ratioChange = this.percentChange(currentRatio, previousRatio);
      const tradeChange = this.percentChange(currentTrade, previousTrade);
      const transferChange = this.percentChange(currentTransfer, previousTransfer);

      const direction: SignalDirection = ratioChange > 3 ? "up" : ratioChange < -3 ? "down" : "flat";
      const importance = this.classifyImportanceByAbsChange(Math.abs(ratioChange));

      return {
        id: "exchange-netflow-proxy",
        label: "거래소 순유입 프록시",
        value: `${currentRatio.toFixed(2)}x (${this.signedPercent(ratioChange)})`,
        source: "blockchain.com charts",
        direction,
        importance,
        summary: `CEX 거래량 ${this.signedPercent(tradeChange)}, 온체인 전송 ${this.signedPercent(transferChange)} (직접 순유입이 아닌 프록시)`,
      };
    } catch {
      return null;
    }
  }

  private async getWhaleMovementSignal(): Promise<OnchainSignal | null> {
    try {
      const [txSeries, txExPopularSeries, transferSeries] = await Promise.all([
        this.fetchBlockchainChartValues("n-transactions", "7days"),
        this.fetchBlockchainChartValues("n-transactions-excluding-popular", "7days"),
        this.fetchBlockchainChartValues("estimated-transaction-volume-usd", "7days"),
      ]);

      if (txSeries.length < 2 || txExPopularSeries.length < 2 || transferSeries.length < 2) {
        return null;
      }

      const txCurrent = txSeries[txSeries.length - 1].y;
      const txPrev = txSeries[txSeries.length - 2].y;
      const exCurrent = txExPopularSeries[txExPopularSeries.length - 1].y;
      const exPrev = txExPopularSeries[txExPopularSeries.length - 2].y;
      const transferCurrent = transferSeries[transferSeries.length - 1].y;
      const transferPrev = transferSeries[transferSeries.length - 2].y;

      const avgTransferCurrent = transferCurrent / Math.max(txCurrent, 1);
      const avgTransferPrev = transferPrev / Math.max(txPrev, 1);
      const avgTransferChange = this.percentChange(avgTransferCurrent, avgTransferPrev);

      const popularShareCurrent = this.clamp((txCurrent - exCurrent) / Math.max(txCurrent, 1), 0, 1);
      const popularSharePrev = this.clamp((txPrev - exPrev) / Math.max(txPrev, 1), 0, 1);
      const shareDeltaPctPoint = (popularShareCurrent - popularSharePrev) * 100;

      const direction: SignalDirection =
        avgTransferChange > 8 || shareDeltaPctPoint > 1.5
          ? "up"
          : avgTransferChange < -8 || shareDeltaPctPoint < -1.5
            ? "down"
            : "flat";
      const importance = this.classifyImportanceByAbsChange(
        Math.max(Math.abs(avgTransferChange), Math.abs(shareDeltaPctPoint))
      );

      return {
        id: "whale-movement-proxy",
        label: "고래/대형주소 활동 프록시",
        value: `${this.formatUsdShort(avgTransferCurrent)} (${this.signedPercent(avgTransferChange)})`,
        source: "blockchain.com charts",
        direction,
        importance,
        summary: `popular 주소 점유율 ${this.signedPercentPoint(shareDeltaPctPoint)}p, 대형 전송 강도 변화 추적`,
      };
    } catch {
      return null;
    }
  }

  private async getStablecoinFlowSignal(): Promise<OnchainSignal | null> {
    try {
      const response = await fetch(this.stablecoinTotalUrl);
      if (!response.ok) {
        return null;
      }

      const points = (await response.json()) as StablecoinChartPoint[];
      const series = points
        .map((point) => ({
          timestamp: Number.parseInt(point.date || "", 10),
          supplyUsd: point.totalCirculatingUSD?.peggedUSD,
        }))
        .filter(
          (point): point is { timestamp: number; supplyUsd: number } =>
            Number.isFinite(point.timestamp) && typeof point.supplyUsd === "number" && point.supplyUsd > 0
        )
        .sort((a, b) => a.timestamp - b.timestamp);

      if (series.length < 2) {
        return null;
      }

      const current = series[series.length - 1];
      const previous = series[series.length - 2];
      const deltaUsd = current.supplyUsd - previous.supplyUsd;
      const deltaPct = this.percentChange(current.supplyUsd, previous.supplyUsd);
      const direction: SignalDirection = deltaUsd > 0 ? "up" : deltaUsd < 0 ? "down" : "flat";
      const importance = this.classifyImportanceByAbsChange(Math.abs(deltaPct));

      return {
        id: "stablecoin-flow",
        label: "스테이블코인 총공급 플로우",
        value: `${this.signedUsd(deltaUsd)} (${this.signedPercent(deltaPct)})`,
        source: "DefiLlama Stablecoins",
        direction,
        importance,
        summary: `총 공급 ${this.formatUsdShort(current.supplyUsd)} 기준, 유동성 ${deltaUsd >= 0 ? "유입" : "유출"} 신호`,
      };
    } catch {
      return null;
    }
  }

  private async fetchBlockchainChartValues(chart: string, timespan: string): Promise<Array<{ x: number; y: number }>> {
    const url = `${this.blockchainChartBaseUrl}/${chart}?timespan=${encodeURIComponent(timespan)}&format=json`;
    const response = await fetch(url);
    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as BlockchainChartResponse;
    if (!Array.isArray(data.values)) {
      return [];
    }

    return data.values
      .map((point) => ({
        x: point.x,
        y: point.y,
      }))
      .filter(
        (point): point is { x: number; y: number } =>
          typeof point.x === "number" && Number.isFinite(point.x) && typeof point.y === "number" && Number.isFinite(point.y)
      );
  }

  private classifyImportanceByAbsChange(absChange: number): SignalImportance {
    if (absChange >= 8) return "high";
    if (absChange >= 3) return "medium";
    return "low";
  }

  private percentChange(current: number, previous: number): number {
    if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) {
      return 0;
    }
    return ((current - previous) / Math.abs(previous)) * 100;
  }

  private signedPercent(value: number): string {
    const sign = value >= 0 ? "+" : "";
    return `${sign}${value.toFixed(2)}%`;
  }

  private signedPercentPoint(value: number): string {
    const sign = value >= 0 ? "+" : "";
    return `${sign}${value.toFixed(2)}`;
  }

  private signedUsd(value: number): string {
    const sign = value >= 0 ? "+" : "";
    return `${sign}${this.formatUsdShort(Math.abs(value))}`;
  }

  private formatUsdShort(value: number): string {
    const absValue = Math.abs(value);
    if (absValue >= 1e12) return `$${(absValue / 1e12).toFixed(2)}T`;
    if (absValue >= 1e9) return `$${(absValue / 1e9).toFixed(2)}B`;
    if (absValue >= 1e6) return `$${(absValue / 1e6).toFixed(2)}M`;
    if (absValue >= 1e3) return `$${(absValue / 1e3).toFixed(2)}K`;
    return `$${absValue.toFixed(2)}`;
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
  }
}

export default OnchainDataService;
