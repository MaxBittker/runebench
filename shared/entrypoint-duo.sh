#!/bin/bash
# Duo entrypoint for the Shield of Arrav task: launches TWO bot clients
# (agenta + agentb) plus the arrav completion watcher instead of the
# single-bot skill tracker. Copied into the task image as /entrypoint-duo.sh
# by the task's environment/Dockerfile (overriding /entrypoint.sh).
#
# Each bot renders to its OWN Xvfb display (:99, :100, …) and is captured by
# its own ffmpeg → /logs/verifier/recording-<bot>.mp4, so the two clients can
# be shown side by side. recording.mp4 is kept as a copy of the first bot's
# feed for back-compat with single-video tooling.
set -e

BOT_NAMES="${BOT_NAMES:-agenta agentb}"
RECORD_VIDEO="${RECORD_VIDEO:-1}"
FIRST_BOT="$(echo $BOT_NAMES | awk '{print $1}')"

# display for the i-th bot (0-indexed) = :(99+i)
disp_for() { echo ":$((99 + $1))"; }

# ── Xvfb virtual displays (one per bot) ──────────────────────────
XVFB_PIDS=""
start_displays() {
    XVFB_PIDS=""
    local i=0
    for name in $BOT_NAMES; do
        local disp; disp="$(disp_for $i)"
        echo "[entrypoint-duo] Starting Xvfb on $disp for \"$name\"..."
        Xvfb "$disp" -screen 0 800x600x24 -ac > /dev/null 2>&1 &
        XVFB_PIDS="$XVFB_PIDS $!"
        i=$((i + 1))
    done
    sleep 1
}

# ── Helper: start engine and wait for readiness ──────────────────
start_engine() {
    cd /app/server/engine && bun-svc run src/app.ts &
    ENGINE_PID=$!
    echo "[entrypoint-duo] Engine starting (pid=$ENGINE_PID)..."
    for i in $(seq 1 120); do
        if curl -sf http://localhost:8888 > /dev/null 2>&1; then
            echo "[entrypoint-duo] Engine ready on port 8888"
            return 0
        fi
        if ! kill -0 $ENGINE_PID 2>/dev/null; then
            echo "[entrypoint-duo] Engine process died during startup"
            return 1
        fi
        sleep 1
    done
    echo "[entrypoint-duo] ERROR: Engine failed to start within 120s"
    return 1
}

# ── Helper: start gateway and wait for readiness ─────────────────
start_gateway() {
    cd /app/server/gateway && bun-svc run gateway.ts &
    GATEWAY_PID=$!
    echo "[entrypoint-duo] Gateway starting (pid=$GATEWAY_PID)..."
    for i in $(seq 1 30); do
        if curl -sf http://localhost:7780 > /dev/null 2>&1; then
            echo "[entrypoint-duo] Gateway ready on port 7780"
            return 0
        fi
        sleep 1
    done
    echo "[entrypoint-duo] Gateway ready (assumed after 30s)"
    return 0
}

# ── Helper: pre-provision SDK workspaces for both bots ───────────
# The image only ships /app/bots/agent (single-bot tasks). Without a per-bot
# dir, agents self-provision from _template/bot.env, whose SERVER default
# points at the remote demo server — a password-walled dead end inside the
# sandbox that costs minutes per bot.
provision_workspaces() {
    for name in $BOT_NAMES; do
        mkdir -p "/app/bots/$name"
        if [ ! -f "/app/bots/$name/bot.env" ]; then
            printf 'BOT_USERNAME=%s\nPASSWORD=test\nSERVER=localhost\nSHOW_CHAT=true\n' \
                "$name" > "/app/bots/$name/bot.env"
        fi
    done
    # Defuse the template's demo-server default for any bot dir an agent
    # still creates by hand, and keep teammate chat visible (create-bot.ts
    # flips the template to SHOW_CHAT=false, which silently breaks in-game
    # coordination on team tasks).
    if [ -f /app/bots/_template/bot.env ]; then
        sed -i 's/^SERVER=.*/SERVER=localhost/' /app/bots/_template/bot.env 2>/dev/null || true
        grep -q '^SERVER=' /app/bots/_template/bot.env || echo 'SERVER=localhost' >> /app/bots/_template/bot.env
        sed -i 's/^SHOW_CHAT=.*/SHOW_CHAT=true/' /app/bots/_template/bot.env 2>/dev/null || true
        grep -q '^SHOW_CHAT=' /app/bots/_template/bot.env || echo 'SHOW_CHAT=true' >> /app/bots/_template/bot.env
    fi
    echo "[entrypoint-duo] Provisioned /app/bots/{$(echo $BOT_NAMES | tr ' ' ',')}"
}

