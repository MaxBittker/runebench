#!/usr/bin/env python3
"""Launch the gemini37flash n=6 45m SOLO-controller comparison trials, detached.

Same three team tasks as launch-team-n6-gemini37flash.py, but --solo: ONE
OpenCode session controls all six bots (no chat), isolating the cost/benefit
of multi-agent coordination. start_new_session=True so the harbor streamers
survive the parent session; SKIP_REGEN=1 (tasks/ already generated).
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
    log = Path(f"/tmp/launch-{activity}-n6-solo-{MODEL}.log")
    cmd = [
        str(REPO / "scripts" / f"run-{activity}-team.sh"),
        "-m", MODEL, "-n", "6", "-H", "45m", "-k", "1", "--solo",
    ]
    fh = open(log, "wb")
    p = subprocess.Popen(
        cmd, cwd=str(REPO), stdout=fh, stderr=subprocess.STDOUT,
        env={**os.environ, "SKIP_REGEN": "1"},
        start_new_session=True,
    )
    procs.append((activity, p.pid, str(log)))
    print(f"launched {activity} (solo) pid={p.pid} -> {log}", flush=True)
    time.sleep(20)

print("\nAll launched:")
for a, pid, log in procs:
    print(f"  {a:9s} pid={pid}  {log}")
