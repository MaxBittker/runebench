#!/usr/bin/env bun
/**
 * Regenerate the skills-30m leaderboard from benchmark result files.
 *
 * Scans results/skills-30m/*.json (one file per model, as written by
 * extractors/extract-skill-results.ts) and extracts the peak XP/min per skill.
 * The score is the same quantity reported by docker/check_xp_rate.ts:
 *
 *   peak XP/min = raw server XP/min ÷ GAME_SPEED(8) ÷ XP_MULTIPLIER(25)
 *
 * When samples are present the peak is recomputed from them (same algorithm as
 * check_xp_rate.ts); when samples are missing or truncated it falls back to the
 * stored `peakXpRate`. Missing/corrupt/partial files are skipped with a warning,
 * never fatal — a partial result set still produces a leaderboard.
 *
 * Usage:
 *   bun scripts/update-leaderboard.ts                       # update default artifact
 *   bun scripts/update-leaderboard.ts --dir results/skills-30m --output results/skills-30m/LEADERBOARD.md
 *   bun scripts/update-leaderboard.ts --stdout              # print instead of write
 */

import { readFileSync, readdirSync, writeFileSync } from 'fs';
import { join, basename, relative } from 'path';

// Must stay in sync with docker/check_xp_rate.ts (guarded by
// scripts/check-xp-normalization-sync.ts).
const GAME_SPEED = 8;
const XP_MULTIPLIER = 25;
const NORMALIZATION_DIVISOR = GAME_SPEED * XP_MULTIPLIER; // 200

export interface SkillSample {
  elapsedMs: number;
  skills: Record<string, { xp?: number }>;
}

export interface SkillResult {
  jobName?: string;
  peakXpRate?: number;
  finalXp?: number;
  finalLevel?: number;
  durationSeconds?: number;
  sampleCount?: number;
  samples?: SkillSample[];
  [key: string]: unknown;
}

export interface ModelResults {
  model?: string;
  skills?: Record<string, SkillResult>;
}

export interface LeaderboardEntry {
  model: string;
  skill: string;
  /** Normalized real-game XP/min (the scored quantity). */
  peakXpPerMin: number;
  /** How the score was obtained. */
  source: 'samples' | 'stored';
  timestamp: string | null; // ISO-ish "YYYY-MM-DD HH:MM:SS"
  sourcePath: string; // path relative to repo root
}

/** Case-insensitive skill XP lookup within one sample (mirrors check_xp_rate.ts). */
export function getSkillXp(sample: SkillSample | undefined | null, skill: string): number {
  if (!sample?.skills) return 0;
  for (const [name, data] of Object.entries(sample.skills)) {
    if (name.toLowerCase() === skill.toLowerCase()) return (data as { xp?: number })?.xp || 0;
  }
  return 0;
}

export interface PeakWindow {
  rate: number; // normalized real-game XP/min
  deltaXp: number;
  deltaMs: number;
}

const EMPTY_PEAK: PeakWindow = { rate: 0, deltaXp: 0, deltaMs: 0 };

/** Peak normalized XP/min over consecutive sample pairs (mirrors check_xp_rate.ts). */
export function computePeakRate(samples: SkillSample[] | undefined, skill: string): PeakWindow {
  if (!samples || samples.length < 2) return EMPTY_PEAK;
  let best = EMPTY_PEAK;
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const curr = samples[i];
    const deltaXp = getSkillXp(curr, skill) - getSkillXp(prev, skill);
    const deltaMs = curr.elapsedMs - prev.elapsedMs;
    if (!Number.isFinite(deltaXp) || !Number.isFinite(deltaMs)) continue;
    if (deltaMs <= 0 || deltaXp <= 0) continue;
    const rawRate = (deltaXp / deltaMs) * 60000;
    const rate = rawRate / NORMALIZATION_DIVISOR;
    if (rate > best.rate) best = { rate, deltaXp, deltaMs };
  }
  return best;
}

