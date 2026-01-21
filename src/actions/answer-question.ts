import {
  Action,
  ActionExample,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback,
  elizaLogger,
} from "@elizaos/core";
import { BlockchainNewsService } from "../services/blockchain-news.js";

/**
 * 질문 답변 액션
 *
 * 사용자의 블록체인 관련 질문에 답변하는 액션입니다.
 */
export const answerQuestionAction: Action = {
  name: "ANSWER_BLOCKCHAIN_QUESTION",
  description: "블록체인, 암호화폐, Web3 관련 질문에 답변합니다.",

  // 이 액션이 실행되어야 하는지 검증
  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const text = message.content.text?.toLowerCase() || "";

    // 블록체인 관련 키워드가 포함되어 있는지 확인
    const blockchainKeywords = [
      "비트코인",
      "이더리움",
      "bitcoin",
      "ethereum",
      "btc",
      "eth",
      "블록체인",
      "blockchain",
      "defi",
      "nft",
      "코인",
      "토큰",
      "지갑",
      "wallet",
      "스테이킹",
      "staking",
      "레이어",
      "layer",
      "가스비",
      "gas",
      "스마트컨트랙트",
      "smart contract",
      "web3",
      "dao",
      "메타마스크",
      "metamask",
    ];

    // 질문 형식인지 확인
    const questionPatterns = ["뭐야", "뭔가요", "어때", "왜", "언제", "어디", "누가", "?", "알려줘", "설명해"];

    const hasKeyword = blockchainKeywords.some((keyword) => text.includes(keyword));
    const isQuestion = questionPatterns.some((pattern) => text.includes(pattern));

    return hasKeyword && isQuestion;
  },

  // 액션 실행
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    _options: any,
    callback: HandlerCallback
  ): Promise<boolean> => {
    elizaLogger.info("💬 질문 답변 액션 실행");

    try {
      const question = message.content.text || "";

      // 뉴스 서비스에서 관련 정보 검색
      const newsService = new BlockchainNewsService();
      const relatedNews = await newsService.searchNews(question);

      // 컨텍스트 생성
      let context = "";
      if (relatedNews.length > 0) {
        context = `\n\n관련 최신 뉴스:\n${relatedNews
          .slice(0, 3)
          .map((n) => `- ${n.title}: ${n.summary}`)
          .join("\n")}`;
      }

      // 응답 생성 (실제로는 LLM을 통해 생성)
      // 여기서는 기본 응답 템플릿 사용
      const response = await generateResponse(question, context);

      // 콜백으로 응답 전달
      callback({
        text: response,
        action: "ANSWER_BLOCKCHAIN_QUESTION",
      });

      return true;
    } catch (error) {
      elizaLogger.error("❌ 질문 답변 실패:", error);

      callback({
        text: "죄송합니다, 답변을 생성하는 중 오류가 발생했어요. 잠시 후 다시 시도해주세요! 🙏",
        action: "ANSWER_BLOCKCHAIN_QUESTION",
      });

      return false;
    }
  },

  // 예시 (few-shot learning용)
  examples: [
    [
      {
        user: "user",
        content: { text: "비트코인이 뭐야?" },
      },
      {
        user: "pixymon",
        content: {
          text: "₿ 비트코인(Bitcoin)은 2009년 사토시 나카모토가 만든 최초의 암호화폐예요!\n\n핵심 특징:\n• 탈중앙화: 은행 없이 P2P로 거래\n• 한정 수량: 총 2,100만 개만 발행\n• 블록체인: 모든 거래가 투명하게 기록\n\n쉽게 말해, '디지털 금'이라고 불리는 이유가 여기에 있어요! 💡",
        },
      },
    ],
    [
      {
        user: "user",
        content: { text: "가스비가 왜 이렇게 비싸?" },
      },
      {
        user: "pixymon",
        content: {
          text: "⛽ 가스비가 비싼 이유를 설명해드릴게요!\n\n가스비 = 네트워크 사용료인데, 비싼 이유는:\n1️⃣ 네트워크 혼잡: 사용자가 많으면 경쟁 입찰\n2️⃣ 복잡한 거래: 스마트컨트랙트 실행은 더 비쌈\n3️⃣ 블록 공간 제한: 한 블록에 담을 수 있는 거래 수 한정\n\n💡 팁: L2(레이어2) 사용하면 가스비를 90% 이상 절약할 수 있어요!",
        },
      },
    ],
  ] as ActionExample[][],

  // 시뮬레이션 (테스트용)
  similes: ["ANSWER_QUESTION", "EXPLAIN_CRYPTO", "BLOCKCHAIN_HELP"],
};

/**
 * 응답 생성 함수 (실제로는 LLM 호출)
 */
async function generateResponse(question: string, context: string): Promise<string> {
  // TODO: 실제 LLM API 호출로 교체
  // 현재는 기본 응답 반환

  const lowerQuestion = question.toLowerCase();

  // 간단한 키워드 기반 응답 (실제로는 LLM이 처리)
  if (lowerQuestion.includes("비트코인") || lowerQuestion.includes("bitcoin")) {
    return `₿ 비트코인에 대해 물어보셨네요!${context}\n\n더 궁금한 점 있으시면 물어봐주세요! 💬`;
  }

  if (lowerQuestion.includes("이더리움") || lowerQuestion.includes("ethereum")) {
    return `⟠ 이더리움 관련 질문이시네요!${context}\n\n추가 질문 환영합니다! 💬`;
  }

  return `좋은 질문이에요! 🤔${context}\n\n더 자세한 내용이 궁금하시면 말씀해주세요!`;
}

export default answerQuestionAction;
