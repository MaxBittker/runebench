#!/bin/bash
# Fetch all completed smith-team / magic-team results from the nanny and render
# a standalone HTML report. Safe to re-run repeatedly as more runs finish —
# it only pulls jobs that have a verifier/reward.txt (i.e. completed).
#
# Usage: scripts/build-team-report.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REMOTE="${REMOTE:-runebench-nanny.exe.xyz}"
REMOTE_JOBS="${REMOTE_JOBS:-rs-bench3/jobs}"
LOCAL="${LOCAL:-/tmp/team-results}"
OUT="$REPO_ROOT/team-events-report.html"

mkdir -p "$LOCAL"

echo "[report] Discovering completed team jobs on $REMOTE ..."
# For each team job dir with a completed trial (has verifier/reward.txt), print:
#   <jobname>|<trial-subdir-abspath>
DONE_LIST=$(ssh "$REMOTE" '
  for j in ~/'"$REMOTE_JOBS"'/smith-team-* ~/'"$REMOTE_JOBS"'/magic-team-* ~/'"$REMOTE_JOBS"'/crafting-team-*; do
    [ -d "$j" ] || continue
    d=$(ls -d "$j"/*__* 2>/dev/null | head -1)
    [ -n "$d" ] && [ -f "$d/verifier/reward.txt" ] && echo "$(basename "$j")|$d"
  done
  true')

n=$(printf '%s\n' "$DONE_LIST" | grep -c '|' || true)
echo "[report] $n completed job(s) found."
printf '%s\n' "$DONE_LIST" | while IFS= read -r line; do
  [ -z "$line" ] && continue
  job="${line%%|*}"; dir="${line#*|}"
  mkdir -p "$LOCAL/$job/verifier"
  # small analysis files only — never the mp4s / trajectories
  for rel in result.json verifier/reward.json verifier/chat-transcript.txt verifier/test-stdout.txt; do
    scp -q "$REMOTE:$dir/$rel" "$LOCAL/$job/$rel" 2>/dev/null || true
  done
done

echo "[report] Rendering HTML ..."
LOCAL="$LOCAL" OUT="$OUT" bun "$SCRIPT_DIR/build-team-report.ts"
echo "[report] Wrote $OUT"
