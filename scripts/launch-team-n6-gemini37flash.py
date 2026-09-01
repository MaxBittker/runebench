#!/usr/bin/env python3
"""Launch the gemini37flash n=6 45m team trials (smith/magic/crafting), detached.

Harbor streamers die with the parent shell/session under plain nohup+disown,
which orphans the Modal trial (no result.json ever lands) — so each launcher
gets its own session via start_new_session=True. SKIP_REGEN=1 because tasks/
was regenerated up front (parallel regens race on tasks/).
"""
import os
import subprocess
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
MODEL = "gemini37flash"
ACTIVITIES = ["smith", "magic", "crafting"]

procs = []
for activity in ACTIVITIES:
    log = Path(f"/tmp/launch-{activity}-n6-{MODEL}.log")
    cmd = [
        str(REPO / "scripts" / f"run-{activity}-team.sh"),
        "-m", MODEL, "-n", "6", "-H", "45m", "-k", "1",
    ]
    fh = open(log, "wb")
    p = subprocess.Popen(
        cmd, cwd=str(REPO), stdout=fh, stderr=subprocess.STDOUT,
        env={**os.environ, "SKIP_REGEN": "1"},
        start_new_session=True,
    )
    procs.append((activity, p.pid, str(log)))
    print(f"launched {activity} pid={p.pid} -> {log}", flush=True)
    time.sleep(20)

print("\nAll launched:")
for a, pid, log in procs:
    print(f"  {a:9s} pid={pid}  {log}")
