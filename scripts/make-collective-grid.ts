#!/usr/bin/env bun
/**
 * Chat-first composite clip for a (collective) market run — a sibling of
 * make-market-grid.ts with the transcript as the star of the show.
 *
 * Layout:
 *   ┌───────────────────────────┬───────────────────────────┐
 *   │ feed grid (4 cols, live   │                           │
 *   │ bots only — dead/grey     │   CHAT — full-height      │
 *   │ feeds are dropped)        │   transcript, one color   │
 *   │                           │   PER AGENT (cool hues =  │
 *   │                           │   miners, warm = smiths,  │
 *   ├─────────────┬─────────────┤   greens = alchemists)    │
 *   │ GOLD        │ PRICES      │                           │
 *   └─────────────┴─────────────┴───────────────────────────┘
 *
 *   GOLD     per-bot gold over time, colored by role (profession)
 *   PRICES   two series only — Mithril platebody, and one bar's worth of
 *            ore (1 Mithril ore + 4 Coal), best-guess from the trade ledger:
 *            bundle sales ("20× Coal + 5× Mithril ore") are priced per
 *            mithril ore, and split payments (a 200gp deposit followed by a
 *            2,880gp "gift" from the same buyer to the same seller) are
 *            folded into the sale they settle. No market-cap pane.
 *
 * Data comes from results/market/_data.js (run scripts/extract-market-viz.ts
 * first; this script re-runs it if the job is missing) plus the job's
 * reward.json for the guild leader.
 *
 * Usage:
 *   bun scripts/make-collective-grid.ts <job-name> [out.mp4]
 *
 * Env overrides:
 *   COLS         feed columns             (default 4)
 *   PANE_PW      feed pane width          (default 360)
 *   CROP         ffmpeg crop for a pane  (default crop=724:478:38:68)
 *   TARGET_SECS  target output length    (default 240 → speed picked from it)
 *   SPEED        force a fixed speedup   (overrides TARGET_SECS)
 *
 * Requires ffmpeg + ffprobe + python3 with matplotlib + Pillow.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';

const REPO = join(import.meta.dir, '..');
const CROP = process.env.CROP || 'crop=724:478:38:68'; // game client only (excludes Chrome banner + rs-sdk bottom bar)
const FPS = 24;
const BG = '#0d1117';
const ARIAL = '/System/Library/Fonts/Supplemental/Arial.ttf';
const ARIAL_BOLD = '/System/Library/Fonts/Supplemental/Arial Bold.ttf';

const ff = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit' });
const fmtClock = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.round(s) % 60).padStart(2, '0')}`;
const fmtGp = (n: number) => Math.round(n).toLocaleString('en-US');
const ffColor = (hex: string) => '0x' + hex.slice(1);

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
  : [...runs].filter((r: any) => /collective/.test(r.meta.job)).sort((a: any, b: any) => b.meta.totalGold - a.meta.totalGold)[0];
if (!run) { console.error(`run not found: ${process.argv[2] ?? '(no local collective run)'}`); process.exit(1); }

const jobName: string = run.meta.job;
const bots: Array<{ name: string; role: string; finalGold: number; model?: string }> = run.bots;
const shortModel = (id: string) => id.replace(/^[^/]+\//, '').replace(/^~/, '').replace(/^[^/]+\//, '');
const mixed = bots.some(b => b.model) && new Set(bots.map(b => b.model)).size > 1;
const modelList = mixed ? [...new Set(bots.map(b => b.model!))] : [];
const modelOf = (b: { model?: string }) => (b.model ? shortModel(b.model) : '');
const roleOf: Record<string, string> = {};
bots.forEach(b => { roleOf[b.name] = b.role; });

// Guild leader (collective variants) from the job's reward.json.
let guild: { leader: string; members: string[]; guildGold: number } | null = null;
try {
  const rj = JSON.parse(readFileSync(join(REPO, 'jobs', jobName, run.meta.trial, 'verifier', 'reward.json'), 'utf-8'));
  if (rj.guild?.leader) guild = rj.guild;
} catch { /* not a collective run / no reward.json */ }

