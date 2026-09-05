#!/bin/bash
# Run 30-minute skill XP benchmarks across models.
#
# Models run sequentially to avoid Modal App lock contention.
# Within each model, harbor runs skills concurrently (-n 4).
#
# Usage:
#   run-skills-30m.sh                      # all models, all skills
#   run-skills-30m.sh -m haiku             # single model
#   run-skills-30m.sh -s woodcutting        # single skill
#   run-skills-30m.sh -m haiku -s woodcutting  # single skill + model
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/run-common.sh"

# ── Model definitions (agent|model-id|label) ────────────────────
ALL_MODELS="
claude-code|anthropic/claude-opus-5|opus5-fast
claude-code|anthropic/claude-opus-5|opus5
claude-code|anthropic/claude-opus-4-7|opus47
claude-code|anthropic/claude-opus-4-6|opus
claude-code|anthropic/claude-opus-4-5|opus45
claude-code|anthropic/claude-sonnet-5|sonnet5
claude-code|anthropic/claude-sonnet-4-6|sonnet46
claude-code|anthropic/claude-sonnet-4-5|sonnet45
claude-code|anthropic/claude-haiku-4-5|haiku
codex|openai/gpt-5.2-codex|codex
codex|openai/gpt-5.3-codex|codex53
codex|openai/gpt-5.4|gpt54
codex|openai/gpt-5.4-mini|gpt54mini
codex|openai/gpt-5.4-nano|gpt54nano
codex|openai/gpt-5.5|gpt55
codex|openai/gpt-6-astra|gpt6astra
codex|openai/gpt-6-astra|gpt6astra-high
codex|openai/gpt-5.6-sol|gpt56
codex|openai/gpt-5.6-sol|gpt56-xhigh
codex|openai/gpt-5.6-sol|gpt56-fast
codex|openai/gpt-5.6-luna|gpt56luna
codex|openai/gpt-5.6-luna|gpt56luna-xhigh
codex|openai/gpt-5.6-luna|gpt56luna-fast
codex|openai/gpt-5.6-terra|gpt56terra
codex|openai/gpt-5.6-terra|gpt56terra-xhigh
codex|openai/gpt-5.6-terra|gpt56terra-fast
gemini-cli|google/gemini-3-pro-preview|gemini
gemini-cli|google/gemini-3.1-pro-preview|gemini31
gemini-cli|google/gemini-3-flash-preview|geminiflash
gemini-cli|google/gemini-3.5-flash|gemini35flash
gemini-cli-high|google/gemini-3.5-flash|gemini35flash-high
gemini38flash-opencode|openrouter/google/gemini-3.8-flash|gemini38flash
gemini37flash-opencode|google/gemini-3.7-flash|gemini37flash
gemini36flash-opencode|google/gemini-3.6-flash|gemini36flash
gemini35flashlite-opencode|google/gemini-3.5-flash-lite|gemini35flashlite
glm-opencode|openrouter/z-ai/glm-5|glm
glm52-opencode|openrouter/z-ai/glm-5.2|glm52
glm52-wandb-opencode|openrouter/z-ai/glm-5.2|glm52-wandb
glm53-opencode|zai-coding-plan/glm-5.3|glm53
glm53flash-opencode|openrouter/z-ai/glm-5.3-flash|glm53flash
gemma4-opencode|openrouter/google/gemma-4-31b-it|gemma4
gptoss120b-opencode|openrouter/openai/gpt-oss-120b|gptoss120b
kimi-opencode|openrouter/moonshotai/kimi-k2.5|kimi
qwen35-opencode|openrouter/qwen/qwen3.5-35b-a3b|qwen35
qwen3max-opencode|openrouter/qwen/qwen3-max|qwen3max
qwen37max-opencode|openrouter/qwen/qwen3.7-max|qwen37max
qwen38max-opencode|openrouter/qwen/qwen3.8-max|qwen38max
qwen38-opencode|openrouter/qwen/qwen3.8-27b|qwen38
deepseek-opencode|openrouter/deepseek/deepseek-v4-pro|deepseek
deepseekflash-opencode|openrouter/deepseek/deepseek-v4-flash|deepseekflash
deepseekflash0731-opencode|openrouter/deepseek/deepseek-v4-flash-0731|deepseekflash0731
kimi26-opencode|openrouter/moonshotai/kimi-k2.6|kimi26
kimi27-opencode|openrouter/moonshotai/kimi-k2.7-code|kimi27
kimi3-opencode|openrouter/moonshotai/kimi-k3|kimi3
grok46-opencode|openrouter/x-ai/grok-4.6|grok46
grok46-medium-opencode|openrouter/x-ai/grok-4.6|grok46-medium
grok46-xhigh-opencode|openrouter/x-ai/grok-4.6|grok46-xhigh
grok45-opencode|openrouter/x-ai/grok-4.5|grok45
grok45-medium-opencode|openrouter/x-ai/grok-4.5|grok45-medium
grok43-opencode|openrouter/x-ai/grok-4.3|grok43
muse-opencode|meta/muse-spark-1.1|muse
muse12-opencode|meta/muse-spark-1.2-contributor|muse12
muse13-opencode|openrouter/meta/muse-spark-1.3-contributor|muse13
inkling-opencode|openrouter/thinkingmachines/inkling|inkling
laguna-opencode|openrouter/poolside/laguna-s-2.1|laguna

