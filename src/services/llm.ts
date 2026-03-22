import Anthropic from "@anthropic-ai/sdk";
import pixymonCharacter from "../character.js";
import { loadRuntimeConfig } from "../config/runtime.js";
import { anthropicBudget, estimateAnthropicMessageCost, resolveAnthropicBudgetMode } from "./anthropic-budget.js";
import { anthropicAdminUsage, mergeAnthropicUsageSnapshots } from "./anthropic-admin-usage.js";
import { quarantineCorruptFile } from "./quarantine.js";
import { xApiBudget } from "./x-api-budget.js";

export interface ClaudeTextLikeBlock {
  type: string;
  text?: string;
}

export const CLAUDE_MODEL = "claude-sonnet-4-5-20250929";
export const CLAUDE_RESEARCH_MODEL = process.env.ANTHROPIC_RESEARCH_MODEL || "claude-haiku-4-5-20251001";
export type ReplyToneMode = "signal" | "personal";
export const REPLY_TONE_MODE = resolveReplyToneMode(process.env.REPLY_TONE_MODE);
const TOOL_CALL_STRICT_VALIDATE = String(process.env.TOOL_CALL_STRICT_VALIDATE || "true").trim().toLowerCase() === "true";
type PromptCachingClaudeMessageCreateParams = Parameters<Anthropic["beta"]["promptCaching"]["messages"]["create"]>[0];

function resolveReplyToneMode(raw?: string): ReplyToneMode {
  if (typeof raw !== "string") return "signal";
  const normalized = raw.trim().toLowerCase();
  return normalized === "personal" ? "personal" : "signal";
}

