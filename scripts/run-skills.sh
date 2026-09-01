#!/bin/bash
# Run skill XP benchmarks across models for a given horizon.
#
# Models run sequentially to avoid Modal App lock contention.
# Within each model, harbor runs skills concurrently (-n 16).
#
# Usage:
#   run-skills.sh                          # 15m, all models, all skills
#   run-skills.sh --horizon 30m            # 30m horizon
#   run-skills.sh -m haiku                 # single model
#   run-skills.sh -s woodcutting           # single skill
#   run-skills.sh -k 4                     # 4 trials (best-of-K)
#   run-skills.sh --dry-run                # print harbor commands without launching
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/run-common.sh"

# ── Defaults ──────────────────────────────────────────────────────
HORIZON="15m"
SELECTED_MODELS=""
SELECTED_SKILLS=""
K_TRIALS=1
DRY_RUN=0
EXTRA_ARGS=""

# ── Parse args ────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --horizon)    HORIZON="$2"; shift 2 ;;
    -m|--model)   SELECTED_MODELS="$SELECTED_MODELS $2"; shift 2 ;;
    -s|--skill)   SELECTED_SKILLS="$SELECTED_SKILLS $2"; shift 2 ;;
    -k|--k-trials) K_TRIALS="$2"; shift 2 ;;
    --dry-run)    DRY_RUN=1; shift ;;
    -h|--help)
      echo "Usage: run-skills.sh [--horizon 15m|30m] [-m model] [-s skill] [-k trials] [--dry-run]"
      echo ""
      echo "Models:  $ALL_MODEL_LABELS (default: all)"
      echo "Skills:  $ALL_SKILLS (default: all sixteen)"
      echo "Horizon: 15m or 30m (default: 15m)"
      exit 0
      ;;
    *)
      EXTRA_ARGS="$EXTRA_ARGS $1"; shift ;;
  esac
done

case "$HORIZON" in
  15m|30m) ;;
  *) echo "Unsupported horizon: $HORIZON (use 15m or 30m)"; exit 1 ;;
esac

if [ -z "$SELECTED_MODELS" ]; then
  SELECTED_MODELS="$ALL_MODEL_LABELS"
fi
if [ -z "$SELECTED_SKILLS" ]; then
  SELECTED_SKILLS="$ALL_SKILLS"
fi

SANDBOX_TIMEOUT=$(sandbox_timeout_for_horizon "$HORIZON")
RUN_TIMEOUT=$(run_timeout_for_horizon "$HORIZON")

load_env "$REPO_ROOT/.env"

if [ "$DRY_RUN" != "1" ]; then
  regenerate_tasks "$REPO_ROOT/generate-tasks.ts"
fi

# ── Run models sequentially (avoid Modal App lock contention) ────────
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
TOTAL_MODELS=0
TOTAL_FAILED=0

for model_name in $SELECTED_MODELS; do
  entry=$(lookup_model "$model_name" "$ALL_MODELS")
  if [ -z "$entry" ]; then
    echo "Unknown model: $model_name (available: $ALL_MODEL_LABELS)"
    exit 1
  fi

  IFS='|' read -r agent model label <<< "$entry"

  if ! configure_model_env "$model_name" "$REPO_ROOT/agents" "$entry"; then
    continue
  fi

  # Build include flags for selected skills (dataset mode: one harbor process
  # per model; -i filters within the -p dataset).
  TASK_FLAGS=""
  for skill in $SELECTED_SKILLS; do
    TASK_FLAGS="$TASK_FLAGS -i '${skill}-xp-${HORIZON}'"
  done

  JOB_NAME="skills-${HORIZON}-${label}-${TIMESTAMP}"
  LOG_FILE="/tmp/harbor-${JOB_NAME}.log"
  N_SKILLS=$(echo $SELECTED_SKILLS | wc -w | tr -d ' ')

  CMD="$ENV_PREFIX harbor run \
    -p '$REPO_ROOT/tasks' \
    $TASK_FLAGS \
    $AGENT_FLAG \
    -m '$model' \
    --job-name '$JOB_NAME' \
    --env modal \
    --ek sandbox_timeout_secs=$SANDBOX_TIMEOUT \
    --ak run_timeout_sec=$RUN_TIMEOUT \
    $AGENT_ENV_FLAGS \
    -n 16 \
    -k $K_TRIALS \
    $EXTRA_ARGS $MODEL_EXTRA_ARGS"

  if [ "$DRY_RUN" = "1" ]; then
    echo "── $model_name ──"
    echo "$CMD"
    echo ""
    continue
  fi

  TOTAL_MODELS=$((TOTAL_MODELS + 1))
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  [$TOTAL_MODELS] $model_name ($N_SKILLS skills × $HORIZON)"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  if ! eval "$CMD" 2>&1 | tee "$LOG_FILE"; then
    TOTAL_FAILED=$((TOTAL_FAILED + 1))
  fi
done

if [ "$DRY_RUN" = "1" ]; then
  exit 0
fi

# ── Print summary ─────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$TOTAL_FAILED" -eq 0 ]; then
  echo "All skill benchmarks complete. ($TOTAL_MODELS models × $HORIZON)"
else
  echo "All runs finished. $TOTAL_FAILED of $TOTAL_MODELS model(s) had errors."
fi
echo ""
echo "Next steps:"
echo "  bun scripts/postprocess-costs.ts"
echo "  bun extractors/extract-skill-results.ts --horizon $HORIZON"
echo "  open views/graph-skills.html"
