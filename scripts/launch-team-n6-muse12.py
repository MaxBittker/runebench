#!/usr/bin/env python3
"""Launch the muse12 (Meta Muse Spark 1.2 contributor) n=6 45m team trials,
SEQUENTIALLY, detached.

Sequential because the contributor tier is capped at 100 RPM *per team*: six
concurrent OpenCode sessions peak at ~70 RPM, so running all three activities
at once (18 sessions) would throttle the runs and skew the benchmark.

Harbor streamers die with the parent shell/session under plain nohup+disown,
which orphans the Modal trial — each launcher gets its own session via
start_new_session=True. Tasks are regenerated once up front (SKIP_REGEN=1 on
each run script so parallel regens can't race on tasks/).
"""
import os
import subprocess
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
ACTIVITIES = ["smith", "magic", "crafting"]
HORIZON = "45m"
# 45m horizon + sandbox boot/verify overhead; gap between sequential launches
# so two activities' sessions never overlap on the shared RPM quota.
GAP_SECONDS = 65 * 60

subprocess.run(["bun", "generate-tasks.ts"], cwd=str(REPO), check=True)

for i, activity in enumerate(ACTIVITIES):
    log = Path(f"/tmp/launch-{activity}-n6-muse12.log")
    cmd = [
        str(REPO / "scripts" / f"run-{activity}-team.sh"),
        "-m", "muse12", "-n", "6", "-H", HORIZON, "-k", "1",
    ]
    fh = open(log, "wb")
    p = subprocess.Popen(
        cmd, cwd=str(REPO), stdout=fh, stderr=subprocess.STDOUT,
        env={**os.environ, "SKIP_REGEN": "1"},
        start_new_session=True,
    )
    print(f"launched {activity} pid={p.pid} -> {log}", flush=True)
    if i < len(ACTIVITIES) - 1:
        print(f"sleeping {GAP_SECONDS}s before the next activity "
              f"(contributor-tier RPM quota is shared)", flush=True)
        time.sleep(GAP_SECONDS)

print("all activities launched")
