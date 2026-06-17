#!/bin/bash
# Claude Opus 4.8, all 16 skills, 15m horizon — two sweeps:
#   1. default thinking         -> job 'skills-15m-opus48-<ts>'      (row: opus48)
#   2. highest reasoning effort -> job 'skills-15m-opus48-max-<ts>'  (row: opus48-max)
#
# claude-code agent, ANTHROPIC_API_KEY auth (claude-opus-4-8 is GA on the
# regular key — no OAuth needed). 'max' is the top of harbor's reasoning_effort
# enum (low/medium/high/xhigh/max; patched locally — see CLAUDE memory).
#
# Sweeps run sequentially: two harbor processes must not share the __harbor__
# Modal App at once. Within each sweep, harbor runs skills concurrently (-n 16).
#
# Optional: pass specific skills as args to re-run only those (e.g. `... firemaking prayer`).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

set -a; source .env 2>/dev/null || true; set +a
: "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY missing from .env}"

if [ "$#" -gt 0 ]; then
  SKILLS="$*"
else
  SKILLS="attack defence strength hitpoints ranged prayer magic woodcutting fishing mining cooking fletching crafting smithing firemaking thieving"
fi

TASK_FLAGS=()
for s in $SKILLS; do
  TASK_FLAGS+=(-i "${s}-xp-15m")
done

echo "Regenerating benchmark tasks..."
bun generate-tasks.ts
echo ""

run_sweep() {
  local job="$1"; shift   # remaining args are extra harbor flags (e.g. --ak reasoning_effort=max)
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  JOB=$job"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  harbor run \
    -p tasks \
    "${TASK_FLAGS[@]}" \
    -a claude-code \
    -m anthropic/claude-opus-4-8 \
    --job-name "$job" \
    --env modal \
    --ek sandbox_timeout_secs=3600 \
    -n 16 -k 1 \
    "$@" 2>&1 | tee "/tmp/harbor-${job}.log"
}

TS=$(date +%Y%m%d-%H%M%S)

# 1) Default thinking (no reasoning_effort override)
run_sweep "skills-15m-opus48-${TS}"

# 2) Highest reasoning effort
run_sweep "skills-15m-opus48-max-${TS}" --ak reasoning_effort=max

echo ""
echo "Both sweeps complete."
echo "Next steps:"
echo "  bun extractors/extract-skill-results.ts --horizon 15m"
echo "  open views/graph-skills.html?horizon=15m"
