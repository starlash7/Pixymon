# Character Architecture

Pixymon의 캐릭터 엔진은 문장 생성기보다 `정전 -> planner -> writer -> publish` 계약을 우선한다.

## Layers

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

## Design Rule

- 회귀를 줄이려면 새로운 감각을 writer에 덧대는 것보다 canon과 planner 계약을 먼저 수정한다.
- 반복이 남으면 writer 문장군보다 planner의 `sceneBase` 분포를 먼저 본다.