// ── Per-agent colors: one hue per bot, arranged so each role owns a hue
// family (miners cool, smiths warm, alchemists green) — the chat stays
// readable per speaker while the gold graph still tells the role story.
const HUE_ARCS: Record<string, [number, number]> = { miner: [190, 285], smith: [350, 60], alchemist: [78, 165], alch: [78, 165] };
function hsl(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return '#' + [r, g, b].map(v => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('');
}
const botColor: Record<string, string> = {};
const roleColor: Record<string, string> = {};
for (const role of [...new Set(bots.map(b => b.role))]) {
  const members = bots.filter(b => b.role === role);
  const [h0, h1] = HUE_ARCS[role] ?? [0, 300];
  const span = ((h1 - h0) % 360 + 360) % 360;
  members.forEach((b, i) => {
    const h = h0 + (members.length > 1 ? (span * i) / (members.length - 1) : span / 2);
    botColor[b.name] = hsl(h, 82, i % 2 ? 74 : 62);
  });
  roleColor[role] = hsl(h0 + span / 2, 82, 66);
}

// ── Feeds: drop bots with no recording or a frozen one (login screen / dead client) ──
function isFrozen(file: string, duration: number): boolean {
  const yavg = (p: number) => {
    const out = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(duration * p), '-i', file, '-frames:v', '1',
      '-vf', `${CROP},signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-`, '-f', 'null', '-'], { encoding: 'utf-8' });
    const m = out.match(/YAVG=([\d.]+)/);
    return m ? Number(m[1]) : null;
  };
  // Same mean luminance (to rounding) at four points = a stuck frame.
  const vals = [0.2, 0.5, 0.8, 0.95].map(yavg);
  return vals.every(v => v != null && Math.abs(v - vals[0]!) < 0.02);
}
const probeDur = (f: string) => Number(execFileSync('ffprobe',
  ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'format=duration',
   '-of', 'default=noprint_wrappers=1:nokey=1', f], { encoding: 'utf-8' }).trim());
const feeds: Array<{ bot: string; file: string; dur: number }> = [];
const dropped: string[] = [];
for (const b of bots) {
  const rel = run.videos[b.name];
  const f = rel ? videoPath(rel) : null;
  if (!f || !existsSync(f)) { dropped.push(`${b.name} (no recording)`); continue; }
  const dur = probeDur(f);
  if (isFrozen(f, dur)) { dropped.push(`${b.name} (frozen feed)`); continue; }
  feeds.push({ bot: b.name, file: f, dur });
}
if (!feeds.length) { console.error(`no live recordings for ${jobName}`); process.exit(1); }
console.log(`[feeds] ${feeds.length} live` + (dropped.length ? `, dropped: ${dropped.join(', ')}` : ''));

// ── Geometry ──
const COLS = Number(process.env.COLS || 4);
const ROWS = Math.ceil(feeds.length / COLS);
const PW = Number(process.env.PANE_PW || 360);
const PH = Math.round(PW / 1.5146 / 2) * 2;   // cropped client ≈ 1.51:1
const LEFT_W = PW * COLS;                      // feed grid + graph strip
const BH = 400;                                // graph strip height
const GRAPH_W = Math.floor(LEFT_W / 2 / 2) * 2;
const H = PH * ROWS + BH;
const CHAT_W = LEFT_W;                         // chat = the right half
const W = LEFT_W + CHAT_W;

// ── Timing ──
const duration = Math.max(...feeds.map(f => f.dur));
const TARGET = Number(process.env.TARGET_SECS || 240);
const SPEED = process.env.SPEED
  ? Number(process.env.SPEED)
  : Math.max(2, Math.min(40, Math.round((duration / TARGET) * 2) / 2));
const OUTDUR = +(duration / SPEED).toFixed(2);
console.log(`[grid] ${jobName}  ${W}x${H}  dur=${fmtClock(duration)}  speed=${SPEED}×  out≈${fmtClock(OUTDUR)}`);

const TMP = `/tmp/collective_grid-${process.pid}`;
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

// ffmpeg filtergraph parser breaks on spaces in font paths → copy to temp.
const REG = join(TMP, 'reg.ttf');
const BOLD = join(TMP, 'bold.ttf');
copyFileSync(ARIAL, REG);
copyFileSync(ARIAL_BOLD, BOLD);

const samples = run.samples as Array<{ t: number; gold: Record<string, number>; bank?: Record<string, number> }>;

