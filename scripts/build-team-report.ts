/**
 * Renders team-events-report.html from fetched smith-team / magic-team results.
 * Invoked by build-team-report.sh (env: LOCAL = fetched-results dir, OUT = html path).
 * Re-runnable: renders whatever completed jobs are present, marks the rest pending.
 */
import { readFileSync, existsSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const LOCAL = process.env.LOCAL || '/tmp/team-results';
const OUT = process.env.OUT || 'team-events-report.html';

const DISPLAY: Record<string, string> = {
  opus48: 'Claude Opus 4.8', opus47: 'Claude Opus 4.7', opus: 'Claude Opus 4.6', opus45: 'Claude Opus 4.5',
  sonnet5: 'Claude Sonnet 5', sonnet46: 'Claude Sonnet 4.6', sonnet45: 'Claude Sonnet 4.5', haiku: 'Claude Haiku 4.5',
  fable5: 'Claude Fable 5', codex53: 'GPT-5.3-Codex', gpt55: 'GPT-5.5', gpt54: 'GPT-5.4',
  gpt54mini: 'GPT-5.4-mini', gpt54nano: 'GPT-5.4-nano', gemini: 'Gemini 3 Pro', gemini31: 'Gemini 3.1 Pro',
  geminiflash: 'Gemini 3 Flash', gemini35flash: 'Gemini 3.5 Flash', glm: 'GLM-5', glm52: 'GLM-5.2',
  kimi: 'Kimi K2.5', qwen3: 'Qwen3-Coder-Next', qwen35: 'Qwen3.5-35B', qwen3max: 'Qwen3-Max',
};
// Provider brand color per model (drives the leaderboard dot + outcome bars).
const C = { anthropic: '#d97757', openai: '#10a37f', gemini: '#4285f4', glm: '#22c55e', kimi: '#a855f7', qwen: '#f59e0b' };
const PROVIDER: Record<string, string> = {
  opus48: C.anthropic, opus47: C.anthropic, opus: C.anthropic, opus45: C.anthropic,
  sonnet5: C.anthropic, sonnet46: C.anthropic, sonnet45: C.anthropic, haiku: C.anthropic, fable5: C.anthropic,
  codex53: C.openai, gpt55: C.openai, gpt54: C.openai, gpt54mini: C.openai, gpt54nano: C.openai,
  gemini: C.gemini, gemini31: C.gemini, geminiflash: C.gemini, gemini35flash: C.gemini,
  glm: C.glm, glm52: C.glm, kimi: C.kimi, qwen3: C.qwen, qwen35: C.qwen, qwen3max: C.qwen,
};
// Every model we launched, so the report shows pending/failed ones too.
const ROSTER = ['opus48', 'opus47', 'opus', 'opus45', 'sonnet5', 'sonnet46', 'sonnet45', 'haiku', 'fable5',
  'codex53', 'gpt55', 'gpt54', 'gpt54mini', 'gpt54nano', 'gemini', 'gemini31', 'geminiflash', 'gemini35flash',
  'glm', 'glm52', 'kimi', 'qwen3', 'qwen35', 'qwen3max'];

// Skills to chart per event: [primary (solid), secondary (dashed)]
const SKILL_CFG: Record<string, { k: string; label: string; dash: boolean }[]> = {
  'magic-team': [{ k: 'magic', label: 'Magic', dash: false }, { k: 'hitpoints', label: 'HP', dash: true }],
  'smith-team': [{ k: 'smithing', label: 'Smithing', dash: false }, { k: 'mining', label: 'Mining', dash: true }],
  'crafting-team': [{ k: 'crafting', label: 'Crafting', dash: false }],
};

interface Row {
  label: string; task: 'smith-team' | 'magic-team' | 'crafting-team'; ts: string;
  reward: number; costUsd: number | null; inTok: number | null; outTok: number | null;
  reward_detail: any; perBot: any; chatCount: number; chat: string;
  bots: string[]; samples: any[];
  firstMs: number | null; // smith-team: when the score-setting item was first smithed
}

function parseJob(job: string): Row | null {
  const m = job.match(/^(smith-team|magic-team|crafting-team)-(.+)-(\d{8}-\d{6})$/);
  if (!m) return null;
  const task = m[1] as Row['task'];
  const label = m[2];
  const ts = m[3];
  const dir = join(LOCAL, job);
  const readJson = (p: string) => { try { return JSON.parse(readFileSync(join(dir, p), 'utf-8')); } catch { return null; } };
  const reward = readJson('verifier/reward.json');
  if (!reward) return null;
  const result = readJson('result.json');
  const chatPath = join(dir, 'verifier/chat-transcript.txt');
  const chat = existsSync(chatPath) ? readFileSync(chatPath, 'utf-8') : '';

  // Downsample the watcher time-series to ~90 points/line for the level charts.
  const raw = reward.tracking?.samples ?? [];
  const bots: string[] = reward.tracking?.botNames ?? ['agenta', 'agentb', 'agentc'];
  const cfg = SKILL_CFG[task];
  const step = Math.max(1, Math.floor(raw.length / 90));
  const samples: any[] = [];
  for (let i = 0; i < raw.length; i += step) {
    const s = raw[i]; const pt: any = { t: s.elapsedMs };
    for (const b of bots) { pt[b] = {}; for (const sc of cfg) pt[b][sc.k] = s.bots?.[b]?.[sc.k]?.level ?? null; }
    samples.push(pt);
  }
  if (raw.length && samples[samples.length - 1]?.t !== raw[raw.length - 1].elapsedMs) {
    const s = raw[raw.length - 1]; const pt: any = { t: s.elapsedMs };
    for (const b of bots) { pt[b] = {}; for (const sc of cfg) pt[b][sc.k] = s.bots?.[b]?.[sc.k]?.level ?? null; }
    samples.push(pt);
  }

  // Smith-team tiebreak input: earliest valid "gained" event at the winning cost
  // (bestItem.elapsedMs isn't guaranteed to be the first occurrence of the item).
  let firstMs: number | null = null;
  if (task === 'smith-team' && (reward.reward ?? 0) > 0) {
    const times = (reward.events ?? [])
      .filter((e: any) => e.event === 'gained' && e.valid && e.cost === reward.reward && e.elapsedMs != null)
      .map((e: any) => e.elapsedMs);
    firstMs = times.length ? Math.min(...times) : (reward.bestItem?.elapsedMs ?? null);
  }

  return {
    label, task, ts,
    reward: reward.reward ?? 0,
    costUsd: result?.agent_result?.cost_usd ?? null,
    inTok: result?.agent_result?.n_input_tokens ?? null,
    outTok: result?.agent_result?.n_output_tokens ?? null,
    reward_detail: task === 'smith-team' ? reward.bestItem
      : task === 'crafting-team' ? { totalXp: reward.totalXp, topBot: reward.topBot, topShare: reward.topShare }
      : reward.best,
    perBot: reward.perBot ?? {},
    chatCount: reward.chatCount ?? 0,
    chat, bots, samples, firstMs,
  };
}

const jobs = existsSync(LOCAL) ? readdirSync(LOCAL).filter(d => /(smith|magic|crafting)-team-/.test(d)) : [];
const allRows = jobs.map(parseJob).filter(Boolean) as Row[];
// Dedupe: keep the newest run per (task,label) so re-runs supersede old data.
const newest = new Map<string, Row>();
for (const r of allRows) {
  const key = `${r.task}|${r.label}`;
  const prev = newest.get(key);
  if (!prev || r.ts > prev.ts) newest.set(key, r);
}
const rows = [...newest.values()];
const byTask = (t: string) => rows.filter(r => r.task === t);

const esc = (s: string) => (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const dn = (l: string) => DISPLAY[l] ?? l;
const fmt = (n: number | null, d = 2) => n == null ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: d });
const usd = (n: number | null) => n == null ? '—' : '$' + n.toFixed(2);
const medal = (i: number) => ['🥇', '🥈', '🥉'][i] ?? `${i + 1}`;
const mmss = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

