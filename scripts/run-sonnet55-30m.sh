#!/bin/bash
# Claude Sonnet 5.5 (claude-sonnet-5-5, GA 2026-09-28), all 16 skills, 30m horizon.
# Produces the `sonnet55` row (extractor KNOWN_MODELS + shared-constants + pricing.ts).
#
# Auth: OPENROUTER_API_KEY from .env via OpenRouter's Anthropic-compatible endpoint
# (our direct Anthropic API keys are dead). Same claude-code harness as every other
# Claude row — harbor forwards ANTHROPIC_BASE_URL and, when it is set, passes the full
# `anthropic/claude-sonnet-5.5` slug as ANTHROPIC_MODEL (plus all alias/subagent
# models). OpenRouter accepts the key as x-api-key. Adaptive thinking is verified to
# come through (signed thinking blocks) on Claude Code 2.1.284.
#
# Effort is left at the CLI default; CLAUDE_EFFORT is unset because the interactive
# shell leaks CLAUDE_EFFORT=high.
#
# Usage:
#   scripts/run-sonnet55-30m.sh                       # all 16 skills
#   scripts/run-sonnet55-30m.sh firemaking prayer     # re-run specific skills only
#   SONNET55_EFFORT=xhigh scripts/run-sonnet55-30m.sh # row `sonnet55-xhigh`
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

set -a; source .env 2>/dev/null || true; set +a
: "${OPENROUTER_API_KEY:?OPENROUTER_API_KEY missing from .env}"
unset CLAUDE_EFFORT CLAUDE_CODE_EFFORT_LEVEL CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_AUTH_TOKEN ANTHROPIC_WORKSPACE_ID ANTHROPIC_CUSTOM_HEADERS
export ANTHROPIC_BASE_URL="https://openrouter.ai/api"
export ANTHROPIC_API_KEY="$OPENROUTER_API_KEY"

MODEL="${SONNET55_MODEL:-anthropic/claude-sonnet-5.5}"

# Optional effort variant: SONNET55_EFFORT=xhigh → row `sonnet55-xhigh` (job token
# `sonnet55-xhigh`; KNOWN_MODELS lists it BEFORE `sonnet55`).
EFFORT="${SONNET55_EFFORT:-}"
EFFORT_ARGS=()
LABEL="sonnet55"
if [ -n "$EFFORT" ]; then
  EFFORT_ARGS=(--ak "reasoning_effort=${EFFORT}")
  LABEL="sonnet55-${EFFORT}"
fi

# Preflight: fail fast on auth/model problems before paying for 16 sandboxes.
PROBE=$(curl -s "$ANTHROPIC_BASE_URL/v1/messages" \
  -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d "{\"model\":\"${MODEL}\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}")
if ! grep -q '"type":"message"' <<<"$PROBE"; then
  echo "Preflight API probe failed:" >&2; echo "$PROBE" >&2; exit 1
fi
echo "Preflight OK ($MODEL via OpenRouter)"

if [ "$#" -gt 0 ]; then
  SKILLS="$*"
else
  SKILLS="attack defence strength hitpoints ranged prayer magic woodcutting fishing mining cooking fletching crafting smithing firemaking thieving"
fi

TASK_FLAGS=()
for s in $SKILLS; do
  TASK_FLAGS+=(-i "${s}-xp-30m")
done

bun generate-tasks.ts >/dev/null

TS=$(date +%Y%m%d-%H%M%S)
JOB="skills-30m-${LABEL}-${TS}"
echo "JOB=$JOB (model=$MODEL effort=${EFFORT:-default})"

harbor run \
  -p tasks \
  "${TASK_FLAGS[@]}" \
  -a claude-code \
  -m "$MODEL" \
  --job-name "$JOB" \
  --env modal \
  --ek sandbox_timeout_secs=7200 \
  -n 16 -k 1 ${EFFORT_ARGS[@]+"${EFFORT_ARGS[@]}"} 2>&1 | tee "/tmp/harbor-${JOB}.log"