/** Parse the run timestamp embedded in job names like skills-30m-gemini-20260310-160121. */
export function timestampFromJobName(jobName: unknown): string | null {
  if (typeof jobName !== 'string') return null;
  const m = jobName.match(/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
}

/** Extract one leaderboard entry per model×skill. Returns [] on unusable input. */
export function extractEntries(
  fileName: string,
  data: unknown,
  sourcePath: string,
): LeaderboardEntry[] {
  if (typeof data !== 'object' || data === null) return [];
  const record = data as ModelResults;
  const skills = record.skills;
  if (typeof skills !== 'object' || skills === null) return [];
  const entries: LeaderboardEntry[] = [];
  for (const [skill, result] of Object.entries(skills)) {
    if (typeof result !== 'object' || result === null) continue;
    const computed = computePeakRate(result.samples, skill);
    const stored = typeof result.peakXpRate === 'number' && Number.isFinite(result.peakXpRate)
      ? result.peakXpRate
      : null;
    let peakXpPerMin: number;
    let source: LeaderboardEntry['source'];
    if (computed.rate > 0) {
      // Prefer the recomputed value but never regress below a higher stored one
      // (e.g. trimmed samples in the extractor can lose the true peak window).
      peakXpPerMin = stored !== null ? Math.max(computed.rate, stored) : computed.rate;
      source = 'samples';
    } else if (stored !== null) {
      peakXpPerMin = stored;
      source = 'stored';
    } else {
      continue; // no usable score at all — skip gracefully
    }
    const ts = timestampFromJobName(result.jobName);
    entries.push({
      model: typeof record.model === 'string' && record.model ? record.model : basename(fileName, '.json'),
      skill,
      peakXpPerMin,
      source,
      timestamp: ts,
      sourcePath,
    });
  }
  return entries;
}

function formatScore(n: number): string {
  return n >= 100 ? String(Math.round(n)) : n.toFixed(1).replace(/\.0$/, '');
}

/** Render the markdown leaderboard artifact. */
export function buildLeaderboardMarkdown(entries: LeaderboardEntry[], generatedAt: Date): string {
  const sorted = [...entries].sort((a, b) => b.peakXpPerMin - a.peakXpPerMin);

  // Per-model summary: each model's best skill and total across skills.
  const byModel = new Map<string, LeaderboardEntry[]>();
  for (const e of sorted) {
    const list = byModel.get(e.model) ?? [];
    list.push(e);
    byModel.set(e.model, list);
  }
  const summary = [...byModel.entries()]
    .map(([model, list]) => ({
      model,
      bestScore: list[0].peakXpPerMin,
      bestSkill: list[0].skill,
      runs: list.length,
      total: list.reduce((s, e) => s + e.peakXpPerMin, 0),
    }))
    .sort((a, b) => b.bestScore - a.bestScore);

  const lines: string[] = [
    '# Skills 30m Leaderboard',
    '',
    `Generated: ${generatedAt.toISOString()}`,
    '',
    'Score = **peak XP/min** (`docker/check_xp_rate.ts`): raw server XP/min ÷ 8 (game speed) ÷ 25 (xpRate).',
    `Sources scanned: \`results/skills-30m/*.json\` (${sorted.length} model×skill runs across ${summary.length} models).`,
    '',
    '## Overall (best skill per model)',
    '',
    '| # | Model | Best Score (XP/min) | Best Skill | Skills Run | Σ All Skills |',
    '|---|-------|--------------------:|------------|-----------:|-------------:|',
  ];
  summary.forEach((row, i) => {
    lines.push(
      `| ${i + 1} | ${row.model} | ${formatScore(row.bestScore)} | ${row.bestSkill} | ${row.runs} | ${formatScore(row.total)} |`,
    );
  });

  lines.push(
    '',
    '## All runs (sorted by score)',
    '',
    '| # | Model | Skill | Peak XP/min | Source | Timestamp | Result File |',
    '|---|-------|-------|------------:|--------|-----------|-------------|',
  );
  sorted.forEach((e, i) => {
    lines.push(
      `| ${i + 1} | ${e.model} | ${e.skill} | ${formatScore(e.peakXpPerMin)} | ${e.source} | ${e.timestamp ?? '—'} | \`${e.sourcePath}\` |`,
    );
  });
  lines.push('');
  return lines.join('\n');
}

export interface ScanOptions {
  dir: string;
  /** Repo-root-relative prefix recorded in the leaderboard's source paths. */
  displayRoot?: string;
}

/** Scan a results directory and extract all leaderboard entries. Never throws on bad files. */
export function scanResults({ dir, displayRoot }: ScanOptions): { entries: LeaderboardEntry[]; warnings: string[] } {
  const warnings: string[] = [];
  const entries: LeaderboardEntry[] = [];
  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('_')).sort();
  } catch (err) {
    warnings.push(`Cannot read directory ${dir}: ${(err as Error).message}`);
    return { entries, warnings };
  }
  if (files.length === 0) warnings.push(`No .json result files found in ${dir}`);
  for (const f of files) {
    const path = join(dir, f);
    try {
      const raw = readFileSync(path, 'utf-8');
      let data: unknown;
      try {
        data = JSON.parse(raw);
      } catch {
        warnings.push(`Skipping ${f}: invalid JSON`);
        continue;
      }
      const extracted = extractEntries(f, data, relative(displayRoot ?? '.', path));
      if (extracted.length === 0) warnings.push(`Skipping ${f}: no usable skill results`);
      entries.push(...extracted);
    } catch (err) {
      warnings.push(`Skipping ${f}: ${(err as Error).message}`);
    }
  }
  return { entries, warnings };
}

// ── CLI ──────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  const dir = flag('--dir') ?? join(import.meta.dir, '..', 'results', 'skills-30m');
  const output = flag('--output') ?? join(dir, 'LEADERBOARD.md');
  const stdout = args.includes('--stdout');

  const { entries, warnings } = scanResults({ dir });
  for (const w of warnings) console.warn(`warn: ${w}`);

  if (entries.length === 0) {
    console.error(`error: no leaderboard entries could be extracted from ${dir}`);
    process.exit(1);
  }

  const md = buildLeaderboardMarkdown(entries, new Date());
  if (stdout) {
    console.log(md);
  } else {
    writeFileSync(output, md);
    console.log(`Wrote ${output} (${entries.length} runs from ${new Set(entries.map(e => e.model)).size} models)`);
  }
}

if (import.meta.main) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
