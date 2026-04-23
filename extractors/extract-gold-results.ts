#!/usr/bin/env bun
/**
 * Extract gold benchmark results from Harbor job directories.
 *
 * Reads reward data (gold earned) + skill tracking from verifier outputs.
 * Outputs to results/gold/_data.js for the graph viewer.
 *
 * Usage:
 *   bun extractors/extract-gold-results.ts                    # Auto-discover gold jobs
 *   bun extractors/extract-gold-results.ts --filter gold-30m  # Filter by pattern
 */

import { readFileSync, readdirSync, existsSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { join, basename } from 'path';
import {
  type Sample, type TrackingData, type TokenUsage,
  detectModel, detectModelFromConfig, getTrialDirs,
  parseRewardFromStdout, findTokenUsageInTrial,
  parseCLIArgs, resolveJobDirs, writeResults,
} from '../shared/extract-utils';
import { extractTrajectoryFromTrial, type TrajectoryStep } from '../shared/trajectory';

const REPO_ROOT = join(import.meta.dir, '..');
const RESULTS_DIR = join(REPO_ROOT, 'results', 'gold');
const JOBS_DIR = join(REPO_ROOT, 'jobs');

// Order matters for detectModel: longer/more-specific labels come first
// (so "opus47" matches before "opus", "codex53" before "codex", etc.).
const KNOWN_MODELS = [
  'opus47', 'opus45', 'opus',
  'sonnet46', 'sonnet45',
  'haiku',
  'codex53', 'codex',
  'gpt55', 'gpt54nano', 'gpt54mini', 'gpt54',
  'gemini31', 'geminiflash', 'gemini',
  'glm', 'kimi', 'qwen35', 'qwen3',
];

const MODEL_LABELS: Record<string, string> = {
  opus47: 'Claude Opus 4.7',
  opus: 'Claude Opus 4.6',
  opus45: 'Claude Opus 4.5',
  sonnet46: 'Claude Sonnet 4.6',
  sonnet45: 'Claude Sonnet 4.5',
  haiku: 'Claude Haiku 4.5',
  codex: 'GPT-5.2 Codex',
  codex53: 'GPT-5.3 Codex',
  gpt54: 'GPT-5.4',
  gpt54mini: 'GPT-5.4 Mini',
  gpt54nano: 'GPT-5.4 Nano',
  gpt55: 'GPT-5.5',
  gemini: 'Gemini 3 Pro',
  gemini31: 'Gemini 3.1 Pro',
  geminiflash: 'Gemini 3 Flash',
  glm: 'GLM-5',
  kimi: 'Kimi K2.5',
  qwen3: 'Qwen3 Coder Next',
  qwen35: 'Qwen3.5 35B',
};

interface GoldReward {
  gold: number;           // peak post-v2 verifier; final pre-v2
  peakGold?: number;      // v2+ verifier
  finalGold?: number;     // v2+ verifier (save-file reading at verifier time)
  peakAtMs?: number | null;
  inventoryGold: number;
  bankGold: number;
  totalLevel?: number;
  tracking?: TrackingData;
}

interface GoldResult {
  model: string;
  modelLabel: string;
  jobName: string;
  gold: number;            // peak gold (primary ranking metric)
  peakGold: number;
  finalGold: number;
  peakAtMs: number | null;
  inventoryGold: number;
  bankGold: number;
  totalLevel: number;
  tracking: TrackingData | null;
  // Per-trial trajectory viewer payload (when available):
  trajectory?: TrajectoryStep[];
  trialDir?: string;
  videoAvailable?: boolean;
  videoDuration?: number;
  containerStartedAt?: string;
  containerFinishedAt?: string;
  agentStartedAt?: string;
  firstStepAt?: string;
  durationSeconds?: number;
  tokenUsage: TokenUsage | null;
  horizon: string;
}

function extractVariantFromSlug(slug: string): string | null {
  const lower = slug.toLowerCase();
  // Trailing separator must be non-word, $, or underscore-hash (trial dir names
  // look like "gold-fletch-alch-15m__abcd1234" — note: \b fails between 'm' and
  // '_' because '_' is a word char in regex, so we use a custom terminator).
  const term = '(?=$|[^a-z0-9])';
  const m = lower.match(new RegExp(`gold-([a-z][a-z-]*?)-(\\d+[mh])${term}`));
  if (m) return `${m[1]}-${m[2]}`;
  const legacy = lower.match(new RegExp(`gold-(\\d+[mh])${term}`));
  if (legacy) return legacy[1];
  return null;
}

/**
 * Returns a variant string like "vanilla-15m", "smith-alch-30m", or "15m"
 * (legacy, pre-condition tasks).
 *
 * Priority: trial dir names (they contain the exact task slug) → harbor config
 * datasets.task_names → job dir name. We skip the job name first because
 * run-gold.sh names jobs `gold-{horizon}-{label}-{ts}`, which loses the
 * condition (the horizon string matches the legacy pattern and masks it).
 */
function detectGoldVariant(dirName: string, jobDir: string): string {
  // 1. Trial dir names — these are <task-slug>__<hash>
  try {
    const entries = readdirSync(jobDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const v = extractVariantFromSlug(entry.name);
      if (v) return v;
    }
  } catch {}

  // 2. Harbor config: datasets[].task_names OR tasks[].path
  const configPath = join(jobDir, 'config.json');
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      const candidates: string[] = [];
      for (const ds of config?.datasets || []) {
        for (const n of ds?.task_names || []) candidates.push(n);
        if (ds?.path) candidates.push(ds.path);
      }
      for (const t of config?.tasks || []) if (t?.path) candidates.push(t.path);
      if (config?.task?.path) candidates.push(config.task.path);
      for (const c of candidates) {
        const v = extractVariantFromSlug(c);
        if (v) return v;
      }
    } catch {}
  }

  // 3. Fall back to the job dir name itself
  const v = extractVariantFromSlug(dirName);
  if (v) return v;
  return 'unknown';
}

