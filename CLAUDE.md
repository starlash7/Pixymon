# Pixymon 개발 규칙

## 문서 범위
- 워크스페이스/브랜치 운영 규칙의 최상위 기준은 `AGENTS.md`다.
- 이 파일은 Pixymon 코드 작성 규칙과 프로젝트 특화 컨벤션을 담는다.
- 실행/환경/구조의 최신 사용자 문서는 `README.md`를 기준으로 하며, 작업 중 README를 임의로 덮어쓰지 않는다.

## 프로젝트 정체성
- Pixymon은 온체인 데이터를 먹고 성장하는 크립토 AI 트위터 봇이다.
- 계정: `@Pixy_mon`
- 현재 콘셉트 단계: `Lv.1`
- 말투 원칙: 일반적인 AI 비서처럼 보이지 않고, 캐릭터처럼 말해야 한다.

## 기술 스택 및 연동
- Runtime: Node.js + TypeScript
- LLM: Claude API `claude-sonnet-4-5-20250929`
- Social: Twitter API v2만 사용
- Market data: CoinGecko, CryptoCompare, Alternative.me
- Memory store: `data/memory.json`

## 보호 파일 (직접 수정 금지)
- `src/character.ts`는 절대 수정하지 않는다.
- `data/memory.json`은 수동으로 직접 편집하지 않는다.
- 메모리 갱신은 서비스 로직을 통해서만 처리한다.

## 트윗 톤/스타일 규칙 (중요)
### 반드시 지킬 것
- 짧고 숫자/데이터 기반으로 작성한다.
- 티커는 `$BTC`, `$ETH` 형식을 사용한다.
- 자기 언급 표현을 자연스럽게 포함한다.
- 예: "픽시가 봤을 때", "데이터 소화해보니"
- 유머는 은근하게 사용한다 (예: 김프, 러그풀, 횡보).

### 절대 금지
- 해시태그 금지
- 이모지 금지
- 투자 조언 톤 금지
- 과도한 확신 표현 금지 (예: "100% 오른다")

## 핵심 기능
1. 온체인/뉴스/소셜 신호 수집 및 narrative digest
2. `@Pixy_mon` 멘션 응답
3. 트렌드 글, 인용, 댓글 후보 생성 및 품질 게이트
4. 트윗/코인/팔로워 상호작용 메모리 누적
5. 비용/쿼터/락/2단계 발행 가드 기반 자율 루프

## TypeScript/안정성 규칙
- 외부 API 호출은 항상 `try/catch`로 감싼다.
- 재시도 로직은 기본 3회로 구현한다.
- Rate limit(`429`)를 명시적으로 처리한다.
- 실패는 모두 구조화된 로그로 남긴다.
- 프로덕션 경로에 `console.log`를 남기지 않는다.
- 가능한 한 `any` 사용을 피하고 타입을 명시한다.

## API 사용 규칙
### Claude API
- 모델은 `claude-sonnet-4-5-20250929`를 사용한다.
- system prompt는 `character.ts`에서 가져온다.
- 프롬프트에 출력 제약을 명시한다.
- 길이 제한 준수
- 해시태그 금지
- 이모지 금지

### Twitter API
- Twitter API v2만 사용한다 (v1 금지).
- 포스팅/응답 흐름에 에러 처리와 재시도를 포함한다.

## 실행 플래그
- `SCHEDULER_MODE=true`: 스케줄러 루프 실행
- `TEST_MODE=true`: 실제 트윗 발행 비활성화
- `TEST_NO_EXTERNAL_CALLS=true`: 테스트 모드에서 외부 API 호출 차단
- `ACTION_MODE=observe|paper|live`: 관찰/모의/실발행 경로 선택
- `ALLOW_FALLBACK_AUTO_PUBLISH=false`: fallback 글 자동 발행 차단 기본값

## 폴더 구조
- `src/index.ts`: 부트스트랩, 안전 훅, 런타임 락, 모드 선택
- `src/config/`: 환경 변수 파싱과 런타임 기본값
- `src/services/`: X/Twitter, LLM, 메모리, 관측성, 예산, narrative 루프
- `src/services/engagement/`: 인게이지먼트 품질, 근거, 텍스트 마무리 보조 모듈
- `src/types/`: 공유 타입
- `src/utils/`: 범용 유틸리티
- `scripts/`: 샘플 생성, 감사 리포트, preflight 점검
- `test/`: Node test runner 기반 단위/회귀 테스트

## 표준 워크플로우
### 글 생성/발행
1. 마켓 데이터 수집
2. 이벤트/근거 플랜 생성
3. Claude로 Pixymon 톤의 후보 생성 (`character.ts` prompt 사용)
4. 품질/중복/fallback 발행 게이트 검사
5. `ACTION_MODE`와 X API budget에 따라 발행 또는 관찰 기록
6. 메모리와 관측 이벤트 업데이트

### 멘션 응답
1. 멘션 수집
2. 언어 감지 (KR/EN)
3. 팔로워 상호작용 컨텍스트 로드
4. 답변 생성
5. 응답 발행

## 장애 점검 체크리스트
### 트윗이 발행되지 않을 때
1. `TEST_MODE=false` 확인
2. Twitter credentials 확인
3. rate limit 상태 확인
4. `data/memory.json` 쓰기 권한 확인

### Claude 응답 톤이 어긋날 때
1. `character.ts`의 personality prompt 확인
2. Anthropic API key 유효성 확인
3. 프롬프트 토큰 수/제약 조건 확인

### 메모리 누적이 안 될 때
1. `data/memory.json` 존재 여부 확인
2. 파일 쓰기 권한 확인
3. JSON read/write 파싱 경로 확인
