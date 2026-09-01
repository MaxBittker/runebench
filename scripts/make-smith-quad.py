#!/usr/bin/env python3
"""
Build a 2x2 quadrant highlight video for a smith-team run:

  ┌────────────────────┬────────────────────┐
  │ agenta (game feed) │ agentb (game feed) │
  ├────────────────────┼────────────────────┤
  │ PROGRESS CHART     │ agentc (game feed) │   ← 3rd quadrant = animated viz
  └────────────────────┴────────────────────┘

The progress chart animates over the run: each bot's Smithing level (solid) and
Mining level (dashed), plus a gold step line for the team's best valid item
value (the score), with a sweeping playhead.

Usage: python3 scripts/make-smith-quad.py <trial-dir> [out.mp4]
Requires: matplotlib, ffmpeg.
"""
import json, os, sys, shutil, subprocess
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.ticker import MaxNLocator

trial = Path(sys.argv[1])
vdir = trial / "verifier"
reward = json.load(open(vdir / "reward.json"))
tr = reward["tracking"]
bots = tr["botNames"]
samples = tr["samples"]
events = [e for e in reward.get("events", []) if e.get("event") == "gained" and e.get("valid")]
best_item = reward.get("bestItem") or {}
job = trial.parent.name

OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("results/arrav") / f"{job}-quad.mp4"
OUT.parent.mkdir(parents=True, exist_ok=True)

OUTPUT_DUR = 54.0     # seconds of final video
FPS = 24              # final fps
VIZ_FPS = 8           # native chart fps (upsampled by ffmpeg)
PANE_W, PANE_H = 600, 450

# Source feeds all share one duration
src = str(vdir / "recording-agenta.mp4")
VIDEO_DUR = float(subprocess.check_output(
    ["ffprobe", "-v", "error", "-show_entries", "format=duration",
     "-of", "csv=p=0", src]).strip())
SPEED = VIDEO_DUR / OUTPUT_DUR

TMP = Path("/tmp/smith_quad")
if TMP.exists():
    shutil.rmtree(TMP)
TMP.mkdir(parents=True)
fdir = TMP / "frames"; fdir.mkdir()

# Fonts without spaces (ffmpeg filtergraph chokes on spaces)
REG = TMP / "reg.ttf"; BOLD = TMP / "bold.ttf"
shutil.copy("/System/Library/Fonts/Supplemental/Arial.ttf", REG)
shutil.copy("/System/Library/Fonts/Supplemental/Arial Bold.ttf", BOLD)

# ── Build per-bot time series ─────────────────────────────────────
ts = [s["elapsedMs"] / 1000.0 for s in samples]            # seconds
COLORS = {bots[0]: "#e8b73a", bots[1]: "#3ad0e8", bots[2]: "#e8743a"}
smith = {b: [s["bots"][b]["smithing"]["level"] for s in samples] for b in bots}
mine = {b: [s["bots"][b]["mining"]["level"] for s in samples] for b in bots}

# Running best valid item value at each sample time
def best_at(t):
    vals = [e["cost"] for e in events if e["elapsedMs"] / 1000.0 <= t]
    return max(vals) if vals else 0
best_series = [best_at(t) for t in ts]
max_level = max(max(max(smith[b]) for b in bots), max(max(mine[b]) for b in bots), 5)
max_gp = max(max(best_series), (best_item.get("cost") or 0), 10)
T_MAX = max(ts[-1], 1)

# Role label from final levels
def role(b):
    fs = smith[b][-1]; fm = mine[b][-1]
    return "miner" if fm > fs + 5 else "smith"
ROLE = {b: role(b) for b in bots}

# ── Render chart frames ───────────────────────────────────────────
N = int(OUTPUT_DUR * VIZ_FPS)
plt.rcParams.update({"font.family": "DejaVu Sans", "text.color": "#e8e8e8",
                     "axes.edgecolor": "#555", "xtick.color": "#aaa", "ytick.color": "#aaa"})
fig, ax = plt.subplots(figsize=(PANE_W / 100, PANE_H / 100), dpi=100)
fig.patch.set_facecolor("#141414"); ax.set_facecolor("#141414")
ax2 = ax.twinx(); ax2.set_facecolor("none")

