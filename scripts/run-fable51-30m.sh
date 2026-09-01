#!/bin/bash
# Claude Fable 5.1 (anthropic/claude-fable-5-1), all 16 skills, 30m horizon.
# Produces the `fable51` row (extractor KNOWN_MODELS + shared-constants + pricing.ts).
#
# Auth: a dedicated, identity-linked (workspace-scoped) API key. Such keys are
# rejected by the API unless every request carries an `anthropic-workspace-id`
# header, so this needs TWO values in .env:
#   FABLE51_API_KEY=sk-ant-api03-...
#   FABLE51_WORKSPACE_ID=wrkspc_...
# The workspace id is exported as ANTHROPIC_WORKSPACE_ID (Claude Code ≥2.1.x reads
# it natively) AND as ANTHROPIC_CUSTOM_HEADERS (older CLIs). harbor's claude_code.py
# is locally patched to forward both into the sandbox (re-apply after harbor
# upgrades — see memory note).
#
# Effort is left at the CLI default; CLAUDE_EFFORT is unset here because the
# interactive shell leaks CLAUDE_EFFORT=high.
#
# Usage:
#   scripts/run-fable51-30m.sh                   # all 16 skills
#   scripts/run-fable51-30m.sh firemaking prayer # re-run specific skills only
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

set -a; source .env 2>/dev/null || true; set +a
: "${FABLE51_API_KEY:?FABLE51_API_KEY missing from .env}"
: "${FABLE51_WORKSPACE_ID:?FABLE51_WORKSPACE_ID missing from .env (wrkspc_...)}"

export ANTHROPIC_API_KEY="$FABLE51_API_KEY"
export ANTHROPIC_WORKSPACE_ID="$FABLE51_WORKSPACE_ID"
export ANTHROPIC_CUSTOM_HEADERS="anthropic-workspace-id: $FABLE51_WORKSPACE_ID"
unset CLAUDE_EFFORT CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_AUTH_TOKEN

MODEL="${FABLE51_MODEL:-anthropic/claude-fable-5-1}"

# Optional effort variant: FABLE51_EFFORT=xhigh → row `fable51-xhigh` (job token
# `fable51-xhigh`; KNOWN_MODELS lists it BEFORE `fable51`). Needs harbor's
# reasoning_effort choices patched to include xhigh/max.
EFFORT="${FABLE51_EFFORT:-}"
EFFORT_ARGS=()
LABEL="fable51"
if [ -n "$EFFORT" ]; then
  EFFORT_ARGS=(--ak "reasoning_effort=${EFFORT}")
  LABEL="fable51-${EFFORT}"
fi

# Preflight: fail fast on auth/workspace problems before paying for 16 sandboxes.
PROBE=$(curl -s https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" \
  -H "anthropic-workspace-id: $ANTHROPIC_WORKSPACE_ID" -H "content-type: application/json" \
  -d "{\"model\":\"${MODEL#anthropic/}\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}")
if ! grep -q '"type":"message"' <<<"$PROBE"; then
  echo "Preflight API probe failed:" >&2; echo "$PROBE" >&2; exit 1
fi
echo "Preflight OK ($MODEL, workspace $ANTHROPIC_WORKSPACE_ID)"

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
