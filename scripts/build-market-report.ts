#!/usr/bin/env bun
/**
 * Build a self-contained HTML report for ONE market run.
 *
 *   bun scripts/build-market-report.ts <job-name> [--notes <dir>] [--out <file>]
 *
 * Reads results/market/_data.js (run `bun scripts/extract-market-viz.ts`
 * first), the trial's reward.json + per-bot trajectories (cost/steps/tokens),
 * and — optionally — per-bot analyst notes (`<dir>/<bot>.json`, see the
 * schema in the "notes" section below). Writes
 * results/market/<job>-report.html: hero numbers, per-model leaderboard,
 * role×model matrix, gold-over-time (per model + per-bot small multiples),
 * trade-flow matrices, per-bot table with expandable notes, the full chat
 * transcript (public + PMs, filterable), and the grid video if
 * results/market/<job>-grid.mp4 exists.
 *
 * Colors: models are assigned categorical slots in a FIXED order (the order
 * they appear in bot-models.json), palette per the dataviz reference
 * (light mode: blue, orange, aqua, yellow, magenta, green, violet, red).
 */
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { MODEL_PRICING, HARBOR_MODEL_PRICING } from '../shared/pricing';

const REPO = join(import.meta.dir, '..');
const args = process.argv.slice(2);
const jobName = args.find(a => !a.startsWith('--'));
if (!jobName) { console.error('usage: build-market-report.ts <job-name> [--notes <dir>] [--out <file>]'); process.exit(1); }
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const notesDir = opt('--notes');
// Optional hand-written findings (markdown subset: paragraphs, `- ` bullets, **bold**, `code`);
// defaults to <notesDir>/FINDINGS.md when present.
const findingsFile = opt('--findings') || (notesDir && existsSync(join(notesDir, 'FINDINGS.md')) ? join(notesDir, 'FINDINGS.md') : undefined);
const outFile = opt('--out') || join(REPO, 'results', 'market', `${jobName}-report.html`);

// ── Load run ────────────────────────────────────────────────────
const dataSrc = readFileSync(join(REPO, 'results', 'market', '_data.js'), 'utf8');
const w: any = {}; new Function('window', dataSrc)(w);
const run = (w.MARKET_RUNS as any[]).find(r => r.meta.job === jobName);
if (!run) { console.error(`job ${jobName} not in results/market/_data.js — run extract-market-viz.ts`); process.exit(1); }
const jobDir = join(REPO, 'jobs', jobName, run.meta.trial);
const reward = JSON.parse(readFileSync(join(jobDir, 'verifier', 'reward.json'), 'utf8'));
const botModels: Record<string, string> = existsSync(join(jobDir, 'agent', 'bot-models.json'))
  ? JSON.parse(readFileSync(join(jobDir, 'agent', 'bot-models.json'), 'utf8')) : {};
const resultJson = existsSync(join(jobDir, 'result.json')) ? JSON.parse(readFileSync(join(jobDir, 'result.json'), 'utf8')) : null;

type Bot = { name: string; role: string; model: string; finalGold: number; inv: number; bank: number; assets: any;
  steps: number; cost: number; inTok: number; outTok: number; cacheTok: number;
  pub: number; pm: number; sold: number; bought: number; revenue: number; spend: number; notes?: any };

const shortModel = (id: string) => {
  const key = HARBOR_MODEL_PRICING[id];
  if (key) return key;
  return id.split('/').pop()!.replace(/-latest$/, '');
};
const modelOrder: string[] = [];
for (const b of run.bots) { const m = b.model || run.meta.model; if (!modelOrder.includes(m)) modelOrder.push(m); }
const PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
const modelColor: Record<string, string> = {}; modelOrder.forEach((m, i) => modelColor[m] = PALETTE[i % PALETTE.length]);
const ROLE_ORDER = ['miner', 'smith', 'alchemist'];

const bots: Bot[] = run.bots.map((b: any) => {
  const pb = reward.perBot?.[b.name] ?? {};
  let steps = 0, cost = 0, inTok = 0, outTok = 0, cacheTok = 0;
  const tp = join(jobDir, 'agent', `trajectory-${b.name}.json`);
  if (existsSync(tp)) {
    try {
      const fm = JSON.parse(readFileSync(tp, 'utf8')).final_metrics ?? {};
      steps = fm.total_steps ?? 0; inTok = fm.total_prompt_tokens ?? 0; outTok = fm.total_completion_tokens ?? 0; cacheTok = fm.total_cached_tokens ?? 0;
      cost = fm.total_cost_usd ?? 0;
      if (!cost) {
        const pr = MODEL_PRICING[shortModel(b.model)];
        if (pr) cost = (inTok - cacheTok) * pr.input + cacheTok * pr.cachedInput + outTok * pr.output;
      }
    } catch { /* ignore */ }
  }
  let notes: any;
  if (notesDir && existsSync(join(notesDir, `${b.name}.json`))) {
    try { notes = JSON.parse(readFileSync(join(notesDir, `${b.name}.json`), 'utf8')); } catch { /* ignore */ }
  }
  return {
    name: b.name, role: b.role, model: b.model || run.meta.model, finalGold: b.finalGold,
    inv: pb.inventoryGold ?? 0, bank: pb.bankGold ?? 0, assets: pb.assets ?? {},
    steps, cost, inTok, outTok, cacheTok, pub: 0, pm: 0, sold: 0, bought: 0, revenue: 0, spend: 0, notes,
  };
});
const byName: Record<string, Bot> = Object.fromEntries(bots.map(b => [b.name, b]));

