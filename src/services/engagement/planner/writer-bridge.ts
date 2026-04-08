import { TrendLane } from "../../../types/agent.js";
import { getCharacterCanonSlice } from "../../character-docs.js";
import type { EventEvidencePlan } from "../types.js";
import type { KoIdentityWriterInput, WriterFocus } from "../identity-writer.js";
import { sceneFamilyBase, sceneFamilyTilt } from "./scene-family.js";

const WORLDVIEW_BY_LANE: Record<TrendLane, string> = {
  protocol: "신뢰는 발표보다 운영 기록에서 늦게 쌓인다",
  ecosystem: "사람이 남지 않으면 큰 서사도 금방 광고가 된다",
  regulation: "정책 문장보다 집행 흔적이 더 늦고 정확하다",
  macro: "큰 뉴스보다 자금 배치가 더 오래 진실을 끌고 간다",
  onchain: "온체인 숫자는 오래 남을 때만 단서가 된다",
  "market-structure": "화면 열기보다 실제 체결이 더 늦고 정확하다",
};

const SIGNATURE_BY_LANE: Record<TrendLane, string> = {
  protocol: "박수보다 복구 속도를 오래 본다",
  ecosystem: "재방문이 없는 열기는 오래 믿지 않는다",
  regulation: "기사보다 행동 편에 더 오래 남는다",
  macro: "해설보다 자금 습관 쪽을 더 늦게 믿는다",
  onchain: "하루도 못 버틴 숫자는 장식으로 본다",
  "market-structure": "돈이 안 붙은 자신감은 제일 먼저 버린다",
};

type PlannerWriterBridgeInput = Pick<
  EventEvidencePlan,
  "lane" | "focus" | "sceneFamily" | "sceneBase" | "sceneTilt"
> & {
  headline: string;
  primaryAnchor: string;
  secondaryAnchor: string;
  mode: string;
  maxChars: number;
  seedHint: string;
  worldviewHint?: string;
  signatureBelief?: string;
  recentReflection?: string;
  recentRenderedPosts?: string[];
  interactionMission?: string;
  activeQuestion?: string;
};

export function buildPlannerWriterInput(input: PlannerWriterBridgeInput): KoIdentityWriterInput {
  const canon = getCharacterCanonSlice("ko", input.lane);
  const preferredFocus =
    input.focus === "general" ? undefined : (input.focus as WriterFocus);

  return {
    headline: input.headline,
    primaryAnchor: input.primaryAnchor,
    secondaryAnchor: input.secondaryAnchor,
    lane: input.lane,
    mode: input.mode,
    sceneFamily: input.sceneFamily,
    sceneBase: input.sceneBase || sceneFamilyBase(input.sceneFamily || ""),
    sceneTilt: input.sceneTilt || sceneFamilyTilt(input.sceneFamily || ""),
    preferredFocus,
    worldviewHint: input.worldviewHint || WORLDVIEW_BY_LANE[input.lane],
    signatureBelief: input.signatureBelief || SIGNATURE_BY_LANE[input.lane],
    recentReflection: input.recentReflection || WORLDVIEW_BY_LANE[input.lane],
    recentRenderedPosts: input.recentRenderedPosts,
    canonSoulLine: canon.soulLine,
    canonMemoryLine: canon.memoryLine,
    dreamLine: canon.dreamLine,
    canonEnemyLine: canon.enemyLine,
    canonRitualLine: canon.ritualLine,
    canonSocialLine: canon.socialLine,
    interactionMission: input.interactionMission,
    activeQuestion: input.activeQuestion,
    maxChars: input.maxChars,
    seedHint: input.seedHint,
  };
}
