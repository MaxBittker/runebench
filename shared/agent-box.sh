#!/bin/bash
# Per-agent sandbox services for SPLIT team tasks (1 box per agent + 1 server
# box). Uploaded and launched by agents/opencode_split_adapter.py in each agent
# sandbox. Runs the CLIENT side only: Xvfb + one chromium bot client
# (launch-bot.ts) pointed at the server box's Modal tunnels + ffmpeg recording.
# The OpenCode session itself is exec'd separately by the adapter.
#
# Env contract (set by the adapter):
#   BOT_NAME            this box's bot username (required)
#   SERVER_WEB_URL      https tunnel origin of the server box engine (port 8888)
#   GATEWAY_URL         wss tunnel URL of the server box gateway (port 7780)
#   LOGIN_STAGGER_SEC   delay before first login so the engine sees one new
#                       session at a time across the fleet (default 0)
#   RECORD_VIDEO        1 to record the display (default 1)
set -u

BOT_NAME="${BOT_NAME:?BOT_NAME is required}"
SERVER_WEB_URL="${SERVER_WEB_URL:?SERVER_WEB_URL is required}"
GATEWAY_URL="${GATEWAY_URL:?GATEWAY_URL is required}"
LOGIN_STAGGER_SEC="${LOGIN_STAGGER_SEC:-0}"
RECORD_VIDEO="${RECORD_VIDEO:-1}"
DISP=":99"

mkdir -p /logs/agent /logs/verifier /logs/tracking

log() { echo "[agent-box] $*"; }

# ── Defuse any locally-running game stack ────────────────────────
# The adapter clears the image ENTRYPOINT for agent boxes, but if it ever
# runs anyway (Modal appends the sandbox command to the entrypoint rather
# than replacing it — that's exactly what happened in the first split runs,
# where every agent box also ran a rogue engine+gateway+watcher+dashboard
# eating ~1 cpu / 1.6 GB) it must be stopped BEFORE we start our client. Take
# down the entrypoint's watchdog/supervisor subshells first (they'd otherwise
# restart whatever we kill), then the services. PID 1/2 (dumb-init and the
# entrypoint script itself) are left alone: killing them ends the sandbox.
# Process names are cwd-relative (`bun run src/app.ts`), so match on those.
for pid in $(pgrep -f "entrypoint(-server|-team|-duo)?\.sh" 2>/dev/null); do
    [ "$pid" -le 2 ] && continue
    kill "$pid" 2>/dev/null || true
done
pkill -f "run src/app\.ts" 2>/dev/null || true       # engine
pkill -f "run gateway\.ts" 2>/dev/null || true
pkill -f "run launch-bot\.ts" 2>/dev/null || true
pkill -f "shared/[a-z_]*watcher\.ts" 2>/dev/null || true
pkill -f "shared/skill_tracker\.ts" 2>/dev/null || true
pkill -f "shared/dashboard\.ts" 2>/dev/null || true
if pgrep -f "run src/app\.ts" > /dev/null 2>&1; then
    sleep 2
    pkill -9 -f "run src/app\.ts" 2>/dev/null || true
    log "WARNING: a local game engine was running on this agent box (image entrypoint fired) — killed"
fi

# ── Provision this bot's SDK workspace against the REMOTE server ─
# GATEWAY_URL (exported into every process env by the adapter) is what the
# SDK actually uses (deriveGatewayUrl checks it first); SERVER is set to the
# gateway host for anything that reads bot.env directly, and to defuse the
# template's demo-server default.
GATEWAY_HOST=$(echo "$GATEWAY_URL" | sed -E 's|^wss?://||; s|/.*$||')
# HTTP origin of the gateway (same port serves both WS and HTTP endpoints);
# used by the watchdog to poll /status/<bot>.
case "$GATEWAY_URL" in
    ws://*)  GATEWAY_HTTP="http://${GATEWAY_URL#ws://}" ;;
    wss://*) GATEWAY_HTTP="https://${GATEWAY_URL#wss://}" ;;
    *)       GATEWAY_HTTP="$GATEWAY_URL" ;;
esac
GATEWAY_HTTP="${GATEWAY_HTTP%/}"
mkdir -p "/app/bots/$BOT_NAME"
printf 'BOT_USERNAME=%s\nPASSWORD=test\nSERVER=%s\nGATEWAY_URL=%s\nSHOW_CHAT=true\n' \
    "$BOT_NAME" "$GATEWAY_HOST" "$GATEWAY_URL" > "/app/bots/$BOT_NAME/bot.env"
