#!/usr/bin/env bun
/**
 * CLI tool to check peak XP rate for a skill (peak XP/min over 15s windows).
 * The reported rate IS the benchmark score: raw server XP ÷ GAME_SPEED ÷ XP_MULTIPLIER.
 *
 * Usage: bun /app/benchmark/shared/check_xp_rate.ts <SkillName>
 *
 * Copied standalone into the Docker image — no local imports allowed.
 * scripts/check-xp-normalization-sync.ts guards the normalization against drift.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';

// Written by the skill_tracker daemon (see ensure-services.sh).
const TRACKING_FILE = process.env.TRACKING_FILE || '/logs/tracking/skill_tracking.json';
const STATE_FILE = '/tmp/last_xp_rate_check.json';

const GAME_SPEED = 8; // engine default 400 ticks / NODE_TICKRATE=50 (docker/Dockerfile)
const XP_MULTIPLIER = 25; // server xpRate (rs-sdk WorldConfig.ts; overridable via NODE_XPRATE)
const NORMALIZATION_DIVISOR = GAME_SPEED * XP_MULTIPLIER; // 200

const skillName = process.argv[2];
if (!skillName) {
  console.error('Usage: bun /app/benchmark/shared/check_xp_rate.ts <SkillName>');
  console.error('Example: bun /app/benchmark/shared/check_xp_rate.ts Woodcutting');
  process.exit(1);
}

function getSkillXp(sample: any, skill: string): number {
  if (!sample?.skills) return 0;
  for (const [name, data] of Object.entries(sample.skills)) {
    if (name.toLowerCase() === skill.toLowerCase()) {
      return (data as any).xp || 0;
    }
  }
  return 0;
}

interface PeakWindow {
  rate: number; // normalized real-game XP/min (the scored quantity)
  rawRate: number; // raw server XP/min
  deltaXp: number;
  deltaMs: number;
  startElapsedMs: number;
  endElapsedMs: number;
}

const EMPTY_PEAK: PeakWindow = {
  rate: 0, rawRate: 0, deltaXp: 0, deltaMs: 0, startElapsedMs: 0, endElapsedMs: 0,
};

function computePeakRate(samples: any[], skill: string, startIdx: number = 0): PeakWindow {
  let best = EMPTY_PEAK;
  for (let i = Math.max(1, startIdx); i < samples.length; i++) {
    const prev = samples[i - 1];
    const curr = samples[i];
    const deltaXp = getSkillXp(curr, skill) - getSkillXp(prev, skill);
    const deltaMs = curr.elapsedMs - prev.elapsedMs;
    if (deltaMs <= 0 || deltaXp <= 0) continue;
    const rawRate = (deltaXp / deltaMs) * 60000;
    const rate = rawRate / NORMALIZATION_DIVISOR;
    if (rate > best.rate) {
      best = {
        rate, rawRate, deltaXp, deltaMs,
        startElapsedMs: prev.elapsedMs,
        endElapsedMs: curr.elapsedMs,
      };
    }
  }
  return best;
}

if (!existsSync(TRACKING_FILE)) {
  console.log('No tracking data yet. Start training first.');
  process.exit(0);
}

let data: any;
try {
  data = JSON.parse(readFileSync(TRACKING_FILE, 'utf-8'));
} catch {
  console.log('Could not read tracking data.');
  process.exit(1);
}

const samples = data?.samples || [];
if (samples.length < 2) {
  console.log('Not enough samples yet. Wait a few seconds.');
  process.exit(0);
}

let lastCheckIdx = 0;
if (existsSync(STATE_FILE)) {
  try {
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    if (state.sampleCount && state.sampleCount < samples.length) {
      lastCheckIdx = state.sampleCount - 1;
    }
  } catch {}
}

const overallPeak = computePeakRate(samples, skillName);
const recentPeak = lastCheckIdx > 0 ? computePeakRate(samples, skillName, lastCheckIdx) : overallPeak;

const lastSample = samples[samples.length - 1];
const elapsedSecs = Math.round(lastSample.elapsedMs / 1000);
const benchmarkDuration = parseInt(process.env.BENCHMARK_DURATION_SECS || '0');
const remainingSecs = benchmarkDuration > 0 ? Math.max(0, benchmarkDuration - elapsedSecs) : 0;

const fmtTime = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
};

const r = (n: number) => Math.round(n).toLocaleString();

console.log(`Peak XP rate for ${skillName} (this IS your score: real-game XP/min):`);
console.log(`  Peak:             ${r(overallPeak.rate)} XP/min`);
if (overallPeak.deltaXp > 0) {
  console.log(
    `    = ${r(overallPeak.rawRate)} raw XP/min ÷ ${GAME_SPEED} game speed ÷ ${XP_MULTIPLIER} xpRate ` +
    `(÷${NORMALIZATION_DIVISOR} total)`,
  );
  console.log(
    `    best window:    ${overallPeak.deltaXp.toLocaleString()} raw XP over ` +
    `${(overallPeak.deltaMs / 1000).toFixed(1)}s, at ` +
    `${fmtTime(Math.round(overallPeak.startElapsedMs / 1000))}-${fmtTime(Math.round(overallPeak.endElapsedMs / 1000))} elapsed`,
  );
}
if (lastCheckIdx > 0) {
  console.log(`  Since last check: ${r(recentPeak.rate)} XP/min`);
}
if (benchmarkDuration > 0) {
  console.log(`  Time elapsed:     ${fmtTime(elapsedSecs)} / ${fmtTime(benchmarkDuration)}`);
  console.log(`  Time remaining:   ${fmtTime(remainingSecs)}`);
}
const intervalMs = parseInt(process.env.SAMPLE_INTERVAL_MS || '15000');
const untilNextSecs = Math.max(0, Math.round((intervalMs - (lastSample.elapsedMs % intervalMs)) / 1000));
console.log(`  Sampled every ${(intervalMs / 1000).toFixed(0)}s; next sample in ~${untilNextSecs}s`);
console.log(`Raw in-game XP accrues ${NORMALIZATION_DIVISOR}x faster than this score — that gap is expected.`);

writeFileSync(STATE_FILE, JSON.stringify({ sampleCount: samples.length, timestamp: Date.now() }));
