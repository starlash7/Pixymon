# Pixymon Operating Plan

Last updated: 2026-09-21

This document is not a brainstorm file. It is the operating contract for Pixymon work.

## 1. North Star

Build Pixymon into a follow-worthy character IP:

1. more human
2. more memorable
3. more worth following

Optimization for automation metrics alone is not success.

## 2. Current Product Definition

Pixymon is:

1. a Korean character-driven X agent
2. a creature that "eats" onchain signals and digests them into narrative memory
3. an interpreter of crypto culture, not a market-summary bot
4. an account whose posts, replies, quotes, and future images should feel like one evolving being

## 3. Garry Tan Overlay

Every meaningful change must declare one mode before implementation:

1. `HOLD SCOPE`
   - stabilize current behavior
   - remove failure modes
   - avoid adding new product surface
2. `EXPANSION`
   - add capability only when the current loop is stable enough
   - every new surface must come with observability and rollback
3. `REDUCTION`
   - remove or disable complexity that is not paying for itself
   - prefer deletion over tuning when a subsystem keeps creating noise

Before patching:

1. audit the live symptom
2. identify the primary bottleneck
3. name the degraded path, recovery path, and observability path

Rules:

1. zero silent failures
2. no hidden mode changes
3. no unobserved fallback behavior
4. every shipped change must leave behind:
   - a deterministic test or explicit runtime check
   - a metric/logging surface
   - a deferred list of what is still not fixed

## 4. Skill Overlay

For repeatable workflows, follow `docs/skills-guidelines.md`.

Practical rules:

1. encode repeated workflows as docs/scripts/tests, not repeated chat explanations
2. store gotchas when failure patterns repeat
3. prefer scripts, references, and templates over long prose
4. do not create giant vague skills; compose smaller reusable workflows
5. if verification is missing, call that out before implementation

## 5. Current Structural Problems

As of now, Pixymon still fails on:

1. fallback-dominated posting
2. weak planner/evidence pairs
3. low character distinctiveness in live output
4. social loop blocked or degraded by X API entitlement limits

The active response is `Pixymon V2`, first in `REDUCTION` and then `HOLD SCOPE`:

1. stop publishing multi-stage fallback prose
2. preserve named subjects, raw numbers, source URLs, and source time
3. connect selected facts to an explicit question, a bounded measurement hypothesis, and its falsifier
4. keep original posts human-approved until offline, observe, and review gates pass
5. revisit published Bite/Withhold at +24h and +72h; rehearse the same lifecycle in a separate, non-publishable shadow ledger
6. treat USD TVL as a candidate only after a bounded token-history screen removes price-dominated moves; never publish the derived balance decomposition as inflow

## 6. Design Principles

1. separate safety rails from creativity rails
2. define desire before defining prohibitions
3. optimize continuity of character over one-off phrasing tricks
4. keep hard blocks for cost, legal, and platform risk only
5. prefer structural fixes over endless copy tuning

## 7. Core Loop

1. `Sense`
2. `Digest`
3. `Desire`
4. `Quest`
5. `Decide`
6. `Act`
7. `Reflect`

The loop only counts as real if the live output is not dominated by fallback.

## 8. Acceptance Gates For Work

No sprint is complete unless it leaves behind:

1. build/test evidence
2. runtime verification notes
3. explicit remaining bottleneck

For content quality changes, also require:

1. local sample proof
2. live-path guard against the exact failure pattern
3. no regression into raw evidence fragments or templated control openers

## 9. Priority Ladder

Work in this order unless a higher-severity runtime failure interrupts:

1. runtime stability
2. planner quality
3. fallback reduction
4. character/IP expression
5. social loop quality
6. expansion surfaces such as images or long-form writing

## 10. KPI

1. duplicate rate under 8%
2. BTC-only framing rate under 40%
3. fallback rate trending down week over week
4. reply loop actually alive, or explicitly disabled for entitlement reasons
5. cost limits respected

V2 promotion metrics override volume metrics:

1. factual and numeric error: `0`
2. named-subject and numeric coverage: `100%`
3. malformed or live-fallback output: `0`
4. semantic near-duplicate rate: `<8%`
5. human no-edit acceptance: `>=80%`
6. due follow-up completion: `>=80%`

## 11. Operating Policy

Keep:

1. cost ceilings
2. legal/platform risk blocks
3. numeric integrity

Reduce:

1. overfitted phrasing rules
2. expression blocks that suppress character voice
3. subsystems that produce repeated low-value output

## 12. Current Next Step

