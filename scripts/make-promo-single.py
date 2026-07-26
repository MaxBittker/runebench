#!/usr/bin/env python3
"""Single-tile (1x1) promo video of one 30m skill run, cropped to the game
viewport, sped up 10x, with the results-site promo overlay: bottom gradient,
time-synced agent narration, and a "<Model> · <Skill>" meta line with the
skill icon. Same styling as make-fable-promo-grid.py.

Usage: make-promo-single.py [model-key] [skill]   (default: fable-5 cooking)

If the recording has audio (image v41+), it is sped up 10x too.

Sync math mirrors app/components/PromoPlayer.js:
  videoStartWallclock = containerFinishedAt - videoDuration
  offset = max(0, firstStepAt - videoStartWallclock)
  text appears at videoTime = offset + step.ts   (then /10 for speedup)
"""
import json
import os
import re
import subprocess
import sys
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL = sys.argv[1] if len(sys.argv) > 1 else "fable-5"
SKILL = sys.argv[2] if len(sys.argv) > 2 else "cooking"
SPEED = 10
TILE_W, TILE_H = 734, 480  # 367x240 viewport crop scaled 2x
GRAD_H = 185
WORK = f"/tmp/promo_single_{MODEL}_{SKILL}"
OUT = os.path.join(ROOT, "results", f"{MODEL}-{SKILL}-30m-promo.mp4")

os.makedirs(WORK, exist_ok=True)

with open(os.path.join(ROOT, "results/skills-30m", f"{MODEL}.json")) as f:
    entry = json.load(f)["skills"][SKILL]

constants = open(os.path.join(ROOT, "views/shared-constants.js")).read()
m = re.search(rf"'{re.escape(MODEL)}':\s*{{[^}}]*shortName:\s*'([^']+)'", constants)
MODEL_NAME = m.group(1) if m else MODEL


def parse_ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def ass_time(t):
    t = max(0, t)
    h, rem = divmod(t, 3600)
    m, s = divmod(rem, 60)
    return f"{int(h)}:{int(m):02d}:{s:05.2f}"


def ass_escape(text):
    return text.replace("\\", "\\\\").replace("{", "(").replace("}", ")").replace("\n", "\\N")


def has_audio(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries",
         "stream=codec_type", "-of", "csv=p=0", path],
        capture_output=True, text=True,
    ).stdout
    return "audio" in out


def make_ass(skill, entry):
    offset = 0.0
    if entry.get("containerFinishedAt"):
        video_start = parse_ts(entry["containerFinishedAt"]) - entry["videoDuration"]
        sync = entry.get("firstStepAt") or entry.get("agentStartedAt")
        if sync:
            offset = max(0.0, parse_ts(sync) - video_start)

    steps = [s for s in entry.get("trajectory", []) if s.get("source") != "tool" and s.get("text")]
    end_of_video = entry["videoDuration"] / SPEED + 1

    lines = [
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {TILE_W}",
        f"PlayResY: {TILE_H}",
        "WrapStyle: 0",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
        "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, "
        "Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        "Style: Transcript,Helvetica,38,&H0DFFFFFF,&H0DFFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,2,1,18,18,52,1",
        "Style: Meta,Helvetica,19,&H00FFFFFF,&H00FFFFFF,&H4D000000,&H4D000000,1,0,0,0,100,100,0,0,1,0,1,1,52,18,14,1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]

    skill_name = skill.capitalize()
    lines.append(
        f"Dialogue: 0,{ass_time(0)},{ass_time(end_of_video)},Meta,,0,0,0,,{MODEL_NAME}  ·  {skill_name}"
    )

    for i, step in enumerate(steps):
        if step.get("ts") is None:
            continue
        start = (offset + step["ts"]) / SPEED
        if i + 1 < len(steps) and steps[i + 1].get("ts") is not None:
            end = (offset + steps[i + 1]["ts"]) / SPEED
        else:
            end = end_of_video
        if end <= start:
            continue
        text = step["text"].strip()
        if len(text) > 200:
            text = text[:200] + "…"
        lines.append(
            f"Dialogue: 1,{ass_time(start)},{ass_time(end)},Transcript,,0,0,0,,{ass_escape(text)}"
        )

    path = os.path.join(WORK, f"{skill}.ass")
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")
    return path


# bottom gradient: transparent -> 75% black, like the promo-overlay CSS
grad_png = os.path.join(WORK, "gradient.png")
subprocess.run(
    ["ffmpeg", "-y", "-v", "error",
     "-f", "lavfi", "-i", f"color=black:s={TILE_W}x{GRAD_H},format=rgba",
     "-vf", "geq=r=0:g=0:b=0:a='0.75*255*(Y/H)'", "-frames:v", "1", grad_png],
    check=True,
)

video = os.path.join(ROOT, entry["trialDir"], "verifier", "recording.mp4")
if not os.path.exists(video):
    sys.exit(f"missing video: {video}")
ass_path = make_ass(SKILL, entry)

inputs = ["-i", video, "-i", grad_png,
          "-i", os.path.join(ROOT, "views", "skill-icons", f"{SKILL}.png")]

fc = (
    f"[2:v]scale=26:26[icon];"
    f"[0:v]crop=367:240:17:32,scale={TILE_W}:{TILE_H},setsar=1,"
    f"setpts=PTS/{SPEED},fps=10[c];"
    f"[c][1:v]overlay=0:main_h-overlay_h[g];"
    f"[g]ass={ass_path}[s];"
    f"[s][icon]overlay=18:main_h-40[v]"
)

maps = ["-map", "[v]"]
audio_args = ["-an"]
if has_audio(video):
    fc += f";[0:a]atempo={SPEED},volume=2[a]"
    maps += ["-map", "[a]"]
    audio_args = ["-c:a", "aac", "-b:a", "128k"]

cmd = ["ffmpeg", "-y", *inputs,
       "-filter_complex", fc,
       *maps, "-c:v", "libx264", "-preset", "medium", "-crf", "21",
       "-pix_fmt", "yuv420p", *audio_args, OUT]
print(" ".join(cmd))
subprocess.run(cmd, check=True)
print(f"wrote {OUT}")
