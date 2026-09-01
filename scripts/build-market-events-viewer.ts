#!/usr/bin/env bun
/**
 * Build ONE self-contained HTML viewer for browsing + filtering the chat and
 * trade events of one or more market runs (one run at a time, `?run=`).
 *
 *   bun scripts/build-market-events-viewer.ts <job> [<job> ...] [--out <file>]
 *     [--label <job>=<label> ...] [--slug <job>=<slug> ...]
 *
 * Reads results/market/_data.js (run `bun scripts/extract-market-viz.ts`
 * first) for chat + sales + bots, and each trial's reward.json for the guild
 * block (collective runs → leader ♛). Writes results/market/events-viewer.html
 * by default. Everything (data + UI) is inlined — no network, no deps.
 *
 * One run is shown at a time, selected by the `?run=` query param — its slug
 * (default `leader` / `noleader`, deduped with -2, -3…; override with --slug),
 * the full job name, a 0-based index, or a substring of the job name. The run
 * pills just rewrite that param. All other filters live in the URL hash.
 * Filters: event kind (PM / public / trade),
 * role, model, bot(s) (sender OR recipient OR trade party; optional "only
 * between selected bots"), free text, time window (brushable histogram).
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { HARBOR_MODEL_PRICING } from '../shared/pricing';

const REPO = join(import.meta.dir, '..');
const args = process.argv.slice(2);
const jobs: string[] = [];
const labels: Record<string, string> = {};
const slugs: Record<string, string> = {};
let outFile = join(REPO, 'results', 'market', 'events-viewer.html');
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') outFile = args[++i];
  else if (args[i] === '--label') { const [j, l] = args[++i].split(/=(.*)/s); labels[j] = l; }
  else if (args[i] === '--slug') { const [j, l] = args[++i].split(/=(.*)/s); slugs[j] = l; }
  else jobs.push(args[i]);
}
if (!jobs.length) { console.error('usage: build-market-events-viewer.ts <job> [<job> ...] [--out <file>] [--label <job>=<label>] [--slug <job>=<slug>]'); process.exit(1); }

const dataSrc = readFileSync(join(REPO, 'results', 'market', '_data.js'), 'utf8');
const w: any = {}; new Function('window', dataSrc)(w);
const shortModel = (id: string) => HARBOR_MODEL_PRICING[id] ?? id.split('/').pop()!.replace(/-latest$/, '');

// Display names in chat `to` fields ("Ivy Smith" / "ivy smith") → bot keys.
const toKey = (s: string | undefined, names: string[]) => {
  if (!s) return undefined;
  const k = s.toLowerCase().trim().replace(/\s+/g, '_');
  return names.includes(k) ? k : k;
};

const runs = jobs.map(job => {
  const run = (w.MARKET_RUNS as any[]).find(r => r.meta.job === job);
  if (!run) { console.error(`job ${job} not in results/market/_data.js — run extract-market-viz.ts`); process.exit(1); }
  const jobDir = join(REPO, 'jobs', job, run.meta.trial);
  const rewardPath = join(jobDir, 'verifier', 'reward.json');
  const reward = existsSync(rewardPath) ? JSON.parse(readFileSync(rewardPath, 'utf8')) : {};
  const names: string[] = run.bots.map((b: any) => b.name);
  const leader: string | undefined = reward.guild?.leader;
  const bots = run.bots.map((b: any) => ({
    name: b.name, role: b.role, model: b.model || run.meta.model, modelLabel: shortModel(b.model || run.meta.model),
    finalGold: b.finalGold, leader: b.name === leader,
  }));
  const chat = run.chat.map((c: any) => ({
    t: c.t, kind: c.to ? 'pm' : 'say', from: c.sender, to: toKey(c.to, names), text: c.text,
  }));
  const trades = (run.sales ?? []).map((s: any) => ({
    t: s.t, kind: 'trade', from: s.from, to: s.to, gp: s.gp, item: s.item, qty: s.qty, unit: s.unit, note: s.note ?? null,
  }));
  const events = [...chat, ...trades].sort((a, b) => a.t - b.t || (a.kind === 'trade' ? 1 : -1));
  const defaultLabel = leader ? `Guild leader (${shortModel(bots.find((b: any) => b.leader)?.model ?? '')}) · ${run.meta.launchedAt.slice(0, 8).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')}`
    : `No leader · ${run.meta.launchedAt.slice(0, 8).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')}`;
  return {
    job, label: labels[job] ?? defaultLabel, slug: slugs[job] ?? (leader ? 'leader' : 'noleader'), trial: run.meta.trial, capSecs: run.meta.capSecs, totalGold: run.meta.totalGold,
    leader, guildGold: reward.guild?.guildGold ?? null, bots, events,
  };
});

// Dedupe default slugs (two no-leader runs → noleader, noleader-2).
{ const seen: Record<string, number> = {};
  for (const r of runs) { const n = (seen[r.slug] = (seen[r.slug] ?? 0) + 1); if (n > 1) r.slug = `${r.slug}-${n}`; } }

// Fixed model → color slots across all runs (order of first appearance).
const PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
const modelOrder: string[] = [];
for (const r of runs) for (const b of r.bots) if (!modelOrder.includes(b.model)) modelOrder.push(b.model);
const models = modelOrder.map((m, i) => ({ id: m, label: shortModel(m), color: PALETTE[i % PALETTE.length] }));

const payload = { runs, models, builtAt: new Date().toISOString() };
const dataJson = JSON.stringify(payload).replace(/<\//g, '<\\/');

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Market events — chat + trades</title>
<style>
:root{--bg:#fafafa;--fg:#1b1b1f;--muted:#6b6f76;--line:#e3e5e8;--card:#fff;--accent:#2a78d6;--pm:#4a3aa7;--say:#6b6f76;--trade:#1baf7a;--sel:#fff4d6;
 --miner:#8a5a2b;--smith:#3b5bdb;--alch:#b5179e}
@media(prefers-color-scheme:dark){:root{--bg:#121317;--fg:#e7e8ea;--muted:#9aa0a8;--line:#2a2d33;--card:#1a1c21;--sel:#3a3220}}
*{box-sizing:border-box}
body{margin:0;font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;background:var(--bg);color:var(--fg)}
header{position:sticky;top:0;z-index:5;background:var(--card);border-bottom:1px solid var(--line);padding:10px 16px 8px}
h1{font-size:16px;margin:0 0 8px;display:flex;align-items:baseline;gap:12px}
h1 small{font-weight:normal;color:var(--muted);font-size:12px}
.row{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;margin:4px 0}
.grp{display:flex;flex-wrap:wrap;gap:4px;align-items:center;padding:2px 8px 2px 0;border-right:1px solid var(--line)}
.grp:last-child{border-right:0}
.grp .lbl{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin-right:2px}
button.pill{border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:999px;padding:2px 9px;font:inherit;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;gap:5px}
button.pill:hover{border-color:var(--accent)}
button.pill.on{background:var(--accent);border-color:var(--accent);color:#fff}
button.pill.on .dot{outline:1px solid #fff}
button.pill.bot{padding:1px 7px;font-size:11px}
button.pill.bot.role-miner{border-left:3px solid var(--miner)}
button.pill.bot.role-smith{border-left:3px solid var(--smith)}
button.pill.bot.role-alchemist{border-left:3px solid var(--alch)}
.dot{width:9px;height:9px;border-radius:50%;display:inline-block;flex:none}
input[type=search]{font:inherit;padding:3px 8px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg);min-width:220px}
label.cb{display:inline-flex;gap:4px;align-items:center;color:var(--muted);font-size:12px;cursor:pointer}
.stats{color:var(--muted);font-size:12px;margin-left:auto;display:flex;gap:14px}
.stats b{color:var(--fg)}
main{padding:12px 16px}
.col{background:var(--card);border:1px solid var(--line);border-radius:8px;min-width:0;display:flex;flex-direction:column;height:calc(100vh - var(--hdr,150px) - 24px)}
.col h2{font-size:13px;margin:0;padding:8px 12px;border-bottom:1px solid var(--line);display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
.col h2 .sub{color:var(--muted);font-weight:normal;font-size:12px}
.hist{position:relative;height:54px;margin:6px 12px 0;border-bottom:1px solid var(--line);cursor:crosshair;user-select:none}
.hist .bar{position:absolute;bottom:0;width:calc(100%/var(--n));background:var(--say);opacity:.55}
.hist .bar.tr{background:var(--trade);opacity:.9}
.hist .brush{position:absolute;top:0;bottom:0;background:rgba(42,120,214,.15);border-left:1px solid var(--accent);border-right:1px solid var(--accent);pointer-events:none}
.hist .ax{position:absolute;bottom:-14px;font-size:10px;color:var(--muted)}
.tw{display:flex;justify-content:space-between;font-size:11px;color:var(--muted);padding:14px 12px 2px}
.tw button{font:inherit;font-size:11px;background:none;border:0;color:var(--accent);cursor:pointer;padding:0}
.list{overflow:auto;flex:1;padding:4px 0 20px}
.ev{display:grid;grid-template-columns:46px 52px minmax(150px,230px) 1fr;gap:0 10px;padding:4px 12px;border-bottom:1px solid var(--line);align-items:baseline}
.ev:hover{background:var(--sel)}
.ev .t{color:var(--muted);font-variant-numeric:tabular-nums;font-size:12px}
.ev .k{font-size:10px;text-transform:uppercase;letter-spacing:.05em;border-radius:4px;padding:1px 5px;text-align:center;color:#fff}
.ev.pm .k{background:var(--pm)}.ev.say .k{background:var(--say)}.ev.trade .k{background:var(--trade)}
.ev .who{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ev .who .arrow{color:var(--muted);margin:0 4px}
.ev .txt{white-space:pre-wrap;word-break:break-word}
.ev.trade .txt{color:var(--trade)}
.ev.trade .txt b{color:var(--fg)}
.ev .txt .note{color:var(--muted);font-size:11px;margin-left:6px}
.name{cursor:pointer;border-bottom:1px dotted transparent}
.name:hover{border-bottom-color:currentColor}
.name.sel{outline:2px solid var(--accent);border-radius:3px;padding:0 3px;font-weight:600}
.name.r-miner{color:var(--miner)}.name.r-smith{color:var(--smith)}.name.r-alchemist{color:var(--alch)}
.crown{color:#d4a017}
.mdot{width:7px;height:7px;border-radius:50%;display:inline-block;margin-right:3px;vertical-align:middle}
mark{background:#ffe57a;color:#000;padding:0 1px;border-radius:2px}
.empty{padding:30px;text-align:center;color:var(--muted)}
.legend{display:flex;gap:10px;font-size:11px;color:var(--muted);align-items:center}
.legend .sw{width:10px;height:10px;border-radius:2px;display:inline-block;margin-right:3px;vertical-align:middle}
.more{display:block;margin:8px auto;padding:4px 12px;font:inherit;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg);cursor:pointer}
kbd{font:11px ui-monospace,monospace;border:1px solid var(--line);border-radius:3px;padding:0 4px;color:var(--muted)}
</style></head><body>
<header id="hdr">
<h1>Market events <small>chat + trades · <code>?run=${runs.map(r => r.slug).join('|')}</code> picks the run · click a name to filter on it · <kbd>esc</kbd> clears</small></h1>
<div class="row">
  <div class="grp"><span class="lbl">Run</span><span id="runPills"></span></div>
  <div class="grp"><span class="lbl">Kind</span><span id="kindPills"></span></div>
  <div class="grp"><span class="lbl">Role</span><span id="rolePills"></span></div>
  <div class="grp"><span class="lbl">Model</span><span id="modelPills"></span></div>
  <div class="grp"><input id="q" type="search" placeholder="search text, item, name… (regex ok)"></div>
  <div class="grp"><label class="cb"><input type="checkbox" id="between"> only between selected bots</label>
    <label class="cb"><input type="checkbox" id="ctx"> ±2 min context</label>
    <button class="pill" id="clear">clear filters</button></div>
  <div class="stats" id="stats"></div>
</div>
<div class="row"><div class="grp" style="border:0"><span class="lbl">Bots</span><span id="botPills"></span></div></div>
</header>
<main id="main"></main>
<script id="data" type="application/json">${dataJson}</script>
<script>
const DATA = JSON.parse(document.getElementById('data').textContent);
const RUNS = DATA.runs, MODELS = DATA.models;
const modelColor = Object.fromEntries(MODELS.map(m => [m.id, m.color]));
const ROLES = ['miner','smith','alchemist'];
const KINDS = [['pm','PM'],['say','public'],['trade','trade']];
const hasSay = RUNS.some(r => r.events.some(e => e.kind === 'say'));

// Every bot across runs, keyed by name (role/model may differ per run — take first, note conflicts).
const botIndex = {};
for (const r of RUNS) for (const b of r.bots) {
  botIndex[b.name] ??= { name: b.name, role: b.role, models: new Set(), leader: false };
  botIndex[b.name].models.add(b.model); if (b.leader) botIndex[b.name].leader = true;
}
const allBots = Object.values(botIndex).sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role) || a.name.localeCompare(b.name));

function runFromQuery() {
  const q = new URLSearchParams(location.search).get('run');
  if (q == null || q === '') return 0;
  let i = RUNS.findIndex(r => r.slug === q); if (i >= 0) return i;
  i = RUNS.findIndex(r => r.job === q); if (i >= 0) return i;
  if (/^\d+$/.test(q) && RUNS[+q]) return +q;
  i = RUNS.findIndex(r => r.job.includes(q)); return i >= 0 ? i : 0;
}
const state = {
  run: runFromQuery(),   // index into RUNS — chosen by ?run=<job|index|substring>
  kinds: new Set(KINDS.map(k => k[0])), roles: new Set(ROLES), models: new Set(MODELS.map(m => m.id)),
  bots: new Set(), q: '', between: false, ctx: false,
  t0: 0, t1: Infinity,
};
// restore from hash
try { const h = new URLSearchParams(location.hash.slice(1));
  if (h.has('kinds')) state.kinds = new Set(h.get('kinds').split(',').filter(Boolean));
  if (h.has('roles')) state.roles = new Set(h.get('roles').split(',').filter(Boolean));
  if (h.has('models')) state.models = new Set(h.get('models').split(',').filter(Boolean));
  if (h.has('bots')) state.bots = new Set(h.get('bots').split(',').filter(Boolean));
  if (h.has('q')) state.q = h.get('q');
  if (h.has('between')) state.between = true;
  if (h.has('t0')) state.t0 = +h.get('t0'); if (h.has('t1')) state.t1 = +h.get('t1');
} catch {}

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const mmss = t => { t = Math.max(0, Math.round(t)); return String(Math.floor(t/60)).padStart(2,'0') + ':' + String(t%60).padStart(2,'0'); };
const fmt = n => Number(n ?? 0).toLocaleString();
const short = n => (n ?? '').replace(/_(miner|smith|alch)$/, '');

function pill(label, on, onclick, extra = '') {
  const b = document.createElement('button'); b.className = 'pill ' + extra + (on ? ' on' : ''); b.innerHTML = label; b.onclick = onclick; return b;
}
function toggle(set, v, all) {
  // plain click: toggle; if that empties the set, reset to all (never show nothing by accident)
  if (set.has(v)) set.delete(v); else set.add(v);
  if (!set.size) for (const x of all) set.add(x);
}
function solo(set, v, all) { // shift-click → only this; shift-click again → all
  if (set.size === 1 && set.has(v)) { for (const x of all) set.add(x); } else { set.clear(); set.add(v); }
}

function renderControls() {
  const rp = $('#runPills'); rp.innerHTML = '';
  RUNS.forEach((r, i) => rp.append(pill(esc(r.label), state.run === i, () => {
    state.run = i;
    const u = new URL(location.href); u.searchParams.set('run', r.slug); history.replaceState(null, '', u);
    render();
  })));

  const kp = $('#kindPills'); kp.innerHTML = '';
  for (const [k, l] of KINDS) { if (k === 'say' && !hasSay) continue;
    kp.append(pill(l, state.kinds.has(k), e => { (e.shiftKey ? solo : toggle)(state.kinds, k, KINDS.map(x => x[0])); render(); })); }

  const rlp = $('#rolePills'); rlp.innerHTML = '';
  for (const r of ROLES) rlp.append(pill(r, state.roles.has(r), e => { (e.shiftKey ? solo : toggle)(state.roles, r, ROLES); render(); }));

  const mp = $('#modelPills'); mp.innerHTML = '';
  for (const m of MODELS) mp.append(pill('<span class="dot" style="background:' + m.color + '"></span>' + esc(m.label), state.models.has(m.id),
    e => { (e.shiftKey ? solo : toggle)(state.models, m.id, MODELS.map(x => x.id)); render(); }));

  const bp = $('#botPills'); bp.innerHTML = '';
  for (const b of allBots) {
    const rb = RUNS[state.run].byName[b.name];   // model + leader status in the CURRENT run
    if (!rb) continue;
    const dot = '<span class="dot" style="background:' + modelColor[rb.model] + '"></span>';
    bp.append(pill(dot + (rb.leader ? '<span class="crown">♛</span>' : '') + esc(b.name), state.bots.has(b.name),
      () => { if (state.bots.has(b.name)) state.bots.delete(b.name); else state.bots.add(b.name); render(); }, 'bot role-' + b.role));
  }
  $('#q').value = state.q; $('#between').checked = state.between; $('#ctx').checked = state.ctx;
  $('#between').disabled = state.bots.size < 2;
}

function matcher() {
  let re = null;
  if (state.q.trim()) { try { re = new RegExp(state.q.trim(), 'i'); } catch { const q = state.q.trim().toLowerCase(); re = { test: s => s.toLowerCase().includes(q) }; } }
  return re;
}
function evText(e) {
  return e.kind === 'trade' ? (e.item ?? '') + ' ' + (e.note ?? '') + ' ' + e.gp + 'gp ' + e.from + ' ' + e.to
    : e.text + ' ' + e.from + ' ' + (e.to ?? '');
}
function passes(e, run, re) {
  const bf = run.byName[e.from], bt = e.to ? run.byName[e.to] : null;
  if (!state.kinds.has(e.kind)) return false;
  // role / model: event passes if EITHER party matches (so "smith" shows everything smiths sent or received)
  const partyOk = b => b && state.roles.has(b.role) && state.models.has(b.model);
  if (!(partyOk(bf) || partyOk(bt))) return false;
  if (state.bots.size) {
    const inF = state.bots.has(e.from), inT = e.to && state.bots.has(e.to);
    if (state.between && state.bots.size >= 2) { if (!(inF && inT)) return false; }
    else if (!(inF || inT)) return false;
  }
  if (re && !re.test(evText(e))) return false;
  return true;
}

function nameHtml(run, n) {
  const b = run.byName[n];
  if (!b) return '<span class="name">' + esc(n) + '</span>';
  return '<span class="name r-' + b.role + (state.bots.has(n) ? ' sel' : '') + '" data-bot="' + esc(n) + '" title="' + esc(b.role + ' · ' + b.modelLabel + ' · final ' + fmt(b.finalGold) + ' gp') + '">' +
    '<span class="mdot" style="background:' + modelColor[b.model] + '"></span>' + (b.leader ? '<span class="crown">♛</span>' : '') + esc(short(n)) + '</span>';
}
function hl(text, re) {
  const s = esc(text);
  if (!re || !re.source) return s;
  try { return s.replace(new RegExp('(' + re.source + ')', 'gi'), '<mark>$1</mark>'); } catch { return s; }
}
function evHtml(run, e, re, dim) {
  const who = nameHtml(run, e.from) + '<span class="arrow">' + (e.kind === 'trade' ? '⇄' : '→') + '</span>' + (e.to ? nameHtml(run, e.to) : '<span class="name" style="color:var(--muted)">all</span>');
  let body;
  if (e.kind === 'trade') {
    if (e.gp > 0 && e.item) body = '<b>' + fmt(e.gp) + ' gp</b> for <b>' + hl(e.item, re) + '</b>' + (e.qty && e.qty !== 1 ? ' ×' + e.qty : '') + (e.unit != null && e.qty > 1 ? ' <span class="note">@ ' + e.unit + ' gp ea</span>' : '') + (e.note ? '<span class="note">' + esc(e.note) + '</span>' : '');
    else if (e.gp > 0) body = '<b>' + fmt(e.gp) + ' gp</b> <span class="note">' + esc(e.note ?? 'gp only') + '</span>';
    else body = '<b>' + hl(e.item ?? '', re) + '</b> <span class="note">' + esc(e.note ?? '') + '</span>';
    body = 'paid ' + body;
  } else body = hl(e.text, re);
  return '<div class="ev ' + e.kind + '"' + (dim ? ' style="opacity:.45"' : '') + '><span class="t">' + mmss(e.t) + '</span><span class="k">' + (e.kind === 'pm' ? 'pm' : e.kind === 'say' ? 'say' : 'trade') + '</span><span class="who">' + who + '</span><span class="txt">' + body + '</span></div>';
}

const PAGE = 600;
function renderColumn(run, idx) {
  const re = matcher();
  const hits = run.events.filter(e => passes(e, run, re));
  let shown = hits;
  if (state.ctx && (state.bots.size || state.q.trim())) {
    // include ±120s of neighbours around each hit (dimmed) so a filtered thread keeps its context
    const hitSet = new Set(hits);
    shown = run.events.filter(e => hitSet.has(e) || hits.some(h => Math.abs(h.t - e.t) <= 120 && state.kinds.has(e.kind)));
    shown.hitSet = hitSet;
  }
  const inWin = shown.filter(e => e.t >= state.t0 && e.t <= state.t1);
  const msgs = hits.filter(e => e.kind !== 'trade' && e.t >= state.t0 && e.t <= state.t1).length;
  const trs = hits.filter(e => e.kind === 'trade' && e.t >= state.t0 && e.t <= state.t1);
  const gp = trs.reduce((a, e) => a + (e.gp || 0), 0);

  const col = document.createElement('section'); col.className = 'col';
  col.innerHTML = '<h2>' + esc(run.label) + ' <span class="sub">' + esc(run.job) + '</span>' +
    '<span class="sub" style="margin-left:auto">' + fmt(run.totalGold) + ' gp total' + (run.guildGold != null ? ' · guild ' + fmt(run.guildGold) + ' gp' : '') + ' · cap ' + mmss(run.capSecs) + '</span></h2>' +
    '<div class="legend" style="padding:6px 12px 0"><span><span class="sw" style="background:var(--say);opacity:.55"></span>msgs / min</span><span><span class="sw" style="background:var(--trade)"></span>trades / min</span><span style="margin-left:auto"><b>' + fmt(msgs) + '</b> msgs · <b>' + fmt(trs.length) + '</b> trades · <b>' + fmt(gp) + '</b> gp</span></div>';
  col.append(histogram(run, hits));
  const tw = document.createElement('div'); tw.className = 'tw';
  tw.innerHTML = '<span>window ' + mmss(state.t0) + ' – ' + (state.t1 === Infinity ? 'end' : mmss(state.t1)) + (state.t1 !== Infinity || state.t0 > 0 ? ' <button data-reset>reset</button>' : ' · drag on the histogram to brush a window') + '</span><span>' + fmt(inWin.length) + ' rows</span>';
  tw.querySelector('[data-reset]')?.addEventListener('click', () => { state.t0 = 0; state.t1 = Infinity; render(); });
  col.append(tw);
  const list = document.createElement('div'); list.className = 'list';
  if (!inWin.length) list.innerHTML = '<div class="empty">no events match</div>';
  else {
    let n = 0;
    const more = () => {
      const chunk = inWin.slice(n, n + PAGE);
      list.insertAdjacentHTML('beforeend', chunk.map(e => evHtml(run, e, re, shown.hitSet && !shown.hitSet.has(e))).join(''));
      n += chunk.length;
      list.querySelector('.more')?.remove();
      if (n < inWin.length) { const b = document.createElement('button'); b.className = 'more'; b.textContent = 'show ' + Math.min(PAGE, inWin.length - n) + ' more (' + (inWin.length - n) + ' left)'; b.onclick = more; list.append(b); }
    };
    more();
  }
  list.addEventListener('click', e => {
    const n = e.target.closest('[data-bot]'); if (!n) return;
    const name = n.dataset.bot;
    if (e.shiftKey || e.metaKey) { if (state.bots.has(name)) state.bots.delete(name); else state.bots.add(name); }
    else { if (state.bots.size === 1 && state.bots.has(name)) state.bots.clear(); else { state.bots.clear(); state.bots.add(name); } }
    render();
  });
  col.append(list);
  return col;
}

function histogram(run, hits) {
  const binS = 60, nb = Math.ceil(run.capSecs / binS) + 1;
  const msgs = new Array(nb).fill(0), trs = new Array(nb).fill(0);
  for (const e of hits) { const i = Math.min(nb - 1, Math.floor(e.t / binS)); if (e.kind === 'trade') trs[i]++; else msgs[i]++; }
  const max = Math.max(1, ...msgs.map((m, i) => m + trs[i]));
  const h = document.createElement('div'); h.className = 'hist'; h.style.setProperty('--n', nb);
  let html = '';
  for (let i = 0; i < nb; i++) {
    const l = (i / nb * 100) + '%';
    if (msgs[i]) html += '<div class="bar" style="left:' + l + ';height:' + (msgs[i] / max * 100) + '%;bottom:' + (trs[i] / max * 100) + '%" title="' + i + 'm: ' + msgs[i] + ' msgs"></div>';
    if (trs[i]) html += '<div class="bar tr" style="left:' + l + ';height:' + (trs[i] / max * 100) + '%" title="' + i + 'm: ' + trs[i] + ' trades"></div>';
  }
  for (let m = 0; m < nb; m += 15) html += '<div class="ax" style="left:' + (m / nb * 100) + '%">' + m + 'm</div>';
  if (state.t0 > 0 || state.t1 !== Infinity) {
    const a = state.t0 / (nb * binS) * 100, b = Math.min(1, (state.t1 === Infinity ? nb * binS : state.t1) / (nb * binS)) * 100;
    html += '<div class="brush" style="left:' + a + '%;width:' + (b - a) + '%"></div>';
  }
  h.innerHTML = html;
  // brush to set the time window
  let x0 = null, brush = null;
  const pos = ev => { const r = h.getBoundingClientRect(); return Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)); };
  h.addEventListener('pointerdown', ev => { x0 = pos(ev); h.setPointerCapture(ev.pointerId); brush = document.createElement('div'); brush.className = 'brush'; h.append(brush); });
  h.addEventListener('pointermove', ev => { if (x0 == null) return; const x = pos(ev); brush.style.left = Math.min(x0, x) * 100 + '%'; brush.style.width = Math.abs(x - x0) * 100 + '%'; });
  h.addEventListener('pointerup', ev => {
    if (x0 == null) return; const x = pos(ev);
    if (Math.abs(x - x0) < 0.005) { state.t0 = 0; state.t1 = Infinity; }
    else { state.t0 = Math.round(Math.min(x0, x) * nb * binS); state.t1 = Math.round(Math.max(x0, x) * nb * binS); }
    x0 = null; render();
  });
  return h;
}

function render() {
  for (const r of RUNS) r.byName ??= Object.fromEntries(r.bots.map(b => [b.name, b]));
  renderControls();
  const main = $('#main'); main.innerHTML = '';
  const idxs = [state.run];
  main.append(renderColumn(RUNS[state.run], state.run));
  document.documentElement.style.setProperty('--hdr', $('#hdr').offsetHeight + 'px');
  // totals across shown runs
  const re = matcher();
  let msgs = 0, trs = 0, gp = 0;
  for (const i of idxs) for (const e of RUNS[i].events) if (passes(e, RUNS[i], re) && e.t >= state.t0 && e.t <= state.t1) { if (e.kind === 'trade') { trs++; gp += e.gp || 0; } else msgs++; }
  $('#stats').innerHTML = '<span><b>' + fmt(msgs) + '</b> msgs</span><span><b>' + fmt(trs) + '</b> trades</span><span><b>' + fmt(gp) + '</b> gp</span>';
  // persist
  const h = new URLSearchParams();
  if (state.kinds.size !== KINDS.length) h.set('kinds', [...state.kinds].join(','));
  if (state.roles.size !== ROLES.length) h.set('roles', [...state.roles].join(','));
  if (state.models.size !== MODELS.length) h.set('models', [...state.models].join(','));
  if (state.bots.size) h.set('bots', [...state.bots].join(','));
  if (state.q) h.set('q', state.q);
  if (state.between) h.set('between', '1');
  if (state.t0 > 0) h.set('t0', String(state.t0)); if (state.t1 !== Infinity) h.set('t1', String(state.t1));
  history.replaceState(null, '', '#' + h.toString());
}

let qTimer;
$('#q').addEventListener('input', e => { clearTimeout(qTimer); qTimer = setTimeout(() => { state.q = e.target.value; render(); }, 150); });
$('#between').addEventListener('change', e => { state.between = e.target.checked; render(); });
$('#ctx').addEventListener('change', e => { state.ctx = e.target.checked; render(); });
$('#clear').addEventListener('click', clearAll);
function clearAll() {
  state.kinds = new Set(KINDS.map(k => k[0])); state.roles = new Set(ROLES); state.models = new Set(MODELS.map(m => m.id));
  state.bots.clear(); state.q = ''; state.between = false; state.ctx = false; state.t0 = 0; state.t1 = Infinity; render();
}
document.addEventListener('keydown', e => { if (e.key === 'Escape' && document.activeElement !== $('#q')) clearAll(); if (e.key === '/' && document.activeElement !== $('#q')) { e.preventDefault(); $('#q').focus(); } });
window.addEventListener('resize', () => document.documentElement.style.setProperty('--hdr', $('#hdr').offsetHeight + 'px'));
render();
</script>
</body></html>`;

writeFileSync(outFile, html);
const n = runs.reduce((a, r) => a + r.events.length, 0);
console.log(`wrote ${outFile} (${(html.length / 1024).toFixed(0)} KB) — ${runs.length} runs, ${n} events: ${runs.map(r => `${r.label}: ${r.events.filter(e => e.kind !== 'trade').length} msgs / ${r.events.filter(e => e.kind === 'trade').length} trades`).join('; ')}`);
