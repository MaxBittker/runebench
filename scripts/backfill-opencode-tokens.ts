#!/usr/bin/env bun
/**
 * Backfill token counts + cost_usd into result.json for OpenCode trials whose
 * trajectory.json is missing (so populate_context_post_run never wrote them).
 *
 * Parses jobs/<job>/<trial>/agent/opencode-*.txt directly and sums the
 * `step_finish` event tokens/cost, matching the logic in
 * agents/opencode_adapter.py::_parse_opencode_log.
 *
 * Usage:
 *   bun scripts/backfill-opencode-tokens.ts                 # jobs/, only null-token trials
 *   bun scripts/backfill-opencode-tokens.ts --force         # overwrite existing values
 *   bun scripts/backfill-opencode-tokens.ts --jobs-dir DIR
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

let jobsDir = join(process.cwd(), 'jobs');
let force = false;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--jobs-dir' && process.argv[i + 1]) {
    jobsDir = process.argv[++i];
    if (!jobsDir.startsWith('/')) jobsDir = join(process.cwd(), jobsDir);
  } else if (process.argv[i] === '--force') {
    force = true;
  }
}

if (!existsSync(jobsDir)) {
  console.error(`Directory not found: ${jobsDir}`);
  process.exit(1);
}

interface Totals { input: number; output: number; cache: number; cost: number; steps: number; }

function sumFromLog(logPath: string): Totals | null {
  let input = 0, output = 0, cache = 0, cost = 0, steps = 0;
  const content = readFileSync(logPath, 'utf-8');
  for (const line of content.split('\n')) {
    if (!line.startsWith('{')) continue;
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type !== 'step_finish') continue;
    const part = ev.part || {};
    const t = part.tokens || {};
    const c = (t.cache || {});
    const total = t.total || 0;
    const out = t.output || 0;
    // Match opencode_adapter.py: prompt = total - output; cached = cache.read
    input += Math.max(0, total - out);
    output += out;
    cache += c.read || 0;
    cost += part.cost || 0;
    steps++;
  }
  if (steps === 0) return null;
  return { input, output, cache, cost, steps };
}

let updated = 0, skippedHasTokens = 0, skippedNoLog = 0, skippedEmptyLog = 0;

function findOpenCodeLog(agentDir: string): string | null {
  try {
    const files = readdirSync(agentDir);
    const match = files.find(f => f.startsWith('opencode-') && f.endsWith('.txt'));
    return match ? join(agentDir, match) : null;
  } catch { return null; }
}

function processTrial(trialDir: string) {
  const resultPath = join(trialDir, 'result.json');
  if (!existsSync(resultPath)) return;

  const agentDir = join(trialDir, 'agent');
  if (!existsSync(agentDir)) return;

  const logPath = findOpenCodeLog(agentDir);
  if (!logPath) { skippedNoLog++; return; }

  const result = JSON.parse(readFileSync(resultPath, 'utf-8'));
  const ar = result.agent_result || {};

  const hasTokens = ar.n_input_tokens != null && ar.n_input_tokens > 0;
  if (hasTokens && !force) { skippedHasTokens++; return; }

  const totals = sumFromLog(logPath);
  if (!totals || (totals.input === 0 && totals.output === 0)) { skippedEmptyLog++; return; }

  ar.n_input_tokens = totals.input;
  ar.n_output_tokens = totals.output;
  ar.n_cache_tokens = totals.cache;
  ar.cost_usd = Math.round(totals.cost * 1_000_000) / 1_000_000;
  result.agent_result = ar;
  writeFileSync(resultPath, JSON.stringify(result, null, 2));

  // Mirror into trajectory.json if one exists
  const trajPath = join(agentDir, 'trajectory.json');
  if (existsSync(trajPath)) {
    try {
      const traj = JSON.parse(readFileSync(trajPath, 'utf-8'));
      if (traj.final_metrics) {
        traj.final_metrics.total_cost_usd = ar.cost_usd;
        traj.final_metrics.total_prompt_tokens = totals.input;
        traj.final_metrics.total_completion_tokens = totals.output;
        traj.final_metrics.total_cached_tokens = totals.cache;
        writeFileSync(trajPath, JSON.stringify(traj, null, 2));
      }
    } catch {}
  }

  updated++;
  const rel = trialDir.startsWith(jobsDir) ? trialDir.slice(jobsDir.length + 1) : trialDir;
  console.log(`  ${rel}: ${totals.input}/${totals.output}/${totals.cache} tok, $${ar.cost_usd} (${totals.steps} steps)`);
}

function isTrialDir(dir: string): boolean {
  return existsSync(join(dir, 'agent')) || existsSync(join(dir, 'verifier'));
}

const topEntries = readdirSync(jobsDir, { withFileTypes: true });
for (const entry of topEntries) {
  if (!entry.isDirectory()) continue;
  const jobDir = join(jobsDir, entry.name);

  try {
    const subEntries = readdirSync(jobDir, { withFileTypes: true });
    for (const sub of subEntries) {
      if (!sub.isDirectory()) continue;
      const subDir = join(jobDir, sub.name);
      if (isTrialDir(subDir)) processTrial(subDir);
    }
  } catch {}

  if (isTrialDir(jobDir)) processTrial(jobDir);
}

console.log(`\nUpdated ${updated} trial(s).`);
console.log(`  skipped ${skippedHasTokens} already-had-tokens`);
console.log(`  skipped ${skippedNoLog} no-opencode-log`);
console.log(`  skipped ${skippedEmptyLog} empty-log (no step_finish events)`);
