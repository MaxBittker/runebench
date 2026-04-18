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
    kimi-opencode)
      if [ -z "${OPENROUTER_API_KEY:-}" ]; then
        echo "  WARNING: OPENROUTER_API_KEY not found in .env, skipping $model_name"
        return 1
      fi
      ENV_PREFIX="PYTHONPATH=$agents_dir:\${PYTHONPATH:-}"
      AGENT_FLAG="--agent-import-path 'kimi_adapter:KimiOpenCode'"
      ;;
    qwen3-opencode)
      if [ -z "${OPENROUTER_API_KEY:-}" ]; then
        echo "  WARNING: OPENROUTER_API_KEY not found in .env, skipping $model_name"
        return 1
      fi
      ENV_PREFIX="PYTHONPATH=$agents_dir:\${PYTHONPATH:-}"
      AGENT_FLAG="--agent-import-path 'qwen3_adapter:Qwen3OpenCode'"
      ;;
    qwen35-opencode)
      if [ -z "${OPENROUTER_API_KEY:-}" ]; then
        echo "  WARNING: OPENROUTER_API_KEY not found in .env, skipping $model_name"
        return 1
      fi
      ENV_PREFIX="PYTHONPATH=$agents_dir:\${PYTHONPATH:-}"
      AGENT_FLAG="--agent-import-path 'qwen35_adapter:Qwen35OpenCode'"
      ;;
    codex)
      ENV_PREFIX="PYTHONPATH=$agents_dir:\${PYTHONPATH:-}"
      AGENT_FLAG="--agent-import-path 'codex_adapter:CodexWithTimeout'"
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
