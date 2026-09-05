# Pixymon V2 Editorial Runbook

## Product promise

> Pixymon does not summarize headlines. It verifies a named event with a number, leaves a judgment, and checks it again after 24 and 72 hours.

V2 is protocol-original-post only. Other lanes, quote posts, replies, images, and unattended live posting remain disabled during the first milestone.

## Current rollout status

- Implemented: V2 contracts, free-provider sensing, Tier A gate, question/hypothesis planner, read-only judgment recall, isolated shadow 24/72h checks, one-retry writer, review ledger, stage-bound manual publisher, decision-input replay, linked telemetry, and offline evaluation commands.
- Not yet earned: the 100-case real replay gate, two-reader blind evaluation, R1/R2 elapsed-time gates, or any automatic live promotion.
- Current publishable supply is deliberately narrow: significant DefiLlama protocol TVL moves only. CoinGecko and mempool.space snapshots, RSS, and CryptoCompare remain discovery-only.
- Default runtime stays `POST_PIPELINE_VERSION=v1` until the operator explicitly selects V2.
- The September 5 shadow smoke selected a real protocol candidate, but Anthropic rejected generation for insufficient credit. It ended as `no-post` (`generation/model-empty`), without a draft or publication. Real-context comparisons and human quality results remain pending; restore model access before collecting more samples.

## Safety model

- `observe`: reads public data and may call Claude, but never initializes an X client in the V2 runtime. It does not update character memory.
- `paper`: same outbound-write guarantee, with every shared state file routed under `PIXYMON_PAPER_DATA_DIR`.
- `live`: the scheduler still refuses automatic V2 posting. `editorial:publish` requires both human approval and an R3 operator authorization bound to earned R0/R1/R2 evidence. Shadow drafts can never publish, including after approval.
- Invalid action modes fail closed as `observe`.
- V2 has no deterministic, hard, rescue, or emergency publishing fallback. A second contract failure becomes `no-post`.

## R0 verification

The verification command runs with the repository's external-call test guards:

```bash
npm run verify
```

It runs the TypeScript build, CLI typecheck, unit/regression tests, 64-case offline golden evaluation, and the 100-candidate synthetic contract diversity gate. The synthetic corpus proves the harness and hard contracts; it is not a substitute for the required 100 real-context replay corpus. `TEST_NO_EXTERNAL_CALLS=true` is a test contract, not evidence that the OS denied network access.

CI checks the isolated namespace's interfaces using `ip -j link show`, not the inherited `/sys/class/net` mount, which caused the first main run to fail before tests. The interface parser has offline regressions; namespace identity, routes, outbound TCP denial and privilege dropping are still checked on Linux. The [ip manual](https://man7.org/linux/man-pages/man8/ip.8.html) documents link inspection and JSON output.

R0 no longer depends on real drafts or Revisit cases. After committing the verification inputs, record the offline gate with `npm run editorial:r0-record -- --output <new-evidence.json>`. The external network-isolation proof is still required separately. Real replay and blind quality gates belong to R2, before any R3 authorization.

`eval:corpus --input` remains a generic local evaluator for JSON arrays. Its input is not accepted as R2 runtime-replay evidence by itself:

```bash
npm run eval:corpus -- --input path/to/generic-corpus-array.json
```

## R2 real replay and blind evaluation

Export the first 100 raw generated drafts in the current `inquiry-writer-v3` collection epoch from the append-only ledger without runtime IDs, reviewers, provider URLs, or publication IDs. Rows retain `trackingMode` so real shadow observations cannot masquerade as live experience. The examples below use the normal ledger; for shadow evaluation, consistently select `EDITORIAL_TRACKING_MODE=shadow` and the corresponding shadow event log and artifact paths:

```bash
npm run editorial:replay-export -- --limit 100 --output data/editorial-v2/replay-001.json
```

