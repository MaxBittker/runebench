#!/bin/bash
# market-status <YOUR_BOT> — time remaining + your current wealth rank.
#
# Rank comes from the market watcher's leaderboard endpoint (/rank on
# RANK_PORT, default 8791). On a single-box run the watcher is on localhost;
# on split-topology agent boxes the split adapter writes the server box's
# tunneled URL to /tmp/rank-url.
BOT="$1"
if [ -z "$BOT" ]; then
    echo "usage: market-status YOUR_BOT" >&2
    exit 2
fi
time-left || true
BASE=""
[ -s /tmp/rank-url ] && BASE=$(head -n1 /tmp/rank-url | tr -d '[:space:]')
[ -z "$BASE" ] && BASE="http://localhost:${RANK_PORT:-8791}"
RANK=$(curl -sf --max-time 10 "${BASE%/}/rank?bot=${BOT}")
if [ -n "$RANK" ]; then
    echo "$RANK"
else
    echo "market-status: leaderboard unavailable right now — try again in a few seconds" >&2
    exit 1
fi
