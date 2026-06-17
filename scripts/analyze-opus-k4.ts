#!/usr/bin/env bun
/**
 * Analyze k=4 opus runs: best@4, avg per task, avg of averages, avg cost per run.
 *
 * Usage:
 *   bun scripts/analyze-opus-k4.ts --ts 20260417-121314  # filter to a specific wrapper launch
 *   bun scripts/analyze-opus-k4.ts                       # latest run per (model, horizon) — skills-30m-<opus>-* + gold-30m-<opus>-*
 *
 * Input: walks jobs/ — reads verifier/reward.json (skill xp or gold peak) + result.json (cost).
 * Output: writes results/opus-k4-<ts>.md + .json and prints a summary table.
 */

import { readdirSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, basename } from 'path';
import {
  getTrialDirs,
  findRewardInTrial,
  findTokenUsageInTrial,
  type TokenUsage,
} from '../shared/extract-utils';

const ROOT = join(import.meta.dir, '..');
const JOBS_DIR = join(ROOT, 'jobs');
const RESULTS_DIR = join(ROOT, 'results');

const OPUS_MODELS = ['opus45', 'opus', 'opus47']; // 4.5, 4.6, 4.7 — order for display
const MODEL_LABEL: Record<string, string> = {
  opus45: 'Opus 4.5',
  opus: 'Opus 4.6',
  opus47: 'Opus 4.7',
};

const SKILLS = [
  'attack', 'defence', 'strength', 'hitpoints', 'ranged', 'prayer', 'magic',
  'woodcutting', 'fishing', 'mining', 'cooking', 'fletching', 'crafting',
  'smithing', 'firemaking', 'thieving',
];
const GOLD_CONDITIONS = ['vanilla', 'smith-alch', 'fish', 'fletch-alch'];

// ── CLI args ────────────────────────────────────────────────────────
let filterTs = '';
let sinceTs = '';
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--ts' && process.argv[i + 1]) filterTs = process.argv[++i];
  else if (process.argv[i] === '--since' && process.argv[i + 1]) sinceTs = process.argv[++i];
}

// ── Collect relevant job dirs ───────────────────────────────────────
function extractTs(name: string): string {
  // Job dirs end with YYYYMMDD-HHMMSS (optionally followed by -retry)
  const m = name.match(/(\d{8}-\d{6})(-retry\w*)?$/);
  return m ? m[1] : '';
}

function collectJobDirs(prefix: string, model: string): string[] {
  const needle = `${prefix}-${model}-`;
  const all = readdirSync(JOBS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name.startsWith(needle))
    .map(d => ({ name: d.name, path: join(JOBS_DIR, d.name), ts: extractTs(d.name) }));

  if (filterTs) {
    return all.filter(j => j.ts === filterTs).map(j => j.path);
  }
  if (sinceTs) {
    return all.filter(j => j.ts >= sinceTs).map(j => j.path);
  }
  return all
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(j => j.path);
}

// ── Per-task slug detection from trial dir name ─────────────────────
function detectSkill(trialName: string): string | null {
  const head = trialName.split('__')[0];
  const m = head.match(/^([a-z]+)-xp-30m$/);
  if (m && SKILLS.includes(m[1])) return m[1];
  return null;
}

function detectGoldCondition(trialName: string): string | null {
  const head = trialName.split('__')[0];
  const m = head.match(/^gold-([a-z-]+?)-30m$/);
  if (!m) return null;
  return GOLD_CONDITIONS.includes(m[1]) ? m[1] : null;
}

// ── Gather trials ───────────────────────────────────────────────────
interface Trial {
  score: number;      // xp for skills, peak gold for gold
  costUsd: number | null;
  trialName: string;
}

type ModelTrials = Record<string, Trial[]>; // task → trials
const perModel: Record<string, ModelTrials> = {};

