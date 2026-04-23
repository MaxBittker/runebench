#!/usr/bin/env bun
/**
 * Crop and upload benchmark recording videos to Cloudflare R2.
 *
 * Scans jobs/ for recording.mp4 files, keeps only the latest run per
 * skill-horizon-model, crops + re-encodes with ffmpeg, then uploads via
 * wrangler to the rs-videos R2 bucket.
 *
 * Usage:
 *   bun scripts/upload-videos.ts --horizon 10m
 *   bun scripts/upload-videos.ts --horizon 30m
 *   bun scripts/upload-videos.ts --horizon 30m --force   # re-upload even if exists
 */

import { readdirSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const ROOT = join(import.meta.dir, "..");
const JOBS_DIR = join(ROOT, "jobs");
const MANIFEST_PATH = join(ROOT, "results", "video-urls.json");

const R2_BUCKET = "rs-videos";
const CF_ACCOUNT_ID = "01ffb951a87113b20a7c43c34bad6e92";
const CROP_FILTER = "crop=367:240:17:32";

// ── CLI args ──────────────────────────────────────────────────────

let horizon = "";
let force = false;
let fromResults = false;

for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--horizon" && process.argv[i + 1]) {
    horizon = process.argv[++i];
  } else if (process.argv[i] === "--force") {
    force = true;
  } else if (process.argv[i] === "--from-results") {
    fromResults = true;
  }
}

if (!horizon) {
  console.error("Usage: bun scripts/upload-videos.ts --horizon 10m|15m|30m [--force] [--from-results]");
  process.exit(1);
}

// Horizon duration in seconds — videos are trimmed to show exactly this much
// of agent gameplay (starting from agent_execution.started_at in result.json,
// skipping the container boot / idle prelude).
const horizonSec = parseInt(horizon.replace("m", ""), 10) * 60;

/** Read result.json next to a recording.mp4 and compute the offset (seconds)
 * from container start to agent start. Falls back to 0 if unavailable. */
function agentStartOffsetSec(videoPath: string): number {
  // videoPath = .../<trialDir>/verifier/recording.mp4
  const trialDir = join(videoPath, "..", "..");
  const resultPath = join(trialDir, "result.json");
  if (!existsSync(resultPath)) return 0;
  try {
    const r = JSON.parse(readFileSync(resultPath, "utf-8"));
    const containerStart = r.started_at as string | undefined;
    const agentStart = r.agent_execution?.started_at as string | undefined;
    if (!containerStart || !agentStart) return 0;
    const offsetMs = Date.parse(agentStart) - Date.parse(containerStart);
    if (!Number.isFinite(offsetMs) || offsetMs < 0) return 0;
    return Math.floor(offsetMs / 1000);
  } catch {
    return 0;
  }
}

// ── Job directory parsing (same as generate-video-grid.ts) ────────

interface VideoEntry {
  skill: string;
  horizon: string;
  model: string;
  timestamp: string;
  localPath: string; // absolute path to recording.mp4
}

/** Parse single-task dir: {skill}-xp-{horizon}-{model}-{timestamp} */
function parseSingleTaskDir(name: string): { skill: string; horizon: string; model: string; timestamp: string } | null {
  const m = name.match(/^(.+)-xp-(10m|15m|30m)-(.+)-(\d{8}-\d{6})$/);
  if (!m) return null;
  return { skill: m[1], horizon: m[2], model: m[3], timestamp: m[4] };
}

/** Parse dataset dir: skills-{horizon}-{model}-{timestamp} */
function parseDatasetDir(name: string): { horizon: string; model: string; timestamp: string } | null {
  const m = name.match(/^skills-(10m|15m|30m)-(.+)-(\d{8}-\d{6})$/);
  if (!m) return null;
  return { horizon: m[1], model: m[2], timestamp: m[3] };
}

/** Parse skill from trial dir name: {skill}-xp-{horizon}__{random} */
function parseTrialSkill(trialName: string): string | null {
  const m = trialName.match(/^(.+)-xp-(?:10m|15m|30m)__/);
  return m ? m[1] : null;
}

/** Find the first recording.mp4 inside a job dir (one level of trial subdirs) */
function findRecording(jobPath: string): string | null {
  try {
    const entries = readdirSync(jobPath);
    for (const entry of entries) {
      const vidPath = join(jobPath, entry, "verifier", "recording.mp4");
      if (existsSync(vidPath)) return vidPath;
    }
  } catch {}
  return null;
}

