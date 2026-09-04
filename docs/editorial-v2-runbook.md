# Pixymon V2 Editorial Runbook

## Product promise

> Pixymon does not summarize headlines. It verifies a named event with a number, leaves a judgment, and checks it again after 24 and 72 hours.

V2 is original-post only. Quote posts, replies, macro, regulation, market structure, images, and unattended live posting remain disabled during the first milestone.

## Current rollout status

- Implemented: V2 contracts, free-provider sensing, Tier A gate, deterministic planner, durable 24/72h checks, one-retry writer, review ledger, manual publisher, linked telemetry, and offline evaluation commands.
- Not yet earned: the 100-case real replay gate, two-reader blind evaluation, R1/R2 elapsed-time gates, or any automatic live promotion.
- Current publishable supply is deliberately narrow: significant DefiLlama protocol TVL moves only. CoinGecko and mempool.space snapshots, RSS, and CryptoCompare remain discovery-only.
- Default runtime stays `POST_PIPELINE_VERSION=v1` until the operator explicitly selects V2.

## Safety model

- `observe`: reads public data and may call Claude, but never initializes an X client in the V2 runtime. It does not update character memory.
- `paper`: same outbound-write guarantee, with every shared state file routed under `PIXYMON_PAPER_DATA_DIR`.
- `live`: the scheduler still refuses automatic V2 posting. Only `editorial:publish` can send an approved original.
- Invalid action modes fail closed as `observe`.
- V2 has no deterministic, hard, rescue, or emergency publishing fallback. A second contract failure becomes `no-post`.

## R0 verification

The verification command is network-free:

```bash
npm run verify
```

It runs the TypeScript build, CLI typecheck, unit/regression tests, 64-case offline golden evaluation, and the 100-candidate synthetic contract diversity gate. The synthetic corpus proves the harness and hard contracts; it is not a substitute for the required 100 real-context replay corpus.

Run the same gates against an anonymized 100-row real replay array:

```bash
npm run eval:corpus -- --input path/to/editorial-v2-replay.json
```

Each row must preserve the draft's `format`, machine falsifier comparator, fact IDs, subject, raw metric value/name/unit/period, source observation time, and final text. The loader accepts those fields either from a stored draft-shaped `facts`/`falsifier` record or as explicit top-level evaluation fields; missing contract metadata fails closed.

## Collect a real candidate without publishing

```bash
ACTION_MODE=observe \
TEST_MODE=false \
TEST_NO_EXTERNAL_CALLS=false \
npm run editorial:collect
```

This reads DefiLlama, mempool.space, CoinGecko, RSS, and configured CryptoCompare. RSS and CryptoCompare are discovery-only in the first live scope. Only fresh, direct, GREEN evidence with a named subject, exact URL/time, and raw numeric metric can reach the writer.

DefiLlama first applies a coarse gate of at least $100M TVL, a 2% 24-hour move, a 2 percentage-point deviation from the large-protocol median, and at least $10M estimated raw USD movement. A cross-sectional median alone does not remove underlying-asset repricing, so no coarse result is publishable yet.

For at most six deterministic shortlist entries, V2 then reads the free `/protocol/{slug}` token history, joins `tokens`, `tokensInUsd`, and `tvl` by exact timestamp, and linearly interpolates only a bracketed 24-hour point. The candidate passes only when common-token coverage is at least 95%, both TVL reconciliations are within 2%, the list/detail direction agrees and their 24-hour gross changes differ by no more than two percentage points, the price-neutral quantity change is at least 2% and $10M, and quantity explains at least half of the log move. Detail responses are capped at 32 MiB each and 64 MiB per run, including bytes consumed by failed or unparsable responses; the whole provider shares one eight-second budget. A detail failure blocks only that candidate and is recorded in `selectionGaps`. Follow-up and publish revalidation use the lightweight `/protocols` absolute TVL path and never spend this detail budget.

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

The terminal card shows the planner thesis, verdict, machine falsifier, raw metric, provider, observation time, source URL, and public draft. Public copy must retain the exact UTC observation time. Decisions are append-only `approve`, `edit`, or `reject` events. Edited copy must pass the same subject, number, time, judgment, length, and Korean contract before it can become approved.

## Publish one approved original

Publishing is intentionally explicit:

```bash
ACTION_MODE=live \
TEST_MODE=false \
TEST_NO_EXTERNAL_CALLS=false \
npm run editorial:publish -- --id <draftId>
```

