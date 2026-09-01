#!/usr/bin/env bun
/**
 * Builds results/smith-team/_viz.js — compact per-trial timeline data for the
 * smith-team visualizer (views/smith-team-viz.html).
 *
 * Reads each smith-team job's verifier/reward.json (full watcher tracking)
 * and emits, per trial:
 *   - samples: [t, x,z,smith,mine ×3 bots] (t = seconds on the watcher clock)
 *   - chat:    [t, botIdx, text]
 *   - events:  [t, botIdx, itemName, cost, valid]  (smithable item gains)
 *   - meta:    model, job, reward, bestItem
 *
 * Usage: bun scripts/build-smith-team-viz-data.ts
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, basename } from 'path';

const REPO_ROOT = join(import.meta.dir, '..');
const JOBS_DIR = join(REPO_ROOT, 'jobs');
const OUT_FILE = join(REPO_ROOT, 'results', 'smith-team', '_viz.js');

const BOTS = ['agenta', 'agentb', 'agentc'];

interface VizTrial {
  model: string;
  job: string;
  reward: number;
  bestItem: any;
  bots: string[];
  /** [t, x0,z0,s0,m0, x1,z1,s1,m1, x2,z2,s2,m2] — null where unknown */
  samples: Array<Array<number | null>>;
  /** [t, botIdx, text] (botIdx -1 = unknown sender) */
  chat: Array<[number, number, string]>;
  /** [t, botIdx, name, cost, valid 0|1] — 'gained' events only */
  events: Array<[number, number, string, number, number]>;
}

function findRewardJson(jobDir: string): string | null {
  for (const entry of readdirSync(jobDir)) {
    const p = join(jobDir, entry, 'verifier', 'reward.json');
    if (existsSync(p)) return p;
  }
  return null;
}

const trials: VizTrial[] = [];

const jobDirs = readdirSync(JOBS_DIR)
  .filter(d => d.startsWith('smith-team-'))
  .sort();

for (const jobName of jobDirs) {
  const rewardPath = findRewardJson(join(JOBS_DIR, jobName));
  if (!rewardPath) {
    console.log(`  skip (no reward.json): ${jobName}`);
    continue;
  }
  const reward = JSON.parse(readFileSync(rewardPath, 'utf-8'));
  const tracking = reward.tracking;
  const model = jobName.match(/^smith-team-(.+)-\d{8}-\d{6}$/)?.[1] ?? jobName;

  const samples: Array<Array<number | null>> = [];
  for (const s of tracking?.samples ?? []) {
    const row: Array<number | null> = [Math.round((s.elapsedMs ?? 0) / 1000)];
    for (const bot of BOTS) {
      const b = s.bots?.[bot];
      row.push(
        b?.position?.x ?? null,
        b?.position?.z ?? null,
        b?.smithing?.level ?? null,
        b?.mining?.level ?? null,
      );
    }
    samples.push(row);
  }

  const chat: Array<[number, number, string]> = (tracking?.chat ?? []).map((c: any) => [
    Math.round((c.elapsedMs ?? 0) / 1000),
    BOTS.indexOf((c.sender ?? '').toLowerCase()),
    c.text ?? '',
  ]);

  const events: Array<[number, number, string, number, number]> = (tracking?.events ?? [])
    .filter((e: any) => e.event === 'gained')
    .map((e: any) => [
      Math.round((e.elapsedMs ?? 0) / 1000),
      BOTS.indexOf(e.bot),
      e.name,
      e.cost,
      e.valid ? 1 : 0,
    ]);

  trials.push({
    model,
    job: jobName,
    reward: reward.reward ?? 0,
    bestItem: reward.bestItem ?? null,
    bots: BOTS,
    samples,
    chat,
    events,
  });
  console.log(`  ${jobName}: ${samples.length} samples, ${chat.length} chat, ${events.length} events`);
}

// Order: best score first
trials.sort((a, b) => b.reward - a.reward);

const payload = { generated: new Date().toISOString(), trials };
writeFileSync(OUT_FILE, `window.SMITH_VIZ = ${JSON.stringify(payload)};\n`);
console.log(`\nWrote ${trials.length} trials → ${OUT_FILE} (${(Bun.file(OUT_FILE).size / 1e6).toFixed(1)} MB)`);
