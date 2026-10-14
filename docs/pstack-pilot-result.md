# pstack pilot evidence — 2026-10-12

HOLD SCOPE. Branch `fix/pstack-memory-scope`, base/HEAD
`aa8cfe061b2fa9672ea8522ed24dea32f07763a7`; changes are uncommitted.

## Provenance and preservation

Two local clones point to starlash7/Pixymon. The requested editorial-v2 sources
were in `conductor/workspaces/pixymon-v1/athens` (clean, aa8cfe0), while its parent
`conductor/repos/pixymon-v1` was clean at fadcb01. The older `repos/pixymon` was
clean at 05ce054 and lacked the requested files. None was edited.

Created a separate local clone in the approved writable task directory with
`git clone --no-hardlinks .../conductor/repos/pixymon-v1 pixymon-pstack`.
Set this clone's origin to the same public GitHub repository. Initial sandbox
fetch failed DNS resolution; authorized escalated `git fetch origin` succeeded.
`git switch -c fix/pstack-memory-scope origin/main` then `git merge --ff-only
origin/main` advanced the isolated branch to freshly fetched aa8cfe0. No original
branch moved. This checkout is not registered with Conductor.

Copied existing athens/node_modules into the isolated checkout (no dependency
install or lockfile changes). Node v24.14.0, npm 11.9.0. Read repository instructions
and relevant .agents skill; no secret values, session transcripts, private logs,
credentials or security settings were read or changed.

## Failure and containment

Fixture: **offline regression derived from docs/plan.md §22**, not exact replay.
The documented experiment had real shadow drafts and assumed 72h outcomes.
Original model request/draft/raw critic output were unavailable; no new model
request was made. Existing synthetic closed records supply assumed outcomes.

The writer already has plain outcome labels and the market/judgment distinction
in evolution.ts. The critic prompt lacked that distinction, and a critic pass
could authorize the wrong text. New tests demonstrate that mechanism using a
controlled passing critic, not an accuracy evaluation of a live model.

Changes: scope-critic.ts gains a bounded grammatical outcome-target guard and
explicit critic contrast; writer.ts applies the guard during evolution contract
validation even without a critic. Guard failures cannot be cleared by critic
pass. Existing one-retry path corrects the text or blocks after two attempts.
evolution.ts remains unchanged. Both critic and writer paths are covered.

## Commands and results

| Command | Result |
| --- | --- |
| `ACTION_MODE=observe TEST_MODE=true TEST_NO_EXTERNAL_CALLS=true npm run test:unit` baseline | exit 0, 620/620 |
| `npm run test:unit -- --test-name-pattern=memory` before production fix | exit 1, 623 tests / 621 pass / 2 fail; this Node invocation ran the full suite despite trailing name argument |
| `npm run test:unit` after first fix | exit 0, 624/624 |
| `npm run verify` first full run | exit 0, build + scripts typecheck + 624 tests + 64 offline cases + 100 synthetic corpus candidates |
| focused command in `docs/pstack-pilot.md`, after reviewer contrast additions and before correction | exit 1, 18/19; `fail !== pass` on direct question |
| same focused command after correction | exit 0, 19/19 |
| `npm run verify` final after reviewer correction | exit 0, build + scripts typecheck + 624/624 tests + 64/64 offline cases + 100 synthetic corpus candidates; corpus gates PASS |
| `git diff --check` | exit 0 |

Original failure assertions: `'pass' !== 'fail'` for the documented wrong text,
and `1 !== 2` because writer accepted it instead of retrying. No-critic writer
blocking and paired legitimate judgments, negation, hedges, questions and quoted
corrections are asserted in the resulting green suite.

Independent review: one fresh same-model agent, not a different-model review.
Initial P2 caught question/quoted-period false positives; reproduced, fixed and
re-reviewed. Final review PASS, independent focused 19/19 and five direct probes
passed, no remaining blocking findings. Double-quoted assertions are explicitly
left to semantic critic.

## Deliverables and limits

Code/tests: scope-critic.ts, writer.ts, editorial-v2-scope-critic.test.ts,
editorial-v2-evolution.test.ts. Instructions: AGENTS.md, CLAUDE.md,
docs/agent-workflow.md, docs/pstack-pilot.md. Attribution: full upstream Lauren Tan
MIT notice in docs/references/pstack-upstream.md. AGENTS/workflow completion gates
now require full npm run verify, not build only.

Sibling `pixymon-pstack-evidence/` contains baseline.log, red.log, green.log,
reviewer-red.log, focused-green.log, verify.log, review.md and red-tests.patch.

No paid model/API calls, X publication, live runtime, deployment, push, PR or main
merge. Observe/test/no-external flags and isolated paths remain unchanged.
Verification tests exercise mocked live callbacks; those are not live execution.
The guard is deterministic containment for bounded direct predicate syntax;
quoted assertions, novel words/grammar and broader outcome mismatches still
require semantic critic. No measured model accuracy improvement is claimed.
The workflow itself has not been evaluated by a live Claude-versus-Codex task
benchmark; this pilot demonstrates local execution and independent review only.

Conductor usage: select/add this local checkout as your project/workspace using
Conductor's normal setup, then give Claude or Codex the minimal prompt at the end
of docs/pstack-pilot.md. The instructions can also be read explicitly in an
existing authorized isolated Pixymon checkout after transferring this diff.
