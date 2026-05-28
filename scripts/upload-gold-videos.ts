#!/usr/bin/env bun
/**
 * Crop + upload gold-benchmark recording videos to Cloudflare R2.
 *
 * Patterned after upload-videos.ts --from-results: reads
 * `results/gold/_combined.json`, walks each trial's `trialDir`, and uploads
 * the recording with key `gold-<horizon>/<model>/gold-<condition>.mp4` so
 * TrajectoryModal can find it via the same videoUrl lookup.
 *
 * Usage:
 *   bun scripts/upload-gold-videos.ts                # 30m only (default)
 *   bun scripts/upload-gold-videos.ts --horizon 15m  # smoke-test horizon
 *   bun scripts/upload-gold-videos.ts --all          # both 15m + 30m
 *   bun scripts/upload-gold-videos.ts --force        # overwrite manifest entries
 */

import { readdirSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const ROOT = join(import.meta.dir, '..');
const COMBINED_PATH = join(ROOT, 'results', 'gold', '_combined.json');
const MANIFEST_PATH = join(ROOT, 'results', 'video-urls.json');

const R2_BUCKET = 'rs-videos';
const CF_ACCOUNT_ID = '01ffb951a87113b20a7c43c34bad6e92';
const CROP_FILTER = 'crop=367:240:17:32';
const PUBLIC_BASE = 'https://pub-f4a8dd0fc02f4f56943a5d84b3932d2f.r2.dev';

// ── CLI args ────────────────────────────────────────────────────────
let horizon = '30m';
let allHorizons = false;
let force = false;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--horizon' && process.argv[i + 1]) {
    horizon = process.argv[++i];
  } else if (process.argv[i] === '--all') {
    allHorizons = true;
  } else if (process.argv[i] === '--force') {
    force = true;
  }
}

if (!existsSync(COMBINED_PATH)) {
  console.error(`Not found: ${COMBINED_PATH}. Run extract-gold-results.ts first.`);
  process.exit(1);
}

const combined: Record<string, Record<string, { trialDir?: string }>> = JSON.parse(
  readFileSync(COMBINED_PATH, 'utf-8'),
);

// ── Build video list ────────────────────────────────────────────────
interface Entry {
  horizon: string;
  condition: string;
  model: string;
  localPath: string;
  r2Key: string;
  manifestKey: string;
}

const entries: Entry[] = [];

for (const [variant, byModel] of Object.entries(combined)) {
  const m = variant.match(/^(.+)-(\d+[mh])$/);
  if (!m) continue;
  const condition = m[1];
  const vHorizon = m[2];
  if (!allHorizons && vHorizon !== horizon) continue;

  for (const [model, r] of Object.entries(byModel)) {
    if (!r.trialDir) continue;
    const trialDir = r.trialDir.startsWith('/') ? r.trialDir : join(ROOT, r.trialDir);
    const vidPath = join(trialDir, 'verifier', 'recording.mp4');
    if (!existsSync(vidPath)) continue;

    const r2Key = `gold-${vHorizon}/${model}/gold-${condition}.mp4`;
    const manifestKey = `gold-${vHorizon}/${model}/gold-${condition}`;
    entries.push({ horizon: vHorizon, condition, model, localPath: vidPath, r2Key, manifestKey });
  }
}

if (entries.length === 0) {
  console.log('No videos to upload.');
  process.exit(0);
}

console.log(`Found ${entries.length} gold recordings (horizon: ${allHorizons ? 'all' : horizon})`);

// ── Manifest ────────────────────────────────────────────────────────
let manifest: Record<string, string> = {};
if (existsSync(MANIFEST_PATH)) {
  try { manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')); } catch {}
}

// ── Shell helper ────────────────────────────────────────────────────
async function run(cmd: string[], env?: Record<string, string>) {
  const proc = Bun.spawn(cmd, {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { ok: code === 0, stdout, stderr };
}

// ── Process ─────────────────────────────────────────────────────────
const CONCURRENCY = 8;
const tmpDir = join(tmpdir(), 'rs-gold-video-upload');
mkdirSync(tmpDir, { recursive: true });

let uploaded = 0;
let skipped = 0;
let failed = 0;
let done = 0;

async function processEntry(e: Entry) {
  const label = `${e.model}/gold-${e.condition}-${e.horizon}`;

  if (!force && manifest[e.manifestKey]) {
    skipped++;
    done++;
    return;
  }

  const tmpFile = join(tmpDir, `${e.model}-${e.condition}-${e.horizon}.mp4`);
  const ff = await run([
    'ffmpeg', '-i', e.localPath,
    '-vf', CROP_FILTER,
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '30',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-y', tmpFile,
  ]);
  if (!ff.ok) {
    console.error(`  FAIL ffmpeg: ${label}`);
    failed++; done++;
    return;
  }

  const bk = await run([
    'ffmpeg', '-i', tmpFile, '-vf', 'select=eq(n\\,30),signalstats', '-frames:v', '1', '-f', 'null', '-',
  ]);
  const yavgMatch = bk.stderr.match(/YAVG:\s*(\d+)/);
  const yavg = yavgMatch ? parseInt(yavgMatch[1]) : 255;
  if (yavg < 10) {
    console.log(`  skip (black): ${label} (YAVG=${yavg})`);
    skipped++; done++;
    return;
  }

  const up = await run(
    ['wrangler', 'r2', 'object', 'put', `${R2_BUCKET}/${e.r2Key}`, '--file', tmpFile, '--content-type', 'video/mp4'],
    { CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT_ID },
  );
  if (!up.ok) {
    console.error(`  FAIL upload: ${label}\n${up.stderr}`);
    failed++; done++;
    return;
  }

  manifest[e.manifestKey] = `${PUBLIC_BASE}/${e.r2Key}`;
  uploaded++;
  done++;
  if (done % 5 === 0 || done === entries.length) {
    console.log(`  [${done}/${entries.length}] ${uploaded} uploaded, ${skipped} skipped, ${failed} failed`);
  }
}

const queue = entries.slice();
async function worker() {
  while (queue.length > 0) {
    const e = queue.shift()!;
    await processEntry(e);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

// ── Write manifest ──────────────────────────────────────────────────
mkdirSync(join(ROOT, 'results'), { recursive: true });
writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));

console.log(`\nDone. ${uploaded} uploaded, ${skipped} skipped, ${failed} failed.`);
console.log(`Manifest: ${MANIFEST_PATH} (${Object.keys(manifest).length} entries)`);
