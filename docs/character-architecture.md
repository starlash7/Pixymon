# Character Architecture

## V2 목표 구조와 현재 계약

`근거 → 질문·가설 → 편집 판단 → 기억을 참고한 글 → 사람 승인 → 게시 → 재관측·판정 수정`

- `EvidenceCardV2`: 대상, 원시 수치, 출처와 시각을 보존한다. 첫 범위는 protocol이며, 파생 선별 자료를 직접 사실처럼 쓰지 않는다.
- `EditorialCaseV2` / planner: 선택한 근거로 답할 수 있는 질문과 제한된 수치 가설을 만든다. 가설은 동일 지표의 기계 판독 가능한 반증 조건과 연결한다. USD TVL의 지속 여부를 유입·채택·인과의 증거로 확대하지 않는다.
- writer: 안정된 신념과 관련된 이전 판단 하나를 참고하고, 선택된 사실 안에서 관점을 쓴다. `sceneBase` / `sceneTilt`나 필수 캐릭터 문구는 사용하지 않는다. 검증 실패 시 한 번만 재생성하고 다시 실패하면 `no-post`다.
- review / publish: 사람 승인과 R0–R2를 통과한 R3 권한을 각각 확인한다. 실제 live 게시가 성공해야 캐릭터 기억을 변경한다.
- follow-up: 24시간에 의미 있는 변화가 있으면 Revisit 후보를 만들고, 72시간에 판정을 닫는다. 가설 없는 관찰은 임의로 지지 판정하지 않는다.
- shadow: 별도 비게시 ledger에서 같은 재관측 과정을 연습한다. 이전 shadow 판단은 명시적으로 구분하며 live 경험으로 전달하지 않는다.

현재 V2는 검증 중이며 자동 게시를 열지 않는다. 실제 평가 결과와 운영 제약은 [운영 계획](plan.md)과 [V2 runbook](editorial-v2-runbook.md)을 따른다.

## V1 보존 경로

아래는 기본값 `POST_PIPELINE_VERSION=v1`의 기존 구조다. V2 live 20개와 14일 무사고가 확인되기 전에는 삭제하지 않으며, V2 표현 규칙의 기준으로 사용하지 않는다.

### Layers

1. `Canon`
   - `SOUL.md`
   - `MEMORY.md`
   - `DREAMS.md`
   - `ENEMIES.md`
   - `RITUALS.md`
   - `SOCIAL.md`

2. `Memory Intent`
   - 현재 욕구, 집착, 원한, 연속성
   - canon line을 lane별로 뽑아서 planner/writer로 넘김

3. `Planner`
   - `focus`
   - `sceneBase`
   - `sceneTilt`
   - `eventStrength`
   를 고른다

4. `Writer`
   - planner가 고른 장면을 표면 문장으로만 렌더링한다
   - 장면 선택은 직접 하지 않는다

5. `Evaluation`
   - duplicate
   - malformed tail
   - hot base concentration
   - quality gate

6. `Publish`
   - local preview
   - observe
   - paper
   - live

### Legacy Design Rule

- 회귀를 줄이려면 새로운 감각을 writer에 덧대는 것보다 canon과 planner 계약을 먼저 수정한다.
- 반복이 남으면 writer 문장군보다 planner의 `sceneBase` 분포를 먼저 본다.