// ── PIL text renderer (chat frames) ──────────────────────────────────
// One python process renders every frame from a JSON spec — far faster
// than one ffmpeg drawtext invocation per frame, and it can mix weights /
// colors within a line (bold colored name, pale body).
//
// spec: { w, h, frames: [{ out, blocks: [{ color, head, body, ... }] , header }] }
writeFileSync(join(TMP, 'text.py'), `
import json, sys
from PIL import Image, ImageDraw, ImageFont
spec = json.load(open(sys.argv[1]))
W, H = spec['w'], spec['h']
BG = spec.get('bg', '${BG}')
REG = ImageFont.truetype(${JSON.stringify(ARIAL)}, spec['font'])
BOLDF = ImageFont.truetype(${JSON.stringify(ARIAL_BOLD)}, spec['font'])
HDR = ImageFont.truetype(${JSON.stringify(ARIAL_BOLD)}, spec.get('headerFont', 22))
HDR_REG = ImageFont.truetype(${JSON.stringify(ARIAL)}, spec.get('headerFont', 22))
PAD_X, HEADER_Y, HEADER_BOTTOM, PAD_BOTTOM = spec['padX'], 16, spec.get('headerBottom', 56), 16
LINEH = spec['font'] + 8
BAR_W = 4; BAR_GAP = 10
maxw = W - PAD_X * 2 - BAR_W - BAR_GAP

def wrap(font, text, first_indent):
    # word-wrap by pixel width; the first line has less room (name prefix)
    lines, cur, room = [], '', maxw - first_indent
    for word in text.split():
        cand = word if not cur else cur + ' ' + word
        if font.getlength(cand) <= room or not cur:
            cur = cand
        else:
            lines.append(cur); cur = word; room = maxw
    if cur: lines.append(cur)
    return lines

def segments(block):
    h = block.get('head')
    if not h: return []
    return [(h, block['color'])] if isinstance(h, str) else [(sg['text'], sg['color']) for sg in h]

def layout(block):
    segs = segments(block)
    head_w = sum(BOLDF.getlength(t) for t, _ in segs) + 8 if segs else 0
    return head_w, wrap(REG, block.get('body', ''), head_w)

n = 0
for fr in spec['frames']:
    img = Image.new('RGB', (W, H), BG)
    d = ImageDraw.Draw(img)
    if fr.get('header'):
        d.text((PAD_X, HEADER_Y), fr['header'], font=HDR, fill='#8b949e')
        if fr.get('headerRight'):
            d.text((W - PAD_X, HEADER_Y + 2), fr['headerRight'], font=HDR_REG, fill='#8b949e', anchor='ra')
    blocks = [(b, layout(b)) for b in fr['blocks']]
    maxlines = (H - HEADER_BOTTOM - PAD_BOTTOM) // LINEH
    overflow = None   # bottom-anchored panes: the oldest block runs off the top rather than leaving a gap
    while len(blocks) > 1 and sum(max(1, len(l[1][1])) for l in blocks) > maxlines:
        overflow = blocks.pop(0)
    if overflow and not fr.get('top'): blocks.insert(0, overflow)
    total = sum(max(1, len(l[1][1])) for l in blocks)
    y = HEADER_BOTTOM if fr.get('top') else min(HEADER_BOTTOM, H - PAD_BOTTOM - total * LINEH)
    for b, (head_w, lines) in blocks:
        x0 = PAD_X
        nl = max(1, len(lines))
        if b.get('head'):
            d.rectangle([x0, y + 3, x0 + BAR_W, y + nl * LINEH - 5], fill=b['color'])
            x0 += BAR_W + BAR_GAP
            hx = x0
            for text, color in segments(b):
                d.text((hx, y), text, font=BOLDF, fill=color)
                hx += BOLDF.getlength(text)
        for i, line in enumerate(lines):
            d.text((x0 + (head_w if i == 0 else 0), y + i * LINEH), line, font=b.get('bodyFont') and BOLDF or REG,
                   fill=b.get('bodyColor', '#d0d7de'))
        y += nl * LINEH
    if fr.get('header'):   # re-paint the header strip over any block that ran off the top
        d.rectangle([0, 0, W, HEADER_BOTTOM - 8], fill=BG)
        d.text((PAD_X, HEADER_Y), fr['header'], font=HDR, fill='#8b949e')
        if fr.get('headerRight'):
            d.text((W - PAD_X, HEADER_Y + 2), fr['headerRight'], font=HDR_REG, fill='#8b949e', anchor='ra')
    img.save(fr['out'])
    n += 1
print('rendered %d text frames' % n)
`);
function renderText(name: string, spec: any) {
  const p = join(TMP, `${name}.json`);
  writeFileSync(p, JSON.stringify(spec));
  execFileSync('python3', [join(TMP, 'text.py'), p], { stdio: 'inherit' });
}

