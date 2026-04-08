import type { OnchainEvidence, TrendLane } from "../../../types/agent.js";
import { sanitizeTweetText } from "../quality.js";
import type { PlannerFocus } from "./spec.js";
import { resolveSettlementSceneBase } from "./scene-bases/settlement.js";
import { resolveLaunchSceneBase } from "./scene-bases/launch.js";
import { resolveDurabilitySceneBase } from "./scene-bases/durability.js";
import { resolveCourtSceneBase } from "./scene-bases/court.js";
import { resolveRetentionSceneBase } from "./scene-bases/retention.js";
import { rewriteSceneFamilyBase, sceneFamilyBase, sceneFamilyMatches } from "./scene-family.js";

type NarrativeBucket =
  | "legal"
  | "capital"
  | "builder"
  | "usage"
  | "retention"
  | "ops"
  | "execution"
  | "liquidity"
  | "durability"
  | "heat"
  | "whale"
  | "settlement"
  | "generic";

function stableSeed(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return Math.abs(hash >>> 0);
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, numeric));
}

function classifyNarrativeBucket(item: OnchainEvidence): NarrativeBucket {
  const normalized = sanitizeTweetText(`${item.label} ${item.value} ${item.summary}`).toLowerCase();
  if (/(법원|소송|당국|정책|규제|etf|sec|cftc|심사|승인|집행|court|lawsuit|policy|regulation|compliance)/.test(normalized)) {
    return "legal";
  }
  if (/(복귀 자금|예치 자금 복귀|스테이블|대기 자금|거래소 유입|거래소 이탈|netflow|exchange flow|자금 흐름|capital)/.test(normalized)) {
    return "capital";
  }
  if (/(개발자 잔류|빌더|builder|developer retention|developer activity)/.test(normalized)) {
    return "builder";
  }
  if (/(고래|큰손|whale)/.test(normalized)) {
    return "whale";
  }
  if (/(재방문|잔류|돌아오|retention|returning|sticky)/.test(normalized)) {
    return "retention";
  }
  if (/(활성 지갑|사용 지갑|실사용|사용 흔적|usage|wallet|address activity|active address|tvl|잠긴 자금)/.test(normalized)) {
    return "usage";
  }
  if (/(체인 사용 압박|사용 압박|거래 대기 압박|밀린 거래 압박|거래 적체)/.test(normalized)) {
    return "durability";
  }
  if (/(예치 자금|현물 체결|호가 유동성|체결 유동성)/.test(normalized)) {
    return "settlement";
  }
  if (/(검증자|복구|업그레이드|메인넷|테스트넷|합의|firedancer|validator|recovery|consensus|rollup)/.test(normalized)) {
    return "ops";
  }
  if (/(주문|체결|호가|유동성|orderbook|liquidity|funding|open interest|현물 체결)/.test(normalized)) {
    return "liquidity";
  }
  if (/(멤풀|수수료|거래 대기|주소 이동|고래|durability|지속성)/.test(normalized)) {
    return "durability";
  }
  if (/(커뮤니티 열기|광고|홍보|가격 쏠림|가격 반응|과열|hype|heat|community)/.test(normalized)) {
    return "heat";
  }
  if (/(집행 흔적|현장 반응|행동)/.test(normalized)) {
    return "execution";
  }
  return "generic";
}

