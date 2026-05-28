#!/usr/bin/env bun
/**
 * CLI tool to check peak XP rate for a skill.
 * Reads skill tracking data and computes peak XP/min from 15-second windows.
 *
 * Usage: bun /cli/check_xp_rate.ts <SkillName>
 * Example: bun /cli/check_xp_rate.ts Woodcutting
 *
 * Returns peak XP rate overall, and since your last call.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';

// The skill_tracker daemon writes here (see ensure-services.sh).
const TRACKING_FILE = process.env.TRACKING_FILE || '/logs/tracking/skill_tracking.json';
const STATE_FILE = '/tmp/last_xp_rate_check.json';

const skillName = process.argv[2];
if (!skillName) {
  console.error('Usage: bun /cli/check_xp_rate.ts <SkillName>');
  console.error('Example: bun /cli/check_xp_rate.ts Woodcutting');
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

function computePeakRate(samples: any[], skill: string, startIdx: number = 0): number {
  let peak = 0;
  for (let i = Math.max(1, startIdx); i < samples.length; i++) {
    const prev = samples[i - 1];
    const curr = samples[i];
    const deltaXp = getSkillXp(curr, skill) - getSkillXp(prev, skill);
    const deltaMs = curr.elapsedMs - prev.elapsedMs;
    if (deltaMs <= 0 || deltaXp <= 0) continue;
    const rate = (deltaXp / deltaMs) * 60000 / 8 / 25; // real-game XP/min (÷8 game speed, ÷25 XP rate)
    if (rate > peak) peak = rate;
  }
  return Math.round(peak);
}

// Read tracking data
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

// Read last check state
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

// Compute time remaining from tracking start + benchmark duration
const lastSample = samples[samples.length - 1];
const elapsedSecs = Math.round(lastSample.elapsedMs / 1000);
const benchmarkDuration = parseInt(process.env.BENCHMARK_DURATION_SECS || '0');
const remainingSecs = benchmarkDuration > 0 ? Math.max(0, benchmarkDuration - elapsedSecs) : 0;

const fmtTime = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
};

console.log(`Peak XP rate for ${skillName}:`);
console.log(`  Overall:          ${overallPeak.toLocaleString()} XP/min`);
if (lastCheckIdx > 0) {
  console.log(`  Since last check: ${recentPeak.toLocaleString()} XP/min`);
}
if (benchmarkDuration > 0) {
  console.log(`  Time elapsed:     ${fmtTime(elapsedSecs)} / ${fmtTime(benchmarkDuration)}`);
  console.log(`  Time remaining:   ${fmtTime(remainingSecs)}`);
}

// Save state for next call
writeFileSync(STATE_FILE, JSON.stringify({ sampleCount: samples.length, timestamp: Date.now() }));
