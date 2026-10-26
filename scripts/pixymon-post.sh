#!/bin/zsh
# Publish one operator-approved original: approve (fact-checked) -> 24h pilot authorization -> one X send.
# Run only after the operator has said which draft to post. Requires X credentials and a clean tree.
set -eu
cd "${0:A:h}/.."
id=${1:?usage: scripts/pixymon-post.sh <draftId> [operatorId]}
operator=${2:-${EDITORIAL_REVIEWER_ID:-Pixy7Crypto}}
export POST_PIPELINE_VERSION=v2 EDITORIAL_TRACKING_MODE=live TEST_MODE=false TEST_NO_EXTERNAL_CALLS=false SOCIAL_SURFACES_ENABLED=false SCHEDULER_MODE=false
ACTION_MODE=observe EDITORIAL_REVIEWER_ID=$operator node --import tsx scripts/editorial-review.ts --id "$id" --action approve --reason fact-checked
auth="data/editorial-v2/authorizations/pilot-$(date -u +%Y%m%dT%H%M%SZ).json"
ACTION_MODE=observe node --import tsx scripts/editorial-authorize-live.ts --pilot --output "$auth" --operator "$operator"
ACTION_MODE=live node --import tsx scripts/editorial-publish.ts --id "$id" --authorization "$auth"