The output is a strict runtime-replay manifest. Its shape is `eval/editorial-v2-replay.schema.json`; runtime validation additionally checks counts, ordered fact-ID mappings, and ledger reconstruction. It binds rows to the exact event-ledger byte prefix with SHA-256 and the `first-created-in-epoch` selection policy. New drafts must preserve `lane`, `collectionEpoch`, and the structured generated payload together. Legacy drafts without an epoch remain readable and are explicitly counted as excluded; a missing field inside the selected epoch is a hard error. Rows preserve lane, format, machine falsifier, anonymized fact IDs, writer `usedFactIds` and sentence claims, subject, raw metric, source observation time, and generated text. Review/edit history remains separate, so an edit cannot masquerade as writer output. Output files are create-only.

After committing a clean verification tree, run the guarded verification and strict runtime replay gates and create an immutable machine-evidence file:

```bash
npm run editorial:r0-record -- \
  --event-log data/editorial-v2/events.ndjson \
  --replay data/editorial-v2/replay-001.json \
  --output data/editorial-v2/r0-evidence-001.json
```

With the optional `--replay` input, this command also re-derives every replay row from the recorded ledger prefix and records the exact replay-file SHA-256 before recording `passed`. The replay checks count toward R2, not R0. It labels synthetic 100-run pipeline determinism separately from the runtime corpus file's 100 reloads; the latter is not represented as a pipeline rerun. It records only `offlineContractMode`, never a claim of OS-level network isolation, and never invents a zero-X audit. Free-form audit metadata conforming to `eval/rollout-evidence.schema.json` is informational; network isolation requires the GitHub verifier described below, and the trusted zero-X verifier is still missing.

Build the human pack from 36 protocol cases: 24 originals (Bite or Withhold, with the actual mix recorded rather than forced), plus 12 Revisit cases. Real shadow follow-ups are eligible evaluation inputs, never live publication evidence. Evolution cannot substitute for an original-post cell. Each comparison input contains only `id`, `replayRowId`, and `baselineText`. V2 text, evidence, lane, and format come directly from the strict replay row. Baseline generation must use the same captured context; hand-authored baselines do not prove a model or planner improvement. The public pack strips provider, URL, system/version labels, and the A/B mapping:

```bash
npm run editorial:blind-pack -- \
  --input path/to/36-comparisons.json \
  --replay data/editorial-v2/replay-001.json \
  --event-log data/editorial-v2/events.ndjson \
  --machine-evidence data/editorial-v2/r0-evidence-001.json \
  --pack-output path/to/reader-pack.json \
  --mapping-output path/to/private-mapping.json

npm run editorial:blind-report -- \
  --replay data/editorial-v2/replay-001.json \
  --pack path/to/reader-pack.json \
  --mapping path/to/private-mapping.json \
  --annotations path/to/annotations.json \
  --adjudications path/to/adjudications.json \
  --output path/to/blind-report.json
```

Keep the mapping away from both readers until annotation finishes. Without `--seed`, the CLI uses a cryptographic random seed; explicit seeds are for reproducibility tests. The mapping is created with mode `0600` and commits to the replay artifact digest, ledger digest, epoch, verified commit, and each selected row digest. Aggregation rejects a changed A/B side, text, evidence, order, row, or commit. Status additionally verifies the source ledger and machine evidence. Use only `reader-1`, `reader-2`, and `adjudicator-1` in tracked annotations. Schemas live in `eval/annotations/`. A missing second reader, required side field, ≥2-point disagreement adjudication, or protocol original/Revisit stratum leaves the evaluation incomplete. Other lanes are not required for this milestone.

## Collect a real candidate without publishing

```bash
ACTION_MODE=observe \
TEST_MODE=false \
TEST_NO_EXTERNAL_CALLS=false \
npm run editorial:collect
```

This reads DefiLlama, mempool.space, CoinGecko, RSS, and configured CryptoCompare. RSS and CryptoCompare are discovery-only in the first live scope. Only fresh, direct, GREEN evidence with a named subject, exact URL/time, and raw numeric metric can reach the writer.

DefiLlama first applies a coarse gate of at least $100M TVL, a 2% 24-hour move, a 2 percentage-point deviation from the large-protocol median, and at least $10M estimated raw USD movement. A cross-sectional median alone does not remove underlying-asset repricing, so no coarse result is publishable yet.

