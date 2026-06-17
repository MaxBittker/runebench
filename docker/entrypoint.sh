#!/bin/bash
set -e

# ── Xvfb virtual display ─────────────────────────────────────────
echo "[entrypoint] Starting Xvfb virtual display..."
Xvfb :99 -screen 0 800x600x24 -ac &
XVFB_PID=$!
export DISPLAY=:99
sleep 1

# ── PulseAudio (lets ffmpeg capture the game client's music/sfx) ─
# Explicit socket + PULSE_SERVER so chromium (started later, inherits
# this env) and ffmpeg talk to the same daemon regardless of XDG dirs.
echo "[entrypoint] Starting PulseAudio..."
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
    echo "[entrypoint] PulseAudio ready (null sink 'game')"
else
    echo "[entrypoint] WARNING: PulseAudio failed to start — recording will have no audio"
fi

# ── Helper: start engine and wait for readiness ──────────────────
start_engine() {
    cd /app/server/engine && bun run src/app.ts &
    ENGINE_PID=$!
    echo "[entrypoint] Engine starting (pid=$ENGINE_PID)..."
    for i in $(seq 1 120); do
        if curl -sf http://localhost:8888 > /dev/null 2>&1; then
            echo "[entrypoint] Engine ready on port 8888"
            return 0
        fi
        if ! kill -0 $ENGINE_PID 2>/dev/null; then
            echo "[entrypoint] Engine process died during startup"
            return 1
        fi
        sleep 1
    done
    echo "[entrypoint] ERROR: Engine failed to start within 120s"
    return 1
}

# ── Helper: start gateway and wait for readiness ─────────────────
start_gateway() {
    cd /app/server/gateway && bun run gateway.ts &
    GATEWAY_PID=$!
    echo "[entrypoint] Gateway starting (pid=$GATEWAY_PID)..."
    for i in $(seq 1 30); do
        if curl -sf http://localhost:7780 > /dev/null 2>&1; then
            echo "[entrypoint] Gateway ready on port 7780"
            return 0
        fi
        sleep 1
    done
    echo "[entrypoint] Gateway ready (assumed after 30s)"
    return 0
}

# ── Helper: start bot client ─────────────────────────────────────
start_bot() {
    cd /app/server/gateway && bun run launch-bot.ts &
    BOT_PID=$!
    echo "[entrypoint] Bot client starting (pid=$BOT_PID)..."
    for i in $(seq 1 120); do
        if curl -sf "http://localhost:7780" > /dev/null 2>&1; then
            break
        fi
        sleep 1
    done
    # Give extra time for tutorial skip
    sleep 20
    echo "[entrypoint] Bot should be ready"
}

# ── Initial startup ──────────────────────────────────────────────

echo "[entrypoint] Starting game engine..."
if ! start_engine; then
    echo "[entrypoint] FATAL: Engine failed to start on initial boot"
    exit 1
fi

echo "[entrypoint] Starting gateway..."
start_gateway

echo "[entrypoint] Launching bot client (non-headless on Xvfb)..."
start_bot

# ── Skill tracker (runs for full container lifetime) ─────────
echo "[entrypoint] Starting skill tracker..."
mkdir -p /logs/tracking
cd /app && TRACKING_FILE=/logs/tracking/skill_tracking.json \
  nohup bun run benchmark/shared/skill_tracker.ts > /logs/tracking/skill_tracker.log 2>&1 &
TRACKER_PID=$!
echo "[entrypoint] Skill tracker started (pid=$TRACKER_PID)"

# ── Screen recording ─────────────────────────────────────────────
RECORD_VIDEO="${RECORD_VIDEO:-1}"
FFMPEG_PID=""
mkdir -p /logs/verifier
if [ "$RECORD_VIDEO" = "1" ]; then
    # Capture game audio off the null sink's monitor when pulse is up;
    # fall back to video-only so a dead daemon never kills the recording.
    AUDIO_IN=()
    AUDIO_OUT=()
    if pactl info > /dev/null 2>&1; then
        AUDIO_IN=(-f pulse -thread_queue_size 1024 -i game.monitor)
        AUDIO_OUT=(-c:a aac -b:a 64k -ac 1)
        echo "[entrypoint] Starting screen recording (1 fps, 400x300, h264 + aac audio)..."
    else
        echo "[entrypoint] Starting screen recording (1 fps, 400x300, h264, no audio)..."
    fi
    ffmpeg -f x11grab -thread_queue_size 1024 -framerate 1 -video_size 800x600 -i :99 \
        "${AUDIO_IN[@]}" \
        -vf scale=400:300 \
        -c:v libx264 -preset ultrafast -crf 38 \
        -pix_fmt yuv420p \
        "${AUDIO_OUT[@]}" \
        -movflags +frag_keyframe+empty_moov \
        /logs/verifier/recording.mp4 \
        > /logs/verifier/ffmpeg.log 2>&1 &
    FFMPEG_PID=$!
    sleep 2