function findGoldRewardInTrial(trialDir: string): GoldReward | null {
  const rewardPath = join(trialDir, 'verifier', 'reward.json');
  if (existsSync(rewardPath)) {
    try {
      const reward = JSON.parse(readFileSync(rewardPath, 'utf-8'));
      if (typeof reward.gold === 'number') return reward;
    } catch {}
  }

  const stdoutPath = join(trialDir, 'verifier', 'test-stdout.txt');
  if (existsSync(stdoutPath)) {
    try {
      const content = readFileSync(stdoutPath, 'utf-8');
      const reward = parseRewardFromStdout(content);
      if (reward && typeof reward.gold === 'number') return reward;
    } catch {}
  }

  return null;
}

// ── Main ─────────────────────────────────────────────────────────

const { filter: userFilter, explicitDirs } = parseCLIArgs(process.argv.slice(2));
const filter = userFilter || 'gold';
const jobDirs = resolveJobDirs(JOBS_DIR, explicitDirs, filter);

const results: GoldResult[] = [];

for (const dir of jobDirs) {
  const jobName = basename(dir);
  let model = detectModel(jobName, KNOWN_MODELS);
  if (model === 'unknown') model = detectModelFromConfig(dir, KNOWN_MODELS);

  if (model === 'unknown') {
    console.log(`  skip: ${jobName} (can't detect model)`);
    continue;
  }

  // Harbor with `-i gold-vanilla-15m -i gold-smith-alch-15m ...` creates ONE
  // job with multiple trial dirs, one per task. Iterate per-trial so each
  // condition gets its own result.
  const trialDirs = getTrialDirs(dir);
  if (trialDirs.length === 0) {
    console.log(`  skip: ${jobName} (no trial dirs)`);
    continue;
  }

  for (const trialDir of trialDirs) {
    const trialName = basename(trialDir);
    const variant = extractVariantFromSlug(trialName) || detectGoldVariant(jobName, dir);
    if (variant === 'unknown') {
      console.log(`  skip: ${jobName}/${trialName} (can't detect variant)`);
      continue;
    }

    const reward = findGoldRewardInTrial(trialDir);
    if (!reward) {
      console.log(`  skip: ${jobName}/${trialName} (no reward)`);
      continue;
    }

    const tokenUsage = findTokenUsageInTrial(trialDir);
    const tracking = reward.tracking || null;
    const nSamples = tracking?.samples?.length ?? 0;
    const costStr = tokenUsage?.costUsd != null ? `, $${tokenUsage.costUsd.toFixed(2)}` : '';
    const tokenStr = tokenUsage
      ? `, tokens: ${(tokenUsage.inputTokens / 1000).toFixed(0)}k in / ${(tokenUsage.outputTokens / 1000).toFixed(0)}k out${costStr}`
      : '';

    // Trajectory viewer metadata — trajectory.json + video timing
    let traj: { steps: TrajectoryStep[]; firstStepAt?: string } | null = null;
    try { traj = extractTrajectoryFromTrial(trialDir); } catch {}

    let containerStartedAt: string | undefined;
    let containerFinishedAt: string | undefined;
    let agentStartedAt: string | undefined;
    const resultPath = join(trialDir, 'result.json');
    if (existsSync(resultPath)) {
      try {
        const r = JSON.parse(readFileSync(resultPath, 'utf-8'));
        containerStartedAt = r.started_at;
        containerFinishedAt = r.finished_at;
        agentStartedAt = r.agent_execution?.started_at;
      } catch {}
    }

    const videoPath = join(trialDir, 'verifier', 'recording.mp4');
    const videoAvailable = existsSync(videoPath);
    let videoDuration: number | undefined;
    if (videoAvailable) {
      try {
        const probe = execSync(
          `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${videoPath}"`,
          { timeout: 5000 }
        ).toString().trim();
        const d = parseFloat(probe);
        if (!isNaN(d)) videoDuration = d;
      } catch {}
    }
    const relTrialDir = trialDir.startsWith(REPO_ROOT) ? trialDir.slice(REPO_ROOT.length + 1) : trialDir;

    // Derive run duration from horizon string ("30m" → 1800s). We don't clamp
    // the samples because the verifier already only records within the run.
    const horizonMatch = variant.match(/(\d+)m$/);
    const durationSeconds = horizonMatch ? parseInt(horizonMatch[1]) * 60 : undefined;

    const peak = reward.peakGold ?? reward.gold;
    const final = reward.finalGold ?? reward.gold;
    const result: GoldResult = {
      model,
      modelLabel: MODEL_LABELS[model] || model,
      jobName,
      gold: peak,
      peakGold: peak,
      finalGold: final,
      peakAtMs: reward.peakAtMs ?? null,
      inventoryGold: reward.inventoryGold ?? 0,
      bankGold: reward.bankGold ?? 0,
      totalLevel: reward.totalLevel ?? 0,
      tracking,
      tokenUsage,
      horizon: variant,
      ...(traj ? { trajectory: traj.steps, firstStepAt: traj.firstStepAt } : {}),
      trialDir: relTrialDir,
      videoAvailable,
      ...(videoDuration ? { videoDuration } : {}),
      ...(containerStartedAt ? { containerStartedAt } : {}),
      ...(containerFinishedAt ? { containerFinishedAt } : {}),
      ...(agentStartedAt ? { agentStartedAt } : {}),
      ...(durationSeconds ? { durationSeconds } : {}),
    };

    results.push(result);
    const peakStr = peak !== final ? ` (peak ${peak}, final ${final})` : '';
    console.log(`  ${model}/${variant}: ${peak} gold${peakStr} (inv=${reward.inventoryGold}, bank=${reward.bankGold}), ${nSamples} samples${tokenStr}`);
  }
}