// Reward ties: magic saturates at level 99, so break by best-account XP;
// smith ties (same item value) break by who first smithed the item — earlier wins.
const xpOf = (r: Row) => r.reward_detail?.xp ?? 0;
const rankCmp = (task: string) => (a: Row, b: Row) =>
  b.reward - a.reward ||
  (task === 'smith-team' ? (a.firstMs ?? Infinity) - (b.firstMs ?? Infinity) : xpOf(b) - xpOf(a));

// Grid timelapse video for a run, if it was generated (videos/<task>-<label>.mp4).
const VIDEO_DIR = process.env.VIDEO_DIR || 'videos';
function videoTag(r: Row): string {
  const rel = `${VIDEO_DIR}/${r.task}-${r.label}.mp4`;
  if (!existsSync(rel)) return '';
  return `<video class="grid-vid" controls preload="none" playsinline src="${rel}"></video>
    <div class="vidcap muted">3-bot grid timelapse (agenta · agentb · agentc) — 45min run compressed to ~8min. <a href="${rel}">open ↗</a></div>`;
}

// Per-task outcome bar chart: reward by model, tallest first, colored by provider.
function outcomeBars(task: 'smith-team' | 'magic-team' | 'crafting-team'): string {
  const done = byTask(task).filter(r => r.reward > 0).sort(rankCmp(task));
  if (!done.length) return '';
  const max = Math.max(...done.map(r => r.reward));
  const rowH = 22, gap = 6, PL = 132, PR = 60, W = 720;
  const H = done.length * (rowH + gap) + 10;
  const bars = done.map((r, i) => {
    const yy = 6 + i * (rowH + gap);
    const w = Math.max(2, (r.reward / max) * (W - PL - PR));
    const col = PROVIDER[r.label] ?? '#888';
    return `<text x="${PL - 8}" y="${yy + rowH / 2 + 4}" text-anchor="end" class="bl">${esc(dn(r.label))}</text>
      <rect x="${PL}" y="${yy}" width="${w.toFixed(1)}" height="${rowH}" rx="3" fill="${col}"/>
      <text x="${PL + w + 6}" y="${yy + rowH / 2 + 4}" class="bv">${fmt(r.reward, 0)}</text>`;
  }).join('');
  const unit = task === 'smith-team' ? 'best item value (gp)' : task === 'magic-team' ? 'best Magic level' : 'best Crafting XP';
  return `<svg viewBox="0 0 ${W} ${H}" class="bars" role="img" aria-label="${unit} by model">${bars}</svg>
    <div class="barcap muted">${unit} · ${done.length} models scored</div>`;
}