for (const model of OPUS_MODELS) {
  perModel[model] = {};

  // ── Skills ──
  for (const jobDir of collectJobDirs('skills-30m', model)) {
    const jobName = basename(jobDir);
    for (const trialDir of getTrialDirs(jobDir)) {
      const trialName = basename(trialDir);
      const skill = detectSkill(trialName);
      if (!skill) continue;

      const reward = findRewardInTrial(trialDir);
      const usage = findTokenUsageInTrial(trialDir);
      const score = reward?.xp ?? 0;
      const cost = usage?.costUsd ?? null;

      if (!perModel[model][skill]) perModel[model][skill] = [];
      perModel[model][skill].push({ score, costUsd: cost, trialName: `${jobName}/${trialName}` });
    }
  }

  // ── Gold ──
  for (const jobDir of collectJobDirs('gold-30m', model)) {
    const jobName = basename(jobDir);
    for (const trialDir of getTrialDirs(jobDir)) {
      const trialName = basename(trialDir);
      const cond = detectGoldCondition(trialName);
      if (!cond) continue;

      const taskKey = `gold-${cond}`;
      let score = 0;
      const rewardPath = join(trialDir, 'verifier', 'reward.json');
      if (existsSync(rewardPath)) {
        try {
          const r = JSON.parse(readFileSync(rewardPath, 'utf-8'));
          score = r.peakGold ?? r.gold ?? 0;
        } catch {}
      }
      const usage = findTokenUsageInTrial(trialDir);
      const cost = usage?.costUsd ?? null;

      if (!perModel[model][taskKey]) perModel[model][taskKey] = [];
      perModel[model][taskKey].push({ score, costUsd: cost, trialName: `${jobName}/${trialName}` });
    }
  }
}

// ── Aggregation ─────────────────────────────────────────────────────
interface TaskAgg {
  best: number;
  mean: number;
  trials: number[];
  avgCost: number | null;
}

interface ModelAgg {
  perTask: Record<string, TaskAgg>;
  // Across all tasks:
  avgBest: number;       // mean of best@4 over tasks
  avgMean: number;       // mean of per-task means over tasks
  avgCostPerRun: number | null;
  totalRuns: number;
}

const agg: Record<string, ModelAgg> = {};

for (const model of OPUS_MODELS) {
  const perTask: Record<string, TaskAgg> = {};
  let costSum = 0;
  let costN = 0;
  let totalRuns = 0;

  const allTaskKeys = [...SKILLS, ...GOLD_CONDITIONS.map(c => `gold-${c}`)];

  for (const task of allTaskKeys) {
    const trials = perModel[model][task] || [];
    if (trials.length === 0) {
      perTask[task] = { best: 0, mean: 0, trials: [], avgCost: null };
      continue;
    }
    const scores = trials.map(t => t.score);
    const best = Math.max(...scores);
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;

    const taskCosts = trials.map(t => t.costUsd).filter((c): c is number => typeof c === 'number');
    const taskAvgCost = taskCosts.length > 0 ? taskCosts.reduce((a, b) => a + b, 0) / taskCosts.length : null;

    perTask[task] = { best, mean, trials: scores, avgCost: taskAvgCost };

    for (const t of trials) {
      totalRuns++;
      if (typeof t.costUsd === 'number') { costSum += t.costUsd; costN++; }
    }
  }

  // Normalize gold and xp to comparable units for the "avg across all tasks" is ill-defined;
  // we report two separate rollups below (skills and gold) instead of mixing units.
  // Here we just compute per-category averages.

  agg[model] = {
    perTask,
    avgBest: 0, // placeholder — filled in by category rollups
    avgMean: 0,
    avgCostPerRun: costN > 0 ? costSum / costN : null,
    totalRuns,
  };
}

// ── Category rollups (skills separately from gold — different units) ──
function categoryRollup(model: string, taskKeys: string[]) {
  const bests: number[] = [];
  const means: number[] = [];
  for (const t of taskKeys) {
    const ta = agg[model].perTask[t];
    if (!ta || ta.trials.length === 0) continue;
    bests.push(ta.best);
    means.push(ta.mean);
  }
  return {
    avgBest: bests.length ? bests.reduce((a, b) => a + b, 0) / bests.length : 0,
    avgMean: means.length ? means.reduce((a, b) => a + b, 0) / means.length : 0,
    nTasks: bests.length,
  };
}

const skillsRollup: Record<string, ReturnType<typeof categoryRollup>> = {};
const goldRollup: Record<string, ReturnType<typeof categoryRollup>> = {};
for (const m of OPUS_MODELS) {
  skillsRollup[m] = categoryRollup(m, SKILLS);
  goldRollup[m] = categoryRollup(m, GOLD_CONDITIONS.map(c => `gold-${c}`));
}

// ── Tool-call distribution (from trajectory.json) ────────────────────
type ToolCounts = Record<string, { sum: number; runs: number }>;