if (results.length === 0) {
  console.log('\nNo gold results found.');
  process.exit(1);
}

function hasBankTracking(r: GoldResult): boolean {
  return r.tracking?.samples?.some(s => (s as any).bankGold != null) ?? false;
}

// Group by horizon, keep best per model+horizon.
const grouped: Record<string, Record<string, GoldResult>> = {};
for (const r of results) {
  if (!grouped[r.horizon]) grouped[r.horizon] = {};
  const existing = grouped[r.horizon][r.model];
  if (!existing) {
    grouped[r.horizon][r.model] = r;
  } else {
    const newHasBank = hasBankTracking(r);
    const existingHasBank = hasBankTracking(existing);
    if (newHasBank && !existingHasBank) {
      grouped[r.horizon][r.model] = r;
    } else if (!newHasBank && existingHasBank) {
      // keep existing bank-tracked run
    } else if (r.gold > existing.gold) {
      grouped[r.horizon][r.model] = r;
    }
  }
}

writeResults(RESULTS_DIR, grouped, 'GOLD_DATA');

// Also write a slim version (no tracking samples) for the index.html matrix.
// The full _data.js is ~10MB with per-5s samples; the summary needs ~1% of it.
const slim: Record<string, Record<string, any>> = {};
for (const [variant, byModel] of Object.entries(grouped)) {
  slim[variant] = {};
  for (const [model, r] of Object.entries(byModel)) {
    slim[variant][model] = {
      model: r.model,
      modelLabel: r.modelLabel,
      gold: r.gold,
      peakGold: r.peakGold,
      finalGold: r.finalGold,
      inventoryGold: r.inventoryGold,
      bankGold: r.bankGold,
      totalLevel: r.totalLevel,
      tokenUsage: r.tokenUsage,
    };
  }
}
{
  const p = join(RESULTS_DIR, '_summary.js');
  writeFileSync(p, `window.GOLD_DATA = ${JSON.stringify(slim)};`);
  console.log(`Wrote ${p} (${(JSON.stringify(slim).length / 1024).toFixed(0)} KB)`);
}

