#!/bin/bash
# 30m skill sweep for any claude-code model served through OpenRouter's
# Anthropic-compatible endpoint, authenticated with OPENROUTER_API_KEY from .env.
#
# Used for older Claude models that are no longer on our (dead) direct Anthropic
# keys but are still on OpenRouter — e.g. claude-sonnet-4 / claude-opus-4.1, which
# OpenRouter routes to Amazon Bedrock. Same claude-code harness as every other
# Claude row; harbor forwards ANTHROPIC_BASE_URL and passes the full OpenRouter
# slug as ANTHROPIC_MODEL. Generalises scripts/run-sonnet55-30m.sh.
#
# Effort is left at the CLI default unless CLAUDE_EFFORT is set explicitly here;
# the interactive shell leaks CLAUDE_EFFORT, so it is read from OR_CLAUDE_EFFORT.
#
# Usage:
#   CLAUDE_MODEL=anthropic/claude-sonnet-4 CLAUDE_LABEL=sonnet4 \
#     scripts/run-claude-openrouter-30m.sh                  # all 16 skills
#   ... scripts/run-claude-openrouter-30m.sh firemaking     # re-run specific skills
#
# CLAUDE_LABEL must match a KNOWN_MODELS key (and a MODEL_PRICING entry).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

: "${CLAUDE_MODEL:?set CLAUDE_MODEL, e.g. anthropic/claude-sonnet-4}"
: "${CLAUDE_LABEL:?set CLAUDE_LABEL, e.g. sonnet4}"
EFFORT="${OR_CLAUDE_EFFORT:-}"

set -a; source .env 2>/dev/null || true; set +a
: "${OPENROUTER_API_KEY:?OPENROUTER_API_KEY missing from .env}"
unset CLAUDE_EFFORT CLAUDE_CODE_EFFORT_LEVEL CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_AUTH_TOKEN ANTHROPIC_WORKSPACE_ID ANTHROPIC_CUSTOM_HEADERS
export ANTHROPIC_BASE_URL="https://openrouter.ai/api"
export ANTHROPIC_API_KEY="$OPENROUTER_API_KEY"

EFFORT_ARGS=()
if [ -n "$EFFORT" ]; then
  EFFORT_ARGS=(--ak "reasoning_effort=${EFFORT}")
fi

# Preflight: fail fast on auth/model problems before paying for 16 sandboxes.
PROBE=$(curl -s "$ANTHROPIC_BASE_URL/v1/messages" \
  -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d "{\"model\":\"${CLAUDE_MODEL}\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}")
if ! grep -q '"type":"message"' <<<"$PROBE"; then
  echo "Preflight API probe failed:" >&2; echo "$PROBE" >&2; exit 1
fi
echo "Preflight OK ($CLAUDE_MODEL via OpenRouter)"

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
JOB="skills-30m-${CLAUDE_LABEL}-${TS}"
echo "JOB=$JOB (model=$CLAUDE_MODEL effort=${EFFORT:-default})"

harbor run \
  -p tasks \
  "${TASK_FLAGS[@]}" \
  -a claude-code \
  -m "$CLAUDE_MODEL" \
  --job-name "$JOB" \
  --env modal \
  --ek sandbox_timeout_secs=7200 \
  -n 16 -k 1 ${EFFORT_ARGS[@]+"${EFFORT_ARGS[@]}"} 2>&1 | tee "/tmp/harbor-${JOB}.log"
