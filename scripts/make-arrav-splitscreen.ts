#!/usr/bin/env bun
/**
 * Build a side-by-side (split-screen) highlight clip from a duo arrav run.
 *
 * The duo entrypoint records one feed per bot (recording-agenta.mp4 /
 * recording-agentb.mp4). This stacks them horizontally with per-bot labels,
 * cuts the key beats (from the run's reward.json milestones + chat), speeds
 * each up, captions it, and concatenates into one clip.
 *
 * Usage:
 *   bun scripts/make-arrav-splitscreen.ts <trial-dir> [out.mp4]
 *   bun scripts/make-arrav-splitscreen.ts jobs/arrav-duo-opus48-XXX/arrav-duo-45m__YYY
 *
 * Requires ffmpeg on PATH. Fonts: macOS Arial (copied to a space-free temp
 * path so ffmpeg's filtergraph parser doesn't choke).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { execFileSync } from 'child_process';

const trialDir = process.argv[2];
if (!trialDir || !existsSync(trialDir)) {
  console.error('Usage: bun scripts/make-arrav-splitscreen.ts <trial-dir> [out.mp4]');
  process.exit(1);
}
const vdir = join(trialDir, 'verifier');
const fa = join(vdir, 'recording-agenta.mp4');
const fb = join(vdir, 'recording-agentb.mp4');
for (const f of [fa, fb]) {
  if (!existsSync(f)) {
    console.error(`Missing ${f} — this run predates dual-feed capture (only recording.mp4).`);
    process.exit(1);
  }
}

// Job dir = parent of the trial dir, e.g. arrav-duo-fable5-20260609-185927
const jobName = basename(join(trialDir.replace(/\/$/, ''), '..'));
const reward = JSON.parse(readFileSync(join(vdir, 'reward.json'), 'utf-8'));

const TMP = '/tmp/arrav_split';
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

// ffmpeg filtergraph parser breaks on spaces in font paths → copy to temp.
const REG = join(TMP, 'reg.ttf');
const BOLD = join(TMP, 'bold.ttf');
copyFileSync('/System/Library/Fonts/Supplemental/Arial.ttf', REG);
copyFileSync('/System/Library/Fonts/Supplemental/Arial Bold.ttf', BOLD);

const ff = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit' });
const fmtClock = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.round(s) % 60).padStart(2, '0')}`;

// ── Beats: derive from milestones, plus fixed open/close ──
type Beat = { at: number; dur: number; speed: number; cap: string };
const ms = (reward.milestones || []) as Array<{ elapsedMs: number; bot: string; item: string; event: string }>;
const firstGain = (item: string) => {
  const m = ms.find(x => x.item === item && x.event === 'gained');
  return m ? Math.round(m.elapsedMs / 1000) : null;
};
const beats: Beat[] = [];
const push = (at: number | null, dur: number, speed: number, cap: string) => {
  if (at == null) return;
  beats.push({ at: Math.max(0, at - 4), dur, speed, cap });
};
push(80, 14, 3, 'Roles split — A: Phoenix Gang   B: Black Arm');
push(firstGain('intelligence_report'), 16, 4, 'A kills Jonny the Beard, takes the intel report');
push(firstGain('arravshield1'), 14, 4, 'A loots the right shield half');
// Strength grind: detect a stretch with no item events but the run continuing
push(960, 24, 6, 'A trains Strength to beat the lvl-23 guard');
// Crossbow handoff = agentb gains the crossbow
const xbowToB = ms.find(x => x.item === 'phoenix_crossbow' && x.bot === 'agentb' && x.event === 'gained');
push(xbowToB ? Math.round(xbowToB.elapsedMs / 1000) - 30 : null, 44, 7, 'Crossbow handoff at the weapon store');
const shieldToB = ms.find(x => x.item === 'arravshield2' && x.bot === 'agentb' && x.event === 'gained');
push(shieldToB ? Math.round(shieldToB.elapsedMs / 1000) : null, 40, 7, 'Shield-half handoff at the Varrock Museum');
const done = reward.firstCompletionSecs;
push(done ? done - 35 : null, 42, 5, reward.completed ? 'Both bots turn in certs — QUEST COMPLETE' : 'Final minutes');

const PW = 600, PH = 450;     // each pane → 1200x450 stacked
const W = PW * 2;
const titleLines = [
  ['Shield of Arrav — split-screen', 40, 'white', 150],
  [`${jobName.replace('arrav-duo-', '')}  ·  agenta (Phoenix)  |  agentb (Black Arm)`, 22, '0xc2a36b', 215],
  [reward.completed ? `Completed ${fmtClock(reward.firstCompletionSecs)}${reward.bothCompleted ? ' · both bots' : ''}`
                    : 'Did not finish', 28, reward.completed ? '0x7fc88a' : '0xd08a7a', 262],
] as const;

// Title card
const titleTxts = titleLines.map((l, i) => {
  const p = join(TMP, `tt${i}.txt`); writeFileSync(p, String(l[0])); return p;
});
const titleFilter = titleLines.map((l, i) =>
  `drawtext=fontfile=${i === 1 ? REG : BOLD}:textfile=${titleTxts[i]}:fontsize=${l[1]}:fontcolor=${l[2]}:x=(w-text_w)/2:y=${l[3]}`
).join(',');
ff(['-f', 'lavfi', '-i', `color=c=0x141414:s=${W}x${PH}:d=2.5`, '-vf', titleFilter,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '24', '-an', join(TMP, 'seg0.mp4')]);

// Beat segments: hstack the two feeds, label each pane, caption the beat.
const list: string[] = [join(TMP, 'seg0.mp4')];
beats.forEach((b, idx) => {
  const capf = join(TMP, `cap${idx}.txt`); writeFileSync(capf, `${fmtClock(b.at + 4)}   ${b.cap}`);
  const la = join(TMP, `la${idx}.txt`); writeFileSync(la, 'agenta · Phoenix');
  const lb = join(TMP, `lb${idx}.txt`); writeFileSync(lb, 'agentb · Black Arm');
  const filter = [
    `[0:v]scale=${PW}:${PH}:flags=lanczos,setpts=PTS/${b.speed},` +
      `drawtext=fontfile=${BOLD}:textfile=${la}:fontsize=18:fontcolor=white:box=1:boxcolor=0x1a3a6a@0.8:boxborderw=7:x=10:y=10[a]`,
    `[1:v]scale=${PW}:${PH}:flags=lanczos,setpts=PTS/${b.speed},` +
      `drawtext=fontfile=${BOLD}:textfile=${lb}:fontsize=18:fontcolor=white:box=1:boxcolor=0x1a6a3a@0.8:boxborderw=7:x=10:y=10[b]`,
    `[a][b]hstack=inputs=2[s]`,
    `[s]drawtext=fontfile=${BOLD}:textfile=${capf}:fontsize=24:fontcolor=white:box=1:boxcolor=0x000000@0.7:boxborderw=14:x=(w-text_w)/2:y=h-52[v]`,
  ].join(';');
  const out = join(TMP, `seg${idx + 1}.mp4`);
  ff(['-ss', String(b.at), '-t', String(b.dur), '-i', fa,
      '-ss', String(b.at), '-t', String(b.dur), '-i', fb,
      '-filter_complex', filter, '-map', '[v]',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '24', '-an', out]);
  list.push(out);
  console.log(`  beat ${idx + 1}: ${fmtClock(b.at + 4)} ${b.cap}`);
});

const listFile = join(TMP, 'list.txt');
writeFileSync(listFile, list.map(f => `file '${f}'`).join('\n') + '\n');
const out = process.argv[3] || join('results', 'arrav', `${jobName}-splitscreen.mp4`);
mkdirSync(join('results', 'arrav'), { recursive: true });
ff(['-f', 'concat', '-safe', '0', '-i', listFile,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out]);
rmSync(TMP, { recursive: true, force: true });
console.log(`\nWrote ${out}`);
