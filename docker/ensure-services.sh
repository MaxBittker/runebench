#!/bin/bash
# Ensure game services and skill tracker are alive (idempotent).
# Called by the verifier before checking results.

# Prevent agents from using generateSave to pre-level characters (cheating)
rm -f /app/sdk/test/utils/save-generator.ts /app/sdk/test/utils/save-generator.js 2>/dev/null || true

# Wait up to 30s for gateway — watchdog may be restarting services
for i in $(seq 1 30); do
    if curl -sf http://localhost:7780 > /dev/null 2>&1; then
        break
    fi
    if [ $i -eq 30 ]; then
        echo "[ensure-services] ERROR: gateway not running after 30s (services should be started by entrypoint.sh)"
        exit 1
    fi
    echo "[ensure-services] Waiting for gateway... ($i/30)"
    sleep 1
done

# Ensure skill tracker is running
if ! pgrep -f skill_tracker > /dev/null 2>&1; then
    echo "[ensure-services] Starting skill tracker..."
    mkdir -p /logs/tracking
    cd /app && TRACKING_FILE=/logs/tracking/skill_tracking.json nohup bun-svc run benchmark/shared/skill_tracker.ts > /logs/tracking/skill_tracker.log 2>&1 &
fi
