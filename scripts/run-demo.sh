#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
export HF_HOME="${HF_HOME:-$HOME/.cache/huggingface}"
export HF_HUB_CACHE="${HF_HUB_CACHE:-$HF_HOME/hub}"
export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
printf 'LVX full app demo: http://127.0.0.1:%s\n' "${PORT:-8790}"
exec node scripts/demo-app.mjs "$@"
