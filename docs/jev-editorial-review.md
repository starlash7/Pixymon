# Jev editorial review — HOLD SCOPE

This is an operator-invoked semantic review experiment, **not a new writer,
auto-approval system, or production quality gate**. The bottleneck it addresses
is that valid fact IDs do not establish whether an inquiry, interpretation or
claimed memory lesson actually follows the supplied evidence.

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

The experiment has a fixed limit of 12 request reservations per UTC day and active
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

Before any runtime integration:

1. Run the eight labeled synthetic cases and examine every mismatch/uncertain
   result, including correct output that Jev falsely flags.
2. Independently annotate at least 12 real same-context cases, including no-edit
   approvals and known edit/reject cases. Do not use these tuning cases as the
   entire held-out evaluation set.
3. Compare missed overclaims, invented lessons, false flags, uncertain rate,
   actual usage/latency, operator review time and two Korean readers' judgments.
4. Only if useful, plan a shadow-mode integration and unified budget accounting.
   Preserve deterministic facts, publication authorization and human approval.

The official [model documentation](https://docs.typesafe.ai/models) explicitly
warns that non-English/CJK accuracy is lower than English. Do not use Jev as the
authority on Korean naturalness, character charm or whether a fact is true.
Confidence is distribution concentration, not proof of correctness.

Sources checked 2026-09-21: [HTTP API](https://docs.typesafe.ai/api),
[Choice](https://docs.typesafe.ai/primitives/choice),
[state](https://docs.typesafe.ai/concepts/state),
[confidence](https://docs.typesafe.ai/confidence),
[citation-checking cookbook](https://docs.typesafe.ai/cookbooks/citation_check).
