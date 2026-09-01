#!/usr/bin/env python3
"""Launcher: team-size sweep (n=1/3/6) x {smith,magic,crafting}-team at 30m, k=1.

Models are taken from argv (default: glm52 gemini35flash).

Each run-script invocation is spawned in its own session (start_new_session)
so the harbor streamers survive the launching terminal. tasks/ must already be
regenerated (SKIP_REGEN=1 is set to avoid 9 concurrent regens racing).
"""
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
ACTIVITIES = ["smith", "magic", "crafting"]
SIZES = [1, 3, 6]
MODELS = sys.argv[1:] or ["glm52", "gemini35flash"]
STAGGER_SECS = 10

env_extra = {"SKIP_REGEN": "1"}

launched = []
for activity in ACTIVITIES:
    for size in SIZES:
        script = REPO / "scripts" / f"run-{activity}-team.sh"
        cmd = [str(script), "-k", "1", "-n", str(size)]
        for m in MODELS:
            cmd += ["-m", m]
        log = Path(f"/tmp/team-size-sweep-{activity}-n{size}.log")
        with open(log, "w") as fh:
            p = subprocess.Popen(
                cmd,
                cwd=str(REPO),
                stdout=fh,
                stderr=subprocess.STDOUT,
                start_new_session=True,
                env={**__import__("os").environ, **env_extra},
            )
        launched.append((activity, size, p.pid, str(log)))
        print(f"launched {activity}-team n={size} pid={p.pid} log={log}", flush=True)
        time.sleep(STAGGER_SECS)

print(f"\nAll {len(launched)} invocations launched ({len(launched) * len(MODELS)} harbor jobs).")
