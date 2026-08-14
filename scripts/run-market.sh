#!/bin/bash
# Run the market benchmark: each run is ONE model controlling SIX bots
# (3 miners / 2 smiths / 1 alchemist) via six concurrent OpenCode sessions
# (opencode_team_adapter). Every bot scores INDIVIDUALLY on its final gold
# (inventory + bank coins at the end of the run); harbor reward = the total
# across all six.
#
# Usage:
#   run-market.sh                 # all models, 20m
#   run-market.sh -m gemini37flash
#   run-market.sh -k 4            # 4 trials per model
#   run-market.sh --dry-run       # print harbor commands without launching
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/run-common.sh"

HORIZON="20m"

# The market task is a fixed 3→2→1 role pyramid = 6 bots with single-letter
# names (a-c miners, d-e smiths, f alchemist) — must match MARKET_BOT_POOL in
# generate-tasks.ts. bot_names overrides the adapter's derived agenta..agentf.
TEAM_SIZE=6
MARKET_BOTS="a,b,c,d,e,f"

# ── Defaults ──────────────────────────────────────────────────────
SELECTED_MODELS=""
K_TRIALS=1
DRY_RUN=0
EXTRA_ARGS=""

# ── Parse args ────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    -m|--model)     SELECTED_MODELS="$SELECTED_MODELS $2"; shift 2 ;;
    -k|--k-trials)  K_TRIALS="$2"; shift 2 ;;
    -H|--horizon)   HORIZON="$2"; shift 2 ;;
    --dry-run)     DRY_RUN=1; shift ;;
    -h|--help)
      echo "Usage: run-market.sh [-m model] [-k trials] [-H horizon] [--dry-run]"
      echo ""
      echo "Models: $ALL_MODEL_LABELS (default: all)"
      echo ""
      echo "Each trial runs one model as ALL SIX players of the market"
      echo "challenge (3 miners / 2 smiths / 1 alchemist). Every player"
      echo "scores individually on final gold; reward = total across bots."
      exit 0
      ;;
    *)
      EXTRA_ARGS="$EXTRA_ARGS $1"; shift ;;
  esac
done

if [ -z "$SELECTED_MODELS" ]; then
  SELECTED_MODELS="$ALL_MODEL_LABELS"
fi

TASK="market-${HORIZON}"
SANDBOX_TIMEOUT=$(sandbox_timeout_for_horizon "$HORIZON")
RUN_TIMEOUT=$(run_timeout_for_horizon "$HORIZON")

load_env "$REPO_ROOT/.env"

# SKIP_REGEN=1 lets a caller that launches several invocations in parallel
# regenerate tasks/ once up front (the regen wipes tasks/ and would race).
if [ "$DRY_RUN" != "1" ] && [ "${SKIP_REGEN:-0}" != "1" ]; then
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

  # Every model runs through a team adapter for this task (one session per
  # bot). NOTE: models whose adapter carries _model_options (reasoning effort
  # etc.) need their OWN team subclass — the generic team adapter drops them.
  case "$agent" in
    luna-xhigh-opencode) AGENT_FLAG="--agent-import-path 'luna_adapter:LunaXhighTeamAdapter'" ;;
    muse12-opencode) AGENT_FLAG="--agent-import-path 'muse12_adapter:Muse12TeamAdapter'" ;;
    *opencode*) AGENT_FLAG="--agent-import-path 'opencode_team_adapter:OpenCodeTeamAdapter'" ;;
  esac

  team_model_extra_args "$model_name"

  JOB_NAME="market-${label}-${TIMESTAMP}"
  LOG_FILE="/tmp/harbor-${JOB_NAME}.log"

  CMD="$ENV_PREFIX harbor run \
    -p '$REPO_ROOT/tasks/$TASK' \
    $AGENT_FLAG \
    -m '$model' \
    --job-name '$JOB_NAME' \
    --env modal \
    --ek sandbox_timeout_secs=$SANDBOX_TIMEOUT \
    --ak run_timeout_sec=$RUN_TIMEOUT \
    --ak team_size=$TEAM_SIZE \
    --ak bot_names=$MARKET_BOTS \
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

  echo "  Launching $model_name (market × $K_TRIALS trial(s)) → $LOG_FILE"
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
  echo "All market runs complete. ($TOTAL models:$LAUNCHED)"
else
  echo "All runs finished. $FAILED of $TOTAL model(s) had errors."
fi