Before X is called, the command rechecks approval, 2h/6h freshness, current provider GREEN health and fact availability, exact duplicate history, Korean/factual contract, the editorial daily cap, X budget, and a single-process lock. Review and dispatch mutations share the same ledger lock, and the approved text is compared again at the true X boundary. The same-subject rolling 24-hour novelty rule is also rechecked against both publications and unresolved dispatch intents. It writes a durable dispatch intent before the one allowed X attempt, rejects missing credentials rather than simulating success, and records publication/character memory only after X returns an ID.

If the process loses the X response or cannot commit the returned ID, the unresolved intent blocks every automatic retry. First verify the post on X; only when it exists, reconcile the ledger without sending again:

```bash
ACTION_MODE=live TEST_MODE=false TEST_NO_EXTERNAL_CALLS=false \
npm run editorial:publish -- --id <draftId> --reconcile-x-id <xPostId> --published-at <ISO timestamp>
```

If X did not create the post, keep the draft blocked and create a new reviewed draft. Never remove or rewrite the append-only intent.

The initial default is one approved original per day. `EDITORIAL_DAILY_POST_LIMIT` is clamped to `1..2`.

## Runtime files and telemetry

Defaults under the active data directory:

- `editorial-v2/events.ndjson`: immutable drafts, reviews, publications, and follow-up resolutions
- `editorial-v2/metrics.ndjson`: linked `provider_fetch`, `planning_decision`, `generation_attempt`, `review_decision`, `dispatch_decision`, and `followup_resolution`
- `editorial-v2/publish.lock`: one-publisher lock

Every chain carries a `runId` and draft/action ID. Every `no-post` records its stage and reason. Provider failures preserve `not-configured`, `unauthorized`, `rate-limited`, `timeout`, `parse-error`, `stale-cache`, `payload-too-large`, `empty`, `http-error`, or `network-error` instead of becoming a healthy fallback. Explicit stale cache signals and cache ages beyond two hours for signal providers or six hours for news providers fail closed. Candidate-level DefiLlama detail gaps are separately recorded without falsely turning a healthy `/protocols` fetch RED.

## Known editorial limits

- Generated claims must copy every draft sentence in order and label it as observation, judgment, or falsifier. A non-Revisit has exactly one falsifier claim and it is last; any earlier conditional clause is rejected. Every non-Revisit ends in one exact comparator-specific machine sentence, and the 72-hour deadline and competing follow-up language are forbidden outside it. The same text contract applies to human edits and publish-time validation. This narrows the executable grammar instead of pretending that a regex can understand arbitrary negated Korean logic.
- The TVL semantic guard blocks fixture-backed unsupported leaps such as users, new capital, adoption, revenue, volume, structural growth, protocol stability, competitiveness, collateral health, or liquidation risk. It is a bounded guard, not proof that arbitrary Korean causal prose is grounded; every initial draft still requires human review, and automatic live remains locked until an independent semantic critic is implemented and calibrated.
- Bite versus Withhold is now based on event materiality, not positive versus negative direction. Evolution remains telemetry-only until real reviewed examples define it.
- The price-neutral screen removes obvious asset-price beta, but it does not prove deposits, causality, historical anomaly, or audience relevance. Those claims require separate evidence; token-symbol and adapter-method changes remain a monitored failure mode.
- A rejected or freshness-expired Revisit is not regenerated automatically. Its terminal public disposition is not yet represented as a dedicated ledger event, so R2 reporting must derive and audit this state before promotion.
- Synthetic corpus success proves the contracts and harness, not tweet quality. Do not promote on it without the real replay and blind human gates.

## Promotion and rollback

Promotion is manual. Do not infer readiness from a green build.

1. R0: verify plus 100 real replay cases and two-reader blind evaluation.
2. R1: observe for 7 days and at least 30 decisions; X writes must remain zero.
3. R2: review for 14 days and at least 30 drafts; no-edit acceptance must be at least 80%, factual errors zero.
4. R3: publish 10 approved originals, maximum one per day.
5. R4/R5: automatic canary and ramp require the critic/calibration gates in code plus the elapsed operational evidence.

Immediately set `ACTION_MODE=observe` after any factual error, malformed post, duplicate post, observe/paper X write, or provider-RED post. Also stop automation if rolling 20 no-edit acceptance falls below 80% or near-duplicate rate reaches 8%.