Do not tune V1 prompts further. Complete the V2 gates in order:

1. `R0`: network-free contract verify and deterministic offline tests, without needing live or shadow posts first
2. `R1`: seven days and at least 30 observe decisions with zero X writes; collect actual protocol shadow follow-ups
3. `R2`: fourteen days and at least 30 reviewed drafts with zero factual errors, plus 100 real replay cases and two-reader blind evaluation
4. `R3`: ten human-approved live originals, capped at one per day; requires fresh, commit-bound operator authorization derived from earned R0/R1/R2
5. only then evaluate an automatic original-post canary

Operational commands and rollback rules live in `docs/editorial-v2-runbook.md`.

## 13. Current Implementation Boundary — REDUCTION / HOLD SCOPE

- The initial evidence and human-evaluation scope is protocol only. Other lanes remain discovery-only.
- A USD TVL level hypothesis checks full reversion or, when explicitly selected, whether the current level holds; it does not test price-neutral retention, deposits, users, or causality. Observations without a testable hypothesis remain unresolved, never supported by default.
- The editor and writer read stable beliefs and one relevant recorded judgment with its original question, check method and observed outcome. Live candidates never learn from shadow experience, unposted drafts, or human edits presented as actual publications.
- Runtime decision contexts preserve candidate facts, clock, selection seed, historical inputs, memory, model identity and code revision before generation, including no-post decisions. The same-context comparison command has no publishing capability.
- Development acceptance starts with 12 real cases before collecting the full corpus. No claim of improved reader preference or no-edit acceptance is allowed before actual human evaluation.
- The trusted external zero-X verifier remains unimplemented. R1 and therefore R3 authorization remain blocked until it is supplied; a local authorization file is not a substitute for that proof.

## 14. Integration Checkpoint — 2026-09-05

- Removed the inactive blanket conditional/falsifier-language ban and its obsolete tests. Grounding, malformed-language, future-recheck-promise, approval and dispatch gates remain intact. Removed the unused daily-limit environment setting; R3 stays fixed at one original per day.
- Aligned the README, character architecture and runbook with protocol-only V2, isolated shadow rehearsal, and R0/R2 evaluation separation. V1 remains until its explicit removal gate is earned.
- Local `npm run verify`: 451 unit tests, 64 offline golden cases, and the 100-case synthetic corpus with 100-run determinism passed. This is contract proof, not reader-quality proof.
- The first main CI run failed before tests because its interface check used the inherited sysfs mount. The corrected check reads current-namespace links through netlink; nine parser regressions cover loopback-only acceptance and fail-closed responses. Linux CI remains the actual namespace-isolation verification surface.
- The last real shadow generation attempt stopped on insufficient Anthropic credit (`generation/model-empty`). Restore generation access, evaluate 12 same-context cases, then collect the real corpus and independent human scores. No live promotion is earned by this integration.

## 15. Inquiry Continuity — HOLD SCOPE

- An editorial model now authors the inquiry and its importance before the writer, with explicit links to the selected fact and actual previous judgment/outcome. It may pursue, withhold or no-post; it does not select arbitrary new tools or evidence sources.
- Memory can influence candidate priority after hard gates. Choosing a stricter current-level check changes the executable falsifier for a new hypothesis while preserving old originals and resolutions. Revisit interprets recorded results instead of moving historical goalposts.
- Initial hypothesis status remains untested; the writer expresses the editor's current judgment without forcing every original to end in withholding. No new phrase templates, emotion categories, social surfaces or publishing permissions are added.
- Verification includes shadow original → invalidated follow-up → Revisit → next original with a different check → different 72h resolution, plus unsupported fact/memory/check rejection and no-post before writing. Deterministic models in tests prove the plumbing, not real character quality.
- Local `npm run verify` passes: build/script types, 467 unit tests, 64 offline golden cases, and the 100-case synthetic corpus with 100-run determinism. Same-context replay regression verifies legacy/current paths without mutating captured inputs.
- Collection epoch is `inquiry-writer-v3`. Real-model generation and human preference/no-edit acceptance remain unverified due to the existing Anthropic credit blocker. R1 zero-X proof and all rollout authorization requirements remain unchanged.

## 16. Jev Advisory Evaluation — HOLD SCOPE