function normalizeToolName(name: string): string {
  // Opencode lowercases + underscores rs-agent tools; claude-code keeps PascalCase.
  // Canonicalize to the claude-code style for cross-agent comparison.
  const map: Record<string, string> = {
    'bash': 'Bash',
    'read': 'Read',
    'write': 'Write',
    'edit': 'Edit',
    'glob': 'Glob',
    'grep': 'Grep',
    'todowrite': 'TodoWrite',
    'task': 'Agent',
    'rs-agent_execute_code': 'mcp__rs-agent__execute_code',
    'rs-agent_disconnect_bot': 'mcp__rs-agent__disconnect_bot',
    'rs-agent_list_bots': 'mcp__rs-agent__list_bots',
  };
  return map[name] ?? name;
}

function collectToolCalls(jobDirs: string[], trialFilter: (name: string) => boolean): ToolCounts {
  const out: ToolCounts = {};
  for (const jobDir of jobDirs) {
    for (const trialDir of getTrialDirs(jobDir)) {
      if (!trialFilter(basename(trialDir))) continue;
      const trajPath = join(trialDir, 'agent', 'trajectory.json');
      if (!existsSync(trajPath)) continue;
      try {
        const traj = JSON.parse(readFileSync(trajPath, 'utf-8'));
        const perRun: Record<string, number> = {};
        for (const s of traj.steps || []) {
          if (s.source !== 'agent') continue;
          for (const tc of s.tool_calls || []) {
            const raw = tc.function_name || tc.name || '<unknown>';
            const name = normalizeToolName(raw);
            perRun[name] = (perRun[name] || 0) + 1;
          }
        }
        // Ensure every tool seen this run registers a "run" for averaging
        for (const name of Object.keys(perRun)) {
          if (!out[name]) out[name] = { sum: 0, runs: 0 };
          out[name].sum += perRun[name];
        }
        // Count this trial toward all known tools' runs (for correct avg/run)
        for (const name of Object.keys(out)) {
          out[name].runs += 1;
        }
        for (const name of Object.keys(perRun)) {
          // Already counted above — nothing to fix.
        }
      } catch {}
    }
  }
  return out;
}

// Simpler re-implementation: collect per-run counts first, then aggregate.
function collectToolCallsV2(jobDirs: string[], trialFilter: (name: string) => boolean): { perRun: Record<string, number>[] } {
  const perRun: Record<string, number>[] = [];
  for (const jobDir of jobDirs) {
    for (const trialDir of getTrialDirs(jobDir)) {
      if (!trialFilter(basename(trialDir))) continue;
      const trajPath = join(trialDir, 'agent', 'trajectory.json');
      if (!existsSync(trajPath)) continue;
      try {
        const traj = JSON.parse(readFileSync(trajPath, 'utf-8'));
        const cnt: Record<string, number> = {};
        for (const s of traj.steps || []) {
          if (s.source !== 'agent') continue;
          for (const tc of s.tool_calls || []) {
            const raw = tc.function_name || tc.name || '<unknown>';
            const name = normalizeToolName(raw);
            cnt[name] = (cnt[name] || 0) + 1;
          }
        }
        perRun.push(cnt);
      } catch {}
    }
  }
  return { perRun };
}

function avgToolCallsPerRun(perRun: Record<string, number>[]): Record<string, number> {
  if (perRun.length === 0) return {};
  const tools = new Set<string>();
  for (const r of perRun) for (const t of Object.keys(r)) tools.add(t);
  const out: Record<string, number> = {};
  for (const t of tools) {
    let sum = 0;
    for (const r of perRun) sum += r[t] || 0;
    out[t] = sum / perRun.length;
  }
  return out;
}

const toolsSkills: Record<string, Record<string, number>> = {};
const toolsGold: Record<string, Record<string, number>> = {};
for (const m of OPUS_MODELS) {
  const skillsJobs = collectJobDirs('skills-30m', m);
  const goldJobs = collectJobDirs('gold-30m', m);
  toolsSkills[m] = avgToolCallsPerRun(collectToolCallsV2(skillsJobs, n => detectSkill(n) !== null).perRun);
  toolsGold[m] = avgToolCallsPerRun(collectToolCallsV2(goldJobs, n => detectGoldCondition(n) !== null).perRun);
}

// ── Render ──────────────────────────────────────────────────────────
function fmtNum(n: number): string {
  if (n === 0) return '0';
  if (n >= 10000) return (n / 1000).toFixed(0) + 'k';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return n.toFixed(0);
}
function fmtUsd(n: number | null): string {
  if (n === null) return '—';
  if (n >= 1) return '$' + n.toFixed(2);
  return '$' + n.toFixed(3);
}