print(f"Rendering {N} chart frames (speed {SPEED:.1f}x)...")
for i in range(N):
    t = (i / max(N - 1, 1)) * VIDEO_DUR
    k = sum(1 for x in ts if x <= t) or 1   # samples revealed so far
    ax.clear(); ax2.clear()
    ax.set_facecolor("#141414")
    tm = [x / 60 for x in ts[:k]]
    for b in bots:
        ax.plot(tm, smith[b][:k], color=COLORS[b], lw=2.2, solid_capstyle="round")
        ax.plot(tm, mine[b][:k], color=COLORS[b], lw=1.3, ls=(0, (3, 2)), alpha=0.55)
    # best-value step (right axis)
    ax2.step(tm, best_series[:k], where="post", color="#f5c542", lw=3.0, alpha=0.95)
    # event dots for valid smiths revealed so far
    for e in events:
        et = e["elapsedMs"] / 1000.0
        if et <= t:
            ax2.plot(et / 60, e["cost"], "o", ms=5, color="#f5c542")
    # annotate the best item once reached
    bi_t = (best_item.get("elapsedMs") or 0) / 1000.0
    if best_item and bi_t <= t:
        ax2.annotate(f"{best_item['name'].replace('_',' ')}\n{best_item['cost']} gp",
                     (bi_t / 60, best_item["cost"]), color="#f5c542", fontsize=8,
                     ha="center", va="bottom", xytext=(0, 6), textcoords="offset points")
    # playhead
    ax.axvline(t / 60, color="#ffffff", lw=1.0, alpha=0.5)

    ax.set_xlim(0, T_MAX / 60); ax.set_ylim(0, max_level * 1.1)
    ax2.set_ylim(0, max_gp * 1.25)
    ax.set_xlabel("minutes", fontsize=9)
    ax.set_ylabel("Skill level", fontsize=9, color="#bbb")
    ax2.set_ylabel("Best item value (gp)", fontsize=9, color="#f5c542")
    ax.yaxis.set_major_locator(MaxNLocator(5))
    ax.set_title("Team Smithing Progress", fontsize=12, color="#fff", fontweight="bold", pad=8)
    cur_best = best_at(t)
    ax.text(0.02, 0.96, f"Best: {cur_best} gp", transform=ax.transAxes, fontsize=11,
            color="#f5c542", fontweight="bold", va="top")
    # legend (bot colors + line-style key), drawn once-ish
    handles = [plt.Line2D([], [], color=COLORS[b], lw=2.4,
               label=f"{b} · {ROLE[b]}") for b in bots]
    handles += [plt.Line2D([], [], color="#999", lw=2, label="Smithing (solid)"),
                plt.Line2D([], [], color="#999", lw=1.3, ls=(0, (3, 2)), label="Mining (dashed)")]
    ax.legend(handles=handles, loc="lower right", fontsize=7, framealpha=0.25,
              facecolor="#222", edgecolor="#444", labelcolor="#ddd")
    for sp in ax.spines.values(): sp.set_color("#444")
    fig.tight_layout()
    fig.savefig(fdir / f"f{i:05d}.png", facecolor="#141414")
    if i % 50 == 0:
        print(f"  frame {i}/{N}")
plt.close(fig)

# viz video from frames
viz = TMP / "viz.mp4"
subprocess.run(["ffmpeg", "-v", "error", "-y", "-framerate", str(VIZ_FPS),
                "-i", str(fdir / "f%05d.png"), "-vf", f"fps={FPS},format=yuv420p",
                "-c:v", "libx264", str(viz)], check=True)

# ── Normalize each bot feed: scale, speed to OUTPUT_DUR, label ─────
def pane(bot, idx):
    out = TMP / f"pane_{bot}.mp4"
    label = TMP / f"lbl_{bot}.txt"; label.write_text(f"{bot} · {ROLE[bot]}")
    col = {"smith": "0x6a3a1a", "miner": "0x1a4a6a"}[ROLE[bot]]
    vf = (f"scale={PANE_W}:{PANE_H}:flags=lanczos,setpts=PTS/{SPEED},fps={FPS},"
          f"drawtext=fontfile={BOLD}:textfile={label}:fontsize=18:fontcolor=white:"
          f"box=1:boxcolor={col}@0.85:boxborderw=7:x=10:y=10")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(vdir / f"recording-{bot}.mp4"),
                    "-t", str(OUTPUT_DUR), "-vf", vf, "-an",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", str(out)], check=True)
    return out

pa, pb, pc = pane(bots[0], 0), pane(bots[1], 1), pane(bots[2], 2)

# ── 2x2 xstack: TL=agenta TR=agentb BL=viz BR=agentc ──────────────
subprocess.run([
    "ffmpeg", "-v", "error", "-y",
    "-i", str(pa), "-i", str(pb), "-i", str(viz), "-i", str(pc),
    "-filter_complex",
    f"[0:v][1:v][2:v][3:v]xstack=inputs=4:layout=0_0|{PANE_W}_0|0_{PANE_H}|{PANE_W}_{PANE_H}[v]",
    "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart", str(OUT)], check=True)

shutil.rmtree(TMP)
print(f"\nWrote {OUT}")
