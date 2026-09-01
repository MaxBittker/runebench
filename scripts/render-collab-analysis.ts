/**
 * Renders collaboration-analysis.html from the team-collab-analysis workflow output.
 * Input: /tmp/collab-payload.json = { perRun: [...], synthesis: {...} }  (env PAYLOAD to override)
 * Output: collaboration-analysis.html (env OUT to override)
 */
import { readFileSync, writeFileSync } from 'fs';

const PAYLOAD = process.env.PAYLOAD || '/tmp/collab-payload.json';
const OUT = process.env.OUT || 'collaboration-analysis.html';
const { perRun, synthesis } = JSON.parse(readFileSync(PAYLOAD, 'utf-8'));

const esc = (s: string) => (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');

// Minimal markdown → HTML for the synthesis fields.
function md(src: string): string {
  const lines = (src || '').split('\n');
  const out: string[] = []; let list: 'ul' | 'ol' | null = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { closeList(); continue; }
    let m;
    if ((m = line.match(/^\s*###\s+(.*)/))) { closeList(); out.push(`<h4>${inline(m[1])}</h4>`); }
    else if ((m = line.match(/^\s*##\s+(.*)/))) { closeList(); out.push(`<h3>${inline(m[1])}</h3>`); }
    else if ((m = line.match(/^\s*[-*]\s+(.*)/))) { if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); }
    else if ((m = line.match(/^\s*\d+\.\s+(.*)/))) { if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(m[1])}</li>`); }
    else { closeList(); out.push(`<p>${inline(line)}</p>`); }
  }
  closeList();
  return out.join('\n');
}

const DISPLAY: Record<string, string> = {
  glm52: 'GLM-5.2', gemini35flash: 'Gemini-3.5-Flash', opus48: 'Claude Opus 4.8',
  gpt55: 'GPT-5.5', gpt54mini: 'GPT-5.4-mini', sonnet5: 'Claude Sonnet 5',
};
const modeBadge = (mode: string) => {
  const c = mode === 'single-carry' ? '#f85149' : mode === 'genuine-division' ? '#3fb950' : '#e3b341';
  return `<span class="badge" style="background:${c}22;color:${c};border-color:${c}55">${esc(mode)}</span>`;
};

// Summary table
const order = ['smith-team', 'magic-team', 'crafting-team'];
const sorted = [...perRun].sort((a, b) => order.indexOf(a.event) - order.indexOf(b.event) || b.collaboration?.effectiveness - a.collaboration?.effectiveness || (b.effectiveness ?? 0) - (a.effectiveness ?? 0));
const tableRows = sorted.map(r => {
  const c = r.collaboration || {};
  return `<tr>
    <td>${esc(r.event)}</td>
    <td><b>${esc(DISPLAY[r.model] || r.model)}</b></td>
    <td>${modeBadge(c.mode || '?')}</td>
    <td class="muted">${esc(c.carryBot || '—')}</td>
    <td>${c.meaningfulHelp ? '✅' : '❌'}</td>
    <td class="score">${r.effectiveness ?? '—'}<span class="muted">/10</span></td>
    <td class="muted small">${esc((c.contributionSplit || '').slice(0, 120))}</td>
  </tr>`;
}).join('\n');

const cards = sorted.map(r => {
  const c = r.collaboration || {};
  const li = (arr: string[]) => (arr || []).map(x => `<li>${inline(x)}</li>`).join('');
  return `<div class="card">
    <div class="card-h"><b>${esc(DISPLAY[r.model] || r.model)}</b> <span class="muted">· ${esc(r.event)} · ${modeBadge(c.mode || '?')} · effectiveness ${r.effectiveness ?? '—'}/10 · ${esc(r.commStyle || '')}</span></div>
    <p><b>Communication:</b> ${inline(r.commStrategy || '')}</p>
    <p><b>Collaboration:</b> ${inline(c.contributionSplit || '')} <span class="muted">${inline(c.evidence || '')}</span></p>
    <div class="two">
      <div><span class="lbl">Issues encountered</span><ul>${li(r.issuesEncountered)}</ul></div>
      <div><span class="lbl warn">Chat / SDK issues</span><ul>${li(r.chatSdkIssues)}</ul></div>
    </div>
    ${(r.keyQuotes || []).length ? `<details><summary>key chat lines</summary><pre>${(r.keyQuotes || []).map(esc).join('\n')}</pre></details>` : ''}
  </div>`;
}).join('\n');

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>RuneBench — Team Collaboration Analysis</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; background:#0d1117; color:#e6edf3; font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  .wrap { max-width:1000px; margin:0 auto; padding:32px 20px 80px; }
  h1 { font-size:29px; margin:0 0 4px; letter-spacing:-.5px; }
  h2 { font-size:21px; margin:42px 0 6px; border-bottom:1px solid #21262d; padding-bottom:8px; }
  h3 { font-size:17px; margin:20px 0 4px; color:#e6edf3; }
  h4 { font-size:15px; margin:14px 0 2px; color:#adbac7; }
  a { color:#58a6ff; }
  .sub { color:#8b949e; margin:0 0 16px; }
  p { color:#c9d1d9; }
  table { width:100%; border-collapse:collapse; margin:12px 0; }
  th { text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.5px; color:#8b949e; border-bottom:1px solid #21262d; padding:8px; }
  td { padding:9px 8px; border-bottom:1px solid #161b22; vertical-align:top; }
  td.score { font-weight:700; }
  .muted { color:#8b949e; font-weight:400; } .small { font-size:12px; }
  .badge { display:inline-block; padding:1px 8px; border-radius:20px; font-size:12px; border:1px solid; }
  .card { background:#161b22; border:1px solid #21262d; border-radius:10px; padding:14px 16px; margin:12px 0; }
  .card-h { font-size:15px; margin-bottom:6px; }
  .card p { margin:6px 0; font-size:14px; }
  .two { display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-top:8px; }
  @media(max-width:680px){ .two{ grid-template-columns:1fr; } }
  .lbl { font-size:11px; text-transform:uppercase; letter-spacing:.5px; color:#8b949e; } .lbl.warn { color:#e3b341; }
  .two ul { margin:4px 0; padding-left:18px; } .two li { font-size:13px; margin:4px 0; color:#c9d1d9; }
  ul li, ol li { margin:6px 0; color:#c9d1d9; }
  details { margin-top:8px; } summary { cursor:pointer; color:#8b949e; font-size:13px; }
  pre { background:#0d1117; border:1px solid #21262d; border-radius:6px; padding:10px; overflow-x:auto; font-size:12px; white-space:pre-wrap; }
  code { background:#21262d; padding:1px 5px; border-radius:4px; font-size:13px; }
  .box { background:linear-gradient(180deg,#161b22,#12161d); border:1px solid #2d333b; border-radius:12px; padding:2px 22px 14px; margin:16px 0; }
  .foot { color:#6e7681; font-size:12px; margin-top:40px; border-top:1px solid #21262d; padding-top:14px; }
</style></head><body><div class="wrap">
  <h1>Team Collaboration Analysis</h1>
  <p class="sub">How 6 models coordinated across 12 three-bot runs · <a href="team-events-report.html">← back to scores &amp; level charts</a></p>

  <div class="box">${md(synthesis.overview)}</div>

  <h2>Per-run collaboration verdict</h2>
  <table><thead><tr><th>Event</th><th>Model</th><th>Mode</th><th>Carry bot</th><th>Real help?</th><th>Score</th><th>Contribution split</th></tr></thead>
  <tbody>${tableRows}</tbody></table>

  <h2>Did they meaningfully help each other?</h2>
  ${md(synthesis.collaboration)}

  <h2>Communication strategies</h2>
  ${md(synthesis.commStrategies)}

  <h2>Issues encountered</h2>
  ${md(synthesis.issues)}

  <h2>Chat / SDK-layer issues <span class="muted" style="font-size:14px">— for the SDK maintainer</span></h2>
  ${md(synthesis.chatSdkIssues)}

  <h2>Bottom line</h2>
  ${md(synthesis.verdict)}

  <h2>Per-run detail</h2>
  ${cards}

  <div class="foot">Generated by the <code>team-collab-analysis</code> workflow (12 parallel run-analyzers → 1 synthesizer) over each run's chat transcript, <code>reward.json</code> per-bot outcomes, and agent-log SDK-error signatures.</div>
</div></body></html>`;

writeFileSync(OUT, html);
console.log(`Wrote ${OUT} (${perRun.length} runs)`);
