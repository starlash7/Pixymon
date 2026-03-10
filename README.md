# Pixymon

온체인 데이터를 먹고 성장하는 캐릭터형 X 에이전트.

<p align="center">
  <img src="./docs/assets/pixymon-sprite.jpg" alt="Pixymon sprite sheet" width="680" />
</p>

## 현재 상태

현재 메인 브랜치 기준 Pixymon은 아래를 갖춘 상태입니다.

- `feed -> digest -> evolve -> plan -> act -> reflect` 루프
- 한국어 중심 narrative post / quote / reply surface
- X API / Anthropic / 총합 비용 가드
- Anthropic prompt caching + surface별 모델 라우팅
- batch reflection queue / sync / soul state 반영
- narrative audit 로그와 금지어/치환어 사전

지금 단계의 핵심은 `문장 튜닝을 더 크게 하는 것`이 아니라, `저속 운영 -> 이상 문장 수집 -> 사전 보강` 루프로 넘어가는 것입니다.

기준 문서:

- 실행/운영: `README.md`
- 워크스페이스 규칙: `AGENTS.md`, `docs/agent-workflow.md`
- 리라이트 계획: `docs/plan.md`

## 제품 정의

Pixymon의 목표는 다음 두 가지를 동시에 만족하는 것입니다.

1. 사실 기반: 온체인/시장/뉴스 신호를 왜곡 없이 소화
2. 캐릭터 기반: 욕망/기분/퀘스트를 가진 서사형 행동

## 현재 아키텍처

핵심 루프:

1. `Sense`: 온체인/시장/뉴스/소셜 입력 수집
2. `Digest`: 품질 점수와 신뢰도 계산
3. `Desire`: hunger(신호/주의/신선도) 상태 갱신
4. `Quest`: 당일 추적할 스레드/가설 선택
5. `Decide`: post/quote/reply/image 행동 포트폴리오 결정
6. `Act`: 발행
7. `Reflect`: 반응/중복/비용/정확도 기반 정책 갱신

운영 보조 루프:

1. `Budget`: X / LLM / TOTAL 일일 비용 가드
2. `Cache`: shared context + prompt caching
3. `Batch`: 비긴급 digest reflection 비동기 처리
4. `Audit`: 실제 발행 문장을 `narrative-observation`으로 기록
5. `Lexicon`: 상위 hit 라벨만 `src/services/narrative-lexicon.ts`에서 보강

## 핵심 구현

- 비용/요청량 가드
  - `src/services/x-api-budget.ts`
  - `src/services/anthropic-budget.ts`
  - `src/services/anthropic-admin-usage.ts`
- narrative 생성 / 후처리
  - `src/services/engagement.ts`
  - `src/services/engagement/text-finalize.ts`
- batch reflection
  - `src/services/llm-batch-queue.ts`
  - `src/services/llm-batch-runner.ts`
  - `src/services/llm-batch-runs.ts`
- narrative audit
  - `src/services/narrative-lexicon.ts`
  - `src/services/narrative-observer.ts`
  - `scripts/narrative-audit-report.mjs`

## 실행

설치:

```bash
npm ci
```

로컬 안전 실행(권장):

```bash
TEST_MODE=true SCHEDULER_MODE=false npm run dev
```

저속 실운영(권장 시작값):

```bash
TEST_MODE=false \
SCHEDULER_MODE=true \
DAILY_ACTIVITY_TARGET=4 \
DAILY_TARGET_TIMEZONE=Asia/Seoul \
POST_MIN_INTERVAL_MINUTES=180 \
npm run dev
```

로컬 리허설(게시글/말투 확인, 실제 발행 없음):

```bash
TEST_MODE=true \
SCHEDULER_MODE=false \
ACTION_MODE=paper \
STATE_RECONCILE_ON_BOOT=true \
ACTION_TWO_PHASE_COMMIT=true \
npm run dev
```

리허설 결과 확인 파일:

- `data/STATE.md`
- `data/operational-state.json`
- `data/memory.json`
- `data/narrative-observation.ndjson`
- `data/narrative-phrase-audit.json`

빌드/테스트:

```bash
npm run build
npm test
```

narrative audit 리포트:

```bash
npm run audit:narrative
```

## 권장 기본 설정

```env
POST_LANGUAGE=ko
REPLY_LANGUAGE_MODE=match
ENFORCE_KOREAN_POSTS=true

X_API_COST_GUARD_ENABLED=true
X_API_DAILY_MAX_USD=0.10
X_API_DAILY_READ_REQUEST_LIMIT=8
X_API_DAILY_CREATE_REQUEST_LIMIT=10

ANTHROPIC_COST_GUARD_ENABLED=true
ANTHROPIC_DAILY_MAX_USD=0.40
TOTAL_COST_GUARD_ENABLED=true
TOTAL_DAILY_MAX_USD=0.50

ANTHROPIC_PROMPT_CACHING_ENABLED=true
ANTHROPIC_USAGE_API_ENABLED=false

NARRATIVE_AUDIT_ENABLED=true
NARRATIVE_AUDIT_LOG_PATH=data/narrative-observation.ndjson
NARRATIVE_AUDIT_SUMMARY_PATH=data/narrative-phrase-audit.json
```

## 현재 운영 루프

상세는 `docs/plan.md`를 기준으로 합니다.

지금 우선순위:

1. 저속 실운영 2~3일
2. `npm run audit:narrative`와 `data/narrative-phrase-audit.json` 확인
3. hit 상위 라벨만 `src/services/narrative-lexicon.ts` 보강
4. reply / mention 실전 품질 개선으로 이동
