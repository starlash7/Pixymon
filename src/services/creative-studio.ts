import { TrendLane } from "../types/agent.js";
import { sanitizeTweetText } from "./engagement/quality.js";

export type CreativeTrack = "quote-reply" | "image-concept" | "story-arc";

interface CreativeBaseInput {
  lane: TrendLane;
  eventHeadline: string;
  evidence: string[];
}

export interface QuoteSeedInput extends CreativeBaseInput {
  language: "ko" | "en";
}

export interface ImageSeedInput extends CreativeBaseInput {
  characterName?: string;
}

export interface StorySeedInput extends CreativeBaseInput {
  language: "ko" | "en";
  hypothesis?: string;
}

export function buildQuoteReplySeed(input: QuoteSeedInput): string {
  const headline = compact(input.eventHeadline, 120);
  const evidence = (input.evidence || []).slice(0, 2).map((item) => compact(item, 64));
  if (input.language === "ko") {
    return compact(
      `${headline}. 근거 ${evidence[0] || "데이터 확인 중"}, ${evidence[1] || "추가 근거 수집 중"}. 이 흐름을 인용으로 짧게 해석해보면?`,
      220
    );
  }
  return compact(
    `${headline}. Evidence: ${evidence[0] || "data pending"}, ${evidence[1] || "more context loading"}. Draft a concise quote take.`,
    220
  );
}

export function buildImageConceptSeed(input: ImageSeedInput): string {
  const character = compact(input.characterName || "Pixymon", 32);
  const headline = compact(input.eventHeadline, 120);
  const evidence = (input.evidence || []).slice(0, 2).map((item) => compact(item, 64));
  return compact(
    `${character} in ${input.lane} mode, reacting to "${headline}", with data glyphs: ${evidence.join(" | ") || "signal loading"}, cinematic, no text watermark`,
    320
  );
}

export function buildStoryArcSeed(input: StorySeedInput): string {
  const headline = compact(input.eventHeadline, 120);
  const hypothesis = compact(input.hypothesis || "", 120);
  const evidence = (input.evidence || []).slice(0, 2).map((item) => compact(item, 64));
  if (input.language === "ko") {
    return compact(
      `챕터 시드: [${input.lane}] ${headline}. 픽시몬 가설: ${hypothesis || "아직 미정"}. 단서: ${evidence.join(", ") || "수집 중"}. 다음 장면은 관찰-검증-회고 순서로 전개.`,
      420
    );
  }
  return compact(
    `Chapter seed: [${input.lane}] ${headline}. Hypothesis: ${hypothesis || "pending"}. Clues: ${evidence.join(", ") || "collecting"}. Next scene follows observe-verify-reflect.`,
    420
  );
}

function compact(text: string, maxLen: number): string {
  return sanitizeTweetText(String(text || "")).slice(0, Math.max(40, Math.floor(maxLen)));
}
