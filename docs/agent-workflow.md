# Agent Workspace Workflow

이 문서는 Conductor에서 여러 워크스페이스/에이전트를 병렬로 돌릴 때의 기본 운영 규칙을 정의한다.

## Core Rules

1. 각 작업은 `origin/main` 기준 새 브랜치에서 시작한다.
2. 각 워크스페이스는 자기 브랜치에만 push 한다.
3. `main` 반영은 통합 담당 워크스페이스 1개만 수행한다.
4. 통합은 `merge` 또는 `cherry-pick`(커밋 SHA 기준)으로 진행한다.
5. `main` 반영 전마다 빌드/테스트를 실행한다.
6. `main` 반영이 끝난 작업 브랜치는 삭제한다.

## Branch Strategy

브랜치 네이밍 예시:

- `feat/modularize-index`
- `feat/onchain-signals`
- `fix/mention-cursor`
- `chore/build-check`

작업 시작:

```bash
git fetch origin
git switch -c feat/<task> origin/main
```

작업 브랜치 푸시:

```bash
git push -u origin feat/<task>
```

## Integration Workspace (Single Owner)

통합 담당 워크스페이스만 아래를 수행한다.

1. 각 작업 워크스페이스에서 커밋 SHA를 받는다.
2. 통합 워크스페이스에서 순서대로 반영한다.

`cherry-pick` 방식:

```bash
git fetch origin
git switch main
git pull --ff-only origin main
git cherry-pick <sha1> <sha2> ...
npm run build
# 필요 시 테스트
# npm test
git push origin main
```

`merge` 방식:

```bash
git fetch origin
git switch main
git pull --ff-only origin main
git merge --no-ff origin/feat/<task>
npm run build
git push origin main
```

## Workspace Lifecycle In Conductor

### 1) 새 작업 시작

1. Conductor에서 `+` 로 새 워크스페이스 생성
2. 작업 브랜치 체크아웃 (`origin/main` 기반)
3. 구현/검증 후 커밋
4. 원격에 push
5. 통합 담당에게 커밋 SHA 전달

### 2) 작업 종료

- 해당 워크스페이스에서 더 할 일이 없으면 `Done` 처리
- 브랜치는 통합 완료 후 삭제 (즉시 삭제 또는 배치 정리)

## Handoff Rules

1. 워크스페이스 간 전달은 패치 파일보다 커밋 SHA를 우선한다.
2. `.context`는 워크스페이스별로 분리되므로, 공용 전달이 필요하면 리포 파일 또는 공용 경로를 사용한다.
3. 충돌 가능성이 큰 파일(`src/index.ts` 등)은 동일 시간대 병렬 수정을 피한다.

## Cleanup

`main` 반영이 끝난 브랜치 정리:

```bash
git push origin --delete feat/<task>
```

로컬 브랜치 정리:

```bash
git branch -d feat/<task>
```

## Quick Checklist

- [ ] `origin/main` 기준 새 브랜치에서 시작했는가
- [ ] 내 워크스페이스는 내 브랜치만 push 했는가
- [ ] 통합 담당 워크스페이스만 `main`을 갱신했는가
- [ ] `main` 반영 전 빌드/테스트를 통과했는가
- [ ] 완료 브랜치를 삭제했는가
