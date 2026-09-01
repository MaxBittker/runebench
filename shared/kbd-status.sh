#!/bin/bash
# kbd-status <YOUR_BOT> — time remaining + the TEAM's server-verified King
# Black Dragon kill count (plus your own credited kills/damage and the
# dragon's last-seen live HP).
#
# The count comes from the dragon watcher's endpoint (/rank on RANK_PORT,
# default 8791), which reads the ENGINE's kill ledger — the only number that
# scores. On a single-box run the watcher is on localhost; on split-topology
# agent boxes the split adapter writes the server box's tunneled URL to
# /tmp/rank-url.
BOT="$1"
if [ -z "$BOT" ]; then
    echo "usage: kbd-status YOUR_BOT" >&2
    exit 2
fi
time-left || true
BASE=""
[ -s /tmp/rank-url ] && BASE=$(head -n1 /tmp/rank-url | tr -d '[:space:]')
[ -z "$BASE" ] && BASE="http://localhost:${RANK_PORT:-8791}"
STATUS=$(curl -sf --max-time 10 "${BASE%/}/rank?bot=${BOT}")
if [ -n "$STATUS" ]; then
    echo "$STATUS"
else
    echo "kbd-status: kill tracker unavailable right now — try again in a few seconds" >&2
    exit 1
fi