export function resolvePlannerSceneFacet(item: OnchainEvidence, lane: TrendLane): string {
  const normalized = sanitizeTweetText(`${item.label} ${item.value} ${item.summary}`).toLowerCase();
  if (lane === "ecosystem") {
    if (/(개발자|빌더|builder|developer)/.test(normalized)) return "builder";
    if (/(지갑\s*재방문|wallet\s*return|wallet\s*revisit|지갑\s*복귀)/.test(normalized)) return "wallet";
    if (/(사용자\s*재방문|유저\s*재방문|재방문\s*흐름|cohort|returning\s*user|사용자\s*복귀)/.test(normalized)) return "cohort";
    if (/(재방문|잔류|retention|returning|sticky)/.test(normalized)) return "retention";
    if (/(예치 자금 복귀|자금 복귀|복귀 자금|returning capital)/.test(normalized)) return "return";
    if (/(일기장|내부자|회의실|포스터)/.test(normalized)) return "inside";
    if (/(지갑|wallet|실사용|usage|사용 흔적)/.test(normalized)) return "usage";
    if (/(커뮤니티|community|열기|광고|홍보|hype)/.test(normalized)) return "community";
    if (/(예치 자금|자금 복귀|capital|tvl)/.test(normalized)) return "capital";
  }
  if (lane === "regulation") {
    if (/(집행|현장 반응|execution)/.test(normalized)) return "execution";
    if (/(브리핑|해설|기사|뉴스)/.test(normalized)) return "briefing";
    if (/(판결|평결|verdict)/.test(normalized)) return "verdict";
    if (/(법원|소송|판결|court|lawsuit)/.test(normalized)) return "court";
    if (/(etf\s*대기\s*주문|대기\s*주문|매수\s*자리|order)/.test(normalized)) return "order";
    if (/(etf|심사|승인|policy|regulation|당국|sec|cftc)/.test(normalized)) return "policy";
    if (/(대기 자금|자금 흐름|capital)/.test(normalized)) return "capital";
  }
  if (lane === "protocol") {
    if (/(배포 큐|배포|rollout|큐)/.test(normalized)) return "rollout";
    if (/(운영 로그|운영 반응|ops|log)/.test(normalized)) return "ops";
    if (/(쇼케이스|데모|무대|객석|포스터|발표회|showcase|demo|stage|audience)/.test(normalized)) return "showcase";
    if (/(복귀 자금|예치 자금|자금 복귀|returning capital)/.test(normalized)) return "return";
    if (/(복귀 자금|예치 자금|자금 복귀|capital)/.test(normalized)) return "capital";
    if (/(메인넷|launch|출시|준비도)/.test(normalized)) return "launch";
    if (/(검증자|validator|합의|consensus)/.test(normalized)) return "validator";
    if (/(복구|recovery|장애)/.test(normalized)) return "recovery";
    if (/(테스트넷|testnet|업그레이드|rollup|firedancer)/.test(normalized)) return "rollout";
  }
  if (lane === "onchain") {
    if (/(고래|큰손|whale|주소 이동|exchange flow|거래소 자금)/.test(normalized)) return "flow";
    if (/(수수료|멤풀|거래 대기|거래 적체|network fee|mempool)/.test(normalized)) return "congestion";
    if (/(체인 사용 압박|사용 압박|체인 안쪽 사용|사용 지갑|지갑 재방문|실사용 잔류|실사용 흔적)/.test(normalized)) return "usage";
    if (/(스테이블|대기 자금|관망 자금|stablecoin|capital)/.test(normalized)) return "capital";
    if (/(활성 지갑|address activity|사용 지갑|usage|tvl)/.test(normalized)) return "usage";
  }
  if (lane === "market-structure") {
    if (/(현물 체결|체결|settlement|spot)/.test(normalized)) return "execution";
    if (/(거래량|volume)/.test(normalized)) return "volume";
    if (/(호가|orderbook|깊이|depth|유동성|liquidity)/.test(normalized)) return "depth";
    if (/(자금 쏠림|capital|자금 흐름|funding)/.test(normalized)) return "capital";
    if (/(주문 소화|execution)/.test(normalized)) return "execution";
    if (/(화면|분위기|과열|heat)/.test(normalized)) return "heat";
  }
  if (lane === "macro") {
    if (/(달러|dxy|usd|eur)/.test(normalized)) return "fx";
    if (/(금리|fed|ecb|rates|treasury)/.test(normalized)) return "rates";
    if (/(물가|inflation|cpi)/.test(normalized)) return "inflation";
    if (/(자금 흐름|capital)/.test(normalized)) return "capital";
  }
  return classifyNarrativeBucket(item);
}

export function resolvePlannerFocus(lane: TrendLane, pair: OnchainEvidence[]): PlannerFocus {
  const buckets = pair.map((item) => classifyNarrativeBucket(item));
  const has = (bucket: NarrativeBucket) => buckets.includes(bucket);
  const merged = sanitizeTweetText(pair.map((item) => `${item.label} ${item.summary}`).join(" | ")).toLowerCase();
  const facets = pair.map((item) => resolvePlannerSceneFacet(item, lane));
  const hasFacet = (facet: string) => facets.includes(facet);

  if (lane === "ecosystem") {
    if ((has("builder") || hasFacet("builder")) && (hasFacet("capital") || hasFacet("usage"))) return "builder";
    if (/(개발자|빌드)/.test(merged) && (has("builder") || hasFacet("builder"))) return "builder";
    if (has("retention") || hasFacet("retention") || hasFacet("wallet") || hasFacet("cohort")) return "retention";
    if (has("heat")) return "hype";
  }
  if (lane === "regulation") {
    if (hasFacet("court") || /(법원|소송|판결|court|lawsuit)/.test(merged)) return "court";
    if (has("legal") && (has("execution") || has("capital"))) return "execution";
  }
  if (lane === "protocol") {
    if (
      hasFacet("launch") ||
      /(메인넷|launch|준비도|출시|런치)/.test(merged) ||
      ((hasFacet("rollout") || /테스트넷|rollout|배포/.test(merged)) && (hasFacet("capital") || has("capital")))
    ) {
      return "launch";
    }
    if (has("ops") || hasFacet("recovery") || hasFacet("validator") || hasFacet("rollout")) return "durability";
  }
  if (lane === "onchain") {
    if (has("whale") || /(고래|거래소 자금|자금 방향)/.test(merged)) return "flow";
    if (has("durability")) return "durability";
    if (
      hasFacet("usage") ||
      hasFacet("congestion") ||
      ((hasFacet("capital") || has("capital")) &&
        (/(체인 사용 압박|밀린 거래 압박|거래 적체|체인 안쪽 사용|사용 지갑|지갑 재방문|관망 자금)/.test(merged) ||
          has("usage")))
    ) {
      return "durability";
    }
  }
  if (lane === "market-structure") {
    if (has("settlement") || /(호가 유동성|현물 체결|깊이)/.test(merged)) return "settlement";
    if (has("liquidity")) return "liquidity";
  }

  return "general";
}