function leaderboard(task: 'smith-team' | 'magic-team' | 'crafting-team') {
  const done = byTask(task).sort(rankCmp(task));
  const doneLabels = new Set(done.map(d => d.label));
  const pending = ROSTER.filter(l => !doneLabels.has(l));
  const scoreHead = task === 'magic-team' ? 'Best Magic level'
    : task === 'crafting-team' ? 'Best Crafting XP (any account)'
    : 'Best item (gp)';

  const bodyRows = done.map((r, i) => {
    const d = r.reward_detail || {};
    const split = r.bots.map(b => fmt(r.perBot?.[b]?.crafting?.xp, 0)).join(' + ');
    const detail = task === 'magic-team'
      ? `Magic <b>${d.level ?? r.reward}</b> · ${fmt(d.xp, 0)} xp <span class="muted">(${d.bot ?? '?'})</span>`
      : task === 'crafting-team'
      ? `Crafting <b>${d.topBot?.level ?? '?'}</b> · ${fmt(d.topBot?.xp ?? r.reward, 0)} xp <span class="muted">(${d.topBot?.bot ?? '?'}; split ${split})</span>`
      : `<b>${esc(d.name ?? '—')}</b> · ${fmt(d.cost ?? r.reward, 0)}gp <span class="muted">(${d.bot ?? '?'}, smith ${d.smithingLevel ?? '?'}${r.firstMs != null ? `, first at ${mmss(r.firstMs)}` : ''})</span>`;
    return `<tr>
      <td class="rank">${medal(i)}</td>
      <td><span class="dot" style="background:${PROVIDER[r.label] ?? '#888'}"></span>${esc(dn(r.label))}</td>
      <td class="score">${fmt(r.reward, 0)}</td>
      <td>${detail}</td>
      <td>${usd(r.costUsd)}</td>
      <td class="muted">${fmt(r.outTok, 0)} out</td>
    </tr>`;
  }).join('\n');

  const pendingRows = pending.map(l => `<tr class="pending">
      <td class="rank">⏳</td><td><span class="dot" style="background:${PROVIDER[l] ?? '#888'}"></span>${esc(dn(l))}</td>
      <td colspan="4" class="muted">running…</td></tr>`).join('\n');

  return `<table>
    <thead><tr><th></th><th>Model</th><th>Score</th><th>${scoreHead}</th><th>Cost</th><th>Output</th></tr></thead>
    <tbody>${bodyRows}${pendingRows}</tbody>
  </table>`;
}

