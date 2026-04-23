#!/bin/bash
# Run 10-minute skill XP benchmarks across models.
#
# Models run sequentially to avoid Modal App lock contention.
# Within each model, harbor runs skills concurrently (-n 4).
#
# Usage:
#   run-skills-10m.sh                      # all models, all skills
#   run-skills-10m.sh -m haiku             # single model
#   run-skills-10m.sh -s woodcutting        # single skill
#   run-skills-10m.sh -m haiku -s woodcutting  # single skill + model
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/run-common.sh"

# ── Model definitions (agent|model-id|label) ────────────────────
ALL_MODELS="
claude-code|anthropic/claude-opus-4-7|opus47
claude-code|anthropic/claude-opus-4-6|opus
claude-code|anthropic/claude-opus-4-5|opus45
claude-code|anthropic/claude-sonnet-4-6|sonnet46
claude-code|anthropic/claude-sonnet-4-5|sonnet45
claude-code|anthropic/claude-haiku-4-5|haiku
codex|openai/gpt-5.2-codex|codex
codex|openai/gpt-5.3-codex|codex53
codex|openai/gpt-5.4|gpt54
codex|openai/gpt-5.4-mini|gpt54mini
codex|openai/gpt-5.4-nano|gpt54nano
codex|openai/gpt-5.5|gpt55
gemini-cli|google/gemini-3-pro-preview|gemini
gemini-cli|google/gemini-3.1-pro-preview|gemini31
gemini-cli|google/gemini-3-flash-preview|geminiflash
glm-opencode|openrouter/z-ai/glm-5|glm
kimi-opencode|openrouter/moonshotai/kimi-k2.5|kimi
qwen3-opencode|openrouter/qwen/qwen3-coder-next|qwen3
qwen35-opencode|openrouter/qwen/qwen3.5-35b-a3b|qwen35

"

ALL_SKILLS="attack defence strength hitpoints ranged prayer magic woodcutting fishing mining cooking fletching crafting smithing firemaking thieving"

# ── Defaults ──────────────────────────────────────────────────────
SELECTED_MODELS=""
SELECTED_SKILLS=""
EXTRA_ARGS=""

# ── Parse args ────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    -m|--model)   SELECTED_MODELS="$SELECTED_MODELS $2"; shift 2 ;;
    -s|--skill)   SELECTED_SKILLS="$SELECTED_SKILLS $2"; shift 2 ;;
    -h|--help)
      echo "Usage: run-skills-10m.sh [-m model] [-s skill]"
      echo ""
      echo "Models: opus47, opus, opus45, sonnet46, sonnet45, haiku, codex, codex53, gpt55, gpt54, gpt54mini, gpt54nano, gemini, gemini31, geminiflash, glm, kimi, qwen3, qwen35 (default: all)"
      echo "Skills: attack, defence, strength, hitpoints, ranged, prayer, magic,"
      echo "        woodcutting, fishing, mining, cooking, fletching, crafting,"
      echo "        smithing, firemaking, thieving (default: all sixteen)"
      exit 0
      ;;
    *)
      EXTRA_ARGS="$EXTRA_ARGS $1"; shift ;;
  esac
done

# Default to all if none specified
if [ -z "$SELECTED_MODELS" ]; then
  SELECTED_MODELS="opus47 opus opus45 sonnet46 sonnet45 haiku codex codex53 gpt55 gpt54 gpt54mini gpt54nano gemini gemini31 geminiflash glm kimi qwen3 qwen35"
fi
if [ -z "$SELECTED_SKILLS" ]; then
  SELECTED_SKILLS="$ALL_SKILLS"
fi

load_env "$REPO_ROOT/.env"
GLM_KEY="${GLM_API_KEY:-}"

regenerate_tasks "$REPO_ROOT/generate-tasks.ts"

# ── Run models sequentially (avoid Modal App lock contention) ────────
# Each model runs all its skills via harbor dataset mode with -n 4 concurrency.
# Models run one at a time so only one harbor process uses the shared __harbor__
# Modal App at any given time.
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
TOTAL_MODELS=0
TOTAL_FAILED=0