function augmentSceneFamilyBaseWithHeadline(
  sceneFamily: string,
  headline: string,
  lane: TrendLane,
  focus: PlannerFocus
): string {
  const normalized = sanitizeTweetText(headline).toLowerCase();
  const base = sceneFamilyBase(sceneFamily);
  if (!normalized || !base) return sceneFamily;

  if (lane === "protocol" && focus === "launch" && base === "protocol:launch:capital") {
    if (/(쇼케이스|데모|무대|객석|포스터|발표회)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "protocol:launch:launch+showcase");
    if (/(운영|로그|복구)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "protocol:launch:launch+ops");
    if (/(복귀 자금|자금 복귀|돌아오|돈이 눕|돈이 안 붙)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "protocol:launch:return+launch");
    if (/(메인넷|launch|출시|준비도|런치)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "protocol:launch:capital+launch");
  }
  if (lane === "protocol" && focus === "launch" && base === "protocol:launch:return+launch") {
    if (/(객석|무대|쇼케이스|포스터|데모|발표회)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "protocol:launch:return+showcase");
    if (/(운영|로그|복구)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "protocol:launch:return+ops");
    if (/(박수|발표|설명|기사|뉴스|기대)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "protocol:launch:return+announcement");
  }
  if (lane === "protocol" && focus === "launch" && base === "protocol:launch:return+ops") {
    if (/(객석|무대|쇼케이스|포스터|데모|발표회)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "protocol:launch:return+showcase");
    if (/(박수|발표|설명|기사|뉴스|기대|브리핑)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "protocol:launch:return+announcement");
    if (/(메인넷|launch|출시|준비도|런치)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "protocol:launch:return+launch");
  }
  if (lane === "protocol" && focus === "launch" && base === "protocol:launch:return+announcement") {
    if (/(객석|무대|쇼케이스|포스터|데모|발표회)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "protocol:launch:return+showcase");
    if (/(운영|로그|복구|배포|롤아웃)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "protocol:launch:return+ops");
    if (/(자금|돈|복귀 자금|자금 복귀|자금 흐름)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "protocol:launch:launch+treasury");
  }
  if (lane === "protocol" && focus === "launch" && base === "protocol:launch:launch+ops") {
    if (/(쇼케이스|데모|무대|객석|포스터|발표회)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "protocol:launch:launch+showcase");
    if (/(복귀 자금|자금 복귀|돌아오|복귀|돈이 눕|돈이 안 붙)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "protocol:launch:return+ops");
    if (/(발표|박수|기사|뉴스|설명)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "protocol:launch:return+announcement");
    if (/(메인넷|launch|출시|준비도|런치)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "protocol:launch:launch+capital");
  }
  if (lane === "protocol" && focus === "launch" && base === "protocol:launch:launch+capital") {
    if (/(쇼케이스|데모|무대|객석|포스터|발표회)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "protocol:launch:launch+showcase");
    if (/(운영|로그|복구)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "protocol:launch:launch+ops");
    if (/(복귀 자금|자금 복귀|돌아오|복귀|돈이 눕|돈이 안 붙)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "protocol:launch:return+launch");
  }
  if (lane === "protocol" && focus === "durability" && base === "protocol:durability:rollout") {
    if (/(운영|로그)/.test(normalized) && /(검증자|validator|합의)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "protocol:durability:validator+log");
    if (/(복구|장애)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "protocol:durability:recovery+rollout");
    if (/(검증자|validator|합의)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "protocol:durability:rollout+validator");
    if (/(운영|로그)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "protocol:durability:repair+ops");
  }
  if (lane === "protocol" && focus === "durability" && base === "protocol:durability:rollout+validator") {
    if (/(복구|장애)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "protocol:durability:recovery+validator");
    if (/(운영|로그)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "protocol:durability:recovery+rollout");
  }
  if (lane === "protocol" && focus === "durability" && base === "protocol:durability:recovery+rollout") {
    if (/(운영|로그)/.test(normalized) && /(검증자|validator|합의)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "protocol:durability:validator+log");
    if (/(검증자|validator|합의)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "protocol:durability:recovery+validator");
    if (/(운영|로그)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "protocol:durability:repair+ops");
  }
  if (lane === "protocol" && focus === "durability" && base === "protocol:durability:recovery+validator") {
    if (/(복구|장애)/.test(normalized) && /(검증자|validator|합의)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "protocol:durability:repair+validator");
    if (/(운영|로그)/.test(normalized) && /(검증자|validator|합의)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "protocol:durability:ops+validator");
  }
  if (lane === "protocol" && focus === "durability" && base === "protocol:durability:validator+log") {
    if (/(복구|장애)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "protocol:durability:recovery+validator");
    if (/(롤아웃|배포)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "protocol:durability:rollout+validator");
    if (/(운영|로그)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "protocol:durability:ops+log");
  }
  if (lane === "protocol" && focus === "durability" && base === "protocol:durability:repair+ops") {
    if (/(복구|장애)/.test(normalized) && /(운영|로그)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "protocol:durability:ops+recovery");
  }
  if (lane === "protocol" && focus === "durability" && base === "protocol:durability:ops+log") {
    if (/(복구|장애)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "protocol:durability:ops+recovery");
    if (/(검증자|validator|합의)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "protocol:durability:ops+validator");
  }
  if (lane === "regulation" && focus === "court" && base === "regulation:court:capital+execution") {
    if (/(브리핑|해설|기사|뉴스)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "regulation:court:briefing+execution");
    if (/(판결|평결|verdict)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "regulation:court:verdict+execution");
    if (/(판결|법원|소송|court|lawsuit)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "regulation:court:court+execution");
  }
  if (lane === "regulation" && focus === "court" && base === "regulation:court:briefing") {
    if (/(판결|평결|verdict)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "regulation:court:verdict+execution");
    if (/(판결|법원|소송|court|lawsuit)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "regulation:court:court+execution");
    if (/(주문|ETF|대기 주문|매수 자리)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "regulation:court:order+capital");
    if (/(자금|돈|capital|대기 자금)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "regulation:court:capital+execution");
    if (/집행/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "regulation:court:briefing+execution");
  }
  if (lane === "regulation" && focus === "court" && base === "regulation:court:capital+court") {
    if (/집행/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "regulation:court:court+execution");
  }
  if (lane === "ecosystem" && focus === "retention" && base === "ecosystem:retention:retention") {
    if (/(커뮤니티|열기|광고|홍보|포스터)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "ecosystem:retention:community+retention");
    if (/(생활|습관|다음 날|리듬)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "ecosystem:retention:habit+retention");
    if (/(지갑|wallet|복귀 흔적)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "ecosystem:retention:wallet+retention");
    if (/(실사용|사용 흔적|체인 사용)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "ecosystem:retention:retention+usage");
  }
  if (lane === "market-structure" && focus === "settlement" && base === "market-structure:settlement:execution") {
    if (/(거래량|숫자|볼륨)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "market-structure:settlement:volume+depth");
    if (/(현물 체결|체결|주문 소화)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "market-structure:settlement:execution+depth");
    if (/(화면|과열|분위기|호가|깊이)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "market-structure:settlement:depth+heat");
  }
  if (lane === "market-structure" && focus === "settlement" && base === "market-structure:settlement:execution+depth") {
    if (/(거래량|숫자|볼륨)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "market-structure:settlement:volume+settlement");
    if (/(현물 체결|체결|주문 소화)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "market-structure:settlement:fill+depth");
    if (/(화면|과열|분위기)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "market-structure:settlement:settlement+heat");
    if (/(호가|깊이)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "market-structure:settlement:depth+settlement");
  }
  if (lane === "market-structure" && focus === "settlement" && base === "market-structure:settlement:fill+depth") {
    if (/(호가|깊이|book)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "market-structure:settlement:fill+book");
  }
  if (lane === "market-structure" && focus === "settlement" && base === "market-structure:settlement:volume+depth") {
    if (/(호가|깊이|book)/.test(normalized)) return rewriteSceneFamilyBase(sceneFamily, "market-structure:settlement:volume+book");
  }

  return sceneFamily;
}

