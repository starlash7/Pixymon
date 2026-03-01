# Pixymon

온체인 데이터를 먹고 성장하는 캐릭터형 X 에이전트입니다.

<p align="center">
  <img src="./docs/assets/pixymon-sprite.jpg" alt="Pixymon sprite sheet" width="680" />
</p>

현재 기준 목표는 다음 2축입니다.

1. 데이터 계층: `TrendEvent + OnchainEvidence` 중심의 근거 기반 생성
2. 자율성 계층: 자율 생성은 열되, 예산/리스크/품질 게이트로 발행 제어

## 핵심 루프

Pixymon은 아래 루프를 반복합니다.

1. `Feed`: 온체인/시장/뉴스 수집
2. `Digest`: 신뢰도/신선도/일관성 점수화
3. `Evolve`: XP 누적 및 상태 업데이트
4. `Plan`: lane/event/evidence/narrative 선택
5. `Act`: 품질/계약/자율성 게이트 통과 시 발행
6. `Reflect`: 실패사유/지표 기반 정책 조정

## 현재 아키텍처

### Data Layer

- `src/services/onchain-data.ts`
- `src/services/blockchain-news.ts`
- `src/services/engagement/trend-context.ts`
- `src/services/engagement/event-evidence.ts`

핵심 규칙:

- `event 1 + evidence 2` 계약
- `onchain evidence required` 옵션
- `cross-source evidence required` 옵션

### Autonomy Layer

- `src/services/narrative-os.ts`
- `src/services/autonomy-governor.ts`
- `src/services/engagement.ts`
- `src/services/memory.ts`

핵심 규칙:

- 자율 텍스트 생성 허용
- 발행 전 거버너 차단: 예산/리스크/언어/근거
- 가설/스레드 메모리 누적

### Output & Ops

- `src/services/twitter.ts`
- `src/services/x-api-budget.ts`
- `src/services/observability.ts`
- `src/services/process-lock.ts`

핵심 규칙:

- post dispatch lock/fingerprint 중복 차단
- X API 일일 비용 캡
- 사이클 단위 메트릭 기록

## 언어 정책 (권장)

- 게시글: 한국어 고정
- 댓글: 기본 매치 모드 (`영어 질문이면 영어`, 그 외 한국어)

권장 설정:

```env
POST_LANGUAGE=ko
REPLY_LANGUAGE_MODE=match
ENFORCE_KOREAN_POSTS=true
```

## 실행

설치:

```bash
npm ci
```

개발 실행:

```bash
npm run dev
```

원샷 사이클:

```bash
SCHEDULER_MODE=false npm run dev
```

24/7 루프:

```bash
SCHEDULER_MODE=true DAILY_ACTIVITY_TARGET=20 DAILY_TARGET_TIMEZONE=Asia/Seoul npm run dev
```

빌드/테스트:

```bash
npm run build
npm test
```

## 핵심 환경 변수

```env
# LLM
ANTHROPIC_API_KEY=

# X API
TWITTER_API_KEY=
TWITTER_API_SECRET=
TWITTER_ACCESS_TOKEN=
TWITTER_ACCESS_SECRET=
TWITTER_USERNAME=Pixy_mon

# Runtime
TEST_MODE=true
SCHEDULER_MODE=false
DAILY_ACTIVITY_TARGET=20
DAILY_TARGET_TIMEZONE=Asia/Seoul
MAX_ACTIONS_PER_CYCLE=4
MIN_LOOP_MINUTES=25
MAX_LOOP_MINUTES=70

# Generation
POST_LANGUAGE=ko
REPLY_LANGUAGE_MODE=match
POST_GENERATION_MAX_ATTEMPTS=2
POST_MAX_CHARS=220
POST_MIN_LENGTH=20
POST_MIN_INTERVAL_MINUTES=90
MAX_POSTS_PER_CYCLE=1

# Data / Autonomy Gate
REQUIRE_ONCHAIN_EVIDENCE=true
REQUIRE_CROSS_SOURCE_EVIDENCE=true
ENFORCE_KOREAN_POSTS=true
AUTONOMY_MAX_BUDGET_UTILIZATION=0.92
AUTONOMY_RISK_BLOCK_SCORE=7

# Digest
NUTRIENT_MIN_DIGEST_SCORE=0.50
NUTRIENT_MAX_INTAKE_PER_CYCLE=12
SENTIMENT_MAX_RATIO_24H=0.25

# Trend filter
TREND_NEWS_MIN_SOURCE_TRUST=0.28
TREND_TWEET_MIN_SOURCE_TRUST=0.24
TREND_TWEET_MIN_SCORE=3.2
TREND_TWEET_MIN_ENGAGEMENT=6
TOPIC_MAX_SAME_TAG_24H=2
TOPIC_BLOCK_CONSECUTIVE_TAG=true

# X cost guard
X_API_COST_GUARD_ENABLED=true
X_API_DAILY_MAX_USD=0.10
X_API_ESTIMATED_READ_COST_USD=0.012
X_API_ESTIMATED_CREATE_COST_USD=0.010
X_API_DAILY_READ_REQUEST_LIMIT=8
X_API_DAILY_CREATE_REQUEST_LIMIT=10
X_MENTION_READ_MIN_INTERVAL_MINUTES=120
X_TREND_READ_MIN_INTERVAL_MINUTES=180
X_CREATE_MIN_INTERVAL_MINUTES=20

# Observability
OBSERVABILITY_ENABLED=true
OBSERVABILITY_STDOUT_JSON=true
OBSERVABILITY_EVENT_LOG_PATH=data/metrics-events.ndjson
```

## 장기 확장 로드맵 (Lobster/AIXBT 지향)

### Phase A: 자율 운영 안정화

- 중복률/재시도율/비용 안정화
- lane 편중 및 BTC 편중 지속 완화

### Phase B: 멀티 포맷 출력

- 인용(quote) 발행
- 이미지 컨셉 생성 및 미디어 발행
- 관련 준비 모듈: `src/services/creative-studio.ts`

### Phase C: 장문 내러티브

- 연재형 스토리 아크(챕터 단위)
- 가설-검증-회고 기반 소설형 출력

## 참고

- 운영 정책/통합 규칙: `AGENTS.md`, `docs/agent-workflow.md`, `docs/plan.md`