// ── Chat column: rolling transcript, one color per agent ─────────────
const CHAT_FONT = 52;
const CHAT_WINDOW = 60;   // entries considered per frame; the renderer trims to what fits
type ChatMsg = { t: number; sender: string; text: string; to?: string };
const chat = (run.chat as ChatMsg[]).filter(c => c.text);
// "sender → receiver" for PMs (each name in its own color), bare sender for public chat.
const chatBlock = (c: ChatMsg) => {
  const to = c.to?.replace(/ /g, '_');
  return {
    color: botColor[c.sender] ?? '#ffffff',
    head: [
      { text: c.sender + (guild && c.sender === guild.leader ? ' [leader]' : ''), color: botColor[c.sender] ?? '#ffffff' },
      ...(to ? [{ text: ' → ', color: '#8b949e' }, { text: to, color: botColor[to] ?? '#ffffff' }] : []),
    ],
    body: c.text,
  };
};
{
  const MIN_HOLD = 0.5; // output-secs between chat frames; finer isn't readable
  const emit: number[] = [];
  let anchor = -Infinity;
  chat.forEach((m, i) => {
    const t0 = m.t / SPEED;
    if (t0 >= OUTDUR) return;
    if (emit.length && t0 - anchor < MIN_HOLD) emit[emit.length - 1] = i;
    else { emit.push(i); anchor = t0; }
  });
  const chatDir = join(TMP, 'chat'); mkdirSync(chatDir);
  const frames: any[] = [];
  const segments: Array<{ png: string; dur: number }> = [];
  const firstT = emit.length ? chat[emit[0]].t / SPEED : OUTDUR;
  const pngOf = (k: number) => join(chatDir, `chat_${String(k).padStart(4, '0')}.png`);
  if (firstT > 0.02 || !emit.length) {
    frames.push({ out: pngOf(frames.length), blocks: [] });
    segments.push({ png: frames[0].out, dur: +(emit.length ? firstT : OUTDUR).toFixed(2) });
  }
  emit.forEach((i, k) => {
    const t0 = chat[i].t / SPEED;
    const t1 = k + 1 < emit.length ? chat[emit[k + 1]].t / SPEED : OUTDUR;
    const out = pngOf(frames.length);
    frames.push({ out, blocks: chat.slice(Math.max(0, i - CHAT_WINDOW + 1), i + 1).map(chatBlock) });
    segments.push({ png: out, dur: +Math.max(0.05, t1 - t0).toFixed(2) });
  });
  console.log(`[chat] ${chat.length} messages → ${frames.length} frames`);
  renderText('chat', { w: CHAT_W, h: H, font: CHAT_FONT, padX: 22, headerBottom: 12, frames });
  segments[segments.length - 1].dur += 3; // overshoot; the grid pass is clamped to OUTDUR
  const list = join(TMP, 'chat.txt');
  writeFileSync(list,
    'ffconcat version 1.0\n' +
    segments.map(s => `file '${s.png}'\nduration ${s.dur}`).join('\n') +
    `\nfile '${segments[segments.length - 1].png}'\n`);
  ff(['-f', 'concat', '-safe', '0', '-i', list, '-vf', `fps=${FPS},format=yuv420p`,
      '-c:v', 'libx264', '-t', String(OUTDUR), '-an', join(TMP, 'chat.mp4')]);
}
const chatMp4 = join(TMP, 'chat.mp4');

// ── Best-guess prices from the trade ledger ──────────────────────────
// A "priced event" = one transfer of the tracked good with the gp that
// settled it. Besides plain sales we fold in:
//   • bundle sales ("20× Coal + 5× Mithril ore") → per mithril ore, when
//     the coal:ore ratio is near the 4:1 a bar needs
//   • split payments: a same-pair gp-only transfer within −60s…+600s of the
//     sale (deposit now, balance after the alch) is added to the sale while
//     the total stays under the item's plausible ceiling
//   • barters (item for nothing) that get paid the same way
type Sale = { t: number; from: string; to: string; gp: number; item: string | null; qty: number | null; unit: number | null; note?: string };
const sales = (run.sales as Sale[]).slice().sort((a, b) => a.t - b.t);
const gifts = sales.filter(s => s.item == null && s.gp > 0);
const giftUsed = new Set<Sale>();
type Priced = { t: number; units: number; gp: number };

