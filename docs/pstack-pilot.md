# Minimal pstack pilot (Conductor Claude / Codex)

Project-local instructions adapted from Lauren Tan's pstack, not a plugin install.
Read this file explicitly in Conductor; AGENTS.md and CLAUDE.md link here so the
workflow does not depend on slash-command discovery. Keep the current model.
Source and MIT notice: [pstack upstream](references/pstack-upstream.md).

## Execution contract

1. Inspect branch, SHA, diff and repository instructions first. Preserve existing
   work in an isolated branch/checkout based on freshly checked origin/main.
   Declare HOLD SCOPE. Read only relevant source and documentation; no secrets or
   session transcripts. Record any unavailable reproduction evidence.
2. Trace the failing path. Distinguish a prompt instruction from a runtime guard.
   Turn the smallest documented failure into a failing regression before editing
   production code. If original inputs are unavailable, label it a derived offline
   regression, never an exact model replay. Include valid judgment/hedge contrasts.
3. Capture the failing command, exit code and assertion. Patch only the mechanism
   the evidence supports; rerun the same check. Do not add a word blacklist or
   duplicate existing writer instructions. A deterministic guard and semantic
   model quality are separate claims.
4. Give one fresh reviewer the diff, intended behavior and reproduction command.
   Use a separate agent when available; otherwise use a separate Conductor chat.
   Report the actual model and whether it is the same model. Reviewer reads the
   code and tests, probes a counterexample, and reports severity/location/evidence.
   Fix accepted findings and rerun affected checks. No reviewer available means
   an explicit pending independent review, not a claimed pass.
5. Run `npm run verify` in full, preserving package.json's observe/test/no-external
   flags and isolated paths. Record command, exit code, test/eval counts, review
   result, branch/SHA/diff, remaining limits and exact reproduction provenance.
   Stop here: no paid API calls, X posts, live runs, deployment, push, PR or merge.

For the documented memory failure, run the focused check with the same isolation:

```sh
ACTION_MODE=observe TEST_MODE=true TEST_NO_EXTERNAL_CALLS=true \
PIXYMON_DATA_DIR=.test-data PIXYMON_PAPER_DATA_DIR=.test-data/paper \
MEMORY_DATA_PATH=.test-data/memory.json \
NARRATIVE_AUDIT_LOG_PATH=.test-data/narrative-observation.ndjson \
NARRATIVE_AUDIT_SUMMARY_PATH=.test-data/narrative-phrase-audit.json \
OBSERVABILITY_EVENT_LOG_PATH=.test-data/metrics-events.ndjson \
node --import tsx --test --test-concurrency=1 \
test/editorial-v2-scope-critic.test.ts test/editorial-v2-evolution.test.ts
npm run verify
```

## Gotchas and evidence boundary

- docs/plan.md §22 describes a real shadow draft experiment, with assumed 72h
  outcomes. The original request, draft and raw critic response are unavailable.
  The new fixtures derive from that documented case using synthetic records.
- evolution.ts already simplifies outcome labels and tells the writer to evaluate
  its judgment. Those mitigations cannot constrain a critic's mistaken pass.
- The pilot adds a bounded subject-particle/affirmative-predicate guard to critic
  and evolution writer validation. It catches direct grading of 급감/급증/하락/
  상승/감소/증가; it is not Korean semantic parsing or a guarantee for paraphrases.
  No improved model accuracy is demonstrated by mocked model responses.
- A critic pass cannot clear `memory-outcome-target`; other outcome mismatches,
  quoted assertions and novel paraphrases remain the semantic critic's job.
- A local clone/branch is not a registered Conductor workspace. Register/open it
  yourself through Conductor before claiming workspace lifecycle integration.

Minimal Conductor prompt (either Claude or Codex):

> Read AGENTS.md, CLAUDE.md and docs/pstack-pilot.md. HOLD SCOPE. Investigate the
> docs/plan.md §22 memory critic mistake offline: show a failing regression before
> the minimum fix, test valid judgments/hedges, obtain one independent review,
> run npm run verify and hand off command evidence plus branch/SHA/diff. Keep the
> current model; no paid API, live run, X post, push, PR, merge or deployment.
