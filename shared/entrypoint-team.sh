#!/bin/bash
# Team entrypoint for multi-bot cooperative tasks: launches N bot clients
# (from BOT_NAMES) plus a task-specific watcher instead of the single-bot
# skill tracker. Copied into the task image as /entrypoint-team.sh by the
# task's environment/Dockerfile (overriding /entrypoint.sh).
#
# Generalizes entrypoint-duo.sh — configure via env:
#   BOT_NAMES         space-separated bot usernames (default: agenta agentb agentc)
#   WATCHER_SCRIPT    watcher path relative to /app (default: benchmark/shared/smith_team_watcher.ts)
#   WATCHER_LOCK      watcher lock file (default: /tmp/smith_team_watcher.lock)
#   TRACKING_FILE     watcher output (default: /logs/tracking/smith_team_tracking.json)
set -e

BOT_NAMES="${BOT_NAMES:-agenta agentb agentc}"
WATCHER_SCRIPT="${WATCHER_SCRIPT:-benchmark/shared/smith_team_watcher.ts}"
WATCHER_LOCK="${WATCHER_LOCK:-/tmp/smith_team_watcher.lock}"
TRACKING_FILE="${TRACKING_FILE:-/logs/tracking/smith_team_tracking.json}"
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
        echo "[entrypoint-team] Starting Xvfb on $disp for \"$name\"..."
        Xvfb "$disp" -screen 0 800x600x24 -ac > /dev/null 2>&1 &
        XVFB_PIDS="$XVFB_PIDS $!"
        i=$((i + 1))
    done
    sleep 1
}

# ── Helper: pre-provision SDK workspaces for every team bot ──────
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
    echo "[entrypoint-team] Provisioned /app/bots/{$(echo $BOT_NAMES | tr ' ' ',')}"
}

# ── Helper: start engine and wait for readiness ──────────────────
start_engine() {
    cd /app/server/engine && bun run src/app.ts &
    ENGINE_PID=$!
    echo "[entrypoint-team] Engine starting (pid=$ENGINE_PID)..."
    for i in $(seq 1 120); do
        if curl -sf http://localhost:8888 > /dev/null 2>&1; then
            echo "[entrypoint-team] Engine ready on port 8888"
            return 0
        fi
        if ! kill -0 $ENGINE_PID 2>/dev/null; then
            echo "[entrypoint-team] Engine process died during startup"
            return 1
        fi
        sleep 1
    done
    echo "[entrypoint-team] ERROR: Engine failed to start within 120s"
    return 1
}

# ── Helper: start gateway and wait for readiness ─────────────────
start_gateway() {
    cd /app/server/gateway && bun run gateway.ts &
    GATEWAY_PID=$!
    echo "[entrypoint-team] Gateway starting (pid=$GATEWAY_PID)..."
    for i in $(seq 1 30); do
        if curl -sf http://localhost:7780 > /dev/null 2>&1; then
            echo "[entrypoint-team] Gateway ready on port 7780"
            return 0
        fi
        sleep 1
    done
    echo "[entrypoint-team] Gateway ready (assumed after 30s)"
    return 0
}

# ── Helper: start all bot clients ────────────────────────────────
# Sets BOT_PIDS (space-separated, same order as BOT_NAMES).
start_bots() {
    BOT_PIDS=""
    local i=0
    for name in $BOT_NAMES; do
        local disp; disp="$(disp_for $i)"
        cd /app/server/gateway && DISPLAY="$disp" BOT_NAME="$name" bun run launch-bot.ts &
        BOT_PIDS="$BOT_PIDS $!"
        echo "[entrypoint-team] Bot client \"$name\" starting on $disp (pid=$!)..."
        # Stagger logins so the engine handles one new session at a time
        sleep 5
        i=$((i + 1))
    done
    # Give extra time for all clients to settle in-game
    sleep 25
    echo "[entrypoint-team] Bots should be ready"
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
        echo "[entrypoint-team] Recording $disp → recording-$name.mp4 (5 fps, 800x600, crf23)..."
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

# ── Helper: start the task watcher ───────────────────────────────
start_watcher() {
    mkdir -p /logs/tracking
    cd /app && BOT_NAMES="$BOT_NAMES" TRACKING_FILE="$TRACKING_FILE" \
      nohup bun run "$WATCHER_SCRIPT" >> /logs/tracking/watcher.log 2>&1 &
    WATCHER_PID=$!
    echo "[entrypoint-team] Watcher started (pid=$WATCHER_PID, script=$WATCHER_SCRIPT)"
}

# ── Initial startup ──────────────────────────────────────────────

echo "[entrypoint-team] Provisioning bot workspaces..."
provision_workspaces

echo "[entrypoint-team] Starting virtual displays..."
start_displays

echo "[entrypoint-team] Starting game engine..."
if ! start_engine; then
    echo "[entrypoint-team] FATAL: Engine failed to start on initial boot"
    exit 1
fi

echo "[entrypoint-team] Starting gateway..."
start_gateway

echo "[entrypoint-team] Launching bot clients ($BOT_NAMES)..."
start_bots

echo "[entrypoint-team] Starting watcher..."
start_watcher

echo "[entrypoint-team] Starting screen recordings..."
start_recording

echo "[entrypoint-team] All services running (engine=$ENGINE_PID, gateway=$GATEWAY_PID, bots=$BOT_PIDS)"

# ── Cleanup handler ──────────────────────────────────────────────
SHUTTING_DOWN=false
cleanup() {
    SHUTTING_DOWN=true
    echo "[entrypoint-team] Shutting down..."
    if [ -n "$FFMPEG_PIDS" ]; then
        echo "[entrypoint-team] Stopping recordings..."
        for pid in $FFMPEG_PIDS; do kill -INT $pid 2>/dev/null; done
        for pid in $FFMPEG_PIDS; do wait $pid 2>/dev/null || true; done
        # Back-compat: single-video tooling expects recording.mp4
        cp "/logs/verifier/recording-$FIRST_BOT.mp4" /logs/verifier/recording.mp4 2>/dev/null || true
        echo "[entrypoint-team] Recordings saved (recording-<bot>.mp4 per bot)"
    fi
    for pid in $XVFB_PIDS; do kill $pid 2>/dev/null || true; done
}
trap cleanup SIGTERM SIGINT EXIT

# ── Watchdog: restart engine/gateway/bots/watcher if they die ────
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
    if [ -f "$WATCHER_LOCK" ]; then
        lock_pid=$(cat "$WATCHER_LOCK" 2>/dev/null)
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
