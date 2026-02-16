# AGENTS.md

이 저장소에서 작업하는 모든 에이전트/워크스페이스는 아래 규칙을 기본값으로 따른다.

## 1) Source of Truth

1. 본 파일(`AGENTS.md`)
2. `docs/agent-workflow.md`
3. 기타 보조 문서

규칙이 충돌하면 위 순서를 우선한다.

## 2) Branch Rules (Default)

1. 모든 작업은 `origin/main` 기준 새 브랜치에서 시작한다.
2. 각 워크스페이스는 자기 브랜치만 push 한다.
3. `main` 반영은 통합 담당 워크스페이스 1개만 수행한다.
4. 워크스페이스 간 전달은 패치보다 커밋 SHA를 우선한다.
5. `main` 반영이 끝난 작업 브랜치는 삭제한다.

작업 브랜치 시작 예시:

```bash
git fetch origin
git switch -c feat/<task> origin/main
```

## 3) Integration Rules (Main)

통합 담당 워크스페이스만 아래를 수행한다.

```bash
git fetch origin
git switch main
git pull --ff-only origin main
git cherry-pick <sha1> <sha2> ...
npm run build
git push origin main
```

- `main` 반영 전 최소 `npm run build` 통과 필수
- 충돌 시 해결 커밋 메시지에 `merge:` 또는 `reconcile:` 접두사 권장

## 4) Workspace Lifecycle

1. `+`로 워크스페이스 생성
2. 브랜치 생성 후 작업/검증/커밋
3. 원격 push 후 SHA 전달
4. 통합 후 워크스페이스 종료(`Done` 또는 닫기)

주의: `.context`는 워크스페이스별로 분리되므로 공용 전달 채널로 쓰지 않는다.

## 5) Current Project Runtime Notes

- 현재 엔트리포인트(`src/index.ts`)는 대화형 인게이지먼트 중심이다.
- 브리핑 자동 포스팅은 엔트리포인트에서 비활성화 상태다.
- 환경/실행/구조 최신 정보는 `README.md`를 기준으로 한다.

## 6) Quick Checklist

- [ ] `origin/main` 기준 새 브랜치에서 시작했는가
- [ ] 내 브랜치에만 push 했는가
- [ ] `main` 반영은 통합 담당만 수행했는가
- [ ] 빌드를 통과했는가
- [ ] 머지 완료 브랜치를 삭제했는가
