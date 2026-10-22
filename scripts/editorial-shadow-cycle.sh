#!/bin/zsh
# Shadow cycle for a scheduler (launchd/cron), never live:
# - every run: close due 24h/72h checks on time (a missed window cannot be judged later)
# - at PIXYMON_SHADOW_COLLECT_HOURS (UTC): one shadow collection. PIXYMON_SHADOW_PROVIDER selects
#   anthropic (default; the same writer that will publish, under the daily USD/request caps, no
#   retry) or gemini (free tier; retried once on a lighter model pair when overloaded).
# Observe mode, shadow ledger, no X client; output is appended to data/shadow-cycle.log.
set -u
cd "${0:A:h}/.." || exit 1
mkdir -p data
LOG=data/shadow-cycle.log
log() { print -r -- "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >> "$LOG"; }

export ACTION_MODE=observe EDITORIAL_TRACKING_MODE=shadow POST_PIPELINE_VERSION=v2
export TEST_MODE=false TEST_NO_EXTERNAL_CALLS=false SOCIAL_SURFACES_ENABLED=false SCHEDULER_MODE=false
PROVIDER=${PIXYMON_SHADOW_PROVIDER:-anthropic}
[[ "$PROVIDER" == anthropic || "$PROVIDER" == gemini ]] || { log "invalid PIXYMON_SHADOW_PROVIDER=$PROVIDER"; exit 1; }
export EDITORIAL_MODEL_PROVIDER=$PROVIDER

followups=$(node --import tsx scripts/editorial-followups.ts 2>&1)
log "followups exit=$? ${followups//$'\n'/ | }"

hour=$(date -u +%H)
case " ${PIXYMON_SHADOW_COLLECT_HOURS:-01 09 17} " in
  *" $hour "*) ;;
  *) exit 0 ;;
esac

if [[ "$PROVIDER" == anthropic ]]; then
  # Paid: one attempt per scheduled hour; the request wrapper enforces ANTHROPIC_DAILY_MAX_USD.
  out=$(node --import tsx scripts/editorial-collect.ts 2>&1)
  log "collect provider=anthropic :: ${out//$'\n'/ | }"
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
