#!/bin/bash
# Run the magic-team benchmark: each run is ONE model controlling THREE bots
# via three concurrent OpenCode sessions (opencode_team_adapter).
# Score = highest Magic level on any account the team reaches in 30m.
#
# Usage:
#   run-magic-team.sh                 # all models
#   run-magic-team.sh -m opus48       # single model
#   run-magic-team.sh -k 4            # 4 trials per model
#   run-magic-team.sh --dry-run       # print harbor commands without launching
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/run-common.sh"

HORIZON="30m"

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
    -H|--horizon)  HORIZON="$2"; shift 2 ;;
    --dry-run)     DRY_RUN=1; shift ;;
    -h|--help)
      echo "Usage: run-magic-team.sh [-m model] [-k trials] [-H horizon] [--dry-run]"
      echo ""
      echo "Models: $ALL_MODEL_LABELS (default: all)"
      echo ""
      echo "Each trial runs one model as ALL THREE players of the cooperative"
      echo "magic-training challenge. Reward = highest Magic level on any account"
      echo "the team reaches within ${HORIZON} (0 = nobody trained magic)."
      exit 0
      ;;
    *)
      EXTRA_ARGS="$EXTRA_ARGS $1"; shift ;;
  esac
done

if [ -z "$SELECTED_MODELS" ]; then
  SELECTED_MODELS="$ALL_MODEL_LABELS"
fi

TASK="magic-team-${HORIZON}"
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

  # Every model runs through the team adapter for this task.
  AGENT_FLAG="--agent-import-path 'opencode_team_adapter:OpenCodeTeamAdapter'"

  JOB_NAME="magic-team-${label}-${TIMESTAMP}"
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

  echo "  Launching $model_name (team × $K_TRIALS trial(s)) → $LOG_FILE"
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
  echo "All magic-team runs complete. ($TOTAL models:$LAUNCHED)"
else
  echo "All runs finished. $FAILED of $TOTAL model(s) had errors."
fi
echo ""
echo "Next steps:"
echo "  bun extractors/extract-magic-team-results.ts"
