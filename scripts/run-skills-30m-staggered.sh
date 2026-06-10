#!/bin/bash
# Run 30-minute skill XP benchmarks — all models launched concurrently
# with 2-minute staggered start times.
#
# Each model's output goes to its own log file under /tmp/harbor-staggered-30m-*.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/run-common.sh"

STAGGER_SECS=90

ALL_MODELS="
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
gemini-cli|google/gemini-3-pro-preview|gemini
gemini-cli|google/gemini-3.1-pro-preview|gemini31
gemini-cli|google/gemini-3-flash-preview|geminiflash
glm-opencode|openrouter/z-ai/glm-5|glm
kimi-opencode|openrouter/moonshotai/kimi-k2.5|kimi
qwen35-opencode|openrouter/qwen/qwen3.5-35b-a3b|qwen35
"

ALL_SKILLS="attack defence strength hitpoints ranged prayer magic woodcutting fishing mining cooking fletching crafting smithing firemaking thieving"

load_env "$REPO_ROOT/.env"
GLM_KEY="${GLM_API_KEY:-}"

regenerate_tasks "$REPO_ROOT/generate-tasks.ts"

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
LOG_DIR="/tmp/harbor-staggered-30m-${TIMESTAMP}"
mkdir -p "$LOG_DIR"

echo "Staggered 30m skill run — ${TIMESTAMP}"
echo "Logs: $LOG_DIR"
echo ""

MODEL_LIST="opus opus45 sonnet46 sonnet45 haiku codex codex53 gpt54 gpt54mini gpt54nano gemini gemini31 geminiflash glm kimi qwen35"
PIDS=()
MODEL_NAMES=()
DELAY=0

for model_name in $MODEL_LIST; do
  entry=$(lookup_model "$model_name" "$ALL_MODELS")
  if [ -z "$entry" ]; then
    echo "Unknown model: $model_name — skipping"
    continue
  fi

  IFS='|' read -r agent model label <<< "$entry"

  # Per-model config
  ENV_PREFIX=""
  AGENT_FLAG="-a '$agent'"
  HARBOR_ENV="modal"
  MODEL_EXTRA_ARGS=""

  if ! configure_model_env "$model_name" "$REPO_ROOT/agents" "$entry"; then
    continue
  fi

  case "$model_name" in
    codex|codex53|gpt54|gpt54mini|gpt54nano)
      MODEL_EXTRA_ARGS="--ak run_timeout_sec=1900"
      ;;
    kimi|qwen35)
      MODEL_EXTRA_ARGS="--ak run_timeout_sec=1800"
      ;;
  esac

  if [ "$model_name" = "codex53" ]; then
    CODEX_AUTH_FILE="$HOME/.codex/auth.json"
    if [ ! -f "$CODEX_AUTH_FILE" ]; then
      echo "  WARNING: ~/.codex/auth.json not found, skipping codex53"
      continue
    fi
    CODEX_AUTH_B64=$(base64 < "$CODEX_AUTH_FILE")
    ENV_PREFIX="$ENV_PREFIX CODEX_AUTH_JSON_B64='$CODEX_AUTH_B64'"
  fi

  TASK_FLAGS=""
  for skill in $ALL_SKILLS; do
    TASK_FLAGS="$TASK_FLAGS -t '${skill}-xp-30m'"
  done

  JOB_NAME="skills-30m-${label}-${TIMESTAMP}"
  LOG_FILE="${LOG_DIR}/${label}.log"

  echo "  [+${DELAY}s] $model_name → $LOG_FILE"

  # Launch in a subshell with a sleep delay
  (
    sleep "$DELAY"
    echo "[$(date '+%H:%M:%S')] Starting $model_name ($model)" >> "$LOG_FILE"
    eval "$ENV_PREFIX harbor run \
      -p '$REPO_ROOT/tasks' \
      $TASK_FLAGS \
      $AGENT_FLAG \
      -m '$model' \
      --job-name '$JOB_NAME' \
      --env $HARBOR_ENV \
      --ek sandbox_timeout_secs=7200 \
      -n 16 \
      -k 1 \
      $MODEL_EXTRA_ARGS" >> "$LOG_FILE" 2>&1
    echo "[$(date '+%H:%M:%S')] Finished $model_name (exit=$?)" >> "$LOG_FILE"
  ) &

  PIDS+=($!)
  MODEL_NAMES+=("$model_name")
  DELAY=$((DELAY + STAGGER_SECS))