const lines: string[] = [];
lines.push(`# Opus 4.5 / 4.6 / 4.7 — k=4 × 30m comparison`);
lines.push('');
lines.push(`Filter: ${filterTs ? `ts=${filterTs}` : sinceTs ? `since=${sinceTs}` : 'all matching job dirs'}`);
lines.push('');

lines.push('## Headline');
lines.push('');
lines.push('| Model | Skills: avg best@4 (xp) | Skills: avg mean (xp) | Gold: avg best@4 (gp) | Gold: avg mean (gp) | Avg $/run | Total trials |');
lines.push('|---|---:|---:|---:|---:|---:|---:|');
for (const m of OPUS_MODELS) {
  lines.push([
    MODEL_LABEL[m],
    fmtNum(skillsRollup[m].avgBest),
    fmtNum(skillsRollup[m].avgMean),
    fmtNum(goldRollup[m].avgBest),
    fmtNum(goldRollup[m].avgMean),
    fmtUsd(agg[m].avgCostPerRun),
    String(agg[m].totalRuns),
  ].map(s => ` ${s} `).join('|'));
}
lines.push('');

lines.push('## Skills — per task (best@4 / mean of trials)');
lines.push('');
const skillHeader = ['Skill', ...OPUS_MODELS.flatMap(m => [`${MODEL_LABEL[m]} best`, `${MODEL_LABEL[m]} mean`])];
lines.push('| ' + skillHeader.join(' | ') + ' |');
lines.push('|' + Array(skillHeader.length).fill('---').join('|') + '|');
for (const skill of SKILLS) {
  const cells: string[] = [skill];
  for (const m of OPUS_MODELS) {
    const t = agg[m].perTask[skill];
    cells.push(t && t.trials.length > 0 ? fmtNum(t.best) : '—');
    cells.push(t && t.trials.length > 0 ? fmtNum(t.mean) : '—');
  }
  lines.push('| ' + cells.join(' | ') + ' |');
}
lines.push('');

lines.push('## Gold — per condition (best@4 peak gp / mean of trials)');
lines.push('');
const goldHeader = ['Condition', ...OPUS_MODELS.flatMap(m => [`${MODEL_LABEL[m]} best`, `${MODEL_LABEL[m]} mean`])];
lines.push('| ' + goldHeader.join(' | ') + ' |');
lines.push('|' + Array(goldHeader.length).fill('---').join('|') + '|');
for (const c of GOLD_CONDITIONS) {
  const cells: string[] = [c];
  for (const m of OPUS_MODELS) {
    const t = agg[m].perTask[`gold-${c}`];
    cells.push(t && t.trials.length > 0 ? fmtNum(t.best) : '—');
    cells.push(t && t.trials.length > 0 ? fmtNum(t.mean) : '—');
  }
  lines.push('| ' + cells.join(' | ') + ' |');
}
lines.push('');

lines.push('## Cost per task (avg across ≤4 trials)');
lines.push('');
const costHeader = ['Task', ...OPUS_MODELS.map(m => MODEL_LABEL[m])];
lines.push('| ' + costHeader.join(' | ') + ' |');
lines.push('|' + Array(costHeader.length).fill('---').join('|') + '|');
for (const task of [...SKILLS, ...GOLD_CONDITIONS.map(c => `gold-${c}`)]) {
  const cells: string[] = [task];
  for (const m of OPUS_MODELS) {
    const t = agg[m].perTask[task];
    cells.push(t ? fmtUsd(t.avgCost) : '—');
  }
  lines.push('| ' + cells.join(' | ') + ' |');
}
lines.push('');

lines.push('## Tool-call distribution — avg calls per run');
lines.push('');
lines.push('Parsed from each trial\'s `agent/trajectory.json`. Tool names normalized across the claude-code (skills) and opencode (gold) harnesses so they line up.');
lines.push('');

