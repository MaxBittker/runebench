#!/bin/bash
# Run gold benchmarks across all models + all 4 starting conditions.
#
# Unlike the skill runners, this uses the unified OpenCode adapter for every
# model (matching the vendor-eval setup). OpenCode records per-step tokens and
# cost_usd directly, so no post-processing is needed for anthropic/openai/gemini.
#
# Usage:
#   run-gold.sh                         # all models, all conditions, 15m
#   run-gold.sh -m opus                 # single model
#   run-gold.sh -c smith-alch           # single condition
#   run-gold.sh --horizon 30m           # longer runs
#   run-gold.sh -m opus -c fletch-alch  # one combo
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/run-common.sh"

# ── Model definitions (agent|model-id|label) ────────────────────
# Every model uses the unified opencode adapter so logs + cost tracking
# are uniform across providers.
ALL_MODELS="
opencode|anthropic/claude-opus-4-7|opus47
opencode|anthropic/claude-opus-4-6|opus
opencode|anthropic/claude-opus-4-5|opus45
opencode|anthropic/claude-sonnet-4-6|sonnet46
opencode|anthropic/claude-sonnet-4-5|sonnet45
opencode|anthropic/claude-haiku-4-5|haiku
opencode|openai/gpt-5.3-codex|codex53
opencode|openai/gpt-5.4|gpt54
opencode|openai/gpt-5.4-mini|gpt54mini
opencode|openai/gpt-5.4-nano|gpt54nano
opencode|openai/gpt-5.5|gpt55
opencode|gemini/gemini-3-pro-preview|gemini
opencode|gemini/gemini-3-flash-preview|geminiflash
glm-opencode|openrouter/z-ai/glm-5|glm
kimi-opencode|openrouter/moonshotai/kimi-k2.5|kimi
qwen3-opencode|openrouter/qwen/qwen3-coder-next|qwen3
qwen35-opencode|openrouter/qwen/qwen3.5-35b-a3b|qwen35
"

ALL_CONDITIONS="vanilla smith-alch fish fletch-alch"

# ── Defaults ──────────────────────────────────────────────────────
SELECTED_MODELS=""
SELECTED_CONDITIONS=""
HORIZON="15m"
K_TRIALS=1
EXTRA_ARGS=""

# ── Parse args ────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    -m|--model)     SELECTED_MODELS="$SELECTED_MODELS $2"; shift 2 ;;
    -c|--condition) SELECTED_CONDITIONS="$SELECTED_CONDITIONS $2"; shift 2 ;;
    --horizon)      HORIZON="$2"; shift 2 ;;
    -k|--k-trials)  K_TRIALS="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: run-gold.sh [-m model] [-c condition] [--horizon 15m|30m] [-k trials]"
      echo ""
      echo "Models:     opus47, opus, sonnet46, sonnet45, haiku, codex53, gpt55,"
      echo "            gpt54, gpt54mini, gpt54nano, gemini, geminiflash, glm, kimi,"
      echo "            qwen3, qwen35 (default: all)"
      echo "Conditions: vanilla, smith-alch, fish, fletch-alch (default: all four)"
      echo "Horizon:    15m or 30m (default: 15m)"
      exit 0
      ;;
    *)
      EXTRA_ARGS="$EXTRA_ARGS $1"; shift ;;
  esac
done

if [ -z "$SELECTED_MODELS" ]; then
  SELECTED_MODELS="opus47 opus sonnet46 sonnet45 haiku codex53 gpt55 gpt54 gpt54mini gpt54nano gemini geminiflash glm kimi qwen3 qwen35"
fi
if [ -z "$SELECTED_CONDITIONS" ]; then
  SELECTED_CONDITIONS="$ALL_CONDITIONS"
fi

load_env "$REPO_ROOT/.env"

regenerate_tasks "$REPO_ROOT/generate-tasks.ts"

# Horizon → (sandbox timeout, bash loop timeout).
# BASH_TIMEOUT must be < task.toml agent timeout (duration + 120s) so the
# opencode loop exits cleanly before harbor fires AgentTimeoutError.
# Leaving a 120s margin also gives the verifier time to read the save file.
case "$HORIZON" in
  15m) SANDBOX_TIMEOUT=1500; BASH_TIMEOUT=900 ;;    # agent.timeout_sec=1020
  30m) SANDBOX_TIMEOUT=2400; BASH_TIMEOUT=1800 ;;   # agent.timeout_sec=1920
  *) echo "Unsupported horizon: $HORIZON (use 15m or 30m)"; exit 1 ;;
esac

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
TOTAL_MODELS=0
TOTAL_FAILED=0

for model_name in $SELECTED_MODELS; do
  entry=$(lookup_model "$model_name" "$ALL_MODELS")
  if [ -z "$entry" ]; then
    echo "Unknown model: $model_name"
    exit 1
  fi

  IFS='|' read -r agent model label <<< "$entry"

  ENV_PREFIX=""
  AGENT_FLAG="-a '$agent'"
  MODEL_EXTRA_ARGS=""

  if ! configure_model_env "$model_name" "$REPO_ROOT/agents" "$entry"; then
    continue
  fi

  # OpenCode bash loop timeout must be < harbor's agent timeout.
  MODEL_EXTRA_ARGS="--ak run_timeout_sec=$BASH_TIMEOUT"

  # Build -i flags for selected conditions
  TASK_FLAGS=""
  for cond in $SELECTED_CONDITIONS; do
    TASK_FLAGS="$TASK_FLAGS -i 'gold-${cond}-${HORIZON}'"
  done

  JOB_NAME="gold-${HORIZON}-${label}-${TIMESTAMP}"
  LOG_FILE="/tmp/harbor-${JOB_NAME}.log"
  N_CONDS=$(echo $SELECTED_CONDITIONS | wc -w | tr -d ' ')

  TOTAL_MODELS=$((TOTAL_MODELS + 1))
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  [$TOTAL_MODELS] $model_name ($N_CONDS conditions × $HORIZON)"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  if ! eval "$ENV_PREFIX harbor run \
    -p '$REPO_ROOT/tasks' \
    $TASK_FLAGS \
    $AGENT_FLAG \
    -m '$model' \
    --job-name '$JOB_NAME' \
    --env modal \
    --ek sandbox_timeout_secs=$SANDBOX_TIMEOUT \
    -n 8 \
    -k $K_TRIALS \
    $EXTRA_ARGS $MODEL_EXTRA_ARGS" 2>&1 | tee "$LOG_FILE"; then
    TOTAL_FAILED=$((TOTAL_FAILED + 1))
  fi
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$TOTAL_FAILED" -eq 0 ]; then
  echo "All gold benchmarks complete. ($TOTAL_MODELS models × $HORIZON)"
else
  echo "All runs finished. $TOTAL_FAILED of $TOTAL_MODELS model(s) had errors."
fi
echo ""
echo "Next steps:"
echo "  bun scripts/postprocess-costs.ts      # backfill cost_usd on jobs that lack it"
echo "  bun extractors/extract-gold-results.ts"
echo "  open views/graph-gold.html"
