#!/usr/bin/env bun
/**
 * Build team-size-report.html — the team-size sweep comparison
 * (smith/magic/crafting-team at n=1/3/6, glm-5.2 vs gemini-3.5-flash, 30m, k=1).
 *
 * Reads each job's trial reward.json (score + per-bot detail + chat count) and
 * result.json (cost), and embeds the grid videos from videos/team-size/.
 *
 * Usage: bun scripts/build-team-size-report.ts   (re-runnable; writes team-size-report.html)
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

// The 2026-07-07 sweep jobs (n6 jobs are the ARG_MAX-fix relaunches; the
// 00373x/00380x/00383x n6 dirs are dead fast-fail artifacts — excluded).
const SWEEP_JOBS = [
  'smith-team-n1-glm52-20260707-130609',
  'smith-team-n1-gemini35flash-20260707-003713',
  'smith-team-glm52-20260707-130619',
  'smith-team-gemini35flash-20260707-003723',
  'smith-team-n6-glm52-20260707-130629',
  'smith-team-n6-gemini35flash-20260707-004238',
  'magic-team-n1-glm52-20260707-130639',
  'magic-team-n1-gemini35flash-20260707-003743',
  'magic-team-glm52-20260707-130649',
  'magic-team-gemini35flash-20260707-003753',
  'magic-team-n6-glm52-20260707-130659',
  'magic-team-n6-gemini35flash-20260707-004248',
  'crafting-team-n1-glm52-20260707-130709',
  'crafting-team-n1-gemini35flash-20260707-003813',
  'crafting-team-glm52-20260707-130719',
  'crafting-team-gemini35flash-20260707-003823',
  'crafting-team-n6-glm52-20260707-130729',
  'crafting-team-n6-gemini35flash-20260707-004258',
];

const MODEL_LABELS: Record<string, string> = {
  glm52: 'GLM-5.2',
  gemini35flash: 'Gemini 3.5 Flash',
};
const MODEL_COLORS: Record<string, string> = {
  glm52: '#f778ba',
  gemini35flash: '#58a6ff',
};
const ACTIVITY_META: Record<string, { title: string; metric: string; desc: string }> = {
  smith: { title: 'Smith-team', metric: 'best item store value (gp)',
    desc: 'Smith the single most valuable item. Score = store value of the best item any team member smiths (level-gated anti-cheat).' },
  magic: { title: 'Magic-team', metric: 'best Magic level',
    desc: 'Push ONE account’s Magic level as high as possible. Score = highest Magic level on any single account.' },
  crafting: { title: 'Crafting-team', metric: 'best Crafting XP',
    desc: 'Push ONE account’s Crafting XP as high as possible. Score = highest single account’s Crafting XP.' },
};
const SIZES = [1, 3, 6];

interface Run {
  activity: string; size: number; model: string;
  reward: number; detail: string; chatCount: number;
  cost: number | null; video: string | null; perBot: string;
}

function parseJobName(name: string) {
  const m = name.match(/^(\w+)-team(?:-n(\d))?-(\w+)-\d{8}-\d{6}$/)!;
  return { activity: m[1], size: m[2] ? Number(m[2]) : 3, model: m[3] };
}

const fmt = (x: number) => x.toLocaleString('en-US');

function loadRun(jobName: string): Run {
  const { activity, size, model } = parseJobName(jobName);
  const jobDir = join('jobs', jobName);
  const trialDir = readdirSync(jobDir).map(d => join(jobDir, d)).find(d => /__/.test(d))!;
  const reward = JSON.parse(readFileSync(join(trialDir, 'verifier', 'reward.json'), 'utf-8'));
  const trial = JSON.parse(readFileSync(join(trialDir, 'result.json'), 'utf-8'));
  const cost = trial.agent_result?.context?.cost_usd ?? trial.agent_result?.cost_usd ?? null;

  let detail = '';
  let perBot = '';
  if (activity === 'smith') {
    detail = reward.bestItem
      ? `${reward.bestItem.name.replace(/_/g, ' ')} (${fmt(reward.bestItem.cost)}gp) by ${reward.bestItem.bot}`
      : 'nothing valid smithed';
    perBot = Object.entries(reward.perBot ?? {}).map(([b, v]: [string, any]) =>
      `${b}: Smithing ${v.finalSmithing?.level ?? 1} / Mining ${v.finalMining?.level ?? 1}`).join(' · ');
  } else if (activity === 'magic') {
    detail = reward.best ? `Magic ${reward.best.level} (${fmt(reward.best.xp)} xp) on ${reward.best.bot}` : 'no casting';
    perBot = Object.entries(reward.perBot ?? {}).map(([b, v]: [string, any]) =>
      `${b}: Magic ${v.magic?.level ?? 1}`).join(' · ');
  } else {
    detail = reward.topBot ? `${fmt(reward.topBot.xp)} xp (level ${reward.topBot.level}) on ${reward.topBot.bot}` : 'no crafting';
    perBot = Object.entries(reward.perBot ?? {}).map(([b, v]: [string, any]) =>
      `${b}: ${fmt(v.crafting?.xp ?? 0)} xp`).join(' · ');
  }

  const videoPath = join('videos', 'team-size',
    `${activity}-team-30m${size === 3 ? '' : `-n${size}`}-${model}.mp4`);
  return {
    activity, size, model,
    reward: reward.reward ?? 0, detail, chatCount: reward.chatCount ?? 0,
    cost, video: existsSync(videoPath) ? videoPath : null, perBot,
  };
}

const runs = SWEEP_JOBS.map(loadRun);
const get = (a: string, n: number, m: string) => runs.find(r => r.activity === a && r.size === n && r.model === m)!;
const totalCost = runs.reduce((s, r) => s + (r.cost ?? 0), 0);

// ── HTML ─────────────────────────────────────────────────────────
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

const summaryRows = Object.keys(ACTIVITY_META).flatMap(act =>
  Object.keys(MODEL_LABELS).map(model => {
    const cells = SIZES.map(n => {
      const r = get(act, n, model);
      const best = Math.max(...Object.keys(MODEL_LABELS).flatMap(m2 => SIZES.map(n2 => get(act, n2, m2).reward)));
      const hi = r.reward === best ? ' class="best"' : '';
      return `<td${hi}><b>${fmt(r.reward)}</b><span class="sub">${esc(r.detail)}</span></td>`;
    }).join('');
    return `<tr><td>${ACTIVITY_META[act].title}</td>
      <td><span class="dot" style="background:${MODEL_COLORS[model]}"></span>${MODEL_LABELS[model]}</td>${cells}</tr>`;
  }));

// Per-activity scaling bars (normalized to the activity max)
const barBlocks = Object.keys(ACTIVITY_META).map(act => {
  const max = Math.max(...runs.filter(r => r.activity === act).map(r => r.reward), 1);
  const groups = SIZES.map(n => {
    const bars = Object.keys(MODEL_LABELS).map(model => {
      const r = get(act, n, model);
      const h = Math.max(2, Math.round((r.reward / max) * 120));
      return `<div class="bar" style="height:${h}px;background:${MODEL_COLORS[model]}" title="${MODEL_LABELS[model]}: ${fmt(r.reward)}"></div>`;
    }).join('');
    return `<div class="bargroup"><div class="bars">${bars}</div><div class="barlabel">n=${n}</div></div>`;
  }).join('');
  return `<div class="chart"><h4>${ACTIVITY_META[act].title}</h4><div class="chartrow">${groups}</div>
    <div class="metric">${ACTIVITY_META[act].metric}</div></div>`;
}).join('');

const videoSections = Object.keys(ACTIVITY_META).map(act => {
  const cards = SIZES.flatMap(n => Object.keys(MODEL_LABELS).map(model => {
    const r = get(act, n, model);
    const vid = r.video
      ? `<video controls preload="none" poster="" src="${r.video}"></video>`
      : `<div class="novideo">video pending</div>`;
    return `<div class="card">
      <div class="cardhead"><span class="dot" style="background:${MODEL_COLORS[model]}"></span>
        <b>${MODEL_LABELS[model]}</b> · team of ${n}</div>
      <div class="score">${fmt(r.reward)} <span class="metric">${ACTIVITY_META[act].metric}</span></div>
      <div class="detail">${esc(r.detail)}</div>
      <div class="detail sub">${r.chatCount} chat msgs · $${(r.cost ?? 0).toFixed(2)} API</div>
      ${vid}
      <details><summary>per-bot finals</summary><div class="perbot">${esc(r.perBot)}</div></details>
    </div>`;
  }));
  return `<section><h2>${ACTIVITY_META[act].title}</h2>
    <p class="desc">${ACTIVITY_META[act].desc}</p>
    <div class="cards">${cards.join('')}</div></section>`;
}).join('');

const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RuneBench — Team-Size Sweep (n=1/3/6)</title>
<style>
  :root { color-scheme: dark; }
  body { background:#0d1117; color:#e6edf3; font:15px/1.5 -apple-system,'Segoe UI',sans-serif; margin:0; padding:32px 24px 80px; }
  main { max-width:1180px; margin:0 auto; }
  h1 { font-size:26px; margin:0 0 4px; } h2 { font-size:21px; border-bottom:1px solid #21262d; padding-bottom:6px; margin-top:48px; }
  h4 { margin:0 0 8px; color:#c9d1d9; }
  .meta, .desc, .sub, .metric { color:#8b949e; font-size:13px; }
  .desc { max-width:760px; }
  table { border-collapse:collapse; width:100%; margin:18px 0; }
  th, td { text-align:left; padding:8px 12px; border-bottom:1px solid #21262d; vertical-align:top; }
  th { color:#8b949e; font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
  td .sub { display:block; }
  td.best b { color:#7fc88a; }
  .dot { display:inline-block; width:10px; height:10px; border-radius:5px; margin-right:7px; }
  .charts { display:flex; gap:28px; flex-wrap:wrap; margin:20px 0; }
  .chart { background:#161b22; border:1px solid #21262d; border-radius:8px; padding:16px 20px; }
  .chartrow { display:flex; gap:22px; align-items:flex-end; height:130px; }
  .bargroup { display:flex; flex-direction:column; align-items:center; justify-content:flex-end; height:100%; }
  .bars { display:flex; gap:5px; align-items:flex-end; flex:1; }
  .bar { width:26px; border-radius:3px 3px 0 0; }
  .barlabel { font-size:12px; color:#8b949e; margin-top:6px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fill, minmax(340px, 1fr)); gap:18px; margin-top:16px; }
  .card { background:#161b22; border:1px solid #21262d; border-radius:8px; padding:14px 16px; }
  .cardhead { margin-bottom:6px; }
  .score { font-size:22px; font-weight:700; margin:2px 0; }
  .detail { font-size:13px; color:#c9d1d9; }
  video, .novideo { width:100%; border-radius:6px; margin-top:10px; background:#010409; }
  .novideo { padding:40px 0; text-align:center; color:#6e7681; border:1px dashed #30363d; }
  details { margin-top:8px; font-size:12px; color:#8b949e; } summary { cursor:pointer; }
  .perbot { padding:6px 2px; }
  .note { background:#161b22; border-left:3px solid #d29922; padding:10px 14px; border-radius:0 6px 6px 0; font-size:13px; color:#c9d1d9; margin:16px 0; }
</style></head><body><main>
<h1>Team-Size Sweep — 1 vs 3 vs 6 bots</h1>
<p class="meta">2026-07-07 · smith/magic/crafting-team · 30-minute horizon · k=1 ·
GLM-5.2 &amp; Gemini 3.5 Flash · one model drives every bot on its team (one OpenCode session per bot,
coordination via in-game chat only) · total API cost $${totalCost.toFixed(2)}</p>

<h2>Scores</h2>
<table><thead><tr><th>Activity</th><th>Model</th><th>Team of 1</th><th>Team of 3</th><th>Team of 6</th></tr></thead>
<tbody>${summaryRows.join('')}</tbody></table>

<div class="charts">${barBlocks}</div>

<h2>Observations</h2>
<ul>
  <li><b>Gemini 3.5 Flash beat GLM-5.2 in all nine cells</b>, usually by an order of magnitude.</li>
  <li><b>Team size helps, but sublinearly.</b> Gemini’s magic score scaled cleanly (1 → 16 → 26); its smith score
      saturated at a steel platebody for both n=3 and n=6 — six miners banked ~4M combined Mining XP that the single
      designated smith couldn’t convert into a higher tier within 30 minutes.</li>
  <li><b>Coordination overhead can go negative:</b> GLM’s 6-bot smith run scored <i>below</i> its 3-bot run
      (28 vs 125 gp) — 1,550 chat messages and a designated smith that only reached Smithing 21.</li>
  <li>Single trials (k=1): treat gaps smaller than ~2× as noise (e.g. gemini crafting n=1 vs n=3).</li>
</ul>
<div class="note">The six original n=6 launches fast-failed before any agent ran (the team adapter’s exec command
exceeded Modal’s 64&nbsp;KB ARG_MAX with six inlined instructions) and were relaunched with the fix —
their dead job dirs are excluded here.</div>

${videoSections}
</main></body></html>
`;

writeFileSync('team-size-report.html', html);
console.log(`Wrote team-size-report.html (${runs.length} runs, ${runs.filter(r => r.video).length} videos found)`);