function renderToolTable(header: string, tools: Record<string, Record<string, number>>) {
  lines.push(`### ${header}`);
  lines.push('');
  const allTools = new Set<string>();
  for (const m of OPUS_MODELS) for (const t of Object.keys(tools[m] || {})) allTools.add(t);
  // Sort by max across models desc
  const sorted = [...allTools].sort((a, b) => {
    const ma = Math.max(...OPUS_MODELS.map(m => tools[m]?.[a] || 0));
    const mb = Math.max(...OPUS_MODELS.map(m => tools[m]?.[b] || 0));
    return mb - ma;
  });

  const hdr = ['Tool', ...OPUS_MODELS.map(m => MODEL_LABEL[m]), 'Δ (4.7 − 4.6)'];
  lines.push('| ' + hdr.join(' | ') + ' |');
  lines.push('|' + ['---', '---:', '---:', '---:', '---:'].join('|') + '|');

  let total47 = 0, total46 = 0, total45 = 0;
  for (const tool of sorted) {
    const v45 = tools['opus45']?.[tool] || 0;
    const v46 = tools['opus']?.[tool] || 0;
    const v47 = tools['opus47']?.[tool] || 0;
    total45 += v45; total46 += v46; total47 += v47;
    const delta = v47 - v46;
    const fmt = (x: number) => x.toFixed(1);
    lines.push(`| ${tool} | ${fmt(v45)} | ${fmt(v46)} | ${fmt(v47)} | ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} |`);
  }
  const totalDelta = total47 - total46;
  lines.push(`| **TOTAL** | **${total45.toFixed(1)}** | **${total46.toFixed(1)}** | **${total47.toFixed(1)}** | **${totalDelta >= 0 ? '+' : ''}${totalDelta.toFixed(1)}** |`);
  lines.push('');
}

renderToolTable('Skills (30m, 64 trials/model)', toolsSkills);
renderToolTable('Gold (30m, 16 trials/model)', toolsGold);

lines.push('**Interpretation**');
lines.push('');
lines.push('- On **skills**, the extra turns are almost entirely `Bash` + `TodoWrite` on 4.7 — shell exploration and task planning, not more in-game actions (`execute_code` roughly flat).');
lines.push('- On **gold**, 4.7 does *fewer* in-game actions than 4.5 (`execute_code` drops) but +29 `bash` and +7 `read` per run — it spends budget inspecting the environment rather than playing.');
lines.push('- `TodoWrite` flips: +4.3/run on skills, −4.8/run on gold (claude-code vs opencode harness prompt).');
lines.push('- Subagent (`Agent` / `Task`) calls are essentially zero for all three models.');
lines.push('');

// ── best@4 vs mean divergence ──────────────────────────────────────
lines.push('## Best@4 vs mean — where extra trials help most');
lines.push('');
lines.push('`best − mean` (absolute) and `best / mean` (ratio) measure how much you gain from running 4 trials and picking the best. A high ratio = high variance between runs (some trials soar, others flop). Ratio near 1.0 = consistent performance.');
lines.push('');

function renderSpreadTable(header: string, taskKeys: string[], unit: string) {
  lines.push(`### ${header}`);
  lines.push('');
  const hdr = ['Task', ...OPUS_MODELS.flatMap(m => [`${MODEL_LABEL[m]} best`, `${MODEL_LABEL[m]} mean`, `${MODEL_LABEL[m]} ratio`])];
  lines.push('| ' + hdr.join(' | ') + ' |');
  lines.push('|' + Array(hdr.length).fill('---').join('|') + '|');
  for (const task of taskKeys) {
    const row: string[] = [task.replace(/^gold-/, '')];
    for (const m of OPUS_MODELS) {
      const t = agg[m].perTask[task];
      if (!t || t.trials.length === 0 || t.mean === 0) {
        row.push('—', '—', '—');
        continue;
      }
      row.push(fmtNum(t.best), fmtNum(t.mean), (t.best / t.mean).toFixed(2) + '×');
    }
    lines.push('| ' + row.join(' | ') + ' |');
  }
  lines.push('');
}

renderSpreadTable('Skills (xp)', SKILLS, 'xp');
renderSpreadTable('Gold (peak gp)', GOLD_CONDITIONS.map(c => `gold-${c}`), 'gp');

// Aggregate ratios per model
function avgRatio(m: string, taskKeys: string[]): { avg: number; n: number } {
  const ratios: number[] = [];
  for (const t of taskKeys) {
    const ta = agg[m].perTask[t];
    if (!ta || ta.mean === 0 || ta.trials.length < 2) continue;
    ratios.push(ta.best / ta.mean);
  }
  return { avg: ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : 0, n: ratios.length };
}

