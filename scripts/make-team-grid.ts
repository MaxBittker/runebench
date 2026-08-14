#!/usr/bin/env bun
/**
 * Build a grid highlight clip from a team run
 * (smith-team / magic-team / crafting-team, any team size).
 *
 * Layout scales with team size — the last pane is always the rolling chat:
 *   n=1 → 2×1  [feed | chat]
 *   n≤3 → 2×2  (original layout: 3 feeds + chat)
 *   n≤5 → 3×2  (feeds + chat, dark filler panes)
 *   n=6 → 4×2  (6 feeds + chat + filler)
 *
 * The bot feeds are cropped to just the game client (the raw capture has
 * a "Chrome is being controlled…" banner + rs-sdk debug bar), scaled to equal
 * panes, and sped up. The bottom-right quadrant replays the in-game chat
 * transcript in sync with the sped-up video: a rolling window of the most
 * recent messages, in a large font, each appearing at its real elapsed time.
 *
 * Runs entirely locally. Given a job name whose mp4s aren't on disk, it scp's
 * the three recordings + reward.json from the nanny into jobs/<job>/… first
 * (build-team-report.sh deliberately never pulls the mp4s).
 *
 * Usage:
 *   bun scripts/make-team-grid.ts <trial-dir | job-name> [out.mp4]
 *   bun scripts/make-team-grid.ts jobs/smith-team-opus48-XXX/smith-team-30m__YYY
 *   bun scripts/make-team-grid.ts smith-team-opus48-20260603-222543      # scp fallback
 *
 * Env overrides:
 *   REMOTE       nanny host              (default runebench-nanny.exe.xyz)
 *   REMOTE_JOBS  remote jobs dir         (default rs-bench3/jobs)
 *   CROP         ffmpeg crop for a pane  (default crop=762:498:38:44)
 *   TARGET_SECS  target output length    (default 240 → speed picked from it)
 *   SPEED        force a fixed speedup   (overrides TARGET_SECS)
 *   CHAT_FONT    chat font size (px)     (default 25)
 *
 * Requires ffmpeg + ffprobe on PATH. Fonts: macOS Arial (copied to a
 * space-free temp path so ffmpeg's filtergraph parser doesn't choke).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { execFileSync } from 'child_process';

const REMOTE = process.env.REMOTE || 'runebench-nanny.exe.xyz';
const REMOTE_JOBS = process.env.REMOTE_JOBS || 'rs-bench3/jobs';
const CROP = process.env.CROP || 'crop=724:478:38:68'; // game client only (excludes Chrome banner + rs-sdk bottom bar)
const CHAT_FONT_ENV = Number(process.env.CHAT_FONT || 0);

const FPS = 24;

const BOT_COLORS: Record<string, string> = {
  agenta: '0x58a6ff', agentb: '0x3fb950', agentc: '0xf778ba',
  agentd: '0xd29922', agente: '0xa371f7', agentf: '0xff7b72',
};
const BOT_POOL = Object.keys(BOT_COLORS);

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: bun scripts/make-team-grid.ts <trial-dir | job-name> [out.mp4]');
  process.exit(1);
}

const ff = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit' });
const fmtClock = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.round(s) % 60).padStart(2, '0')}`;

// ── Resolve the trial dir; scp the mp4s from the nanny if it's a bare job name ──
function trialHasFeeds(dir: string) {
  return existsSync(join(dir, 'verifier', 'recording-agenta.mp4'));
}
function findTrialUnder(jobDir: string): string | null {
  if (!existsSync(jobDir)) return null;
  if (trialHasFeeds(jobDir)) return jobDir; // arg was already the trial dir
  const sub = readdirSync(jobDir).map(d => join(jobDir, d)).find(d => /__/.test(d) && existsSync(join(d, 'verifier')));
  return sub && trialHasFeeds(sub) ? sub : (sub ?? null);
}

function resolveTrialDir(a: string): string {
  // 1) an on-disk path (trial dir or job dir)
  if (existsSync(a)) {
    const local = findTrialUnder(a);
    if (local && trialHasFeeds(local)) return local;
  }
  // 2) a job name we already have locally
  const localJob = findTrialUnder(join('jobs', a));
  if (localJob && trialHasFeeds(localJob)) return localJob;

  // 3) fetch from the nanny
  const jobName = basename(a.replace(/\/$/, ''));
  console.log(`[fetch] ${jobName} not local — pulling mp4s from ${REMOTE} …`);
  let remoteTrial: string;
  try {
    remoteTrial = execFileSync('ssh', [REMOTE,
      `ls -d ~/${REMOTE_JOBS}/${jobName}/*__* 2>/dev/null | head -1`], { encoding: 'utf-8' }).trim();
  } catch {
    console.error(`[fetch] ssh ${REMOTE} failed`); process.exit(1);
  }
  if (!remoteTrial) { console.error(`[fetch] no trial dir for ${jobName} on ${REMOTE}`); process.exit(1); }
  const dest = join('jobs', jobName, basename(remoteTrial), 'verifier');
  mkdirSync(dest, { recursive: true });
  for (const rel of [...BOT_POOL.map(b => `recording-${b}.mp4`),
                     'reward.json', 'chat-transcript.txt']) {
    console.log(`[fetch]   ${rel}`);
    try { execFileSync('scp', ['-q', `${REMOTE}:${remoteTrial}/${rel}`, join(dest, rel)], { stdio: 'inherit' }); }
    catch { /* optional files (e.g. agentc feed on a 2-bot run) may be absent */ }
  }
  return join('jobs', jobName, basename(remoteTrial));
}