/** Parse a basket string ("20× Coal + 5× Mithril ore") into counts by item name. */
function parseBasket(s: string): Record<string, number> | null {
  const out: Record<string, number> = {};
  for (const part of s.split(' + ')) {
    const m = part.match(/^(\d+)× (.+)$/);
    if (!m) return null;
    out[m[2]] = (out[m[2]] ?? 0) + Number(m[1]);
  }
  return out;
}
/** `units(basket)` → how many tracked units the basket holds (0 = not this good). */
function pricedEvents(units: (basket: Record<string, number>) => number, ceilingPerUnit: number): Priced[] {
  const out: Priced[] = [];
  for (const s of sales) {
    if (!s.item) continue;
    let basket: Record<string, number> | null = null;
    let payer = s.from, payee = s.to;
    if (/ ↔ /.test(s.item)) {                           // barter: "A's goods ↔ B's goods"
      const [ga, gb] = s.item.split(' ↔ ');
      if (gb === 'nothing') { basket = parseBasket(ga); payer = s.to; payee = s.from; }
      else if (ga === 'nothing') { basket = parseBasket(gb); }
      else continue;                                      // goods both ways — not priceable
    } else if (s.note?.startsWith('bundle')) basket = parseBasket(s.item);
    else basket = { [s.item]: s.qty ?? 1 };
    if (!basket) continue;
    const n = units(basket);
    if (!n) continue;
    let gp = s.gp;
    const cap = ceilingPerUnit * n;
    for (const g of gifts) {
      if (giftUsed.has(g) || g.from !== payer || g.to !== payee) continue;
      if (g.t < s.t - 60 || g.t > s.t + 600) continue;
      if (gp + g.gp > cap) continue;
      gp += g.gp; giftUsed.add(g);
    }
    if (gp > 0) out.push({ t: s.t, units: n, gp });
  }
  return out;
}
const PLATEBODY = 'Mithril platebody';
const plateEvents = pricedEvents(b => (Object.keys(b).length === 1 && b[PLATEBODY]) ? b[PLATEBODY] : 0, 3600); // high alch = 3,120
const oreEvents = pricedEvents(b => {
  const ore = b['Mithril ore'] ?? 0, coal = b['Coal'] ?? 0;
  if (Object.keys(b).some(k => k !== 'Mithril ore' && k !== 'Coal')) return 0;
  return ore > 0 && coal >= 3 * ore && coal <= 5 * ore ? ore : 0;   // ≈ 4 coal per mithril ore
}, 800);
console.log(`[prices] platebody: ${plateEvents.length} priced events · ore sets: ${oreEvents.length} priced events`);

const PRICE_WINDOW = 5;
function estimate(window: Priced[]): number {
  let w = window;
  if (w.length >= 3) {
    const med = [...w].map(s => s.gp / s.units).sort((a, b) => a - b)[Math.floor(w.length / 2)];
    const kept = w.filter(s => s.gp / s.units <= med * 3 && s.gp / s.units >= med / 3);
    if (kept.length) w = kept;
  }
  const q = w.reduce((n, s) => n + s.units, 0);
  return w.reduce((n, s) => n + s.gp, 0) / q;
}
/** price[i] = rolling estimate as of samples[i].t (null before the first event) */
function priceSeries(events: Priced[]): Array<number | null> {
  const price: Array<number | null> = []; let k = 0; let cur: number | null = null;
  for (const s of samples) {
    while (k < events.length && events[k].t <= s.t) { k++; cur = estimate(events.slice(Math.max(0, k - PRICE_WINDOW), k)); }
    price.push(cur == null ? null : Math.round(cur));
  }
  return price;
}
const plateSeries = priceSeries(plateEvents);
const oreSeries = priceSeries(oreEvents);