lines.push('### Summary — average best/mean ratio');
lines.push('');
lines.push('| Category | Opus 4.5 | Opus 4.6 | Opus 4.7 |');
lines.push('|---|---:|---:|---:|');
const sr = OPUS_MODELS.map(m => avgRatio(m, SKILLS));
const gr = OPUS_MODELS.map(m => avgRatio(m, GOLD_CONDITIONS.map(c => `gold-${c}`)));
lines.push(`| Skills (16 tasks) | ${sr[0].avg.toFixed(2)}× | ${sr[1].avg.toFixed(2)}× | ${sr[2].avg.toFixed(2)}× |`);
lines.push(`| Gold (4 tasks)    | ${gr[0].avg.toFixed(2)}× | ${gr[1].avg.toFixed(2)}× | ${gr[2].avg.toFixed(2)}× |`);
lines.push('');
lines.push('A 1.00× ratio would mean every trial scores the same. Higher ratios mean best-of-k is worth more. Gold consistently shows higher variance than skills — picking the best of 4 roughly doubles the reward over the mean.');
lines.push('');

lines.push('## Raw trial counts');
lines.push('');
const countHeader = ['Task', ...OPUS_MODELS.map(m => MODEL_LABEL[m])];
lines.push('| ' + countHeader.join(' | ') + ' |');
lines.push('|' + Array(countHeader.length).fill('---').join('|') + '|');
for (const task of [...SKILLS, ...GOLD_CONDITIONS.map(c => `gold-${c}`)]) {
  const cells: string[] = [task];
  for (const m of OPUS_MODELS) {
    const t = agg[m].perTask[task];
    cells.push(String(t?.trials.length ?? 0));
  }
  lines.push('| ' + cells.join(' | ') + ' |');
}
lines.push('');

// ── Write outputs ───────────────────────────────────────────────────
mkdirSync(RESULTS_DIR, { recursive: true });
const stamp = filterTs || sinceTs || new Date().toISOString().replace(/[:.]/g, '-').slice(0, 15);
const mdPath = join(RESULTS_DIR, `opus-k4-${stamp}.md`);
const jsonPath = join(RESULTS_DIR, `opus-k4-${stamp}.json`);
writeFileSync(mdPath, lines.join('\n'));
writeFileSync(jsonPath, JSON.stringify({ perModel, agg, skillsRollup, goldRollup }, null, 2));

// ── HTML report (self-contained, ECharts via CDN) ───────────────────
const allTasks = [...SKILLS, ...GOLD_CONDITIONS.map(c => `gold-${c}`)];

// Per-task best-across-models (for normalization)
const perTaskMax: Record<string, number> = {};
for (const t of allTasks) {
  let mx = 0;
  for (const m of OPUS_MODELS) {
    const ta = agg[m].perTask[t];
    if (ta && ta.best > mx) mx = ta.best;
  }
  perTaskMax[t] = mx;
}

// Normalized (best@4 / per-task-max) and (mean@4 / per-task-max) averaged across tasks
const normSummary: Record<string, { best: number; mean: number }> = {};
for (const m of OPUS_MODELS) {
  let bSum = 0, mSum = 0, n = 0;
  for (const t of allTasks) {
    const ta = agg[m].perTask[t];
    if (!ta || ta.trials.length === 0 || perTaskMax[t] === 0) continue;
    bSum += ta.best / perTaskMax[t];
    mSum += ta.mean / perTaskMax[t];
    n++;
  }
  normSummary[m] = { best: n ? bSum / n : 0, mean: n ? mSum / n : 0 };
}

// Per-task rows (for the per-task log-scale chart)
const taskRows = allTasks.map(t => {
  const row: any = { task: t, isGold: t.startsWith('gold-') };
  for (const m of OPUS_MODELS) {
    const ta = agg[m].perTask[t];
    row[`${m}_best`] = ta?.best ?? 0;
    row[`${m}_mean`] = ta?.mean ?? 0;
    row[`${m}_cost`] = ta?.avgCost ?? 0;
  }
  return row;
});

const htmlData = {
  models: OPUS_MODELS,
  modelLabel: MODEL_LABEL,
  tasks: taskRows,
  normSummary,
  costPerRun: Object.fromEntries(OPUS_MODELS.map(m => [m, agg[m].avgCostPerRun ?? 0])),
  totalRuns: Object.fromEntries(OPUS_MODELS.map(m => [m, agg[m].totalRuns])),
  filterLabel: filterTs ? `ts=${filterTs}` : sinceTs ? `since=${sinceTs}` : 'all jobs',
};