// chat counts (reward.chat carries `to` for PMs; _data chat is normalized)
const chat: Array<{ t: number; sender: string; to?: string; text: string }> = (reward.chat ?? []).map((c: any) => ({
  t: Math.round((c.elapsedMs ?? 0) / 1000), sender: String(c.sender ?? '').toLowerCase(), to: c.to ? String(c.to).toLowerCase() : undefined, text: c.text ?? '',
}));
for (const c of chat) { const b = byName[c.sender]; if (!b) continue; if (c.to) b.pm++; else b.pub++; }

// sales: from = payer (buyer), to = payee (seller)
const sales: Array<{ t: number; from: string; to: string; gp: number; item: string | null; qty: number | null; unit: number | null; note?: string }> = run.sales ?? [];
for (const s of sales) {
  const buyer = byName[s.from], seller = byName[s.to];
  if (buyer) { buyer.bought++; buyer.spend += s.gp; }
  if (seller) { seller.sold++; seller.revenue += s.gp; }
}

// ── Aggregates ─────────────────────────────────────────────────
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
const usd = (n: number) => `$${n.toFixed(2)}`;
const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const esc = (s: any) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const models = modelOrder.map(m => {
  const bs = bots.filter(b => b.model === m);
  const golds = bs.map(b => b.finalGold);
  const cost = sum(bs.map(b => b.cost));
  const best = bs.reduce((a, b) => (b.finalGold > a.finalGold ? b : a));
  return {
    id: m, label: shortModel(m), color: modelColor[m], n: bs.length,
    total: sum(golds), mean: sum(golds) / bs.length, median: median(golds), best,
    cost, gpPerUsd: cost ? sum(golds) / cost : 0,
    steps: sum(bs.map(b => b.steps)), pub: sum(bs.map(b => b.pub)), pm: sum(bs.map(b => b.pm)),
    sold: sum(bs.map(b => b.sold)), bought: sum(bs.map(b => b.bought)),
    zeroish: bs.filter(b => b.finalGold <= 200).length,
    byRole: Object.fromEntries(ROLE_ORDER.map(r => { const rb = bs.filter(b => b.role === r); return [r, rb.length ? sum(rb.map(b => b.finalGold)) / rb.length : NaN]; })),
  };
}).sort((a, b) => b.total - a.total);
const totalGold = run.meta.totalGold ?? sum(bots.map(b => b.finalGold));
const totalCost = resultJson?.agent_result?.cost_usd ?? sum(bots.map(b => b.cost));
const winner = bots.reduce((a, b) => (b.finalGold > a.finalGold ? b : a));
const roleTotals = Object.fromEntries(ROLE_ORDER.map(r => [r, sum(bots.filter(b => b.role === r).map(b => b.finalGold))]));
const pmCount = chat.filter(c => c.to).length;
// Task cap from the trial slug (market-60m…); the watcher's capSecs includes boot slack.
const capMin = Number((run.meta.trial.match(/^market-(\d+)m/) ?? [])[1]) || Math.round((run.meta.capSecs ?? 3600) / 60);
const capSecs = capMin * 60;

// model→model gp flow (buyer model → seller model) and role→role
const flowMM: Record<string, Record<string, number>> = {};
const flowRR: Record<string, Record<string, number>> = {};
for (const s of sales) {
  const b = byName[s.from], se = byName[s.to]; if (!b || !se) continue;
  (flowMM[b.model] ??= {})[se.model] = ((flowMM[b.model] ??= {})[se.model] ?? 0) + s.gp;
  (flowRR[b.role] ??= {})[se.role] = ((flowRR[b.role] ??= {})[se.role] ?? 0) + s.gp;
}
// top counterparties
const pairs: Record<string, { a: string; b: string; gp: number; n: number }> = {};
for (const s of sales) {
  const k = [s.from, s.to].sort().join('|');
  (pairs[k] ??= { a: k.split('|')[0], b: k.split('|')[1], gp: 0, n: 0 });
  pairs[k].gp += s.gp; pairs[k].n++;
}
const topPairs = Object.values(pairs).sort((x, y) => y.gp - x.gp).slice(0, 12);

