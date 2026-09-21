# Jev editorial decisions — HOLD SCOPE

These are operator-invoked experiments, **not a new writer, auto-approval system,
or production quality gate**. Jev can now select relevant recorded experience
before inquiry/writing in isolated shadow collection. The existing advisory
command independently reviews a finished draft. Neither path can authorize X writes.

## Pre-writing memory selection

The previous path always recalled the latest same-subject judgment. That misses
an older failed test that may matter more to the present question. The new opt-in
path is connected to `collectEditorialDraftV2`, not just a report beside it:

1. Existing hard evidence, freshness, novelty and due-Revisit gates choose the fact.
2. Code retrieves at most six recent distinct judgment threads for the same
   provider, stable subject identity and original measurement. Unposted live
   candidates, different provenance and future records/outcomes are excluded.
   A final 72h outcome takes precedence over late bookkeeping for a missed 24h check.
3. One Jev Choice selects a record, `none` or `unclear`, against the planned
   measurement question. Jev cannot invent experience, alter facts or execute tools.
4. A selected record is copied into the inquiry model and then the writer. The
   inquiry model authors the lesson and may select a different bounded test for
   the **new** hypothesis. Historical falsifiers remain unchanged.
5. Low confidence/probability or `unclear` means **no prior record is supplied**;
   this is logged, not interpreted as “there is no history.” API/contract/quota/audit
   failures instead stop the candidate at `memory/no-post`, with no latest-memory fallback.

Revisit bypasses Jev entirely: it must retain the actual original being revisited.
Empty recall also costs zero Jev calls. Confidence **and** winning-option probability
must both be at least 0.8; these are provisional experiment thresholds, not Korean
accuracy guarantees. Candidate count/ordering is a retrieval limit, so Jev cannot
discover a useful memory outside the supplied six threads.

Enable for **one operator-invoked shadow collection**:

```bash
# Keys live in local .env; do not paste them into chat or commit them.
# Requires TYPESAFE_API_KEY and usable ANTHROPIC_API_KEY/credit.
TEST_MODE=false TEST_NO_EXTERNAL_CALLS=false npm run editorial:shadow -- --jev-memory
```

This command performs normal real provider reads and Anthropic inquiry/writing,
plus at most one paid Jev request. It sends the current measurement question and
candidate judgment text/outcomes to TypeSafe; URLs, reviewer metadata and ledger
IDs are not projected into its API state. Free text is still potentially sensitive.
Do not schedule it: shared USD accounting and Korean calibration remain pending.
Without `--jev-memory`, collection retains the existing selector and makes no Jev call.
Non-shadow use is rejected both by the CLI and the collection service.

Memory selection uses rubric `pixymon-memory-selection-v1` and experimental
collection epoch `jev-memory-inquiry-v4`. Existing baseline epoch remains
`inquiry-writer-v3`. Shadow drafts cannot publish, and the experimental epoch is
not accepted by the current live publisher. No R1/R2/R3 promotion is earned.

The shared `editorial-jev` audit reserves calls before inference. A digest-protected
decision context captures the candidate pool, exact request, raw probabilities,
selected memory (or explicit omission/failure), rubric and run/action linkage
before inquiry/writing. `planning_decision` events use stage `memory` with a reason.
The run's selected memory is frozen during replay; changed evidence or a missing
selection cannot silently reuse it. Replay never re-calls Jev.

Compare the baseline latest-memory input with the recorded Jev choice on the
**same** situation, clock, fact and generation model:

```bash
npm run editorial:compare -- --context <decision-context.json> \
  --output <new-comparison.json> --memory-baseline
```

This comparison uses paid Anthropic generation, but no provider/Jev/X calls or
memory writes. Have readers score the two outputs blind. A failed Jev selection
stays a no-post on the candidate side; it is not rescued into a positive sample.
Include failures, empty recall and uncertainty when measuring useful-selection
coverage, no-edit acceptance and preference. The synthetic test that chooses an
older refuted test and changes the new falsifier proves the connection only;
it does **not** prove Jev will choose correctly or that the resulting tweet is better.

## What was adopted