function resolveEventSceneNudge(headline: string, lane: TrendLane, focus: PlannerFocus): string {
  const normalized = sanitizeTweetText(headline).toLowerCase();
  if (!normalized) return "";
  if (lane === "ecosystem" && focus === "builder") {
    if (/(일기장|내부자|회의실|포스터)/.test(normalized)) return "inside-gap";
    if (/(엇갈|다른 속도|갈라|서로 다른|낙관|헐거워)/.test(normalized)) return "split";
    if (/(복귀 자금|자금 복귀|안 돌아|돌아오지|객석)/.test(normalized)) return "return-lag";
    if (/(예치 자금|tvl|자금|돈)/.test(normalized)) return "treasury-lag";
    if (/(실사용|사용|얇|묽)/.test(normalized)) return "usage-thin";
  }
  if (lane === "ecosystem" && focus === "retention") {
    if (/(생활 리듬|습관|habits?)/.test(normalized)) return "habit-gap";
    if (/(지갑|다시 들어오|복귀 흔적)/.test(normalized)) return "wallet-thins";
    if (/(사람|잔류|재방문|다음 날)/.test(normalized)) return "cohort-thin";
    if (/(생활 흔적|실사용|체인 사용)/.test(normalized)) return "usage-gap";
    if (/(열기|커뮤니티)/.test(normalized)) return "heat-gap";
  }
  if (lane === "regulation" && focus === "court") {
    if (/(브리핑|해설)/.test(normalized)) return "briefing-gap";
    if (/(기사|뉴스)/.test(normalized)) return "headline-gap";
    if (/(판결|법원|소송)/.test(normalized)) return "verdict-gap";
    if (/집행/.test(normalized)) return "execution-lag";
    if (/(자금|돈)/.test(normalized)) return "capital-lag";
  }
  if (lane === "protocol" && focus === "launch") {
    if (/(객석|무대)/.test(normalized)) return "audience-gap";
    if (/(발표회|브리핑)/.test(normalized)) return "briefing-gap";
    if (/(쇼케이스|데모|발표|무대|반쪽|얇아진|얇은)/.test(normalized)) return "showcase";
    if (/(발표회|객석|종이|무대)/.test(normalized)) return "stage-gap";
    if (/(복귀 자금|돈)/.test(normalized)) return "return-lag";
    if (/(운영|로그)/.test(normalized)) return "ops-cold";
    if (/(롤아웃|배포)/.test(normalized)) return "rollout-lag";
  }
  if (lane === "protocol" && focus === "durability") {
    if (/(로그|기록)/.test(normalized)) return "log-gap";
    if (/(박수|발표|쇼케이스)/.test(normalized)) return "applause-gap";
    if (/(복구|장애)/.test(normalized)) return "repair-gap";
    if (/(운영|로그)/.test(normalized)) return "ops-gap";
    if (/(검증자|합의)/.test(normalized)) return "validator-gap";
    if (/(배포|롤아웃)/.test(normalized)) return "rollout-lag";
  }
  if (lane === "market-structure" && focus === "settlement") {
    if (/거래량|숫자/.test(normalized)) return "size-only";
    if (/(정산|settlement)/.test(normalized)) return "settlement-lag";
    if (/(호가|깊이)/.test(normalized)) return "book-thin";
    if (/(체결|주문 소화)/.test(normalized)) return "fill-thin";
    if (/(화면|과열|분위기)/.test(normalized)) return "screen-heat";
  }
  return "";
}

