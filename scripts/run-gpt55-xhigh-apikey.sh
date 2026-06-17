#!/bin/bash
# One-off: gpt-5.5 @ xhigh effort, all 16 skills, 30m horizon, API-key auth.
#
# Why this exists (not the normal run-skills-30m.sh path):
#   run-common.sh forces gpt55 onto ChatGPT OAuth (agents/auth.json). Under
#   -n 16 concurrency that breaks two ways:
#     1. 16 codex procs refresh the same single-use OAuth refresh token ->
#        401 refresh_token_reused (NonZeroAgentExitCodeError).
#     2. codex_adapter.py writes ONE shared auth tempfile; early trials unlink
#        it in finally -> the rest get "CODEX_AUTH_JSON_PATH non-existent" (ValueError).
#   API-key auth (OPENAI_API_KEY) sidesteps both: no token refresh, no tempfile.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

set -a; source .env 2>/dev/null || true; set +a
: "${OPENAI_API_KEY:?OPENAI_API_KEY missing from .env}"

# Make sure no OAuth path leaks in -> forces the adapter's API-key branch.
unset CODEX_AUTH_JSON_B64 CODEX_AUTH_JSON_PATH || true

TS=$(date +%Y%m%d-%H%M%S)
JOB="skills-30m-gpt55-apikey-${TS}"
# Optional: pass specific skills as args to re-run only those (e.g. `... firemaking prayer`).
# No args = all 16 skills.
if [ "$#" -gt 0 ]; then
  SKILLS="$*"
else
  SKILLS="attack defence strength hitpoints ranged prayer magic woodcutting fishing mining cooking fletching crafting smithing firemaking thieving"
fi

TASK_FLAGS=()
for s in $SKILLS; do
  TASK_FLAGS+=(-i "${s}-xp-30m")
done

echo "JOB=$JOB"
PYTHONPATH=agents harbor run \
  -p tasks \
  "${TASK_FLAGS[@]}" \
  --agent-import-path codex_adapter:CodexWithTimeout \
  -m openai/gpt-5.5 \
  --job-name "$JOB" \
  --env modal \
  --ek sandbox_timeout_secs=7200 \
  -n 16 -k 1 \
  --ak reasoning_effort=xhigh \
  --ak run_timeout_sec=1900 2>&1 | tee "/tmp/harbor-${JOB}.log"
