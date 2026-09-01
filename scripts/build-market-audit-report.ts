#!/usr/bin/env bun
/**
 * Build the "problems, strategy & anecdotes" audit report for ONE market run.
 *
 *   bun scripts/build-market-audit-report.ts <job-name> --audit <dir> [--out <file>]
 *
 * <dir> holds per-bot `audit-<bot>.json` files (schema: problems[], strategy{},
 * anecdotes[] — produced by analyst subagents from the trajectories),
 * optionally `audit-infra.json` (boot/stalls/restarts/client issues) and
 * `SYNTHESIS.md` (hand-written cross-cutting write-up; markdown subset:
 * headings `## `, `- ` bullets, **bold**, `code`, blank-line paragraphs).
 * Writes results/market/<job>-audit.html (self-contained; links to the main
 * <job>-report.html next to it).
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { HARBOR_MODEL_PRICING } from '../shared/pricing';

const REPO = join(import.meta.dir, '..');
const args = process.argv.slice(2);
const jobName = args.find(a => !a.startsWith('--'));
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const auditDir = opt('--audit');
if (!jobName || !auditDir) { console.error('usage: build-market-audit-report.ts <job-name> --audit <dir> [--out <file>]'); process.exit(1); }
const outFile = opt('--out') || join(REPO, 'results', 'market', `${jobName}-audit.html`);

const dataSrc = readFileSync(join(REPO, 'results', 'market', '_data.js'), 'utf8');
const w: any = {}; new Function('window', dataSrc)(w);
const run = (w.MARKET_RUNS as any[]).find(r => r.meta.job === jobName);
if (!run) { console.error(`job ${jobName} not in results/market/_data.js`); process.exit(1); }
const jobDir = join(REPO, 'jobs', jobName, run.meta.trial);
const reward = JSON.parse(readFileSync(join(jobDir, 'verifier', 'reward.json'), 'utf8'));

const shortModel = (id: string) => HARBOR_MODEL_PRICING[id] ?? id.split('/').pop()!.replace(/-latest$/, '');
const modelOrder: string[] = [];
for (const b of run.bots) { const m = b.model || run.meta.model; if (!modelOrder.includes(m)) modelOrder.push(m); }
const PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
const modelColor: Record<string, string> = {}; modelOrder.forEach((m, i) => modelColor[m] = PALETTE[i % PALETTE.length]);
const ROLE_ORDER = ['miner', 'smith', 'alchemist'];
const bots: Array<{ name: string; role: string; model: string; finalGold: number; audit?: any }> = run.bots.map((b: any) => {
  const p = join(auditDir, `audit-${b.name}.json`);
  let audit: any; if (existsSync(p)) { try { audit = JSON.parse(readFileSync(p, 'utf8')); } catch (e) { console.error(`bad json ${p}: ${e}`); } }
  return { name: b.name, role: b.role, model: b.model || run.meta.model, finalGold: b.finalGold, audit };
});
const byName = Object.fromEntries(bots.map(b => [b.name, b]));
const infra = existsSync(join(auditDir, 'audit-infra.json')) ? JSON.parse(readFileSync(join(auditDir, 'audit-infra.json'), 'utf8')) : null;
const synthesisFile = join(auditDir, 'SYNTHESIS.md');

const esc = (s: any) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
const chip = (m: string) => `<span class="chip"><span class="dot" style="background:${modelColor[m]}"></span>${esc(shortModel(m))}</span>`;
const botTag = (n: string) => { const b = byName[n?.toLowerCase?.()]; return b ? `<span class="bt"><b>${n.toUpperCase()}</b> <span class="dot" style="background:${modelColor[b.model]}"></span><span class="muted">${b.role}</span></span>` : `<b>${esc(n)}</b>`; };
const roleTag = (r: string) => `<span class="role">${r}</span>`;
const mdInline = (t: string) => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>');
function md(src: string) {
  let out = '', inList = false;
  for (const raw of src.split('\n')) {
    const l = raw.trimEnd();
    if (/^\s*-\s+/.test(l)) { if (!inList) { out += '<ul>'; inList = true; } out += `<li>${mdInline(l.replace(/^\s*-\s+/, ''))}</li>`; continue; }
    if (inList) { out += '</ul>'; inList = false; }
    if (/^###\s/.test(l)) out += `<h4>${mdInline(l.slice(4))}</h4>`;
    else if (/^##\s/.test(l)) out += `<h3>${mdInline(l.slice(3))}</h3>`;
    else if (/^#\s/.test(l)) out += `<h2>${mdInline(l.slice(2))}</h2>`;
    else if (l.trim()) out += `<p>${mdInline(l)}</p>`;
  }
  if (inList) out += '</ul>';
  return out;
}

// ── Problems ────────────────────────────────────────────────────
type Prob = { bot: string; kind: string; title: string; at: string; evidence: string; impact: string; root_cause_guess: string };
const problems: Prob[] = bots.flatMap(b => (b.audit?.problems ?? []).map((p: any) => ({ ...p, bot: b.name })));
const KIND_ORDER = ['sdk', 'infra', 'tooling', 'task-design', 'game-mechanics', 'model-behavior'];
const kinds = [...new Set(problems.map(p => p.kind))].sort((a, b) => (KIND_ORDER.indexOf(a) + 99) % 99 - (KIND_ORDER.indexOf(b) + 99) % 99);
const kindCounts = Object.fromEntries(kinds.map(k => [k, problems.filter(p => p.kind === k).length]));
const perModelKind = modelOrder.map(m => ({ m, counts: Object.fromEntries(kinds.map(k => [k, problems.filter(p => p.kind === k && byName[p.bot]?.model === m).length])) }));

const problemsTable = `
<div class="filters"><span class="muted">Kind:</span><button class="pf on" data-k="all">All (${problems.length})</button>${kinds.map(k => `<button class="pf" data-k="${k}">${k} (${kindCounts[k]})</button>`).join('')}
<span class="muted" style="margin-left:14px">Model:</span><button class="pm on" data-m="all">All</button>${modelOrder.map(m => `<button class="pm" data-m="${esc(m)}"><span class="dot" style="background:${modelColor[m]}"></span>${esc(shortModel(m))}</button>`).join('')}</div>
<table class="tbl" id="probs"><thead><tr><th>Bot</th><th>Kind</th><th>At</th><th>Problem</th><th>Evidence</th><th>Impact</th><th>Root cause (guess)</th></tr></thead><tbody>${
  problems.sort((a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind) || a.bot.localeCompare(b.bot)).map(p => `<tr data-k="${esc(p.kind)}" data-m="${esc(byName[p.bot]?.model)}">
    <td>${botTag(p.bot)}</td><td><span class="kind k-${esc(p.kind)}">${esc(p.kind)}</span></td><td class="mono">${esc(p.at)}</td><td><b>${esc(p.title)}</b></td><td class="ev">${esc(p.evidence)}</td><td>${esc(p.impact)}</td><td class="muted">${esc(p.root_cause_guess)}</td></tr>`).join('')}</tbody></table>`;

const kindMatrix = `<table class="tbl compact"><thead><tr><th>Model</th>${kinds.map(k => `<th>${k}</th>`).join('')}<th>Total</th></tr></thead><tbody>${
  perModelKind.map(r => `<tr><td>${chip(r.m)}</td>${kinds.map(k => `<td class="num">${r.counts[k] || '·'}</td>`).join('')}<td class="num"><b>${Object.values(r.counts).reduce((a: number, b: any) => a + b, 0)}</b></td></tr>`).join('')}
  <tr class="tot"><td>All</td>${kinds.map(k => `<td class="num">${kindCounts[k]}</td>`).join('')}<td class="num">${problems.length}</td></tr></tbody></table>`;

// ── Infra ───────────────────────────────────────────────────────
const infraHtml = infra ? `
<p>${esc(infra.summary)}</p>
<div class="cols2">
<div><h4>Model stalls (gaps &gt; 3 min between steps)</h4><table class="tbl compact"><thead><tr><th>Bot</th><th>From</th><th>To</th><th>min</th><th>Evidence</th></tr></thead><tbody>${(infra.stalls ?? []).map((s: any) => `<tr><td>${botTag(s.bot)}</td><td class="mono">${esc(s.from)}</td><td class="mono">${esc(s.to)}</td><td class="num">${esc(s.gap_min)}</td><td class="ev">${esc(s.evidence)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">none</td></tr>'}</tbody></table>
<h4>Session restarts</h4><table class="tbl compact"><thead><tr><th>Bot</th><th>At</th><th>What</th></tr></thead><tbody>${(infra.session_restarts ?? []).map((s: any) => `<tr><td>${botTag(s.bot)}</td><td class="mono">${esc(s.at)}</td><td class="ev">${esc(s.what)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">none</td></tr>'}</tbody></table></div>
<div><h4>Game-client / tunnel issues</h4><table class="tbl compact"><thead><tr><th>Bot</th><th>At</th><th>What</th></tr></thead><tbody>${(infra.client_issues ?? []).map((s: any) => `<tr><td>${botTag(s.bot)}</td><td class="mono">${esc(s.at)}</td><td class="ev">${esc(s.what)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">none</td></tr>'}</tbody></table>
<h4>API errors</h4><table class="tbl compact"><thead><tr><th>Bot</th><th>At</th><th>Error</th></tr></thead><tbody>${(infra.api_errors ?? []).map((s: any) => `<tr><td>${botTag(s.bot)}</td><td class="mono">${esc(s.at)}</td><td class="ev">${esc(s.error)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">none</td></tr>'}</tbody></table>
<h4>Watcher gaps</h4>${(infra.watcher_gaps ?? []).length ? `<ul>${infra.watcher_gaps.map((g: any) => `<li>${botTag(g.bot)} ${esc(g.what)}</li>`).join('')}</ul>` : '<p class="muted">none</p>'}
<h4>Boot</h4><p class="muted">First-step spread ${esc(infra.boot?.spread_secs)}s. ${esc(infra.boot?.notes)}</p>
<h4>Harbor / adapter</h4><ul>${(infra.harbor_adapter ?? []).map((s: string) => `<li>${esc(s)}</li>`).join('')}</ul></div></div>` : '<p class="muted">no audit-infra.json</p>';

// ── Strategy ────────────────────────────────────────────────────
const stratHtml = ROLE_ORDER.map(role => {
  const rb = bots.filter(b => b.role === role).sort((a, b) => b.finalGold - a.finalGold);
  return `<h3>${role.charAt(0).toUpperCase() + role.slice(1)}s</h3>
<table class="tbl strat"><thead><tr><th>Bot</th><th>Final</th><th>Initial plan</th><th>Pivots</th><th>Pricing</th><th>Trust &amp; credit</th><th>Time management</th><th>Verdict</th></tr></thead><tbody>${
    rb.map(b => { const s = b.audit?.strategy ?? {}; return `<tr>
      <td>${botTag(b.name)}<br>${chip(b.model)}</td><td class="num"><b>${fmt(b.finalGold)}</b></td>
      <td>${esc(s.initial_plan)}</td><td>${(s.pivots ?? []).length ? `<ul>${s.pivots.map((p: string) => `<li>${esc(p)}</li>`).join('')}</ul>` : '<span class="muted">—</span>'}</td>
      <td>${esc(s.pricing)}</td><td>${esc(s.trust_and_credit)}</td><td>${esc(s.time_management)}</td><td class="verdict">${esc(s.verdict)}</td></tr>`; }).join('')}</tbody></table>`;
}).join('');

// ── Anecdotes ───────────────────────────────────────────────────
type Anec = { bot: string; at: string; with: string; quote: string; why_interesting: string };
const anecdotes: Anec[] = bots.flatMap(b => (b.audit?.anecdotes ?? []).map((a: any) => ({ ...a, bot: b.name })));
const toSecs = (t: string) => { const m = String(t ?? '').match(/(\d+):(\d+)/); return m ? +m[1] * 60 + +m[2] : 1e9; };
anecdotes.sort((a, b) => toSecs(a.at) - toSecs(b.at));
const anecHtml = `<div class="filters"><span class="muted">Model:</span><button class="am on" data-m="all">All (${anecdotes.length})</button>${modelOrder.map(m => `<button class="am" data-m="${esc(m)}"><span class="dot" style="background:${modelColor[m]}"></span>${esc(shortModel(m))}</button>`).join('')}<input id="aq" placeholder="filter text…"/></div>
<div class="anecs" id="anecs">${anecdotes.map(a => `<div class="anec" data-m="${esc(byName[a.bot]?.model)}" style="border-left:3px solid ${modelColor[byName[a.bot]?.model] ?? '#999'}">
  <div class="ah"><span class="mono">${esc(a.at)}</span> ${botTag(a.bot)} <span class="muted">↔</span> ${botTag(String(a.with ?? '').split(/[ ,/&]+/)[0])}${String(a.with ?? '').length > 1 ? ` <span class="muted">(${esc(a.with)})</span>` : ''}</div>
  <blockquote>${esc(a.quote).replace(/\n/g, '<br>')}</blockquote>
  <div class="why">${esc(a.why_interesting)}</div></div>`).join('')}</div>`;

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Audit — ${esc(jobName)}</title>
<style>
:root{color-scheme:light;--surface:#fcfcfb;--surface2:#f3f2ee;--text:#0b0b0b;--text2:#52514e;--muted:#8a8984;--line:#e4e2dc}
*{box-sizing:border-box}body{margin:0;background:var(--surface);color:var(--text);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
.wrap{max-width:1400px;margin:0 auto;padding:28px 28px 80px}h1{font-size:24px;margin:0 0 4px}h2{font-size:19px;margin:36px 0 12px;padding-top:12px;border-top:1px solid var(--line)}h3{font-size:15px;margin:22px 0 8px}h4{margin:12px 0 6px;font-size:12px;color:var(--text2);text-transform:uppercase;letter-spacing:.04em}
.sub{color:var(--text2);margin-bottom:14px}code{background:var(--surface2);padding:1px 5px;border-radius:4px;font-size:12px}
.tbl{border-collapse:collapse;width:100%;font-size:13px}.tbl th{font-weight:600;color:var(--text2);text-align:left;padding:8px 8px;border-bottom:2px solid var(--line);white-space:nowrap}.tbl td{padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}.tbl .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.tbl.compact td,.tbl.compact th{padding:5px 8px}.tbl .tot td{font-weight:600;border-top:2px solid var(--line)}
.tbl.strat td{font-size:12.5px}.tbl.strat ul{margin:0;padding-left:16px}.verdict{font-weight:500}
.chip{display:inline-flex;align-items:center;gap:5px;font-size:12px;white-space:nowrap}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;flex:none}.bt{white-space:nowrap}.bt .dot{margin:0 3px}
.role{font-size:11px;padding:1px 6px;border-radius:4px;background:var(--surface2);color:var(--text2);text-transform:uppercase}.muted{color:var(--muted)}.mono{font-family:ui-monospace,Menlo,monospace;font-size:12px}
.ev{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:var(--text2);word-break:break-word}
#probs{table-layout:fixed}#probs th:nth-child(1){width:110px}#probs th:nth-child(2){width:100px}#probs th:nth-child(3){width:90px}#probs th:nth-child(4){width:200px}#probs th:nth-child(5){width:31%}#probs th:nth-child(6){width:18%}#probs td{word-break:break-word}
.tbl.strat{table-layout:fixed}.tbl.strat th:nth-child(1){width:90px}.tbl.strat th:nth-child(2){width:64px}.tbl.strat td{word-break:break-word}
.tbl.compact td{word-break:break-word}
.kind{font-size:11px;padding:1px 6px;border-radius:4px;background:#eee;white-space:nowrap}.k-sdk{background:#dbeafe}.k-infra{background:#fde68a}.k-tooling{background:#e9d5ff}.k-task-design{background:#fecaca}.k-game-mechanics{background:#d1fae5}.k-model-behavior{background:#f3f4f6}
.filters{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:8px 0}.filters button{border:1px solid var(--line);background:#fff;border-radius:16px;padding:3px 10px;font-size:12px;cursor:pointer;display:inline-flex;gap:5px;align-items:center}.filters button.on{background:var(--text);color:#fff;border-color:var(--text)}
#aq{margin-left:auto;border:1px solid var(--line);border-radius:6px;padding:4px 8px;font-size:12px;min-width:240px}
.cols2{display:grid;grid-template-columns:1fr 1fr;gap:24px}@media(max-width:1000px){.cols2{grid-template-columns:1fr}}
.anecs{display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:12px}.anec{background:var(--surface2);border-radius:8px;padding:8px 12px}.ah{font-size:12px;display:flex;gap:6px;align-items:center;flex-wrap:wrap}.anec blockquote{margin:6px 0;padding:6px 10px;background:#fff;border-radius:6px;font-size:12.5px;white-space:pre-wrap}.why{font-size:12px;color:var(--text2)}
.synth p,.synth li{max-width:1100px}.synth ul{margin:4px 0 8px 18px;padding:0}.synth li{margin:4px 0}
.hero{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:12px 0}.tile{background:var(--surface2);border-radius:10px;padding:12px 14px}.tile .k{font-size:11px;color:var(--text2);text-transform:uppercase;letter-spacing:.04em}.tile .v{font-size:24px;font-weight:600}
</style></head><body><div class="wrap">
<h1>Audit — problems, strategy &amp; communication</h1>
<div class="sub">Job <code>${esc(jobName)}</code> · ${bots.length} bots · models: ${modelOrder.map(chip).join(' &nbsp; ')} · main results report: <a href="${esc(jobName)}-report.html">${esc(jobName)}-report.html</a></div>
<div class="hero">
  <div class="tile"><div class="k">Problems logged</div><div class="v">${problems.length}</div><div class="muted">${kinds.map(k => `${k} ${kindCounts[k]}`).join(' · ')}</div></div>
  <div class="tile"><div class="k">Bots audited</div><div class="v">${bots.filter(b => b.audit).length}/${bots.length}</div></div>
  <div class="tile"><div class="k">Model stalls</div><div class="v">${(infra?.stalls ?? []).length}</div><div class="muted">gaps &gt; 3 min</div></div>
  <div class="tile"><div class="k">Anecdotes</div><div class="v">${anecdotes.length}</div></div>
</div>
${existsSync(synthesisFile) ? `<div class="synth">${md(readFileSync(synthesisFile, 'utf8'))}</div>` : ''}

<h2>Problems by model &amp; kind</h2>
${kindMatrix}
<h2>All problems hit by agents</h2>
${problemsTable}

<h2>Infra health</h2>
${infraHtml}

<h2>Strategic decisions</h2>
${stratHtml}

<h2>Communication anecdotes</h2>
${anecHtml}
</div>
<script>
(function(){
  var K='all', M='all';
  function ap(){document.querySelectorAll('#probs tbody tr').forEach(function(tr){tr.style.display=((K==='all'||tr.dataset.k===K)&&(M==='all'||tr.dataset.m===M))?'':'none';});}
  document.querySelectorAll('.pf').forEach(function(b){b.onclick=function(){document.querySelectorAll('.pf').forEach(function(x){x.classList.remove('on')});b.classList.add('on');K=b.dataset.k;ap();};});
  document.querySelectorAll('.pm').forEach(function(b){b.onclick=function(){document.querySelectorAll('.pm').forEach(function(x){x.classList.remove('on')});b.classList.add('on');M=b.dataset.m;ap();};});
  var AM='all', AQ='';
  function aa(){document.querySelectorAll('#anecs .anec').forEach(function(a){var ok=(AM==='all'||a.dataset.m===AM)&&(!AQ||a.textContent.toLowerCase().indexOf(AQ)>=0);a.style.display=ok?'':'none';});}
  document.querySelectorAll('.am').forEach(function(b){b.onclick=function(){document.querySelectorAll('.am').forEach(function(x){x.classList.remove('on')});b.classList.add('on');AM=b.dataset.m;aa();};});
  document.getElementById('aq').oninput=function(e){AQ=e.target.value.trim().toLowerCase();aa();};
})();
</script></body></html>`;
writeFileSync(outFile, html);
console.log(`wrote ${outFile} — ${problems.length} problems, ${anecdotes.length} anecdotes, ${bots.filter(b => b.audit).length}/${bots.length} bots audited${infra ? ', infra ok' : ''}`);
