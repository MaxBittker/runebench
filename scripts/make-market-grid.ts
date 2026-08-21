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
 *   ├──────┬──────┬──────┬──────┤
 *   │ GOLD │ CAP  │PRICES│ CHAT │   bottom strip, synced to the sped-up clock
 *   └──────┴──────┴──────┴──────┘
 *
 *   GOLD    animated per-bot gold-over-time line graph (matplotlib frames,
 *           one per watcher sample, revealed progressively), colored by ROLE
 *   CAP     animated item market-cap graph: qty held across all bots' inv+bank
 *           × rolling-average trade price (top goods; flat starting stock like
 *           nature runes is filtered out so mined/smithed goods stay readable)
 *   PRICES  best-effort rolling-average unit price per traded item (log y,
 *           qty-weighted mean of the last 5 single-item sales, outliers trimmed)
 *   CHAT    rolling window of in-game chat (same renderer as the team grid)
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
 * Feeds, graph lines, and chat are colored BY ROLE (miner/smith/alchemist);
 * mixed-model runs (bots[].model from agent/bot-models.json) add the model
 * name to each badge.
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
// Everything is colored by role: miners blue, smiths orange, alchemists green
// (they turn goods into gp — matches the total-gold green).
const ROLE_COLORS: Record<string, string> = { miner: '0x58a6ff', smith: '0xd29922', alchemist: '0x3fb950', alch: '0x3fb950' };
// Item-volume graph lines (up to ITEM_MAX distinct goods).
const ITEM_COLORS = ['0x58a6ff', '0xf778ba', '0x3fb950', '0xd29922', '0xa371f7', '0xff7b72', '0x39d2c0', '0xe3b341'];
const ITEM_MAX = ITEM_COLORS.length;

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
  const stale = (rs: any[] | null) =>
    !rs ||
    (jobArg && !rs.some((r: any) => r.meta.job === jobArg)) ||
    // itemSeries was added for the ITEMS pane — old _data.js lacks it
    rs.every((r: any) => !r.itemSeries);
  if (stale(runs)) {
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
// Color everything by ROLE — the market story is miners → smiths → alchemist,
// and role colors stay readable at any team size (models are in the badges).
const shortModel = (id: string) => id.replace(/^[^/]+\//, '').replace(/^~/, '').replace(/^[^/]+\//, '');
const mixed = bots.some(b => b.model) && new Set(bots.map(b => b.model)).size > 1;
const modelList = mixed ? [...new Set(bots.map(b => b.model!))] : [];
const botColor: Record<string, string> = {};
bots.forEach((b, i) => {
  botColor[b.name] = ROLE_COLORS[b.role] ?? COLOR_POOL[i % COLOR_POOL.length];
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

// ── Geometry: feed grid + a 4-pane bottom strip (gold | market cap | prices | chat) ──
const COLS = Number(process.env.COLS || (feeds.length > 6 ? 6 : 3));
const ROWS = Math.ceil(feeds.length / COLS);
const PW = Number(process.env.PANE_PW || (COLS > 3 ? 400 : 620));
const PH = Math.round(PW / 1.5146 / 2) * 2;   // cropped client ≈ 1.51:1
const W = PW * COLS;
const BH = Math.max(PH, 400);                  // bottom strip height (readable text at small panes)
const H = PH * ROWS + BH;
const PANE_W = Math.floor(W / 4 / 2) * 2;      // gold / market cap / prices / chat panes

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

// ── Rolling-text pane (chat) ─────────────────────────────────────────
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

// ── Rolling price estimates from the mined sales ─────────────────────
// Best-effort unit price per item at each watcher sample: qty-weighted mean
// of the last PRICE_WINDOW single-item sales, after dropping entries more
// than 3× away from the window median (agents mislabel baskets now and then —
// a "1540gp nature rune" would otherwise dominate the market cap).
const samples = run.samples as Array<{ t: number; gold: Record<string, number> }>;
const PRICE_WINDOW = 5;
type Sale = { t: number; from: string; to: string; gp: number; item: string | null; qty: number | null; unit: number | null; note?: string };
const pricedSales = (run.sales as Sale[])
  .filter(s => s.item && s.qty && s.unit != null && s.unit > 0 && !/bundle|barter|mixed/.test(s.note ?? ''))
  .sort((a, b) => a.t - b.t);
const salesByItem: Record<string, Sale[]> = {};
for (const s of pricedSales) (salesByItem[s.item!] ??= []).push(s);
function estimate(window: Sale[]): number {
  let w = window;
  if (w.length >= 3) {
    const med = [...w].map(s => s.unit!).sort((a, b) => a - b)[Math.floor(w.length / 2)];
    const kept = w.filter(s => s.unit! <= med * 3 && s.unit! >= med / 3);
    if (kept.length) w = kept;
  }
  const q = w.reduce((n, s) => n + s.qty!, 0);
  return w.reduce((n, s) => n + s.unit! * s.qty!, 0) / q;
}
/** price[i] = estimate as of samples[i].t (null before the item's first sale); fill = backfilled with the first estimate */
function priceSeries(item: string): { price: Array<number | null>; fill: number[] } {
  const sales = salesByItem[item] ?? [];
  const price: Array<number | null> = []; let k = 0; let cur: number | null = null;
  for (const s of samples) {
    while (k < sales.length && sales[k].t <= s.t) { k++; cur = estimate(sales.slice(Math.max(0, k - PRICE_WINDOW), k)); }
    price.push(cur);
  }
  const first = price.find(p => p != null) ?? 0;
  return { price, fill: price.map(p => p ?? first) };
}
const priceByItem: Record<string, ReturnType<typeof priceSeries>> = {};
for (const item of Object.keys(salesByItem)) priceByItem[item] = priceSeries(item);
console.log(`[prices] ${pricedSales.length} priced sales across ${Object.keys(salesByItem).length} items`);

// ── Gold-over-time line graph (matplotlib frames, one per sample) ──
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
    (ln,) = ax.plot([], [], color=b['color'], linewidth=1.8 if len(bots) <= 6 else 1.2)
    lines[b['name']] = ln
    (dot,) = ax.plot([], [], 'o', color=b['color'], markersize=3.5)
    dots[b['name']] = dot
# Lines are colored by role, so the legend is one entry per role, not per bot.
from matplotlib.lines import Line2D
roles = []
for b in bots:
    if not any(r[0] == b['role'] for r in roles): roles.append((b['role'], b['color']))
leg = ax.legend([Line2D([0], [0], color=c, lw=2.2) for _, c in roles],
                ['%ss' % r if not r.endswith('s') else r for r, _ in roles],
                loc='upper left', fontsize=10, ncol=len(roles), frameon=False,
                labelcolor=[c for _, c in roles], handlelength=1.2,
                columnspacing=1.2, borderaxespad=0.2)
for t in leg.get_texts(): t.set_fontweight('bold')
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
  // matplotlib's px sizing can come out one row short of BH — scale pins it.
  ff(['-f', 'concat', '-safe', '0', '-i', list, '-vf', `fps=${FPS},scale=${PANE_W}:${BH},format=yuv420p`,
      '-c:v', 'libx264', '-t', String(OUTDUR), '-an', mp4]);
  return mp4;
}
const graphMp4 = framesToMp4(graphDir, 'graph');

// ── Multi-series line graph renderer (MARKET CAP + PRICES panes) ──
// Same frame timing as GOLD; `step` draws hold-last-value lines (prices only
// move at sales), `log` puts y on a log axis (ore vs platebody spans 100×).
const multiPy = `
import json, sys, math
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.ticker import FuncFormatter, LogLocator, NullFormatter

cfg = json.load(open(sys.argv[1]))
BG = '#0d1117'; FG = '#8b949e'
series = cfg['series']; ts = cfg['ts']
vals_all = [v for s in series for v in s['vals'] if v is not None]
ymax = max(1, max(vals_all) if vals_all else 1) * 1.08
xmax = max(cfg['capSecs'], ts[-1] if ts else 1)
fmt = lambda v, _: ('%.1fk' % (v / 1000)).replace('.0k', 'k') if v >= 1000 else ('%d' % v if v >= 10 else '%g' % v)

fig, ax = plt.subplots(figsize=(cfg['w'] / 100, cfg['h'] / 100), dpi=100)
fig.patch.set_facecolor(BG); ax.set_facecolor(BG)
fig.subplots_adjust(left=0.105, right=0.975, top=0.86, bottom=0.11)
for sp in ax.spines.values(): sp.set_color('#30363d')
ax.tick_params(colors=FG, labelsize=8.5)
ax.set_xlim(0, xmax)
if cfg.get('log'):
    ymin = max(1, min(vals_all) if vals_all else 1) / 1.5
    ax.set_yscale('log'); ax.set_ylim(ymin, ymax * 1.3)
    ax.yaxis.set_major_locator(LogLocator(base=10, subs=(1.0, 2.0, 5.0)))
    ax.yaxis.set_minor_formatter(NullFormatter())
else:
    ax.set_ylim(0, ymax)
ax.grid(color='#30363d', alpha=0.35, linewidth=0.6)
ax.xaxis.set_major_formatter(FuncFormatter(lambda v, _: '%d:%02d' % (v // 60, v % 60)))
ax.yaxis.set_major_formatter(FuncFormatter(fmt))
fig.text(0.02, 0.945, cfg['title'], color=FG, fontsize=13, fontweight='bold', family='Arial')
fig.text(0.975, 0.945, cfg['subtitle'], color=FG, fontsize=9, ha='right', family='Arial')

lines, dots = [], []
for s in series:
    (ln,) = ax.plot([], [], color=s['color'], linewidth=1.6, label=s['name'],
                    drawstyle='steps-post' if cfg.get('step') else 'default')
    lines.append(ln)
    (dot,) = ax.plot([], [], 'o', color=s['color'], markersize=3.5)
    dots.append(dot)
leg = ax.legend(loc='upper left', fontsize=8.5, ncol=2, frameon=False,
                labelcolor=[s['color'] for s in series], handlelength=1.2,
                columnspacing=1.0, borderaxespad=0.2)
nan = float('nan')
for i in range(len(ts)):
    for k, s in enumerate(series):
        ys = [nan if v is None else v for v in s['vals'][:i + 1]]
        lines[k].set_data(ts[:i + 1], ys)
        dots[k].set_data([ts[i]], [ys[-1]])
    fig.savefig('%s/frame_%04d.png' % (cfg['out'], i), facecolor=BG)
print('rendered %d frames' % len(ts))
`;
function renderMultiSeries(name: string, cfg: { title: string; subtitle: string; log?: boolean; step?: boolean;
                           series: Array<{ name: string; vals: Array<number | null>; color: string }> }): string {
  const dir = join(TMP, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(TMP, `${name}.json`), JSON.stringify({ out: dir, w: PANE_W, h: BH, capSecs: run.meta.capSecs, ts: samples.map(s => s.t), ...cfg }));
  writeFileSync(join(TMP, `${name}.py`), multiPy);
  console.log(`[${name}] rendering ${samples.length} frames …`);
  execFileSync('python3', [join(TMP, `${name}.py`), join(TMP, `${name}.json`)], { stdio: 'inherit' });
  return framesToMp4(dir, name);
}

// ── Item market-cap graph: qty held (all bots' inv+bank) × rolling price ──
const itemSeries = run.itemSeries as { names: string[]; qty: number[][] } | undefined;
if (!itemSeries) { console.error('no itemSeries in _data.js — re-run scripts/extract-market-viz.ts'); process.exit(1); }
const capCand = itemSeries.names.flatMap((name, j) => {
  const pr = priceByItem[name];
  if (!pr) return [];                                    // never traded for gp → no price → no cap
  const qty = itemSeries.qty.map(row => row[j] ?? 0);
  const vals = qty.map((q, i) => Math.round(q * pr.fill[i]));
  let peak = 0; for (const v of vals) peak = Math.max(peak, v);
  let qtyPeak = 0; for (const q of qty) qtyPeak = Math.max(qtyPeak, q);
  return [{ name, vals, peak, grown: qty[0] < 0.8 * qtyPeak }];
});
// Flat starting stock (nature runes, hammers) would dwarf the goods actually
// mined/smithed during the run — drop items whose QUANTITY is already at ≥80%
// of its peak at t=0 (price moves alone don't count), then keep the biggest caps.
const grown = capCand.filter(c => c.peak >= 1 && c.grown);
const pickedCaps = (grown.length >= 2 ? grown : capCand)
  .sort((a, b) => b.peak - a.peak).slice(0, ITEM_MAX);
console.log(`[items] ${pickedCaps.map(c => `${c.name} (peak ${fmtGp(c.peak)}gp)`).join(', ')}`);
const itemsMp4 = renderMultiSeries('items', {
  title: 'ITEM MARKET CAP', subtitle: 'qty held × rolling avg trade price',
  series: pickedCaps.map((c, i) => ({ name: c.name, vals: c.vals, color: '#' + ITEM_COLORS[i].slice(2) })),
});

// ── Price graph: rolling-average unit price per traded item (log y) ──
const pickedPrices = Object.keys(salesByItem)
  .sort((a, b) => salesByItem[b].length - salesByItem[a].length || a.localeCompare(b))
  .slice(0, ITEM_MAX);
console.log(`[prices] ${pickedPrices.map(n => `${n} (${salesByItem[n].length} sales)`).join(', ')}`);
const pricesMp4 = renderMultiSeries('prices', {
  title: 'PRICES', subtitle: `gp/unit · rolling avg of last ${PRICE_WINDOW} sales`, log: true, step: true,
  series: pickedPrices.map((n, i) => ({
    name: n, color: '#' + ITEM_COLORS[i].slice(2),
    vals: priceByItem[n].price.map(p => (p == null ? null : Math.round(p * 100) / 100)),
  })),
});

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

// ── One-pass grid: feed panes + gold/market-cap/prices/chat strip ──
const inputs: string[] = [];
feeds.forEach(f => {
  if (f.file) inputs.push('-i', f.file);
  else inputs.push('-f', 'lavfi', '-i', `color=c=0x161b22:s=${PW}x${PH}:r=${FPS}:d=${OUTDUR}`);
});
inputs.push('-i', graphMp4, '-i', itemsMp4, '-i', pricesMp4, '-i', chatMp4);

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
const stripFilters = [0, 1, 2, 3].map(i =>
  `[${nb + i}:v]tpad=stop_mode=clone:stop_duration=5,scale=${PANE_W}:${BH},format=yuv420p,setsar=1[p${nb + i}]`);
// Bottom strip panes sit at absolute offsets under the feed grid; if 4×PANE_W
// falls short of W (rounding), the chat pane is right-aligned and xstack's
// fill color covers the 0–2px seam.
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
const out = process.argv[3] || join(REPO, 'results', 'market', `${jobName}-grid.mp4`);
mkdirSync(join(REPO, 'results', 'market'), { recursive: true });
ff(['-f', 'concat', '-safe', '0', '-i', listFile,
    '-c', 'copy', '-movflags', '+faststart', out]);
rmSync(TMP, { recursive: true, force: true });
console.log(`\nWrote ${out}`);
