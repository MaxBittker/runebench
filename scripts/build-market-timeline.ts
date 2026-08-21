/**
 * Builds a self-contained HTML timeline visualization for one market run:
 * chat + trades + wealth events over time, synchronized around a single
 * time cursor so you can follow what happened.
 *
 *   - wealth chart: per-bot gold lines (colored by model), crosshair + tooltip
 *   - activity lanes: one row per bot grouped by role — chat ticks, trade
 *     connectors (payer → payee), gain/loss carets
 *   - event feed: every PM, trade and gold event in order, filterable by bot
 *     and event type; clicking anywhere sets the cursor and scrolls the feed
 *
 * Reads results/market/_data.js (run `bun scripts/extract-market-viz.ts`
 * first) plus the trial's reward.json for the guild block.
 *
 * Usage: bun scripts/build-market-timeline.ts [job-name-or-prefix]
 *        → results/market/<job>-timeline.html
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

const REPO = join(import.meta.dir, '..');
const OUT_DIR = join(REPO, 'results', 'market');

// ── Load the run ─────────────────────────────────────────────────────
const dataSrc = readFileSync(join(OUT_DIR, '_data.js'), 'utf8');
const runs: any[] = JSON.parse(dataSrc.slice(dataSrc.indexOf('=') + 1).trim().replace(/;$/, ''));
const jobArg = process.argv[2];
const run = jobArg ? runs.find(r => r.meta.job === jobArg || r.meta.job.startsWith(jobArg)) : runs[0];
if (!run) { console.error(`no run matching ${jobArg} in _data.js`); process.exit(1); }
const { meta } = run;

// guild block (collective runs) lives in the trial's reward.json, not _data.js
let guild: { leader: string; members: string[]; guildGold: number } | null = null;
const rewardPath = join(REPO, 'jobs', meta.job, meta.trial, 'verifier', 'reward.json');
if (existsSync(rewardPath)) {
  try { guild = JSON.parse(readFileSync(rewardPath, 'utf8')).guild ?? null; } catch { /* keep null */ }
}

// ── Slim the payload ─────────────────────────────────────────────────
const bots: Array<{ name: string; role: string; model: string; finalGold: number }> =
  run.bots.map((b: any) => ({ name: b.name, role: b.role, model: b.model ?? 'unknown', finalGold: b.finalGold }));

// fixed model → categorical-slot order: bot count desc, then name (leader's
// solo model naturally lands last); color follows the model, never rank
const modelCount: Record<string, number> = {};
for (const b of bots) modelCount[b.model] = (modelCount[b.model] ?? 0) + 1;
const models = Object.keys(modelCount).sort((a, b2) => modelCount[b2] - modelCount[a] || a.localeCompare(b2));
const shortModel = (m: string) =>
  m.split('/').pop()!.replace('-latest', '').replace('deepseek-v4-flash', 'deepseek-flash').replace('claude-', '');

const T: number[] = run.samples.map((s: any) => s.t);
const gold: Record<string, number[]> = {};
for (const b of bots) gold[b.name] = run.samples.map((s: any) => s.gold[b.name] ?? 0);

const norm = (s: string) => (s ?? '').toLowerCase().replace(/ /g, '_');
const chat = run.chat.map((c: any) => ({ t: c.t, s: norm(c.sender), to: c.to ? norm(c.to) : null, x: c.text }));
const sales = run.sales.map((s: any) => ({
  t: s.t, from: s.from, to: s.to, gp: s.gp, item: s.item, qty: s.qty, unit: s.unit, note: s.note ?? null,
}));
const goldEvents = run.events
  .filter((e: any) => e.type === 'gain' || e.type === 'loss')
  .map((e: any) => ({ t: e.t, bot: e.bot, d: e.type === 'gain' ? e.amount : -e.amount, after: e.after }));

const payload = {
  meta: {
    job: meta.job, totalGold: meta.totalGold, winner: meta.winner, capSecs: meta.capSecs,
    launchedAt: meta.launchedAt,
  },
  guild, bots, models: models.map(m => ({ id: m, label: shortModel(m), n: modelCount[m] })),
  T, gold, chat, sales, goldEvents,
};