done

echo ""
echo "All ${#PIDS[@]} models launched (staggered by ${STAGGER_SECS}s)."
echo "PIDs: ${PIDS[*]}"
echo ""
echo "Monitor with:"
echo "  tail -f ${LOG_DIR}/*.log"
echo ""

# Wait for all and report
FAILED=0
for i in "${!PIDS[@]}"; do
  if ! wait "${PIDS[$i]}"; then
    echo "FAILED: ${MODEL_NAMES[$i]} (PID ${PIDS[$i]})"
    FAILED=$((FAILED + 1))
  else
    echo "  DONE: ${MODEL_NAMES[$i]}"
  fi
done

echo ""
if [ "$FAILED" -eq 0 ]; then
  echo "All models complete."
else
  echo "$FAILED of ${#PIDS[@]} model(s) had errors. Check logs in $LOG_DIR"
fi

# ── Retry phase: re-run skills that failed during setup ──────────
echo ""
echo "Scanning for failed skills..."

RETRY_TOTAL=0
RETRY_DIR=$(mktemp -d)

for model_name in $MODEL_LIST; do
  entry=$(lookup_model "$model_name" "$ALL_MODELS")
  [ -z "$entry" ] && continue
  IFS='|' read -r agent model label <<< "$entry"
  JOB_DIR="$REPO_ROOT/jobs/skills-30m-${label}-${TIMESTAMP}"
  [ ! -d "$JOB_DIR" ] && continue

  MISSING=""
  for skill in $ALL_SKILLS; do
    # Check if any task dir for this skill has a reward file
    found_reward=false
    for taskdir in "$JOB_DIR"/${skill}-xp-30m__*; do
      [ -d "$taskdir" ] && [ -f "$taskdir/verifier/reward.json" ] && found_reward=true && break
    done
    if ! $found_reward; then
      MISSING="$MISSING $skill"
    fi
  done

  if [ -n "$MISSING" ]; then
    echo "$MISSING" > "$RETRY_DIR/$model_name"
    n=$(echo $MISSING | wc -w | tr -d ' ')
    RETRY_TOTAL=$((RETRY_TOTAL + n))
    echo "  $model_name: $n missing —$MISSING"
  fi
done

if [ "$RETRY_TOTAL" -eq 0 ]; then
  echo "No failed skills — all results complete."
