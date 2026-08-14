#!/bin/bash
# Run the smith-team benchmark: each run is ONE model controlling THREE bots
# via three concurrent OpenCode sessions (opencode_team_adapter).
# Score = store value of the best single item the team smiths in 30m.
#
# Usage:
#   run-smith-team.sh                 # all models
#   run-smith-team.sh -m opus48       # single model
#   run-smith-team.sh -k 4            # 4 trials per model
#   run-smith-team.sh --dry-run       # print harbor commands without launching
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/run-common.sh"

HORIZON="30m"

# ── Defaults ──────────────────────────────────────────────────────
SELECTED_MODELS=""
K_TRIALS=1
TEAM_SIZE=3
SOLO=0
DRY_RUN=0
EXTRA_ARGS=""

# ── Parse args ────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    -m|--model)     SELECTED_MODELS="$SELECTED_MODELS $2"; shift 2 ;;
    -k|--k-trials)  K_TRIALS="$2"; shift 2 ;;
    -H|--horizon)   HORIZON="$2"; shift 2 ;;
    -n|--team-size) TEAM_SIZE="$2"; shift 2 ;;
    --solo)        SOLO=1; shift ;;
    --dry-run)     DRY_RUN=1; shift ;;
    -h|--help)
      echo "Usage: run-smith-team.sh [-m model] [-k trials] [-H horizon] [-n team-size] [--dry-run]"
      echo ""
      echo "Models: $ALL_MODEL_LABELS (default: all)"
      echo ""
      echo "Each trial runs one model as ALL THREE players of the cooperative"
      echo "smithing challenge. Reward = store value of the best single item"
      echo "the team smiths within ${HORIZON} (0 = nothing valid smithed)."
      exit 0
      ;;
    *)
      EXTRA_ARGS="$EXTRA_ARGS $1"; shift ;;
  esac
done

if [ -z "$SELECTED_MODELS" ]; then
  SELECTED_MODELS="$ALL_MODEL_LABELS"
fi

# n=3 is the canonical task; other sizes use the -n<N> variant dirs.
SIZE_SUFFIX=""
if [ "$TEAM_SIZE" != "3" ]; then SIZE_SUFFIX="-n${TEAM_SIZE}"; fi
# --solo: ONE OpenCode session controls all bots (no chat) — comparison
# condition vs the N-session team adapter. Job names gain a -solo marker.
SOLO_TAG=""
if [ "$SOLO" = "1" ]; then SOLO_TAG="-solo"; fi
TASK="smith-team-${HORIZON}${SIZE_SUFFIX}"
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

  # Every model runs through a team adapter for this task. OpenCode models
  # share the unified opencode team adapter; claude-code-only models (e.g.
  # hotteok EAP) keep the claude team adapter set by configure_model_env.
  # NOTE: models whose adapter carries _model_options (reasoning effort etc.)
  # need their OWN team subclass — the generic team adapter would drop them.
  case "$agent" in
    luna-xhigh-opencode) AGENT_FLAG="--agent-import-path 'luna_adapter:LunaXhighTeamAdapter'" ;;
    muse12-opencode) AGENT_FLAG="--agent-import-path 'muse12_adapter:Muse12TeamAdapter'" ;;
    *opencode*) AGENT_FLAG="--agent-import-path 'opencode_team_adapter:OpenCodeTeamAdapter'" ;;
  esac
  # Solo condition only exists for the opencode family (single-session adapter).
  # Models with _model_options need their own solo subclass (same gotcha as
  # the team adapters above).
  if [ "$SOLO" = "1" ]; then
    case "$agent" in
      luna-xhigh-opencode) AGENT_FLAG="--agent-import-path 'luna_adapter:LunaXhighSoloAdapter'" ;;
      *) AGENT_FLAG="--agent-import-path 'opencode_solo_adapter:OpenCodeSoloTeamAdapter'" ;;
    esac
  fi

  team_model_extra_args "$model_name"

  JOB_NAME="smith-team${SIZE_SUFFIX}${SOLO_TAG}-${label}-${TIMESTAMP}"
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
  echo "All smith-team runs complete. ($TOTAL models:$LAUNCHED)"
else
  echo "All runs finished. $FAILED of $TOTAL model(s) had errors."
fi
echo ""
echo "Next steps:"
echo "  bun extractors/extract-smith-team-results.ts"