fi

echo "[entrypoint] All services running (engine=$ENGINE_PID, gateway=$GATEWAY_PID, bot=$BOT_PID)"

# ── Cleanup handler ──────────────────────────────────────────────
SHUTTING_DOWN=false
cleanup() {
    SHUTTING_DOWN=true
    echo "[entrypoint] Shutting down..."
    if [ -n "$FFMPEG_PID" ]; then
        echo "[entrypoint] Stopping recording..."
        kill -INT $FFMPEG_PID 2>/dev/null
        # Give ffmpeg time to finalize the mp4
        wait $FFMPEG_PID 2>/dev/null || true
        echo "[entrypoint] Recording saved to /logs/verifier/recording.mp4"
    fi
    if [ -n "$XVFB_PID" ]; then
        kill $XVFB_PID 2>/dev/null || true
    fi
}
trap cleanup SIGTERM SIGINT EXIT

# ── Watchdog: restart engine/gateway/bot if they die ─────────────
# Agents sometimes run "pkill bun" or "killall bun" which kills the
# game engine and gateway. This watchdog detects dead processes and
# restarts the full stack so the game recovers automatically.
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
    bot_alive=true

    if ! kill -0 $ENGINE_PID 2>/dev/null; then
        engine_alive=false
    fi
    if ! kill -0 $GATEWAY_PID 2>/dev/null; then
        gateway_alive=false
    fi
    if ! kill -0 $BOT_PID 2>/dev/null; then
        bot_alive=false
    fi

    # Check tracker — use lock file since agents may have killed and restarted it
    tracker_alive=true
    if [ -f /tmp/skill_tracker.lock ]; then
        lock_pid=$(cat /tmp/skill_tracker.lock 2>/dev/null)
        if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
            TRACKER_PID=$lock_pid  # adopt agent-started tracker
        else
            tracker_alive=false
        fi
    elif ! kill -0 $TRACKER_PID 2>/dev/null; then
        tracker_alive=false
    fi

    if $engine_alive && $gateway_alive && $bot_alive && $tracker_alive; then
        continue
    fi

    # Tracker-only death: just restart it without touching the game stack
    if $engine_alive && $gateway_alive && $bot_alive && ! $tracker_alive; then
        echo "[watchdog] Tracker died, restarting..."
        cd /app && TRACKING_FILE=/logs/tracking/skill_tracking.json \
          nohup bun run benchmark/shared/skill_tracker.ts >> /logs/tracking/skill_tracker.log 2>&1 &
        TRACKER_PID=$!
        echo "[watchdog] Tracker restarted (pid=$TRACKER_PID)"
        continue
    fi

    RESTART_COUNT=$((RESTART_COUNT + 1))
    if [ $RESTART_COUNT -gt $MAX_RESTARTS ]; then
        echo "[watchdog] Max restarts ($MAX_RESTARTS) reached, giving up"
        break
    fi

    echo "[watchdog] Dead process detected (engine=$engine_alive gateway=$gateway_alive bot=$bot_alive tracker=$tracker_alive) — restart #$RESTART_COUNT"

    # Kill any remaining pieces to do a clean restart
    kill $ENGINE_PID 2>/dev/null || true
    kill $GATEWAY_PID 2>/dev/null || true
    kill $BOT_PID 2>/dev/null || true
    kill $TRACKER_PID 2>/dev/null || true
    sleep 2

    # Restart engine
    if ! start_engine; then
        echo "[watchdog] Engine failed to restart, will retry next cycle"
        continue
    fi

    # Restart gateway
    start_gateway

    # Restart bot client
    start_bot

    # Restart tracker (game stack is fresh, tracker needs to reconnect)
    cd /app && TRACKING_FILE=/logs/tracking/skill_tracking.json \
      nohup bun run benchmark/shared/skill_tracker.ts >> /logs/tracking/skill_tracker.log 2>&1 &
    TRACKER_PID=$!

    echo "[watchdog] Services restored (engine=$ENGINE_PID, gateway=$GATEWAY_PID, bot=$BOT_PID, tracker=$TRACKER_PID)"
done &
WATCHDOG_PID=$!

# Keep container alive. Use `wait` so bash can process SIGTERM from
# docker stop (unlike sleep, wait is interruptible by signals).
wait $WATCHDOG_PID 2>/dev/null || true
# If watchdog exits (max restarts), keep container alive for verifier
tail -f /dev/null &
TAIL_PID=$!
wait $TAIL_PID