/** Find all recordings in a dataset job dir, keyed by skill */
function findDatasetRecordings(jobPath: string): { skill: string; localPath: string }[] {
  const results: { skill: string; localPath: string }[] = [];
  try {
    const entries = readdirSync(jobPath);
    for (const entry of entries) {
      const skill = parseTrialSkill(entry);
      if (!skill) continue;
      const vidPath = join(jobPath, entry, "verifier", "recording.mp4");
      if (existsSync(vidPath)) results.push({ skill, localPath: vidPath });
    }
  } catch {}
  return results;
}

// ── Build video list ──────────────────────────────────────────────

let videos: VideoEntry[];
/** Set of manifest keys that are valid for this horizon (used to clean stale entries) */
let validManifestKeys: Set<string> | undefined;

if (fromResults) {
  // --from-results: read _combined.json and use trialDir to find recordings.
  // This guarantees the uploaded video matches the extracted trajectory data.
  const combinedPath = join(ROOT, "results", `skills-${horizon}`, "_combined.json");
  if (!existsSync(combinedPath)) {
    console.error(`No combined results found at ${combinedPath}. Run extract-skill-results.ts first.`);
    process.exit(1);
  }

  const combined: Record<string, Record<string, { trialDir?: string }>> = JSON.parse(
    readFileSync(combinedPath, "utf-8"),
  );

  console.log(`Building video list from ${combinedPath}...\n`);

  const entries: VideoEntry[] = [];
  validManifestKeys = new Set();

  for (const [model, skills] of Object.entries(combined)) {
    for (const [skill, data] of Object.entries(skills)) {
      validManifestKeys.add(`${horizon}/${model}/${skill}`);

      if (!data.trialDir) continue;
      const trialDir = join(ROOT, data.trialDir);
      const videoPath = join(trialDir, "verifier", "recording.mp4");
      if (!existsSync(videoPath)) continue;

      entries.push({
        skill,
        horizon,
        model,
        timestamp: "", // not needed — we already know these are the correct runs
        localPath: videoPath,
      });
    }
  }

  videos = entries.sort((a, b) => {
    if (a.skill !== b.skill) return a.skill.localeCompare(b.skill);
    return a.model.localeCompare(b.model);
  });

  console.log(`Found ${videos.length} videos from extracted results\n`);
} else {
  // Default: scan jobs/ directory and deduplicate by latest timestamp
  console.log(`Scanning jobs/ for ${horizon} recordings...\n`);

  const allEntries: VideoEntry[] = [];
  const jobDirs = readdirSync(JOBS_DIR);

  for (const dir of jobDirs) {
    // Try single-task format: {skill}-xp-{horizon}-{model}-{timestamp}
    const single = parseSingleTaskDir(dir);
    if (single && single.horizon === horizon) {
      const recording = findRecording(join(JOBS_DIR, dir));
      if (recording) {
        allEntries.push({ ...single, localPath: recording });
      }
      continue;
    }

    // Try dataset format: skills-{horizon}-{model}-{timestamp}
    const dataset = parseDatasetDir(dir);
    if (dataset && dataset.horizon === horizon) {
      for (const rec of findDatasetRecordings(join(JOBS_DIR, dir))) {
        allEntries.push({
          skill: rec.skill,
          horizon: dataset.horizon,
          model: dataset.model,
          timestamp: dataset.timestamp,
          localPath: rec.localPath,
        });
      }
    }
  }

  // Keep only the latest run per skill-model
  const latest = new Map<string, VideoEntry>();
  for (const entry of allEntries) {
    const key = `${entry.skill}-${entry.model}`;
    const existing = latest.get(key);
    if (!existing || entry.timestamp > existing.timestamp) {
      latest.set(key, entry);
    }
  }

  videos = [...latest.values()].sort((a, b) => {
    if (a.skill !== b.skill) return a.skill.localeCompare(b.skill);
    return a.model.localeCompare(b.model);
  });

  console.log(`Found ${videos.length} videos to process (${allEntries.length} total recordings, deduplicated to latest per skill-model)\n`);
}

if (videos.length === 0) {
  console.log("Nothing to do.");
  process.exit(0);
}

// ── Load existing manifest ────────────────────────────────────────

let manifest: Record<string, string> = {};
if (existsSync(MANIFEST_PATH)) {
  try {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
  } catch {}
}

// ── Helper: run a command and return { ok, stdout, stderr } ───────

