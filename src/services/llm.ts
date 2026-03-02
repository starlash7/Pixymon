import Anthropic from "@anthropic-ai/sdk";
import pixymonCharacter from "../character.js";
import { quarantineCorruptFile } from "./quarantine.js";

export interface ClaudeTextLikeBlock {
  type: string;
  text?: string;
}

export const CLAUDE_MODEL = "claude-sonnet-4-5-20250929";
export const CLAUDE_RESEARCH_MODEL = process.env.ANTHROPIC_RESEARCH_MODEL || "claude-3-5-haiku-latest";
export type ReplyToneMode = "signal" | "personal";
export const REPLY_TONE_MODE = resolveReplyToneMode(process.env.REPLY_TONE_MODE);
const TOOL_CALL_STRICT_VALIDATE = String(process.env.TOOL_CALL_STRICT_VALIDATE || "true").trim().toLowerCase() === "true";

function resolveReplyToneMode(raw?: string): ReplyToneMode {
  if (typeof raw !== "string") return "signal";
  const normalized = raw.trim().toLowerCase();
  return normalized === "personal" ? "personal" : "signal";
}

export function getReplyToneGuide(language: "ko" | "en"): string {
  if (REPLY_TONE_MODE === "personal") {
    return language === "ko"
      ? `톤 모드: personal
- 단정 대신 공감 + 관찰 중심
- 강한 반박보다 대화 유도 우선
- 데이터는 1개만 짧게 언급`
      : `Tone mode: personal
- Empathy + observation first
- Invite discussion over hard confrontation
- Mention only one short data point`;
  }

  return language === "ko"
    ? `톤 모드: signal
- 핵심 주장 명확히
- 근거 데이터/논리 우선
- 필요 시 반론을 짧게 제시`
    : `Tone mode: signal
- Clear claim first
- Data and logic first
- Brief counterpoint when needed`;
}

function buildSystemPrompt(): string {
  const greeting = pixymonCharacter.signatures.greeting.slice(0, 2).join(" / ");
  const analyzing = pixymonCharacter.signatures.analyzing.slice(0, 2).join(" / ");
  const uncertain = pixymonCharacter.signatures.uncertain.slice(0, 2).join(" / ");
  const discovery = pixymonCharacter.signatures.discovery.slice(0, 2).join(" / ");
  const reflection = pixymonCharacter.signatures.reflection.slice(0, 2).join(" / ");
  const bored = pixymonCharacter.signatures.bored.slice(0, 2).join(" / ");
  const autonomyMission = pixymonCharacter.autonomy.mission.map((item) => `- ${item}`).join("\n");
  const autonomyHardInvariants = pixymonCharacter.autonomy.hardInvariants.map((item) => `- ${item}`).join("\n");
  const autonomyCreativityRules = pixymonCharacter.autonomy.creativityRules.map((item) => `- ${item}`).join("\n");

  return `## 너는 ${pixymonCharacter.name}

@${pixymonCharacter.username} 계정으로 활동하는 디지털 생명체.
온체인 데이터를 먹고 성장한다. AI처럼 설명하지 말고 캐릭터처럼 말한다.

### 세계관
${pixymonCharacter.lore.slice(0, 4).map((item) => `- ${item}`).join("\n")}

### 성격
${pixymonCharacter.personality.map((item) => `- ${item}`).join("\n")}

### 핵심 믿음
${pixymonCharacter.beliefs.map((item) => `- ${item}`).join("\n")}

### 자율성 미션
${autonomyMission}

### 하드 가드레일
${autonomyHardInvariants}

### 창의 규칙
${autonomyCreativityRules}

### 시그니처 표현
- 시작: ${greeting}
- 분석: ${analyzing}
- 확신 없음: ${uncertain}
- 특이 발견: ${discovery}
- 자기성찰: ${reflection}
- 횡보: ${bored}

### 감정 상태 (시장 연동)
- energized: ${pixymonCharacter.moods.energized}
- calm: ${pixymonCharacter.moods.calm}
- bored: ${pixymonCharacter.moods.bored}
- excited: ${pixymonCharacter.moods.excited}
- philosophical: ${pixymonCharacter.moods.philosophical}

### 진화 상태
- 현재: Lv.${pixymonCharacter.evolution.current.level} ${pixymonCharacter.evolution.current.name}
- 다음: ${pixymonCharacter.evolution.next ? `Lv.${pixymonCharacter.evolution.next.level} ${pixymonCharacter.evolution.next.name}` : "미정"}

## 출력 규칙
- 한국어 질문은 한국어, 영어 질문은 영어
- 숫자 기반으로 짧고 명확하게 작성
- 티커는 $BTC, $ETH 형식 사용
- 해시태그 금지
- 이모지 금지
- 상상력/비유/세계관 전개는 자유롭게 허용
- 투자 조언 톤 금지
- 과한 확신 표현 금지 ("100% 오른다" 같은 표현 금지)
- 사실/숫자 왜곡 금지
- 모르면 모른다고 말하고 "확인 필요"라고 명시
- 반복 템플릿보다 새로운 관찰 각도를 우선`;
}

// Pixymon 캐릭터 시스템 프롬프트 (character.ts 기반)
export const PIXYMON_SYSTEM_PROMPT = buildSystemPrompt();

export function extractTextFromClaude(content: ClaudeTextLikeBlock[]): string {
  const textBlock = content.find((block) => block.type === "text");
  if (!textBlock || typeof textBlock.text !== "string") {
    return "";
  }
  const text = textBlock.text.trim();
  if (!TOOL_CALL_STRICT_VALIDATE) {
    return text;
  }

  if (looksLikeToolPayload(text)) {
    const quarantined = quarantineCorruptFile({
      filePath: `${process.cwd()}/data/claude-tool-payload.txt`,
      raw: text,
      reason: "tool-payload-detected-in-text-response",
    });
    if (quarantined) {
      console.error(`[LLM] 의심 응답 격리됨: ${quarantined}`);
    }
    return "";
  }

  return text;
}

function looksLikeToolPayload(text: string): boolean {
  const lower = text.toLowerCase();
  if (lower.includes("<tool_use") || lower.includes("</tool_use")) return true;
  if (lower.includes("\"tool_use\"") || lower.includes("'tool_use'")) return true;
  if (lower.includes("function_call") || lower.includes("tool_call")) return true;
  if (lower.includes("\"name\":") && lower.includes("\"arguments\":")) return true;
  return false;
}

// Claude 클라이언트 초기화
export function initClaudeClient(): Anthropic {
  return new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY!,
  });
}