// ── Graphs (matplotlib, one frame per watcher sample) ───────────────
const graphDir = join(TMP, 'graph'); mkdirSync(graphDir);
const pricesDir = join(TMP, 'prices'); mkdirSync(pricesDir);
writeFileSync(join(TMP, 'graphs.json'), JSON.stringify({
  goldOut: graphDir, pricesOut: pricesDir, w: GRAPH_W, h: BH, capSecs: run.meta.capSecs,
  bots: bots.map(b => ({ name: b.name, role: b.role, color: roleColor[b.role] })),
  roles: [...new Set(bots.map(b => b.role))].map(r => ({ role: r, color: roleColor[r] })),
  guild: guild ? { leader: guild.leader, members: guild.members } : null,
  samples,
  prices: [
    { name: 'Mithril platebody', color: '#e3b341', vals: plateSeries, events: plateEvents.map(e => [e.t, e.gp / e.units]) },
    { name: '1 Mithril ore + 4 Coal', color: '#58a6ff', vals: oreSeries, events: oreEvents.map(e => [e.t, e.gp / e.units]) },
  ],
}));
writeFileSync(join(TMP, 'graphs.py'), `
import json, sys
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.ticker import FuncFormatter
from matplotlib.lines import Line2D

cfg = json.load(open(sys.argv[1]))
BG = '${BG}'; FG = '#8b949e'
samples = cfg['samples']; ts = [s['t'] for s in samples]
xmax = max(cfg['capSecs'], ts[-1] if ts else 1)
clock = FuncFormatter(lambda v, _: '%d:%02d' % (v // 60, v % 60))
kfmt = FuncFormatter(lambda v, _: ('%.1fk' % (v / 1000)).replace('.0k', 'k') if v >= 1000 else '%d' % v)

def new_fig(title):
    fig, ax = plt.subplots(figsize=(cfg['w'] / 100, cfg['h'] / 100), dpi=100)
    fig.patch.set_facecolor(BG); ax.set_facecolor(BG)
    fig.subplots_adjust(left=0.1, right=0.9, top=0.86, bottom=0.11)
    for sp in ax.spines.values(): sp.set_color('#30363d')
    ax.tick_params(colors=FG, labelsize=12)
    ax.set_xlim(0, xmax)
    ax.grid(color='#30363d', alpha=0.35, linewidth=0.6)
    ax.xaxis.set_major_formatter(clock)
    fig.text(0.02, 0.945, title, color=FG, fontsize=18, fontweight='bold', family='Arial')
    return fig, ax

# ── GOLD: one line per bot, colored by role ──
bots = cfg['bots']
series = {b['name']: [s['gold'].get(b['name'], 0) for s in samples] for b in bots}
fig, ax = new_fig('GOLD')
ax.set_ylim(0, max(1, max(max(v) for v in series.values())) * 1.08)
ax.yaxis.set_major_formatter(kfmt)
lines, dots = {}, {}
for b in bots:
    (ln,) = ax.plot([], [], color=b['color'], linewidth=1.3)
    (dot,) = ax.plot([], [], 'o', color=b['color'], markersize=3)
    lines[b['name']] = ln; dots[b['name']] = dot
leg = ax.legend([Line2D([0], [0], color=r['color'], lw=2.2) for r in cfg['roles']],
                ['%ss' % r['role'] for r in cfg['roles']], loc='upper left', fontsize=13, ncol=len(cfg['roles']),
                frameon=False, labelcolor=[r['color'] for r in cfg['roles']], handlelength=1.2, columnspacing=1.2, borderaxespad=0.2)
for t in leg.get_texts(): t.set_fontweight('bold')
total_txt = fig.text(0.975, 0.945, '', color='#7fc88a', fontsize=15, fontweight='bold', ha='right', family='Arial')
guild_txt = fig.text(0.975, 0.885, '', color='#e3b341', fontsize=13, fontweight='bold', ha='right', family='Arial')
members = set(cfg['guild']['members']) if cfg.get('guild') else set()
for i in range(len(samples)):
    for b in bots:
        n = b['name']
        lines[n].set_data(ts[:i + 1], series[n][:i + 1])
        dots[n].set_data([ts[i]], [series[n][i]])
    total_txt.set_text('market {:,}gp'.format(sum(series[b['name']][i] for b in bots)))
    if members:
        guild_txt.set_text("smiths' guild {:,}gp".format(sum(series[n][i] for n in members if n in series)))
    fig.savefig('%s/frame_%04d.png' % (cfg['goldOut'], i), facecolor=BG)
plt.close(fig)
print('gold: rendered %d frames' % len(samples))

# ── PRICES: platebody on the left axis, one bar's ore on the right axis ──
plate, ore = cfg['prices']
fig, ax = new_fig('PRICES')
ax2 = ax.twinx()
for sp in ax2.spines.values(): sp.set_color('#30363d')
ax2.tick_params(colors=ore['color'], labelsize=12)
ax.tick_params(axis='y', colors=plate['color'])
ax2.grid(False)
def lim(vals, evs):
    vs = [v for v in vals if v is not None] + [e[1] for e in evs]
    return max(1, max(vs) if vs else 1) * 1.15
ax.set_ylim(0, lim(plate['vals'], plate['events'])); ax2.set_ylim(0, lim(ore['vals'], ore['events']))
ax.yaxis.set_major_formatter(kfmt); ax2.yaxis.set_major_formatter(kfmt)
fig.text(0.02, 0.885, 'avg of last 5 trades', color=FG, fontsize=11, family='Arial')
fig.text(0.9, 0.945, plate['name'] + ' (left axis)', color=plate['color'], fontsize=14, fontweight='bold', ha='right', family='Arial')
fig.text(0.9, 0.885, ore['name'] + ' (right axis)', color=ore['color'], fontsize=14, fontweight='bold', ha='right', family='Arial')
nan = float('nan')
(pl,) = ax.plot([], [], color=plate['color'], linewidth=1.8, drawstyle='steps-post')
(ol,) = ax2.plot([], [], color=ore['color'], linewidth=1.8, drawstyle='steps-post')
pe = ax.scatter([], [], s=9, color=plate['color'], alpha=0.45)
oe = ax2.scatter([], [], s=9, color=ore['color'], alpha=0.45)
pd = ax.plot([], [], 'o', color=plate['color'], markersize=4)[0]
od = ax2.plot([], [], 'o', color=ore['color'], markersize=4)[0]
ptxt = ax.annotate('', (0, 0), xytext=(6, 0), textcoords='offset points', color=plate['color'], fontsize=13, fontweight='bold', va='center')
otxt = ax2.annotate('', (0, 0), xytext=(6, 0), textcoords='offset points', color=ore['color'], fontsize=13, fontweight='bold', va='center')
import numpy as np
for i in range(len(ts)):
    for s, ln, dot, sc, txt in ((plate, pl, pd, pe, ptxt), (ore, ol, od, oe, otxt)):
        ys = [nan if v is None else v for v in s['vals'][:i + 1]]
        ln.set_data(ts[:i + 1], ys)
        last = ys[-1]
        if last == last:  # not nan
            dot.set_data([ts[i]], [last]); txt.set_text('{:,}gp'.format(int(last))); txt.xy = (ts[i], last)
        evs = [e for e in s['events'] if e[0] <= ts[i]]
        sc.set_offsets(np.array(evs) if evs else np.empty((0, 2)))
    fig.savefig('%s/frame_%04d.png' % (cfg['pricesOut'], i), facecolor=BG)
print('prices: rendered %d frames' % len(ts))
`);
console.log(`[graphs] rendering ${samples.length} gold + ${samples.length} price frames …`);
execFileSync('python3', [join(TMP, 'graphs.py'), join(TMP, 'graphs.json')], { stdio: 'inherit' });

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
  ff(['-f', 'concat', '-safe', '0', '-i', list, '-vf', `fps=${FPS},scale=${GRAPH_W}:${BH},format=yuv420p`,
      '-c:v', 'libx264', '-t', String(OUTDUR), '-an', mp4]);
  return mp4;
}
const graphMp4 = framesToMp4(graphDir, 'graph');
const pricesMp4 = framesToMp4(pricesDir, 'prices');