export function augmentSceneFamilyWithHeadline(
  sceneFamily: string,
  headline: string,
  lane: TrendLane,
  focus: PlannerFocus
): string {
  const baseAdjusted = augmentSceneFamilyBaseWithHeadline(sceneFamily, headline, lane, focus);
  const nudge = resolveEventSceneNudge(headline, lane, focus);
  if (!nudge) return baseAdjusted;
  const parts = baseAdjusted.split(":").filter(Boolean);
  if (parts.slice(3).includes(nudge)) return baseAdjusted;
  return `${baseAdjusted}:${nudge}`;
}

export function diversifyDerivedSceneFamilyForVariant(
  sceneFamily: string,
  lane: TrendLane,
  focus: PlannerFocus,
  variant: number
): string {
  const index = Math.abs(variant) % 8;
  const base = sceneFamilyBase(sceneFamily);
  if (!base) return sceneFamily;

  if (lane === "ecosystem" && focus === "builder" && base === "ecosystem:builder:builder+return") {
    return rewriteSceneFamilyBase(sceneFamily, [
      "ecosystem:builder:builder+return",
      "ecosystem:builder:builder+inside",
      "ecosystem:builder:builder+usage",
      "ecosystem:builder:builder+treasury",
      "ecosystem:builder:builder+usage",
      "ecosystem:builder:builder+inside",
      "ecosystem:builder:builder+treasury",
      "ecosystem:builder:builder+return",
    ][index]);
  }
  if (
    lane === "ecosystem" &&
    focus === "retention" &&
    /(ecosystem:retention:wallet\+retention|ecosystem:retention:retention\+cohort|ecosystem:retention:retention\+usage|ecosystem:retention:usage\+wallet|ecosystem:retention:cohort\+usage|ecosystem:retention:retention\+wallet|ecosystem:retention:cohort\+retention|ecosystem:retention:wallet\+usage|ecosystem:retention:habit\+retention|ecosystem:retention:return\+habit)/.test(base)
  ) {
    return rewriteSceneFamilyBase(sceneFamily, [
      "ecosystem:retention:community+retention",
      "ecosystem:retention:retention+cohort",
      "ecosystem:retention:retention+usage",
      "ecosystem:retention:cohort+usage",
      "ecosystem:retention:usage+wallet",
      "ecosystem:retention:habit+retention",
      "ecosystem:retention:return+habit",
      "ecosystem:retention:cohort+retention",
    ][index]);
  }
  if (
    lane === "regulation" &&
    focus === "court" &&
    /(regulation:court:briefing\+execution|regulation:court:briefing\+capital|regulation:court:capital\+execution|regulation:court:court\+execution|regulation:court:order\+capital|regulation:court:verdict\+execution)/.test(base)
  ) {
    return rewriteSceneFamilyBase(sceneFamily, [
      "regulation:court:briefing+execution",
      "regulation:court:capital+execution",
      "regulation:court:court+execution",
      "regulation:court:order+capital",
      "regulation:court:verdict+execution",
      "regulation:court:briefing+capital",
      "regulation:court:court+execution",
      "regulation:court:capital+execution",
    ][index]);
  }
  if (
    lane === "protocol" &&
    focus === "launch" &&
    /(protocol:launch:return\+announcement|protocol:launch:return\+launch|protocol:launch:return\+showcase|protocol:launch:return\+ops|protocol:launch:launch\+treasury|protocol:launch:launch\+ops|protocol:launch:launch\+capital|protocol:launch:launch\+showcase|protocol:launch:launch\+audience|protocol:launch:return\+audience)/.test(base)
  ) {
    return rewriteSceneFamilyBase(sceneFamily, [
      "protocol:launch:return+announcement",
      "protocol:launch:return+ops",
      "protocol:launch:return+audience",
      "protocol:launch:return+launch",
      "protocol:launch:launch+rollout",
      "protocol:launch:launch+audience",
      "protocol:launch:launch+treasury",
      "protocol:launch:launch+showcase",
    ][index]);
  }
  if (
    lane === "protocol" &&
    focus === "durability" &&
    /(protocol:durability:recovery\+validator|protocol:durability:recovery\+rollout|protocol:durability:repair\+validator|protocol:durability:repair\+ops|protocol:durability:ops\+validator|protocol:durability:ops\+recovery|protocol:durability:rollout\+validator|protocol:durability:recovery\+ops|protocol:durability:ops\+log|protocol:durability:repair\+log|protocol:durability:validator\+log)/.test(base)
  ) {
    return rewriteSceneFamilyBase(sceneFamily, [
      "protocol:durability:recovery+validator",
      "protocol:durability:recovery+rollout",
      "protocol:durability:repair+validator",
      "protocol:durability:repair+log",
      "protocol:durability:validator+log",
      "protocol:durability:ops+log",
      "protocol:durability:rollout+validator",
      "protocol:durability:recovery+ops",
    ][index]);
  }
  if (
    lane === "market-structure" &&
    focus === "settlement" &&
    /(market-structure:settlement:execution\+depth|market-structure:settlement:volume\+depth|market-structure:settlement:depth\+settlement|market-structure:settlement:depth\+heat|market-structure:settlement:execution\+settlement|market-structure:settlement:volume\+settlement|market-structure:settlement:fill\+depth|market-structure:settlement:settlement\+heat|market-structure:settlement:fill\+book|market-structure:settlement:volume\+book)/.test(base)
  ) {
    return rewriteSceneFamilyBase(sceneFamily, [
      "market-structure:settlement:execution+depth",
      "market-structure:settlement:volume+book",
      "market-structure:settlement:depth+settlement",
      "market-structure:settlement:depth+heat",
      "market-structure:settlement:execution+settlement",
      "market-structure:settlement:volume+settlement",
      "market-structure:settlement:fill+book",
      "market-structure:settlement:settlement+heat",
    ][index]);
  }
  return sceneFamily;
}

