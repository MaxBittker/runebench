#!/bin/bash
# Single 30m skill sweep for the new Claude "fable" model.
#
# fable is API-key accessible (GA on the key, like opus-4-8) — no OAuth/Keychain
# dance like the OAuth-gated capture. Auth is the plain ANTHROPIC_API_KEY in .env.
# Rate card: $10/M input, $50/M output (see shared/pricing.ts).
#
# The model ID defaults to anthropic/claude-fable but can be overridden if the
# published string differs:
#   FABLE_MODEL='anthropic/claude-fable-5[1m]' scripts/run-fable-30m.sh
#
# Usage:
#   scripts/run-fable-30m.sh                 # all 16 skills
#   scripts/run-fable-30m.sh firemaking prayer   # re-run specific skills only
#
# Run `bun generate-tasks.ts` before launching.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

set -a; source .env 2>/dev/null || true; set +a
: "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY missing from .env}"

MODEL="${FABLE_MODEL:-anthropic/claude-fable-5}"

if [ "$#" -gt 0 ]; then
  SKILLS="$*"
else
  SKILLS="attack defence strength hitpoints ranged prayer magic woodcutting fishing mining cooking fletching crafting smithing firemaking thieving"
fi

TASK_FLAGS=()
for s in $SKILLS; do
  TASK_FLAGS+=(-i "${s}-xp-30m")
done

TS=$(date +%Y%m%d-%H%M%S)
JOB="skills-30m-fable-${TS}"
echo "JOB=$JOB (model=$MODEL)"

harbor run \
  -p tasks \
  "${TASK_FLAGS[@]}" \
  -a claude-code \
  -m "$MODEL" \
  --job-name "$JOB" \
  --env modal \
  --ek sandbox_timeout_secs=7200 \
  -n 16 -k 1 2>&1 | tee "/tmp/harbor-${JOB}.log"