// Read the video manifest so we can stamp public URLs onto each trajectory.
const videoManifestPath = join(REPO_ROOT, 'results', 'video-urls.json');
let videoManifest: Record<string, string> = {};
if (existsSync(videoManifestPath)) {
  try { videoManifest = JSON.parse(readFileSync(videoManifestPath, 'utf-8')); } catch {}
}

// Write a separate trajectory payload for the in-page TrajectoryModal.
// Shape: window.GOLD_TRAJECTORIES[model][condition] = { ...single trial record }
// Keyed like the skills data (data[model][skill]) so the modal can reuse the
// same navigation patterns. Only 30m runs are included (15m is smoke-test).
const traj: Record<string, Record<string, any>> = {};
for (const [variant, byModel] of Object.entries(grouped)) {
  const m = variant.match(/^(.+)-(\d+[mh])$/);
  if (!m) continue;
  const condition = m[1];
  const horizon = m[2];
  if (horizon !== '30m') continue; // 15m runs excluded from index UI
  for (const [model, r] of Object.entries(byModel)) {
    if (!r.trajectory || r.trajectory.length === 0) continue;
    if (!traj[model]) traj[model] = {};
    // Slim the tracking samples: keep elapsedMs, gold, and skill levels
    const slimSamples: any[] = [];
    const firstSample = r.tracking?.samples?.[0];
    function baselineLevel(skillName: string): number {
      if (!firstSample?.skills) return 1;
      for (const [n, d] of Object.entries(firstSample.skills)) {
        if (n.toLowerCase() === skillName.toLowerCase()) return (d as any).level || 1;
      }
      return 1;
    }
    for (const s of (r.tracking?.samples || [])) {
      const slimSkills: Record<string, { level: number; xp?: number }> = {};
      if (s.skills) {
        for (const [n, d] of Object.entries(s.skills)) {
          const sd = d as { level: number; xp: number };
          if (sd.level > baselineLevel(n) || sd.xp > 0) {
            slimSkills[n] = { level: sd.level, xp: sd.xp };
          }
        }
      }
      slimSamples.push({
        elapsedMs: s.elapsedMs,
        skills: slimSkills,
        ...(typeof s.gold === 'number' ? { gold: s.gold } : {}),
      });
    }
    const videoUrl = videoManifest[`gold-${horizon}/${model}/gold-${condition}`];
    traj[model][`gold-${condition}`] = {
      jobName: r.jobName,
      peakGold: r.peakGold,
      finalGold: r.finalGold,
      peakAtMs: r.peakAtMs,
      totalLevel: r.totalLevel,
      durationSeconds: r.durationSeconds,
      sampleCount: slimSamples.length,
      samples: slimSamples,
      trajectory: r.trajectory,
      ...(r.firstStepAt ? { firstStepAt: r.firstStepAt } : {}),
      ...(r.tokenUsage ? { tokenUsage: r.tokenUsage } : {}),
      ...(r.trialDir ? { trialDir: r.trialDir } : {}),
      ...(r.videoAvailable ? { videoAvailable: true } : {}),
      ...(r.videoDuration ? { videoDuration: r.videoDuration } : {}),
      ...(videoUrl ? { videoUrl } : {}),
      ...(r.containerStartedAt ? { containerStartedAt: r.containerStartedAt } : {}),
      ...(r.containerFinishedAt ? { containerFinishedAt: r.containerFinishedAt } : {}),
      ...(r.agentStartedAt ? { agentStartedAt: r.agentStartedAt } : {}),
    };
  }
}
{
  const p = join(RESULTS_DIR, '_trajectories.js');
  const json = JSON.stringify(traj);
  writeFileSync(p, `window.GOLD_TRAJECTORIES = ${json};`);
  console.log(`Wrote ${p} (${(json.length / 1024).toFixed(0)} KB)`);
}

console.log(`\n${results.length} result(s) extracted. View: open views/graph-gold.html`);
