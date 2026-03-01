# Pixymon

온체인 데이터를 먹고 성장하는 캐릭터형 X 에이전트.

<p align="center">
  <img src="./docs/assets/pixymon-sprite.jpg" alt="Pixymon sprite sheet" width="680" />
</p>

## 현재 상태

현재 코드는 `근거 기반 분석 + 품질/비용 가드`에 강하지만, 캐릭터 자율성은 아직 제한적입니다.  
다음 목표는 “분석 봇”에서 “욕망과 기억을 가진 자율 캐릭터 에이전트”로 구조 전환입니다.

기준 문서:

- 실행/운영: `README.md`
- 워크스페이스 규칙: `AGENTS.md`, `docs/agent-workflow.md`
- 리라이트 계획: `docs/plan.md`

## 제품 정의

Pixymon의 목표는 다음 두 가지를 동시에 만족하는 것입니다.

1. 사실 기반: 온체인/시장/뉴스 신호를 왜곡 없이 소화
2. 캐릭터 기반: 욕망/기분/퀘스트를 가진 서사형 행동

## 아키텍처 방향 (vNext)

핵심 루프:

1. `Sense`: 온체인/시장/뉴스/소셜 입력 수집
2. `Digest`: 품질 점수와 신뢰도 계산
3. `Desire`: hunger(신호/주의/신선도) 상태 갱신
4. `Quest`: 당일 추적할 스레드/가설 선택
5. `Decide`: post/quote/reply/image 행동 포트폴리오 결정
6. `Act`: 발행
7. `Reflect`: 반응/중복/비용/정확도 기반 정책 갱신

## 무엇을 유지하고, 무엇을 바꾸는가

유지:

- 비용/요청량 가드 (`src/services/x-api-budget.ts`)
- 안전 차단(법적/리스크/TOS) (`src/services/autonomy-governor.ts`)
- 숫자 왜곡 방지

변경:

- 과도한 하드 품질 차단 -> 소프트 점수 기반 선호
- 단일 템플릿 반복 -> 퀘스트/기분 기반 서사 변화
- 쿼터 중심 행동 -> 목표/욕망 중심 행동

## 실행

설치:

```bash
npm ci
```

로컬 안전 실행(권장):

```bash
TEST_MODE=true SCHEDULER_MODE=false npm run dev
```

24/7 실행:

```bash
TEST_MODE=false SCHEDULER_MODE=true DAILY_ACTIVITY_TARGET=20 DAILY_TARGET_TIMEZONE=Asia/Seoul npm run dev
```

빌드/테스트:

```bash
npm run build
npm test
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
```

## 현재 로드맵

상세는 `docs/plan.md`를 기준으로 합니다.

상위 단계:

1. Soul Architecture 기초 타입/메모리 추가
2. Desire + Quest + Mood 엔진 추가
3. 행동 선택기(Action policy) 재구성
4. 프롬프트/게이트를 캐릭터 중심으로 재설계
5. 관측성/회고 루프로 자동 개선