// ── Timeline series ─────────────────────────────────────────────
const samples: Array<{ t: number; gold: Record<string, number>; bank: Record<string, number> }> = run.samples ?? [];
const seriesModel = modelOrder.map(m => ({
  id: m, color: modelColor[m], label: shortModel(m),
  pts: samples.map(s => [s.t, sum(bots.filter(b => b.model === m).map(b => (s.gold[b.name] ?? 0)))] as [number, number]),
}));
const seriesBot = bots.map(b => ({ name: b.name, color: modelColor[b.model], pts: samples.map(s => [s.t, s.gold[b.name] ?? 0] as [number, number]) }));

// ── SVG helpers ─────────────────────────────────────────────────
function lineChart(series: Array<{ label: string; color: string; pts: [number, number][] }>, opts: { w: number; h: number; id: string; yLabel?: string; direct?: boolean }) {
  const { w, h, id } = opts; const pad = { l: 56, r: 190, t: 12, b: 28 };
  const xs = series.flatMap(s => s.pts.map(p => p[0])), ys = series.flatMap(s => s.pts.map(p => p[1]));
  const x0 = 0, x1 = Math.max(capSecs, ...xs), y1 = Math.max(1, ...ys) * 1.05;
  const X = (x: number) => pad.l + (x - x0) / (x1 - x0) * (w - pad.l - pad.r);
  const Y = (y: number) => pad.t + (1 - y / y1) * (h - pad.t - pad.b);
  const yTicks = 4; const yStep = niceStep(y1 / yTicks);
  let g = '';
  for (let v = 0; v <= y1; v += yStep) g += `<line x1="${pad.l}" x2="${w - pad.r}" y1="${Y(v)}" y2="${Y(v)}" class="grid"/><text x="${pad.l - 6}" y="${Y(v) + 4}" class="tick" text-anchor="end">${fmt(v)}</text>`;
  for (let m = 0; m <= x1 / 60; m += 10) g += `<text x="${X(m * 60)}" y="${h - 8}" class="tick" text-anchor="middle">${m}m</text>`;
  const paths = series.map(s => `<path d="${s.pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('')}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round"/>`).join('');
  // direct labels at line end, de-collided
  let labels = '';
  if (opts.direct !== false) {
    const ends = series.map(s => ({ s, y: Y(s.pts[s.pts.length - 1]?.[1] ?? 0) })).sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;
    labels = ends.map(e => `<text x="${w - pad.r + 8}" y="${e.y + 4}" class="dl"><tspan fill="${e.s.color}">●</tspan> ${esc(e.s.label)} ${fmt(e.s.pts[e.s.pts.length - 1]?.[1] ?? 0)}</text>`).join('');
  }
  const data = JSON.stringify(series.map(s => ({ label: s.label, color: s.color, pts: s.pts })));
  return `<div class="chart" data-chart="${id}"><svg viewBox="0 0 ${w} ${h}" width="100%" data-pad="${JSON.stringify([pad.l, pad.r, pad.t, pad.b]).replace(/"/g, '&quot;')}" data-x1="${x1}" data-y1="${y1}">${g}${paths}${labels}<line class="xh" y1="${pad.t}" y2="${h - pad.b}" x1="0" x2="0" style="display:none"/></svg><div class="tip" style="display:none"></div><script type="application/json" class="series">${data}</script></div>`;
}
function niceStep(raw: number) { const p = Math.pow(10, Math.floor(Math.log10(raw))); const f = raw / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; }
function sparkline(pts: [number, number][], color: string, ymax: number, w = 120, h = 28) {
  const x1 = Math.max(capSecs, pts[pts.length - 1]?.[0] ?? 1);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${(p[0] / x1 * w).toFixed(1)},${(h - 2 - p[1] / ymax * (h - 4)).toFixed(1)}`).join('');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><path d="${d}" fill="none" stroke="${color}" stroke-width="1.5"/></svg>`;
}
function hbar(v: number, max: number, color: string) {
  const pct = max ? Math.max(0, v / max * 100) : 0;
  return `<div class="hb"><div class="hbf" style="width:${pct.toFixed(1)}%;background:${color}"></div></div>`;
}
const chip = (m: string) => `<span class="chip"><span class="dot" style="background:${modelColor[m]}"></span>${esc(shortModel(m))}</span>`;
const roleTag = (r: string) => `<span class="role role-${r}">${r}</span>`;

// ── Sections ────────────────────────────────────────────────────
const videoRel = `${jobName}-grid.mp4`;
const hasVideo = existsSync(join(REPO, 'results', 'market', videoRel));
const launched = run.meta.launchedAt?.replace(/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/, '$1-$2-$3 $4:$5:$6');
const perRole = bots.length / 3;