function resolvePlannerSceneTilt(
  lane: TrendLane,
  focus: PlannerFocus,
  pair: OnchainEvidence[],
  facets: string[]
): string {
  const lagPattern = /(지연|둔화|관망|정체|비어|비면|늦|얕|약화|멈춤|없음|느림|식음|뒤처|빠지)/;
  const holdPattern = /(유지|확대|증가|복귀|재가동|정상화|상승|회복|강화|안정|버티|남)/;
  const mergedText = sanitizeTweetText(pair.map((item) => `${item.label} ${item.value} ${item.summary}`).join(" | ")).toLowerCase();
  const rows = pair.map((item) => {
    const text = sanitizeTweetText(`${item.label} ${item.value} ${item.summary}`).toLowerCase();
    return {
      facet: resolvePlannerSceneFacet(item, lane),
      lag: lagPattern.test(text),
      hold: holdPattern.test(text),
    };
  });
  const facetLag = (...targets: string[]) => rows.some((row) => targets.includes(row.facet) && row.lag);
  const facetHold = (...targets: string[]) => rows.some((row) => targets.includes(row.facet) && row.hold);
  const hasFacet = (...targets: string[]) => facets.some((facet) => targets.includes(facet));
  const scoreCandidates = new Map<string, number>();
  const addScore = (tilt: string, score: number, condition = true) => {
    if (!condition || !tilt || score <= 0) return;
    scoreCandidates.set(tilt, (scoreCandidates.get(tilt) || 0) + score);
  };
  const pickTilt = (fallback = ""): string => {
    if (scoreCandidates.size === 0) return fallback;
    const ranked = [...scoreCandidates.entries()].sort((a, b) => b[1] - a[1]);
    const topScore = ranked[0][1];
    const finalists = ranked.filter((item) => topScore - item[1] <= 0.08).map((item) => item[0]);
    if (finalists.length === 1) return finalists[0];
    const seed = stableSeed(`${lane}|${focus}|${mergedText}|${facets.join("+")}|tilt`);
    return finalists[Math.abs(seed) % finalists.length];
  };

  if (lane === "ecosystem" && focus === "builder") {
    addScore("capital-lag", 0.74, hasFacet("capital") && facetLag("capital"));
    addScore("usage-gap", 0.72, hasFacet("usage") && facetLag("usage"));
    addScore("builder-holds", 0.66, facetHold("builder") && facetHold("capital"));
    addScore("builder-holds", 0.12, /(복귀|재가동|버티)/.test(mergedText));
    addScore("builder-split", 0.42, true);
    return pickTilt("builder-split");
  }
  if (lane === "ecosystem" && focus === "retention") {
    addScore("usage-gap", 0.74, hasFacet("usage") && facetLag("usage"));
    addScore("habit-gap", 0.82, /(생활|습관|다음 날|리듬)/.test(mergedText));
    addScore("wallet-thins", 0.72, hasFacet("wallet") && facetLag("wallet"));
    addScore("cohort-thins", 0.72, hasFacet("cohort", "retention") && facetLag("cohort", "retention"));
    addScore("heat-gap", 0.68, /(열기|커뮤니티|광고|포스터)/.test(mergedText));
    addScore("retention-holds", 0.64, facetHold("wallet", "cohort", "retention"));
    addScore("retention-split", 0.4, true);
    return pickTilt("retention-split");
  }
  if (lane === "regulation" && focus === "court") {
    addScore("order-lag", 0.8, hasFacet("order") && facetLag("order"));
    addScore("execution-lag", 0.74, hasFacet("execution") && facetLag("execution"));
    addScore("capital-lag", 0.72, hasFacet("capital") && facetLag("capital"));
    addScore("headline-gap", 0.7, /(브리핑|해설|기사|뉴스)/.test(mergedText));
    addScore("verdict-gap", 0.7, /(판결|평결|법원|소송|court)/.test(mergedText));
    addScore("order-holds", 0.66, facetHold("order", "capital"));
    addScore("court-holds", 0.62, facetHold("court", "execution"));
    addScore("court-split", 0.4, true);
    return pickTilt("court-split");
  }
  if (lane === "regulation" && focus === "execution") {
    addScore("capital-lag", 0.72, hasFacet("capital") && facetLag("capital"));
    addScore("execution-holds", 0.62, facetHold("execution"));
    addScore("execution-split", 0.42, true);
    return pickTilt("execution-split");
  }
  if (lane === "protocol" && focus === "launch") {
    addScore("return-lag", 0.76, hasFacet("return") && facetLag("return"));
    addScore("audience-gap", 0.74, /(객석|무대|쇼케이스|발표회|브리핑|포스터|데모)/.test(mergedText));
    addScore("ops-lag", 0.72, hasFacet("ops") && facetLag("ops"));
    addScore("rollout-lag", 0.72, hasFacet("rollout") && facetLag("rollout"));
    addScore("capital-lag", 0.68, hasFacet("capital") && facetLag("capital"));
    addScore("ops-holds", 0.62, facetHold("ops", "rollout"));
    addScore("launch-holds", 0.6, facetHold("launch", "return", "capital"));
    addScore("launch-split", 0.38, true);
    return pickTilt("launch-split");
  }
  if (lane === "protocol" && focus === "durability") {
    addScore("log-gap", 0.82, /(로그|기록|운영 로그)/.test(mergedText));
    addScore("applause-gap", 0.72, /(박수|발표|쇼케이스|무대|객석)/.test(mergedText));
    addScore("ops-lag", 0.74, hasFacet("ops") && facetLag("ops"));
    addScore("validator-lag", 0.74, hasFacet("validator") && facetLag("validator"));
    addScore("recovery-lag", 0.76, hasFacet("recovery") && facetLag("recovery"));
    addScore("rollout-lag", 0.68, hasFacet("rollout") && facetLag("rollout"));
    addScore("ops-holds", 0.62, facetHold("ops", "recovery"));
    addScore("durability-holds", 0.6, facetHold("validator", "recovery", "rollout"));
    addScore("durability-split", 0.38, true);
    return pickTilt("durability-split");
  }
  if (lane === "market-structure" && focus === "settlement") {
    addScore("size-only", 0.74, hasFacet("volume") && facetLag("volume"));
    addScore("execution-thin", 0.76, hasFacet("execution") && facetLag("execution"));
    addScore("depth-thin", 0.74, hasFacet("depth") && facetLag("depth"));
    addScore("settlement-lag", 0.72, /(정산|settlement|호가 책|깊이)/.test(mergedText));
    addScore("book-thin", 0.72, /(호가 책|호가|book)/.test(mergedText));
    addScore("settlement-holds", 0.62, facetHold("volume", "depth") || facetHold("settlement", "execution"));
    addScore("settlement-split", 0.38, true);
    return pickTilt("settlement-split");
  }
  if (lane === "market-structure" && focus === "liquidity") {
    addScore("depth-thin", 0.76, hasFacet("depth") && facetLag("depth"));
    addScore("capital-thin", 0.72, hasFacet("capital") && facetLag("capital"));
    addScore("liquidity-holds", 0.62, facetHold("execution", "depth"));
    addScore("liquidity-split", 0.38, true);
    return pickTilt("liquidity-split");
  }
  if (lane === "onchain" && focus === "durability") {
    addScore("congestion-lag", 0.74, hasFacet("congestion") && facetLag("congestion"));
    addScore("capital-lag", 0.72, hasFacet("capital") && facetLag("capital"));
    addScore("durability-holds", 0.62, facetHold("usage", "congestion", "capital"));
    addScore("durability-split", 0.38, true);
    return pickTilt("durability-split");
  }
  if (lane === "onchain" && focus === "flow") {
    addScore("capital-lag", 0.74, hasFacet("capital") && facetLag("capital"));
    addScore("flow-lag", 0.74, hasFacet("flow") && facetLag("flow"));
    addScore("flow-holds", 0.62, facetHold("flow", "capital"));
    addScore("flow-split", 0.38, true);
    return pickTilt("flow-split");
  }
  return "";
}