"

ALL_SKILLS="attack defence strength hitpoints ranged prayer magic woodcutting fishing mining cooking fletching crafting smithing firemaking thieving"

# ── Defaults ──────────────────────────────────────────────────────
SELECTED_MODELS=""
SELECTED_SKILLS=""
K_TRIALS=1
EXTRA_ARGS=""

# ── Parse args ────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    -m|--model)   SELECTED_MODELS="$SELECTED_MODELS $2"; shift 2 ;;
    -s|--skill)   SELECTED_SKILLS="$SELECTED_SKILLS $2"; shift 2 ;;
    -k|--k-trials) K_TRIALS="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: run-skills-30m.sh [-m model] [-s skill] [-k trials]"
      echo ""
      echo "Models: opus47, opus, opus45, sonnet5, sonnet46, sonnet45, haiku, codex, codex53, gpt55, gpt6astra, gpt56, gpt54, gpt54mini, gpt54nano, gemini, gemini31, geminiflash, gemini35flash, gemini35flash-high, glm, kimi, qwen35 (default: all)"
      echo "Skills: attack, defence, strength, hitpoints, ranged, prayer, magic,"
      echo "        woodcutting, fishing, mining, cooking, fletching, crafting,"
      echo "        smithing, firemaking, thieving (default: all sixteen)"
      echo "Trials: -k N  (default: 1; e.g. 4 runs each for best-of-K)"
      exit 0
      ;;
    *)
      EXTRA_ARGS="$EXTRA_ARGS $1"; shift ;;
  esac
done

