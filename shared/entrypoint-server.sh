#!/bin/bash
# Server entrypoint for SPLIT multi-bot tasks (1 box per agent + 1 server box):
# runs ONLY the game server stack — engine + gateway + task watcher. No Xvfb,
# no chromium bot clients, no ffmpeg: those live on the per-agent sandboxes
# spawned by agents/opencode_split_adapter.py, which connect back here through
# Modal encrypted tunnels (launch with --ek tunnel_ports=8888,7780).
#
# Copied into the task image as /entrypoint-server.sh by the task's
# environment/Dockerfile (overriding /entrypoint.sh). Same env contract as
# entrypoint-team.sh minus the client-side pieces:
#   BOT_NAMES         space-separated bot usernames (default: agenta agentb agentc)
#   WATCHER_SCRIPT    watcher path relative to /app (default: benchmark/shared/smith_team_watcher.ts)
#   WATCHER_LOCK      watcher lock file (default: /tmp/smith_team_watcher.lock)
#   TRACKING_FILE     watcher output (default: /logs/tracking/smith_team_tracking.json)
set -e

BOT_NAMES="${BOT_NAMES:-agenta agentb agentc}"
WATCHER_SCRIPT="${WATCHER_SCRIPT:-benchmark/shared/smith_team_watcher.ts}"
WATCHER_LOCK="${WATCHER_LOCK:-/tmp/smith_team_watcher.lock}"
TRACKING_FILE="${TRACKING_FILE:-/logs/tracking/smith_team_tracking.json}"
DASHBOARD_PORT="${DASHBOARD_PORT:-8790}"

# ── Helper: pre-provision SDK workspaces for every team bot ──────
# The watcher (and any server-side tooling) resolves bots through
# /app/bots/<name>/bot.env; keep the same provisioning as the single-box
# entrypoints so nothing falls through to the remote demo-server default.
provision_workspaces() {
    for name in $BOT_NAMES; do
        mkdir -p "/app/bots/$name"
        if [ ! -f "/app/bots/$name/bot.env" ]; then
            printf 'BOT_USERNAME=%s\nPASSWORD=test\nSERVER=localhost\nSHOW_CHAT=true\n' \
                "$name" > "/app/bots/$name/bot.env"
        fi
    done
    if [ -f /app/bots/_template/bot.env ]; then
        sed -i 's/^SERVER=.*/SERVER=localhost/' /app/bots/_template/bot.env 2>/dev/null || true
        grep -q '^SERVER=' /app/bots/_template/bot.env || echo 'SERVER=localhost' >> /app/bots/_template/bot.env
        sed -i 's/^SHOW_CHAT=.*/SHOW_CHAT=true/' /app/bots/_template/bot.env 2>/dev/null || true
        grep -q '^SHOW_CHAT=' /app/bots/_template/bot.env || echo 'SHOW_CHAT=true' >> /app/bots/_template/bot.env
    fi
    echo "[entrypoint-server] Provisioned /app/bots/{$(echo $BOT_NAMES | tr ' ' ',')}"
}

# ── Helper: start engine and wait for readiness ──────────────────
start_engine() {
    cd /app/server/engine && bun-svc run src/app.ts &
    ENGINE_PID=$!
    echo "[entrypoint-server] Engine starting (pid=$ENGINE_PID)..."
    for i in $(seq 1 120); do
        if curl -sf http://localhost:8888 > /dev/null 2>&1; then
            echo "[entrypoint-server] Engine ready on port 8888"
            return 0
        fi
        if ! kill -0 $ENGINE_PID 2>/dev/null; then
            echo "[entrypoint-server] Engine process died during startup"
            return 1
        fi
        sleep 1
    done
    echo "[entrypoint-server] ERROR: Engine failed to start within 120s"
    return 1
}

# ── Helper: start gateway and wait for readiness ─────────────────
start_gateway() {
    cd /app/server/gateway && bun-svc run gateway.ts &
    GATEWAY_PID=$!
    echo "[entrypoint-server] Gateway starting (pid=$GATEWAY_PID)..."
    for i in $(seq 1 30); do
        if curl -sf http://localhost:7780 > /dev/null 2>&1; then
            echo "[entrypoint-server] Gateway ready on port 7780"
            return 0
        fi
        sleep 1
    done
    echo "[entrypoint-server] Gateway ready (assumed after 30s)"
    return 0
}

