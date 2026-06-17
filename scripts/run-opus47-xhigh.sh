#!/bin/bash
# Opus 4.7 @ xhigh reasoning effort, all 16 skills, 30m horizon.
# Produces a distinct 'opus47-xhigh' row (the committed opus47 row is default effort).
#
# claude-code agent, ANTHROPIC_API_KEY auth — no OAuth/concurrency issue, so -n 16 is fine.
# xhigh is already in harbor's claude_code.py reasoning_effort choices (patched locally).
#
# Optional: pass specific skills as args to re-run only those (e.g. `... firemaking prayer`).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

set -a; source .env 2>/dev/null || true; set +a
: "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY missing from .env}"

TS=$(date +%Y%m%d-%H%M%S)
JOB="skills-30m-opus47-xhigh-${TS}"
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
harbor run \
  -p tasks \
  "${TASK_FLAGS[@]}" \
  -a claude-code \
  -m anthropic/claude-opus-4-7 \
  --job-name "$JOB" \
  --env modal \
  --ek sandbox_timeout_secs=7200 \
  -n 16 -k 1 \
  --ak reasoning_effort=xhigh 2>&1 | tee "/tmp/harbor-${JOB}.log"