// ── Per-pane gold HUD (burned-in ASS subtitles) ────────────────────
// Top-right balance readout that steps with the watcher samples, plus a
// floating ▲/▼ delta pop whenever the balance changes between samples.
const assTime = (sec: number) => {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000), m = Math.floor((cs % 360000) / 6000), sc = Math.floor((cs % 6000) / 100), c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(sc).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
};
const HUD_FONT = 20;
const POP_FONT = 22;
function writeGoldHudAss(bot: string): string {
  const S = samples;
  const ev: string[] = [];
  const bal = (i: number) => {
    const g = S[i].gold[bot] ?? 0, bk = S[i].bank?.[bot] ?? 0;
    const split = bk > 0 ? `\\N{\\fs${Math.round(HUD_FONT * 0.6)}\\c&HD9D1C9&}inv ${fmtGp(g - bk)} · bank ${fmtGp(bk)}` : '';
    return `${fmtGp(g)}gp${split}`;
  };
  let i = 0;
  let lastPopT = -Infinity, popRow = 0;
  while (i < S.length) {
    let j = i;
    while (j + 1 < S.length && bal(j + 1) === bal(i)) j++;
    const t0 = S[i].t / SPEED, t1 = (j + 1 < S.length ? S[j + 1].t : S[j].t + 5) / SPEED;
    ev.push(`Dialogue: 0,${assTime(t0)},${assTime(Math.max(t1, t0 + 0.05))},Bal,,0,0,0,,${bal(i)}`);
    if (i > 0) {
      const d = (S[i].gold[bot] ?? 0) - (S[i - 1].gold[bot] ?? 0);
      if (d !== 0) {
        const col = d > 0 ? '&H50B93F&' : '&H727BFF&';   // ASS is BGR: green / red
        const txt = `${d > 0 ? '▲ +' : '▼ −'}${fmtGp(Math.abs(d))}gp`;
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
feeds.forEach(f => { hudAss[f.bot] = writeGoldHudAss(f.bot); });

// ── One-pass composite: feeds + gold + prices + chat (spare grid slots stay blank) ──
const inputs: string[] = [];
feeds.forEach(f => inputs.push('-i', f.file));
const nb = feeds.length;
let idx = nb;
const goldIdx = idx++, pricesIdx = idx++, chatIdx = idx++;
inputs.push('-i', graphMp4, '-i', pricesMp4, '-i', chatMp4);

const paneFilters = feeds.map((f, i) => {
  const lf = join(TMP, `label${i}.txt`);
  const bm = bots.find(b => b.name === f.bot);
  const leader = guild && f.bot === guild.leader ? ' · LEADER' : '';
  // The bot name already carries its role (anna_miner); keep the badge short enough for a bigger font.
  writeFileSync(lf, `${f.bot}${leader}${mixed && bm ? ` · ${modelOf(bm).replace(/-latest$/, '')}` : ''}`);
  // Badge text: dark on the lighter colors, white on the darker ones.
  const badge = `drawtext=fontfile=${BOLD}:textfile=${lf}:fontsize=18:fontcolor=0x0d1117:` +
    `box=1:boxcolor=${ffColor(botColor[f.bot])}@0.92:boxborderw=6:x=10:y=10`;
  const hud = `subtitles=${hudAss[f.bot]}:fontsdir=${TMP},`;
  // setpts+fps first so scale/drawtext only run on the ~1/SPEED frames we keep;
  // tpad freezes the last frame for feeds that end before the longest one.
  return `[${i}:v]setpts=PTS/${SPEED},fps=${FPS},${CROP},scale=${PW}:${PH}:flags=lanczos,${badge},${hud}` +
         `tpad=stop_mode=clone:stop_duration=${OUTDUR},format=yuv420p,setsar=1[p${i}]`;
});
const extra: string[] = [];
const layout: string[] = feeds.map((_, i) => `${(i % COLS) * PW}_${Math.floor(i / COLS) * PH}`);
extra.push(`[${goldIdx}:v]tpad=stop_mode=clone:stop_duration=5,scale=${GRAPH_W}:${BH},format=yuv420p,setsar=1[p${goldIdx}]`);
extra.push(`[${pricesIdx}:v]tpad=stop_mode=clone:stop_duration=5,scale=${GRAPH_W}:${BH},format=yuv420p,setsar=1[p${pricesIdx}]`);
extra.push(`[${chatIdx}:v]tpad=stop_mode=clone:stop_duration=5,scale=${CHAT_W}:${H},format=yuv420p,setsar=1[p${chatIdx}]`);
layout.push(`0_${ROWS * PH}`, `${LEFT_W - GRAPH_W}_${ROWS * PH}`, `${LEFT_W}_0`);
const SLOTS = idx;
const stack = Array.from({ length: SLOTS }, (_, i) => `[p${i}]`).join('') +
  `xstack=inputs=${SLOTS}:layout=${layout.join('|')}:fill=${ffColor(BG)}[grid]`;
const filterComplex = [...paneFilters, ...extra, stack].join(';');

ff([...inputs, '-t', String(OUTDUR), '-filter_complex', filterComplex, '-map', '[grid]',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-an', join(TMP, 'grid.mp4')]);

const out = process.argv[3] || join(REPO, 'results', 'market', `${jobName}-chatgrid.mp4`);
mkdirSync(join(REPO, 'results', 'market'), { recursive: true });
ff(['-i', join(TMP, 'grid.mp4'), '-c', 'copy', '-movflags', '+faststart', out]);
rmSync(TMP, { recursive: true, force: true });
console.log(`\nWrote ${out}`);
