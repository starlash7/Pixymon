#!/bin/zsh
# Collection cycle for a scheduler (launchd/cron). It creates candidates (PIXYMON_CYCLE_TRACKING=live
# by default, or shadow). With PIXYMON_AUTO_PUBLISH=true a critic-passed live candidate is published
# immediately through editorial:publish --auto (daily caps, STOP file, clean tree); otherwise never.
# - every run: close due 24h/72h checks on time (a missed window cannot be judged later)
# - at PIXYMON_SHADOW_COLLECT_HOURS (UTC): one shadow collection. PIXYMON_SHADOW_PROVIDER selects
#   anthropic (default; the same writer that will publish, under the daily USD/request caps, no
#   retry) or gemini (free tier; retried once on a lighter model pair when overloaded).
# Collection runs in observe mode; output is appended to data/shadow-cycle.log.
set -u
cd "${0:A:h}/.." || exit 1
mkdir -p data
LOG=data/shadow-cycle.log
log() { print -r -- "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >> "$LOG"; }

TRACKING=${PIXYMON_CYCLE_TRACKING:-live}
[[ "$TRACKING" == live || "$TRACKING" == shadow ]] || { log "invalid PIXYMON_CYCLE_TRACKING=$TRACKING"; exit 1; }
export ACTION_MODE=observe EDITORIAL_TRACKING_MODE=$TRACKING POST_PIPELINE_VERSION=v2
export TEST_MODE=false TEST_NO_EXTERNAL_CALLS=false SOCIAL_SURFACES_ENABLED=false SCHEDULER_MODE=false
PROVIDER=${PIXYMON_SHADOW_PROVIDER:-anthropic}
[[ "$PROVIDER" == anthropic || "$PROVIDER" == gemini ]] || { log "invalid PIXYMON_SHADOW_PROVIDER=$PROVIDER"; exit 1; }
export EDITORIAL_MODEL_PROVIDER=$PROVIDER

followups=$(node --import tsx scripts/editorial-followups.ts 2>&1)
log "followups exit=$? ${followups//$'\n'/ | }"

# Replies to people who mention or reply to Pixymon; the poll itself is throttled and budgeted.
if [[ "${PIXYMON_AUTO_PUBLISH:-false}" == true ]]; then
  mentions=$(ACTION_MODE=live node --import tsx scripts/editorial-mentions.ts 2>&1 | grep -v "LLM-BUDGET")
  [[ "$mentions" == *"polled=false"* ]] || log "mentions :: ${mentions//$'\n'/ | }"
  # The trainer's own posts, read twice a day at most, become material for thoughts (X forbids replying).
  trainer=$(ACTION_MODE=live node --import tsx scripts/editorial-trainer.ts 2>&1 | grep -v "LLM-BUDGET")
  [[ "$trainer" == *"polled=false"* ]] || log "trainer :: ${trainer//$'\n'/ | }"
fi

# Thought-first posts: Pixymon's own musings, at most PIXYMON_THOUGHT_DAILY_LIMIT a day, 4h apart, local daytime.
if [[ "${PIXYMON_AUTO_PUBLISH:-false}" == true ]]; then
  thought=$(ACTION_MODE=live node --import tsx scripts/editorial-thought.ts 2>&1 | grep -v "LLM-BUDGET")
  [[ "$thought" == *"skip reason="* && "$thought" != *"graded"* ]] || log "thought :: ${thought//$'\n'/ | }"
fi

hour=$(date -u +%H)
case " ${PIXYMON_SHADOW_COLLECT_HOURS:-01 09 17} " in
  *" $hour "*) ;;
  *) exit 0 ;;
esac

if [[ "$PROVIDER" == anthropic ]]; then
  # Paid: one attempt per scheduled hour; the request wrapper enforces ANTHROPIC_DAILY_MAX_USD.
  out=$(node --import tsx scripts/editorial-collect.ts 2>&1)
  log "collect provider=anthropic :: ${out//$'\n'/ | }"
  # Operator-enabled auto mode: publish a fresh, critic-passed live candidate right away (daily caps apply).
  if [[ "${PIXYMON_AUTO_PUBLISH:-false}" == true && "$TRACKING" == live && "$out" =~ 'draft=(action_[a-z0-9-]+)' ]]; then
    id=$match[1]
    pub=$(ACTION_MODE=live node --import tsx scripts/editorial-publish.ts --id "$id" --auto 2>&1)
    log "auto-publish $id :: ${pub//$'\n'/ | }"
  fi
  exit 0
fi

collect() {
  local out
  out=$(GEMINI_EDITORIAL_MODEL=$1 GEMINI_CRITIC_MODEL=$2 node --import tsx scripts/editorial-collect.ts 2>&1 | grep -v 'willRetry":true')
  log "collect writer=$1 critic=$2 :: ${out//$'\n'/ | }"
  # Retry only when the provider was unavailable, not when gates said no-post.
  [[ "$out" =~ "no-post stage=[a-z-]+ reason=[a-z-]*(model-error|gemini-|scope-critic)" ]] && return 1
  return 0
}
# Free-tier quotas are 20 requests per model per day; the critic uses a lite model by default.
collect "${GEMINI_EDITORIAL_MODEL:-gemini-3.5-flash}" "${GEMINI_CRITIC_MODEL:-gemini-3.5-flash-lite}" ||
  collect gemini-3.5-flash-lite gemini-3.1-flash-lite