else
  echo ""
  echo "Retrying $RETRY_TOTAL failed skill(s)..."

  RETRY_PIDS=()
  RETRY_LABELS=()

  for model_name in $MODEL_LIST; do
    [ ! -f "$RETRY_DIR/$model_name" ] && continue
    RETRY_SKILLS=$(cat "$RETRY_DIR/$model_name")

    entry=$(lookup_model "$model_name" "$ALL_MODELS")
    [ -z "$entry" ] && continue
    IFS='|' read -r agent model label <<< "$entry"

    # Re-configure model env
    ENV_PREFIX=""
    AGENT_FLAG="-a '$agent'"
    HARBOR_ENV="modal"
    MODEL_EXTRA_ARGS=""

    if ! configure_model_env "$model_name" "$REPO_ROOT/agents" "$entry"; then
      continue
    fi

    case "$model_name" in
      codex|codex53|gpt54)
        MODEL_EXTRA_ARGS="--ak run_timeout_sec=1900"
        ;;
      kimi|qwen35)
        MODEL_EXTRA_ARGS="--ak run_timeout_sec=1800"
        ;;
    esac

    if [ "$model_name" = "codex53" ]; then
      CODEX_AUTH_FILE="$HOME/.codex/auth.json"
      if [ ! -f "$CODEX_AUTH_FILE" ]; then
        echo "  WARNING: ~/.codex/auth.json not found, skipping codex53 retry"
        continue
      fi
      CODEX_AUTH_B64=$(base64 < "$CODEX_AUTH_FILE")
      ENV_PREFIX="$ENV_PREFIX CODEX_AUTH_JSON_B64='$CODEX_AUTH_B64'"
    fi

    # Build task flags for missing skills only
    TASK_FLAGS=""
    for skill in $RETRY_SKILLS; do
      TASK_FLAGS="$TASK_FLAGS -t '${skill}-xp-30m'"
    done

    RETRY_JOB_NAME="skills-30m-${label}-${TIMESTAMP}-retry"
    RETRY_LOG_FILE="${LOG_DIR}/${label}-retry.log"
    RETRY_N=$(echo $RETRY_SKILLS | wc -w | tr -d ' ')

    echo "  Retrying $model_name ($RETRY_N skills) → $RETRY_LOG_FILE"

    (
      echo "[$(date '+%H:%M:%S')] Retry starting $model_name ($model)" >> "$RETRY_LOG_FILE"
      eval "$ENV_PREFIX harbor run \
        -p '$REPO_ROOT/tasks' \
        $TASK_FLAGS \
        $AGENT_FLAG \
        -m '$model' \
        --job-name '$RETRY_JOB_NAME' \
        --env $HARBOR_ENV \
        --ek sandbox_timeout_secs=7200 \
        -n $RETRY_N \
        -k 1 \
        $MODEL_EXTRA_ARGS" >> "$RETRY_LOG_FILE" 2>&1
      echo "[$(date '+%H:%M:%S')] Retry finished $model_name (exit=$?)" >> "$RETRY_LOG_FILE"
    ) &

    RETRY_PIDS+=($!)
    RETRY_LABELS+=("$model_name")
  done

  # Wait for all retries
  echo ""
  echo "Waiting for ${#RETRY_PIDS[@]} retry job(s)..."
  RETRY_FAILED=0
  for i in "${!RETRY_PIDS[@]}"; do
    if ! wait "${RETRY_PIDS[$i]}"; then
      echo "  RETRY FAILED: ${RETRY_LABELS[$i]}"
      RETRY_FAILED=$((RETRY_FAILED + 1))
    else
      echo "  RETRY DONE: ${RETRY_LABELS[$i]}"
    fi
  done

  # Final scan to see how many gaps were filled
  echo ""
  echo "Post-retry scan..."
  STILL_MISSING=0
  for model_name in $MODEL_LIST; do
    [ ! -f "$RETRY_DIR/$model_name" ] && continue
    RETRY_SKILLS=$(cat "$RETRY_DIR/$model_name")

    entry=$(lookup_model "$model_name" "$ALL_MODELS")
    [ -z "$entry" ] && continue
    IFS='|' read -r agent model label <<< "$entry"

    # Check both original and retry job dirs
    ORIG_JOB_DIR="$REPO_ROOT/jobs/skills-30m-${label}-${TIMESTAMP}"
    RETRY_JOB_DIR="$REPO_ROOT/jobs/skills-30m-${label}-${TIMESTAMP}-retry"

    MODEL_STILL_MISSING=""
    for skill in $RETRY_SKILLS; do
      found_reward=false
      for jobdir in "$ORIG_JOB_DIR" "$RETRY_JOB_DIR"; do
        for taskdir in "$jobdir"/${skill}-xp-30m__*; do
          [ -d "$taskdir" ] && [ -f "$taskdir/verifier/reward.json" ] && found_reward=true && break 2
        done
      done
      if ! $found_reward; then
        MODEL_STILL_MISSING="$MODEL_STILL_MISSING $skill"
        STILL_MISSING=$((STILL_MISSING + 1))
      fi
    done

    if [ -n "$MODEL_STILL_MISSING" ]; then
      echo "  $model_name: still missing —$MODEL_STILL_MISSING"
    fi
  done

  rm -rf "$RETRY_DIR"

  FILLED=$((RETRY_TOTAL - STILL_MISSING))
  echo ""
  echo "Retry summary: $FILLED of $RETRY_TOTAL gaps filled."
  if [ "$STILL_MISSING" -gt 0 ]; then
    echo "  $STILL_MISSING skill(s) still missing after retry."
  fi
fi

echo ""
echo "Next steps:"
echo "  bun extractors/extract-skill-results.ts --horizon 30m"
echo "  open views/graph-skills.html?horizon=30m"