const heroHtml = `
<div class="hero">
  <div class="tile"><div class="k">Total gold</div><div class="v">${fmt(totalGold)} <span class="u">gp</span></div><div class="s">${bots.length} bots · ${perRole} per role</div></div>
  <div class="tile"><div class="k">Winner</div><div class="v">${winner.name.toUpperCase()} <span class="u">${fmt(winner.finalGold)} gp</span></div><div class="s">${winner.role} · ${chip(winner.model)}</div></div>
  <div class="tile"><div class="k">Best model (total)</div><div class="v">${esc(models[0].label)}</div><div class="s">${fmt(models[0].total)} gp over ${models[0].n} bots · ${usd(models[0].cost)}</div></div>
  <div class="tile"><div class="k">LLM spend</div><div class="v">${usd(totalCost)}</div><div class="s">${fmt(totalGold / Math.max(totalCost, 0.01))} gp per $</div></div>
  <div class="tile"><div class="k">Chat</div><div class="v">${fmt(chat.length)}</div><div class="s">${fmt(pmCount)} private (${Math.round(100 * pmCount / Math.max(1, chat.length))}%) · ${fmt(chat.length - pmCount)} public</div></div>
  <div class="tile"><div class="k">Trades</div><div class="v">${fmt(sales.length)}</div><div class="s">${fmt(sum(sales.map(s => s.gp)))} gp changed hands</div></div>
</div>`;

const maxModelTotal = Math.max(...models.map(m => m.total));
const leaderboardHtml = `
<table class="tbl">
<thead><tr><th>#</th><th>Model</th><th>Bots</th><th>Total gp</th><th></th><th>Mean</th><th>Median</th><th>Best bot</th><th>≤200gp</th><th>Cost</th><th>gp / $</th><th>Steps</th><th>Public</th><th>PMs</th><th>Sold</th><th>Bought</th></tr></thead>
<tbody>${models.map((m, i) => `<tr>
  <td>${i + 1}</td><td>${chip(m.id)}</td><td>${m.n}</td><td class="num"><b>${fmt(m.total)}</b></td><td class="barcell">${hbar(m.total, maxModelTotal, m.color)}</td>
  <td class="num">${fmt(m.mean)}</td><td class="num">${fmt(m.median)}</td><td>${m.best.name.toUpperCase()} · ${fmt(m.best.finalGold)}</td><td class="num">${m.zeroish}/${m.n}</td>
  <td class="num">${usd(m.cost)}</td><td class="num">${fmt(m.gpPerUsd)}</td><td class="num">${fmt(m.steps)}</td><td class="num">${fmt(m.pub)}</td><td class="num">${fmt(m.pm)}</td><td class="num">${m.sold}</td><td class="num">${m.bought}</td>
</tr>`).join('')}</tbody></table>`;

const matrixHtml = `
<table class="tbl compact">
<thead><tr><th>Model \\ role (mean gp)</th>${ROLE_ORDER.map(r => `<th>${roleTag(r)}</th>`).join('')}<th>All</th></tr></thead>
<tbody>${models.map(m => `<tr><td>${chip(m.id)}</td>${ROLE_ORDER.map(r => `<td class="num">${isNaN(m.byRole[r]) ? '—' : fmt(m.byRole[r])}</td>`).join('')}<td class="num"><b>${fmt(m.mean)}</b></td></tr>`).join('')}
<tr class="tot"><td>Role total</td>${ROLE_ORDER.map(r => `<td class="num">${fmt(roleTotals[r])}</td>`).join('')}<td class="num">${fmt(totalGold)}</td></tr></tbody></table>`;

