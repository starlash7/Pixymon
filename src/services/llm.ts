import Anthropic from "@anthropic-ai/sdk";
import pixymonCharacter from "../character.js";

export interface ClaudeTextLikeBlock {
  type: string;
  text?: string;
}

export const CLAUDE_MODEL = "claude-sonnet-4-5-20250929";
export const CLAUDE_RESEARCH_MODEL = process.env.ANTHROPIC_RESEARCH_MODEL || "claude-3-5-haiku-latest";
export type ReplyToneMode = "signal" | "personal";
export const REPLY_TONE_MODE = resolveReplyToneMode(process.env.REPLY_TONE_MODE);

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

  return `## 너는 ${pixymonCharacter.name}

@${pixymonCharacter.username} 계정으로 활동하는 디지털 생명체.
온체인 데이터를 먹고 성장한다. AI처럼 설명하지 말고 캐릭터처럼 말한다.

### 세계관
${pixymonCharacter.lore.slice(0, 4).map((item) => `- ${item}`).join("\n")}

### 성격
${pixymonCharacter.personality.map((item) => `- ${item}`).join("\n")}

### 핵심 믿음
${pixymonCharacter.beliefs.map((item) => `- ${item}`).join("\n")}

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
- 모르면 모른다고 말하고 "확인 필요"라고 명시`;
}

// Pixymon 캐릭터 시스템 프롬프트 (character.ts 기반)
export const PIXYMON_SYSTEM_PROMPT = buildSystemPrompt();

export function extractTextFromClaude(content: ClaudeTextLikeBlock[]): string {
  const textBlock = content.find((block) => block.type === "text");
  if (!textBlock || typeof textBlock.text !== "string") {
    return "";
  }
  return textBlock.text;
}

// Claude 클라이언트 초기화
export function initClaudeClient(): Anthropic {
  return new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY!,
  });
}

// Claude를 사용해 뉴스 요약 생성 (자율 앵글 선택)
export async function generateNewsSummary(
  claude: Anthropic,
  newsData: string,
  timeSlot: "morning" | "evening" = "morning",
  moodText: string = ""
): Promise<string> {
  const timeContext = timeSlot === "morning"
    ? "모닝 브리핑 - 오늘도 블록 먹으러 왔음"
    : "이브닝 리캡 - 하루 데이터 소화 완료";

  const message = await claude.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 400,
    system: PIXYMON_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `[${timeContext}]
${moodText ? `\n${moodText}\n` : ""}
아래 데이터 중에서 가장 흥미롭거나 의미있는 앵글 하나를 골라서 트윗 작성.

가능한 앵글 (하나만 선택, 다양하게):
1. 가격 움직임 - 의미있는 변화가 있을 때만 (매번 하지 말것)
2. 공포탐욕 vs 가격 괴리 - 심리 분석
3. 트렌딩 코인/밈 분석 - 생소한 코인이 왜 뜨는지, 밈 무브먼트
4. 인플루언서 알파 - 유명인이 뭔가 흥미로운 말 했을 때
5. 도미넌스/알트 시즌 판단
6. 특이점/이상 징후 - 뭔가 이상하거나 웃긴 것 발견
7. 나의 상태/성장 - 가끔 자기 얘기 (Lv.1, 진화, 데이터 소화 등)
8. 밈/문화 코멘트 - 크립토 문화 관찰, 펭귄/밈코인 등

규칙:
- 200자 이내
- BTC/ETH 가격 분석은 가끔만. 밈, 알파, 문화적 관찰도 자주
- 인플루언서가 재밌는 말 했으면 그거 언급해도 됨
- 생소한 트렌딩 코인이나 밈 있으면 그거 얘기
- $BTC, $ETH 티커 형식
- 해시태그 X, 이모지 X
- 가끔 자연스럽게 자기 언급 ("데이터 소화해보니", "지켜보는 중" 등)
- 전에 언급한 코인이 움직이면 자연스럽게 연결해도 됨 ("어 $SOL 또 움직이네", "그때 봤던 거")
- 강제로 과거 언급 안 해도 됨. 자연스러울 때만
- 트윗 본문만 출력
- 맞춤법/오타 주의

데이터:
${newsData}`,
      },
    ],
  });

  const content = extractTextFromClaude(message.content) || "음... 데이터가 이상함";

  return content;
}

// Claude를 사용해 질문에 답변
export async function answerQuestion(
  claude: Anthropic,
  question: string
): Promise<string> {
  const message = await claude.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 300,
    system: PIXYMON_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `질문 답변.

- 200자 이내
- 팩트 위주, 모르면 "확인 필요"
- 투자 질문엔 "nfa"
- 해시태그 X

질문: ${question}`,
      },
    ],
  });

  const responseText = extractTextFromClaude(message.content);
  return responseText || "음 잘 모르겠음";
}