For at most six deterministic shortlist entries, V2 then reads the free `/protocol/{slug}` token history, joins `tokens`, `tokensInUsd`, and `tvl` by exact timestamp, and linearly interpolates only a bracketed 24-hour point. The candidate passes only when common-token coverage is at least 95%, both TVL reconciliations are within 2%, the list/detail direction agrees and their 24-hour gross changes differ by no more than two percentage points, the price-neutral quantity change is at least 2% and $10M, and quantity explains at least half of the log move. Detail responses are capped at 32 MiB each and 64 MiB per run, including bytes consumed by failed or unparsable responses; three fixed lanes share one eight-second provider budget. Top-level responses are also bounded: DefiLlama 16 MiB, mempool.space 64 KiB, CoinGecko 1 MiB, RSS and CryptoCompare 4 MiB each. A detail failure blocks only that candidate and is recorded in `selectionGaps`. Follow-up and publish revalidation use the lightweight `/protocols` absolute TVL path, never spend the detail budget, and query only providers named by their targets instead of waiting for the whole provider fan-out.

The interpolation and token-balance decomposition are review-only derived screening context. They are not evidence of deposits or net inflow: rebases, rewards, wrappers, and adapter changes can also alter balances. The public fact remains DefiLlama's raw 24-hour TVL change. Its 24/72h falsifier is anchored to the same protocol's absolute TVL and pre-move level, not a later rolling `change_1d` window.

Run due numeric checks independently of Claude. This command never generates copy and never calls X; public-value candidates remain durable for a later collection run:

```bash
ACTION_MODE=observe TEST_MODE=false TEST_NO_EXTERNAL_CALLS=false \
npm run editorial:followups
```

Run it at least hourly if the 24/72h checkpoint promise is in force. Each checkpoint accepts an observation only during the three hours after its due time, so a much later current value is never relabelled as a 24h or 72h check. A missing observation remains retryable inside that window. A missed 24h check then closes silently; a missed 72h check closes unresolved. A first run after 72h records the missed 24h checkpoint without applying the late value to it. A public Revisit is queued only for invalidation or a meaningful change.

In scheduler mode, numeric follow-ups run hourly while generic collection keeps its configured interval. A public-value checkpoint candidate triggers collection immediately so its immutable snapshot is drafted inside the two-hour signal freshness window. When using the provider-only command manually, follow its prompt and run `editorial:collect` immediately if `publicCandidates` is non-zero.

Paper mode must use a separate directory:

```bash
ACTION_MODE=paper \
PIXYMON_PAPER_DATA_DIR=.paper-data \
TEST_MODE=false \
TEST_NO_EXTERNAL_CALLS=false \
npm run editorial:collect
```

## Review queue

Review every pending draft interactively:

```bash
npm run editorial:review
```

Review one draft:

```bash
npm run editorial:review -- --id <draftId>
```

The terminal card shows the model's inquiry, why the evidence matters, current judgment, chosen check, linked memory lesson/change, machine falsifier, raw metric, source URL/time, and draft. Review whether the reasoning really follows the evidence and the linked past outcome; fact-ID linkage alone does not prove a semantic claim. Public copy must retain the exact UTC observation time. Decisions are append-only `approve`, `edit`, or `reject` events. Edited copy must pass the same subject, number, time, judgment, length, and Korean contract before it can become approved. Add `fact-checked` and `language-checked` to the final review's reason tags after those checks; rollout status treats absent positive tags as unknown, never as proof of zero errors.

## Publish one approved original

Publishing is intentionally explicit:

```bash
ACTION_MODE=live \
TEST_MODE=false \
TEST_NO_EXTERNAL_CALLS=false \
npm run editorial:publish -- --id <draftId> --authorization <authorization.json>
```