const trialDir = resolveTrialDir(arg);
const vdir = join(trialDir, 'verifier');
const jobName = basename(join(trialDir.replace(/\/$/, ''), '..'));
const reward = JSON.parse(readFileSync(join(vdir, 'reward.json'), 'utf-8'));
const bots: string[] = reward.tracking?.botNames
  ?? (reward.perBot && Object.keys(reward.perBot).length ? Object.keys(reward.perBot) : null)
  ?? BOT_POOL.filter(b => existsSync(join(vdir, `recording-${b}.mp4`)));

// ── Grid geometry scales with team size (cropped client ≈ 1.51:1) ──
// n=6 uses STRIP mode: a COLS×ROWS grid of feeds on top and a full-width
// chat strip underneath taking the bottom 1/3 of the canvas (with ROWS=2 the
// strip is exactly one pane-height tall). Smaller sizes keep chat as a pane.
const N = bots.length;
const STRIP = N >= 6;
const [COLS, ROWS, PW] = N <= 1 ? [2, 1, 700] : N <= 3 ? [2, 2, 700] : N <= 5 ? [3, 2, 620] : [3, 2, 620];
const PH = PW === 700 ? 460 : Math.round(PW / 1.5146 / 2) * 2;
const W = PW * COLS;
const CHAT_W = STRIP ? W : PW;
const CHAT_H = STRIP ? Math.round(PH * ROWS / 2 / 2) * 2 : PH;
const H = PH * ROWS + (STRIP ? CHAT_H : 0);
const CHAT_FONT = CHAT_FONT_ENV || (STRIP ? 24 : 20);

// One pane per bot (missing feed → dark placeholder), chat pane appended below.
const feeds = bots.map(b => {
  const f = join(vdir, `recording-${b}.mp4`);
  return { bot: b, file: existsSync(f) ? f : null };
});
if (!feeds.some(f => f.file)) { console.error(`No recording-*.mp4 in ${vdir}`); process.exit(1); }
const probeFile = feeds.find(f => f.file)!.file!;

// Duration (all feeds are recorded together, so any present one works)
const duration = Number(execFileSync('ffprobe',
  ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'format=duration',
   '-of', 'default=noprint_wrappers=1:nokey=1', probeFile], { encoding: 'utf-8' }).trim());

// Speed: fixed via SPEED, else pick from a target output length.
const TARGET = Number(process.env.TARGET_SECS || 240);
const SPEED = process.env.SPEED
  ? Number(process.env.SPEED)
  : Math.max(2, Math.min(40, Math.round((duration / TARGET) * 2) / 2));
