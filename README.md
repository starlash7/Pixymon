# Pixymon

온체인 데이터를 먹고 성장하는 캐릭터형 X(Twitter) 에이전트입니다.  
현재 Pixymon은 단순 자동포스팅 봇이 아니라, **멘션 응답 + 트렌드 인게이지먼트 + 메모리/관측성 기반 운영 루프**를 중심으로 동작합니다.

[![Twitter](https://img.shields.io/badge/Twitter-@Pixy__mon-1DA1F2?style=flat&logo=twitter)](https://twitter.com/Pixy_mon)
[![Claude](https://img.shields.io/badge/Claude-Sonnet_4.5-D97706?style=flat-square)](https://www.anthropic.com/)
[![Node](https://img.shields.io/badge/Node.js-18%2B-3C873A?style=flat-square)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square)](https://www.typescriptlang.org/)

<p align="center">
  <img src="./docs/assets/pixymon-sprite.jpg" alt="Pixymon sprite sheet" width="680" />
</p>

## 1. 현재 상태 요약

2026-02-17 기준 주요 업데이트:

1. 고정 시간 크론 기반이 아닌 **자율 quota 루프**로 운영
2. 트렌드 글/댓글/멘션 응답을 목표치 기반으로 균형 실행
3. **품질 게이트 강화**: 숫자 앵커 정합성, 중복/내러티브 반복, 주제 다양성
4. **적응형 정책 + 신뢰도 계층**: 실패율/폴백율/소스 신뢰도에 따라 임계값 자동 보정
5. **관측성 추가**: 사이클 메트릭 JSON 출력 + `data/metrics-events.ndjson` 저장
6. **자동 테스트 추가**: `npm test`로 핵심 설정/품질/관측성 유닛 테스트 실행
7. 레거시 경로 정리: 구형 `briefing`/`influencer` 하드코딩 경로 제거

## 2. 런타임 동작

`src/index.ts` 기준 기본 동작:

1. `SCHEDULER_MODE=true`면 24/7 자율 루프, `false`면 one-shot 사이클
2. 하루 목표(`DAILY_ACTIVITY_TARGET`)를 댓글+글 합산으로 채움
3. 기본 언어 정책:
   - 글: `POST_LANGUAGE=ko`
   - 댓글: `REPLY_LANGUAGE_MODE=match`
4. 핵심 실행 경로:
   - 멘션 응답
   - 트렌드 글 생성
   - 트렌드 댓글

## 3. 핵심 아키텍처

### 3.1 Orchestration Layer

- `src/index.ts`: 엔트리포인트, 모드 분기
- `src/services/runtime.ts`: one-shot / scheduler 실행 컨트롤
- `src/services/engagement.ts`: quota 사이클 오케스트레이션

### 3.2 Intelligence & Quality Layer

- `src/services/llm.ts`: Claude 호출 및 톤 정책
- `src/services/cognitive-engine.ts`: 5-layer 인지 루프
- `src/services/engagement/quality.ts`: 품질 게이트
- `src/services/engagement/policy.ts`: 적응형 정책

### 3.3 Data & Memory Layer

- `src/services/blockchain-news.ts`: 뉴스/마켓/F&G 수집
- `src/services/onchain-data.ts`: 온체인 시그널 스냅샷
- `src/services/memory.ts`: 영구 메모리 및 텔레메트리 저장
- `src/services/observability.ts`: 구조화 메트릭 출력/기록

## 4. 운영 품질/관측 지표

현재 기록되는 핵심 지표:

1. `post_fail_reason`
2. `retry_count`
3. `fallback_rate`
4. `source_trust` 변화
5. 캐시 히트/미스 (`cognitive`, `runContext`, `trendContext`, `trendTweets`)

메트릭 저장:

- stdout JSON (`OBSERVABILITY_STDOUT_JSON=true`)
- `data/metrics-events.ndjson`

## 5. 실행 방법

설치:

```bash
npm ci
```

개발 실행:

```bash
npm run dev
```

스케줄러 실행 (권장):

```bash
SCHEDULER_MODE=true DAILY_ACTIVITY_TARGET=20 DAILY_TARGET_TIMEZONE=Asia/Seoul npm run dev
```

테스트 모드:

```bash
TEST_MODE=true npm run dev
```

빌드/테스트:

```bash
npm run build
npm test
```

## 6. 환경 변수 (핵심)

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

# Observability
OBSERVABILITY_ENABLED=true
OBSERVABILITY_STDOUT_JSON=true
OBSERVABILITY_EVENT_LOG_PATH=data/metrics-events.ndjson
```

참고:

- `TEST_MODE=false`일 때 Twitter 키가 없으면 프로세스가 종료됩니다.

## 7. 프로젝트 구조

```text
src/
├── index.ts
├── character.ts
├── services/
│   ├── blockchain-news.ts
│   ├── cognitive-engine.ts
│   ├── engagement.ts
│   ├── engagement/
│   │   ├── policy.ts
│   │   ├── quality.ts
│   │   ├── trend-context.ts
│   │   └── types.ts
│   ├── llm.ts
│   ├── memory.ts
│   ├── observability.ts
│   ├── onchain-data.ts
│   ├── reflection.ts
│   ├── research-engine.ts
│   ├── runtime.ts
│   └── twitter.ts
├── types/
│   ├── agent.ts
│   ├── index.ts
│   └── runtime.ts
└── utils/
    └── mood.ts
```

## 8. 로드맵 문서

다음 진화 방향(Feed -> Digest -> Evolve -> Act -> Reflect, Phase Gate 포함):

- `docs/plan.md`

멀티 워크스페이스 운영 규칙:

- `docs/agent-workflow.md`
- `AGENTS.md`

## 9. 주의사항

1. 투자 자문 목적이 아닙니다 (NFA).
2. 외부 API 응답/지연/제한에 따라 결과가 달라질 수 있습니다.
3. 자동 생성 텍스트는 게시 전 검토가 필요합니다.