const BOT_COLORS: Record<string, string> = { agenta: '#58a6ff', agentb: '#3fb950', agentc: '#f778ba' };

// Inline SVG line chart: level (y, 1–99) vs elapsed time (x), one line per bot
// per tracked skill (solid = primary skill, dashed = secondary).
function levelChart(r: Row): string {
  const S = r.samples;
  if (!S || S.length < 2) return '';
  const cfg = SKILL_CFG[r.task];
  const W = 520, H = 210, PL = 30, PR = 96, PT = 12, PB = 24;
  const maxT = S[S.length - 1].t || 1;
  const x = (t: number) => PL + (t / maxT) * (W - PL - PR);
  const y = (lvl: number) => H - PB - ((Math.max(1, lvl) - 1) / 98) * (H - PT - PB);

  const grid: string[] = [];
  for (const lv of [1, 25, 50, 75, 99]) {
    grid.push(`<line x1="${PL}" y1="${y(lv)}" x2="${W - PR}" y2="${y(lv)}" stroke="#21262d"/>`);
    grid.push(`<text x="${PL - 4}" y="${y(lv) + 3}" text-anchor="end" class="ax">${lv}</text>`);
  }
  const mins = Math.round(maxT / 60000);
  for (let mm = 0; mm <= mins; mm += 15) {
    const t = mm * 60000;
    grid.push(`<text x="${x(t)}" y="${H - 8}" text-anchor="middle" class="ax">${mm}m</text>`);
  }

  const lines: string[] = [];
  for (const b of r.bots) {
    const color = BOT_COLORS[b] ?? '#8b949e';
    for (const sc of cfg) {
      const pts = S.filter(s => s[b]?.[sc.k] != null).map(s => `${x(s.t).toFixed(1)},${y(s[b][sc.k]).toFixed(1)}`);
      if (pts.length < 2) continue;
      lines.push(`<polyline fill="none" stroke="${color}" stroke-width="${sc.dash ? 1.3 : 2}" ${sc.dash ? 'stroke-dasharray="3,3" opacity="0.6"' : ''} points="${pts.join(' ')}"/>`);
    }
  }

  let ly = PT + 6; const legend: string[] = [];
  for (const b of r.bots) {
    legend.push(`<line x1="${W - PR + 6}" y1="${ly}" x2="${W - PR + 22}" y2="${ly}" stroke="${BOT_COLORS[b] ?? '#8b949e'}" stroke-width="2"/><text x="${W - PR + 26}" y="${ly + 3}" class="lg">${b}</text>`);
    ly += 16;
  }
  ly += 4;
  for (const sc of cfg) {
    legend.push(`<line x1="${W - PR + 6}" y1="${ly}" x2="${W - PR + 22}" y2="${ly}" stroke="#8b949e" stroke-width="${sc.dash ? 1.3 : 2}" ${sc.dash ? 'stroke-dasharray="3,3"' : ''}/><text x="${W - PR + 26}" y="${ly + 3}" class="lg">${sc.label}</text>`);
    ly += 16;
  }

  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="level over time">
    ${grid.join('')}${lines.join('')}${legend.join('')}
  </svg>`;
}

function perBotCard(r: Row) {
  const bots = Object.keys(r.perBot);
  const cells = bots.map(b => {
    const pb = r.perBot[b];
    if (r.task === 'magic-team') {
      return `<div class="bot"><span class="botname">${b}</span> Magic <b>${pb?.magic?.level ?? '?'}</b> <span class="muted">(${fmt(pb?.magic?.xp, 0)} xp)</span></div>`;
    }
    if (r.task === 'crafting-team') {
      return `<div class="bot"><span class="botname">${b}</span> Crafting <b>${pb?.crafting?.level ?? '?'}</b> <span class="muted">(${fmt(pb?.crafting?.xp, 0)} xp)</span></div>`;
    }
    return `<div class="bot"><span class="botname">${b}</span> Smith <b>${pb?.finalSmithing?.level ?? '?'}</b> / Mine <b>${pb?.finalMining?.level ?? '?'}</b> <span class="muted">${pb?.bestValidItem ? '· best ' + esc(pb.bestValidItem.name) : ''}</span></div>`;
  }).join('');
  const chatLines = r.chat.trim().split('\n').filter(Boolean);
  const chatSample = chatLines.slice(0, 8).map(esc).join('\n');
  const more = chatLines.length > 8 ? `\n… ${chatLines.length - 8} more messages` : '';
  return `<div class="card">
    <div class="card-h"><span class="dot" style="background:${PROVIDER[r.label] ?? '#888'}"></span><b>${esc(dn(r.label))}</b>
      <span class="muted">— ${r.task} · score ${fmt(r.reward, 0)} · ${usd(r.costUsd)} · ${r.chatCount} msgs</span></div>
    <div class="bots">${cells}</div>
    ${videoTag(r)}
    ${levelChart(r)}
    ${chatLines.length ? `<details><summary>chat (${chatLines.length})</summary><pre>${chatSample}${esc(more)}</pre></details>` : ''}
  </div>`;
}

const nDone = rows.length, nTotal = ROSTER.length * 3;
const nVideos = rows.filter(r => existsSync(`${VIDEO_DIR}/${r.task}-${r.label}.mp4`)).length;
const magicRows = byTask('magic-team');
const magicTop = magicRows.length ? Math.max(...magicRows.map(r => r.reward)) : 0;
const magicMin = magicRows.length ? Math.min(...magicRows.map(r => r.reward)) : 0;
const smithMagicDone = byTask('smith-team').length + byTask('magic-team').length;
const now = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>RuneBench — Team Events Report</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; background:#0d1117; color:#e6edf3; font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  .wrap { max-width:1000px; margin:0 auto; padding:32px 20px 80px; }
  h1 { font-size:30px; margin:0 0 4px; letter-spacing:-.5px; }
  h2 { font-size:20px; margin:44px 0 6px; border-bottom:1px solid #21262d; padding-bottom:8px; }
  .sub { color:#8b949e; margin:0 0 8px; }
  .prog { display:inline-block; background:#161b22; border:1px solid #21262d; border-radius:20px; padding:4px 14px; font-size:13px; color:#8b949e; }
  p.lead { color:#adbac7; }
  table { width:100%; border-collapse:collapse; margin:12px 0 8px; }
  th { text-align:left; font-size:12px; text-transform:uppercase; letter-spacing:.5px; color:#8b949e; border-bottom:1px solid #21262d; padding:8px 10px; }
  td { padding:10px; border-bottom:1px solid #161b22; }
  td.rank { font-size:18px; width:44px; text-align:center; }
  td.score { font-weight:700; font-size:17px; }
  tr.pending td { color:#6e7681; }
  .dot { display:inline-block; width:9px; height:9px; border-radius:50%; margin-right:8px; vertical-align:middle; }
  .muted { color:#8b949e; font-weight:400; }
  .card { background:#161b22; border:1px solid #21262d; border-radius:10px; padding:14px 16px; margin:12px 0; }
  .card-h { font-size:15px; margin-bottom:8px; }
  .bots { display:grid; grid-template-columns:1fr; gap:4px; margin:6px 0; }
  .bot { font-size:13.5px; }
  .botname { display:inline-block; min-width:60px; color:#58a6ff; font-family:ui-monospace,monospace; }
  details { margin-top:8px; }
  summary { cursor:pointer; color:#8b949e; font-size:13px; }
  pre { background:#0d1117; border:1px solid #21262d; border-radius:6px; padding:10px; overflow-x:auto; font-size:12px; white-space:pre-wrap; margin:8px 0 0; }
  .findings { background:linear-gradient(180deg,#161b22,#12161d); border:1px solid #2d333b; border-radius:12px; padding:6px 22px 14px; margin:22px 0 4px; }
  .findings h3 { font-size:16px; margin:16px 0 4px; color:#e3b341; }
  .findings ul { margin:6px 0; padding-left:20px; }
  .findings li { margin:9px 0; color:#c9d1d9; }
  .chart { width:100%; max-width:560px; height:auto; margin:10px 0 2px; display:block; }
  .chart .ax { fill:#6e7681; font-size:9px; }
  .chart .lg { fill:#adbac7; font-size:10px; }
  .grid-vid { width:100%; max-width:720px; border:1px solid #21262d; border-radius:8px; margin:10px 0 2px; display:block; background:#000; }
  .vidcap, .barcap { font-size:12px; margin:2px 0 6px; }
  .vidcap a, .barcap a { color:#58a6ff; }
  .bars { width:100%; max-width:720px; height:auto; margin:8px 0 2px; display:block; }
  .bars .bl { fill:#adbac7; font-size:11px; }
  .bars .bv { fill:#e6edf3; font-size:11px; font-weight:600; }
  .foot { color:#6e7681; font-size:12px; margin-top:40px; border-top:1px solid #21262d; padding-top:14px; }
  code { background:#21262d; padding:1px 5px; border-radius:4px; font-size:13px; }
</style></head><body><div class="wrap">
  <h1>RuneBench — Team Events</h1>
  <p class="sub">One model drives three cooperating bots. Generated ${now}</p>
  <span class="prog">${nDone} / ${nTotal} runs complete · ${nVideos} grid videos</span>
  &nbsp;<a href="collaboration-analysis.html" style="color:#58a6ff">→ Team collaboration analysis</a>

  <div class="findings">
    <h3>Setup — homogeneous, from scratch</h3>
    <p>Every bot starts <b>identical</b>: a bronze pickaxe, a bronze axe, and level-30 Attack/Strength/Defence/Hitpoints — <b>no coins, runes, ore, materials, or processing tools</b>, and no pre-assigned leader. Each event is a bootstrap-an-economy-from-nothing challenge (mine/fight/earn → buy/craft the resource → funnel it to one specialist), so scores are low and hard-won and cooperation is load-bearing. See the <a href="collaboration-analysis.html">collaboration analysis</a> for how each team communicated and whether a real gather→supply→specialist chain actually emerged.</p>
  </div>

  <h2>⚒️ Smith-Team <span class="muted" style="font-size:14px">— highest-value item forged in 45 min</span></h2>
  <p class="lead">Score = store value (gp) of the single most valuable item the team legitimately smiths; ties break by who smithed that item <b>first</b>. Rewards role specialization: two miners feeding one dedicated smith who climbs the metal tiers.</p>
  ${leaderboard('smith-team')}
  ${outcomeBars('smith-team')}

  <h2>✨ Magic-Team <span class="muted" style="font-size:14px">— highest Magic level on any account in 45 min</span></h2>
  <p class="lead">Score = the best single account's final Magic level. Casting needs runes and the team starts with <b>none</b> — they must earn coins (combat/thieving) and buy runes, or mine essence and runecraft, then funnel them to one caster. It's a brutal bootstrap: the top account this round reached only <b>Magic ${magicTop}</b>, and the weakest team ended at <b>Magic ${magicMin}</b>.</p>
  ${leaderboard('magic-team')}
  ${outcomeBars('magic-team')}

  <h2>🧵 Crafting-Team <span class="muted" style="font-size:14px">— highest Crafting XP on any account in 45 min</span></h2>
  <p class="lead">Score = the best single account's Crafting XP (the <b>max</b>, like magic-team). The team starts with <b>no materials or tools</b> — they bootstrap from shearing sheep + spinning wool (free), then earn coins to buy a needle/chisel and gather cowhides/gems. The per-bot split shows how lopsided each team went.</p>
  ${leaderboard('crafting-team')}
  ${outcomeBars('crafting-team')}

  <h2>Per-model detail</h2>
  ${rows.length ? rows.sort((a,b)=> a.task.localeCompare(b.task) || b.reward-a.reward).map(perBotCard).join('\n') : '<p class="muted">No completed runs yet.</p>'}

  <div class="foot">
    RuneBench v3 · smith-team &amp; magic-team on Modal · reward from each run's <code>verifier/reward.json</code>.
    Re-run <code>scripts/build-team-report.sh</code> to refresh as more runs finish.
  </div>
</div></body></html>`;

writeFileSync(OUT, html);
console.log(`Rendered ${nDone}/${nTotal} runs → ${OUT}`);
