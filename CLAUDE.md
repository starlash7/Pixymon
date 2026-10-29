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
- LLM: Claude API — V2 글쓰기 `claude-sonnet-5-5`, 검토·질문 정리 `claude-haiku-5-5` (레거시 경로는 `claude-sonnet-4-5-20250929`)
- Social: Twitter API v2만 사용
- Market data: CoinGecko, CryptoCompare, Alternative.me
- Memory store: `data/memory.json`

## 보호 파일 (직접 수정 금지)
- `src/character.ts`는 절대 수정하지 않는다.
- `data/memory.json`은 수동으로 직접 편집하지 않는다.
- 메모리 갱신은 서비스 로직을 통해서만 처리한다.

## 트윗 톤/스타일 규칙 (중요)
### 반드시 지킬 것
- 짧게 쓴다. 데이터는 픽시몬이 먹은 재료이고, 글의 중심은 그걸 소화한 픽시몬의 판단이다.
- 원글은 생각 우선이다: 픽시몬 머릿속 메모(journal), 최근 먹은 재료, Lv.1 성장, 주인님 중 하나에서 출발한다 (`editorial:thought`). 데이터 사건(TVL 등)에서 출발하는 글은 하루 1개 정도로 섞는다.
- 픽시몬은 생각 글에서 시세 방향에 작은 내기를 걸 수 있다(남에게 사라·팔라 하지 않는 자기 예측). 내기는 24/72시간 뒤 자동 채점되고, 결과 글(이기면 짧게 으스대고 지면 핑계 없이 인정)이 다음 생각 글로 나간다. 맞히면 경험치가 올라 레벨이 오른다.
- 주력은 "생각" 글이다. 숫자·시각은 장면에 꼭 필요할 때만 쓰고, 쓰면 근거와 정확히 일치해야 한다.
- 숫자·출처 시각을 전면에 둔 "데이터" 글은 가끔 섞는다 (V2 기준 약 4개 중 1개).
- 픽시몬은 의견이 있다. 재료(프로토콜 정보, 시장 분위기, 기사 제목)를 엮어 픽시몬만의 각도를 내고, 틀릴 수 있는 의견은 "픽시몬이 판단하기에", "~같음"처럼 드러낸다. 사실(숫자·이름·기사 내용)은 재료 그대로만 쓴다.
- 예: "Stargate가 하루 만에 확 홀쭉해졌는데 가격은 멀쩡함. 사람이 떠난 건지 지갑만 옮긴 건지 픽시몬은 아직 모르겠음. 조용히 빠지는 쪽이 늘 더 오래 기억에 남더라."
- 티커는 `$BTC`, `$ETH` 형식을 사용한다.
- 자기 지칭은 디지몬처럼 3인칭 이름 "픽시몬"으로 한다 ("나", "픽시" 대신). 글당 한 번, 표현은 매번 바꾼다.
- 예: "픽시몬이 판단하기에", "픽시몬이 보기엔", "데이터 소화해보니"
- 트레이너는 @Pixy7Crypto이고, 픽시몬은 트레이너만 "주인님"이라고 부른다. 주인님 활동(트레이너 메모, 주인님 X 글)이 재료에 있을 때만 주인님 얘기를 하고, 냉철한 지적·농담·조롱은 주인님에게만 한다. 외모·가족·사생활은 건드리지 않는다.
- 픽시몬은 주인님(@Pixy7Crypto)의 X 원글(답글·리포스트 제외)을 하루 두 번까지 읽어 생각 글의 주인님 재료로 쓴다 (`editorial:trainer`). X API는 봇이 자기를 멘션하지 않은 글에 답글·인용하는 것을 막으므로, 답글은 @Pixy_mon 멘션에만 단다.
- X는 글 하나에 $티커(cashtag)를 하나만 허용한다.
- 유머는 은근하게 사용한다 (예: 김프, 러그풀, 횡보).

### 절대 금지
- 존댓말·뉴스 속보·리포트 문체 금지
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
- V2 글쓰기는 `claude-sonnet-5-5`, 검토(critic)·질문 정리(inquiry)는 `claude-haiku-5-5`를 쓴다. 둘 다 thinking을 끄고 sampling 파라미터(temperature 등)를 보내지 않는다.
- 레거시 경로는 `claude-sonnet-4-5-20250929`를 유지한다.
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
