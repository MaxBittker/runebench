#!/bin/bash
# Run the benchmark suite across models on Modal.
#
# Usage:
#   run.sh                    # all models, woodcutting-xp-10m
#   run.sh -t woodcutting-xp-5m
#   run.sh -m sonnet45        # single model
#   run.sh -n 2               # 2 trials per model
#   run.sh -c 4               # 4 concurrent trials
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/run-common.sh"

# ── Model definitions (agent|model-id|label) ────────────────────
ALL_MODELS="
claude-code|anthropic/claude-opus-4-6|opus
claude-code|anthropic/claude-sonnet-4-6|sonnet46
claude-code|anthropic/claude-sonnet-4-5|sonnet45
claude-code|anthropic/claude-haiku-4-5|haiku
codex|openai/gpt-5.3-codex|codex
codex|openai/gpt-5.4|gpt54
codex|openai/gpt-5.4-mini|gpt54mini
codex|openai/gpt-5.4-nano|gpt54nano
codex|openai/gpt-5.5|gpt55
gemini-cli|google/gemini-3-pro-preview|gemini
gemini-cli|google/gemini-3-flash-preview|geminiflash
glm-opencode|openrouter/z-ai/glm-5|glm
kimi-opencode|openrouter/moonshotai/kimi-k2.5|kimi
qwen3-opencode|openrouter/qwen/qwen3-coder-next|qwen3
qwen35-opencode|openrouter/qwen/qwen3.5-35b-a3b|qwen35

"

# ── Defaults ──────────────────────────────────────────────────────
TASK="woodcutting-xp-10m"
SELECTED_MODELS=""
N_TRIALS=1
CONCURRENCY=2
EXTRA_ARGS=""

# ── Parse args ────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    -t|--task)    TASK="$2"; shift 2 ;;
    -m|--model)   SELECTED_MODELS="$SELECTED_MODELS $2"; shift 2 ;;
    -n|--trials)  N_TRIALS="$2"; shift 2 ;;
    -c|--concurrency) CONCURRENCY="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: run.sh [-t task] [-m model] [-n trials] [-c concurrency]"
      echo ""
      echo "Models: opus, sonnet46, sonnet45, haiku, codex, gpt55, gpt54, gpt54mini, gpt54nano, gemini, geminiflash, glm, kimi, qwen3, qwen35 (default: all)"
      echo "Task:   any task dir name (default: woodcutting-xp-10m)"
      exit 0
      ;;
    *)
      EXTRA_ARGS="$EXTRA_ARGS $1"; shift ;;
  esac
done

# Default to all models if none specified
if [ -z "$SELECTED_MODELS" ]; then
  SELECTED_MODELS="sonnet46 sonnet45 opus haiku codex gpt55 gpt54 gpt54mini gpt54nano gemini geminiflash glm kimi qwen3 qwen35"
fi

load_env "$REPO_ROOT/.env"
GLM_KEY="${GLM_API_KEY:-}"

regenerate_tasks "$REPO_ROOT/generate-tasks.ts"

# ── Launch all models in parallel ─────────────────────────────────
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
PIDS=""

for name in $SELECTED_MODELS; do
  entry=$(lookup_model "$name" "$ALL_MODELS")
  if [ -z "$entry" ]; then
    echo "Unknown model: $name (available: opus, sonnet46, sonnet45, haiku, codex, gpt55, gpt54, gpt54mini, gpt54nano, gemini, geminiflash, glm, kimi, qwen3, qwen35)"
    exit 1
  fi

  IFS='|' read -r agent model label <<< "$entry"

  ENV_PREFIX=""
  AGENT_FLAG="-a '$agent'"
  if ! configure_model_env "$name" "$REPO_ROOT/agents" "$entry"; then
    continue
  fi

  JOB_NAME="${TASK}-${label}-${TIMESTAMP}"
  LOG_FILE="/tmp/harbor-${JOB_NAME}.log"

  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  Launching: $name ($model)"
  echo "  Task:      $TASK"
  echo "  Trials:    $N_TRIALS"
  echo "  Log:       $LOG_FILE"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  eval "$ENV_PREFIX harbor run \
    -p '$REPO_ROOT/tasks/$TASK' \
    $AGENT_FLAG \
    -m '$model' \
    --job-name '$JOB_NAME' \
    --env modal \
    --ek sandbox_timeout_secs=3600 \
    -n '$CONCURRENCY' \
    -k '$N_TRIALS' \
    $EXTRA_ARGS" > "$LOG_FILE" 2>&1 &

  PIDS="$PIDS $!"
  echo ""
done

echo "All models launched. Waiting for completion..."
echo "  PIDs: $PIDS"
echo ""

FAILED=0
for pid in $PIDS; do
  if ! wait "$pid"; then
    FAILED=$((FAILED + 1))
  fi
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$FAILED" -eq 0 ]; then
  echo "All runs complete."
else
  echo "All runs finished. $FAILED model(s) had errors."
fi

# Print summary from log files
for name in $SELECTED_MODELS; do
  entry=$(lookup_model "$name" "$ALL_MODELS")
  IFS='|' read -r agent model label <<< "$entry"
  LOG_FILE="/tmp/harbor-${TASK}-${label}-${TIMESTAMP}.log"
  if [ -f "$LOG_FILE" ]; then
    echo ""
    echo "── $name ──"
    tail -20 "$LOG_FILE"
  fi
done
