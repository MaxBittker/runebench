#!/usr/bin/env python3
"""Launch the n=6 team trials for grok45 + gpt56luna-xhigh, detached.

Harbor streamers die with the parent shell/session under plain nohup+disown,
which orphans the Modal trial (no result.json ever lands) — so each launcher
gets its own session via start_new_session=True.
"""
import subprocess
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
MODELS = ["grok45", "gpt56luna-xhigh"]
ACTIVITIES = ["smith", "magic", "crafting"]

procs = []
for activity in ACTIVITIES:
    for model in MODELS:
        log = Path(f"/tmp/launch-{activity}-n6-{model}.log")
        cmd = [
            str(REPO / "scripts" / f"run-{activity}-team.sh"),
            "-m", model, "-n", "6", "-k", "1",
        ]
        fh = open(log, "wb")
        p = subprocess.Popen(
            cmd, cwd=str(REPO), stdout=fh, stderr=subprocess.STDOUT,
            env={**__import__("os").environ, "SKIP_REGEN": "1"},
            start_new_session=True,
        )
        procs.append((activity, model, p.pid, str(log)))
        print(f"launched {activity}/{model} pid={p.pid} -> {log}", flush=True)
        time.sleep(20)

print("\nAll launched:")
for a, m, pid, log in procs:
    print(f"  {a:9s} {m:16s} pid={pid}  {log}")