// ── HTML ─────────────────────────────────────────────────────────────
const DATA_JSON = JSON.stringify(payload).replace(/</g, '\\u003c');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Market timeline — ${meta.job}</title>
<style>
.viz-root {
  color-scheme: light;
  --surface-1: #fcfcfb; --page: #f9f9f7;
  --ink-1: #0b0b0b; --ink-2: #52514e; --ink-3: #898781;
  --grid: #e1e0d9; --axis: #c3c2b7; --border: rgba(11,11,11,0.10);
  --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a; --s4: #eda100; --s5: #e87ba4;
}
:root[data-theme="dark"] .viz-root,
:root:not([data-theme="light"]) .viz-root.os-dark {
  color-scheme: dark;
  --surface-1: #1a1a19; --page: #0d0d0d;
  --ink-1: #ffffff; --ink-2: #c3c2b7; --ink-3: #898781;
  --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10);
  --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500; --s5: #d55181;
}
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
.viz-root { background: var(--page); color: var(--ink-1); min-height: 100vh; padding: 20px 24px 40px; }
h1 { font-size: 18px; margin: 0 0 2px; font-weight: 650; }
.sub { color: var(--ink-3); font-size: 12px; margin-bottom: 14px; }
.card { background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
.tiles { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
.tile { background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px; padding: 10px 16px; min-width: 130px; }
.tile .k { font-size: 11px; color: var(--ink-3); }
.tile .v { font-size: 22px; font-weight: 600; }
.tile .s { font-size: 11px; color: var(--ink-2); }
.bar { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-bottom: 10px; font-size: 12px; color: var(--ink-2); }
.bar label { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; user-select: none; }
.legend { display: flex; gap: 14px; flex-wrap: wrap; align-items: center; }
.lg { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; padding: 2px 6px; border-radius: 6px; }
.lg:hover { background: var(--grid); }
.lg.off { opacity: 0.35; }
.lg .key { width: 16px; height: 0; border-top: 3px solid; border-radius: 2px; }
.btn { background: var(--surface-1); color: var(--ink-2); border: 1px solid var(--border); border-radius: 6px; padding: 3px 10px; cursor: pointer; font: inherit; font-size: 12px; }
.btn:hover { border-color: var(--ink-3); }
.spacer { flex: 1; }
#cursorReadout { font-variant-numeric: tabular-nums; color: var(--ink-2); min-width: 130px; }
.main { display: grid; grid-template-columns: 1fr 400px; gap: 14px; align-items: start; }
@media (max-width: 1100px) { .main { grid-template-columns: 1fr; } }
#chartCard { margin-bottom: 14px; }
#feed { height: 78vh; overflow-y: auto; padding: 0; position: sticky; top: 12px; }
#feed .hd { position: sticky; top: 0; background: var(--surface-1); padding: 10px 14px 8px; font-size: 12px; color: var(--ink-3); border-bottom: 1px solid var(--grid); z-index: 2; }
.ev { padding: 6px 14px; border-bottom: 1px solid var(--grid); cursor: pointer; font-size: 12.5px; }
.ev:hover { background: color-mix(in oklab, var(--grid) 45%, var(--surface-1)); }
.ev .hdr { display: flex; gap: 8px; align-items: baseline; color: var(--ink-2); }
.ev .tt { font-variant-numeric: tabular-nums; color: var(--ink-3); font-size: 11px; min-width: 44px; }
.ev .who { font-weight: 600; color: var(--ink-1); }
.ev .body { color: var(--ink-2); margin-left: 52px; overflow-wrap: anywhere; }
.ev .gp { font-weight: 600; color: var(--ink-1); font-variant-numeric: tabular-nums; }
.ev.cur { box-shadow: inset 3px 0 0 var(--ink-3); background: color-mix(in oklab, var(--grid) 55%, var(--surface-1)); }
.dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; flex: none; }
.tag { font-size: 10px; border: 1px solid var(--border); border-radius: 4px; padding: 0 4px; color: var(--ink-3); }
svg { display: block; }
svg text { font: 11px system-ui, -apple-system, "Segoe UI", sans-serif; fill: var(--ink-3); }
.laneLabel { cursor: pointer; }
.laneLabel:hover text.nm { fill: var(--ink-1); }
text.nm { fill: var(--ink-2); font-weight: 600; }
text.gp { fill: var(--ink-3); font-variant-numeric: tabular-nums; }
text.roleHd { fill: var(--ink-3); font-weight: 650; letter-spacing: 0.08em; font-size: 10px; }
#tooltip { position: fixed; pointer-events: none; background: var(--surface-1); color: var(--ink-1);
  border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; font-size: 12px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.18); max-width: 340px; z-index: 10; display: none; }
