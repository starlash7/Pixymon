# 🦊 Pixymon

온체인 데이터를 먹고 진화하는 AI 생명체형 트위터 에이전트

[![Twitter](https://img.shields.io/badge/Twitter-@Pixy__mon-1DA1F2?style=flat&logo=twitter)](https://twitter.com/Pixy_mon)
[![Claude](https://img.shields.io/badge/AI-Claude-blueviolet)](https://anthropic.com)

## 최신 상태

- 최종 업데이트: 2026-02-16 (KST)
- 현재 버전: `1.0.0`
- 기본 브랜치 기준: `main`
- 런타임: Node.js + TypeScript
- LLM: Anthropic Claude (`claude-sonnet-4-5-20250929`)

## 현재 동작 기능

### 1) 마켓 브리핑 자동 포스팅
- 매일 오전 9시 / 오후 9시 (KST)
- 뉴스 + 마켓 데이터 + Fear & Greed + 인플루언서 컨텍스트 기반 생성
- 중복 트윗 검사 후 발행

### 2) 멘션 자동 응답
- `@Pixy_mon` 멘션 감지 후 자동 답변
- 한국어/영어 언어 감지 후 대응
- 팔로워 상호작용 기록 기반 컨텍스트 반영

### 3) 프로액티브 인게이지먼트
- 인플루언서 트윗에 주기적으로 답글
- 하루 한도 기반 운영 및 중복 방지
- Twitter API v2 기준으로 동작

### 4) 메모리 시스템
- `data/memory.json` 기반 영구 메모리
- 과거 트윗/예측/멘션/팔로워 상호작용 저장
- 중복/유사 트윗 방지

## 데이터 소스

- CoinGecko: 트렌딩 코인, 마켓 데이터
- CryptoCompare: 크립토 뉴스
- Alternative.me: Fear & Greed Index
- Twitter: 인플루언서 모니터링 및 응답

## 실행 방법

```bash
git clone https://github.com/starlash7/Pixymon.git
cd Pixymon
npm ci
npm run dev
```

### 모드별 실행

```bash
# 24/7 스케줄러 모드
SCHEDULER_MODE=true npm run dev

# 테스트 모드 (실제 트윗 발행 안 함)
TEST_MODE=true npm run dev
```

PowerShell:

```powershell
$env:SCHEDULER_MODE="true"; npm run dev
$env:TEST_MODE="true"; npm run dev
```

## 환경 변수 (.env)

```env
# Claude API
ANTHROPIC_API_KEY=your_anthropic_api_key_here

# Twitter API v2
TWITTER_API_KEY=your_twitter_api_key_here
TWITTER_API_SECRET=your_twitter_api_secret_here
TWITTER_ACCESS_TOKEN=your_twitter_access_token_here
TWITTER_ACCESS_SECRET=your_twitter_access_secret_here
TWITTER_USERNAME=Pixy_mon

# Runtime flags
TEST_MODE=true
SCHEDULER_MODE=false

NODE_ENV=development
LOG_LEVEL=info
```

## 프로젝트 구조 (모듈화 반영)

```text
src/
├── index.ts
├── character.ts
├── config/
│   └── influencers.ts
├── services/
│   ├── blockchain-news.ts
│   ├── briefing.ts
│   ├── engagement.ts
│   ├── llm.ts
│   ├── memory.ts
│   ├── onchain-data.ts
│   ├── reflection.ts
│   ├── research-engine.ts
│   └── twitter.ts
├── types/
│   ├── agent.ts
│   └── index.ts
└── utils/
    └── mood.ts
```

## 빌드/테스트 상태

- `npm run build`: 동작
- `npm run test`: 현재 미정의 (test script 없음)

## 참고

- 운영 규칙 문서: `CLAUDE.md`
- 메모리 파일(`data/memory.json`)은 코드 경유로만 업데이트 권장

**NFA**: 투자 조언이 아닙니다. AI 생성 콘텐츠는 검증이 필요합니다.