const flowHtml = (() => {
  const mm = `<table class="tbl compact"><thead><tr><th>Buyer ↓ / Seller →</th>${modelOrder.map(m => `<th>${chip(m)}</th>`).join('')}</tr></thead><tbody>${
    modelOrder.map(b => `<tr><td>${chip(b)}</td>${modelOrder.map(s => `<td class="num">${flowMM[b]?.[s] ? fmt(flowMM[b][s]) : '·'}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  const rr = `<table class="tbl compact"><thead><tr><th>Buyer ↓ / Seller →</th>${ROLE_ORDER.map(r => `<th>${roleTag(r)}</th>`).join('')}</tr></thead><tbody>${
    ROLE_ORDER.map(b => `<tr><td>${roleTag(b)}</td>${ROLE_ORDER.map(s => `<td class="num">${flowRR[b]?.[s] ? fmt(flowRR[b][s]) : '·'}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  const tp = `<table class="tbl compact"><thead><tr><th>Pair</th><th>Trades</th><th>gp</th></tr></thead><tbody>${topPairs.map(p => `<tr><td>${p.a.toUpperCase()} ${chip(byName[p.a]?.model)} ↔ ${p.b.toUpperCase()} ${chip(byName[p.b]?.model)}</td><td class="num">${p.n}</td><td class="num">${fmt(p.gp)}</td></tr>`).join('')}</tbody></table>`;
  return `<div class="cols3"><div><h4>gp paid, model → model</h4>${mm}</div><div><h4>gp paid, role → role</h4>${rr}</div><div><h4>Busiest counterparties</h4>${tp}</div></div>`;
})();

const ymaxBot = Math.max(1, ...seriesBot.flatMap(s => s.pts.map(p => p[1])));
const smallMultiples = `<div class="sm">${[...bots].sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || b.finalGold - a.finalGold).map(b => {
  const s = seriesBot.find(x => x.name === b.name)!;
  return `<div class="smc"><div class="smh"><b>${b.name.toUpperCase()}</b> ${roleTag(b.role)} <span class="muted">${esc(shortModel(b.model))}</span><span class="smv">${fmt(b.finalGold)}</span></div>${sparkline(s.pts, s.color, ymaxBot, 200, 44)}</div>`;
}).join('')}</div>`;

const assetsStr = (a: any) => {
  const parts: string[] = [];
  for (const k of ['inventory', 'bank']) for (const it of a?.[k] ?? []) parts.push(`${it.count}× ${it.name}`);
  return parts.length ? parts.join(', ') : '—';
};
const botRows = [...bots].sort((a, b) => b.finalGold - a.finalGold).map((b, i) => {
  const s = seriesBot.find(x => x.name === b.name)!;
  const n = b.notes;
  const notesHtml = n ? `<div class="notes">
      <p>${esc(n.summary)}</p>
      ${n.timeline?.length ? `<ul class="tl">${n.timeline.map((t: string) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
      ${n.failure_modes?.length ? `<div class="tags">${n.failure_modes.map((f: string) => `<span class="tag">${esc(f)}</span>`).join('')}</div>` : ''}
      ${n.dm_usage ? `<p class="muted"><b>DMs:</b> ${esc(n.dm_usage)}</p>` : ''}
      ${n.trades?.notes ? `<p class="muted"><b>Trades:</b> ${esc(n.trades.notes)}</p>` : ''}
    </div>` : '';
  return `<tr class="botrow" data-model="${esc(b.model)}" data-role="${b.role}">
    <td>${i + 1}</td><td><b>${b.name.toUpperCase()}</b></td><td>${roleTag(b.role)}</td><td>${chip(b.model)}</td>
    <td class="num"><b>${fmt(b.finalGold)}</b></td><td class="num muted">${fmt(b.inv)} / ${fmt(b.bank)}</td>
    <td>${sparkline(s.pts, s.color, ymaxBot)}</td>
    <td class="num">${b.sold} / ${b.bought}</td><td class="num">${fmt(b.revenue)} / ${fmt(b.spend)}</td>
    <td class="num">${b.pub} / ${b.pm}</td><td class="num">${fmt(b.steps)}</td><td class="num">${usd(b.cost)}</td>
    <td class="assets">${esc(assetsStr(b.assets))}</td>
  </tr>${notesHtml ? `<tr class="noterow" data-model="${esc(b.model)}" data-role="${b.role}"><td></td><td colspan="12">${notesHtml}</td></tr>` : ''}`;
}).join('');
const botTableHtml = `
<div class="filters">
  <span class="muted">Filter:</span>
  <button class="fbtn on" data-f="all">All</button>
  ${modelOrder.map(m => `<button class="fbtn" data-f="model:${esc(m)}"><span class="dot" style="background:${modelColor[m]}"></span>${esc(shortModel(m))}</button>`).join('')}
  ${ROLE_ORDER.map(r => `<button class="fbtn" data-f="role:${r}">${r}s</button>`).join('')}
</div>
<table class="tbl" id="bots">
<thead><tr><th>#</th><th>Bot</th><th>Role</th><th>Model</th><th>Final gp</th><th>inv / bank</th><th>Gold over time</th><th>Sold / bought</th><th>Revenue / spend</th><th>Public / PM</th><th>Steps</th><th>Cost</th><th>Leftover assets</th></tr></thead>
<tbody>${botRows}</tbody></table>`;

const chatHtml = `
<div class="filters">
  <button class="cbtn on" data-c="all">All (${chat.length})</button>
  <button class="cbtn" data-c="pub">Public (${chat.length - pmCount})</button>
  <button class="cbtn" data-c="pm">Private (${pmCount})</button>
  <input id="chatq" placeholder="filter by bot letter or text…"/>
</div>
<div id="chat">${chat.map(c => {
  const b = byName[c.sender];
  return `<div class="msg ${c.to ? 'pm' : 'pub'}" data-s="${c.sender}" data-to="${c.to ?? ''}"><span class="ts">${mmss(c.t)}</span><span class="dot" style="background:${b ? modelColor[b.model] : '#999'}"></span><b>${c.sender.toUpperCase()}</b>${c.to ? `<span class="arrow"> → ${c.to.toUpperCase()}</span>` : ''} <span class="txt">${esc(c.text)}</span></div>`;
}).join('')}</div>`;

const salesHtml = `<details><summary>All ${sales.length} paired trades</summary><table class="tbl compact"><thead><tr><th>t</th><th>Buyer</th><th>Seller</th><th>gp</th><th>Item</th><th>Qty</th><th>Unit</th><th>Note</th></tr></thead><tbody>${
  sales.map(s => `<tr><td>${mmss(s.t)}</td><td>${s.from.toUpperCase()} ${chip(byName[s.from]?.model)}</td><td>${s.to.toUpperCase()} ${chip(byName[s.to]?.model)}</td><td class="num">${fmt(s.gp)}</td><td>${esc(s.item ?? '')}</td><td class="num">${s.qty ?? ''}</td><td class="num">${s.unit ?? ''}</td><td class="muted">${esc(s.note ?? '')}</td></tr>`).join('')}</tbody></table></details>`;

const modelSummaryHtml = models.map(m => {
  const bs = bots.filter(b => b.model === m.id);
  const fm: Record<string, number> = {};
  for (const b of bs) for (const f of b.notes?.failure_modes ?? []) fm[f] = (fm[f] ?? 0) + 1;
  const topFm = Object.entries(fm).sort((a, b) => b[1] - a[1]).slice(0, 8);
  return `<div class="mcard" style="border-top:3px solid ${m.color}">
    <h4>${chip(m.id)} <span class="muted">${fmt(m.total)} gp · ${usd(m.cost)}</span></h4>
    <div class="mrow">${bs.sort((a, b) => b.finalGold - a.finalGold).map(b => `<span class="pill">${b.name.toUpperCase()} <span class="muted">${b.role.slice(0, 5)}</span> ${fmt(b.finalGold)}</span>`).join('')}</div>
    ${topFm.length ? `<div class="tags">${topFm.map(([f, n]) => `<span class="tag">${esc(f)}${n > 1 ? ` ×${n}` : ''}</span>`).join('')}</div>` : ''}
  </div>`;
}).join('');

const mdInline = (t: string) => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>').replace(/\*(.+?)\*/g, '<i>$1</i>');
const findingsHtml = (() => {
  if (!findingsFile) return '';
  const lines = readFileSync(findingsFile, 'utf8').split('\n');
  let out = '', inList = false;
  for (const raw of lines) {
    const l = raw.trimEnd();
    if (/^\s*-\s+/.test(l)) { if (!inList) { out += '<ul class="findings">'; inList = true; } out += `<li>${mdInline(l.replace(/^\s*-\s+/, ''))}</li>`; }
    else { if (inList) { out += '</ul>'; inList = false; } if (l.trim()) out += `<p>${mdInline(l)}</p>`; }
  }
  if (inList) out += '</ul>';
  return `<h2>Key findings</h2>${out}`;
})();

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Market ${esc(run.meta.trial.split('__')[0])} — ${esc(jobName)}</title>
<style>
:root{color-scheme:light;--surface:#fcfcfb;--surface2:#f3f2ee;--text:#0b0b0b;--text2:#52514e;--muted:#8a8984;--line:#e4e2dc;--grid:#ebe9e3}
*{box-sizing:border-box}body{margin:0;background:var(--surface);color:var(--text);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
.wrap{max-width:1380px;margin:0 auto;padding:28px 28px 80px}
h1{font-size:24px;margin:0 0 4px}h2{font-size:18px;margin:36px 0 12px;padding-top:12px;border-top:1px solid var(--line)}h4{margin:8px 0 6px;font-size:13px;color:var(--text2);text-transform:uppercase;letter-spacing:.04em}
.sub{color:var(--text2);margin-bottom:18px}.sub code{background:var(--surface2);padding:1px 5px;border-radius:4px}
.hero{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}
.tile{background:var(--surface2);border-radius:10px;padding:14px 16px}.tile .k{font-size:12px;color:var(--text2);text-transform:uppercase;letter-spacing:.04em}.tile .v{font-size:26px;font-weight:600;margin:2px 0}.tile .u{font-size:14px;font-weight:400;color:var(--text2)}.tile .s{font-size:12px;color:var(--text2)}
.tbl{border-collapse:collapse;width:100%;font-size:13px}.tbl th{font-weight:600;color:var(--text2);text-align:left;padding:8px 8px;border-bottom:2px solid var(--line);white-space:nowrap}.tbl td{padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:middle}.tbl .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.tbl.compact td,.tbl.compact th{padding:5px 8px}.tbl .tot td{font-weight:600;border-top:2px solid var(--line)}
.barcell{width:160px}.hb{background:var(--grid);border-radius:4px;height:10px;width:100%}.hbf{height:10px;border-radius:4px}
.chip{display:inline-flex;align-items:center;gap:5px;font-size:12px;white-space:nowrap}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;flex:none}
.role{font-size:11px;padding:1px 6px;border-radius:4px;background:var(--surface2);color:var(--text2);text-transform:uppercase;letter-spacing:.03em}
.muted{color:var(--muted)}.assets{font-size:12px;color:var(--text2);max-width:280px}
.chart{position:relative;margin:8px 0 4px}.chart svg{display:block;background:var(--surface)}.grid{stroke:var(--grid);stroke-width:1}.tick{font-size:11px;fill:var(--text2)}.dl{font-size:12px;fill:var(--text)}.xh{stroke:#999;stroke-dasharray:3 3}
.tip{position:absolute;background:#fff;border:1px solid var(--line);border-radius:6px;padding:6px 8px;font-size:12px;pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.08);white-space:nowrap}
.sm{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:8px}.smc{background:var(--surface2);border-radius:8px;padding:6px 8px}.smh{display:flex;gap:6px;align-items:baseline;font-size:12px;min-width:0}.smh .muted{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}.smv{margin-left:auto;flex:none;font-variant-numeric:tabular-nums;font-weight:600}
.spark{display:block}
.cols3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px}@media(max-width:1000px){.cols3{grid-template-columns:1fr}}
.filters{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:8px 0}.fbtn,.cbtn{border:1px solid var(--line);background:#fff;border-radius:16px;padding:3px 10px;font-size:12px;cursor:pointer;display:inline-flex;gap:5px;align-items:center}.fbtn.on,.cbtn.on{background:var(--text);color:#fff;border-color:var(--text)}
#chatq{margin-left:auto;border:1px solid var(--line);border-radius:6px;padding:4px 8px;font-size:12px;min-width:260px}
#chat{max-height:520px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:6px 10px;font-size:12.5px}.msg{padding:2px 0;border-bottom:1px dotted var(--grid)}.msg .ts{color:var(--muted);font-variant-numeric:tabular-nums;margin-right:6px}.msg .dot{margin-right:5px}.msg.pm .arrow{color:var(--text2)}.msg .txt{color:var(--text)}
.notes{background:var(--surface2);border-radius:8px;padding:8px 12px;font-size:12.5px;margin:2px 0 6px}.notes p{margin:4px 0}.tl{margin:4px 0 4px 16px;padding:0;color:var(--text2)}.tags{display:flex;gap:5px;flex-wrap:wrap;margin:6px 0 2px}.tag{background:#fff;border:1px solid var(--line);border-radius:4px;padding:1px 6px;font-size:11px;color:var(--text2)}
.mcards{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}.mcard{background:var(--surface2);border-radius:8px;padding:8px 12px 10px}.mrow{display:flex;flex-wrap:wrap;gap:4px}.pill{background:#fff;border:1px solid var(--line);border-radius:12px;padding:1px 8px;font-size:12px;font-variant-numeric:tabular-nums}
video{width:100%;max-width:1200px;border-radius:8px;background:#000}details summary{cursor:pointer;color:var(--text2);margin:6px 0}
.findings{margin:6px 0 0 18px;padding:0;max-width:1100px}.findings li{margin:6px 0}code{background:var(--surface2);padding:1px 5px;border-radius:4px;font-size:12px}
.legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;margin:2px 0 6px}
</style></head><body><div class="wrap">
<h1>Market run — ${esc(run.meta.trial.split('__')[0])}</h1>
<div class="sub">Job <code>${esc(jobName)}</code> · launched ${esc(launched)} UTC · ${bots.length} players (${perRole} miners / ${perRole} smiths / ${perRole} alchemists), ${modelOrder.length} models dealt ${perRole / modelOrder.length} per model per role · cap ${Math.round(capSecs / 60)} min · every player judged solely on final coin balance.
${hasVideo ? '' : ''}<br>Legend: ${modelOrder.map(m => chip(m)).join(' &nbsp; ')}</div>
${heroHtml}
${findingsHtml}

<h2>Model leaderboard</h2>
${leaderboardHtml}
<div class="mcards" style="margin-top:14px">${modelSummaryHtml}</div>

<h2>Role × model</h2>
${matrixHtml}

<h2>Gold over time — per model (sum of its ${perRole * 3 / modelOrder.length} bots)</h2>
${lineChart(seriesModel, { w: 1300, h: 340, id: 'models' })}

<h2>Gold over time — every bot</h2>
<div class="legend">${modelOrder.map(m => chip(m)).join('')} <span class="muted">sorted by role, then final gold; shared y-axis (max ${fmt(ymaxBot)} gp)</span></div>
${smallMultiples}

<h2>Trade flows</h2>
${flowHtml}
${salesHtml}

<h2>Per-bot results${notesDir ? ' &amp; behavior notes' : ''}</h2>
${botTableHtml}

<h2>Chat transcript</h2>
${chatHtml}

${hasVideo ? `<h2>Grid video</h2><video controls preload="metadata" src="${esc(videoRel)}"></video><div class="muted" style="margin-top:6px">${esc(videoRel)} · interactive viewer: <a href="../../views/graph-market.html">views/graph-market.html</a></div>` : `<h2>Video</h2><div class="muted">No grid video found at results/market/${esc(videoRel)} — build one with <code>bun scripts/make-market-grid.ts ${esc(jobName)}</code>.</div>`}
</div>
<script>
(function(){
  // line-chart hover: crosshair + tooltip
  document.querySelectorAll('.chart').forEach(function(ch){
    var svg=ch.querySelector('svg'), tip=ch.querySelector('.tip'), xh=ch.querySelector('.xh');
    var series=JSON.parse(ch.querySelector('script.series').textContent);
    var pad=JSON.parse(svg.getAttribute('data-pad')), x1=+svg.getAttribute('data-x1');
    var vb=svg.viewBox.baseVal;
    svg.addEventListener('mousemove',function(e){
      var r=svg.getBoundingClientRect(); var vx=(e.clientX-r.left)/r.width*vb.width;
      if(vx<pad[0]||vx>vb.width-pad[1]){tip.style.display='none';xh.style.display='none';return;}
      var t=(vx-pad[0])/(vb.width-pad[0]-pad[1])*x1;
      xh.setAttribute('x1',vx);xh.setAttribute('x2',vx);xh.style.display='';
      var rows=series.map(function(s){var best=s.pts[0];for(var i=0;i<s.pts.length;i++){if(Math.abs(s.pts[i][0]-t)<Math.abs(best[0]-t))best=s.pts[i];}return {s:s,v:best?best[1]:0};}).sort(function(a,b){return b.v-a.v;});
      var mm=Math.floor(t/60), ss=Math.floor(t%60);
      tip.innerHTML='<b>'+String(mm).padStart(2,'0')+':'+String(ss).padStart(2,'0')+'</b><br>'+rows.map(function(r){return '<span class="dot" style="background:'+r.s.color+'"></span> '+r.s.label+' '+Math.round(r.v).toLocaleString();}).join('<br>');
      tip.style.display='';var lx=e.clientX-r.left+12; if(lx+180>r.width) lx=e.clientX-r.left-190; tip.style.left=lx+'px'; tip.style.top=(e.clientY-r.top+12)+'px';
    });
    svg.addEventListener('mouseleave',function(){tip.style.display='none';xh.style.display='none';});
  });
  // bot table filters
  document.querySelectorAll('.fbtn').forEach(function(b){b.addEventListener('click',function(){
    document.querySelectorAll('.fbtn').forEach(function(x){x.classList.remove('on');});b.classList.add('on');
    var f=b.getAttribute('data-f');
    document.querySelectorAll('#bots tbody tr').forEach(function(tr){
      var show=f==='all'||(f.indexOf('model:')===0&&tr.getAttribute('data-model')===f.slice(6))||(f.indexOf('role:')===0&&tr.getAttribute('data-role')===f.slice(5));
      tr.style.display=show?'':'none';
    });
  });});
  // chat filters
  var mode='all', q='';
  function applyChat(){document.querySelectorAll('#chat .msg').forEach(function(m){
    var ok=mode==='all'||m.classList.contains(mode);
    if(ok&&q){var s=m.getAttribute('data-s'), to=m.getAttribute('data-to'); var txt=m.textContent.toLowerCase();
      ok = q.length===1 ? (s===q||to===q) : txt.indexOf(q)>=0;}
    m.style.display=ok?'':'none';});}
  document.querySelectorAll('.cbtn').forEach(function(b){b.addEventListener('click',function(){document.querySelectorAll('.cbtn').forEach(function(x){x.classList.remove('on');});b.classList.add('on');mode=b.getAttribute('data-c');applyChat();});});
  document.getElementById('chatq').addEventListener('input',function(e){q=e.target.value.trim().toLowerCase();applyChat();});
})();
</script>
</body></html>`;

writeFileSync(outFile, html);
console.log(`wrote ${outFile} (${(html.length / 1024).toFixed(0)} KB) — ${bots.length} bots, ${models.length} models, ${chat.length} chat msgs, ${sales.length} trades${notesDir ? `, notes for ${bots.filter(b => b.notes).length} bots` : ''}`);