Before X is called, the command rechecks approval, durable writer lineage, 2h/6h freshness, current provider GREEN health and fact availability, exact duplicate history, Korean/factual contract, the editorial daily cap, X budget, and a single-process lock. Legacy drafts without captured `draft`/`usedFactIds`/sentence claims cannot publish. Duplicate-text and daily-cap reservations are made atomically under the ledger lock, and the approved text is compared again at the true X boundary. The same-subject rolling 24-hour novelty rule is also rechecked against both publications and unresolved dispatch intents. It writes a durable dispatch intent before the one allowed X attempt, rejects missing credentials rather than simulating success, and records publication/character memory only after X returns an ID.

If the process loses the X response or cannot commit the returned ID, the unresolved intent blocks every automatic retry. First verify the post on X; only when it exists, reconcile the ledger without sending again:

```bash
ACTION_MODE=live TEST_MODE=false TEST_NO_EXTERNAL_CALLS=false \
npm run editorial:publish -- --id <draftId> --reconcile-x-id <xPostId> --published-at <ISO timestamp>
```

If X did not create the post, keep the draft blocked and create a new reviewed draft. Never remove or rewrite the append-only intent.

Lock files fail closed after an abnormal process exit; they are never auto-deleted because stale-lock recovery can race with a new owner. If a command reports a stale or unverifiable lock, first confirm that no Pixymon/editorial process is alive and inspect X plus the dispatch intent. Only then remove the exact reported lock path manually and retry the non-destructive operation. Never broadly delete the data directory or ledger.

R3 is fixed to one approved original per day; there is no environment override for ramping through this command.

Before publishing, create a new 24-hour authorization with `npm run editorial:authorize-live -- --status <fresh-status.json> --output <new-authorization.json> --operator <operatorId>`. The source status must be less than 15 minutes old, belong to the clean current commit, and have every R0/R1/R2 check passing. The publisher verifies its digest, expiry and commit again at the actual dispatch boundary. A file named `<active data directory>/editorial-v2/STOP` suspends sending even with an otherwise valid authorization. The authorization records local operator authority, not independent external proof. Never hand-edit a status or authorization to bypass a gate. The missing trusted zero-X verifier still prevents earning R1 and issuing operational R3 authorization.

## Shadow rehearsal and same-context comparison

Use `npm run editorial:shadow` for real reads and budgeted generation without publishing. It writes to `editorial-v2-shadow/`, not the live-candidate queue. Run the worker hourly:

```bash
ACTION_MODE=observe EDITORIAL_TRACKING_MODE=shadow npm run editorial:followups
ACTION_MODE=observe EDITORIAL_TRACKING_MODE=shadow npm run editorial:review -- --id <shadowDraftId>
```

Shadow tracking starts at draft creation, uses the same checkpoint windows, and records no publication or character-memory mutation. An unchanged 24h observation stays silent. Revisit generation receives the original recorded question and judgment, explicitly labelled shadow. Use the shadow ledger consistently for R1/R2 status, replay and review evidence; do not splice it into the live ledger. After earning R3, collect and approve a fresh normal candidate in `editorial-v2/` for actual publishing. Actual publications keep their own publication-anchored follow-ups.

Every collection captures a private create-only `decision-contexts/<action hash>.json` before generation: candidate evidence, history, clock, selection seed, relevant memory, configured model, code revision and selected plan. No-post inputs are captured too. These input snapshots are different from the anonymized output-revalidation corpus and must remain in gitignored runtime data.

```bash
npm run editorial:compare -- --context <decision-context.json> --output <new-comparison.json>
```

This compares the captured plan with the current planning/inquiry path using the same stored evidence/time/seed/memory and configured model. Old `hypothesis-writer-v2` contexts retain their pre-inquiry baseline; the current variant adds an inquiry call. New `inquiry-writer-v3` contexts run inquiry on both sides, so neither side recreates an earlier sampled inquiry response. Each side can stop before writing. It does not call providers or X or modify either ledger. This is not a recreation of an old writer/model or proof of LLM determinism. Start with 12 actual collected contexts. Human scores, no-edit acceptance and reader preference remain pending until independent evaluation; the comparison command does not earn R2 by itself.

## Inquiry before writing

