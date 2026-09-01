#!/usr/bin/env bun
/**
 * Extract smith-team benchmark results from Harbor job directories.
 *
 * Reads the verifier's reward.json (best smithed item + per-bot detail) from
 * each trial. Outputs results/smith-team/_combined.json + _data.js, plus
 * per-trial chat transcripts.
 *
 * Usage:
 *   bun extractors/extract-smith-team-results.ts                      # auto-discover smith-team jobs
 *   bun extractors/extract-smith-team-results.ts --filter smith-team  # filter by pattern
 *   bun extractors/extract-smith-team-results.ts jobs/smith-team-opus48-...  # explicit dirs
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, basename } from 'path';
import {
  detectModel, detectModelFromConfig, getTrialDirs,
  parseRewardFromStdout, findTokenUsageInTrial,
  parseCLIArgs, resolveJobDirs, writeResults,
} from '../shared/extract-utils';

const REPO_ROOT = join(import.meta.dir, '..');
const RESULTS_DIR = join(REPO_ROOT, 'results', 'smith-team');
const JOBS_DIR = join(REPO_ROOT, 'jobs');

// Longer/more-specific labels first (see extract-gold-results.ts)
const KNOWN_MODELS = [
  'opus48', 'opus47', 'opus45', 'opus',
  'sonnet46', 'sonnet45',
  'haiku',
  'codex53',
  'gpt55', 'gpt54nano', 'gpt54mini', 'gpt54',
  'gemini37flash', 'gemini35flash', 'gemini31', 'geminiflash', 'gemini',
  'glm', 'kimi', 'qwen3max', 'qwen35', 'qwen3',
  'gpt56luna-xhigh', 'grok46', 'grok45',
];

interface SmithTeamTrial {
  model: string;
  jobDir: string;
  trialDir: string;
  reward: number;            // store value of the best valid smithed item
  bestItem: any;             // { name, cost, bot, levelRequired, smithingLevel, method, elapsedSecs }
  suspectedCheat: boolean;
  invalidBest: any;
  perBot: any;
  chatCount: number;
  tokens: any;
}

/** Write the in-game chat transcript for a trial as readable text. */
function writeTranscript(trial: { jobDir: string }, chat: any[]): string | null {
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
  for (const p of [
    join(trialDir, 'verifier', 'reward.json'),
    join(trialDir, 'verifier', 'logs', 'reward.json'),
  ]) {
    if (existsSync(p)) {
      try { return JSON.parse(readFileSync(p, 'utf-8')); } catch {}
    }
  }
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
  const jobDirs = resolveJobDirs(JOBS_DIR, explicitDirs, filter || 'smith-team');

  const trials: SmithTeamTrial[] = [];

  for (const jobDir of jobDirs) {
    const jobName = basename(jobDir);
    // Job names are smith-team-<label>-<timestamp> — prefer the exact label
    const nameMatch = jobName.match(/^smith-team-(.+)-\d{8}-\d{6}$/);
    const model = (nameMatch && nameMatch[1]) ||
      detectModelFromConfig(jobDir, KNOWN_MODELS) || detectModel(jobName, KNOWN_MODELS);

    for (const trialDir of getTrialDirs(jobDir)) {
      const reward = readReward(trialDir);
      if (!reward) {
        console.log(`  no reward data: ${trialDir}`);
        continue;
      }
      const chat = reward.chat ?? reward.tracking?.chat ?? [];
      const trial: SmithTeamTrial = {
        model,
        jobDir: jobName,
        trialDir: basename(trialDir),
        reward: reward.reward ?? 0,
        bestItem: reward.bestItem ?? null,
        suspectedCheat: !!reward.suspectedCheat,
        invalidBest: reward.invalidBest ?? null,
        perBot: reward.perBot ?? null,
        chatCount: chat.length,
        tokens: findTokenUsageInTrial(trialDir),
      };
      const transcriptPath = writeTranscript(trial, chat);
      if (transcriptPath) console.log(`  transcript: ${transcriptPath} (${chat.length} messages)`);
      trials.push(trial);
    }
  }

  // Per-model summary: best item value across trials
  const byModel: Record<string, any> = {};
  for (const t of trials) {
    const m = (byModel[t.model] ??= { model: t.model, trials: [], best: 0, bestItem: null });
    m.trials.push(t);
    if (t.reward > m.best) {
      m.best = t.reward;
      m.bestItem = t.bestItem;
    }
  }

  console.log(`\n${trials.length} trial(s) across ${Object.keys(byModel).length} model(s):\n`);
  for (const m of Object.values(byModel).sort((a: any, b: any) => b.best - a.best)) {
    const item = m.bestItem ? `${m.bestItem.name} by ${m.bestItem.bot}` : '—';
    const cheats = m.trials.filter((t: SmithTeamTrial) => t.suspectedCheat).length;
    const chatTotal = m.trials.reduce((s: number, t: SmithTeamTrial) => s + (t.chatCount || 0), 0);
    console.log(`  ${m.model.padEnd(16)} best=${String(m.best).padStart(6)}gp  ${item.padEnd(32)} trials=${m.trials.length} chat=${chatTotal} msgs${cheats ? `  SUSPECTED-CHEAT×${cheats}` : ''}`);
  }

  writeResults(RESULTS_DIR, { models: byModel, trials }, 'SMITH_TEAM_DATA');
}

main();
