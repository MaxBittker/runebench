#!/bin/bash
# Claude Sonnet 5 @ xhigh reasoning effort, all 16 skills, 30m horizon.
# Produces a distinct 'sonnet5-xhigh' row (run-skills-30m.sh -m sonnet5 is default effort=high).
#
# Sibling of the default sonnet5 run: same model (anthropic/claude-sonnet-5), same API-key
# auth (-n 16 is fine, Sonnet 5 is GA on a standard ANTHROPIC_API_KEY org), but adds
# --ak reasoning_effort=xhigh. xhigh is in harbor's claude_code.py reasoning_effort choices
# (patched locally — re-apply after harbor upgrades; see memory reference_harbor_effort_enum).
#
# Job name carries the dash-bounded token `sonnet5-xhigh` so the extractor's detectModel keys
# it to its own row (KNOWN_MODELS lists sonnet5-xhigh BEFORE sonnet5).
#
# Optional: pass specific skills as args to re-run only those (e.g. `... firemaking prayer`).
# Run `bun generate-tasks.ts` before launching.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

set -a; source .env 2>/dev/null || true; set +a
: "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY missing from .env}"

MODEL="${SONNET5_MODEL:-anthropic/claude-sonnet-5}"

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
JOB="skills-30m-sonnet5-xhigh-${TS}"
echo "JOB=$JOB (model=$MODEL, effort=xhigh)"

harbor run \
  -p tasks \
  "${TASK_FLAGS[@]}" \
  -a claude-code \
  -m "$MODEL" \
  --job-name "$JOB" \
  --env modal \
  --ek sandbox_timeout_secs=7200 \
  -n 16 -k 1 \
  --ak reasoning_effort=xhigh 2>&1 | tee "/tmp/harbor-${JOB}.log"
