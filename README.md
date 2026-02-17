# Pixymon

온체인 데이터를 먹고 성장하는 캐릭터형 X(Twitter) 에이전트입니다.
Pixymon은 단순 자동포스팅 봇이 아니라, **멘션 응답 + 인플루언서 인게이지먼트 + 메모리 기반 컨텍스트 유지**를 중심으로 동작합니다.

[![Twitter](https://img.shields.io/badge/Twitter-@Pixy__mon-1DA1F2?style=flat&logo=twitter)](https://twitter.com/Pixy_mon)
[![Claude](https://img.shields.io/badge/Claude-Sonnet_4.5-D97706?style=flat-square)](https://www.anthropic.com/)
[![Node](https://img.shields.io/badge/Node.js-18%2B-3C873A?style=flat-square)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square)](https://www.typescriptlang.org/)

<p align="center">
  <img src="./docs/assets/pixymon-sprite.jpg" alt="Pixymon sprite sheet" width="680" />
</p>

## 1. 현재 런타임 상태 (중요)

`src/index.ts` 기준 현재 기본 동작은 아래와 같습니다.

- LLM: Anthropic Claude (`claude-sonnet-4-5-20250929`)
- 스케줄러 모드(`SCHEDULER_MODE=true`)
- 고정 시간 크론 없이 자율 루프 실행
- 하루 활동 목표(`DAILY_ACTIVITY_TARGET`)를 댓글 + 글 합산으로 채움
- 트렌드 글 + 트렌드 댓글 + 멘션 답글을 균형 실행
- 기본 언어 정책: 글은 한국어(`POST_LANGUAGE=ko`), 댓글은 입력 언어 매칭(`REPLY_LANGUAGE_MODE=match`)

즉, 운영 포커스는 **대화형 인게이지먼트 + 트렌드 포스팅** 동시 최적화입니다.

## 2. 핵심 기능

### 2.1 멘션 자동 응답
- `@Pixy_mon` 멘션을 `since_id` 기반으로 수집
- 최근 멘션 커서(`lastProcessedMentionId`)를 영구 저장해 중복 처리 방지
- 실패 시 커서를 앞당기지 않도록 설계되어 멘션 유실 위험 완화

### 2.2 프로액티브 인게이지먼트
- 인플루언서 풀(`src/config/influencers.ts`)에서 샘플링
- 계정별 1회 제한, 이미 답글 단 트윗 skip
- 일일 한도(`TEST_MODE` 50 / 실운영 10) 적용
- 한국어/영어 감지 후 프롬프트 분기

### 2.3 메모리 시스템
- `data/memory.json` 기반 로컬 영구 메모리
- 저장 항목: 트윗 로그, 코인 언급/예측, 팔로워 상호작용, 마지막 멘션 커서, 이미 댓글 단 트윗 목록
- 최근 발화 유사도(Jaccard) 기반 중복 문장 방지

### 2.4 브리핑 파이프라인 (모듈 존재)
- `src/services/briefing.ts`에 구현되어 있으며, 현재 엔트리포인트에서는 스케줄 호출 비활성화
- CoinGecko/CryptoCompare/Fear&Greed/인플루언서 컨텍스트를 합성해 요약 생성 가능

## 3. 아키텍처

### 3.1 실행 계층
- `src/index.ts`: 엔트리포인트, 모드 분기, 크론 스케줄
- `src/services/twitter.ts`: Twitter API 연동, 멘션/답글/게시, rate limit 재시도
- `src/services/llm.ts`: 시스템 프롬프트 구성 및 Claude 호출
- `src/services/engagement.ts`: 멘션 응답/인플루언서 댓글 오케스트레이션
- `src/services/memory.ts`: 로컬 상태 저장소

### 3.2 데이터/리서치 계층 (확장 모듈)
- `src/services/blockchain-news.ts`: 뉴스/마켓/F&G 수집
- `src/services/onchain-data.ts`: 온체인 시그널 스냅샷(TVL, mempool, stablecoin 등)
- `src/services/research-engine.ts`: LLM 기반 구조화 인사이트(`claim/evidence/counterpoint/confidence`)
- `src/services/reflection.ts`: 과거 발화/반응 지표 기반 정책 회고

위 모듈은 현재 코드베이스에 포함되어 있으며, 운영 목적에 따라 엔트리포인트에서 연결 확장 가능합니다.

## 4. 타입 시스템 (핵심 계약)

### 4.1 에이전트 추론 타입 (`src/types/agent.ts`)
- `OnchainSignal`, `OnchainSnapshot`
- `ResearchInput`, `StructuredInsight`, `EvidenceItem`
- `ReflectionPolicy`
- `ActionStyle = assertive | curious | cautious`

### 4.2 공통 도메인 타입 (`src/types/index.ts`)
- 뉴스/마켓/질문 컨텍스트/답변 결과 인터페이스
- 운영 중인 서비스 타입 정합성과 확장 지점 정의

### 4.3 추론(Research) 레이어 규칙 (`src/services/research-engine.ts`)
- 결과는 자연어가 아니라 JSON 구조체로 강제됨: `claim`, `evidence[]`, `counterpoint`, `confidence`, `actionStyle`
- `evidence.source`는 `market | onchain | news | influencer | memory | mixed`만 허용
- 신뢰도 기반 톤 정책: `confidence >= 0.72` -> `assertive`, `0.55 <= confidence < 0.72` -> `curious`, `confidence < 0.55` -> `cautious`
- JSON 파싱 실패/형식 불일치 시 `DEFAULT_INSIGHT`로 안전 폴백

## 5. 기술 스택

- Runtime: Node.js 18+
- Language: TypeScript (`strict`, `NodeNext`)
- LLM SDK: `@anthropic-ai/sdk`
- Social API: `twitter-api-v2`
- Scheduler: `node-cron`
- Config: `dotenv`

## 6. 데이터 소스

- CoinGecko: 마켓/트렌딩
- CryptoCompare: 뉴스
- Alternative.me: Fear & Greed
- DefiLlama / mempool.space / blockchain.com: 온체인 시그널 확장 모듈
- X(Twitter): 멘션/타임라인/답글

## 7. 실행 방법

### 7.1 설치

```bash
npm ci
```

### 7.2 개발 실행

```bash
npm run dev
```

### 7.3 스케줄러 모드

```bash
SCHEDULER_MODE=true npm run dev
```

권장 예시:

```bash
SCHEDULER_MODE=true DAILY_ACTIVITY_TARGET=20 DAILY_TARGET_TIMEZONE=Asia/Seoul npm run dev
```

### 7.4 테스트 모드 (실제 포스팅/답글 미발행)

```bash
TEST_MODE=true npm run dev
```

## 8. 환경 변수

```env
# Claude
ANTHROPIC_API_KEY=your_anthropic_api_key_here

# Twitter API v2
TWITTER_API_KEY=your_twitter_api_key_here
TWITTER_API_SECRET=your_twitter_api_secret_here
TWITTER_ACCESS_TOKEN=your_twitter_access_token_here
TWITTER_ACCESS_SECRET=your_twitter_access_secret_here
TWITTER_USERNAME=Pixy_mon

# Runtime
TEST_MODE=true
SCHEDULER_MODE=false
DAILY_ACTIVITY_TARGET=20
DAILY_TARGET_TIMEZONE=Asia/Seoul
MAX_ACTIONS_PER_CYCLE=4
MIN_LOOP_MINUTES=25
MAX_LOOP_MINUTES=70

# Engagement tuning
POST_GENERATION_MAX_ATTEMPTS=2
POST_MAX_CHARS=220
POST_MIN_LENGTH=20
POST_LANGUAGE=ko
REPLY_LANGUAGE_MODE=match
TREND_NEWS_MIN_SOURCE_TRUST=0.28
TREND_TWEET_MIN_SOURCE_TRUST=0.24
TREND_TWEET_MIN_SCORE=3.2
TREND_TWEET_MIN_ENGAGEMENT=6
TOPIC_MAX_SAME_TAG_24H=3
TOPIC_BLOCK_CONSECUTIVE_TAG=true
NODE_ENV=development
LOG_LEVEL=info
```

`TEST_MODE=false`일 때 Twitter 키 누락 시 프로세스가 종료됩니다.

## 9. 빌드 및 산출물

```bash
npm run build
```

- 출력 경로: `dist/`
- `tsconfig` 옵션: declaration/source map 포함

## 10. 프로젝트 구조

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

## 11. 운영 워크플로우

멀티 워크스페이스/브랜치 운영 규칙은 아래 문서 사용:

- `docs/agent-workflow.md`

## 12. 주의사항

- 투자 자문 목적이 아닙니다 (NFA).
- 외부 API 응답/지연/제한에 따라 결과가 달라질 수 있습니다.
- 자동 생성 텍스트는 게시 전 검토가 필요합니다.
