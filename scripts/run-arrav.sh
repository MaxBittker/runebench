#!/bin/bash
# Run the Shield of Arrav duo benchmark: each run is ONE model controlling
# TWO bots via two concurrent OpenCode sessions (opencode_duo_adapter).
# Score = seconds saved vs the 30m cap (first quest completion).
#
# Usage:
#   run-arrav.sh                 # all models
#   run-arrav.sh -m opus47       # single model
#   run-arrav.sh -k 4            # 4 trials per model
#   run-arrav.sh --dry-run       # print harbor commands without launching
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/run-common.sh"

TASK="arrav-duo-45m"
HORIZON="45m"

# ── Defaults ──────────────────────────────────────────────────────
SELECTED_MODELS=""
K_TRIALS=1
DRY_RUN=0
EXTRA_ARGS=""

# ── Parse args ────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    -m|--model)    SELECTED_MODELS="$SELECTED_MODELS $2"; shift 2 ;;
    -k|--k-trials) K_TRIALS="$2"; shift 2 ;;
    --dry-run)     DRY_RUN=1; shift ;;
    -h|--help)
      echo "Usage: run-arrav.sh [-m model] [-k trials] [--dry-run]"
      echo ""
      echo "Models: $ALL_MODEL_LABELS (default: all)"
      echo ""
      echo "Each trial runs one model as BOTH players of the two-player"
      echo "Shield of Arrav quest. Reward = ${HORIZON} cap minus first"
      echo "completion time, in seconds (0 = did not finish)."
      exit 0
      ;;
    *)
      EXTRA_ARGS="$EXTRA_ARGS $1"; shift ;;
  esac
done

if [ -z "$SELECTED_MODELS" ]; then
  SELECTED_MODELS="$ALL_MODEL_LABELS"
fi

SANDBOX_TIMEOUT=$(sandbox_timeout_for_horizon "$HORIZON")
RUN_TIMEOUT=$(run_timeout_for_horizon "$HORIZON")

load_env "$REPO_ROOT/.env"

if [ "$DRY_RUN" != "1" ]; then
  regenerate_tasks "$REPO_ROOT/generate-tasks.ts"
fi

# ── Launch all models in parallel (one sandbox each, like run.sh) ──
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
PIDS=""
LAUNCHED=""

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

  # Every model runs through the duo adapter for this task. Claude-code-only
  # models (e.g. hotteok EAP) have no duo adapter yet — skip them.
  case "$agent" in
    *opencode*) AGENT_FLAG="--agent-import-path 'opencode_duo_adapter:OpenCodeDuoAdapter'" ;;
    *) echo "  Skipping $model_name (no OpenCode access; duo adapter is OpenCode-only)"; continue ;;
  esac

  JOB_NAME="arrav-duo-${label}-${TIMESTAMP}"
  LOG_FILE="/tmp/harbor-${JOB_NAME}.log"

  CMD="$ENV_PREFIX harbor run \
    -p '$REPO_ROOT/tasks/$TASK' \
    $AGENT_FLAG \
    -m '$model' \
    --job-name '$JOB_NAME' \
    --env modal \
    --ek sandbox_timeout_secs=$SANDBOX_TIMEOUT \
    --ak run_timeout_sec=$RUN_TIMEOUT \
    $AGENT_ENV_FLAGS \
    -n 4 \
    -k $K_TRIALS \
    $EXTRA_ARGS $MODEL_EXTRA_ARGS"

  if [ "$DRY_RUN" = "1" ]; then
    echo "── $model_name ──"
    echo "$CMD"
    echo ""
    continue
  fi

  echo "  Launching $model_name (duo × $K_TRIALS trial(s)) → $LOG_FILE"
  eval "$CMD" > "$LOG_FILE" 2>&1 &
  PIDS="$PIDS $!"
  LAUNCHED="$LAUNCHED $model_name"
done

if [ "$DRY_RUN" = "1" ]; then
  exit 0
fi

echo ""
echo "All models launched in parallel. Waiting for completion..."

FAILED=0
TOTAL=0
for pid in $PIDS; do
  TOTAL=$((TOTAL + 1))
  if ! wait "$pid"; then
    FAILED=$((FAILED + 1))
  fi
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$FAILED" -eq 0 ]; then
  echo "All arrav-duo runs complete. ($TOTAL models:$LAUNCHED)"
else
  echo "All runs finished. $FAILED of $TOTAL model(s) had errors."
fi
echo ""
echo "Next steps:"
echo "  bun extractors/extract-arrav-results.ts"
