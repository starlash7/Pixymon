# P0 Humanization Gates Report (2026-03-02)

## Scope
- Control-tag 유출 제거 (`철학 메모:`, `메타 회고:` 등 라벨형 문구가 본문에 직접 노출되는 문제)
- `생명체` 반복 정체성 문구 제거 및 self narrative 자연어화
- 게시글 구조 하드 게이트 추가: `행동(Action) + 반증(Invalidation)` 둘 다 없으면 품질 게이트 실패
- TEST-LOCAL 경로 포함 fallback 생성 문장 자연어화

## Code Changes
- `src/services/engagement/quality.ts`
  - `stripNarrativeControlTags` 추가
  - `validateActionAndInvalidation` 추가
  - `enforceActionAndInvalidation` 추가
  - `evaluatePostQuality`에 action/invalidation 검증 훅 추가
  - `stable` 오탐(일반 형용사)으로 인한 `stable-flow` 과검출 완화 (`stablecoin` 중심)
- `src/services/engagement/types.ts`
  - `PostQualityContext`에 `language`, `requireActionAndInvalidation` 필드 추가
- `src/services/engagement.ts`
  - LLM/로컬/fallback 후보 모두 control-tag 정리 및 action/invalidation 보정 적용
  - post quality 호출부에 하드 게이트 컨텍스트 전달
  - preview 후보도 동일 게이트 적용
  - fallback prelude 단순화(문장 왜곡/중복 유발 제거)
  - 길이 제한 시 단어 경계 truncate 적용
- `src/services/engagement/event-evidence.ts`
  - deterministic fallback 문장 전면 재작성(라벨 제거, action+invalidation 포함)
- `src/services/engagement/trend-context.ts`
  - 로컬 테마 headline 라벨형 프리픽스 제거
- `src/services/memory.ts`
  - `nextSelfNarrative`의 `생명체` 문구 제거
  - lane별 문장 풀을 자연어 중심으로 재작성
- `src/services/narrative-os.ts`
  - KO 오프닝 문구를 라벨형 표현에서 자연어 시작문으로 조정
- `test/quality.test.ts`
  - control-tag 제거, action/invalidation 게이트, 보정 함수 테스트 추가

## Validation
- Build: `npm run build` 통과
- Unit tests: `npm test` 통과 (`48/48`)
- Local smoke (no external calls):
  - 실행 환경: `TEST_MODE=true`, `TEST_NO_EXTERNAL_CALLS=true`
  - 확인 포인트:
    - 라벨형 제어 태그 미노출
    - action/invalidation 누락 시 자동 보정 또는 게이트 실패
    - fallback 경로에서도 동일 정책 유지

## Observed Improvement
- 기존: 라벨형 문장 시작 + 동일 구조 반복 + 정체성 문구(`생명체`) 반복
- 현재: 자연어 서사 문장으로 시작, action/invalidation 구조 강제, 반복 패턴 일부 감소

## Remaining Risks
- 기존 메모리 데이터가 이미 유사한 문장을 다수 포함하면 `novelty`/`blocked-phrase` 게이트로 생성 실패율이 일시적으로 높을 수 있음
- action/invalidation 보정 문구는 여전히 구조적으로 반복될 수 있어, 다음 단계에서 더 큰 표현 다양성(템플릿 확장 + semantic paraphrase)이 필요
