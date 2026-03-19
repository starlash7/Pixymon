# Pixymon Operating Plan

Last updated: 2026-03-19

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

Before more prompt tuning, prioritize:

1. planner rewrite
2. fallback auto-publish reduction
3. social path redesign that matches real X entitlement constraints
