import test from "node:test";
import assert from "node:assert/strict";
import { buildSignalFingerprint } from "../src/services/engagement/signal-fingerprint.ts";

test("buildSignalFingerprint is stable for equivalent signal states", () => {
  const a = buildSignalFingerprint({
    marketContext: `## Market Snapshot
FearGreed 12 (Extreme Fear)
- BTC $100,120 (+0.12%)
- ETH $4,010 (-0.45%)
- SOL $205 (+1.92%)`,
    onchainContext: `## 온체인/플로우 시그널
- BTC 네트워크 수수료: 3 sat/vB | 네트워크 혼잡이 완화되어 단기 과열은 제한적 (source: mempool.space)
- BTC 멤풀 대기열: 44,000 tx | 대기열이 낮아 거래 처리 압력이 완만함 (source: mempool.space)
- 고래/대형주소 활동 프록시: +$1.24M (+224.00%) | popular 주소 점유율 +1.80p, 대형 전송 강도 변화 추적 (source: blockchain.com charts)`,
    trendSummary: "핫 토픽: eToro 실적",
    focusHeadline: "Trading platform eToro shares jump 14% after posting record Q4 profit",
  });

  const b = buildSignalFingerprint({
    marketContext: `## Market Snapshot
FearGreed 11 (Extreme Fear)
- BTC $100,080 (+0.10%)
- ETH $4,008 (-0.40%)
- SOL $204 (+1.70%)`,
    onchainContext: `## 온체인/플로우 시그널
- BTC 네트워크 수수료: 2 sat/vB | 네트워크 혼잡이 완화되어 단기 과열은 제한적 (source: mempool.space)
- BTC 멤풀 대기열: 42,000 tx | 대기열이 낮아 거래 처리 압력이 완만함 (source: mempool.space)
- 고래/대형주소 활동 프록시: +$1.18M (+201.00%) | popular 주소 점유율 +1.55p, 대형 전송 강도 변화 추적 (source: blockchain.com charts)`,
    trendSummary: "핫 토픽: eToro 실적",
    focusHeadline: "Trading platform eToro shares jump 14% after posting record Q4 profit",
  });

  assert.equal(a.signature, b.signature);
  assert.equal(a.key, b.key);
});

test("buildSignalFingerprint changes when regime changes", () => {
  const fear = buildSignalFingerprint({
    marketContext: `## Market Snapshot
FearGreed 12 (Extreme Fear)
- BTC $100,120 (+0.12%)`,
    onchainContext: `## 온체인/플로우 시그널
- 스테이블코인 총공급 플로우: +$250.00M (+1.20%) | 총 공급 $200.00B 기준, 유동성 유입 신호 (source: DefiLlama Stablecoins)`,
    trendSummary: "온체인 자금 유입",
    focusHeadline: "Stablecoin supply rises again",
  });

  const greed = buildSignalFingerprint({
    marketContext: `## Market Snapshot
FearGreed 78 (Greed)
- BTC $104,000 (+4.20%)`,
    onchainContext: `## 온체인/플로우 시그널
- 스테이블코인 총공급 플로우: -$800.00M (-3.20%) | 총 공급 $199.20B 기준, 유동성 유출 신호 (source: DefiLlama Stablecoins)`,
    trendSummary: "온체인 자금 유출",
    focusHeadline: "Stablecoin supply falls sharply",
  });

  assert.notEqual(fear.signature, greed.signature);
  assert.notEqual(fear.key, greed.key);
});
