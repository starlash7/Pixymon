#!/bin/zsh
set -euo pipefail

ROOT_DIR="/Users/sungwoo/conductor/workspaces/pixymon/amsterdam"

cd "$ROOT_DIR"
mkdir -p logs

if [ -f ".env" ]; then
  set -a
  source ".env"
  set +a
fi

export PATH="/Users/sungwoo/.nvm/versions/node/v20.12.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

exec /Users/sungwoo/.nvm/versions/node/v20.12.0/bin/node dist/index.js