export function resolvePlannerSceneFamily(lane: TrendLane, focus: PlannerFocus, pair: OnchainEvidence[]): string {
  const facets = [...new Set(pair.map((item) => resolvePlannerSceneFacet(item, lane)).filter(Boolean))].sort().slice(0, 3);
  const merged = sanitizeTweetText(pair.map((item) => `${item.label} ${item.value} ${item.summary}`).join(" | ")).toLowerCase();
  let facetKey = facets.length > 0 ? facets.join("+") : "generic";

  if (lane === "ecosystem" && focus === "builder") {
    if (facets.includes("builder") && facets.includes("inside")) {
      facetKey = "builder+inside";
    } else if (facets.includes("builder") && facets.includes("return")) {
      facetKey = "builder+return";
    } else if (facets.includes("builder") && facets.includes("usage")) {
      facetKey = "builder+usage";
    } else if (facets.includes("builder") && facets.includes("capital")) {
      facetKey = /(예치 자금|tvl|자금)/.test(merged) ? "builder+capital" : "builder";
    } else if (facets.includes("builder")) {
      facetKey = "builder";
    }
  }

  if (lane === "ecosystem" && focus === "retention") facetKey = resolveRetentionSceneBase(merged, facets);
  if (lane === "protocol" && focus === "launch") facetKey = resolveLaunchSceneBase(merged, facets);
  if (lane === "market-structure" && focus === "settlement") facetKey = resolveSettlementSceneBase(merged, facets);
  if (lane === "protocol" && focus === "durability") facetKey = resolveDurabilitySceneBase(merged, facets);
  if (lane === "regulation" && focus === "court") facetKey = resolveCourtSceneBase(merged, facets);

  const tilt = resolvePlannerSceneTilt(lane, focus, pair, facets);
  return tilt ? `${lane}:${focus}:${facetKey}:${tilt}` : `${lane}:${focus}:${facetKey}`;
}

