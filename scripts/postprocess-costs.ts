#!/usr/bin/env bun
/**
 * Backfill cost_usd on Harbor trial results.
 *
 * Ported from vendor-runescape-rl/scripts/postprocess-costs.ts but reads the
 * pricing table from shared/pricing.ts so the UI and extractors agree.
 *
 * Walks a jobs directory, reads each trial's result.json + trajectory.json,
 * computes cost from n_input_tokens / n_cache_tokens / n_output_tokens, and
 * writes cost_usd back in-place when it's missing (or when --force is set).
 *
 * OpenCode-run trials already have cost_usd filled in (OpenCode reports it per
 * step). This script primarily helps claude-code, codex, and gemini-cli runs.
 *
 * Usage:
 *   bun scripts/postprocess-costs.ts                  # default: jobs/
 *   bun scripts/postprocess-costs.ts --jobs-dir eval_results
 *   bun scripts/postprocess-costs.ts --force          # overwrite existing cost_usd
 *   bun scripts/postprocess-costs.ts --force --models gpt54mini,gpt54nano
 *                                                     # force-recompute only for
 *                                                     # trials whose resolved
 *                                                     # pricing key is in the list
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { computeCost, MODEL_PRICING, HARBOR_MODEL_PRICING } from '../shared/pricing';

// ── CLI args ────────────────────────────────────────────────────────
let jobsDir = join(process.cwd(), 'jobs');
let force = false;
let modelsFilter: Set<string> | null = null;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--jobs-dir' && process.argv[i + 1]) {
    jobsDir = process.argv[++i];
    if (!jobsDir.startsWith('/')) jobsDir = join(process.cwd(), jobsDir);
  } else if (process.argv[i] === '--force') {
    force = true;
  } else if (process.argv[i] === '--models' && process.argv[i + 1]) {
    modelsFilter = new Set(process.argv[++i].split(',').map((s) => s.trim()).filter(Boolean));
  }
}

function resolvePricingKey(modelName: string): string | null {
  if (MODEL_PRICING[modelName]) return modelName;
  if (HARBOR_MODEL_PRICING[modelName]) return HARBOR_MODEL_PRICING[modelName];
  return null;
}

if (!existsSync(jobsDir)) {
  console.error(`Directory not found: ${jobsDir}`);
  process.exit(1);
}

// ── Walk trial dirs ─────────────────────────────────────────────────
let updated = 0;
let skippedNoChange = 0;
let skippedNoTokens = 0;
let skippedNoPricing = 0;

function processTrialDir(trialDir: string) {
  const resultPath = join(trialDir, 'result.json');
  if (!existsSync(resultPath)) return;

  const result = JSON.parse(readFileSync(resultPath, 'utf-8'));

  // Resolve model name (prefer agent_info.model_info which is post-run truth)
  const cfgAgent = result.config?.agent || {};
  const modelInfo = result.agent_info?.model_info || {};
  let modelName = cfgAgent.model_name || '';
  if (modelInfo.provider && modelInfo.name) {
    modelName = `${modelInfo.provider}/${modelInfo.name}`;
  }

  const ar = result.agent_result || {};
  const inputTokens = ar.n_input_tokens || 0;
  const cacheTokens = ar.n_cache_tokens || 0;
  const outputTokens = ar.n_output_tokens || 0;

  if (inputTokens === 0 && outputTokens === 0) {
    skippedNoTokens++;
    return;
  }

  const cost = computeCost(modelName, inputTokens, cacheTokens, outputTokens);
  if (cost === null) {
    skippedNoPricing++;
    return;
  }

  // If a models filter is set, force only applies to matching models
  const pricingKey = resolvePricingKey(modelName);
  const forceThis = force && (modelsFilter === null || (pricingKey !== null && modelsFilter.has(pricingKey)));

  // Write cost_usd back if missing or forced for this model
  let dirty = false;
  if (ar.cost_usd == null || forceThis) {
    ar.cost_usd = Math.round(cost * 1_000_000) / 1_000_000;
    result.agent_result = ar;
    dirty = true;
  }
  if (dirty) writeFileSync(resultPath, JSON.stringify(result, null, 2));

  // Mirror into trajectory.json final_metrics.total_cost_usd
  const trajPath = join(trialDir, 'agent', 'trajectory.json');
  if (existsSync(trajPath)) {
    try {
      const traj = JSON.parse(readFileSync(trajPath, 'utf-8'));
      const fm = traj.final_metrics;
      if (fm && (fm.total_cost_usd == null || forceThis)) {
        fm.total_cost_usd = Math.round(cost * 1_000_000) / 1_000_000;
        traj.final_metrics = fm;
        writeFileSync(trajPath, JSON.stringify(traj, null, 2));
      }
    } catch {}
  }

  if (dirty) updated++;
  else skippedNoChange++;
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
      if (isTrialDir(subDir)) processTrialDir(subDir);
    }
  } catch {}

  if (isTrialDir(jobDir)) processTrialDir(jobDir);
}

console.log(`Updated ${updated} trial(s).`);
console.log(`  skipped ${skippedNoChange} already-had-cost`);
console.log(`  skipped ${skippedNoTokens} no-token-data`);
console.log(`  skipped ${skippedNoPricing} no-pricing-for-model`);
