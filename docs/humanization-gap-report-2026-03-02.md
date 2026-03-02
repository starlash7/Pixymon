# Pixymon Humanization Gap Report (2026-03-02)

## Scope
- Goal: Compare current Pixymon post output quality against a Lobster-like standard.
- Focus: "human-feeling" output quality, not infra reliability or API stability.
- Run mode: local simulation only (`TEST_MODE=true`, `TEST_NO_EXTERNAL_CALLS=true`).

## Test Method
- Command profile:
  - `SCHEDULER_MODE=false`
  - `DAILY_ACTIVITY_TARGET=100`
  - `MAX_ACTIONS_PER_CYCLE=8`
  - `MAX_POSTS_PER_CYCLE=4`
  - `POST_MIN_INTERVAL_MINUTES=0`
  - `TOPIC_MAX_SAME_TAG_24H=8`
  - `TOPIC_BLOCK_CONSECUTIVE_TAG=false`
- Sample extraction:
  - Source: `/tmp/pixymon_report_posts.txt`
  - Evaluated sample size: 5 successful simulated posts

## Current Output Metrics
- Sample size: 5
- Average length: 149 chars
- Starts with explicit control labels (`철학 메모:` etc): 0/5
- Contains identity phrase `생명체다`: 2/5
- Contains meta tags (`철학 메모`, `메타 회고`, `상호작용 실험`, `짧은 우화`): 4/5
- Contains action-oriented line (`다음 확인 포인트`, `오늘 미션` etc): 5/5
- Contains explicit invalidation/falsification condition: 1/5
- Opening prefix duplication: 0/5

## Lobster Comparison
### Where Pixymon improved
- Repetition is much lower than before (opening prefix duplicates currently low).
- Price-only summaries are reduced.
- Action hints appear in most posts.

### Where Pixymon still lags
- Internal control tags still leak to surface text (`철학 메모`, `메타 회고`).
- Identity line pattern remains synthetic (`...생명체다` recurring).
- Action is often soft ("관찰", "확인") rather than decisive.
- Falsifiable claims are sparse; most posts remain interpretive commentary.
- Voice still feels template-first, not thought-first.

## Root Cause Map (Code)
- Identity sentence is lane-bound template and repeatedly emits `생명체다`:
  - `src/services/memory.ts` (`nextSelfNarrative`)
- Meta labels are generated as literal post text:
  - `src/services/engagement.ts` (`buildPreviewFallbackCandidates`)
  - `src/services/engagement/event-evidence.ts` (`buildEventEvidenceFallbackPost`)
- Humanization is post-cleaning oriented, not full rewrite oriented:
  - `src/services/engagement.ts` (`humanizeNarrativeDraft`)
- No hard gate for "must include decision + invalidation":
  - `src/services/engagement/quality.ts` currently checks duplication/quality, not decisive-action contract.

## Priority Backlog (Execution Order)
### P0 (must-have)
1. Hide control tags from final surface text.
   - Keep mode tags internal only.
   - Surface writer must output plain narrative without label prefixes.
2. Remove biological self template recurrence (`생명체다`) from default identity generator.
   - Replace with rotating first-person identity variants tied to concrete motive.
3. Add action contract gate.
   - Each post must include:
     - one thesis,
     - one next action,
     - one invalidation condition (what breaks this view).

### P1 (high impact)
1. Two-step writing pipeline:
   - Step A: `Plan JSON` only (internal schema).
   - Step B: `Surface Writer` (human prose only, no control tags).
2. Critic pass:
   - Reject if template leakage, soft hedge-only tone, or no falsification clause.
3. Memory anti-pattern debt:
   - Track overused phrase stems, block for next N cycles.

### P2 (polish)
1. Tone entropy tuning per lane (macro/regulation/protocol).
2. Long-arc continuity:
   - Refer to previous claim outcomes explicitly.
3. Narrative variation pack:
   - Add "mini-scene", "counterfactual", "question-chain" forms.

## Acceptance Criteria for "90% Human-like"
- Template leakage rate (`철학 메모`, `메타 회고`, `상호작용 실험`) <= 10%
- Biological identity phrase recurrence (`생명체다`) <= 5%
- Decisive-action contract pass rate >= 85%
- Explicit invalidation line rate >= 80%
- 24h opening-prefix duplicate rate <= 5%
- Manual blind-read test:
  - at least 7/10 posts judged "human-feeling" by reviewer

## Recommended Next Sprint (1 iteration)
1. Implement P0 gates and identity rewrite.
2. Implement Plan JSON + Surface Writer split.
3. Run 20-post local simulation and re-score against acceptance criteria.
4. Promote only if build/test pass and criteria >= target.
