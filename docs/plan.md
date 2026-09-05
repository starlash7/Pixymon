# Pixymon Operating Plan

Last updated: 2026-09-05

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
- A USD TVL level hypothesis checks whether that level has fully reverted; it does not test price-neutral retention, deposits, users, or causality. Observations without a testable hypothesis remain unresolved, never supported by default.
- The writer reads stable beliefs and one relevant recorded judgment. Live candidates never learn from shadow experience, unposted drafts, or human edits presented as actual publications.
- Runtime decision contexts preserve candidate facts, clock, selection seed, historical inputs, memory, model identity and code revision before generation, including no-post decisions. The same-context comparison command has no publishing capability.
- Development acceptance starts with 12 real cases before collecting the full corpus. No claim of improved reader preference or no-edit acceptance is allowed before actual human evaluation.
- The trusted external zero-X verifier remains unimplemented. R1 and therefore R3 authorization remain blocked until it is supplied; a local authorization file is not a substitute for that proof.

## 14. Integration Checkpoint — 2026-09-05

- Removed the inactive blanket conditional/falsifier-language ban and its obsolete tests. Grounding, malformed-language, future-recheck-promise, approval and dispatch gates remain intact. Removed the unused daily-limit environment setting; R3 stays fixed at one original per day.
- Aligned the README, character architecture and runbook with protocol-only V2, isolated shadow rehearsal, and R0/R2 evaluation separation. V1 remains until its explicit removal gate is earned.
- Local `npm run verify`: 442 unit tests, 64 offline golden cases, and the 100-case synthetic corpus with 100-run determinism passed. This is contract proof, not reader-quality proof.
- The last real shadow generation attempt stopped on insufficient Anthropic credit (`generation/model-empty`). Restore generation access, evaluate 12 same-context cases, then collect the real corpus and independent human scores. No live promotion is earned by this integration.