# ── Helper: start the task watcher ───────────────────────────────
start_watcher() {
    mkdir -p /logs/tracking
    cd /app && BOT_NAMES="$BOT_NAMES" TRACKING_FILE="$TRACKING_FILE" \
      nohup bun-svc run "$WATCHER_SCRIPT" >> /logs/tracking/watcher.log 2>&1 &
    WATCHER_PID=$!
    echo "[entrypoint-server] Watcher started (pid=$WATCHER_PID, script=$WATCHER_SCRIPT)"
}

# ── Helper: start the live observation dashboard ─────────────────
# Read-only web view of the run (chat, inventories, banks, gold timeline);
# reaches observers through its own tunnel port (--ek tunnel_ports=…,8790).
# Supervised by a simple restart loop rather than the main watchdog: losing
# it must never touch the game stack, and it holds no run state.
start_dashboard() {
    if [ ! -f /app/benchmark/shared/dashboard.ts ]; then
        echo "[entrypoint-server] No dashboard.ts in image — dashboard disabled"
        return 0
    fi
    mkdir -p /logs/tracking
    (
        while true; do
            cd /app && BOT_NAMES="$BOT_NAMES" TRACKING_FILE="$TRACKING_FILE" \
              DASHBOARD_PORT="$DASHBOARD_PORT" \
              bun-svc run benchmark/shared/dashboard.ts >> /logs/tracking/dashboard.log 2>&1
            sleep 3
        done
    ) &
    DASHBOARD_SUPERVISOR_PID=$!
    echo "[entrypoint-server] Dashboard supervisor started (pid=$DASHBOARD_SUPERVISOR_PID, port=$DASHBOARD_PORT)"
}

# ── Initial startup ──────────────────────────────────────────────

echo "[entrypoint-server] Provisioning bot workspaces..."
provision_workspaces

echo "[entrypoint-server] Starting game engine..."
if ! start_engine; then
    echo "[entrypoint-server] FATAL: Engine failed to start on initial boot"
    exit 1
fi

echo "[entrypoint-server] Starting gateway..."
start_gateway

echo "[entrypoint-server] Starting watcher..."
start_watcher

echo "[entrypoint-server] Starting dashboard..."
start_dashboard

echo "[entrypoint-server] Server stack running (engine=$ENGINE_PID, gateway=$GATEWAY_PID, watcher=$WATCHER_PID)"

# ── Cleanup handler ──────────────────────────────────────────────
SHUTTING_DOWN=false
cleanup() {
    SHUTTING_DOWN=true
    echo "[entrypoint-server] Shutting down..."
}
trap cleanup SIGTERM SIGINT EXIT

# ── Watchdog: restart engine/gateway/watcher if they die ─────────
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
    watcher_alive=true

    if ! kill -0 $ENGINE_PID 2>/dev/null; then
        engine_alive=false
    fi
    if ! kill -0 $GATEWAY_PID 2>/dev/null; then
        gateway_alive=false
    fi

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

    if $engine_alive && $gateway_alive && $watcher_alive; then
        continue
    fi

    # Watcher-only death: restart it without touching the game stack
    if $engine_alive && $gateway_alive && ! $watcher_alive; then
        echo "[watchdog] Watcher died, restarting..."
        start_watcher
        continue
    fi

    RESTART_COUNT=$((RESTART_COUNT + 1))
    if [ $RESTART_COUNT -gt $MAX_RESTARTS ]; then
        echo "[watchdog] Max restarts ($MAX_RESTARTS) reached, giving up"
        break
    fi

    echo "[watchdog] Dead process detected (engine=$engine_alive gateway=$gateway_alive watcher=$watcher_alive) — restart #$RESTART_COUNT"

    kill $ENGINE_PID 2>/dev/null || true
    kill $GATEWAY_PID 2>/dev/null || true
    kill $WATCHER_PID 2>/dev/null || true
    sleep 2

    if ! start_engine; then
        echo "[watchdog] Engine failed to restart, will retry next cycle"
        continue
    fi
    start_gateway
    start_watcher

    echo "[watchdog] Services restored (engine=$ENGINE_PID, gateway=$GATEWAY_PID, watcher=$WATCHER_PID)"
done &
WATCHDOG_PID=$!

# Keep container alive. Use `wait` so bash can process SIGTERM from
# docker stop (unlike sleep, wait is interruptible by signals).
wait $WATCHDOG_PID 2>/dev/null || true
# If watchdog exits (max restarts), keep container alive for verifier
tail -f /dev/null &
TAIL_PID=$!
wait $TAIL_PID