if [ -f /app/bots/_template/bot.env ]; then
    sed -i "s|^SERVER=.*|SERVER=$GATEWAY_HOST|" /app/bots/_template/bot.env 2>/dev/null || true
    sed -i 's/^SHOW_CHAT=.*/SHOW_CHAT=true/' /app/bots/_template/bot.env 2>/dev/null || true
fi
log "Provisioned /app/bots/$BOT_NAME (server=$GATEWAY_HOST)"

# ── Wait for the server box to be reachable through its tunnel ───
server_ready=0
for i in $(seq 1 300); do
    if curl -sf "$SERVER_WEB_URL" > /dev/null 2>&1; then
        server_ready=1
        break
    fi
    sleep 1
done
if [ "$server_ready" != "1" ]; then
    log "ERROR: server $SERVER_WEB_URL not reachable after 300s"
    # Keep going — launch-bot retries via the watchdog below, and the
    # OpenCode session may still be able to diagnose.
fi
log "Server reachable at $SERVER_WEB_URL"

# ── Virtual display ──────────────────────────────────────────────
Xvfb "$DISP" -screen 0 800x600x24 -ac > /dev/null 2>&1 &
XVFB_PID=$!
sleep 1
log "Xvfb up on $DISP (pid=$XVFB_PID)"

# ── PulseAudio (null sink) ───────────────────────────────────────
# Same setup as the single-bot /entrypoint.sh: chromium runs UNMUTED so the
# recording gets music/sfx, so give it a real (null) sink to render into and
# let ffmpeg capture the sink monitor. (Agent boxes previously ran without any
# audio device; chromium's audio service was the hottest process on bot b's
# box in the 2026-08-16 run — 122% CPU — so a proper sink is also the cheaper
# configuration.) PULSE_SERVER is exported so launch-bot → chromium and
# ffmpeg (started below) share the daemon.
export PULSE_SERVER=unix:/tmp/pulse.sock
pulseaudio -D --exit-idle-time=-1 \
    --load="module-native-protocol-unix auth-anonymous=1 socket=/tmp/pulse.sock" \
    > /dev/null 2>&1 || true
AUDIO_OK=false
for i in $(seq 1 10); do
    if pactl info > /dev/null 2>&1; then AUDIO_OK=true; break; fi
    sleep 1
done
if $AUDIO_OK; then
    pactl load-module module-null-sink sink_name=game > /dev/null
    pactl set-default-sink game
    log "PulseAudio ready (null sink 'game')"
else
    log "WARNING: PulseAudio failed to start — recording will have no audio"
fi

# ── Bot client (chromium via launch-bot.ts) ──────────────────────
start_bot() {
    cd /app/server/gateway && \
        DISPLAY="$DISP" BOT_NAME="$BOT_NAME" \
        BOT_URL="$SERVER_WEB_URL/bot" GATEWAY_URL="$GATEWAY_URL" \
        bun-svc run launch-bot.ts >> /logs/agent/launch-bot.log 2>&1 &
    BOT_PID=$!
    log "Bot client \"$BOT_NAME\" starting on $DISP (pid=$BOT_PID)"
}

sleep "$LOGIN_STAGGER_SEC"
start_bot

# Readiness marker for the adapter: launch-bot logs "is in-game" once the
# client is logged in and past the tutorial check.
(
    for i in $(seq 1 180); do
        if grep -q 'is in-game' /logs/agent/launch-bot.log 2>/dev/null; then
            touch /tmp/bot-ready
            exit 0
        fi
        sleep 1
    done
) &

# ── Screen recording ─────────────────────────────────────────────
FFMPEG_PID=""
if [ "$RECORD_VIDEO" = "1" ]; then
    # Game audio off the null sink's monitor when pulse is up; video-only
    # otherwise so a dead daemon never kills the recording.
    AUDIO_IN=()
    AUDIO_OUT=()
    if $AUDIO_OK; then
        AUDIO_IN=(-f pulse -thread_queue_size 1024 -i game.monitor)
        AUDIO_OUT=(-c:a aac -b:a 64k -ac 1)
    fi
    log "Recording $DISP → recording-$BOT_NAME.mp4 (5 fps, 800x600, crf23, audio=$AUDIO_OK)..."
    ffmpeg -f x11grab -thread_queue_size 1024 -framerate 5 -video_size 800x600 -i "$DISP" \
        "${AUDIO_IN[@]}" \
        -c:v libx264 -preset veryfast -crf 23 \
        -pix_fmt yuv420p \
        "${AUDIO_OUT[@]}" \
        -movflags +frag_keyframe+empty_moov \
        "/logs/verifier/recording-$BOT_NAME.mp4" \
        > "/logs/verifier/ffmpeg-$BOT_NAME.log" 2>&1 &
    FFMPEG_PID=$!
