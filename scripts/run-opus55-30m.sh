#!/bin/bash
# Claude Opus 5.5 (anthropic/claude-opus-5-5, GA 2026-09-22), all 16 skills, 30m horizon.
# Produces the `opus55` row (extractor KNOWN_MODELS + shared-constants + pricing.ts).
#
# Auth: plain ANTHROPIC_API_KEY from .env (no workspace header needed). Effort is
# left at the CLI default (API default for this model is `medium`); CLAUDE_EFFORT
# is unset here because the interactive shell leaks CLAUDE_EFFORT=high.
#
# Usage:
#   scripts/run-opus55-30m.sh                     # all 16 skills
#   scripts/run-opus55-30m.sh firemaking prayer   # re-run specific skills only
#   OPUS55_EFFORT=xhigh scripts/run-opus55-30m.sh # row `opus55-xhigh`
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

set -a; source .env 2>/dev/null || true; set +a
: "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY missing from .env}"
unset CLAUDE_EFFORT CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_AUTH_TOKEN ANTHROPIC_WORKSPACE_ID ANTHROPIC_CUSTOM_HEADERS

MODEL="${OPUS55_MODEL:-anthropic/claude-opus-5-5}"

# Optional effort variant: OPUS55_EFFORT=xhigh → row `opus55-xhigh` (job token
# `opus55-xhigh`; KNOWN_MODELS lists it BEFORE `opus55`). Needs harbor's
# reasoning_effort choices patched to include xhigh/max.
EFFORT="${OPUS55_EFFORT:-}"
EFFORT_ARGS=()
LABEL="opus55"
if [ -n "$EFFORT" ]; then
  EFFORT_ARGS=(--ak "reasoning_effort=${EFFORT}")
  LABEL="opus55-${EFFORT}"
fi

# Preflight: fail fast on auth/model problems before paying for 16 sandboxes.
PROBE=$(curl -s https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d "{\"model\":\"${MODEL#anthropic/}\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}")
if ! grep -q '"type":"message"' <<<"$PROBE"; then
  echo "Preflight API probe failed:" >&2; echo "$PROBE" >&2; exit 1
fi
echo "Preflight OK ($MODEL)"

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
  -n 16 -k 1 "${EFFORT_ARGS[@]}" 2>&1 | tee "/tmp/harbor-${JOB}.log"
