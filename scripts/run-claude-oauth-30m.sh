#!/bin/bash
# 30m skill sweep for any claude-code model, authenticated with the local Max
# subscription OAuth token instead of an API key.
#
# Why OAuth: pre-release models are often enabled for the Max subscription
# before any of our API keys. Running GA models (fable) the same way keeps the
# auth path — and therefore the rate-limit and cache behaviour — identical
# across compared rows.
#
# All 16 concurrent trials share one five_hour subscription window. Before
# trusting any zeros, check that every rate_limit_event says status "allowed":
#   grep -ho '"status":"[a-z_]*","resetsAt' jobs/<job>/*/agent/claude-code.txt | sort | uniq -c
#
# Usage:
#   CLAUDE_MODEL=anthropic/claude-fable-5 CLAUDE_LABEL=fable-5-v2 \
#     scripts/run-claude-oauth-30m.sh
#   CLAUDE_MODEL=anthropic/claude-fable-5 CLAUDE_LABEL=fable-5-xhigh-v2 \
#     CLAUDE_EFFORT=xhigh scripts/run-claude-oauth-30m.sh
#   ... scripts/run-claude-oauth-30m.sh mining thieving    # subset of skills
#
# CLAUDE_LABEL must be UNIQUE per run, or the extractor merges this run into an
# existing row (newest-with-data wins per skill). Reuse an existing label only
# when deliberately re-running a straggler skill into that row.
#
# Run `bun generate-tasks.ts` before launching.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

: "${CLAUDE_MODEL:?set CLAUDE_MODEL, e.g. anthropic/claude-fable-5}"
: "${CLAUDE_LABEL:?set CLAUDE_LABEL, e.g. fable-5-v2 (must be unique per run)}"

CLAUDE_CODE_OAUTH_TOKEN="$(security find-generic-password -s 'Claude Code-credentials' -w \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["claudeAiOauth"]["accessToken"])')"
: "${CLAUDE_CODE_OAUTH_TOKEN:?could not read OAuth token from keychain — run /login in Claude Code}"
export CLAUDE_CODE_OAUTH_TOKEN
# The sandbox gets a STATIC token (it cannot refresh). Fail early if it expires
# before the run would finish, rather than dying mid-sweep.
python3 - <<'PY'
import json, subprocess, sys, time
tok = json.loads(subprocess.run(
    ["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
    capture_output=True, text=True, check=True).stdout)["claudeAiOauth"]
left = tok["expiresAt"] / 1000 - time.time()
print(f"  OAuth token valid for {left/60:.0f} more minutes")
if left < 45 * 60:
    sys.exit("  ABORT: token expires before a 30m sweep + verifier would finish — /login first")
PY
unset ANTHROPIC_API_KEY

if [ "$#" -gt 0 ]; then
  SKILLS="$*"
else
  SKILLS="attack defence strength hitpoints ranged prayer magic woodcutting fishing mining cooking fletching crafting smithing firemaking thieving"
fi

TASK_FLAGS=()
for s in $SKILLS; do
  TASK_FLAGS+=(-i "${s}-xp-30m")
done

EFFORT_ARGS=()
if [ -n "${CLAUDE_EFFORT:-}" ]; then
  # `reasoning_effort` (not `effort`) is the claude-code agent kwarg; xhigh/max are
  # only accepted if harbor's claude_code.py choices list is patched locally.
  EFFORT_ARGS=(--ak "reasoning_effort=${CLAUDE_EFFORT}")
fi

FAST_ARGS=()
if [ -n "${CLAUDE_FAST:-}" ]; then
  # Fast mode (Opus only, ~2.5x speed, 2x price) via the locally patched harbor
  # claude_code.py: injects --settings '{"fastMode": true}' and skips the org
  # availability check that CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC suppresses.
  # Bills from the subscription account's USAGE CREDITS, not the plan window.
  # Fast mode silently falls back to standard speed when throttled — audit
  # usage "speed" fields in the trajectories before trusting the row.
  FAST_ARGS=(--ak "fast_mode=true")
fi

TS=$(date +%Y%m%d-%H%M%S)
JOB="skills-30m-${CLAUDE_LABEL}-${TS}"
echo "JOB=$JOB (model=$CLAUDE_MODEL effort=${CLAUDE_EFFORT:-default})"

harbor run \
  -p tasks \
  "${TASK_FLAGS[@]}" \
  -a claude-code \
  -m "$CLAUDE_MODEL" \
  ${EFFORT_ARGS[@]+"${EFFORT_ARGS[@]}"} \
  ${FAST_ARGS[@]+"${FAST_ARGS[@]}"} \
  --job-name "$JOB" \
  --env modal \
  --ek sandbox_timeout_secs=7200 \
  -n 16 -k 1 2>&1 | tee "/tmp/harbor-${JOB}.log"
