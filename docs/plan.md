# Pixymon Evolution Plan

Last updated: 2026-02-17  
Owner branch: `feat/pixymon-next-iteration`

## 1. 목적

Pixymon을 단순 트윗 봇이 아니라, **온체인 데이터를 먹고 성장하는 캐릭터형 X(Twitter) 에이전트**로 고도화한다.

핵심 루프:

1. Feed: 온체인/시장/뉴스를 영양소로 수집
2. Digest: 신뢰도/신선도/일관성 점수화 후 XP 변환
3. Evolve: XP 누적에 따라 stage/ability/톤 변화
4. Act: 합의된 결과만 글/댓글 실행
5. Reflect: 반응/실패/비용 기반 정책 자동 보정

## 2. North Star & KPI

North Star:

- `온체인 이상 신호를 빠르고 정확하게 해석하는 진화형 캐릭터 에이전트`

운영 KPI:

1. `market_mismatch_reject_count` 발행 대비 0 유지
2. 중복률(`duplicate_rate`) < 5%
3. 트렌드 적합도(`trend_relevance_score`) > 75%
4. `fallback_rate`, `retry_count` 주차별 감소
5. `evolution_event` 주 단위 관측 + stage별 행동 차이 확인

## 3. 제품 원칙

1. 캐릭터 유지: 트렌드를 따라가도 Pixymon 세계관/톤을 잃지 않는다.
2. 숫자 우선: 앵커 불일치 시 무조건 발행 금지.
3. 안전 우선: 비평가(Skeptic) reject 시 실행 금지.
4. 측정 우선: 신규 기능은 메트릭 없이 배포하지 않는다.
5. 단계 우선: Phase gate 미통과 시 다음 Phase 진행 금지.

## 4. 통합 아키텍처 방향

기반 컨셉은 Pixymon 루프를 중심으로 두고, 아래 요소를 결합한다.

1. AIXBT 방향: Signal Graph, momentum score, cluster memory
2. GOAT 방향: 도구 라우팅(초기 read-only), 가드레일 기반 실행
3. Swarms 방향: Scout/Analyst/Skeptic/Voice/Executor 역할 분리

## 5. 5-Phase 로드맵

### Phase 1. Concept Core (2주)

목표:

- 영양소 표준 타입/ledger/ingestion 완성

수정 파일:

- `src/types/agent.ts`
- `src/services/memory.ts`
- `src/services/onchain-data.ts`
- `src/services/engagement/trend-context.ts`

산출물:

- `OnchainNutrient`, `DigestScore`, `EvolutionStage`, `AbilityUnlock`
- `nutrientLedger`, `xpGainBySource`, `evolutionHistory` 저장

Gate:

- nutrient 누락률 0%
- XP 계산 재현성 테스트 통과

### Phase 2. Evolution Engine (2주)

목표:

- stage별 말투/행동/리스크 모드 강제

수정 파일:

- `src/services/cognitive-engine.ts`
- `src/services/llm.ts`
- `src/services/engagement.ts`

산출물:

- stage별 prompt profile
- digest -> evolve 정책 적용

Gate:

- stage별 생성물 차이를 테스트로 판별 가능

### Phase 3. Swarms Council (2~3주)

목표:

- 단일 출력 대신 역할 분리 합의형 출력

수정 파일:

- `src/services/cognitive-engine.ts` (role orchestration)
- `src/services/engagement.ts`

산출물:

- Scout/Analyst/Skeptic/Voice/Executor 파이프라인
- critic reject rate 계측

Gate:

- 오류성 발행 사전 차단율 개선 확인

### Phase 4. GOAT-lite Tool Layer (2주)

목표:

- 온체인 툴 라우팅 도입 (read-only -> 시뮬레이션)

수정 파일:

- `src/services/*` (tool router, safety checks)

산출물:

- read-only tool calls
- 시뮬레이션 결과 기반 보조 추론

Gate:

- tool 실패시 안전 폴백 100%

### Phase 5. AIXBT-like Intelligence (3주)

목표:

- Signal Graph/momentum/cluster를 운영 루프에 통합

수정 파일:

- `src/services/observability.ts`
- 신규 graph/cluster 서비스 모듈

산출물:

- 내부 추론 API/터미널용 구조화 출력

Gate:

- baseline 대비 relevance/engagement 개선

## 6. 파일 기준 패치 순서

1. `src/types/agent.ts`
2. `src/services/memory.ts`
3. `src/services/onchain-data.ts`
4. `src/services/engagement/trend-context.ts`
5. `src/services/cognitive-engine.ts`
6. `src/services/llm.ts`
7. `src/services/engagement.ts`
8. `src/services/observability.ts`
9. `test/*`

## 7. 즉시 실행 스프린트 (이번 사이클)

범위:

1. Phase 1 전체
2. Phase 2 중 stage prompt/profile 분기까지

이번 스프린트 완료 기준:

1. 루프에 `feed -> digest -> evolve` 데이터 경로가 실제로 기록된다.
2. `nutrient_intake`, `xp_gain`, `evolution_event` 메트릭이 남는다.
3. `npm run build`, `npm test` 통과.

## 8. 운영 안전장치

1. 숫자 앵커 불일치: 즉시 reject
2. 신뢰도 임계치 미달 소스: 실행 후보 제외
3. critic reject 발생: 발행 중단 + fail reason 기록
4. canary 전략: 새 정책은 소량 실행 후 확대

## 9. 변경 관리 규칙

1. 각 Phase는 별도 브랜치/커밋 단위로 분리
2. Phase Gate 통과 로그를 `docs/plan.md` 하단에 이력으로 추가
3. KPI 임계치 악화 시 즉시 이전 정책으로 롤백
