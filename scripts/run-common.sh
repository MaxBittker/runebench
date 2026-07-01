#!/bin/bash
# Shared shell functions for run scripts.
# Source this file: source "$(dirname "$0")/run-common.sh"

# ── Shared model roster ──────────────────────────────────────────
# Central default consumed by the multi-bot launch scripts
# (run-arrav.sh, run-smith-team.sh), which run every model through the
# unified OpenCode duo/team adapter. The per-skill and gold scripts
# define their own ALL_MODELS locally after sourcing, which overrides
# this — so this list only feeds the multi-bot path.
ALL_MODELS="
opencode|anthropic/claude-fable-5|fable5
opencode|anthropic/claude-opus-4-8|opus48
opencode|anthropic/claude-opus-4-7|opus47
opencode|anthropic/claude-opus-4-6|opus
opencode|anthropic/claude-opus-4-5|opus45
opencode|anthropic/claude-sonnet-5|sonnet5
opencode|anthropic/claude-sonnet-4-6|sonnet46
opencode|anthropic/claude-sonnet-4-5|sonnet45
opencode|anthropic/claude-haiku-4-5|haiku
opencode|openai/gpt-5.3-codex|codex53
opencode|openai/gpt-5.4|gpt54
opencode|openai/gpt-5.4-mini|gpt54mini
opencode|openai/gpt-5.4-nano|gpt54nano
opencode|openai/gpt-5.5|gpt55
opencode|gemini/gemini-3-pro-preview|gemini
opencode|gemini/gemini-3.1-pro-preview|gemini31
opencode|gemini/gemini-3-flash-preview|geminiflash
opencode|gemini/gemini-3.5-flash|gemini35flash
glm-opencode|openrouter/z-ai/glm-5|glm
glm52-opencode|openrouter/z-ai/glm-5.2|glm52
kimi-opencode|openrouter/moonshotai/kimi-k2.5|kimi
qwen3-opencode|openrouter/qwen/qwen3-coder-next|qwen3
qwen35-opencode|openrouter/qwen/qwen3.5-35b-a3b|qwen35
qwen3max-opencode|openrouter/qwen/qwen3-max|qwen3max
"

ALL_MODEL_LABELS="fable5 opus48 opus47 opus opus45 sonnet5 sonnet46 sonnet45 haiku codex53 gpt55 gpt54 gpt54mini gpt54nano gemini gemini31 geminiflash gemini35flash glm glm52 kimi qwen3 qwen35 qwen3max"

# ── sandbox_timeout_for_horizon: horizon → Modal sandbox backstop ──
# Generous ceilings: a too-small value kills runs mid-flight (unfair zero
# scores); a large one only matters if the sandbox hangs.
sandbox_timeout_for_horizon() {
  case "$1" in
    5m)   echo 3600 ;;
    15m)  echo 3600 ;;
    30m)  echo 7200 ;;
    45m)  echo 7200 ;;
    60m)  echo 10800 ;;
    *)    echo 3600 ;;
  esac
}

# ── run_timeout_for_horizon: horizon → opencode bash-loop budget ──
# Must be < task.toml agent timeout (horizon + 120s) so the opencode loop
# exits cleanly before harbor fires AgentTimeoutError, leaving the verifier
# time to read the save file.
run_timeout_for_horizon() {
  case "$1" in
    5m)   echo 300 ;;
    15m)  echo 900 ;;
    30m)  echo 1800 ;;
    45m)  echo 2700 ;;
    60m)  echo 3600 ;;
    *)    echo 900 ;;
  esac
}

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
#   ENV_PREFIX      — env vars to prepend to the harbor command
#   AGENT_FLAG      — agent flag for harbor (e.g. -a 'claude-code')
#   AGENT_ENV_FLAGS — --ae credential flags forwarded into the sandbox
#                     (used by the multi-bot launch scripts; the skill and
#                     gold scripts forward creds via ENV_PREFIX and ignore
#                     this, so it is set best-effort and never skips them).
# Returns 1 if model should be skipped (missing credentials).
configure_model_env() {
  local model_name="$1"
  local agents_dir="$2"

  ENV_PREFIX=""
  AGENT_FLAG="-a '$(echo "$3" | cut -d'|' -f1)'"
  AGENT_ENV_FLAGS=""

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

  # Forward provider credentials into the sandbox via --ae, keyed on the
  # model-id provider prefix. Best-effort and non-fatal: the multi-bot
  # scripts consume $AGENT_ENV_FLAGS; the skill/gold scripts ignore it
  # (they forward creds through ENV_PREFIX), so a missing key here must
  # NOT skip those models — hence no `return 1`.
  case "$(echo "$3" | cut -d'|' -f2)" in
    anthropic/*)        [ -n "${ANTHROPIC_API_KEY:-}" ]  && AGENT_ENV_FLAGS="--ae ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}" ;;
    openai/*)           [ -n "${OPENAI_API_KEY:-}" ]     && AGENT_ENV_FLAGS="--ae OPENAI_API_KEY=${OPENAI_API_KEY}" ;;
    gemini/*|google/*)  [ -n "${GEMINI_API_KEY:-}" ]     && AGENT_ENV_FLAGS="--ae GEMINI_API_KEY=${GEMINI_API_KEY}" ;;
    openrouter/*)       [ -n "${OPENROUTER_API_KEY:-}" ] && AGENT_ENV_FLAGS="--ae OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" ;;
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
