#!/bin/bash
# Single 30m skill sweep for Claude Opus 4.8 — one effort mode per invocation,
# so two copies can run in PARALLEL (default + max) as separate background procs.
#
# Usage:
#   scripts/run-opus48-30m.sh default [skills...]   -> job 'skills-30m-opus48-<ts>'
#   scripts/run-opus48-30m.sh max     [skills...]   -> job 'skills-30m-opus48-max-<ts>' (--ak reasoning_effort=max)
#
# Does NOT regenerate tasks — run `bun generate-tasks.ts` once before launching
# (two parallel procs must not race on the tasks/ dir).
#
# claude-code agent, ANTHROPIC_API_KEY auth (claude-opus-4-8 is GA on the key).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

MODE="${1:-default}"; shift || true
set -a; source .env 2>/dev/null || true; set +a
: "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY missing from .env}"

EFFORT_ARGS=()
case "$MODE" in
  default) LABEL="opus48" ;;
  max)     LABEL="opus48-max"; EFFORT_ARGS=(--ak reasoning_effort=max) ;;
  *) echo "Unknown mode '$MODE' (use: default | max)"; exit 1 ;;
esac

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
JOB="skills-30m-${LABEL}-${TS}"
echo "JOB=$JOB (mode=$MODE)"

harbor run \
  -p tasks \
  "${TASK_FLAGS[@]}" \
  -a claude-code \
  -m anthropic/claude-opus-4-8 \
  --job-name "$JOB" \
  --env modal \
  --ek sandbox_timeout_secs=7200 \
  -n 16 -k 1 \
  "${EFFORT_ARGS[@]+"${EFFORT_ARGS[@]}"}" 2>&1 | tee "/tmp/harbor-${JOB}.log"