# ── Helper: start each bot client on its own display ─────────────
# Sets BOT_PIDS (space-separated, same order as BOT_NAMES).
start_bots() {
    BOT_PIDS=""
    local i=0
    for name in $BOT_NAMES; do
        local disp; disp="$(disp_for $i)"
        cd /app/server/gateway && DISPLAY="$disp" BOT_NAME="$name" bun-svc run launch-bot.ts &
        BOT_PIDS="$BOT_PIDS $!"
        echo "[entrypoint-duo] Bot client \"$name\" starting on $disp (pid=$!)..."
        # Stagger logins so the engine handles one new session at a time
        sleep 5
        i=$((i + 1))
    done
    # Give extra time for both clients to settle in-game
    sleep 25
    echo "[entrypoint-duo] Bots should be ready"
}

# ── Helper: start the arrav completion watcher ───────────────────
start_watcher() {
    mkdir -p /logs/tracking
    cd /app && BOT_NAMES="$BOT_NAMES" TRACKING_FILE=/logs/tracking/arrav_tracking.json \
      nohup bun-svc run benchmark/shared/arrav_watcher.ts >> /logs/tracking/arrav_watcher.log 2>&1 &
    WATCHER_PID=$!
    echo "[entrypoint-duo] Arrav watcher started (pid=$WATCHER_PID)"
}

# ── Helper: start one screen recording per bot display ───────────
FFMPEG_PIDS=""
start_recording() {
    [ "$RECORD_VIDEO" = "1" ] || return 0
    FFMPEG_PIDS=""
    mkdir -p /logs/verifier
    local i=0
    for name in $BOT_NAMES; do
        local disp; disp="$(disp_for $i)"
        echo "[entrypoint-duo] Recording $disp → recording-$name.mp4 (5 fps, 800x600, crf23)..."
        ffmpeg -f x11grab -framerate 5 -video_size 800x600 -i "$disp" \
            -c:v libx264 -preset veryfast -crf 23 \
            -pix_fmt yuv420p \
            -movflags +frag_keyframe+empty_moov \
            "/logs/verifier/recording-$name.mp4" \
            > "/logs/verifier/ffmpeg-$name.log" 2>&1 &
        FFMPEG_PIDS="$FFMPEG_PIDS $!"
        i=$((i + 1))
    done
    sleep 2
}

# ── Initial startup ──────────────────────────────────────────────

echo "[entrypoint-duo] Provisioning bot workspaces..."
provision_workspaces

echo "[entrypoint-duo] Starting virtual displays..."
start_displays

echo "[entrypoint-duo] Starting game engine..."
if ! start_engine; then
    echo "[entrypoint-duo] FATAL: Engine failed to start on initial boot"
    exit 1
fi

echo "[entrypoint-duo] Starting gateway..."
start_gateway

echo "[entrypoint-duo] Launching bot clients ($BOT_NAMES)..."
start_bots

echo "[entrypoint-duo] Starting arrav watcher..."
start_watcher

echo "[entrypoint-duo] Starting screen recordings..."
start_recording

echo "[entrypoint-duo] All services running (engine=$ENGINE_PID, gateway=$GATEWAY_PID, bots=$BOT_PIDS)"

