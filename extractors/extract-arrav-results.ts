#!/usr/bin/env bun
/**
 * Extract Shield of Arrav duo benchmark results from Harbor job directories.
 *
 * Reads the verifier's reward.json (completion time + per-bot detail) from
 * each trial. Outputs results/arrav/_combined.json + _data.js.
 *
 * Usage:
 *   bun extractors/extract-arrav-results.ts                     # auto-discover arrav-duo jobs
 *   bun extractors/extract-arrav-results.ts --filter arrav-duo  # filter by pattern
 *   bun extractors/extract-arrav-results.ts jobs/arrav-duo-opus47-...  # explicit dirs
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, basename } from 'path';
import {
  detectModel, detectModelFromConfig, getTrialDirs,
  parseRewardFromStdout, findTokenUsageInTrial,
  parseCLIArgs, resolveJobDirs, writeResults,
} from '../shared/extract-utils';

const REPO_ROOT = join(import.meta.dir, '..');
const RESULTS_DIR = join(REPO_ROOT, 'results', 'arrav');
const JOBS_DIR = join(REPO_ROOT, 'jobs');

// Longer/more-specific labels first (see extract-gold-results.ts)
const KNOWN_MODELS = [
  'fable5',
  'opus48', 'opus47', 'opus45', 'opus',
  'sonnet46', 'sonnet45',
  'haiku',
  'codex53',
  'gpt55', 'gpt54nano', 'gpt54mini', 'gpt54',
  'gemini35flash', 'gemini31', 'geminiflash', 'gemini',
  'glm', 'kimi', 'qwen3max', 'qwen35', 'qwen3',
];

interface ArravTrial {
  model: string;
  jobDir: string;
  trialDir: string;
  completed: boolean;
  bothCompleted: boolean;
  firstCompletionSecs: number | null;
  reward: number;            // capSecs - firstCompletionSecs (0 = DNF)
  capSecs: number;
  perBot: any;
  milestones: any[];
  chatCount: number;
  tokens: any;
}

/** Write the in-game chat transcript for a trial as readable text. */
function writeTranscript(trial: { model: string; jobDir: string }, chat: any[]): string | null {
  if (!chat?.length) return null;
  const dir = join(RESULTS_DIR, 'transcripts');
  mkdirSync(dir, { recursive: true });
  const lines = chat.map((c: any) => {
    const t = Math.round((c.elapsedMs ?? 0) / 1000);
    const mm = String(Math.floor(t / 60)).padStart(2, '0');
    const ss = String(t % 60).padStart(2, '0');
    return `[${mm}:${ss}] ${c.sender}: ${c.text}`;
  });
  const path = join(dir, `${trial.jobDir}.txt`);
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
}

function readReward(trialDir: string): any | null {
  // Preferred: verifier reward.json on disk
  for (const p of [
    join(trialDir, 'verifier', 'reward.json'),
    join(trialDir, 'verifier', 'logs', 'reward.json'),
  ]) {
    if (existsSync(p)) {
      try { return JSON.parse(readFileSync(p, 'utf-8')); } catch {}
    }
  }
  // Fallback: stdout markers
  for (const p of [
    join(trialDir, 'verifier', 'stdout.txt'),
    join(trialDir, 'verifier', 'logs', 'stdout.txt'),
  ]) {
    if (existsSync(p)) {
      const parsed = parseRewardFromStdout(readFileSync(p, 'utf-8'));
      if (parsed) return parsed;
    }
  }
  return null;
}

function main() {
  const { filter, explicitDirs } = parseCLIArgs(process.argv.slice(2));
  const jobDirs = resolveJobDirs(JOBS_DIR, explicitDirs, filter || 'arrav-duo');

  const trials: ArravTrial[] = [];

  for (const jobDir of jobDirs) {
    const jobName = basename(jobDir);
    // Job names are arrav-duo-<label>-<timestamp> — prefer the exact label
    // over config-based detection (which collapses e.g. opus48 → opus).
    const nameMatch = jobName.match(/^arrav-duo-(.+)-\d{8}-\d{6}$/);
    const model = (nameMatch && nameMatch[1]) ||
      detectModelFromConfig(jobDir, KNOWN_MODELS) || detectModel(jobName, KNOWN_MODELS);

    for (const trialDir of getTrialDirs(jobDir)) {
      const reward = readReward(trialDir);
      if (!reward) {
        console.log(`  no reward data: ${trialDir}`);
        continue;
      }
      const chat = reward.chat ?? reward.tracking?.chat ?? [];
      const trial: ArravTrial = {
        model,
        jobDir: jobName,
        trialDir: basename(trialDir),
        completed: !!reward.completed,
        bothCompleted: !!reward.bothCompleted,
        firstCompletionSecs: reward.firstCompletionSecs ?? null,
        reward: reward.reward ?? 0,
        capSecs: reward.capSecs ?? 1800,
        perBot: reward.perBot ?? null,
        milestones: reward.milestones ?? [],
        chat,
        chatCount: chat.length,
        tokens: findTokenUsageInTrial(trialDir),
      };
      const transcriptPath = writeTranscript(trial, chat);
      if (transcriptPath) console.log(`  transcript: ${transcriptPath} (${chat.length} messages)`);
      trials.push(trial);
    }
  }

  // Per-model summary: best (fastest) completion across trials
  const byModel: Record<string, any> = {};
  for (const t of trials) {
    const m = (byModel[t.model] ??= { model: t.model, trials: [], completions: 0, bestSecs: null });
    m.trials.push(t);
    if (t.completed) {
      m.completions++;
      if (m.bestSecs === null || (t.firstCompletionSecs ?? Infinity) < m.bestSecs) {
        m.bestSecs = t.firstCompletionSecs;
      }
    }
  }

  console.log(`\n${trials.length} trial(s) across ${Object.keys(byModel).length} model(s):\n`);
  const fmt = (s: number | null) =>
    s === null ? 'DNF' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  for (const m of Object.values(byModel).sort((a: any, b: any) => (a.bestSecs ?? Infinity) - (b.bestSecs ?? Infinity))) {
    const chatTotal = m.trials.reduce((s: number, t: ArravTrial) => s + (t.chatCount || 0), 0);
    console.log(`  ${m.model.padEnd(16)} best=${fmt(m.bestSecs).padEnd(7)} completions=${m.completions}/${m.trials.length} chat=${chatTotal} msgs`);
  }

  writeResults(RESULTS_DIR, { models: byModel, trials }, 'ARRAV_DATA');
}

main();