The official [TypeSafe skill](https://github.com/typesafe-ai/skills) is installed
in `.agents/skills/typesafe-ai`, pinned at
`65a39f393687675ce170e6094757de20370365b9`, including its MIT license.
It teaches typed decision design; it does not run inside Pixymon's character.
Community CLI installers, model routers and broad skill collections were not added.

The implementation follows the official skill's separation of exact code checks
from semantic model judgments, and its citation-checking pattern:

1. Code validates inquiry/fact/memory links and constructs a narrow snapshot.
2. One Jev request independently judges question/test alignment, evidence
   significance, memory fidelity, and each public sentence's grounding.
3. Code validates every answer's type, allowed options, probability distribution,
   selected peak, model identity and usage. It preserves raw probabilities.
4. Flags and uncertainty are shown to the operator. Human approval and all
   existing publication gates remain mandatory and unchanged.

Every request is pinned to `jev-1.13.0` and rubric `pixymon-inquiry-review-v1`.
Confidence below 0.8 is a **provisional review flag**, not a calibrated Korean
accuracy estimate. Even a clean result with confidence 1 cannot authorize posting.
Jev does not write or repair drafts, change a falsifier, choose a new model,
resolve follow-ups, or modify character memory.

## Preview without any external call

```bash
# Eight explicitly synthetic Korean boundary cases; no ledger or API key needed.
npm run editorial:jev-review -- --help
npm run editorial:jev-review -- --case bounded-level
npm run editorial:jev-review -- --case memory-distortion

# Inspect the exact request for an existing draft, including its current human edit.
ACTION_MODE=observe npm run editorial:jev-review -- --id <draftId>
EDITORIAL_TRACKING_MODE=shadow npm run editorial:jev-review -- --id <shadowDraftId>
```

Default mode is preview, with zero network calls and no file writes. The request
includes the current text, numeric evidence, inquiry and relevant previous
judgment/outcome. It excludes source URLs, runtime IDs and human reviewer metadata
from the API payload. This is field minimization, not a guarantee that arbitrary
free text is free of private information: inspect the preview before sending it.
Fixture labels are never supplied to Jev. They are author annotations, not measured
model results or proof of reader preference.

## Execute one advisory evaluation

Set `TYPESAFE_API_KEY` locally (never paste it into chat). Then explicitly permit
one paid request:

```bash
ACTION_MODE=observe TEST_MODE=false TEST_NO_EXTERNAL_CALLS=false \
  npm run editorial:jev-review -- --case memory-distortion --execute

ACTION_MODE=observe TEST_MODE=false TEST_NO_EXTERNAL_CALLS=false \
  npm run editorial:jev-review -- --id <draftId> --execute
```

Use the same `EDITORIAL_TRACKING_MODE` as the draft's ledger. Paper uses its
separate configured data directory. Live mode is rejected. API credentials alone
never enable a request. No provider, Anthropic or X client is called by this command.

Both experiments share a fixed limit of 12 request reservations per UTC day and active
data directory, with a cross-process lock. All attempts, including errors and
timeouts, consume their reservation. A request is at most 24,000 UTF-8 bytes and
has an 8-second deadline; there are no retries or alternative-model fallbacks.
This manual experiment is separately request-capped; it is **not yet included in
the autonomous runtime's combined USD accounting** and is not scheduled there.
Do not automate the command or increase its allowance before integrating that
accounting and measuring actual usage/cost.

Audit records go to `<active data directory>/editorial-jev/YYYY-MM-DD.ndjson`:

- `reserved` is fsynced before the API call; a crash does not free the allowance.
- `completed` retains request digest, rubric, resolved model, probabilities, token
  usage, latency, flags, uncertainty, run/draft linkage and the exact reviewed text.
- `sourceKind` distinguishes synthetic samples from ledger drafts.
- Missing key/network permission or unavailable lock/budget are explicit terminal
  results and do not make an API call. HTTP 401/403, 429, 529, JSON/contract errors,
  network failures and timeout remain distinct; raw error bodies are not logged.

These files are advisory records, not `review-recorded` events, critic scores for
auto-publish, or rollout evidence. Later edits produce a different request digest;
an old report does not assess the edited text. Reservations must not be deleted
to recover quota. If a lock survives a crash, confirm its owner has exited before
manually removing that specific lock.

## Verification and next gate

`npm run verify` includes offline API contract, malformed response, safety,
side-effect, concurrency, quota, CLI and fixture tests. Those use fake transport
responses: they prove wiring, not Jev's semantic judgments. The 100-run check
proves deterministic request construction, not remote model determinism.

As of this implementation, no `TYPESAFE_API_KEY` was configured and no real Jev
request was made. Actual accuracy, cost and latency are unmeasured.

Before scheduling either experiment or enabling Jev for live candidates:

1. Run the eight labeled synthetic cases and examine every mismatch/uncertain
   result, including correct output that Jev falsely flags.
2. Independently annotate at least 12 real same-context cases, including no-edit
   approvals and known edit/reject cases. Do not use these tuning cases as the
   entire held-out evaluation set.
3. Compare missed overclaims, invented lessons, false flags, uncertain rate,
   actual usage/latency, operator review time and two Korean readers' judgments.
4. Evaluate pre-writing recall separately: label useful prior judgments and no-match
   cases, then compare same-context outputs with `--memory-baseline`. Include API
   failures and empty/uncertain recall in coverage, not only successful choices.
5. Only if useful, integrate unified USD budget accounting and earn the rollout
   gates. Preserve deterministic facts, publication authorization and human approval.

The official [model documentation](https://docs.typesafe.ai/models) explicitly
warns that non-English/CJK accuracy is lower than English. Do not use Jev as the
authority on Korean naturalness, character charm or whether a fact is true.
Confidence is distribution concentration, not proof of correctness.

Sources checked 2026-09-21: [HTTP API](https://docs.typesafe.ai/api),
[Choice](https://docs.typesafe.ai/primitives/choice),
[state](https://docs.typesafe.ai/concepts/state),
[confidence](https://docs.typesafe.ai/confidence),
[citation-checking cookbook](https://docs.typesafe.ai/cookbooks/citation_check),
[selection/no-match cookbook](https://docs.typesafe.ai/cookbooks/skill_suggestion).
