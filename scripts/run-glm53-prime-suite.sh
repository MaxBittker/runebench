#!/bin/bash
# GLM-5.3 via OpenRouter → PrimeIntellect endpoint, our OpenCode harness, image v71:
# the harness-only counterpart to PrimeIntellect's published prime-agent run
# (analysis/primeintellect-traces/). Covers the same 40 tasks they ran, n=1 like
# theirs (--reps N adds extra 30m replicates).
#
# Default: jobs run one after another (≤16 concurrent agents) — PI peaked at 8,
# and stacking jobs loads the shared endpoint well past what their run saw.
# --parallel launches every job at once (launch windows staggered by STAGGER s,
# default 240, to avoid Modal app-claim contention); per-job logs in $LOG_DIR.
#
# Usage: scripts/run-glm53-prime-suite.sh [--parallel] [--reps N] [--skip-30m] [--skip-15m] [--skip-gold]
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPS=1
RUN_30M=1; RUN_15M=1; RUN_GOLD=1
PARALLEL=0
STAGGER="${STAGGER:-240}"
LOG_DIR="${LOG_DIR:-/tmp/glm53-prime-suite-$(date +%Y%m%d-%H%M%S)}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --reps) REPS="$2"; shift 2 ;;
    --skip-30m) RUN_30M=0; shift ;;
    --skip-15m) RUN_15M=0; shift ;;
    --skip-gold) RUN_GOLD=0; shift ;;
    --parallel) PARALLEL=1; shift ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

step() { echo ""; echo "=== [$(date +%H:%M:%S)] $* ==="; }

# run <log-name> <cmd...>: sequential, or backgrounded with a staggered launch window.
mkdir -p "$LOG_DIR"
LAUNCHED=0
run() {
  local name="$1"; shift
  if [ "$PARALLEL" = 1 ]; then
    [ "$LAUNCHED" -gt 0 ] && sleep "$STAGGER"
    echo "[$(date +%H:%M:%S)] launching $name → $LOG_DIR/$name.log"
    "$@" > "$LOG_DIR/$name.log" 2>&1 &
  else
    "$@" 2>&1 | tee "$LOG_DIR/$name.log"
  fi
  LAUNCHED=$((LAUNCHED + 1))
}

if [ "$RUN_30M" = 1 ]; then
  for i in $(seq 1 "$REPS"); do
    step "30m skills, replicate $i/$REPS"
    run "30m-rep$i" "$SCRIPT_DIR/run-skills-30m.sh" -m glm53-prime
  done
fi
if [ "$RUN_15M" = 1 ]; then
  step "15m skills"
  run 15m "$SCRIPT_DIR/run-skills-15m.sh" -m glm53-prime
fi
if [ "$RUN_GOLD" = 1 ]; then
  step "gold 15m (4 conditions)"
  run gold-15m "$SCRIPT_DIR/run-gold.sh" -m glm53-prime --horizon 15m
  step "gold 30m (4 conditions)"
  run gold-30m "$SCRIPT_DIR/run-gold.sh" -m glm53-prime --horizon 30m
fi
wait
step "done (logs: $LOG_DIR)"