# ── Cleanup handler ──────────────────────────────────────────────
SHUTTING_DOWN=false
cleanup() {
    SHUTTING_DOWN=true
    echo "[entrypoint-duo] Shutting down..."
    if [ -n "$FFMPEG_PIDS" ]; then
        echo "[entrypoint-duo] Stopping recordings..."
        for pid in $FFMPEG_PIDS; do kill -INT $pid 2>/dev/null; done
        for pid in $FFMPEG_PIDS; do wait $pid 2>/dev/null || true; done
        # Back-compat: single-video tooling expects recording.mp4
        cp "/logs/verifier/recording-$FIRST_BOT.mp4" /logs/verifier/recording.mp4 2>/dev/null || true
        echo "[entrypoint-duo] Recordings saved (recording-<bot>.mp4 per bot)"
    fi
    for pid in $XVFB_PIDS; do kill $pid 2>/dev/null || true; done
}
trap cleanup SIGTERM SIGINT EXIT

# ── Watchdog: restart engine/gateway/bots/watcher if they die ────
# (Displays + recordings persist across restarts — the X servers don't die
# when a client does, and ffmpeg keeps grabbing the same display.)
WATCHDOG_INTERVAL=5
RESTART_COUNT=0
MAX_RESTARTS=10

while true; do
    sleep $WATCHDOG_INTERVAL

    if $SHUTTING_DOWN; then
        break
    fi

    engine_alive=true
    gateway_alive=true
    bots_alive=true
    watcher_alive=true

    if ! kill -0 $ENGINE_PID 2>/dev/null; then
        engine_alive=false
    fi
    if ! kill -0 $GATEWAY_PID 2>/dev/null; then
        gateway_alive=false
    fi
    for pid in $BOT_PIDS; do
        if ! kill -0 $pid 2>/dev/null; then
            bots_alive=false
        fi
    done

    # Watcher — use lock file since agents may have killed and restarted it
    if [ -f /tmp/arrav_watcher.lock ]; then
        lock_pid=$(cat /tmp/arrav_watcher.lock 2>/dev/null)
        if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
            WATCHER_PID=$lock_pid  # adopt restarted watcher
        else
            watcher_alive=false
        fi
    elif ! kill -0 $WATCHER_PID 2>/dev/null; then
        watcher_alive=false
    fi

    if $engine_alive && $gateway_alive && $bots_alive && $watcher_alive; then
        continue
    fi

    # Watcher-only death: restart it without touching the game stack
    if $engine_alive && $gateway_alive && $bots_alive && ! $watcher_alive; then
        echo "[watchdog] Watcher died, restarting..."
        start_watcher
        continue
    fi

    RESTART_COUNT=$((RESTART_COUNT + 1))
    if [ $RESTART_COUNT -gt $MAX_RESTARTS ]; then
        echo "[watchdog] Max restarts ($MAX_RESTARTS) reached, giving up"
        break
    fi

    echo "[watchdog] Dead process detected (engine=$engine_alive gateway=$gateway_alive bots=$bots_alive watcher=$watcher_alive) — restart #$RESTART_COUNT"

    # Kill any remaining pieces to do a clean restart
    kill $ENGINE_PID 2>/dev/null || true
    kill $GATEWAY_PID 2>/dev/null || true
    for pid in $BOT_PIDS; do kill $pid 2>/dev/null || true; done
    kill $WATCHER_PID 2>/dev/null || true
    sleep 2

    if ! start_engine; then
        echo "[watchdog] Engine failed to restart, will retry next cycle"
        continue
    fi
    start_gateway
    start_bots
    start_watcher

    echo "[watchdog] Services restored (engine=$ENGINE_PID, gateway=$GATEWAY_PID, bots=$BOT_PIDS, watcher=$WATCHER_PID)"
done &
WATCHDOG_PID=$!

# Keep container alive. Use `wait` so bash can process SIGTERM from
# docker stop (unlike sleep, wait is interruptible by signals).
wait $WATCHDOG_PID 2>/dev/null || true
# If watchdog exits (max restarts), keep container alive for verifier
tail -f /dev/null &
TAIL_PID=$!
wait $TAIL_PID