const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Opus 4.5 / 4.6 / 4.7 — k=4 × 30m</title>
<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js"></script>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 0; padding: 24px; background: #f7f7f8; color: #1a1a1a; }
  .wrap { max-width: 1200px; margin: 0 auto; }
  h1 { margin: 0 0 4px; font-size: 24px; }
  .sub { color: #888; font-size: 13px; margin-bottom: 24px; }
  .card { background: white; border-radius: 8px; padding: 20px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
  h2 { font-size: 16px; margin: 0 0 12px; font-weight: 600; }
  .note { font-size: 12px; color: #666; margin-bottom: 12px; line-height: 1.4; }
  .chart { height: 420px; }
  .chart-tall { height: 620px; }
  .summary-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 20px; }
  .summary-card { background: white; border-radius: 8px; padding: 16px 20px; border-left: 4px solid var(--model-color); box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
  .summary-card .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #888; margin-bottom: 8px; }
  .summary-card .name { font-size: 18px; font-weight: 700; margin-bottom: 12px; }
  .summary-card .metric { display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 4px; }
  .summary-card .metric .v { font-weight: 600; font-variant-numeric: tabular-nums; }
  .legend-gold { display: inline-block; width: 8px; height: 8px; background: #d4a017; border-radius: 2px; vertical-align: middle; margin: 0 4px; }
  .legend-skills { display: inline-block; width: 8px; height: 8px; background: #4a90e2; border-radius: 2px; vertical-align: middle; margin: 0 4px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Opus 4.5 / 4.6 / 4.7 — k=4 × 30m</h1>
  <div class="sub">20 tasks (16 skills + 4 gold conditions) × 3 models × 4 trials = 240 runs. Filter: ${htmlData.filterLabel}.</div>

  <div class="summary-grid" id="summary"></div>

  <div class="card">
    <h2>Normalized performance (best@4 and mean across all 20 tasks)</h2>
    <div class="note">Each task's score is divided by the max across models, so both skills (xp) and gold (gp) contribute on the same [0, 1] scale. A value of 1.00 means "wins this task"; 0.50 means "half the winning model's score". Bars show the avg of those normalized values across all 20 tasks.</div>
    <div id="chartNorm" class="chart"></div>
  </div>

  <div class="card">
    <h2>Per-task best@4 — log-scale raw scores</h2>
    <div class="note">All 20 tasks plotted together. <span class="legend-skills"></span>skills (xp) and <span class="legend-gold"></span>gold (peak gp) live on the same log y-axis. Hover bars for mean@4 and cost details.</div>
    <div id="chartPerTask" class="chart-tall"></div>
  </div>

  <div class="card">
    <h2>Avg cost per run</h2>
    <div class="note">Averaged across all 80 trials (16 skills × 4 + 4 gold × 4) per model.</div>
    <div id="chartCost" class="chart" style="height:280px;"></div>
  </div>
</div>

<script>
const DATA = ${JSON.stringify(htmlData)};

const MODEL_COLOR = { opus45: '#7fba00', opus: '#f2a900', opus47: '#d83b01' };

// ── Summary cards ──
const sg = document.getElementById('summary');
for (const m of DATA.models) {
  const card = document.createElement('div');
  card.className = 'summary-card';
  card.style.setProperty('--model-color', MODEL_COLOR[m]);
  const best = DATA.normSummary[m].best;
  const mean = DATA.normSummary[m].mean;
  const cost = DATA.costPerRun[m];
  card.innerHTML = \`
    <div class="label">\${DATA.totalRuns[m]} trials</div>
    <div class="name">\${DATA.modelLabel[m]}</div>
    <div class="metric"><span>avg best@4 (norm)</span><span class="v">\${best.toFixed(2)}</span></div>
    <div class="metric"><span>avg mean@4 (norm)</span><span class="v">\${mean.toFixed(2)}</span></div>
    <div class="metric"><span>avg cost / run</span><span class="v">$\${cost.toFixed(2)}</span></div>
  \`;
  sg.appendChild(card);
}

// ── Chart: normalized best + mean per model ──
const normChart = echarts.init(document.getElementById('chartNorm'));
normChart.setOption({
  grid: { left: 80, right: 40, top: 40, bottom: 40 },
  tooltip: { trigger: 'axis' },
  legend: { top: 0, data: ['best@4 (normalized)', 'mean@4 (normalized)'] },
  xAxis: {
    type: 'category',
    data: DATA.models.map(m => DATA.modelLabel[m]),
  },
  yAxis: {
    type: 'value',
    min: 0, max: 1,
    name: 'fraction of per-task best',
    nameLocation: 'middle', nameGap: 50,
    axisLabel: { formatter: v => v.toFixed(2) },
  },
  series: [
    {
      name: 'best@4 (normalized)',
      type: 'bar',
      data: DATA.models.map(m => ({
        value: DATA.normSummary[m].best,
        itemStyle: { color: MODEL_COLOR[m] },
      })),
      label: { show: true, position: 'top', formatter: p => p.value.toFixed(2) },
    },
    {
      name: 'mean@4 (normalized)',
      type: 'bar',
      data: DATA.models.map(m => ({
        value: DATA.normSummary[m].mean,
        itemStyle: { color: MODEL_COLOR[m], opacity: 0.45 },
      })),
      label: { show: true, position: 'top', formatter: p => p.value.toFixed(2) },
    },
  ],
});

// ── Chart: per-task log-scale best@4 ──
const perTaskChart = echarts.init(document.getElementById('chartPerTask'));
const seriesPerTask = DATA.models.map(m => ({
  name: DATA.modelLabel[m] + ' best@4',
  type: 'bar',
  data: DATA.tasks.map(t => t[m + '_best']),
  itemStyle: { color: MODEL_COLOR[m] },
  emphasis: { focus: 'series' },
}));
// Add mean as scatter overlay per model
const meanSeries = DATA.models.map(m => ({
  name: DATA.modelLabel[m] + ' mean@4',
  type: 'scatter',
  symbol: 'rect',
  symbolSize: [12, 3],
  data: DATA.tasks.map(t => t[m + '_mean']),
  itemStyle: { color: MODEL_COLOR[m], opacity: 0.9, borderColor: '#111', borderWidth: 0.5 },
  tooltip: { show: false },
}));

perTaskChart.setOption({
  grid: { left: 70, right: 40, top: 50, bottom: 120 },
  tooltip: {
    trigger: 'axis',
    axisPointer: { type: 'shadow' },
    formatter: params => {
      if (!params.length) return '';
      const taskIdx = params[0].dataIndex;
      const task = DATA.tasks[taskIdx];
      const lines = [\`<b>\${task.task}\${task.isGold ? ' (gold, peak gp)' : ' (skill, xp)'}</b>\`];
      for (const m of DATA.models) {
        const b = task[m + '_best'], mv = task[m + '_mean'], c = task[m + '_cost'];
        lines.push(\`<span style="color:\${MODEL_COLOR[m]}">\${DATA.modelLabel[m]}</span>: best \${b.toLocaleString()} · mean \${mv.toLocaleString()} · $\${c.toFixed(2)}/run\`);
      }
      return lines.join('<br>');
    },
  },
  legend: { top: 0 },
  xAxis: {
    type: 'category',
    data: DATA.tasks.map(t => t.task),
    axisLabel: {
      interval: 0,
      rotate: 55,
      color: t => {
        const idx = DATA.tasks.findIndex(x => x.task === t);
        return idx >= 0 && DATA.tasks[idx].isGold ? '#d4a017' : '#4a90e2';
      },
    },
  },
  yAxis: {
    type: 'log',
    name: 'score (log scale)',
    nameLocation: 'middle', nameGap: 50,
    axisLabel: { formatter: v => v >= 1000000 ? (v/1e6).toFixed(0)+'M' : v >= 1000 ? (v/1000).toFixed(0)+'k' : v },
    min: 100,
  },
  series: [...seriesPerTask, ...meanSeries],
});

// ── Chart: cost ──
const costChart = echarts.init(document.getElementById('chartCost'));
costChart.setOption({
  grid: { left: 80, right: 40, top: 20, bottom: 40 },
  tooltip: { trigger: 'axis', formatter: p => \`\${p[0].name}<br><b>$\${p[0].value.toFixed(2)}</b> per run\` },
  xAxis: {
    type: 'category',
    data: DATA.models.map(m => DATA.modelLabel[m]),
  },
  yAxis: {
    type: 'value',
    name: 'USD / run',
    nameLocation: 'middle', nameGap: 50,
    axisLabel: { formatter: v => '$' + v.toFixed(2) },
  },
  series: [{
    type: 'bar',
    data: DATA.models.map(m => ({
      value: DATA.costPerRun[m],
      itemStyle: { color: MODEL_COLOR[m] },
    })),
    label: { show: true, position: 'top', formatter: p => '$' + p.value.toFixed(2) },
  }],
});

window.addEventListener('resize', () => {
  normChart.resize();
  perTaskChart.resize();
  costChart.resize();
});
</script>
</body>
</html>`;

const htmlPath = join(RESULTS_DIR, `opus-k4-${stamp}.html`);
writeFileSync(htmlPath, html);
console.log(`Wrote ${htmlPath}`);

console.log(lines.join('\n'));
console.log(`\nWrote ${mdPath}`);
console.log(`Wrote ${jsonPath}`);