export function estimateNarrativeBucketBonus(pair: OnchainEvidence[], lane: TrendLane): number {
  const buckets = pair.map((item) => classifyNarrativeBucket(item));
  const distinct = new Set(buckets).size;
  const focus = resolvePlannerFocus(lane, pair);
  let bonus = 0;
  const has = (bucket: NarrativeBucket) => buckets.includes(bucket);

  if (distinct >= 2) bonus += 0.08;
  if (buckets.includes("generic")) bonus -= 0.08;

  if (lane === "ecosystem") {
    if (has("retention") && has("usage")) bonus += 0.18;
    if (has("heat") && has("usage")) bonus += 0.1;
    if (has("retention") && has("capital")) bonus += 0.08;
    if (has("builder") && (has("capital") || has("usage") || has("settlement"))) bonus += 0.2;
    if (focus === "builder") bonus += 0.18;
    if (focus === "retention") bonus += 0.08;
    if (focus === "hype") bonus += 0.04;
    if (has("heat") && !has("usage") && !has("retention")) bonus -= 0.12;
    if (focus === "general") bonus -= 0.12;
  }
  if (lane === "regulation") {
    if (has("legal") && (has("capital") || has("execution") || has("usage"))) bonus += 0.18;
    if (has("legal") && has("whale")) bonus += 0.08;
    if (focus === "court") bonus += 0.12;
    if (focus === "execution") bonus += 0.06;
    if (has("legal") && has("generic")) bonus -= 0.1;
    if (focus === "general") bonus -= 0.1;
  }
  if (lane === "protocol") {
    if (has("ops") && (has("usage") || has("durability") || has("capital") || has("settlement"))) bonus += 0.16;
    if (focus === "launch") bonus += 0.14;
    if (focus === "durability") bonus += 0.06;
    if (has("ops") && has("generic")) bonus -= 0.08;
    if (focus === "general") bonus -= 0.1;
  }
  if (lane === "onchain") {
    if (has("durability") && (has("capital") || has("usage") || has("whale"))) bonus += 0.16;
    if (focus === "flow") bonus += 0.12;
    if (focus === "durability") bonus += 0.06;
    if (has("durability") && has("generic")) bonus -= 0.08;
    if (focus === "general") bonus -= 0.08;
  }
  if (lane === "market-structure") {
    if (has("liquidity") && (has("capital") || has("heat") || has("settlement"))) bonus += 0.16;
    if (focus === "settlement") bonus += 0.12;
    if (focus === "liquidity") bonus += 0.06;
    if (focus === "general") bonus -= 0.1;
  }
  if (lane === "macro") {
    if (has("capital") || has("usage")) bonus += 0.06;
  }

  return clampNumber(bonus, -0.2, 0.28, 0);
}

export function estimateSceneFamilyMonopolyPenalty(
  lane: TrendLane,
  focus: PlannerFocus,
  sceneFamily: string,
  familyCount: number
): number {
  if (familyCount <= 1) return 0;
  let penalty = 0.05 * (familyCount - 1);
  if (
    (lane === "ecosystem" && focus === "retention" && sceneFamilyMatches(sceneFamily, /(cohort\+wallet|retention\+usage|wallet\+usage)$/)) ||
    (lane === "ecosystem" && focus === "builder" && sceneFamilyMatches(sceneFamily, /builder\+capital$/)) ||
    (lane === "protocol" && focus === "launch" && sceneFamilyMatches(sceneFamily, /(capital\+launch|launch\+capital|return\+launch|return\+announcement|return\+ops|return\+showcase|launch\+ops)$/)) ||
    (lane === "regulation" && focus === "court" && sceneFamilyMatches(sceneFamily, /^regulation:court:court$|briefing\+capital/)) ||
    (lane === "protocol" && focus === "durability" && sceneFamilyMatches(sceneFamily, /(recovery\+validator|ops\+validator|rollout\+validator|validator\+log)$/))
  ) {
    penalty += lane === "regulation" && focus === "court" ? 0.14 : 0.1;
  }
  return clampNumber(penalty, 0, 0.26, 0);
}

export function estimateNarrativeTension(
  pair: OnchainEvidence[],
  lane: TrendLane,
  focus: PlannerFocus,
  sceneFamily: string
): number {
  const positive = /(유지|확대|증가|복귀|재가동|정상화|상승|회복|강화|안정)/;
  const negative = /(지연|둔화|정체|관망|이탈|비어|비면|빠지|식음|약화|하락|멈춤|없음|느림)/;
  const merged = sanitizeTweetText(pair.map((item) => `${item.label} ${item.value} ${item.summary}`).join(" | "));
  const positiveCount = pair.filter((item) => positive.test(`${item.value} ${item.summary}`)).length;
  const negativeCount = pair.filter((item) => negative.test(`${item.value} ${item.summary}`)).length;
  let tension = 0;
  if (positiveCount >= 1 && negativeCount >= 1) tension += 0.12;
  if (lane === "ecosystem" && focus === "retention" && /(wallet|retention|usage|community|cohort)/.test(sceneFamilyBase(sceneFamily))) tension += 0.04;
  if (lane === "regulation" && focus === "court" && /(court\+execution|capital\+court|verdict\+execution|briefing\+execution)/.test(sceneFamilyBase(sceneFamily))) tension += 0.06;
  if (lane === "protocol" && focus === "launch" && /(capital\+rollout|launch\+rollout|capital\+launch|return\+launch|launch\+ops|launch\+showcase)/.test(sceneFamilyBase(sceneFamily))) tension += 0.06;
  if (lane === "protocol" && focus === "durability" && /(recovery\+rollout|recovery\+validator)/.test(sceneFamilyBase(sceneFamily))) tension += 0.04;
  if (lane === "market-structure" && /(depth\+execution|capital\+depth|execution\+settlement|depth\+settlement|execution\+depth|volume\+depth|depth\+heat)/.test(sceneFamilyBase(sceneFamily))) tension += 0.05;
  if (/(따로 놀|엇갈|반쪽|허세|광고|기사값|발표값)/.test(merged)) tension += 0.04;
  return clampNumber(tension, 0, 0.24, 0);
}
