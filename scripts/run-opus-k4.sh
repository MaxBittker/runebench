#!/bin/bash
# Run all three opus models (4.5 / 4.6 / 4.7) on all skills + all gold conditions
# at k=4, 30m horizon. Skills first, then gold — serial to avoid Modal app-lock
# contention. Logs to /tmp/opus-k4-<timestamp>.log.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

TS=$(date +%Y%m%d-%H%M%S)
LOG="/tmp/opus-k4-${TS}.log"

echo "Opus 4.5/4.6/4.7 x k=4 x 30m (skills + gold) starting at ${TS}" | tee "$LOG"
echo "Log: $LOG"

{
  echo ""
  echo "========== SKILLS-30m =========="
  "$SCRIPT_DIR/run-skills-30m.sh" -m opus47 -m opus -m opus45 -k 4

  echo ""
  echo "========== GOLD-30m =========="
  "$SCRIPT_DIR/run-gold.sh" --horizon 30m -m opus47 -m opus -m opus45 -k 4

  echo ""
  echo "========== POSTPROCESS =========="
  bun "$REPO_ROOT/scripts/postprocess-costs.ts" || true

  echo ""
  echo "========== ANALYSIS =========="
  bun "$REPO_ROOT/scripts/analyze-opus-k4.ts" --ts "$TS" || true

  echo ""
  echo "DONE at $(date +%Y%m%d-%H%M%S)"
} 2>&1 | tee -a "$LOG"