async function run(cmd: string[], env?: Record<string, string>): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { ok: exitCode === 0, stdout, stderr };
}

// ── Check if R2 object exists ─────────────────────────────────────

async function r2Exists(key: string): Promise<boolean> {
  const result = await run(
    ["wrangler", "r2", "object", "head", `${R2_BUCKET}/${key}`],
    { CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT_ID },
  );
  return result.ok;
}

// ── Process videos (concurrent) ───────────────────────────────────

const CONCURRENCY = 4;

const tmpDir = join(tmpdir(), "rs-video-upload");
mkdirSync(tmpDir, { recursive: true });

let uploaded = 0;
let skipped = 0;
let failed = 0;
let done = 0;

async function processVideo(video: VideoEntry): Promise<void> {
  const r2Key = `${video.horizon}/${video.model}/${video.skill}.mp4`;
  const manifestKey = `${video.horizon}/${video.model}/${video.skill}`;
  const label = `${video.skill}/${video.model}`;

  // Skip if already in manifest (fast path — no R2 roundtrip)
  if (!force && manifest[manifestKey]) {
    skipped++;
    done++;
    return;
  }

  // Crop + trim + re-encode.
  //   -ss BEFORE -i → fast seek (re-encodes from the nearest keyframe, which is
  //                     fine since we re-encode anyway). Skips container boot.
  //   -t horizonSec → cap output duration to the scoring horizon, so videos
  //                   can't run past the 30m (or 15m / 10m) mark.
  const startOffset = agentStartOffsetSec(video.localPath);
  const tmpFile = join(tmpDir, `${video.skill}-${video.model}.mp4`);
  const ffResult = await run([
    "ffmpeg",
    "-ss", String(startOffset),
    "-i", video.localPath,
    "-t", String(horizonSec),
    "-vf", CROP_FILTER,
    "-c:v", "libx264", "-preset", "fast", "-crf", "30",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    "-y", tmpFile,
  ]);

  if (!ffResult.ok) {
    console.error(`  FAIL ffmpeg: ${label}`);
    failed++;
    done++;
    return;
  }

  // Check if the video is mostly black (sample a frame from 25% in)
  const blackCheck = await run([
    "ffmpeg", "-i", tmpFile, "-vf", "select=eq(n\\,30),signalstats", "-frames:v", "1", "-f", "null", "-",
  ]);
  const lavfiMatch = blackCheck.stderr.match(/YAVG:\s*(\d+)/);
  const yavg = lavfiMatch ? parseInt(lavfiMatch[1]) : 255;
  if (yavg < 10) {
    console.log(`  skip (black): ${label} (YAVG=${yavg})`);
    skipped++;
    done++;
    return;
  }

  // Upload to R2
  const uploadResult = await run(
    ["wrangler", "r2", "object", "put", `${R2_BUCKET}/${r2Key}`, "--file", tmpFile, "--content-type", "video/mp4"],
    { CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT_ID },
  );

  if (!uploadResult.ok) {
    console.error(`  FAIL upload: ${label}`);
    failed++;
    done++;
    return;
  }

  const publicUrl = `https://pub-f4a8dd0fc02f4f56943a5d84b3932d2f.r2.dev/${r2Key}`;
  manifest[manifestKey] = publicUrl;
  uploaded++;
  done++;
  if (done % 10 === 0 || done === videos.length) {
    console.log(`  [${done}/${videos.length}] ${uploaded} uploaded, ${skipped} skipped, ${failed} failed`);
  }
}

// Run with bounded concurrency
const queue = videos.slice();
async function worker() {
  while (queue.length > 0) {
    const video = queue.shift()!;
    await processVideo(video);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

// ── Clean stale manifest entries ───────────────────────────────────

if (validManifestKeys) {
  let cleaned = 0;
  for (const key of Object.keys(manifest)) {
    if (key.startsWith(`${horizon}/`) && !validManifestKeys.has(key)) {
      delete manifest[key];
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`\nCleaned ${cleaned} stale manifest entries for ${horizon}`);
  }
}

// ── Write manifest ────────────────────────────────────────────────

mkdirSync(join(ROOT, "results"), { recursive: true });
writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));

console.log(`\nDone. ${uploaded} uploaded, ${skipped} skipped, ${failed} failed.`);
console.log(`Manifest: ${MANIFEST_PATH} (${Object.keys(manifest).length} entries)`);