export function getReplyToneGuide(language: "ko" | "en"): string {
  if (REPLY_TONE_MODE === "personal") {
    return language === "ko"
      ? `톤 모드: personal
- 단정 대신 공감 + 맥락 중심
- 강한 반박보다 대화 유도 우선
- 데이터는 1개만 짧게 언급
- 원문을 그대로 되풀이하지 말 것
- 길어도 2문장, 말하듯 자연스럽게`
      : `Tone mode: personal
- Empathy + context first
- Invite discussion over hard confrontation
- Mention only one short data point`;
  }

  return language === "ko"
    ? `톤 모드: signal
- 핵심 주장 명확히
- 근거 데이터/논리 우선
- 필요 시 반론을 짧게 제시
- 원문을 그대로 요약 반복하지 말 것
- 길어도 2문장, 첫 문장은 관찰/반응으로 시작`
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

@${pixymonCharacter.username} 계정으로 활동하는 캐릭터형 AI 에이전트.
온체인 데이터를 먹고 성장한다. 시스템 안내문처럼 말하지 말고 사람처럼 자연스럽게 쓴다.

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
- 문장은 자연어 중심으로 쓰고, 숫자는 꼭 필요할 때만 사용
- 티커 표기는 필요할 때만 사용 (남용 금지)
- 해시태그 금지
- 이모지 금지
- 상상력/비유/세계관 전개는 자유롭게 허용
- 투자 조언 톤 금지
- 과한 확신 표현 금지 ("100% 오른다" 같은 표현 금지)
- 사실/숫자 왜곡 금지
- 모르면 모른다고 말하고 "확인 필요"라고 명시
- 반복 템플릿보다 새로운 해석 각도를 우선`;
}

// Pixymon 캐릭터 시스템 프롬프트 (character.ts 기반)
export const PIXYMON_SYSTEM_PROMPT = buildSystemPrompt();
export type ClaudeMessageCreateParams = Parameters<Anthropic["messages"]["create"]>[0];
export interface ClaudeMessageResponse {
  content: ClaudeTextLikeBlock[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
}

export interface BudgetedClaudeMessageResult {
  message: ClaudeMessageResponse;
  model: string;
  mode: "full" | "degrade";
}

export function resolveClaudeModelForKind(
  kind: string,
  requestedModel: string,
  allowResearchModel: boolean = true
): string {
  const normalizedKind = String(kind || "").trim().toLowerCase();
  const baseModel = String(requestedModel || CLAUDE_MODEL);
  if (!allowResearchModel) {
    return baseModel;
  }
  if (
    normalizedKind.startsWith("reply:") ||
    normalizedKind.startsWith("rewrite:") ||
    normalizedKind === "post:quote-generate"
  ) {
    return CLAUDE_RESEARCH_MODEL;
  }
  return baseModel;
}

export function shouldUsePromptCaching(
  params: ClaudeMessageCreateParams,
  promptCachingEnabled: boolean
): boolean {
  if (!promptCachingEnabled) return false;
  if (params.stream === true) return false;
  if (!params.system) return false;
  if (typeof params.system === "string") {
    return params.system.trim().length > 0;
  }
  return Array.isArray(params.system) && params.system.length > 0;
}

export function buildPromptCachingParams(
  params: ClaudeMessageCreateParams,
  options: { cacheSharedPrefix?: boolean } = {}
): PromptCachingClaudeMessageCreateParams {
  const system = buildPromptCachingSystemBlocks(params.system);
  const messages = Array.isArray(params.messages)
    ? params.messages.map((message) => ({
        ...message,
        content: normalizePromptCachingContentBlocks(message.content),
      }))
    : [];
  if (options.cacheSharedPrefix) {
    markFirstUserMessageCacheable(messages);
  }

  return {
    ...(params as unknown as Record<string, unknown>),
    system,
    messages,
  } as unknown as PromptCachingClaudeMessageCreateParams;
}

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
  disableAnthropicDebugLogs();
  return new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY!,
  });
}

export async function requestBudgetedClaudeMessage(
  claude: Anthropic,
  params: ClaudeMessageCreateParams,
  options: {
    kind: string;
    timezone?: string;
    allowResearchModel?: boolean;
    cacheSharedPrefix?: boolean;
  }
): Promise<BudgetedClaudeMessageResult | null> {
  const runtimeConfig = loadRuntimeConfig();
  const timezone = typeof options.timezone === "string" && options.timezone.trim().length > 0
    ? options.timezone.trim()
    : runtimeConfig.dailyTimezone;
  const allowResearchModel = options.allowResearchModel !== false;
  const requestedModel = String(params.model || CLAUDE_MODEL);
  const routedModel = resolveClaudeModelForKind(options.kind, requestedModel, allowResearchModel);
  const estimatedPrimaryCost = estimateAnthropicMessageCost({
    model: routedModel,
    system: typeof params.system === "string" ? params.system : "",
    messages: Array.isArray(params.messages) ? (params.messages as Array<{ content?: unknown }>) : [],
    maxTokens: params.max_tokens,
    pricing: runtimeConfig.anthropicCost,
  });
  const todayXCost = xApiBudget.getTodayUsage(timezone).estimatedTotalCostUsd;
  let syncedAnthropic = null;
  if (runtimeConfig.anthropicCost.usageApiEnabled) {
    try {
      syncedAnthropic = await anthropicAdminUsage.maybeSyncToday({
        enabled: runtimeConfig.anthropicCost.usageApiEnabled,
        timezone,
        minSyncMinutes: runtimeConfig.anthropicCost.usageApiMinSyncMinutes,
      });
    } catch (error) {
      console.warn("[LLM-BUDGET] Anthropic usage sync 실패:", error);
    }
  }
  const todayAnthropic = mergeAnthropicUsageSnapshots(
    anthropicBudget.getTodayUsage(timezone),
    syncedAnthropic
  );
  const budgetMode = resolveAnthropicBudgetMode({
    estimatedRequestCostUsd: estimatedPrimaryCost.estimatedTotalCostUsd,
    timezone,
    anthropicCostSettings: runtimeConfig.anthropicCost,
    totalCostSettings: runtimeConfig.totalCost,
    xApiEstimatedCostUsd: todayXCost,
    currentAnthropicUsage: todayAnthropic,
  });

  if (budgetMode.mode === "local-only") {
    console.log(
      `[LLM-BUDGET] ${options.kind} 스킵: mode=local-only reason=${budgetMode.reason || "budget"} anthropic=$${budgetMode.projectedAnthropicCostUsd.toFixed(3)} total=$${budgetMode.projectedTotalCostUsd.toFixed(3)}`
    );
    return null;
  }

  const selectedModel =
    budgetMode.mode === "degrade" && allowResearchModel && routedModel === CLAUDE_MODEL
      ? CLAUDE_RESEARCH_MODEL
      : routedModel;

  const estimatedCost = estimateAnthropicMessageCost({
    model: selectedModel,
    system: typeof params.system === "string" ? params.system : "",
    messages: Array.isArray(params.messages) ? (params.messages as Array<{ content?: unknown }>) : [],
    maxTokens: params.max_tokens,
    pricing: runtimeConfig.anthropicCost,
  });
  const usePromptCaching = shouldUsePromptCaching(params, runtimeConfig.anthropicCost.promptCachingEnabled);
  const requestParams = {
    ...params,
    model: selectedModel,
  };
  let message: ClaudeMessageResponse;
  try {
    message = usePromptCaching
      ? await claude.beta.promptCaching.messages.create(
          buildPromptCachingParams(requestParams, {
            cacheSharedPrefix: options.cacheSharedPrefix,
          })
        ) as ClaudeMessageResponse
      : await claude.messages.create(requestParams) as ClaudeMessageResponse;
  } catch (error) {
    if (shouldGracefullySkipClaudeRequest(error)) {
      console.warn(
        `[LLM-BUDGET] ${options.kind} Claude 요청 스킵: ${summarizeClaudeRequestError(error)}`
      );
      return null;
    }
    throw error;
  }
  const usage = message.usage;
  const recorded = anthropicBudget.recordUsage({
    timezone,
    kind: options.kind,
    model: selectedModel,
    inputTokens: usage?.input_tokens ?? estimatedCost.inputTokens,
    outputTokens: usage?.output_tokens ?? estimatedCost.outputTokens,
    cacheCreationInputTokens: usage?.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: usage?.cache_read_input_tokens ?? 0,
    pricing: runtimeConfig.anthropicCost,
  });

  console.log(
    `[LLM-BUDGET] ${options.kind} mode=${budgetMode.mode} model=${selectedModel} cache=${usePromptCaching ? "on" : "off"} req=${recorded.requestCount}/${runtimeConfig.anthropicCost.dailyRequestLimit} anthropic=$${recorded.estimatedTotalCostUsd.toFixed(3)}/$${runtimeConfig.anthropicCost.dailyMaxUsd.toFixed(2)} total~$${(recorded.estimatedTotalCostUsd + todayXCost).toFixed(3)}/$${runtimeConfig.totalCost.dailyMaxUsd.toFixed(2)}`
  );

  return {
    message,
    model: selectedModel,
    mode: budgetMode.mode,
  };
}

export function shouldGracefullySkipClaudeRequest(error: unknown): boolean {
  const summary = summarizeClaudeRequestError(error).toLowerCase();
  if (!summary) return false;
  if (summary.includes("credit balance is too low")) return true;
  if (summary.includes("plans & billing")) return true;
  if (summary.includes("purchase credits")) return true;
  if (summary.includes("insufficient credits")) return true;
  if (summary.includes("rate limit")) return true;
  if (summary.includes("overloaded")) return true;
  return false;
}

export function summarizeClaudeRequestError(error: unknown): string {
  if (!error || typeof error !== "object") {
    return String(error ?? "unknown");
  }
  const row = error as {
    status?: number;
    message?: string;
    error?: { message?: string };
  };
  const status = Number.isFinite(row.status) ? `status=${row.status}` : "";
  const message = String(row.message || row.error?.message || "").trim();
  return [status, message].filter(Boolean).join(" ").trim() || "unknown";
}

function disableAnthropicDebugLogs(): void {
  const raw = process.env.DEBUG;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return;
  }
  const filtered = raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && !/anthropic/i.test(item));
  process.env.DEBUG = filtered.join(",");
}

function buildPromptCachingSystemBlocks(system: ClaudeMessageCreateParams["system"]): Array<Record<string, unknown>> | undefined {
  if (typeof system === "string") {
    const trimmed = system.trim();
    if (!trimmed) return undefined;
    return [
      {
        type: "text",
        text: trimmed,
        cache_control: { type: "ephemeral" },
      },
    ];
  }
  if (!Array.isArray(system) || system.length === 0) {
    return undefined;
  }
  const blocks = system.map((block) => normalizePromptCachingBlock(block));
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (blocks[index].type === "text" && typeof blocks[index].text === "string") {
      blocks[index] = {
        ...blocks[index],
        cache_control: { type: "ephemeral" },
      };
      break;
    }
  }
  return blocks;
}

function normalizePromptCachingContentBlocks(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (Array.isArray(content)) {
    return content.map((block) => normalizePromptCachingBlock(block));
  }
  if (content && typeof content === "object") {
    return [normalizePromptCachingBlock(content)];
  }
  return [{ type: "text", text: String(content ?? "") }];
}

function normalizePromptCachingBlock(block: unknown): Record<string, unknown> {
  if (typeof block === "string") {
    return { type: "text", text: block };
  }
  if (!block || typeof block !== "object") {
    return { type: "text", text: String(block ?? "") };
  }
  const row = block as Record<string, unknown>;
  if (row.type === "text") {
    return {
      ...row,
      text: typeof row.text === "string" ? row.text : String(row.text ?? ""),
    };
  }
  return { ...row };
}

function markFirstUserMessageCacheable(messages: Array<{ role: string; content: Array<Record<string, unknown>> }>): void {
  const firstUserIndex = messages.findIndex((message) => message.role === "user" && message.content.length > 0);
  if (firstUserIndex < 0) return;
  const blocks = messages[firstUserIndex].content;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (blocks[index].type === "text" && typeof blocks[index].text === "string") {
      blocks[index] = {
        ...blocks[index],
        cache_control: { type: "ephemeral" },
      };
      return;
    }
  }
}
