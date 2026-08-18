#!/usr/bin/env bun
/**
 * Build a composited highlight clip from a market run — the market-task
 * sibling of make-team-grid.ts.
 *
 * Layout (6 bots):
 *   ┌────────┬────────┬────────┐
 *   │ agenta │ agentb │ agentc │   3×2 grid of cropped, sped-up bot feeds
 *   ├────────┼────────┼────────┤   (badge = bot · role)
 *   │ agentd │ agente │ agentf │
 *   ├────────┬────────┬────────┤
 *   │  GOLD  │  CHAT  │ TRADES │   bottom strip, synced to the sped-up clock
 *   └────────┴────────┴────────┘
 *
 *   GOLD    animated per-bot gold-over-time line graph (matplotlib frames,
 *           one per watcher sample, revealed progressively)
 *   CHAT    rolling window of in-game chat (same renderer as the team grid)
 *   TRADES  rolling trade ledger from extract-market-viz's mined sales
 *           (payer → payee, gp, goods)
 *
 * Data comes from results/market/_data.js — run the extractor first (this
 * script re-runs it automatically if the job is missing from _data.js):
 *   bun scripts/extract-market-viz.ts
 *
 * Usage:
 *   bun scripts/make-market-grid.ts [job-name] [out.mp4]
 *   bun scripts/make-market-grid.ts market-gemini37flash-20260814-004635
 *   (no arg → the local run with the highest total gold that has all feeds)
 *
 * Larger markets (market-*-n12/-n18) get a 6-column grid of smaller panes.
 * Mixed-model runs (bots[].model from agent/bot-models.json) color feeds and
 * graph lines BY MODEL and add the model to each badge.
 *
 * Env overrides:
 *   COLS         feed columns             (default 3 for ≤6 bots, else 6)
 *   PANE_PW      feed pane width          (default 620 for 3 cols, 400 for 6)
 *   CROP         ffmpeg crop for a pane  (default crop=724:478:38:68)
 *   TARGET_SECS  target output length    (default 240 → speed picked from it)
 *   SPEED        force a fixed speedup   (overrides TARGET_SECS)
 *
 * Requires ffmpeg + ffprobe + python3/matplotlib. Fonts: macOS Arial
 * (copied to a space-free temp path so ffmpeg's filtergraph parser doesn't choke).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';

const REPO = join(import.meta.dir, '..');
const CROP = process.env.CROP || 'crop=724:478:38:68'; // game client only (excludes Chrome banner + rs-sdk bottom bar)
const FPS = 24;

const COLOR_POOL = ['0x58a6ff', '0x3fb950', '0xf778ba', '0xd29922', '0xa371f7', '0xff7b72'];

const ff = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit' });
const fmtClock = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.round(s) % 60).padStart(2, '0')}`;
const fmtGp = (n: number) => Math.round(n).toLocaleString('en-US');

// ── Load runs from the extractor's _data.js (regenerate if stale) ──
function loadRuns(): any[] {
  const dataPath = join(REPO, 'results', 'market', '_data.js');
  const read = () => {
    if (!existsSync(dataPath)) return null;
    const src = readFileSync(dataPath, 'utf-8');
    const m = src.match(/window\.MARKET_RUNS\s*=\s*([\s\S]*);\s*$/);
    return m ? JSON.parse(m[1]) : null;
  };
  let runs = read();
  const jobArg = process.argv[2];
  if (!runs || (jobArg && !runs.some((r: any) => r.meta.job === jobArg))) {
    console.log('[data] regenerating results/market/_data.js …');
    execFileSync('bun', [join(REPO, 'scripts', 'extract-market-viz.ts')], { stdio: 'inherit' });
    runs = read();
  }
  if (!runs?.length) { console.error('no market runs in results/market/_data.js'); process.exit(1); }
  return runs;
}

const runs = loadRuns();
const videoPath = (rel: string) => join(REPO, rel.replace(/^\.\.\//, '')); // paths are relative to views/
const run = process.argv[2]
  ? runs.find((r: any) => r.meta.job === process.argv[2])
  : [...runs]
      .filter((r: any) => r.bots.every((b: any) => r.videos[b.name] && existsSync(videoPath(r.videos[b.name]))))
      .sort((a: any, b: any) => b.meta.totalGold - a.meta.totalGold)[0];
if (!run) { console.error(`run not found: ${process.argv[2] ?? '(no local run with all feeds)'}`); process.exit(1); }

const jobName: string = run.meta.job;
const bots: Array<{ name: string; role: string; finalGold: number; model?: string }> = run.bots;
// Mixed-model run → one color per model (18 per-bot colors aren't readable);
// single-model run → one color per bot as before.
const shortModel = (id: string) => id.replace(/^[^/]+\//, '').replace(/^~/, '').replace(/^[^/]+\//, '');
const mixed = bots.some(b => b.model) && new Set(bots.map(b => b.model)).size > 1;
const modelList = mixed ? [...new Set(bots.map(b => b.model!))] : [];
const botColor: Record<string, string> = {};
bots.forEach((b, i) => {
  botColor[b.name] = mixed
    ? COLOR_POOL[modelList.indexOf(b.model!) % COLOR_POOL.length]
    : COLOR_POOL[i % COLOR_POOL.length];
});
const modelOf = (b: { model?: string }) => (b.model ? shortModel(b.model) : '');
const roleOf: Record<string, string> = {};
bots.forEach(b => { roleOf[b.name] = b.role; });

const feeds = bots.map(b => {
  const rel = run.videos[b.name];
  const f = rel ? videoPath(rel) : null;
  return { bot: b.name, file: f && existsSync(f) ? f : null };
});
if (!feeds.some(f => f.file)) { console.error(`no recordings on disk for ${jobName}`); process.exit(1); }
const probeFile = feeds.find(f => f.file)!.file!;

// ── Geometry: 3×2 feed grid + a 3-pane bottom strip (graph | chat | trades) ──
const COLS = Number(process.env.COLS || (feeds.length > 6 ? 6 : 3));
const ROWS = Math.ceil(feeds.length / COLS);
const PW = Number(process.env.PANE_PW || (COLS > 3 ? 400 : 620));
const PH = Math.round(PW / 1.5146 / 2) * 2;   // cropped client ≈ 1.51:1
const W = PW * COLS;
const BH = Math.max(PH, 400);                  // bottom strip height (readable text at small panes)
const H = PH * ROWS + BH;
const PANE_W = Math.floor(W / 3 / 2) * 2;      // graph / chat / trades panes

// ── Timing ──
const duration = Number(execFileSync('ffprobe',
  ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'format=duration',
   '-of', 'default=noprint_wrappers=1:nokey=1', probeFile], { encoding: 'utf-8' }).trim());
const TARGET = Number(process.env.TARGET_SECS || 240);
const SPEED = process.env.SPEED
  ? Number(process.env.SPEED)
  : Math.max(2, Math.min(40, Math.round((duration / TARGET) * 2) / 2));
const OUTDUR = +(duration / SPEED).toFixed(2);
console.log(`[grid] ${jobName}  dur=${fmtClock(duration)}  speed=${SPEED}×  out≈${fmtClock(OUTDUR)}`);

const TMP = `/tmp/market_grid-${process.pid}`;
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

// ffmpeg filtergraph parser breaks on spaces in font paths → copy to temp.
const REG = join(TMP, 'reg.ttf');
const BOLD = join(TMP, 'bold.ttf');
copyFileSync('/System/Library/Fonts/Supplemental/Arial.ttf', REG);
copyFileSync('/System/Library/Fonts/Supplemental/Arial Bold.ttf', BOLD);

// ── Title card ──
const winner = run.meta.winner ?? { bot: '?', role: '?', gold: 0 };
const titleLines: Array<[string, number, string, number]> = [
  [`RuneScape market — ${bots.length} bots, ${mixed ? `${modelList.length} models mixed` : 'one model'}`, 44, 'white', H / 2 - 96],
  [`${mixed ? modelList.map(shortModel).join(' + ') : run.meta.model} · ${bots.map(b => `${b.name}:${b.role}`).join('  ')} · sped up ${SPEED}×`, 22, '0xc2a36b', H / 2 - 30],
  [`Roles earn gp by selling up the chain: miners → smiths → alchemist`, 22, '0x8b949e', H / 2 + 8],
  [`Total ${fmtGp(run.meta.totalGold)}gp · top earner ${winner.bot} (${winner.role}) ${fmtGp(winner.gold)}gp`, 28, '0x7fc88a', H / 2 + 54],
];
const titleFilter = titleLines.map((l, i) => {
  const p = join(TMP, `tt${i}.txt`); writeFileSync(p, l[0]);
  return `drawtext=fontfile=${i === 0 || i === 3 ? BOLD : REG}:textfile=${p}:fontsize=${l[1]}:fontcolor=${l[2]}:x=(w-text_w)/2:y=${l[3]}`;
}).join(',');
ff(['-f', 'lavfi', '-i', `color=c=0x0d1117:s=${W}x${H}:d=2.6`, '-vf', titleFilter,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-an', join(TMP, 'title.mp4')]);

// ── Rolling-text panes (chat + trades) ──────────────────────────────
// Same technique as make-team-grid: pre-render one PNG per visible window
// state, concat into a video track timed to the sped-up clock.
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

/** Timed entries → pane video (rolling window of the most recent WINDOW entries). */
function buildRollingPane(name: string, header: string, items: Array<{ t: number; lines: Line[] }>, WINDOW: number): string {
  const MIN_HOLD = 0.5; // output-secs; finer windows aren't readable
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
  segments[segments.length - 1].dur += 3; // overshoot; the grid pass is clamped to OUTDUR
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

// Chat: one entry per message, colored by sender.
const chatItems = (run.chat as Array<{ t: number; sender: string; text: string }>)
  .filter(c => c.text)
  .map(c => ({
    t: c.t,
    lines: [{ color: botColor[c.sender] ?? 'white', text: `[${fmtClock(c.t)}] ${c.sender}: ${c.text}` }],
  }));
console.log(`[chat] ${chatItems.length} messages`);
const chatMp4 = buildRollingPane('chat', 'CHAT', chatItems, 8);

// Trades: one entry per sale — payer line + goods line, colored by the payee
// (the bot that earned the gp).
const tradeItems = (run.sales as Array<{ t: number; from: string; to: string; gp: number; item: string | null; qty: number | null; unit: number | null; note?: string }>)
  .map(s => {
    const goods = s.item
      ? (s.qty && s.qty > 1 && !/bundle|barter/.test(s.note ?? '') ? `${s.qty}× ${s.item}` : s.item)
      : /gift|advance/.test(s.note ?? '') ? 'gift / advance'
      : 'goods unknown';
    const gp = s.gp > 0 ? `${fmtGp(s.gp)}gp` : 'barter';
    return {
      t: s.t,
      lines: [{ color: botColor[s.to] ?? 'white', text: `[${fmtClock(s.t)}] ${s.from} paid ${s.to} ${gp} — ${goods}` }],
    };
  });
console.log(`[trades] ${tradeItems.length} sales`);
const tradesMp4 = buildRollingPane('trades', 'TRADE LOG', tradeItems, 8);

// ── Gold-over-time line graph (matplotlib frames, one per sample) ──
const samples = run.samples as Array<{ t: number; gold: Record<string, number> }>;
const graphDir = join(TMP, 'graph');
mkdirSync(graphDir, { recursive: true });
const pyCfg = {
  out: graphDir,
  w: PANE_W, h: BH,
  capSecs: run.meta.capSecs,
  bots: bots.map(b => ({ name: b.name, role: b.role, model: modelOf(b), color: '#' + botColor[b.name].slice(2) })),
  samples,
};
writeFileSync(join(TMP, 'graph.json'), JSON.stringify(pyCfg));
writeFileSync(join(TMP, 'graph.py'), `
import json, sys
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.ticker import FuncFormatter

cfg = json.load(open(sys.argv[1]))
BG = '#0d1117'; FG = '#8b949e'
bots = cfg['bots']; samples = cfg['samples']
ts = [s['t'] for s in samples]
series = {b['name']: [s['gold'].get(b['name'], 0) for s in samples] for b in bots}
ymax = max(1, max(max(v) for v in series.values())) * 1.08
xmax = max(cfg['capSecs'], ts[-1] if ts else 1)

fig, ax = plt.subplots(figsize=(cfg['w'] / 100, cfg['h'] / 100), dpi=100)
fig.patch.set_facecolor(BG); ax.set_facecolor(BG)
fig.subplots_adjust(left=0.105, right=0.975, top=0.86, bottom=0.11)
for sp in ax.spines.values(): sp.set_color('#30363d')
ax.tick_params(colors=FG, labelsize=8.5)
ax.set_xlim(0, xmax); ax.set_ylim(0, ymax)
ax.grid(color='#30363d', alpha=0.35, linewidth=0.6)
ax.xaxis.set_major_formatter(FuncFormatter(lambda v, _: '%d:%02d' % (v // 60, v % 60)))
ax.yaxis.set_major_formatter(FuncFormatter(lambda v, _: ('%.1fk' % (v / 1000)).replace('.0k', 'k') if v >= 1000 else '%d' % v))
fig.text(0.02, 0.945, 'GOLD', color=FG, fontsize=13, fontweight='bold', family='Arial')

lines, dots = {}, {}
for b in bots:
    (ln,) = ax.plot([], [], color=b['color'], linewidth=1.8 if len(bots) <= 6 else 1.2,
                    label=('%s %s %s' % (b['name'], b['role'], b['model'])).strip())
    lines[b['name']] = ln
    (dot,) = ax.plot([], [], 'o', color=b['color'], markersize=3.5)
    dots[b['name']] = dot
leg = ax.legend(loc='upper left', fontsize=8 if len(bots) <= 6 else 6.5, ncol=2 if len(bots) <= 6 else 3, frameon=False,
                labelcolor=[b['color'] for b in bots], handlelength=1.2,
                columnspacing=1.0, borderaxespad=0.2)
total_txt = fig.text(0.975, 0.945, '', color='#7fc88a', fontsize=12,
                     fontweight='bold', ha='right', family='Arial')

for i in range(len(samples)):
    for b in bots:
        n = b['name']
        lines[n].set_data(ts[:i + 1], series[n][:i + 1])
        dots[n].set_data([ts[i]], [series[n][i]])
    total = sum(series[b['name']][i] for b in bots)
    total_txt.set_text('total {:,}gp'.format(total))
    fig.savefig('%s/frame_%04d.png' % (cfg['out'], i), facecolor=BG)
print('rendered %d frames' % len(samples))
`);
console.log(`[graph] rendering ${samples.length} frames …`);
execFileSync('python3', [join(TMP, 'graph.py'), join(TMP, 'graph.json')], { stdio: 'inherit' });

// Frame i holds from samples[i].t to samples[i+1].t (output clock).
const gSegs: string[] = ['ffconcat version 1.0'];
if (samples.length && samples[0].t > 0)
  gSegs.push(`file '${graphDir}/frame_0000.png'`, `duration ${(samples[0].t / SPEED).toFixed(3)}`);
samples.forEach((s, i) => {
  const t1 = i + 1 < samples.length ? samples[i + 1].t : Math.max(s.t, OUTDUR * SPEED);
  gSegs.push(`file '${graphDir}/frame_${String(i).padStart(4, '0')}.png'`,
             `duration ${Math.max(0.03, (t1 - s.t) / SPEED + (i === samples.length - 1 ? 3 : 0)).toFixed(3)}`);
});
gSegs.push(`file '${graphDir}/frame_${String(samples.length - 1).padStart(4, '0')}.png'`);
const graphList = join(TMP, 'graphlist.txt');
writeFileSync(graphList, gSegs.join('\n') + '\n');
const graphMp4 = join(TMP, 'graph.mp4');
// matplotlib's px sizing can come out one row short of BH — scale pins it.
ff(['-f', 'concat', '-safe', '0', '-i', graphList, '-vf', `fps=${FPS},scale=${PANE_W}:${BH},format=yuv420p`,
    '-c:v', 'libx264', '-t', String(OUTDUR), '-an', graphMp4]);

// ── Per-pane gold HUD (burned-in ASS subtitles) ────────────────────
// Each feed pane gets a top-right balance readout ("14,151gp", with the
// inv/bank split when banked) that steps with the watcher samples, plus a
// floating ▲/▼ delta pop whenever the balance changes between samples.
// ASS is used because 18 panes × ~760 samples would be ~14k drawtext
// filters; a subtitle track per pane is one filter each.
const assTime = (sec: number) => {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000), m = Math.floor((cs % 360000) / 6000), sc = Math.floor((cs % 6000) / 100), c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(sc).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
};
const HUD_FONT = PW >= 600 ? 22 : 16;
const POP_FONT = PW >= 600 ? 24 : 18;
function writeGoldHudAss(bot: string): string {
  const S = samples as Array<{ t: number; gold: Record<string, number>; bank?: Record<string, number> }>;
  const ev: string[] = [];
  const bal = (i: number) => {
    const g = S[i].gold[bot] ?? 0, bk = S[i].bank?.[bot] ?? 0;
    const split = bk > 0 ? `\\N{\\fs${Math.round(HUD_FONT * 0.6)}\\c&HD9D1C9&}inv ${fmtGp(g - bk)} · bank ${fmtGp(bk)}` : '';
    return `${fmtGp(g)}gp${split}`;
  };
  // Balance: one event per run of equal text (fewer events, no flicker).
  let i = 0;
  let lastPopT = -Infinity, popRow = 0;
  while (i < S.length) {
    let j = i;
    while (j + 1 < S.length && bal(j + 1) === bal(i)) j++;
    const t0 = S[i].t / SPEED, t1 = (j + 1 < S.length ? S[j + 1].t : S[j].t + 5) / SPEED;
    ev.push(`Dialogue: 0,${assTime(t0)},${assTime(Math.max(t1, t0 + 0.05))},Bal,,0,0,0,,${bal(i)}`);
    // Delta pop at the start of this run (skip the very first sample).
    if (i > 0) {
      const d = (S[i].gold[bot] ?? 0) - (S[i - 1].gold[bot] ?? 0);
      if (d !== 0) {
        const col = d > 0 ? '&H50B93F&' : '&H727BFF&';   // ASS is BGR: green / red
        const txt = `${d > 0 ? '▲ +' : '▼ −'}${fmtGp(Math.abs(d))}gp`;
        // Stack pops that overlap in time (a −250 then +750 within a
        // second) on separate rows instead of drawing over each other.
        popRow = t0 - lastPopT < 1.6 ? (popRow + 1) % 3 : 0;
        lastPopT = t0;
        const y0 = 14 + HUD_FONT * 1.9 + popRow * (POP_FONT + 6), y1 = y0 - 22;
        ev.push(`Dialogue: 1,${assTime(t0)},${assTime(t0 + 1.6)},Pop,,0,0,0,,{\\c${col}\\move(${PW - 12},${y0},${PW - 12},${y1})\\fad(80,500)}${txt}`);
      }
    }
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
Style: Pop,Arial,${POP_FONT},&H50B93F&,&H50B93F&,&HD0110D0D&,&HD0110D0D&,-1,0,0,0,100,100,0,0,3,4,0,9,0,12,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${ev.join('\n')}
`;
  const f = join(TMP, `hud_${bot}.ass`);
  writeFileSync(f, ass);
  return f;
}
const hudAss: Record<string, string> = {};
feeds.forEach(f => { if (f.file) hudAss[f.bot] = writeGoldHudAss(f.bot); });
console.log(`[hud] gold overlays for ${Object.keys(hudAss).length} panes`);

// ── One-pass grid: 6 feed panes + graph/chat/trades strip ──
const inputs: string[] = [];
feeds.forEach(f => {
  if (f.file) inputs.push('-i', f.file);
  else inputs.push('-f', 'lavfi', '-i', `color=c=0x161b22:s=${PW}x${PH}:r=${FPS}:d=${OUTDUR}`);
});
inputs.push('-i', graphMp4, '-i', chatMp4, '-i', tradesMp4);

const paneFilters = feeds.map((f, idx) => {
  const lf = join(TMP, `label${idx}.txt`);
  const bm = bots.find(b => b.name === f.bot);
  writeFileSync(lf, `${f.bot} · ${roleOf[f.bot]}${mixed && bm ? ` · ${modelOf(bm)}` : ''}`);
  const badge = `drawtext=fontfile=${BOLD}:textfile=${lf}:fontsize=${PW >= 600 ? 20 : 15}:fontcolor=white:` +
    `box=1:boxcolor=${(botColor[f.bot] ?? '0x30363d')}@0.85:boxborderw=8:x=12:y=12`;
  if (f.file) {
    // setpts+fps first so scale/drawtext only run on the ~1/SPEED frames we keep
    const hud = hudAss[f.bot] ? `subtitles=${hudAss[f.bot]}:fontsdir=${TMP},` : '';
    return `[${idx}:v]setpts=PTS/${SPEED},fps=${FPS},${CROP},scale=${PW}:${PH}:flags=lanczos,${badge},${hud}` +
           `format=yuv420p,setsar=1[p${idx}]`;
  }
  const nf = join(TMP, `nofeed${idx}.txt`); writeFileSync(nf, 'no feed');
  return `[${idx}:v]${badge},drawtext=fontfile=${REG}:textfile=${nf}:fontsize=26:fontcolor=0x6e7681:` +
         `x=(w-text_w)/2:y=(h-text_h)/2,format=yuv420p,setsar=1[p${idx}]`;
});
const nb = feeds.length;
const stripFilters = [0, 1, 2].map(i =>
  `[${nb + i}:v]tpad=stop_mode=clone:stop_duration=5,scale=${PANE_W}:${BH},format=yuv420p,setsar=1[p${nb + i}]`);
// Bottom strip panes sit at absolute offsets under the feed grid; if 3×PANE_W
// falls short of W (rounding), the trades pane is right-aligned and xstack's
// fill color covers the 0–2px seam.
const layout = [
  ...feeds.map((_, i) => `${(i % COLS) * PW}_${Math.floor(i / COLS) * PH}`),
  `0_${ROWS * PH}`, `${PANE_W}_${ROWS * PH}`, `${W - PANE_W}_${ROWS * PH}`,
].join('|');
const SLOTS = nb + 3;
const stack = Array.from({ length: SLOTS }, (_, i) => `[p${i}]`).join('') +
  `xstack=inputs=${SLOTS}:layout=${layout}:fill=0x0d1117[grid]`;
const filterComplex = [...paneFilters, ...stripFilters, stack].join(';');

ff([...inputs, '-t', String(OUTDUR), '-filter_complex', filterComplex, '-map', '[grid]',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-an', join(TMP, 'grid.mp4')]);

// ── Concat title + grid ──
const listFile = join(TMP, 'list.txt');
writeFileSync(listFile, [join(TMP, 'title.mp4'), join(TMP, 'grid.mp4')].map(f => `file '${f}'`).join('\n') + '\n');
const out = process.argv[3] || join(REPO, 'results', 'market', `${jobName}-grid.mp4`);
mkdirSync(join(REPO, 'results', 'market'), { recursive: true });
ff(['-f', 'concat', '-safe', '0', '-i', listFile,
    '-c', 'copy', '-movflags', '+faststart', out]);
rmSync(TMP, { recursive: true, force: true });
console.log(`\nWrote ${out}`);
