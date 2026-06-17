#!/bin/bash
# Composite 4x4 grid of the 16 fable-5 30m skill recordings, sped up 10x.
set -euo pipefail
cd "$(dirname "$0")/.."

JOB=jobs/skills-30m-fable-20260609-142747
OUT=results/fable-5-30m-grid.mp4
FONT=/System/Library/Fonts/Helvetica.ttc

SKILLS=(attack cooking crafting defence firemaking fishing fletching hitpoints
        magic mining prayer ranged smithing strength thieving woodcutting)

inputs=()
filters=""
for i in "${!SKILLS[@]}"; do
  s=${SKILLS[$i]}
  f=$(ls "$JOB"/"$s"-xp-30m__*/verifier/recording.mp4)
  inputs+=(-i "$f")
  label=$(echo "$s" | awk '{print toupper(substr($0,1,1)) substr($0,2)}')
  filters+="[$i:v]crop=367:240:17:32,scale=368:240,setsar=1,setpts=PTS/10,fps=10,drawtext=fontfile=$FONT:text='$label':fontsize=20:fontcolor=white:x=10:y=10:box=1:boxcolor=black@0.5:boxborderw=8[v$i];"
done

layout=""
for i in $(seq 0 15); do
  col=$((i % 4)); row=$((i / 4))
  layout+="$((col * 368))_$((row * 240))|"
done
layout=${layout%|}

vrefs=""
for i in $(seq 0 15); do vrefs+="[v$i]"; done

ffmpeg -y "${inputs[@]}" \
  -filter_complex "${filters}${vrefs}xstack=inputs=16:layout=$layout[grid]" \
  -map "[grid]" -c:v libx264 -preset medium -crf 22 -pix_fmt yuv420p -an \
  "$OUT"