# Default to all if none specified
if [ -z "$SELECTED_MODELS" ]; then
  SELECTED_MODELS="opus opus45 sonnet46 sonnet45 haiku codex codex53 gpt55 gpt54 gpt54mini gpt54nano gemini gemini31 geminiflash gemini35flash gemini35flash-high glm kimi qwen35"
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
    echo "Unknown model: $model_name (available: opus, opus45, sonnet46, sonnet45, haiku, codex, codex53, gpt55, gpt6astra, gpt56, gpt54, gpt54mini, gpt54nano, gemini, gemini31, geminiflash, gemini35flash, gemini35flash-high, glm, kimi, qwen35)"
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
  #   - For codex: sets the Modal exec timeout (must be < harbor's 1920s agent timeout)
  case "$model_name" in
    opus5-fast)
      # Fast mode (2.5x speed, $10/$50 per MTok) via patched harbor claude_code.py:
      # injects --settings '{"fastMode": true}' + CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK=1.
      # Requires fast mode enabled for the org in Console (Claude Code preferences).
      MODEL_EXTRA_ARGS="--ak fast_mode=true"
      ;;
    codex|codex53|gpt55|gpt6astra-high|gpt56|gpt56luna|gpt56terra|gpt54|gpt54mini|gpt54nano)
      MODEL_EXTRA_ARGS="--ak run_timeout_sec=1900"
      ;;
    gpt6astra)
      # gpt-6-astra's own CLI default is medium (supported_reasoning_levels
      # low..ultra in ~/.codex/models_cache.json), while harbor's codex default
      # is high. Pin medium explicitly so the base row is the model's default
      # thinking level; the high condition lives in the gpt6astra-high row.
      MODEL_EXTRA_ARGS="--ak run_timeout_sec=1900 --ak reasoning_effort=medium"
      ;;
    gpt56-xhigh|gpt56luna-xhigh|gpt56terra-xhigh)
      MODEL_EXTRA_ARGS="--ak run_timeout_sec=1900 --ak reasoning_effort=xhigh"
      ;;
    gpt56-fast|gpt56luna-fast|gpt56terra-fast)
      # OpenAI's premium-speed serving tier: codex_adapter turns fast_mode=true
      # into `-c service_tier="fast" --enable fast_mode` on the codex exec line.
      # reasoning_effort is left at harbor's codex default (high) so these rows
      # differ from the base gpt56* rows in serving speed ONLY.
      #
      # On the wire this becomes `"service_tier": "priority"`. An unrecognised
      # value is dropped SILENTLY (exit 0, no error), and codex records the
      # tier in no post-run artifact, so verify from the echoed command line:
      #   grep -l 'service_tier="fast"' jobs/<job>/*/trial.log | wc -l   # want 16
      MODEL_EXTRA_ARGS="--ak run_timeout_sec=1900 --ak fast_mode=true"
      ;;
    glm|glm52|glm52-wandb|glm53|glm53flash|gemma4|gptoss120b|kimi|kimi26|kimi27|kimi3|kimi3-low|qwen35|qwen3max|qwen37max|qwen38max|qwen38|deepseek|deepseekflash|deepseekflash0731|inkling|laguna|gemini38flash|gemini37flash|gemini36flash|gemini35flashlite)
      MODEL_EXTRA_ARGS="--ak run_timeout_sec=1800"
      ;;
    grok46|grok46-medium|grok46-xhigh|grok45|grok45-medium|grok43|muse|muse12|muse13)
      # xAI blocks grok models for EU-origin requests (403 "not available in
      # your region") — pin the Modal sandbox to a US region so OpenRouter sees
      # a US client. Requires the sandbox_region patch in harbor's modal.py.
      #
      # muse: Meta returns the same class of 403 ("This model is only available
      # in the United States") for non-US sandboxes. Unpinned, ~5 of 16 skills
      # landed outside the US and fast-fail aborted with 0 tokens.
      MODEL_EXTRA_ARGS="--ak run_timeout_sec=1800 --ek sandbox_region=us-east"
      ;;
    gemini|gemini31|geminiflash|gemini35flash|gemini35flash-high)
      # gemini-cli ≥0.39 switched session storage from session-*.json to
      # session-*.jsonl in a different layout; harbor's post-run find/parse
      # still expects the legacy single-JSON file. Pin to the last version
      # that uses the old format so token usage / cost gets captured.
      MODEL_EXTRA_ARGS="--ak version=0.38.2"
      ;;
  esac
  # OAuth auth for codex-family models that need a ChatGPT session token
  # instead of OPENAI_API_KEY (codex53/gpt6astra use ~/.codex/auth.json; gpt55
  # uses the repo-local agents/auth.json). codex_adapter shares ONE decoded
  # tempfile across all -n trials; the access token must outlive the sweep
  # (check exp: it is NOT refreshed inside the sandbox).
  CODEX_AUTH_FILE=""
  if [ "$model_name" = "codex53" ] || [ "${model_name%-high}" = "gpt6astra" ]; then
    CODEX_AUTH_FILE="$HOME/.codex/auth.json"
  elif [ "$model_name" = "gpt55" ]; then
    CODEX_AUTH_FILE="$REPO_ROOT/agents/auth.json"
  fi
  if [ -n "$CODEX_AUTH_FILE" ]; then
    if [ ! -f "$CODEX_AUTH_FILE" ]; then
      echo "  WARNING: $CODEX_AUTH_FILE not found, skipping $model_name (OAuth required)"
      continue
    fi
    # Base64-encode auth.json to safely pass OAuth tokens through shell/Modal env
    CODEX_AUTH_B64=$(base64 < "$CODEX_AUTH_FILE")
    ENV_PREFIX="$ENV_PREFIX CODEX_AUTH_JSON_B64='$CODEX_AUTH_B64'"
  fi

  # Build -t flags for selected skills (dataset mode: one harbor process per model)
  TASK_FLAGS=""
  for skill in $SELECTED_SKILLS; do
    TASK_FLAGS="$TASK_FLAGS -i '${skill}-xp-30m'"
  done

  JOB_NAME="skills-30m-${label}-${TIMESTAMP}"
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
    --ek sandbox_timeout_secs=7200 \
    -n 16 \
    -k $K_TRIALS \
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
echo "  bun extractors/extract-skill-results.ts"
echo "  open views/graph-skills.html"
