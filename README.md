# 🦊 Pixymon

**트위터 기반 블록체인 뉴스 AI 에이전트**

ElizaOS를 기반으로 만들어진 AI 에이전트로, 매일 핫한 블록체인 이슈를 정리하고 사용자의 질문에 답변합니다.

![ElizaOS](https://img.shields.io/badge/ElizaOS-1.0.0-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue)
![License](https://img.shields.io/badge/License-MIT-green)

---

## ✨ 주요 기능

### 📰 자동 뉴스 요약
- 매일 정해진 시간에 블록체인/암호화폐 관련 핫이슈 자동 수집
- AI를 통한 뉴스 요약 및 트위터 자동 포스팅
- 실시간 마켓 데이터 (BTC, ETH 등) 포함

### 💬 질문 답변
- 트위터 멘션으로 질문하면 AI가 답변
- 블록체인, DeFi, NFT, Layer2 등 다양한 주제 지원
- 최신 뉴스 컨텍스트를 반영한 답변

### 🎯 지원 주제
- Bitcoin & Ethereum
- DeFi (탈중앙화 금융)
- NFT & 디지털 아트
- Layer2 솔루션 (Arbitrum, Optimism, zkSync 등)
- DAO & 거버넌스
- 암호화폐 규제 및 정책

---

## 🚀 시작하기

### 필수 조건

- Node.js 18.0.0 이상
- npm 또는 yarn
- Twitter (X) Developer 계정 및 API 키
- OpenAI API 키

### 설치

```bash
# 저장소 클론
git clone https://github.com/yourusername/pixymon.git
cd pixymon

# 의존성 설치
npm install

# 환경 변수 설정
copy env.example .env
# .env 파일을 열어 API 키 입력
```

### 환경 변수 설정

`env.example` 파일을 `.env`로 복사하고 아래 값들을 입력하세요:

```env
# 필수
OPENAI_API_KEY=your_openai_api_key
TWITTER_USERNAME=your_twitter_username
TWITTER_PASSWORD=your_twitter_password
TWITTER_API_KEY=your_twitter_api_key
TWITTER_API_SECRET=your_twitter_api_secret
TWITTER_ACCESS_TOKEN=your_twitter_access_token
TWITTER_ACCESS_SECRET=your_twitter_access_secret

# 선택 (추가 기능용)
COINGECKO_API_KEY=your_coingecko_api_key
ETHERSCAN_API_KEY=your_etherscan_api_key
```

### 실행

```bash
# 개발 모드
npm run dev

# 프로덕션 빌드 및 실행
npm run build
npm start
```

---

## 📁 프로젝트 구조

```
pixymon/
├── src/
│   ├── index.ts              # 메인 진입점
│   ├── character.ts          # Pixymon 캐릭터 정의
│   ├── services/
│   │   ├── blockchain-news.ts # 뉴스 수집 서비스
│   │   └── scheduler.ts      # 자동 포스팅 스케줄러
│   └── actions/
│       └── answer-question.ts # 질문 답변 액션
├── env.example               # 환경 변수 템플릿
├── package.json
├── tsconfig.json
└── README.md
```

---

## 🔧 설정 커스터마이징

### 캐릭터 수정

`src/character.ts` 파일에서 에이전트의 성격, 말투, 지식 범위를 수정할 수 있습니다:

```typescript
export const pixymonCharacter: Character = {
  name: "Pixymon",
  bio: [...],       // 에이전트 배경
  adjectives: [...], // 성격 특성
  style: {...},     // 말투 스타일
  // ...
};
```

### 포스팅 시간 변경

`src/services/scheduler.ts`에서 자동 포스팅 시간을 변경할 수 있습니다:

```typescript
// 기본: 오전 9시, 오후 6시
private postingHours: number[] = [9, 18];

// 예: 오전 8시, 오후 12시, 오후 8시로 변경
scheduler.setPostingHours([8, 12, 20]);
```

---

## 🛡️ 주의사항

- **투자 조언 금지**: 이 에이전트는 정보 제공 목적으로만 사용됩니다. 투자 결정은 본인의 책임입니다.
- **API 사용량**: Twitter API와 OpenAI API의 사용량 제한을 확인하세요.
- **정보의 정확성**: AI가 생성한 내용은 항상 검증이 필요합니다.

---

## 📝 향후 개발 계획

- [ ] 실시간 뉴스 API 연동 (CoinDesk, The Block 등)
- [ ] 온체인 데이터 분석 기능
- [ ] 텔레그램/디스코드 지원
- [ ] 다국어 지원
- [ ] 웹 대시보드

---

## 🤝 기여하기

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## 📄 라이선스

MIT License - 자세한 내용은 [LICENSE](LICENSE) 파일을 참조하세요.

---

## 🔗 관련 링크

- [ElizaOS Documentation](https://docs.elizaos.ai/)
- [Twitter Developer Portal](https://developer.twitter.com/)
- [OpenAI API](https://platform.openai.com/)

---

Made with ❤️ by Pixymon Team
