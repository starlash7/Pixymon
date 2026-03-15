
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

As of `main`, Pixymon has:

- a `feed -> digest -> evolve -> plan -> act -> reflect` loop
- Korean-first post / quote / reply generation
- onchain nutrient ingestion and digest scoring
- shared context reuse across surfaces
- Anthropic and X API budget guards
- Anthropic prompt caching and surface-level model routing
- narrative observation logs and phrase-audit summaries
- batch-ready reflection jobs that can feed memory back into the character state
- safer reply target selection for trend replies
- structural fallback planning when direct news events are weak

The current phase is not "add more templates".
It is:

- run slowly in production
- observe actual outputs
- fix real failure modes from logs and audits

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

### Core Loop

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

### Supporting Loops

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

- `src/services/engagement.ts`
  - main planning and action loop
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

Use slow production first.
The goal is stable runtime, better posts, and clean audit logs, not brute-force volume.

Recommended baseline:

```env
TEST_MODE=false
SCHEDULER_MODE=true
DAILY_ACTIVITY_TARGET=8
POST_MIN_INTERVAL_MINUTES=60
POST_LANGUAGE=ko
REPLY_LANGUAGE_MODE=match

X_API_DAILY_MAX_USD=0.50
ANTHROPIC_DAILY_MAX_USD=0.50
TOTAL_DAILY_MAX_USD=1.00

TREND_TWEET_MIN_SOURCE_TRUST=0.45
TREND_TWEET_MIN_ENGAGEMENT=12
```

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

## Development

Install:

```bash
npm ci
```

Local safe rehearsal:

```bash
TEST_MODE=true SCHEDULER_MODE=false npm run dev
```

Build:

```bash
npm run build
```

Test:

```bash
npm test
```

Tests run with isolated `.test-data/` storage so local production memory and audit files are not mutated during CI-like checks.

## Current Constraints

Pixymon is still in a build-and-observe phase.

The main remaining constraints are:

- runtime reliability across long local sessions
- reply volume staying low because target safety filters are strict
- some fallback posts still being more functional than truly memorable
- planner quality still needs tightening around event/evidence contracts under weak news conditions

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

1. keep Pixymon running reliably
2. observe 1-2 days of real outputs
3. patch only what shows up in logs, memory, and narrative audits
4. push Pixymon toward character gravity, not just automation throughput

If Pixymon becomes a recognizable character IP, the operator behind it becomes legible too.
