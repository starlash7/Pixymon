
<p align="center">
  <img src="./docs/assets/pixymon-sprite.jpg" alt="Pixymon sprite sheet" width="680" />
</p>

## Pixymon

[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Anthropic Claude](https://img.shields.io/badge/Anthropic-Claude-191919?logo=anthropic&logoColor=white)](https://www.anthropic.com/)
[![X API](https://img.shields.io/badge/X%20API-v2-111111?logo=x&logoColor=white)](https://developer.x.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

A Korean character-driven X agent that "eats" onchain signals, digests them into narrative memory, and posts as a growing creature rather than a market-summary bot.

## What Pixymon Is

Pixymon is not meant to become a generic crypto posting bot.

The product goal is:

- Pixymon becomes memorable enough to earn attention on its own
- The operator behind Pixymon becomes known because the account itself becomes a recognizable IP

That means Pixymon has to combine three things at once:

- `AIXBT-like`: dense market and onchain interpretation
- `Lobster-like`: human, characterful, worth following
- `Pixymon-like`: an onchain creature that feeds, digests, evolves, acts, and reflects

The current product north star is documented in `concept.md`.

## Current State

The current work is Pixymon V2: evidence → question/hypothesis → editorial judgment → memory-aware writing → human approval → publication → reobservation and revised judgment.

- Initial scope: protocol originals with named, fresh, direct numeric evidence.
- Implemented: a model-authored inquiry before writing (question, evidence significance, current judgment and memory-driven check choice), relevant judgment/outcome recall, isolated shadow follow-ups, append-only review, and stage-bound approved publishing.
- Validation: offline contracts and synthetic diversity tests; these do not prove reader preference or production quality.
- Still blocked: real replay/human evaluation, elapsed R1/R2 gates, and the trusted zero-X verifier. The September 5 generation smoke also stopped on insufficient Anthropic credit.

V2 exists beside the legacy path behind `POST_PIPELINE_VERSION=v1|v2` (default: `v1`). Selecting V2 does not authorize live posting. V1 social features and fallbacks remain for compatibility, not as V2 fallbacks, until V2 has 20 live posts and 14 incident-free days.

## Product Principles

Pixymon should move toward:

- character + interpreter, not data bot
- conversation gravity, not one-way posting
- memorable worldview, not repetitive market commentary
- recurring arc: feed, digest, evolve, fail, reflect

Pixymon should avoid:

- price-only posts
- market cap / dominance snapshot posts
- fear-greed boilerplate
- meaningless high-frequency output
- over-safe, personality-free text

Every meaningful change should answer this question:

> Does this make Pixymon feel more human, more memorable, and more worth following?

If the answer is no, it is probably just automation work, not product work.

## Architecture

### V2 Editorial Loop

The planner chooses eligible evidence, giving a previously invalidated subject priority among equally fresh candidates. A budgeted editorial model then explains its question, why the evidence matters, and what a real prior judgment changes about the next check. It can pursue a bounded measurement test, withhold, or choose no-post. The writer renders that judgment with read-only memory; an unresolved hypothesis no longer forces a boilerplate withholding conclusion. Human approval does not bypass freshness, grounding, duplicate, budget, or rollout-stage checks. Shadow rehearsal exercises the follow-up loop without publishing or changing live character memory.

See [character architecture](docs/character-architecture.md) for the contracts and [V2 runbook](docs/editorial-v2-runbook.md) for commands and promotion requirements.

### Legacy V1 Core Loop

1. `Feed`
   - Collect onchain, market, news, and social signals
   - Normalize them into nutrients and trend events

2. `Digest`
   - Score freshness, trust, consistency, and signal quality
   - Convert accepted nutrients into XP and memory updates

3. `Evolve`
   - Update stage, soul state, and active abilities
   - Track recurring reflections and internal narrative drift

4. `Plan`
   - Select a lane (`protocol`, `ecosystem`, `regulation`, `macro`, `onchain`, `market-structure`)
   - Pair one event with evidence anchors
   - Reject low-quality or low-signal plans

5. `Act`
   - Post, quote, or reply
   - Enforce budget guardrails and duplicate checks

6. `Reflect`
   - Record narrative outputs
   - Log phrase audit hits
   - Feed reflection memos back into memory

### Legacy V1 Supporting Loops

- `Budget`
  - X API guard
  - Anthropic guard
  - total spend guard
- `Caching`
  - shared run context
  - prompt caching for repeated prefixes
- `Batch`
  - queue / sync for non-urgent digest reflections
- `Audit`
  - narrative observation log
  - suspicious phrase summary
- `Lexicon`
  - rewrite internal analyst jargon into natural Korean

## Tech Stack

### Core

- Node.js 20+
- TypeScript 5
- `twitter-api-v2`
- `@anthropic-ai/sdk`
- `dotenv`
- `tsx` for local development
- Node built-in test runner for regression coverage

### Internal Services

- `src/services/editorial-v2/`
  - V2 evidence, hypotheses, writer, review, publishing, follow-ups and evaluation
- `src/services/engagement.ts`
  - legacy V1 planning and action loop
- `src/services/engagement/event-evidence.ts`
  - event selection, evidence pairing, structural fallback planning
- `src/services/llm.ts`
  - Claude requests, routing, caching hooks
- `src/services/memory.ts`
  - evolving state, soul prompt context, stored post memory
- `src/services/twitter.ts`
  - posting, reply search, trend-target filtering
- `src/services/narrative-observer.ts`
  - narrative event logging and audit summaries
- `src/services/narrative-lexicon.ts`
  - rewrite and suspicious-pattern rules
- `src/services/x-api-budget.ts`
  - X API budget tracking
- `src/services/anthropic-budget.ts`
  - Anthropic budget tracking
- `src/services/anthropic-admin-usage.ts`
  - optional usage sync from Anthropic admin endpoints

## Runtime and Operations

### Recommended Operating Mode

Use V2 observe/shadow first. Real provider reads and generation may spend the configured LLM budget; they do not post to X. For a one-shot runtime collection, explicitly select:

```env
TEST_MODE=false
TEST_NO_EXTERNAL_CALLS=false
ACTION_MODE=observe
POST_PIPELINE_VERSION=v2
SCHEDULER_MODE=false
POST_LANGUAGE=ko

X_API_DAILY_MAX_USD=0.50
ANTHROPIC_DAILY_MAX_USD=0.50
TOTAL_DAILY_MAX_USD=1.00
```

`.env.example` retains safe test defaults and the legacy V1 selector. Follow the V2 commands below instead of assuming a production rollout is ready.

### Language Policy

- Posts are Korean-first
- Replies follow the incoming language when needed
- Narrative lexicon and surface finalization are tuned primarily for Korean cadence

### Observability

Important files:

- `data/memory.json`
- `data/operational-state.json`
- `data/metrics-events.ndjson`
- `data/narrative-observation.ndjson`
- `data/narrative-phrase-audit.json`

Narrative audit report:

```bash
npm run audit:narrative
```

### Pixymon V2 editorial workflow

Run the complete local contract gate:

```bash
npm run verify
```

The command enables external-call guards in tests. The GitHub `verify` workflow additionally runs it inside an OS network namespace with outbound access removed; see the runbook for the distinction and evidence checks.

Collect and review a real V2 candidate without X writes:

```bash
ACTION_MODE=observe TEST_MODE=false TEST_NO_EXTERNAL_CALLS=false npm run editorial:collect
ACTION_MODE=observe TEST_MODE=false TEST_NO_EXTERNAL_CALLS=false npm run editorial:followups
npm run editorial:review -- --id <draftId>
```

Only after earning R3 authorization can `editorial:publish -- --id <draftId> --authorization <authorization.json>` run in live mode. It is capped to one original per day and refuses stale evidence, missing approval, duplicate text, test mode, missing X credentials, and concurrent publishing. Full operating and rollback instructions are in [the V2 runbook](docs/editorial-v2-runbook.md).

The current milestone is protocol-only. `npm run editorial:shadow` collects into a separate, permanently non-publishable ledger; `EDITORIAL_TRACKING_MODE=shadow ACTION_MODE=observe npm run editorial:followups` reobserves those hypotheses without X writes or live character-memory changes. R0 is now the offline contract gate; real replay and blind quality evaluation are R2 requirements. R3 publishing requires a fresh operator authorization created by `editorial:authorize-live` from an earned R0/R1/R2 status. The missing trusted zero-X verifier still blocks R1, so this change does not enable production publishing.

## Development

Install:

```bash
npm ci
```

Local safe rehearsal:

```bash
ACTION_MODE=observe TEST_MODE=true SCHEDULER_MODE=false npm run dev
```

Build:

```bash
npm run build
```

Test:

```bash
npm test
```

Full V2 verification:

```bash
npm run verify
```

Tests use repository-scoped `.test-data/` storage, while stateful editorial regressions use per-test temporary directories. This keeps local production memory and audit files untouched; the suite-wide `.test-data/` directory is not itself a per-test isolation boundary.

## Current Constraints

Pixymon is still in a build-and-observe phase.

The main remaining constraints are:

- restore generation access before collecting 12 same-context comparisons; the last Anthropic call was rejected for insufficient credit
- implement the trusted zero-X verifier; R1 and therefore R3 publishing remain blocked without it
- collect a 100-context real replay corpus, complete two-reader blind evaluation, and earn the elapsed R1/R2 observe/review gates before approved live publishing
- implement and calibrate an independent semantic critic before considering automatic live promotion
- V2's protocol lane now blocks price-dominated TVL moves with a bounded, derived DefiLlama token-history screen; the screen is not a deposit or inflow claim

## Project Documents

- `concept.md`
  - product north star and decision filter
- `AGENTS.md`
  - workspace and integration rules
- `docs/agent-workflow.md`
  - operator / workspace workflow
- `docs/plan.md`
  - implementation roadmap and review overlay

## Practical Direction

The near-term path is simple:

1. keep verification green and preserve non-publishing observe/shadow isolation
2. compare old and new judgments on the same real contexts; measure human approval and preference
3. earn the offline, observe, and review gates before approved live publishing
4. expand only after the character and evidence loop prove their value

If Pixymon becomes a recognizable character IP, the operator behind it becomes legible too.