- The editorial model decides what to learn, why the selected evidence matters, and how the previous judgment/outcome changes this check. It returns structured reasoning, not a public draft. A malformed contract gets one retry; no public value or an empty model response stops before the writer. No deterministic inquiry or prose fallback exists in runtime.
- For a new USD TVL hypothesis, `pre-move-level` tests full reversion; `current-level` tests whether the current level also holds (increase: below current invalidates; decrease: above current invalidates). The model chooses a method, never an arbitrary metric, threshold or deadline. Code binds it to the existing evidence and +24/+72h schedule. `observation-only` cannot resolve as supported. Revisit uses `recorded-checkpoint` and cannot rewrite the original test.
- Memory includes the relevant original question/check and recorded outcome, including an outcome resolved in the same collection run. A published Revisit can refer back to its original outcome. Unposted live drafts and approvals do not count as experience. Shadow experience stays isolated. Definitive prior invalidation can change candidate priority only after Tier A, freshness and novelty gates.
- The initial planner's `digesting` represents the untested measurement hypothesis, not a requirement to withhold every editorial opinion. The inquiry's judgment drives the writer; factual grounding and human review still apply.
- A normal successful collection now uses two budgeted model calls: inquiry (up to 1,000 output tokens) and writer (up to 550). Each has at most one contract retry. Provider-only follow-ups still need no LLM. Existing spend limits remain in force; no automatic budget increase is made.
- `planning_decision` / `inquiry` telemetry stores the question, significance, judgment, selected method/threshold, linked draft/outcome IDs and lesson/change. The immutable draft stores the complete inquiry. Inputs are captured before either model call. The new collection epoch prevents old output-quality evidence from being reused as proof for this behavior; publishing requires the current epoch and an inquiry record.
- These contracts verify bounded execution and provenance, not the originality or truth of arbitrary reasoning prose. Independent human comparison remains required; the existing Anthropic credit failure blocks real-model quality verification until access is restored.

## Runtime files and telemetry

Defaults under the active data directory:

- `editorial-v2/events.ndjson`: immutable drafts, reviews, publications, and follow-up resolutions
- `editorial-v2/metrics.ndjson`: linked `provider_fetch`, `planning_decision`, `generation_attempt`, `review_decision`, `dispatch_decision`, and `followup_resolution`
- `editorial-v2/publish.lock`: one-publisher lock

Every chain carries a `runId` and draft/action ID. Every `no-post` records its stage and reason. Provider failures preserve `not-configured`, `unauthorized`, `rate-limited`, `timeout`, `parse-error`, `stale-cache`, `payload-too-large`, `empty`, `http-error`, or `network-error` instead of becoming a healthy fallback. Explicit stale cache signals and cache ages beyond two hours for signal providers or six hours for news providers fail closed. Candidate-level DefiLlama detail gaps are separately recorded without falsely turning a healthy `/protocols` fetch RED.

Inspect R0/R1/R2 evidence without calling providers, X, Claude, or character memory:

```bash
npm run editorial:status -- \
  --machine-evidence data/editorial-v2/r0-evidence-001.json \
  --replay data/editorial-v2/replay-001.json
```

That default command performs no network request. To verify the OS-isolated CI run directly from GitHub instead of trusting a hand-written audit field, run it on a clean checkout of the exact commit pushed to `main`:

```bash
npm run editorial:status -- \
  --machine-evidence data/editorial-v2/r0-evidence-001.json \
  --replay data/editorial-v2/replay-001.json \
  --github-ci-repo starlash7/Pixymon
```

The optional flag makes read-only GitHub Actions API requests. `GITHUB_TOKEN` is optional for a public repository and is never persisted. The verifier requires one completed successful `push` run for the exact clean local HEAD on branch `main`, workflow `.github/workflows/verify.yml`, job `verify`, and successful step `Verify with outbound network disabled`. API/auth/rate-limit errors, no matching run, or ambiguous runs remain `unknown`; any returned SHA/branch/event/workflow/job/step mismatch fails. Free-form `networkIsolationAudit` JSON remains informational and can never earn this check.