fi

# ── Cleanup + watchdog ───────────────────────────────────────────
SHUTTING_DOWN=false
cleanup() {
    SHUTTING_DOWN=true
    log "Shutting down..."
    if [ -n "$FFMPEG_PID" ]; then
        kill -INT $FFMPEG_PID 2>/dev/null || true
        wait $FFMPEG_PID 2>/dev/null || true
    fi
    kill $XVFB_PID 2>/dev/null || true
}
trap cleanup SIGTERM SIGINT EXIT

# The watchdog covers two distinct failure modes:
#   1. launch-bot's PROCESS died — checked via kill -0.
#   2. launch-bot is alive but its client is dead at the gateway ("process
#      alive, client dead": the 2026-08-14 split-market run lost a bot for 11
#      minutes this way). launch-bot self-heals this itself (page reload after
#      ~30s, exit(1) when it can't recover), so the status poll here is a
#      backstop with a deliberately LONGER deadline — it only fires if
#      launch-bot is wedged too hard to run its own health loop.
restart_bot() {
    kill "$BOT_PID" 2>/dev/null || true   # SIGTERM: launch-bot closes chromium itself
    sleep 3
    # Backstop for a launch-bot too far gone to run its signal handler; this
    # box runs exactly one bot, so a blanket pkill can't hit a teammate.
    pkill -f "launch-bot.ts" 2>/dev/null || true
    pkill -f chromium 2>/dev/null || true
    sleep 1
    start_bot
}

RESTART_COUNT=0
MAX_RESTARTS=10
NONACTIVE_POLLS=0
LAST_STATUS=""
DEAD_STATUS_LIMIT=36    # 'dead' × 5s interval = 3 minutes
STALE_STATUS_LIMIT=60   # any non-active (incl. 'stale') × 5s = 5 minutes — a
                        # wedged chromium can hold 'stale' indefinitely (its
                        # gateway ws lives while no state flows), as seen in
                        # the first market-split run (29 min of 'stale')
SEEN_ACTIVE=0
while true; do
    sleep 5
    if $SHUTTING_DOWN; then break; fi

    client_dead=""
    if ! kill -0 $BOT_PID 2>/dev/null; then
        client_dead="process died"
    else
        status=$(curl -sf -m 8 "$GATEWAY_HTTP/status/$BOT_NAME" 2>/dev/null | grep -o '"status": *"[a-z]*"' | head -1 | grep -o '[a-z]*"$' | tr -d '"' || true)
        if [ "$status" = "active" ]; then
            SEEN_ACTIVE=1
            NONACTIVE_POLLS=0
        elif [ -n "$status" ] && [ "$SEEN_ACTIVE" = "1" ]; then
            # An unreachable gateway (empty status) says nothing about OUR
            # client; 'dead'/'stale' both count, with a longer fuse for stale.
            NONACTIVE_POLLS=$((NONACTIVE_POLLS + 1))
            LAST_STATUS="$status"
            if [ "$status" = "dead" ] && [ $NONACTIVE_POLLS -ge $DEAD_STATUS_LIMIT ]; then
                client_dead="gateway reports status=dead for $((NONACTIVE_POLLS * 5))s and launch-bot has not recovered it"
            elif [ $NONACTIVE_POLLS -ge $STALE_STATUS_LIMIT ]; then
                client_dead="gateway reports status!=active ($LAST_STATUS) for $((NONACTIVE_POLLS * 5))s and launch-bot has not recovered it"
            fi
        fi
    fi
    [ -n "$client_dead" ] || continue

    RESTART_COUNT=$((RESTART_COUNT + 1))
    if [ $RESTART_COUNT -gt $MAX_RESTARTS ]; then
        log "[watchdog] Max restarts ($MAX_RESTARTS) reached, giving up"
        break
    fi
    log "[watchdog] Bot client dead ($client_dead) — restart #$RESTART_COUNT"
    NONACTIVE_POLLS=0
    restart_bot
done

# Keep the box alive for the adapter's artifact collection
tail -f /dev/null