- Imported the official TypeSafe development skill at a pinned commit, without global plugins or new package dependencies. Jev is used for bounded semantic review, not writing or posting authority.
- The operator-only command checks question/test alignment, evidence significance, faithful use of previous outcomes and sentence grounding. Exact code checks and all existing approval/rollout gates remain authoritative.
- Default preview makes no network call or write. Explicit execution uses one pinned-model request, an 8-second deadline, a 24KB request cap and 12 reserved calls/day UTC; no retry/fallback. Advisory audit records are separate from reviews, memory and promotion evidence.
- Eight synthetic Korean boundary cases and mock-transport tests exercise the integration. They do not establish semantic accuracy or reader quality. TypeSafe documents weaker non-English/CJK performance, so Korean calibration is required.
- Local `npm run verify` passes: build/script types, 504 unit tests (37 new Jev tests), 64 offline golden cases and the 100-case synthetic corpus. The operator CLI's synthetic memory-distortion preview completed with zero external calls and no publication authority.
- Missing `TYPESAFE_API_KEY` prevents real-model verification in this checkpoint. Next: labeled fixtures, 12 actual cases and an independent held-out evaluation. Automatic scheduling, USD budget unification, reranking and writer replacement remain deferred; no live promotion is earned.

## 17. Jev Pre-writing Recall — HOLD SCOPE

- The primary bottleneck is latest-only recall: an older recorded test may be more relevant to the present measurement question. An explicit `editorial:shadow -- --jev-memory` experiment now selects one of up to six eligible judgment threads before inquiry/writing, with `none` and uncertainty outcomes. Exact entity, metric, provenance and time checks remain in code.
- Selected experience is copied from the ledger, never generated by Jev. The inquiry model explains why the current evidence matters and what the selected prior result changes. Revisit keeps its original parent and historical falsifier; no model reselects that history.
- Jev failures stop the candidate with a memory-stage reason. Uncertain/no-match decisions explicitly supply no previous record. Request reservations, raw probabilities, selected memory and no-post contexts are recorded; no retries or hidden latest-memory fallback.
- Shared advisory/memory allowance stays at 12 reserved calls/day per active data directory. Only operator-invoked shadow runs are enabled; no scheduler, new social surface, autonomous tool execution or posting authority. Unified USD accounting remains required before automation.
- Experimental epoch is `jev-memory-inquiry-v4`; baseline/live eligibility remains `inquiry-writer-v3`. Same-context `--memory-baseline` compares the original latest-memory selector against the recorded Jev choice without fetching new evidence or re-calling Jev. Rollout and real human-evaluation gates are unchanged.
- Offline tests verify older-memory → inquiry → writer → changed new falsifier, no-match/uncertain omission, immutable Revisit parent, hard-gate precedence, shared quota and fail-closed replay. This is wiring proof, not improved judgment/reader preference. `TYPESAFE_API_KEY` is still absent; actual Jev inference, Korean calibration, latency/cost and reader quality remain unverified.
- Local `npm run verify` passes: build/script types, 523 unit tests (19 new memory tests), 64 offline golden cases and the 100-case synthetic corpus with 100-run determinism. No actual Jev or X request was made.

## 18. Runtime Checkpoint — 2026-09-21 / HOLD SCOPE

- The immediate bottleneck is generation access and missing real output evaluation, not another framework or memory feature. The latest one-shot observe/shadow test used the existing `inquiry-writer-v3` path at `14a2514` with no code or persistent configuration changes.
- Real sensing selected one eligible protocol candidate. Anthropic rejected the first inquiry call with HTTP 400 for insufficient credit; the collector stopped at `inquiry/inquiry-model-empty`, before the writer, with no fallback. The generic empty-result reason must be interpreted together with the provider error.
- No draft, review, publication or durable follow-up was created. Character memory and the X-budget file were unchanged. Shadow metrics and a decision-input snapshot were retained locally; raw runtime records are not committed and this smoke does not earn R1 zero-write proof.
- Jev remained disabled and its key absent. Current local defaults remain V1/observe with external-call test guards and the scheduler off. A merged feature is not an activated or quality-validated feature.
- The existing 523-unit/64-golden/100-synthetic verification is implementation evidence, not 100 real generated posts or measured reader preference. Actual prose, faithful memory interpretation, character distinctiveness and no-edit acceptance remain unverified.
- Next: restore model access; inspect the first actual draft without posting; collect and review 12 real cases; observe successful shadow originals at +24h/+72h; then compare memory selection on the same contexts. The trusted zero-X verifier and independent semantic-critic execution/calibration remain separate unfinished requirements, not gates that elapsed time alone can satisfy.
- Reproduction details and recovery steps are in the [editorial runbook](editorial-v2-runbook.md#september-21-shadow-smoke-checkpoint). No posting permission, provider threshold, spend limit or rollout requirement is relaxed by this checkpoint.
