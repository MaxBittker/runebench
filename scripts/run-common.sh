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
      if [ -z "${OPENROUTER_API_KEY:-}" ]; then
        echo "  WARNING: OPENROUTER_API_KEY not found in .env, skipping $model_name"
        return 1
      fi
      ENV_PREFIX="PYTHONPATH=$agents_dir:\${PYTHONPATH:-}"
      AGENT_FLAG="--agent-import-path 'muse_adapter:MuseSparkOpenCode'"
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
    grok45-xhigh-opencode)
      if [ -z "${OPENROUTER_API_KEY:-}" ]; then
        echo "  WARNING: OPENROUTER_API_KEY not found in .env, skipping $model_name"
        return 1
      fi
      ENV_PREFIX="PYTHONPATH=$agents_dir:\${PYTHONPATH:-}"
      AGENT_FLAG="--agent-import-path 'grok45_adapter:Grok45XhighOpenCode'"
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
