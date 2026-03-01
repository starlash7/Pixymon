# Pixymon vNext Plan

Last updated: 2026-03-02  
Owner branch (docs): `docs/soul-architecture`

## 1. 문제 정의

현재 Pixymon은 아래 강점이 있다.

1. 숫자/근거 검증
2. 비용 가드
3. 중복 억제

하지만 사용자 체감은 아직 “분석 자동화 봇”에 가깝다.  
핵심 부족점은 `욕망`, `의도`, `서사 지속성`이다.

## 2. 목표 상태

Pixymon을 다음 상태로 전환한다.

1. 데이터 기반 정확성 유지
2. 캐릭터의 욕망/기분/퀘스트 기반 행동
3. post/reply/quote/image가 하나의 서사로 연결
4. 운영 가드레일은 유지하되 창의성 차단은 최소화

## 3. 설계 원칙

1. Safety rails와 Creativity rails를 분리한다.
2. “무엇을 하지 말라”보다 “무엇을 갈망하는가”를 우선한다.
3. 단일 발화 품질보다 연속 서사 품질을 최적화한다.
4. 하드 블록은 비용/법적/고위험에만 한정한다.
5. 나머지는 점수 기반 우선순위로 완화한다.

## 4. 핵심 루프 (vNext)

1. `Sense`: 온체인/시장/뉴스/소셜 수집
2. `Digest`: 신뢰도/신선도/일관성 점수화
3. `Desire`: hunger 상태 갱신
4. `Quest`: 하루 목표 스레드 선택
5. `Decide`: 행동 포트폴리오 선택
6. `Act`: post/quote/reply/image 실행
7. `Reflect`: 반응/중복/비용/정확도 기반 보정

## 5. 코드 태스크 (우선순위 순)

### T01. Soul 타입 추가

- 파일: `src/types/agent.ts`
- 작업:
  - `DesireState`
  - `MoodState`
  - `QuestThread`
  - `StyleProfile`

### T02. 메모리 영속화 확장

- 파일: `src/services/memory.ts`
- 작업:
  - desire/mood/quest/style 저장 구조 추가
  - 조회/업데이트 API 추가

### T03. Desire 엔진 추가

- 파일: `src/services/desire-engine.ts` (new)
- 작업:
  - novelty/attention/conviction hunger 계산
  - recent performance 기반 hunger decay/gain

### T04. Mood 엔진 추가

- 파일: `src/services/mood-engine.ts` (new)
- 작업:
  - market condition + quest outcome 기반 mood 전이

### T05. Quest 플래너 추가

- 파일: `src/services/quest-planner.ts` (new)
- 작업:
  - 하루 1~3개 퀘스트 선정
  - 퀘스트 진행/완료/폐기 규칙

### T06. Action 정책기 추가

- 파일: `src/services/action-policy.ts` (new)
- 작업:
  - post/quote/reply/image 비율 결정
  - 쿼터 기반이 아닌 욕망/퀘스트 기반 선택

### T07. 루프 재배선

- 파일: `src/services/engagement.ts`
- 작업:
  - `sense -> digest -> desire -> quest -> decide -> act -> reflect`

### T08. 프롬프트 재설계

- 파일: `src/services/llm.ts`
- 작업:
  - 금지형 규칙 축소
  - 캐릭터 목표/욕망/놀이 중심 instruction 강화

### T09. 품질 게이트 소프트화

- 파일: `src/services/engagement/quality.ts`
- 작업:
  - 일부 hard reject -> score penalty 전환
  - 다양성/신선도 점수 합산

### T10. Governor 역할 축소

- 파일: `src/services/autonomy-governor.ts`
- 작업:
  - 운영 리스크(비용/TOS/법적) 중심 block만 유지
  - 창의성 관련 block 제거

### T11. event-evidence 계약 차등화

- 파일: `src/services/engagement/event-evidence.ts`
- 작업:
  - 분석 lane 엄격
  - 캐릭터/서사 lane 완화

### T12. Reflection 엔진 추가

- 파일: `src/services/reflection-engine.ts` (new)
- 작업:
  - duplicate/fallback/engagement 지표 기반 정책 업데이트

### T13. 관측성 확장

- 파일: `src/services/observability.ts`
- 작업:
  - `quest_completion_rate`
  - `style_entropy`
  - `novelty_debt`

### T14. Runtime 플래그 추가

- 파일:
  - `src/types/runtime.ts`
  - `src/config/runtime.ts`
- 작업:
  - `SOUL_MODE`
  - `SOFT_GATE_MODE`
  - `QUEST_MODE`

## 6. 실행 순서 (PR 단위)

1. PR-A: T01, T02, T14
2. PR-B: T03, T04, T05
3. PR-C: T06, T07
4. PR-D: T08, T09, T11
5. PR-E: T10, T12, T13

## 7. 단계 게이트

PR-A 통과 조건:

1. 빌드 통과
2. 메모리 역직렬화 하위호환 유지

PR-B 통과 조건:

1. desire/mood/quest 상태가 메모리에 기록
2. 단위 테스트 추가

PR-C 통과 조건:

1. 루프가 새 단계 순서로 실행
2. 행동 선택 로그에서 이유(reason) 출력

PR-D 통과 조건:

1. 반복 템플릿 감소 지표 개선
2. 캐릭터 톤 다양성 증가

PR-E 통과 조건:

1. 비용 가드 안정
2. 퀘스트 완료율/신선도 지표 관측 가능

## 8. KPI

1. Duplicate rate < 8%
2. BTC-only framing rate < 40%
3. Quest completion rate > 60%
4. Fallback rate 주차별 감소
5. Read/Create 비용 상한 준수

## 9. 운영 정책

유지:

1. 비용 상한
2. 법적/리스크 차단
3. 숫자 왜곡 금지

완화:

1. 표현 규칙 과다 차단
2. 서사적 실험 차단

## 10. 이번 턴 범위

문서 정리만 완료했다.  
다음 턴부터 PR-A(T01/T02/T14) 코드 패치를 시작한다.
