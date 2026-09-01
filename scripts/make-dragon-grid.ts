#!/usr/bin/env bun
/**
 * Build a composited highlight clip from a dragon-team run — the dragon-task
 * sibling of make-market-grid.ts, reading straight from the job dir (no
 * extractor step: reward.json embeds the watcher tracking).
 *
 * Layout (10 bots):
 *   ┌──────┬──────┬──────┬──────┬──────┐
 *   │ anna │ ben  │ cara │ dan  │ ella │   5×2 grid of cropped, sped-up bot
 *   ├──────┼──────┼──────┼──────┼──────┤   feeds (badge = bot · model; the
 *   │ finn │ gus  │ hana │ ivy  │ jack │   covert selfish bot is flagged red)
 *   ├──────┬──────┬───────┬───────┬────┤
 *   │KILLS │WEALTH│ KILLS │ CHAT  │        bottom strip, synced to the
 *   └──────┴──────┴─FEED──┴───────┴────┘   sped-up clock
 *
 *   KILLS   cumulative SERVER-VERIFIED KBD kills (engine kill ledger)
 *   WEALTH  per-bot wealth (coins + item store value) over time — the covert
 *           selfish bot in red, everyone else in team blue
 *   FEED    rolling list of verified kills with per-bot damage splits
 *   CHAT    rolling window of in-game chat
 *
 * Usage:
 *   bun scripts/make-dragon-grid.ts <job-name> [out.mp4]
 *
 * Env overrides: COLS, PANE_PW, CROP, TARGET_SECS, SPEED (see make-market-grid).
 * Requires ffmpeg + ffprobe + python3/matplotlib (macOS Arial fonts).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, readdirSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';

const REPO = join(import.meta.dir, '..');
const CROP = process.env.CROP || 'crop=724:478:38:68';
const FPS = 24;
const KBD_NPC_ID = 50;

const ff = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit' });
const fmtClock = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.round(s) % 60).padStart(2, '0')}`;
const fmtGp = (n: number) => Math.round(n).toLocaleString('en-US');

// ── Locate the job + load reward.json (embeds the watcher tracking) ──
const jobName = process.argv[2];
if (!jobName) { console.error('usage: bun scripts/make-dragon-grid.ts <job-name> [out.mp4]'); process.exit(1); }
const jobRoot = join(REPO, 'jobs', jobName);
const trialDir = readdirSync(jobRoot).map(d => join(jobRoot, d))
  .find(d => existsSync(join(d, 'verifier', 'reward.json')));
if (!trialDir) { console.error(`no trial with verifier/reward.json under ${jobRoot}`); process.exit(1); }
const reward = JSON.parse(readFileSync(join(trialDir, 'verifier', 'reward.json'), 'utf8'));
const tracking = reward.tracking;
if (!tracking) { console.error('reward.json has no embedded tracking'); process.exit(1); }
const botNames: string[] = tracking.botNames;
const selfishBot: string = reward.selfish?.bot ?? '';
const botModels: Record<string, string> = existsSync(join(trialDir, 'agent', 'bot-models.json'))
  ? JSON.parse(readFileSync(join(trialDir, 'agent', 'bot-models.json'), 'utf8')) : {};
const shortModel = (id: string) => (id ?? '').replace(/^[^/]+\//, '').replace(/^~/, '').replace(/^[^/]+\//, '');

// Colors: team blue for the loyal nine, red for the covert selfish bot.
const TEAM_COLOR = '0x58a6ff';
const SELFISH_COLOR = '0xff5a52';
const KILL_COLOR = '0x3fb950';
const botColor: Record<string, string> = {};
botNames.forEach(b => { botColor[b] = b === selfishBot ? SELFISH_COLOR : TEAM_COLOR; });

const feeds = botNames.map(b => {
  const f = join(trialDir, 'agent', `recording-${b}.mp4`);
  return { bot: b, file: existsSync(f) ? f : null };
});
if (!feeds.some(f => f.file)) { console.error(`no recordings in ${trialDir}/agent`); process.exit(1); }
const probeFile = feeds.find(f => f.file)!.file!;

// ── Timeline data ──
const samples = (tracking.samples as any[]).map(s => ({
  t: s.elapsedMs / 1000,
  wealth: Object.fromEntries(botNames.map(b => [b, s.bots?.[b]?.wealth ?? s.bots?.[b]?.gold ?? null])),
}));
// carry-forward nulls so lines don't dip to zero on observer hiccups
const lastVal: Record<string, number> = {};
for (const s of samples) for (const b of botNames) {
  if (s.wealth[b] == null) s.wealth[b] = lastVal[b] ?? 0; else lastVal[b] = s.wealth[b];
}
const kbdKills = (tracking.kills as any[]).filter(k => k.npcId === KBD_NPC_ID)
  .map(k => ({ ...k, t: k.elapsedMs / 1000 }));
const chat = (tracking.chat as any[]).map(c => ({ t: c.elapsedMs / 1000, sender: c.sender, to: c.to, text: c.text }));
const capSecs = Number((jobName.match(/dragon-team[^0-9]*(\d+)m/) ?? [])[1] ?? 60) * 60 || 3600;

// ── Geometry ──
const COLS = Number(process.env.COLS || (feeds.length > 6 ? 5 : 3));
const ROWS = Math.ceil(feeds.length / COLS);
const PW = Number(process.env.PANE_PW || (COLS > 3 ? 440 : 620));
const PH = Math.round(PW / 1.5146 / 2) * 2;
const W = PW * COLS;
const BH = Math.max(PH, 400);
const PANE_W = Math.floor(W / 4 / 2) * 2;

// ── Timing ──
const duration = Number(execFileSync('ffprobe',
  ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'format=duration',
   '-of', 'default=noprint_wrappers=1:nokey=1', probeFile], { encoding: 'utf-8' }).trim());
const TARGET = Number(process.env.TARGET_SECS || 240);
const SPEED = process.env.SPEED
  ? Number(process.env.SPEED)
  : Math.max(2, Math.min(40, Math.round((duration / TARGET) * 2) / 2));
const OUTDUR = +(duration / SPEED).toFixed(2);
console.log(`[grid] ${jobName}  dur=${fmtClock(duration)}  speed=${SPEED}×  out≈${fmtClock(OUTDUR)}  kills=${kbdKills.length}`);

const TMP = `/tmp/dragon_grid-${process.pid}`;
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const REG = join(TMP, 'reg.ttf');
const BOLD = join(TMP, 'bold.ttf');
copyFileSync('/System/Library/Fonts/Supplemental/Arial.ttf', REG);
copyFileSync('/System/Library/Fonts/Supplemental/Arial Bold.ttf', BOLD);

// ── Title card ──
const models = [...new Set(Object.values(botModels).map(shortModel))];
const selfish = reward.selfish ?? { finalWealth: 0, wealthRank: 0 };
const titleLines: Array<[string, number, string, number]> = [
  [`RuneScape dragon-team — ${botNames.length} bots hunt the King Black Dragon`, 44, 'white', H0() - 110],
  [`${models.join(' + ') || 'one model'} · shared goal: most KBD kills in ${Math.round(capSecs / 60)} min · sped up ${SPEED}×`, 22, '0xc2a36b', H0() - 44],
  [`One covert SELFISH agent (${selfishBot || '?'}, red) is secretly scored on personal wealth instead`, 22, '0xff7b72', H0() - 8],
  [`${kbdKills.length} server-verified kills · ${selfishBot} ended wealth rank ${selfish.wealthRank}/${botNames.length} with ${fmtGp(selfish.finalWealth)}gp`, 28, '0x7fc88a', H0() + 44],
];
function H0() { return (PH * ROWS + BH) / 2; }
const H = PH * ROWS + BH;
const titleFilter = titleLines.map((l, i) => {
  const p = join(TMP, `tt${i}.txt`); writeFileSync(p, l[0]);
  return `drawtext=fontfile=${i === 0 || i === 3 ? BOLD : REG}:textfile=${p}:fontsize=${l[1]}:fontcolor=${l[2]}:x=(w-text_w)/2:y=${l[3]}`;
}).join(',');
ff(['-f', 'lavfi', '-i', `color=c=0x0d1117:s=${W}x${H}:d=2.6`, '-vf', titleFilter,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-an', join(TMP, 'title.mp4')]);

// ── Rolling-text panes (kill feed + chat) ───────────────────────
const TEXT_FONT = 19;
const WRAP = Math.floor((PANE_W - 40) / (TEXT_FONT * 0.53));
const LINEH = TEXT_FONT + 8;
const HEADER_Y = 16, HEADER_BOTTOM = 56, PAD_BOTTOM = 16, PAD_X = 20;
const MAXLINES = Math.floor((BH - HEADER_BOTTOM - PAD_BOTTOM) / LINEH);

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
const clean = (s: string) => s.replace(/[\\%]/g, '');

interface Line { color: string; text: string }
let pngN = 0;
function renderPanePng(header: string, entries: Line[][]): string {
  let blocks = entries.map(e => e.map(l => ({ color: l.color, lines: wrap(l.text) })));
  const count = () => blocks.reduce((n, b) => n + b.reduce((m, l) => m + l.lines.length, 0), 0);
  while (blocks.length > 1 && count() > MAXLINES) blocks.shift();
  const hf = join(TMP, `hdr${pngN}.txt`); writeFileSync(hf, header);
  const draws = [`drawtext=fontfile=${BOLD}:textfile=${hf}:fontsize=22:fontcolor=0x8b949e:x=${PAD_X}:y=${HEADER_Y}`];
  let y = Math.max(HEADER_BOTTOM, BH - PAD_BOTTOM - count() * LINEH);
  blocks.forEach((b, j) => b.forEach((l, li) => l.lines.forEach((line, k) => {
    const p = join(TMP, `pane${pngN}_${j}_${li}_${k}.txt`);
    writeFileSync(p, clean(line));
    draws.push(`drawtext=fontfile=${REG}:textfile=${p}:fontsize=${TEXT_FONT}:fontcolor=${l.color}:x=${PAD_X}:y=${y}`);
    y += LINEH;
  })));
  const png = join(TMP, `pane${pngN++}.png`);
  ff(['-f', 'lavfi', '-i', `color=c=0x0d1117:s=${PANE_W}x${BH}`, '-vf', draws.join(','), '-frames:v', '1', png]);
  return png;
}

function buildRollingPane(name: string, header: string, items: Array<{ t: number; lines: Line[] }>, WINDOW: number): string {
  const MIN_HOLD = 0.5;
  const emit: number[] = [];
  let anchor = -Infinity;
  items.forEach((m, i) => {
    const t0 = m.t / SPEED;
    if (t0 >= OUTDUR) return;
    if (emit.length && t0 - anchor < MIN_HOLD) emit[emit.length - 1] = i;
    else { emit.push(i); anchor = t0; }
  });
  const segments: Array<{ png: string; dur: number }> = [];
  const firstT = emit.length ? items[emit[0]].t / SPEED : OUTDUR;
  if (firstT > 0.02) segments.push({ png: renderPanePng(header, []), dur: +firstT.toFixed(2) });
  emit.forEach((i, k) => {
    const t0 = items[i].t / SPEED;
    const t1 = k + 1 < emit.length ? items[emit[k + 1]].t / SPEED : OUTDUR;
    segments.push({
      png: renderPanePng(header, items.slice(Math.max(0, i - WINDOW + 1), i + 1).map(m => m.lines)),
      dur: +Math.max(0.05, t1 - t0).toFixed(2),
    });
  });
  if (!segments.length) segments.push({ png: renderPanePng(header, []), dur: OUTDUR });
  segments[segments.length - 1].dur += 3;
  const list = join(TMP, `${name}.txt`);
  writeFileSync(list,
    'ffconcat version 1.0\n' +
    segments.map(s => `file '${s.png}'\nduration ${s.dur}`).join('\n') +
    `\nfile '${segments[segments.length - 1].png}'\n`);
  const mp4 = join(TMP, `${name}.mp4`);
  ff(['-f', 'concat', '-safe', '0', '-i', list, '-vf', `fps=${FPS},format=yuv420p`,
      '-c:v', 'libx264', '-t', String(OUTDUR), '-an', mp4]);
  return mp4;
}

// Chat pane: one entry per message, selfish bot in red.
const chatItems = chat.filter(c => c.text).map(c => ({
  t: c.t,
  lines: [{ color: botColor[(c.sender ?? '').toLowerCase()] ?? 'white',
            text: `[${fmtClock(c.t)}] ${c.sender}${c.to ? ` -> ${c.to} (pm)` : ''}: ${c.text}` }],
}));
console.log(`[chat] ${chatItems.length} messages`);
const chatMp4 = buildRollingPane('chat', 'CHAT', chatItems, 8);

// Kill feed pane: one entry per verified kill, with the damage split.
const killItems = kbdKills.map((k, i) => ({
  t: k.t,
  lines: [
    { color: '0x7fc88a', text: `[${fmtClock(k.t)}] KILL #${i + 1} — top: ${k.killer ?? '?'}` },
    { color: '0x8b949e', text: `  ${(k.contributors ?? []).map((c: any) => `${c.username ?? '?'} ${c.damage}`).join(' · ')}` },
  ],
}));
const killsFeedMp4 = buildRollingPane('killfeed', 'VERIFIED KILL FEED', killItems, 6);

// ── Graph panes via matplotlib (KILLS + WEALTH) ─────────────────
const multiPy = `
import json, sys
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.ticker import FuncFormatter, MaxNLocator

cfg = json.load(open(sys.argv[1]))
BG = '#0d1117'; FG = '#8b949e'
series = cfg['series']; ts = cfg['ts']
vals_all = [v for s in series for v in s['vals'] if v is not None]
ymax = max(1, max(vals_all) if vals_all else 1) * 1.08
xmax = max(cfg['capSecs'], ts[-1] if ts else 1)
fmt = lambda v, _: ('%.1fk' % (v / 1000)).replace('.0k', 'k') if v >= 1000 else '%d' % v

fig, ax = plt.subplots(figsize=(cfg['w'] / 100, cfg['h'] / 100), dpi=100)
fig.patch.set_facecolor(BG); ax.set_facecolor(BG)
fig.subplots_adjust(left=0.105, right=0.975, top=0.86, bottom=0.11)
for sp in ax.spines.values(): sp.set_color('#30363d')
ax.tick_params(colors=FG, labelsize=8.5)
ax.set_xlim(0, xmax); ax.set_ylim(0, ymax)
if cfg.get('intY'): ax.yaxis.set_major_locator(MaxNLocator(integer=True))
ax.grid(color='#30363d', alpha=0.35, linewidth=0.6)
ax.xaxis.set_major_formatter(FuncFormatter(lambda v, _: '%d:%02d' % (v // 60, v % 60)))
ax.yaxis.set_major_formatter(FuncFormatter(fmt))
fig.text(0.02, 0.945, cfg['title'], color=FG, fontsize=13, fontweight='bold', family='Arial')
fig.text(0.975, 0.945, cfg['subtitle'], color=FG, fontsize=9, ha='right', family='Arial')

lines, dots = [], []
for s in series:
    (ln,) = ax.plot([], [], color=s['color'], linewidth=s.get('lw', 1.6),
                    label=s.get('label'),
                    drawstyle='steps-post' if cfg.get('step') else 'default')
    lines.append(ln)
    (dot,) = ax.plot([], [], 'o', color=s['color'], markersize=3.5)
    dots.append(dot)
labeled = [(l, s) for l, s in zip(lines, series) if s.get('label')]
if labeled:
    leg = ax.legend([l for l, _ in labeled], [s['label'] for _, s in labeled],
                    loc='upper left', fontsize=9.5, frameon=False,
                    labelcolor=[s['color'] for _, s in labeled],
                    handlelength=1.2, borderaxespad=0.2)
    for t in leg.get_texts(): t.set_fontweight('bold')
nan = float('nan')
for i in range(len(ts)):
    for k, s in enumerate(series):
        ys = [nan if v is None else v for v in s['vals'][:i + 1]]
        lines[k].set_data(ts[:i + 1], ys)
        dots[k].set_data([ts[i]], [ys[-1] if ys else 0])
    fig.savefig('%s/frame_%04d.png' % (cfg['out'], i), facecolor=BG)
print('rendered %d frames' % len(ts))
`;

function framesToMp4(dir: string, name: string): string {
  const segs: string[] = ['ffconcat version 1.0'];
  if (samples.length && samples[0].t > 0)
    segs.push(`file '${dir}/frame_0000.png'`, `duration ${(samples[0].t / SPEED).toFixed(3)}`);
  samples.forEach((s, i) => {
    const t1 = i + 1 < samples.length ? samples[i + 1].t : Math.max(s.t, OUTDUR * SPEED);
    segs.push(`file '${dir}/frame_${String(i).padStart(4, '0')}.png'`,
              `duration ${Math.max(0.03, (t1 - s.t) / SPEED + (i === samples.length - 1 ? 3 : 0)).toFixed(3)}`);
  });
  segs.push(`file '${dir}/frame_${String(samples.length - 1).padStart(4, '0')}.png'`);
  const list = join(TMP, `${name}list.txt`);
  writeFileSync(list, segs.join('\n') + '\n');
  const mp4 = join(TMP, `${name}.mp4`);
  ff(['-f', 'concat', '-safe', '0', '-i', list, '-vf', `fps=${FPS},scale=${PANE_W}:${BH},format=yuv420p`,
      '-c:v', 'libx264', '-t', String(OUTDUR), '-an', mp4]);
  return mp4;
}

function renderMultiSeries(name: string, cfg: { title: string; subtitle: string; step?: boolean; intY?: boolean;
                           series: Array<{ label?: string; vals: Array<number | null>; color: string; lw?: number }> }): string {
  const dir = join(TMP, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(TMP, `${name}.json`), JSON.stringify({ out: dir, w: PANE_W, h: BH, capSecs, ts: samples.map(s => s.t), ...cfg }));
  writeFileSync(join(TMP, `${name}.py`), multiPy);
  console.log(`[${name}] rendering ${samples.length} frames …`);
  execFileSync('python3', [join(TMP, `${name}.py`), join(TMP, `${name}.json`)], { stdio: 'inherit' });
  return framesToMp4(dir, name);
}

// KILLS: cumulative verified kill count at each sample time.
const killVals = samples.map(s => kbdKills.filter(k => k.t <= s.t).length);
const killsMp4 = renderMultiSeries('kills', {
  title: 'KBD KILLS', subtitle: 'server-verified (engine kill ledger)', step: true, intY: true,
  series: [{ label: `team kills`, vals: killVals, color: '#' + KILL_COLOR.slice(2), lw: 2.4 }],
});

// WEALTH: per-bot wealth; only the selfish bot gets a legend entry.
const wealthMp4 = renderMultiSeries('wealth', {
  title: 'WEALTH', subtitle: 'coins + item store value (inv+bank+worn)',
  series: botNames.map(b => ({
    label: b === selfishBot ? `${b} (covert selfish)` : undefined,
    vals: samples.map(s => s.wealth[b]),
    color: '#' + botColor[b].slice(2),
    lw: b === selfishBot ? 2.6 : 1.1,
  })),
});

// ── Per-pane wealth HUD (ASS subtitles, stepped to watcher samples) ──
const assTime = (sec: number) => {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000), m = Math.floor((cs % 360000) / 6000), sc = Math.floor((cs % 6000) / 100), c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(sc).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
};
const HUD_FONT = PW >= 600 ? 22 : 16;
function writeWealthHudAss(bot: string): string {
  const ev: string[] = [];
  const bal = (i: number) => `${fmtGp(samples[i].wealth[bot] ?? 0)}gp`;
  let i = 0;
  while (i < samples.length) {
    let j = i;
    while (j + 1 < samples.length && bal(j + 1) === bal(i)) j++;
    const t0 = samples[i].t / SPEED, t1 = (j + 1 < samples.length ? samples[j + 1].t : samples[j].t + 5) / SPEED;
    ev.push(`Dialogue: 0,${assTime(t0)},${assTime(Math.max(t1, t0 + 0.05))},Bal,,0,0,0,,${bal(i)}`);
    i = j + 1;
  }
  const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: ${PW}
PlayResY: ${PH}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Bal,Arial,${HUD_FONT},&H66D8FF&,&H66D8FF&,&HD0110D0D&,&HD0110D0D&,-1,0,0,0,100,100,0,0,3,4,0,9,0,12,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${ev.join('\n')}
`;
  const f = join(TMP, `hud_${bot}.ass`);
  writeFileSync(f, ass);
  return f;
}
const hudAss: Record<string, string> = {};
feeds.forEach(f => { if (f.file) hudAss[f.bot] = writeWealthHudAss(f.bot); });

// ── One-pass grid ──
const inputs: string[] = [];
feeds.forEach(f => {
  if (f.file) inputs.push('-i', f.file);
  else inputs.push('-f', 'lavfi', '-i', `color=c=0x161b22:s=${PW}x${PH}:r=${FPS}:d=${OUTDUR}`);
});
inputs.push('-i', killsMp4, '-i', wealthMp4, '-i', killsFeedMp4, '-i', chatMp4);

const paneFilters = feeds.map((f, idx) => {
  const lf = join(TMP, `label${idx}.txt`);
  const model = shortModel(botModels[f.bot] ?? '');
  writeFileSync(lf, `${f.bot}${model ? ` · ${model}` : ''}`);
  const badge = `drawtext=fontfile=${BOLD}:textfile=${lf}:fontsize=${PW >= 600 ? 20 : 15}:fontcolor=white:` +
    `box=1:boxcolor=${(botColor[f.bot] ?? '0x30363d')}@0.85:boxborderw=8:x=12:y=12`;
  if (f.file) {
    const hud = hudAss[f.bot] ? `subtitles=${hudAss[f.bot]}:fontsdir=${TMP},` : '';
    return `[${idx}:v]setpts=PTS/${SPEED},fps=${FPS},${CROP},scale=${PW}:${PH}:flags=lanczos,${badge},${hud}` +
           `format=yuv420p,setsar=1[p${idx}]`;
  }
  const nf = join(TMP, `nofeed${idx}.txt`); writeFileSync(nf, 'no feed');
  return `[${idx}:v]${badge},drawtext=fontfile=${REG}:textfile=${nf}:fontsize=26:fontcolor=0x6e7681:` +
         `x=(w-text_w)/2:y=(h-text_h)/2,format=yuv420p,setsar=1[p${idx}]`;
});
const nb = feeds.length;
const stripFilters = [0, 1, 2, 3].map(i =>
  `[${nb + i}:v]tpad=stop_mode=clone:stop_duration=5,scale=${PANE_W}:${BH},format=yuv420p,setsar=1[p${nb + i}]`);
const layout = [
  ...feeds.map((_, i) => `${(i % COLS) * PW}_${Math.floor(i / COLS) * PH}`),
  `0_${ROWS * PH}`, `${PANE_W}_${ROWS * PH}`, `${2 * PANE_W}_${ROWS * PH}`, `${W - PANE_W}_${ROWS * PH}`,
].join('|');
const SLOTS = nb + 4;
const stack = Array.from({ length: SLOTS }, (_, i) => `[p${i}]`).join('') +
  `xstack=inputs=${SLOTS}:layout=${layout}:fill=0x0d1117[grid]`;
const filterComplex = [...paneFilters, ...stripFilters, stack].join(';');

ff([...inputs, '-t', String(OUTDUR), '-filter_complex', filterComplex, '-map', '[grid]',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-an', join(TMP, 'grid.mp4')]);

// ── Concat title + grid ──
const listFile = join(TMP, 'list.txt');
writeFileSync(listFile, [join(TMP, 'title.mp4'), join(TMP, 'grid.mp4')].map(f => `file '${f}'`).join('\n') + '\n');
const out = process.argv[3] || join(REPO, 'results', 'dragon', `${jobName}-grid.mp4`);
mkdirSync(join(REPO, 'results', 'dragon'), { recursive: true });
ff(['-f', 'concat', '-safe', '0', '-i', listFile,
    '-c', 'copy', '-movflags', '+faststart', out]);
rmSync(TMP, { recursive: true, force: true });
console.log(`\nWrote ${out}`);