#tooltip .v { font-weight: 650; }
#tooltip .m { color: var(--ink-2); }
#tooltip .x { color: var(--ink-2); margin-top: 3px; overflow-wrap: anywhere; }
details.tbl { margin-top: 14px; }
details.tbl summary { cursor: pointer; color: var(--ink-2); font-size: 13px; }
table { border-collapse: collapse; margin-top: 8px; font-size: 12.5px; }
th, td { text-align: left; padding: 4px 12px 4px 0; border-bottom: 1px solid var(--grid); }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
</style>
</head>
<body>
<div class="viz-root" id="root">
  <h1>Market run timeline</h1>
  <div class="sub" id="subTitle"></div>
  <div class="tiles" id="tiles"></div>
  <div class="bar">
    <span class="legend" id="legend"></span>
    <span class="spacer"></span>
    <label><input type="checkbox" id="tChat" checked> chat</label>
    <label><input type="checkbox" id="tTrade" checked> trades</label>
    <label><input type="checkbox" id="tGold" checked> gold events</label>
    <button class="btn" id="clearFilter" style="display:none"></button>
    <span id="cursorReadout"></span>
    <button class="btn" id="themeBtn">dark</button>
  </div>
  <div class="card" id="chartCard"><div id="chart"></div></div>
  <div class="main">
    <div class="card" id="lanesCard"><div id="lanes"></div></div>
    <div class="card" id="feed"><div class="hd" id="feedHd"></div><div id="feedRows"></div></div>
  </div>
  <details class="tbl card"><summary>Final standings table</summary><div id="standings"></div></details>
