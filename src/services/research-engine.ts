import Anthropic from "@anthropic-ai/sdk";
import { EvidenceItem, ResearchInput, StructuredInsight } from "../types/agent.js";

const VALID_SOURCES = new Set<EvidenceItem["source"]>([
  "market",
  "onchain",
  "news",
  "influencer",
  "memory",
  "mixed",
]);

const DEFAULT_INSIGHT: StructuredInsight = {
  claim: "증거 강도가 충분하지 않아 단정 대신 관찰 중심으로 접근",
  evidence: [
    {
      point: "시장 데이터와 뉴스 컨텍스트가 부분적으로만 일치",
      source: "mixed",
      confidence: 0.45,
    },
  ],
  counterpoint: "단기 노이즈일 가능성이 높으므로 확인 필요",
  confidence: 0.45,
  actionStyle: "cautious",
};

interface ClaudeTextBlock {
  type: string;
  text?: string;
}

export class ResearchEngine {
  constructor(
    private readonly claude: Anthropic,
    private readonly model: string,
    private readonly baseSystemPrompt: string
  ) {}

  async generateInsight(input: ResearchInput): Promise<StructuredInsight> {
    try {
      const prompt = this.buildPrompt(input);
      const message = await this.claude.messages.create({
        model: this.model,
        max_tokens: 500,
        system: `${this.baseSystemPrompt}

추가 역할:
- 너는 내부 리서치 레이어다.
- 먼저 주장/근거/반론을 구조화하고, 그 다음에 외부로 문장을 만든다.
- 출력은 반드시 JSON 객체 하나만 반환한다.`,
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
      });

      const rawText = this.extractText(message.content);
      return this.parseInsight(rawText);
    } catch (error) {
      console.error("[RESEARCH] 인사이트 생성 실패:", error);
      return DEFAULT_INSIGHT;
    }
  }

  formatInsightForPrompt(insight: StructuredInsight): string {
    const evidenceText =
      insight.evidence.length > 0
        ? insight.evidence
            .slice(0, 3)
            .map((item) => `${item.point} (src:${item.source}, conf:${Math.round(item.confidence * 100)}%)`)
            .join(" | ")
        : "근거 부족";

    return [
      "## 리서치 레이어",
      `- 주장: ${insight.claim}`,
      `- 근거: ${evidenceText}`,
      `- 반론: ${insight.counterpoint}`,
      `- 종합 확신도: ${Math.round(insight.confidence * 100)}%`,
      `- 권장 톤: ${insight.actionStyle}`,
    ].join("\n");
  }

  private buildPrompt(input: ResearchInput): string {
    return `목표: ${input.objective}
언어: ${input.language}
주제: ${input.topic}

시장 컨텍스트:
${input.marketContext}

온체인 컨텍스트:
${input.onchainContext || "없음"}

인플루언서 컨텍스트:
${input.influencerContext || "없음"}

메모리/회고 컨텍스트:
${input.memoryContext || "없음"}

아래 형식의 JSON만 반환:
{
  "claim": "핵심 주장 한 문장",
  "evidence": [
    {"point":"근거","source":"market|onchain|news|influencer|memory|mixed","confidence":0.0}
  ],
  "counterpoint": "핵심 반론 한 문장",
  "confidence": 0.0,
  "actionStyle": "assertive|curious|cautious"
}

규칙:
- claim/counterpoint는 120자 이내
- evidence는 1~3개
- 확신이 낮으면 confidence를 0.6 미만으로 낮추고 actionStyle은 cautious 또는 curious
- 증거가 엇갈리면 단정 대신 질문형 전략을 택한다`;
  }

  private extractText(content: unknown): string {
    if (!Array.isArray(content)) {
      return "";
    }

    const textBlock = content.find(
      (block): block is ClaudeTextBlock =>
        this.isClaudeTextBlock(block) && block.type === "text" && typeof block.text === "string"
    );

    return textBlock?.text || "";
  }

  private parseInsight(rawText: string): StructuredInsight {
    const jsonText = this.extractJsonString(rawText);
    if (!jsonText) {
      return DEFAULT_INSIGHT;
    }

    try {
      const parsed = JSON.parse(jsonText) as unknown;
      if (!this.isRecord(parsed)) {
        return DEFAULT_INSIGHT;
      }

      const claim = this.toSafeString(parsed.claim, DEFAULT_INSIGHT.claim, 120);
      const counterpoint = this.toSafeString(parsed.counterpoint, DEFAULT_INSIGHT.counterpoint, 120);
      const confidence = this.clampConfidence(this.toNumber(parsed.confidence, DEFAULT_INSIGHT.confidence));
      const actionStyle = this.normalizeActionStyle(parsed.actionStyle, confidence);
      const evidence = this.normalizeEvidence(parsed.evidence);

      return {
        claim,
        counterpoint,
        confidence,
        actionStyle,
        evidence: evidence.length > 0 ? evidence : DEFAULT_INSIGHT.evidence,
      };
    } catch {
      return DEFAULT_INSIGHT;
    }
  }

  private normalizeEvidence(raw: unknown): EvidenceItem[] {
    if (!Array.isArray(raw)) {
      return [];
    }

    return raw
      .slice(0, 3)
      .map((item) => {
        if (!this.isRecord(item)) return null;
        const point = this.toSafeString(item.point, "", 120);
        if (!point) return null;

        const sourceRaw = this.toSafeString(item.source, "mixed", 20) as EvidenceItem["source"];
        const source = VALID_SOURCES.has(sourceRaw) ? sourceRaw : "mixed";
        const confidence = this.clampConfidence(this.toNumber(item.confidence, 0.5));
        return { point, source, confidence };
      })
      .filter((item): item is EvidenceItem => item !== null);
  }

  private normalizeActionStyle(raw: unknown, confidence: number): StructuredInsight["actionStyle"] {
    if (raw === "assertive" || raw === "curious" || raw === "cautious") {
      return raw;
    }
    if (confidence >= 0.72) return "assertive";
    if (confidence >= 0.55) return "curious";
    return "cautious";
  }

  private extractJsonString(text: string): string | null {
    const fenced = text.match(/```json\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
      return fenced[1].trim();
    }

    const direct = text.trim();
    if (direct.startsWith("{") && direct.endsWith("}")) {
      return direct;
    }

    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      return text.slice(firstBrace, lastBrace + 1).trim();
    }

    return null;
  }

  private toSafeString(value: unknown, fallback: string, maxLength: number): string {
    if (typeof value !== "string") return fallback;
    const trimmed = value.trim();
    if (!trimmed) return fallback;
    return trimmed.slice(0, maxLength);
  }

  private toNumber(value: unknown, fallback: number): number {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number.parseFloat(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return fallback;
  }

  private clampConfidence(value: number): number {
    if (value < 0) return 0;
    if (value > 1) return 1;
    return Math.round(value * 100) / 100;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  private isClaudeTextBlock(value: unknown): value is ClaudeTextBlock {
    if (!this.isRecord(value)) {
      return false;
    }
    return typeof value.type === "string" && (value.text === undefined || typeof value.text === "string");
  }
}

export default ResearchEngine;
