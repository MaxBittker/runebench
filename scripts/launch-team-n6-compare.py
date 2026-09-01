#!/usr/bin/env python3
"""Launch the n=6 45m team-vs-solo comparison suite for one or more models,
detached: {smith,magic,crafting} × {team, solo} per model.

Usage: launch-team-n6-compare.py <model-label> [<model-label> ...]

Harbor streamers die with the parent shell/session under plain nohup+disown,
which orphans the Modal trial — each launcher gets its own session via
start_new_session=True. SKIP_REGEN=1: regenerate tasks/ once up front if the
generator changed (parallel regens race on tasks/).
"""
import os
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
ACTIVITIES = ["smith", "magic", "crafting"]
CONDITIONS = [("team", []), ("solo", ["--solo"])]

models = sys.argv[1:]
if not models:
    sys.exit("usage: launch-team-n6-compare.py <model-label> [...]")

procs = []
for model in models:
    for activity in ACTIVITIES:
        for cond, extra in CONDITIONS:
            log = Path(f"/tmp/launch-{activity}-n6-{cond}-{model}.log")
            cmd = [
                str(REPO / "scripts" / f"run-{activity}-team.sh"),
                "-m", model, "-n", "6", "-H", "45m", "-k", "1", *extra,
            ]
            fh = open(log, "wb")
            p = subprocess.Popen(
                cmd, cwd=str(REPO), stdout=fh, stderr=subprocess.STDOUT,
                env={**os.environ, "SKIP_REGEN": "1"},
                start_new_session=True,
            )
            procs.append((model, activity, cond, p.pid, str(log)))
            print(f"launched {model}/{activity}/{cond} pid={p.pid} -> {log}", flush=True)
            time.sleep(15)

print("\nAll launched:")
for m, a, c, pid, log in procs:
    print(f"  {m:16s} {a:9s} {c:5s} pid={pid}  {log}")