for model_name in $SELECTED_MODELS; do
  entry=$(lookup_model "$model_name" "$ALL_MODELS")
  if [ -z "$entry" ]; then
    echo "Unknown model: $model_name (available: opus, opus45, sonnet46, sonnet45, haiku, codex, codex53, gpt54, gpt54mini, gpt54nano, gemini, gemini31, geminiflash, glm, kimi, qwen3, qwen35)"
    exit 1
  fi

  IFS='|' read -r agent model label <<< "$entry"

  # Per-model config (reset each iteration)
  ENV_PREFIX=""
  AGENT_FLAG="-a '$agent'"
  HARBOR_ENV="modal"
  MODEL_EXTRA_ARGS=""

  if ! configure_model_env "$model_name" "$REPO_ROOT/agents" "$entry"; then
    continue
  fi

  # Model-specific overrides beyond configure_model_env
  #
  # run_timeout_sec prevents the harbor/Modal cancellation hang:
  #   - For opencode agents: sets the bash loop timeout (game time)
  #   - For codex: sets the Modal exec timeout (must be < harbor's 720s agent timeout)
  case "$model_name" in
    codex|codex53|gpt55|gpt54|gpt54mini|gpt54nano)
      MODEL_EXTRA_ARGS="--ak run_timeout_sec=650"
      ;;
    kimi|qwen3|qwen35)
      MODEL_EXTRA_ARGS="--ak run_timeout_sec=600"
      ;;
  esac
  if [ "$model_name" = "codex53" ]; then
    CODEX_AUTH_FILE="$HOME/.codex/auth.json"
    if [ ! -f "$CODEX_AUTH_FILE" ]; then
      echo "  WARNING: ~/.codex/auth.json not found, skipping codex53 (OAuth required)"
      continue
    fi
    # Base64-encode auth.json to safely pass OAuth tokens through shell/Modal env
    CODEX_AUTH_B64=$(base64 < "$CODEX_AUTH_FILE")
    ENV_PREFIX="$ENV_PREFIX CODEX_AUTH_JSON_B64='$CODEX_AUTH_B64'"
  fi

  # Build -t flags for selected skills (dataset mode: one harbor process per model)
  TASK_FLAGS=""
  for skill in $SELECTED_SKILLS; do
    TASK_FLAGS="$TASK_FLAGS -t '${skill}-xp-10m'"
  done

  JOB_NAME="skills-10m-${label}-${TIMESTAMP}"
  LOG_FILE="/tmp/harbor-${JOB_NAME}.log"
  N_SKILLS=$(echo $SELECTED_SKILLS | wc -w | tr -d ' ')

  TOTAL_MODELS=$((TOTAL_MODELS + 1))
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  [$TOTAL_MODELS] $model_name ($N_SKILLS skills)"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  if ! eval "$ENV_PREFIX harbor run \
    -p '$REPO_ROOT/tasks' \
    $TASK_FLAGS \
    $AGENT_FLAG \
    -m '$model' \
    --job-name '$JOB_NAME' \
    --env $HARBOR_ENV \
    --ek sandbox_timeout_secs=3600 \
    -n 16 \
    -k 1 \
    $EXTRA_ARGS $MODEL_EXTRA_ARGS" 2>&1 | tee "$LOG_FILE"; then
    TOTAL_FAILED=$((TOTAL_FAILED + 1))
  fi
done

# ── Print summary ─────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$TOTAL_FAILED" -eq 0 ]; then
  echo "All skill benchmarks complete. ($TOTAL_MODELS models)"
else
  echo "All runs finished. $TOTAL_FAILED of $TOTAL_MODELS model(s) had errors."
fi
echo ""
echo "Next steps:"
echo "  bun extractors/extract-skill-results.ts --horizon 10m"
echo "  open views/graph-skills.html?horizon=10m"