</div>
<div id="tooltip"></div>
<script>
const DATA = ${DATA_JSON};
(() => {
const root = document.getElementById('root');
if (matchMedia('(prefers-color-scheme: dark)').matches) root.classList.add('os-dark');
const themeBtn = document.getElementById('themeBtn');
const isDark = () => getComputedStyle(root).colorScheme === 'dark';
themeBtn.textContent = isDark() ? 'light' : 'dark';
themeBtn.onclick = () => {
  document.documentElement.dataset.theme = isDark() ? 'light' : 'dark';
  themeBtn.textContent = isDark() ? 'light' : 'dark';
  drawAll();
  buildFeed();   // feed swatches carry resolved colors — restamp for the new mode
};

// ── data prep ────────────────────────────────────────────────────
const { meta, guild, bots, models, T, gold, chat, sales, goldEvents } = DATA;
const SLOTS = ['--s1','--s2','--s3','--s4','--s5'];
const modelSlot = {}; models.forEach((m, i) => modelSlot[m.id] = SLOTS[Math.min(i, SLOTS.length - 1)]);
const byName = {}; bots.forEach(b => byName[b.name] = b);
const colorOf = b => getComputedStyle(root).getPropertyValue(modelSlot[byName[b]?.model] ?? '--s1').trim();
const leader = guild ? guild.leader : null;
const dispName = b => (b === leader ? '\\u265B ' : '') + b;
const fmt = n => (n ?? 0).toLocaleString('en-US');
const mmss = t => String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
const capT = T[T.length - 1] ?? meta.capSecs;

// role groups, fixed order
const ROLE_ORDER = ['miner', 'smith', 'alch'];
const roles = ROLE_ORDER.filter(r => bots.some(b => b.role === r))
  .concat([...new Set(bots.map(b => b.role))].filter(r => !ROLE_ORDER.includes(r)));
const laneBots = []; roles.forEach(r => bots.filter(b => b.role === r).forEach(b => laneBots.push(b.name)));

// unified event list for the feed (chronological)
const events = [];
chat.forEach(c => events.push({ kind: 'chat', t: c.t, a: c.s, b: c.to, text: c.x }));
sales.forEach(s => events.push({ kind: 'trade', t: s.t, a: s.from, b: s.to, gp: s.gp, item: s.item, qty: s.qty, unit: s.unit, note: s.note }));
goldEvents.forEach(g => events.push({ kind: 'gold', t: g.t, a: g.bot, d: g.d, after: g.after }));
events.sort((x, y) => x.t - y.t);

// ── header ───────────────────────────────────────────────────────
document.getElementById('subTitle').textContent =
  meta.job + ' — ' + bots.length + ' bots, ' + Math.round(capT / 60) + ' min, ' +
  chat.length + ' messages, ' + sales.length + ' trades';
const tiles = document.getElementById('tiles');
function tile(k, v, s) {
  const d = document.createElement('div'); d.className = 'tile';
  const e1 = document.createElement('div'); e1.className = 'k'; e1.textContent = k;
  const e2 = document.createElement('div'); e2.className = 'v'; e2.textContent = v;
  d.append(e1, e2);
  if (s) { const e3 = document.createElement('div'); e3.className = 's'; e3.textContent = s; d.append(e3); }
  tiles.append(d);
}
tile('Total gold', fmt(meta.totalGold) + ' gp', 'all ' + bots.length + ' bots');
tile('Richest bot', fmt(meta.winner.gold) + ' gp', meta.winner.bot + ' (' + (byName[meta.winner.bot]?.model.split('/').pop() ?? meta.winner.role) + ')');
if (guild) tile('Guild total', fmt(guild.guildGold) + ' gp', '\\u265B ' + guild.leader + ' + ' + (guild.members.length - 1) + ' smiths');
tile('Trades', fmt(sales.length), fmt(sales.reduce((a, s) => a + s.gp, 0)) + ' gp changed hands');
tile('Messages', fmt(chat.length), 'all private (PM)');

// ── legend (model filter) ────────────────────────────────────────
const modelOff = new Set();
const legend = document.getElementById('legend');
models.forEach(m => {
  const el = document.createElement('span'); el.className = 'lg';
  const key = document.createElement('span'); key.className = 'key';
  key.style.borderTopColor = 'var(' + modelSlot[m.id] + ')';
  const lb = document.createElement('span');
  lb.textContent = m.label + (m.id === byName[leader]?.model ? ' \\u265B' : '') + ' (' + m.n + ')';
  el.append(key, lb);
  el.onclick = () => { modelOff.has(m.id) ? modelOff.delete(m.id) : modelOff.add(m.id);
    el.classList.toggle('off', modelOff.has(m.id)); applyFilter(); };
  legend.append(el);
});

// ── shared state ─────────────────────────────────────────────────
let botFilter = null;      // bot name or null
let cursorT = null;        // seconds or null
const show = { chat: true, trade: true, gold: true };
const tooltip = document.getElementById('tooltip');
function showTip(x, y, rows) {
  tooltip.replaceChildren();
  rows.forEach(([cls, text]) => {
    const d = document.createElement('div'); d.className = cls; d.textContent = text; tooltip.append(d);
  });
  tooltip.style.display = 'block';
  const w = tooltip.offsetWidth, h = tooltip.offsetHeight;
  tooltip.style.left = Math.min(x + 14, innerWidth - w - 10) + 'px';
  tooltip.style.top = Math.min(y + 14, innerHeight - h - 10) + 'px';
}
const hideTip = () => tooltip.style.display = 'none';
const botVisible = b => (!botFilter || involves(b, botFilter)) && !modelOff.has(byName[b]?.model);
const involves = (b, f) => b === f;
const evInvolves = (e, b) => e.a === b || e.b === b;
const evVisible = e => show[e.kind] && (!botFilter || evInvolves(e, botFilter)) &&
  !(modelOff.size && [e.a, e.b].filter(Boolean).every(x => byName[x] && modelOff.has(byName[x].model)));

// ── SVG helpers ──────────────────────────────────────────────────
const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs) => { const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };

// ── wealth chart ─────────────────────────────────────────────────
const chartDiv = document.getElementById('chart');
const CH = 300, ML = 56, MR = 16, MT = 12, MB = 24;
let chartW = 0, xScale = t => 0, yScale = v => 0, chartSvg = null, chartCursor = null, chartHover = null;
const yMax = Math.max(...laneBots.map(b => Math.max(...gold[b]))) * 1.05;

function drawChart() {
  chartDiv.replaceChildren();
  chartW = chartDiv.clientWidth;
  const iw = chartW - ML - MR, ih = CH - MT - MB;
  xScale = t => ML + (t / capT) * iw;
  yScale = v => MT + ih - (v / yMax) * ih;
  const svg = svgEl('svg', { width: chartW, height: CH });
  // gridlines + y ticks (clean steps)
  const step = yMax > 40000 ? 10000 : 5000;
  for (let v = 0; v <= yMax; v += step) {
    svg.append(svgEl('line', { x1: ML, x2: chartW - MR, y1: yScale(v), y2: yScale(v), stroke: 'var(--grid)', 'stroke-width': 1 }));
    const tx = svgEl('text', { x: ML - 8, y: yScale(v) + 3, 'text-anchor': 'end' });
    tx.textContent = v >= 1000 ? (v / 1000) + 'k' : v; svg.append(tx);
  }
  // x ticks every 10 min
  for (let t = 0; t <= capT; t += 600) {
    const tx = svgEl('text', { x: xScale(t), y: CH - 8, 'text-anchor': 'middle' });
    tx.textContent = Math.round(t / 60) + 'm'; svg.append(tx);
  }
  svg.append(svgEl('line', { x1: ML, x2: chartW - MR, y1: yScale(0), y2: yScale(0), stroke: 'var(--axis)', 'stroke-width': 1 }));
  // per-bot lines
  for (const b of laneBots) {
    const pts = T.map((t, i) => xScale(t).toFixed(1) + ',' + yScale(gold[b][i]).toFixed(1)).join(' ');
    const p = svgEl('polyline', { points: pts, fill: 'none', stroke: colorOf(b), 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'data-bot': b });
    p.style.opacity = lineOpacity(b);
    svg.append(p);
  }
  chartCursor = svgEl('line', { y1: MT, y2: MT + ih, stroke: 'var(--ink-3)', 'stroke-width': 1, visibility: 'hidden' });
  chartHover = svgEl('line', { y1: MT, y2: MT + ih, stroke: 'var(--grid)', 'stroke-width': 1, visibility: 'hidden' });
  svg.append(chartHover, chartCursor);
  svg.style.cursor = 'crosshair';
  svg.addEventListener('pointermove', chartMove);
  svg.addEventListener('pointerleave', () => { hideTip(); chartHover.setAttribute('visibility', 'hidden'); emphasizeBot(null); });
  svg.addEventListener('click', ev => { const t = pxToT(ev); setCursor(t, true); });
  chartDiv.append(svg);
  chartSvg = svg;
  updateCursorLines();
}
const lineOpacity = b => botVisible(b) ? (botFilter && b !== botFilter ? 0.12 : 0.9) : 0.06;
function emphasizeBot(b) {
  if (!chartSvg) return;
  chartSvg.querySelectorAll('polyline').forEach(p => {
    const pb = p.dataset.bot;
    p.style.opacity = b ? (pb === b ? 1 : 0.10) : lineOpacity(pb);
    p.setAttribute('stroke-width', b && pb === b ? 3 : 2);
  });
}
function pxToT(ev) {
  const r = chartSvg.getBoundingClientRect();
  return Math.max(0, Math.min(capT, ((ev.clientX - r.left) - ML) / (chartW - ML - MR) * capT));
}
function chartMove(ev) {
  const t = pxToT(ev);
  let si = 0; while (si < T.length - 1 && T[si] < t) si++;
  chartHover.setAttribute('x1', xScale(T[si])); chartHover.setAttribute('x2', xScale(T[si]));
  chartHover.setAttribute('visibility', 'visible');
  // nearest line vertically at this sample
  const r = chartSvg.getBoundingClientRect();
  const my = ev.clientY - r.top;
  let best = null, bd = 28;
  for (const b of laneBots) {
    if (!botVisible(b)) continue;
    const d = Math.abs(yScale(gold[b][si]) - my);
    if (d < bd) { bd = d; best = b; }
  }
  emphasizeBot(best);
  if (best) {
    const rank = laneBots.filter(o => botVisible(o) && gold[o][si] > gold[best][si]).length + 1;
    showTip(ev.clientX, ev.clientY, [
      ['v', dispName(best) + ' — ' + fmt(gold[best][si]) + ' gp'],
      ['m', byName[best].role + ' · ' + (models.find(m => m.id === byName[best].model)?.label ?? '') + ' · rank #' + rank],
      ['m', 'at ' + mmss(T[si])],
    ]);
  } else {
    showTip(ev.clientX, ev.clientY, [['m', mmss(T[si])]]);
  }
}

// ── activity lanes ───────────────────────────────────────────────
const lanesDiv = document.getElementById('lanes');
const ROW = 24, HDR = 22, LLBL = 168, LMR = 14;
let lanesSvg = null, laneY = {}, lanesW = 0, lxScale = t => 0, lanesCursor = null, laneMarks = [];

function drawLanes() {
  lanesDiv.replaceChildren();
  lanesW = lanesDiv.clientWidth;
  laneY = {}; laneMarks = [];
  let y = 6;
  const rows = [];
  for (const role of roles) {
    rows.push({ hdr: role, y }); y += HDR;
    for (const b of laneBots.filter(n => byName[n].role === role)) { laneY[b] = y + ROW / 2; y += ROW; }
  }
  const H = y + 26;
  const iw = lanesW - LLBL - LMR;
  lxScale = t => LLBL + (t / capT) * iw;
  const svg = svgEl('svg', { width: lanesW, height: H });

  // role headers + row chrome
  for (const r of rows) {
    const tx = svgEl('text', { x: 4, y: r.y + 15, class: 'roleHd' });
    tx.textContent = r.hdr.toUpperCase() + 'S'; svg.append(tx);
  }
  for (const b of Object.keys(laneY)) {
    const yy = laneY[b];
    svg.append(svgEl('line', { x1: LLBL, x2: lanesW - LMR, y1: yy, y2: yy, stroke: 'var(--grid)', 'stroke-width': 1 }));
    const g = svgEl('g', { class: 'laneLabel' });
    const dot = svgEl('circle', { cx: 12, cy: yy, r: 4.5, fill: colorOf(b) });
    const nm = svgEl('text', { x: 22, y: yy + 4, class: 'nm' }); nm.textContent = dispName(b);
    const gp = svgEl('text', { x: LLBL - 8, y: yy + 4, 'text-anchor': 'end', class: 'gp' });
    gp.textContent = fmt(byName[b].finalGold);
    const hit = svgEl('rect', { x: 0, y: yy - ROW / 2, width: LLBL, height: ROW, fill: 'transparent' });
    hit.addEventListener('click', () => setBotFilter(botFilter === b ? null : b));
    hit.addEventListener('pointermove', ev => showTip(ev.clientX, ev.clientY, [
      ['v', dispName(b) + ' — final ' + fmt(byName[b].finalGold) + ' gp'],
      ['m', byName[b].role + ' · ' + (models.find(m => m.id === byName[b].model)?.label ?? '')],
      ['m', 'click to ' + (botFilter === b ? 'clear filter' : 'filter to this bot')],
    ]));
    hit.addEventListener('pointerleave', hideTip);
    g.append(dot, nm, gp, hit); svg.append(g);
  }
  // x ticks
  for (let t = 0; t <= capT; t += 600) {
    const tx = svgEl('text', { x: lxScale(t), y: H - 8, 'text-anchor': 'middle' });
    tx.textContent = Math.round(t / 60) + 'm'; svg.append(tx);
  }

  const markLayer = svgEl('g', {});
  svg.append(markLayer);

  // gold events: carets, muted ink
  if (show.gold) for (const g of goldEvents) {
    if (!markVisible(g.bot, null)) continue;
    const x = lxScale(g.t), yy = laneY[g.bot]; if (yy == null) continue;
    const up = g.d > 0, s = 3.6;
    const p = svgEl('path', {
      d: up ? 'M' + (x - s) + ' ' + (yy + s) + ' L' + x + ' ' + (yy - s) + ' L' + (x + s) + ' ' + (yy + s) + ' Z'
            : 'M' + (x - s) + ' ' + (yy - s) + ' L' + x + ' ' + (yy + s) + ' L' + (x + s) + ' ' + (yy - s) + ' Z',
      fill: 'var(--ink-3)', opacity: 0.5,
    });
    markLayer.append(p);
    laneMarks.push({ x, y: yy, kind: 'gold', e: g });
  }
  // chat ticks on the sender row, model color
  if (show.chat) for (const c of chat) {
    if (!markVisible(c.s, c.to)) continue;
    const x = lxScale(c.t), yy = laneY[c.s]; if (yy == null) continue;
    markLayer.append(svgEl('line', { x1: x, x2: x, y1: yy - 7, y2: yy + 7, stroke: colorOf(c.s), 'stroke-width': 1.5, opacity: 0.8 }));
    laneMarks.push({ x, y: yy, kind: 'chat', e: c });
  }
  // trades: connector payer → payee, payee dot sized by gp with a surface ring
  if (show.trade) for (const s of sales) {
    if (!markVisible(s.from, s.to)) continue;
    const x = lxScale(s.t), y1 = laneY[s.from], y2 = laneY[s.to];
    if (y1 == null || y2 == null) continue;
    markLayer.append(svgEl('line', { x1: x, x2: x, y1, y2, stroke: 'var(--ink-3)', 'stroke-width': 2, opacity: 0.55 }));
    const r = Math.max(4, Math.min(8, 3 + Math.log10(Math.max(10, s.gp))));
    markLayer.append(svgEl('circle', { cx: x, cy: y1, r: 3.5, fill: 'var(--surface-1)', stroke: colorOf(s.from), 'stroke-width': 2 }));
    markLayer.append(svgEl('circle', { cx: x, cy: y2, r, fill: colorOf(s.to), stroke: 'var(--surface-1)', 'stroke-width': 2 }));
    laneMarks.push({ x, y: y2, kind: 'trade', e: s });
    laneMarks.push({ x, y: y1, kind: 'trade', e: s });
  }

  lanesCursor = svgEl('line', { y1: 4, y2: H - 20, stroke: 'var(--ink-3)', 'stroke-width': 1, visibility: 'hidden' });
  svg.append(lanesCursor);
  svg.addEventListener('pointermove', lanesMove);
  svg.addEventListener('pointerleave', hideTip);
  svg.addEventListener('click', ev => {
    const r = svg.getBoundingClientRect(), mx = ev.clientX - r.left;
    if (mx <= LLBL) return;   // label clicks handled per-row
    const near = nearestMark(ev);
    setCursor(near ? near.e.t : Math.round((mx - LLBL) / (lanesW - LLBL - LMR) * capT), true);
  });
  lanesDiv.append(svg);
  lanesSvg = svg;
  updateCursorLines();
}
const markVisible = (a, b) => {
  if (botFilter && a !== botFilter && b !== botFilter) return false;
  if (modelOff.size) {
    const parts = [a, b].filter(x => x && byName[x]);
    if (parts.length && parts.every(x => modelOff.has(byName[x].model))) return false;
  }
  return true;
};
function nearestMark(ev) {
  const r = lanesSvg.getBoundingClientRect();
  const mx = ev.clientX - r.left, my = ev.clientY - r.top;
  let best = null, bd = 14;
  for (const m of laneMarks) {
    const d = Math.hypot(m.x - mx, m.y - my);
    if (d < bd) { bd = d; best = m; }
  }
  return best;
}
function lanesMove(ev) {
  const m = nearestMark(ev);
  if (!m) { hideTip(); return; }
  if (m.kind === 'chat') {
    showTip(ev.clientX, ev.clientY, [
      ['v', mmss(m.e.t) + '  ' + m.e.s + (m.e.to ? ' \\u2192 ' + m.e.to : '') + (m.e.to ? ' (pm)' : '')],
      ['x', m.e.text],
    ]);
  } else if (m.kind === 'trade') {
    showTip(ev.clientX, ev.clientY, [
      ['v', mmss(m.e.t) + '  ' + m.e.from + ' paid ' + m.e.to + ' ' + fmt(m.e.gp) + ' gp'],
      ['m', tradeGoods(m.e)],
    ]);
  } else {
    showTip(ev.clientX, ev.clientY, [
      ['v', mmss(m.e.t) + '  ' + m.e.a + ' ' + (m.e.d > 0 ? '+' : '\\u2212') + fmt(Math.abs(m.e.d)) + ' gp'],
      ['m', 'balance after: ' + fmt(m.e.after) + ' gp (unpaired \\u2014 shop/alch/drop)'],
    ]);
  }
}
const tradeGoods = s => s.item
  ? 'for ' + s.item + (s.qty && s.qty > 1 ? ' \\u00D7' + s.qty : '') + (s.unit != null && s.qty > 1 ? ' @ ' + s.unit + ' gp ea' : '') + (s.note ? ' \\u2014 ' + s.note : '')
  : (s.note ?? 'goods not observed');

// ── event feed ───────────────────────────────────────────────────
const feedRows = document.getElementById('feedRows');
const feedHd = document.getElementById('feedHd');
const feedEls = [];
function buildFeed() {
  feedRows.replaceChildren(); feedEls.length = 0;
  for (const e of events) {
    const d = document.createElement('div'); d.className = 'ev'; d.dataset.t = e.t;
    const hdr = document.createElement('div'); hdr.className = 'hdr';
    const tt = document.createElement('span'); tt.className = 'tt'; tt.textContent = mmss(e.t);
    hdr.append(tt);
    if (e.kind === 'chat') {
      hdr.append(swatch(e.a));
      const who = document.createElement('span'); who.className = 'who';
      who.textContent = e.a + (e.b ? ' \\u2192 ' + e.b : ''); hdr.append(who);
      const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = e.b ? 'pm' : 'say'; hdr.append(tag);
      const body = document.createElement('div'); body.className = 'body'; body.textContent = e.text;
      d.append(hdr, body);
    } else if (e.kind === 'trade') {
      hdr.append(swatch(e.a));
      const who = document.createElement('span'); who.className = 'who'; who.textContent = e.a + ' \\u2192 ' + e.b;
      const gp = document.createElement('span'); gp.className = 'gp'; gp.textContent = fmt(e.gp) + ' gp';
      const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = 'trade';
      hdr.append(who, gp, tag);
      const body = document.createElement('div'); body.className = 'body'; body.textContent = tradeGoods(e);
      d.append(hdr, body);
    } else {
      hdr.append(swatch(e.a));
      const who = document.createElement('span'); who.className = 'who'; who.textContent = e.a;
      const gp = document.createElement('span'); gp.className = 'gp';
      gp.textContent = (e.d > 0 ? '+' : '\\u2212') + fmt(Math.abs(e.d)) + ' gp';
      const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = e.d > 0 ? 'gain' : 'spend';
      hdr.append(who, gp, tag);
      d.append(hdr);
    }
    d.onclick = () => setCursor(e.t, false);
    feedRows.append(d);
    feedEls.push({ el: d, e });
  }
  applyFeedFilter();
}
function swatch(b) {
  const s = document.createElement('span'); s.className = 'dot';
  s.style.background = colorOf(b); return s;
}
function applyFeedFilter() {
  let n = 0;
  for (const { el, e } of feedEls) {
    const vis = evVisible(e);
    el.style.display = vis ? '' : 'none';
    if (vis) n++;
  }
  feedHd.textContent = n + ' events' + (botFilter ? ' \\u00B7 ' + botFilter : '') +
    (cursorT != null ? ' \\u00B7 at ' + mmss(cursorT) : '');
}

// ── cursor + filter plumbing ─────────────────────────────────────
function setCursor(t, scrollFeed) {
  cursorT = Math.round(t);
  document.getElementById('cursorReadout').textContent = 'cursor: ' + mmss(cursorT);
  updateCursorLines();
  applyFeedFilter();
  if (scrollFeed) {
    const target = feedEls.find(f => f.e.t >= cursorT && f.el.style.display !== 'none');
    if (target) target.el.scrollIntoView({ block: 'center' });
  }
  feedEls.forEach(f => f.el.classList.toggle('cur', Math.abs(f.e.t - cursorT) <= 5));
}
function updateCursorLines() {
  if (chartCursor) {
    if (cursorT == null) chartCursor.setAttribute('visibility', 'hidden');
    else { chartCursor.setAttribute('x1', xScale(cursorT)); chartCursor.setAttribute('x2', xScale(cursorT)); chartCursor.setAttribute('visibility', 'visible'); }
  }
  if (lanesCursor) {
    if (cursorT == null) lanesCursor.setAttribute('visibility', 'hidden');
    else { lanesCursor.setAttribute('x1', lxScale(cursorT)); lanesCursor.setAttribute('x2', lxScale(cursorT)); lanesCursor.setAttribute('visibility', 'visible'); }
  }
}
const clearBtn = document.getElementById('clearFilter');
function setBotFilter(b) {
  botFilter = b;
  clearBtn.style.display = b ? '' : 'none';
  clearBtn.textContent = b ? 'clear filter: ' + b + ' \\u2715' : '';
  drawLanes(); emphasizeBot(null); applyFilter();
}
clearBtn.onclick = () => setBotFilter(null);
function applyFilter() {
  if (chartSvg) chartSvg.querySelectorAll('polyline').forEach(p => {
    p.style.opacity = lineOpacity(p.dataset.bot); p.setAttribute('stroke-width', 2);
  });
  drawLanes();
  applyFeedFilter();
}
for (const [id, key] of [['tChat', 'chat'], ['tTrade', 'trade'], ['tGold', 'gold']]) {
  document.getElementById(id).addEventListener('change', ev => { show[key] = ev.target.checked; applyFilter(); });
}

// ── standings table ──────────────────────────────────────────────
(function standings() {
  const wrap = document.getElementById('standings');
  const tbl = document.createElement('table');
  const thead = document.createElement('thead'); const hr = document.createElement('tr');
  for (const h of ['#', 'Bot', 'Role', 'Model', 'Final gold']) {
    const th = document.createElement('th'); th.textContent = h;
    if (h === 'Final gold' || h === '#') th.className = 'num'; hr.append(th);
  }
  thead.append(hr); tbl.append(thead);
  const tb = document.createElement('tbody');
  [...bots].sort((a, b) => b.finalGold - a.finalGold).forEach((b, i) => {
    const tr = document.createElement('tr');
    const cells = [String(i + 1), dispName(b.name), b.role,
      models.find(m => m.id === b.model)?.label ?? b.model, fmt(b.finalGold)];
    cells.forEach((c, ci) => {
      const td = document.createElement('td'); td.textContent = c;
      if (ci === 0 || ci === 4) td.className = 'num'; tr.append(td);
    });
    tb.append(tr);
  });
  tbl.append(tb); wrap.append(tbl);
})();

// ── boot ─────────────────────────────────────────────────────────
function drawAll() { drawChart(); drawLanes(); }
drawAll();
buildFeed();
let rsz; addEventListener('resize', () => { clearTimeout(rsz); rsz = setTimeout(drawAll, 150); });
})();
</script>
</body>
</html>
`;

const outFile = join(OUT_DIR, `${meta.job}-timeline.html`);
writeFileSync(outFile, html);
console.log(`wrote ${outFile} (${(html.length / 1024).toFixed(0)} KB) — ${bots.length} bots, ${chat.length} chat, ${sales.length} trades, ${goldEvents.length} gold events`);