const OUTDUR = +(duration / SPEED).toFixed(2);
console.log(`[grid] ${jobName}  dur=${fmtClock(duration)}  speed=${SPEED}×  out≈${fmtClock(OUTDUR)}`);

const TMP = `/tmp/team_grid-${process.pid}`;
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

// ffmpeg filtergraph parser breaks on spaces in font paths → copy to temp.
const REG = join(TMP, 'reg.ttf');
const BOLD = join(TMP, 'bold.ttf');
copyFileSync('/System/Library/Fonts/Supplemental/Arial.ttf', REG);
copyFileSync('/System/Library/Fonts/Supplemental/Arial Bold.ttf', BOLD);

// ── Title card ──
const taskLabel = jobName.match(/^(smith|magic|crafting)-team/)?.[0] ?? 'team';
const modelLabel = jobName.replace(/^(smith|magic|crafting)-team-/, '').replace(/-\d{8}-\d{6}$/, '');
const scoreLine = (() => {
  if (taskLabel === 'smith-team' && reward.bestItem?.name)
    return `Best item: ${reward.bestItem.name} · ${Math.round(reward.bestItem.cost ?? reward.reward)}gp`;
  if (taskLabel === 'magic-team' && reward.best) return `Best Magic ${reward.best.level ?? reward.reward}`;
  return `Score ${Math.round(reward.reward ?? 0)} · ${reward.chatCount ?? (reward.chat?.length ?? 0)} chat msgs`;
})();
const titleLines: Array<[string, number, string, number]> = [
  [`RuneScape ${taskLabel} — ${N === 1 ? 'one bot' : `${N} bots`}, one model`, 44, 'white', H / 2 - 70],
  [`${modelLabel} · ${bots.join(' | ')} · sped up ${SPEED}×`, 24, '0xc2a36b', H / 2 - 8],
  [scoreLine, 28, '0x7fc88a', H / 2 + 40],
];
const titleFilter = titleLines.map((l, i) => {
  const p = join(TMP, `tt${i}.txt`); writeFileSync(p, l[0]);
  return `drawtext=fontfile=${i === 1 ? REG : BOLD}:textfile=${p}:fontsize=${l[1]}:fontcolor=${l[2]}:x=(w-text_w)/2:y=${l[3]}`;
}).join(',');
ff(['-f', 'lavfi', '-i', `color=c=0x0d1117:s=${W}x${H}:d=2.6`, '-vf', titleFilter,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-an', join(TMP, 'title.mp4')]);

// ── Chat: rolling window of recent messages, timed to the sped-up clock ──
type Chat = { sender: string; text: string; elapsedMs: number };
const chat: Chat[] = ((reward.chat ?? []) as Chat[])
  .filter(c => c && c.text)
  .sort((a, b) => a.elapsedMs - b.elapsedMs);

const WINDOW = 8;                       // most-recent messages shown at once
// Wrap width in chars: Arial runs ≈ 0.53 em per char (the old PW/10.6 at font 20).
const WRAP = Math.floor((CHAT_W - 40) / (CHAT_FONT * 0.53));
const LINEH = CHAT_FONT + 8;            // per-line height incl. spacing
const HEADER_Y = 16, HEADER_BOTTOM = 58, PAD_BOTTOM = 18, PAD_X = 20;
const MAXLINES = Math.floor((CHAT_H - HEADER_BOTTOM - PAD_BOTTOM) / LINEH);

const wrap = (s: string) => {
  const out: string[] = []; let line = '';
  for (const word of s.split(/\s+/)) {
    if (!line) line = word;
    else if ((line + ' ' + word).length <= WRAP) line += ' ' + word;
    else { out.push(line); line = word; }
  }
  if (line) out.push(line);
  return out;
};
// ffmpeg drawtext textfile special chars — only backslashes/percent matter in a textfile.
const clean = (s: string) => s.replace(/[\\%]/g, '');

// The chat pane is pre-rendered as PNG stills (one per visible window state)
// concatenated into a short video track. Rendering each window separately keeps
// the main filtergraph small (chatty runs have 1000+ messages) and lets each
// message be drawn in its sender's color.
const headerDraw = `drawtext=fontfile=${BOLD}:text=TEAM CHAT:fontsize=22:fontcolor=0x8b949e:x=${PAD_X}:y=${HEADER_Y}`;
let pngN = 0;
function renderChatPng(msgs: Chat[]): string {
  let entries = msgs.map(m => ({
    color: BOT_COLORS[m.sender.toLowerCase()] ?? 'white',
    lines: wrap(`[${fmtClock(m.elapsedMs / 1000)}] ${m.sender}: ${m.text}`),
  }));
  while (entries.length > 1 && entries.reduce((n, e) => n + e.lines.length, 0) > MAXLINES) entries.shift();
  const total = entries.reduce((n, e) => n + e.lines.length, 0);
  // Bottom-anchor the block so the newest line is always visible. Each wrapped
  // line gets its own absolutely-positioned drawtext — drawtext's internal
  // line_spacing tracks glyph height, not fontsize, and drifts out of step.
  let y = Math.max(HEADER_BOTTOM, CHAT_H - PAD_BOTTOM - total * LINEH);
  const draws = [headerDraw];
  entries.forEach((e, j) => {
    e.lines.forEach((line, li) => {
      const p = join(TMP, `chat${pngN}_${j}_${li}.txt`);
      writeFileSync(p, clean(line));
      draws.push(`drawtext=fontfile=${REG}:textfile=${p}:fontsize=${CHAT_FONT}:fontcolor=${e.color}:` +
                 `x=${PAD_X}:y=${y}`);
      y += LINEH;
    });
  });
  const png = join(TMP, `chat${pngN++}.png`);
  ff(['-f', 'lavfi', '-i', `color=c=0x0d1117:s=${CHAT_W}x${CHAT_H}`, '-vf', draws.join(','), '-frames:v', '1', png]);
  return png;
}

// Merge messages that land within one hold-slot of output time — windows finer
// than ~0.5s aren't readable anyway.
const MIN_HOLD = 0.5; // output-secs
const emit: number[] = [];
let anchor = -Infinity;
chat.forEach((m, i) => {
  const t0 = m.elapsedMs / 1000 / SPEED;
  if (t0 >= OUTDUR) return;
  if (emit.length && t0 - anchor < MIN_HOLD) emit[emit.length - 1] = i; // same slot → keep latest window
  else { emit.push(i); anchor = t0; }
});

const segments: Array<{ png: string; dur: number }> = [];
const firstT = emit.length ? chat[emit[0]].elapsedMs / 1000 / SPEED : OUTDUR;
if (firstT > 0.02) segments.push({ png: renderChatPng([]), dur: +firstT.toFixed(2) });
emit.forEach((i, k) => {
  const t0 = chat[i].elapsedMs / 1000 / SPEED;
  const t1 = k + 1 < emit.length ? chat[emit[k + 1]].elapsedMs / 1000 / SPEED : OUTDUR;
  segments.push({ png: renderChatPng(chat.slice(Math.max(0, i - WINDOW + 1), i + 1)),
                  dur: +Math.max(0.05, t1 - t0).toFixed(2) });
});
if (!segments.length) segments.push({ png: renderChatPng([]), dur: OUTDUR });
segments[segments.length - 1].dur += 3; // overshoot; the grid pass is clamped to OUTDUR

const chatList = join(TMP, 'chatlist.txt');
writeFileSync(chatList,
  'ffconcat version 1.0\n' +
  segments.map(s => `file '${s.png}'\nduration ${s.dur}`).join('\n') +
  `\nfile '${segments[segments.length - 1].png}'\n`);
const chatMp4 = join(TMP, 'chat.mp4');
ff(['-f', 'concat', '-safe', '0', '-i', chatList, '-vf', `fps=${FPS},format=yuv420p`,
    '-c:v', 'libx264', '-t', String(OUTDUR), '-an', chatMp4]);

// ── One-pass grid (COLS×ROWS) ──
// Inputs: N bot feeds (or lavfi black for a missing one) + the pre-rendered
// chat pane + dark lavfi fillers for any remaining slots.
// STRIP mode: the chat pane is an extra full-width slot below the feed grid
// (not one of the COLS×ROWS grid cells), so no fillers are needed.
const SLOTS = STRIP ? feeds.length + 1 : COLS * ROWS;
const inputs: string[] = [];
feeds.forEach(f => {
  if (f.file) { inputs.push('-i', f.file); }
  else { inputs.push('-f', 'lavfi', '-i', `color=c=0x161b22:s=${PW}x${PH}:r=${FPS}:d=${OUTDUR}`); }
});
inputs.push('-i', chatMp4); // pre-rendered chat pane = input feeds.length
const nFillers = STRIP ? 0 : SLOTS - feeds.length - 1;
for (let i = 0; i < nFillers; i++) {
  inputs.push('-f', 'lavfi', '-i', `color=c=0x0d1117:s=${PW}x${PH}:r=${FPS}:d=${OUTDUR}`);
}

const paneFilters = feeds.map((f, idx) => {
  const label = `${f.bot}`;
  const lf = join(TMP, `label${idx}.txt`); writeFileSync(lf, label);
  const badge = `drawtext=fontfile=${BOLD}:textfile=${lf}:fontsize=20:fontcolor=white:` +
    `box=1:boxcolor=${(BOT_COLORS[f.bot] ?? '0x30363d')}@0.85:boxborderw=8:x=12:y=12`;
  if (f.file) {
    // setpts+fps first so scale/drawtext only run on the ~1/SPEED frames we keep
    return `[${idx}:v]setpts=PTS/${SPEED},fps=${FPS},${CROP},scale=${PW}:${PH}:flags=lanczos,${badge},` +
           `format=yuv420p,setsar=1[p${idx}]`;
  }
  // placeholder pane: badge + "no feed"
  const nf = join(TMP, `nofeed${idx}.txt`); writeFileSync(nf, 'no feed');
  return `[${idx}:v]${badge},drawtext=fontfile=${REG}:textfile=${nf}:fontsize=26:fontcolor=0x6e7681:` +
         `x=(w-text_w)/2:y=(h-text_h)/2,format=yuv420p,setsar=1[p${idx}]`;
});
const chatIdx = feeds.length;
const chatFilter = `[${chatIdx}:v]tpad=stop_mode=clone:stop_duration=5,format=yuv420p,setsar=1[p${chatIdx}]`;
const fillerFilters = Array.from({ length: nFillers }, (_, i) =>
  `[${chatIdx + 1 + i}:v]format=yuv420p,setsar=1[p${chatIdx + 1 + i}]`);
// xstack layout: row-major, absolute pixel offsets; in STRIP mode the last
// slot is the full-width chat strip anchored below the feed rows.
const layout = STRIP
  ? [...feeds.map((_, i) => `${(i % COLS) * PW}_${Math.floor(i / COLS) * PH}`),
     `0_${ROWS * PH}`].join('|')
  : Array.from({ length: SLOTS }, (_, i) =>
      `${(i % COLS) * PW}_${Math.floor(i / COLS) * PH}`).join('|');
const stack = Array.from({ length: SLOTS }, (_, i) => `[p${i}]`).join('') +
  `xstack=inputs=${SLOTS}:layout=${layout}[grid]`;
const filterComplex = [...paneFilters, chatFilter, ...fillerFilters, stack].join(';');

ff([...inputs, '-t', String(OUTDUR), '-filter_complex', filterComplex, '-map', '[grid]',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-an', join(TMP, 'grid.mp4')]);

// ── Concat title + grid ──
const listFile = join(TMP, 'list.txt');
writeFileSync(listFile, [join(TMP, 'title.mp4'), join(TMP, 'grid.mp4')].map(f => `file '${f}'`).join('\n') + '\n');
const out = process.argv[3] || join('results', 'team', `${jobName}-grid.mp4`);
mkdirSync(join('results', 'team'), { recursive: true });
ff(['-f', 'concat', '-safe', '0', '-i', listFile,
    '-c', 'copy', '-movflags', '+faststart', out]);
rmSync(TMP, { recursive: true, force: true });
console.log(`\nWrote ${out}`);