Add `--pack`, `--mapping`, `--annotations`, and optional `--adjudications` together to include the blind result. Status rechecks the replay SHA-256, ledger prefix, epoch, all 36 V2 rows, and the clean verified commit. It counts R1 evidence at or after the recorded R0 verification time and requires 30 unique observe actions over seven distinct dates and seven full 24-hour periods. Status uses append-only event time, requires explicit `fallbackUsed`, and revalidates approved final copy. Missing/corrupt logs, absent positive fact/language checks, unlinked telemetry, old verification commits, dirty trees, or unverified external audit metadata fail closed or remain `unknown`.

Once a saved status reports every R1 check as passed, record the operator's manual promotion on a clean repository:

```bash
npm run editorial:r1-promote -- \
  --status data/editorial-v2/r1-status.json \
  --output data/editorial-v2/r1-promotion.json
```

The create-only artifact binds the exact source status bytes, commit, observe window, and promotion time. Pass `--r1-promotion data/editorial-v2/r1-promotion.json --r1-status data/editorial-v2/r1-status.json` to subsequent status commands. R2 credits only drafts and review decisions recorded after that boundary and still requires 30 drafts over 14 dates and 14 full days. The artifact records a manual decision; it does not attest to zero X writes. The trusted zero-X verifier remains unimplemented, so current data cannot earn R1 or create a valid operational promotion.

## Known editorial limits

- The Linux CI workflow denies network access for the verify process, and changes to `.github/workflows/verify.yml` are part of the R0 clean-tree check. Rollout status can bind the exact successful push/main run to a clean current HEAD only when `--github-ci-repo` is supplied; otherwise network isolation remains `unknown`. The repository does not yet enforce this workflow through a `main` branch-protection rule or ruleset, so the successful run is evidence for that commit but not proof that every future integration must pass the check. The zero-X audit still has no trusted external verifier and remains `unknown`.
- Generated claims must copy every draft sentence in order and label it as observation or judgment. The machine falsifier stays in the plan, review card, and 24/72-hour worker. Ordinary conditionals are allowed; numeric/entity grounding, explicit future-recheck-promise checks, sentence claims and human approval remain enforced.
- The TVL semantic guard blocks fixture-backed unsupported leaps such as users, new capital, adoption, revenue, volume, structural growth, protocol stability, competitiveness, collateral health, or liquidation risk. It is a bounded guard, not proof that arbitrary Korean causal prose is grounded; every initial draft still requires human review, and automatic live remains locked until an independent semantic critic is implemented and calibrated.
- Bite means a bounded measurement hypothesis can be stated and tested; Withhold means only an observation is available. Neither a positive nor negative number determines approval or emotion. USD TVL hypotheses concern the displayed level only, never price-neutral retention or inflows. Observation-only checks close unresolved rather than becoming supported merely because an arbitrary threshold was not crossed. Evolution remains telemetry-only.
- The price-neutral screen removes obvious asset-price beta, but it does not prove deposits, causality, historical anomaly, or audience relevance. Those claims require separate evidence; token-symbol and adapter-method changes remain a monitored failure mode.
- A rejected or freshness-expired Revisit is not regenerated automatically. Its terminal public disposition is not yet represented as a dedicated ledger event, so R2 reporting must derive and audit this state before promotion.
- Synthetic corpus success proves the contracts and harness, not tweet quality. Do not promote on it without the real replay and blind human gates.

## Promotion and rollback

Promotion is manual. Do not infer readiness from a green build.

1. R0: offline contract verify and network isolation proof.
2. R1: observe/shadow for 7 days and at least 30 decisions; X writes must remain zero.
3. R2: 100 real replay cases, two-reader blind evaluation, and review for 14 days and at least 30 drafts; no-edit acceptance must be at least 80%, factual errors zero.
4. R3: explicit operator authorization plus human approval; publish 10 originals, maximum one per day.
5. R4/R5: automatic canary and ramp require the critic/calibration gates in code plus the elapsed operational evidence.

Immediately set `ACTION_MODE=observe` after any factual error, malformed post, duplicate post, observe/paper X write, or provider-RED post. Also stop automation if rolling 20 no-edit acceptance falls below 80% or near-duplicate rate reaches 8%.
