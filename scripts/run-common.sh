#!/bin/bash
# Shared shell functions for run scripts.
# Source this file: source "$(dirname "$0")/run-common.sh"

# ── load_env: source .env file and export all variables ──────────
load_env() {
  local env_file="$1"
  if [ -f "$env_file" ]; then
    set -a  # auto-export all variables
    source "$env_file"
    set +a
  fi
}

# ── lookup_model: find model entry by label (bash 3 compatible) ──
# Usage: entry=$(lookup_model "$name" "$ALL_MODELS")
lookup_model() {
  local name="$1"
  local models="$2"
  echo "$models" | while IFS='|' read -r agent model label; do
    if [ "$label" = "$name" ]; then
      echo "$agent|$model|$label"
      return 0
    fi
  done
}

# ── configure_model_env: set ENV_PREFIX/AGENT_FLAG for a model ───
# Sets these variables in the caller's scope:
#   ENV_PREFIX  — env vars to prepend to the harbor command
#   AGENT_FLAG  — agent flag for harbor (e.g. -a 'claude-code')
# Returns 1 if model should be skipped (missing credentials).
configure_model_env() {
  local model_name="$1"
  local agents_dir="$2"

  ENV_PREFIX=""
  AGENT_FLAG="-a '$(echo "$3" | cut -d'|' -f1)'"

  # Agent dispatch — agent_name (field 1 of ALL_MODELS entry) wins over model label.
  local agent_name
  agent_name="$(echo "$3" | cut -d'|' -f1)"

  case "$agent_name" in
    opencode)
      ENV_PREFIX="PYTHONPATH=$agents_dir:\${PYTHONPATH:-}"
      AGENT_FLAG="--agent-import-path 'opencode_adapter:OpenCodeAdapter'"
      ;;
    glm-opencode)
      if [ -z "${OPENROUTER_API_KEY:-}" ]; then
        echo "  WARNING: OPENROUTER_API_KEY not found in .env, skipping $model_name"
        return 1
      fi
      ENV_PREFIX="PYTHONPATH=$agents_dir:\${PYTHONPATH:-}"
      AGENT_FLAG="--agent-import-path 'glm_adapter:GlmOpenCode'"
      ;;
    glm52-opencode)
      if [ -z "${OPENROUTER_API_KEY:-}" ]; then
        echo "  WARNING: OPENROUTER_API_KEY not found in .env, skipping $model_name"
        return 1
      fi
      ENV_PREFIX="PYTHONPATH=$agents_dir:\${PYTHONPATH:-}"
      AGENT_FLAG="--agent-import-path 'glm52_adapter:Glm52OpenCode'"
      ;;
    glm52-wandb-opencode)
      if [ -z "${OPENROUTER_API_KEY:-}" ]; then
        echo "  WARNING: OPENROUTER_API_KEY not found in .env, skipping $model_name"
        return 1
      fi
      ENV_PREFIX="PYTHONPATH=$agents_dir:\${PYTHONPATH:-}"
      AGENT_FLAG="--agent-import-path 'glm52wandb_adapter:Glm52WandbOpenCode'"
      ;;
    glm53flash-opencode)
      if [ -z "${OPENROUTER_API_KEY:-}" ]; then
        echo "  WARNING: OPENROUTER_API_KEY not found in .env, skipping $model_name"
        return 1
      fi
      ENV_PREFIX="PYTHONPATH=$agents_dir:\${PYTHONPATH:-}"
      AGENT_FLAG="--agent-import-path 'glm53flash_adapter:Glm53FlashOpenCode'"
      ;;
    glm53-opencode)
      # z.ai GLM Coding Plan direct (api.z.ai/api/coding/paas/v4) — needs ZHIPU_API_KEY.
      if [ -z "${ZHIPU_API_KEY:-}" ]; then
        echo "  WARNING: ZHIPU_API_KEY not found in .env, skipping $model_name"
        return 1
      fi
      ENV_PREFIX="PYTHONPATH=$agents_dir:\${PYTHONPATH:-}"
      AGENT_FLAG="--agent-import-path 'glm53_adapter:Glm53OpenCode'"
      ;;
    gemma4-opencode)
      if [ -z "${OPENROUTER_API_KEY:-}" ]; then
        echo "  WARNING: OPENROUTER_API_KEY not found in .env, skipping $model_name"
        return 1
      fi
      ENV_PREFIX="PYTHONPATH=$agents_dir:\${PYTHONPATH:-}"
      AGENT_FLAG="--agent-import-path 'gemma4_adapter:Gemma4OpenCode'"
      ;;
    gptoss120b-opencode)
      if [ -z "${OPENROUTER_API_KEY:-}" ]; then
        echo "  WARNING: OPENROUTER_API_KEY not found in .env, skipping $model_name"
        return 1
      fi
      ENV_PREFIX="PYTHONPATH=$agents_dir:\${PYTHONPATH:-}"
      AGENT_FLAG="--agent-import-path 'gptoss_adapter:GptOss120bOpenCode'"
      ;;
    kimi-opencode)
      if [ -z "${OPENROUTER_API_KEY:-}" ]; then
        echo "  WARNING: OPENROUTER_API_KEY not found in .env, skipping $model_name"
        return 1
      fi
      ENV_PREFIX="PYTHONPATH=$agents_dir:\${PYTHONPATH:-}"
      AGENT_FLAG="--agent-import-path 'kimi_adapter:KimiOpenCode'"
      ;;
    qwen35-opencode)
      if [ -z "${OPENROUTER_API_KEY:-}" ]; then
        echo "  WARNING: OPENROUTER_API_KEY not found in .env, skipping $model_name"
        return 1
      fi
      ENV_PREFIX="PYTHONPATH=$agents_dir:\${PYTHONPATH:-}"
      AGENT_FLAG="--agent-import-path 'qwen35_adapter:Qwen35OpenCode'"
      ;;
    qwen3max-opencode)
      if [ -z "${OPENROUTER_API_KEY:-}" ]; then
        echo "  WARNING: OPENROUTER_API_KEY not found in .env, skipping $model_name"
        return 1
      fi
      ENV_PREFIX="PYTHONPATH=$agents_dir:\${PYTHONPATH:-}"
      AGENT_FLAG="--agent-import-path 'qwen3max_adapter:Qwen3MaxOpenCode'"
      ;;
    qwen38max-opencode)
      if [ -z "${OPENROUTER_API_KEY:-}" ]; then
        echo "  WARNING: OPENROUTER_API_KEY not found in .env, skipping $model_name"
        return 1
      fi
      ENV_PREFIX="PYTHONPATH=$agents_dir:\${PYTHONPATH:-}"
      AGENT_FLAG="--agent-import-path 'qwen38max_adapter:Qwen38MaxOpenCode'"
      ;;
    qwen38-opencode)
      if [ -z "${OPENROUTER_API_KEY:-}" ]; then
        echo "  WARNING: OPENROUTER_API_KEY not found in .env, skipping $model_name"
        return 1
      fi
      ENV_PREFIX="PYTHONPATH=$agents_dir:\${PYTHONPATH:-}"
      AGENT_FLAG="--agent-import-path 'qwen38_adapter:Qwen38OpenCode'"
      ;;
    qwen37max-opencode)
      if [ -z "${OPENROUTER_API_KEY:-}" ]; then
        echo "  WARNING: OPENROUTER_API_KEY not found in .env, skipping $model_name"
        return 1
      fi
      ENV_PREFIX="PYTHONPATH=$agents_dir:\${PYTHONPATH:-}"
      AGENT_FLAG="--agent-import-path 'qwen37max_adapter:Qwen37MaxOpenCode'"
      ;;
    deepseek-opencode)
      if [ -z "${OPENROUTER_API_KEY:-}" ]; then
        echo "  WARNING: OPENROUTER_API_KEY not found in .env, skipping $model_name"
        return 1
      fi
      ENV_PREFIX="PYTHONPATH=$agents_dir:\${PYTHONPATH:-}"
      AGENT_FLAG="--agent-import-path 'deepseek_adapter:DeepSeekOpenCode'"
      ;;
    deepseekflash-opencode)
      if [ -z "${OPENROUTER_API_KEY:-}" ]; then
        echo "  WARNING: OPENROUTER_API_KEY not found in .env, skipping $model_name"
        return 1
      fi
      ENV_PREFIX="PYTHONPATH=$agents_dir:\${PYTHONPATH:-}"
      AGENT_FLAG="--agent-import-path 'deepseek_adapter:DeepSeekFlashOpenCode'"
      ;;
    deepseekflash0731-opencode)
      if [ -z "${OPENROUTER_API_KEY:-}" ]; then
        echo "  WARNING: OPENROUTER_API_KEY not found in .env, skipping $model_name"
        return 1
      fi
      ENV_PREFIX="PYTHONPATH=$agents_dir:\${PYTHONPATH:-}"
      AGENT_FLAG="--agent-import-path 'deepseek_adapter:DeepSeekFlash0731OpenCode'"
      ;;
    kimi26-opencode)
      if [ -z "${OPENROUTER_API_KEY:-}" ]; then
        echo "  WARNING: OPENROUTER_API_KEY not found in .env, skipping $model_name"
        return 1
      fi
      ENV_PREFIX="PYTHONPATH=$agents_dir:\${PYTHONPATH:-}"
      AGENT_FLAG="--agent-import-path 'kimi26_adapter:Kimi26OpenCode'"
      ;;
    kimi27-opencode)
      if [ -z "${OPENROUTER_API_KEY:-}" ]; then
        echo "  WARNING: OPENROUTER_API_KEY not found in .env, skipping $model_name"
        return 1
      fi
      ENV_PREFIX="PYTHONPATH=$agents_dir:\${PYTHONPATH:-}"
      AGENT_FLAG="--agent-import-path 'kimi27_adapter:Kimi27OpenCode'"
      ;;
    kimi3-opencode)
      if [ -z "${OPENROUTER_API_KEY:-}" ]; then
        echo "  WARNING: OPENROUTER_API_KEY not found in .env, skipping $model_name"
        return 1
      fi
      ENV_PREFIX="PYTHONPATH=$agents_dir:\${PYTHONPATH:-}"
      AGENT_FLAG="--agent-import-path 'kimi3_adapter:Kimi3OpenCode'"
      ;;
    kimi3-low-opencode)
      if [ -z "${OPENROUTER_API_KEY:-}" ]; then
        echo "  WARNING: OPENROUTER_API_KEY not found in .env, skipping $model_name"
        return 1
      fi
      ENV_PREFIX="PYTHONPATH=$agents_dir:\${PYTHONPATH:-}"
      AGENT_FLAG="--agent-import-path 'kimi3_adapter:Kimi3LowOpenCode'"
      ;;
    muse-opencode)
      # Meta Model API direct (api.meta.ai) — needs META_MODEL_API_KEY.
      if [ -z "${META_MODEL_API_KEY:-}" ]; then
        echo "  WARNING: META_MODEL_API_KEY not found in .env, skipping $model_name"
        return 1
      fi
      ENV_PREFIX="PYTHONPATH=$agents_dir:\${PYTHONPATH:-}"
      AGENT_FLAG="--agent-import-path 'muse_adapter:MuseSparkOpenCode'"
      ;;
    muse12-opencode)
      if [ -z "${META_MODEL_API_KEY:-}" ]; then
        echo "  WARNING: META_MODEL_API_KEY not found in .env, skipping $model_name"
        return 1
      fi
      ENV_PREFIX="PYTHONPATH=$agents_dir:\${PYTHONPATH:-}"
      AGENT_FLAG="--agent-import-path 'muse_adapter:Muse12ContributorOpenCode'"
      ;;
    muse13-opencode)
      # muse-spark-1.3-contributor via OpenRouter (single Meta endpoint, pinned).
      if [ -z "${OPENROUTER_API_KEY:-}" ]; then
        echo "  WARNING: OPENROUTER_API_KEY not found in .env, skipping $model_name"
        return 1
      fi
      ENV_PREFIX="PYTHONPATH=$agents_dir:\${PYTHONPATH:-}"
      AGENT_FLAG="--agent-import-path 'muse_adapter:Muse13ContributorOpenRouter'"
      ;;
    grok46-medium-opencode)
      if [ -z "${OPENROUTER_API_KEY:-}" ]; then
        echo "  WARNING: OPENROUTER_API_KEY not found in .env, skipping $model_name"
        return 1
      fi
      ENV_PREFIX="PYTHONPATH=$agents_dir:\${PYTHONPATH:-}"
      AGENT_FLAG="--agent-import-path 'grok46_adapter:Grok46MediumOpenCode'"
      ;;
    grok46-xhigh-opencode)
      if [ -z "${OPENROUTER_API_KEY:-}" ]; then
        echo "  WARNING: OPENROUTER_API_KEY not found in .env, skipping $model_name"
        return 1
      fi
      ENV_PREFIX="PYTHONPATH=$agents_dir:\${PYTHONPATH:-}"
      AGENT_FLAG="--agent-import-path 'grok46_adapter:Grok46XhighOpenCode'"
      ;;
    grok46-opencode)
      if [ -z "${OPENROUTER_API_KEY:-}" ]; then
        echo "  WARNING: OPENROUTER_API_KEY not found in .env, skipping $model_name"
        return 1
      fi
      ENV_PREFIX="PYTHONPATH=$agents_dir:\${PYTHONPATH:-}"
      AGENT_FLAG="--agent-import-path 'grok46_adapter:Grok46OpenCode'"
      ;;
    grok45-opencode)
      if [ -z "${OPENROUTER_API_KEY:-}" ]; then
        echo "  WARNING: OPENROUTER_API_KEY not found in .env, skipping $model_name"
        return 1
      fi
      ENV_PREFIX="PYTHONPATH=$agents_dir:\${PYTHONPATH:-}"
      AGENT_FLAG="--agent-import-path 'grok45_adapter:Grok45OpenCode'"
      ;;
    grok43-opencode)
      if [ -z "${OPENROUTER_API_KEY:-}" ]; then
        echo "  WARNING: OPENROUTER_API_KEY not found in .env, skipping $model_name"
        return 1
      fi
      ENV_PREFIX="PYTHONPATH=$agents_dir:\${PYTHONPATH:-}"
      AGENT_FLAG="--agent-import-path 'grok43_adapter:Grok43OpenCode'"
      ;;
    grok45-medium-opencode)
      if [ -z "${OPENROUTER_API_KEY:-}" ]; then
        echo "  WARNING: OPENROUTER_API_KEY not found in .env, skipping $model_name"
        return 1
      fi
      ENV_PREFIX="PYTHONPATH=$agents_dir:\${PYTHONPATH:-}"
      AGENT_FLAG="--agent-import-path 'grok45_adapter:Grok45MediumOpenCode'"
      ;;
    gemini38flash-opencode)
      # OpenRouter (Google first-party endpoints) — Google API keys were all
      # invalid on launch day, see agents/gemini38flash_adapter.py.
      if [ -z "${OPENROUTER_API_KEY:-}" ]; then
        echo "  WARNING: OPENROUTER_API_KEY not found in .env, skipping $model_name"
        return 1
      fi
      ENV_PREFIX="PYTHONPATH=$agents_dir:\${PYTHONPATH:-}"
      AGENT_FLAG="--agent-import-path 'gemini38flash_adapter:Gemini38FlashOpenCode'"
      ;;
    gemini37flash-opencode)
      # Google API direct (not OpenRouter) — needs GEMINI_API_KEY.
      if [ -z "${GEMINI_API_KEY:-}" ]; then
        echo "  WARNING: GEMINI_API_KEY not found in .env, skipping $model_name"
        return 1
      fi
      ENV_PREFIX="PYTHONPATH=$agents_dir:\${PYTHONPATH:-}"
      AGENT_FLAG="--agent-import-path 'gemini_oc_adapter:Gemini37FlashOpenCode'"
      ;;
    gemini36flash-opencode)
      # Google API direct (not OpenRouter) — needs GEMINI_API_KEY.
      if [ -z "${GEMINI_API_KEY:-}" ]; then
        echo "  WARNING: GEMINI_API_KEY not found in .env, skipping $model_name"
        return 1
      fi
      ENV_PREFIX="PYTHONPATH=$agents_dir:\${PYTHONPATH:-}"
      AGENT_FLAG="--agent-import-path 'gemini_oc_adapter:Gemini36FlashOpenCode'"
      ;;
    gemini35flashlite-opencode)
      if [ -z "${GEMINI_API_KEY:-}" ]; then
        echo "  WARNING: GEMINI_API_KEY not found in .env, skipping $model_name"
        return 1
      fi
      ENV_PREFIX="PYTHONPATH=$agents_dir:\${PYTHONPATH:-}"
      AGENT_FLAG="--agent-import-path 'gemini_oc_adapter:Gemini35FlashLiteOpenCode'"
      ;;
    laguna-opencode)
      if [ -z "${OPENROUTER_API_KEY:-}" ]; then
        echo "  WARNING: OPENROUTER_API_KEY not found in .env, skipping $model_name"
        return 1
      fi
      ENV_PREFIX="PYTHONPATH=$agents_dir:\${PYTHONPATH:-}"
      AGENT_FLAG="--agent-import-path 'laguna_adapter:LagunaOpenCode'"
      ;;
    inkling-opencode)
      if [ -z "${OPENROUTER_API_KEY:-}" ]; then
        echo "  WARNING: OPENROUTER_API_KEY not found in .env, skipping $model_name"
        return 1
      fi
      ENV_PREFIX="PYTHONPATH=$agents_dir:\${PYTHONPATH:-}"
      AGENT_FLAG="--agent-import-path 'inkling_adapter:InklingOpenCode'"
      ;;
    codex)
      ENV_PREFIX="PYTHONPATH=$agents_dir:\${PYTHONPATH:-}"
      AGENT_FLAG="--agent-import-path 'codex_adapter:CodexWithTimeout'"
      ;;
    gemini-cli-high)
      # Gemini CLI pinned to thinking_level=HIGH (its max) via gemini_adapter.
      ENV_PREFIX="PYTHONPATH=$agents_dir:\${PYTHONPATH:-}"
      AGENT_FLAG="--agent-import-path 'gemini_adapter:GeminiCliHighThinking'"
      ;;
  esac
  return 0
}

# ── regenerate_tasks: run the task generator ─────────────────────
regenerate_tasks() {
  local script="$1"
  echo "Regenerating benchmark tasks..."
  bun "$script"
  echo ""
}
