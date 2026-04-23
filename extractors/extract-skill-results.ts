#!/usr/bin/env bun
/**
 * Extract skill XP tracking data from Harbor job results for the graph viewer.
 *
 * Detects skill from job dir name: {skill}-xp-{horizon}-{model}-...
 * Groups by model -> skill.
 *
 * Usage:
 *   bun extractors/extract-skill-results.ts                              # 30m (default)
 *   bun extractors/extract-skill-results.ts --horizon 10m                # 10m
 *   bun extractors/extract-skill-results.ts --horizon 30m --filter opus  # Filter by pattern
 *   bun extractors/extract-skill-results.ts jobs/woodcutting-xp-10m-*    # Specific job dirs
 *
 * Output:
 *   results/skills-{horizon}/_combined.json  — { model: { skill: { finalXp, finalLevel, samples[], tokenUsage } } }
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import {
  type Sample, type TrackingData, type TokenUsage,
  detectModel, detectModelFromConfig, getTrialDirs,
  findTrackingInTrial, findRewardInTrial, findTokenUsageInTrial,
  trimSamplesToHorizon,
  parseCLIArgs, resolveJobDirs, writeResults,
} from '../shared/extract-utils';

const JOBS_DIR = join(import.meta.dir, '..', 'jobs');
const RESULTS_ROOT = join(import.meta.dir, '..', 'results');

const KNOWN_MODELS = ['opus47', 'opus', 'opus45', 'sonnet46', 'sonnet45', 'haiku', 'codex53', 'gpt55', 'gpt54mini', 'gpt54nano', 'gpt54', 'gemini31', 'geminiflash', 'gemini', 'glm', 'kimi', 'qwen35', 'qwen3'];

const KNOWN_SKILLS = [
  'attack', 'defence', 'strength', 'hitpoints', 'ranged', 'prayer', 'magic',
  'woodcutting', 'fishing', 'mining', 'cooking', 'fletching', 'crafting',
  'smithing', 'firemaking', 'thieving',
];

/** Detect skill from directory name: {skill}-xp-{horizon}-{model}-... */
function detectSkill(dirName: string, horizon: string): string | null {
  const lower = dirName.toLowerCase();
  for (const skill of KNOWN_SKILLS) {
    if (lower.startsWith(`${skill}-xp-${horizon}`)) return skill;
  }
  return null;
}

/** Detect skill from trial dir name: {skill}-xp-{horizon}__{random} */
function detectSkillFromTrialName(trialDirName: string, horizon: string): string | null {
  const taskPart = trialDirName.split('__')[0];
  if (!taskPart) return null;
  return detectSkill(taskPart, horizon);
}

function detectSkillFromConfig(jobDir: string, horizon: string): string | null {
  const configPath = join(jobDir, 'config.json');
  if (!existsSync(configPath)) return null;
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    const taskPath = config?.tasks?.[0]?.path || '';
    const lower = taskPath.toLowerCase();
    for (const skill of KNOWN_SKILLS) {
      if (lower.includes(`${skill}-xp-${horizon}`)) return skill;
    }
  } catch {}
  return null;
}

// ── Trajectory extraction ────────────────────────────────────────

interface TrajectoryStep {
  source: 'agent' | 'tool' | 'user';
  text: string;
  ts?: number; // seconds since first agent step (for video sync)
  detail?: string; // code content for Write/Edit tools
}

function extractTrajectoryFromTrial(trialDir: string): { steps: TrajectoryStep[]; firstStepAt?: string } | null {
  const agentDir = join(trialDir, 'agent');
  if (!existsSync(agentDir)) return null;

  const trajectoryPath = join(agentDir, 'trajectory.json');
  if (existsSync(trajectoryPath)) {
    try {
      const traj = JSON.parse(readFileSync(trajectoryPath, 'utf-8'));
      const result = parseClaudeTrajectory(traj);
      return result;
    } catch {}
  }

  const codexPath = join(agentDir, 'codex.txt');
  if (existsSync(codexPath)) {
    try {
      return parseCodexLog(readFileSync(codexPath, 'utf-8'));
    } catch {}
  }

  // Handle any opencode-*.txt variant (kimi, qwen3, qwen35, etc.)
  try {
    const agentFiles = readdirSync(agentDir);
    const opencodePath = agentFiles.find(f => f.startsWith('opencode-') && f.endsWith('.txt'));
    if (opencodePath) {
      try {
        return parseKimiLog(readFileSync(join(agentDir, opencodePath), 'utf-8'));
      } catch {}
    }
  } catch {}

  const geminiPath = join(agentDir, 'gemini-cli.txt');
  if (existsSync(geminiPath)) {
    try {
      return parseGeminiCliLog(readFileSync(geminiPath, 'utf-8'));
    } catch {}
  }

  return null;
}

function truncateLines(text: string, maxLines: number, maxChars: number): string {
  const lines = text.split('\n');
  let result = lines.slice(0, maxLines).join('\n');
  if (result.length > maxChars) result = result.slice(0, maxChars);
  if (lines.length > maxLines || text.length > maxChars) result += '\n...';
  return result;
}

/** Extract a tool step from a tool_calls entry */
function extractToolStep(toolCall: any, ts?: number): TrajectoryStep | null {
  const toolName = toolCall?.function_name || 'unknown';
  const args = toolCall?.arguments || {};

  let text = toolName;
  let detail: string | undefined;

  if (toolName === 'Bash' || toolName === 'run_shell_command' || toolName === 'exec_command') {
    const cmd: string = args.command || args.cmd || '';
    // Detect heredoc file writes: cat << 'EOF' > filename.ts
    const heredocMatch = cmd.match(/^cat\s+<<\s*'?EOF'?\s*>\s*(.+)/);
    if (heredocMatch) {
      const filePath = heredocMatch[1].trim();
      text = `write: ${filePath}`;
      // Extract content between first newline and EOF
      const eofIdx = cmd.lastIndexOf('\nEOF');
      if (eofIdx > 0) {
        const content = cmd.slice(cmd.indexOf('\n') + 1, eofIdx);
        if (content) detail = truncateLines(content, 25, 2000);
      }
    } else {
      text = `bash: ${cmd.slice(0, 300)}`;
    }
  } else if (toolName === 'write_stdin') {
    const chars: string = args.chars || '';
    if (!chars) return null; // skip empty stdin polls (just waiting for output)
    // Show control characters readably
    const display = chars.replace(/\x03/g, '^C').replace(/\x04/g, '^D').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
    text = `stdin: ${display.slice(0, 300)}`;
  } else if (toolName === 'Write' || toolName === 'write_file') {
    text = `write: ${args.file_path || args.path || ''}`;
    const content = args.content || '';
    if (content) detail = truncateLines(content, 25, 2000);
  } else if (toolName === 'Edit') {
    text = `edit: ${args.file_path || ''}`;
    const newStr = args.new_string || '';
    if (newStr) detail = truncateLines(newStr, 25, 2000);
  } else if (toolName === 'Read' || toolName === 'read_file') {
    text = `read: ${args.file_path || args.path || ''}`;
  }

  return { source: 'tool', text, ...(ts !== undefined ? { ts } : {}), ...(detail ? { detail } : {}) };
}

function parseClaudeTrajectory(traj: any): { steps: TrajectoryStep[]; firstStepAt?: string } {
  const rawSteps = traj.steps || [];
  const steps: TrajectoryStep[] = [];

  // Find the first timestamp to compute relative offsets
  let firstTs: number | null = null;
  let firstStepAt: string | undefined;
  for (const step of rawSteps) {
    if (step.timestamp) {
      firstTs = new Date(step.timestamp).getTime();
      firstStepAt = step.timestamp;
      break;
    }
  }

  for (const step of rawSteps) {
    const src = step.source;
    if (src !== 'agent') continue;

    const msg: string = step.message || '';
    const toolCalls: any[] = step.tool_calls || [];

    // Skip steps with no message and no tool calls
    if (!msg && toolCalls.length === 0) continue;

    // Compute seconds since first step
    let ts: number | undefined;
    if (firstTs !== null && step.timestamp) {
      ts = Math.round((new Date(step.timestamp).getTime() - firstTs) / 1000);
    }

    if (msg.startsWith('Executed ')) {
      // Claude format: "Executed ToolName tool_call_id" — tool call is the step
      const step = extractToolStep(toolCalls[0] || { function_name: msg.replace('Executed ', '').split(' ')[0] }, ts);
      if (step) steps.push(step);
    } else {
      // Gemini/other/Codex format: message is thinking text, tool_calls are separate
      // Emit agent text if present
      if (msg) {
        steps.push({ source: 'agent', text: msg, ...(ts !== undefined ? { ts } : {}) });
      }
      // Emit tool calls (skip null — e.g. empty write_stdin polls)
      for (const tc of toolCalls) {
        const step = extractToolStep(tc, ts);
        if (step) steps.push(step);
      }
    }
  }

  return { steps: steps.slice(0, 200), firstStepAt };
}

function parseCodexLog(content: string): { steps: TrajectoryStep[] } {
  const steps: TrajectoryStep[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'item.completed' && entry.item) {
        const item = entry.item;
        if (item.type === 'agent_message' && item.text) {
          steps.push({ source: 'agent', text: item.text });
        } else if (item.type === 'reasoning' && item.text) {
          steps.push({ source: 'agent', text: item.text });
        } else if (item.type === 'command_execution' && item.command) {
          // Strip /bin/bash -lc prefix to get actual command
          let cmd: string = item.command;
          const bashPrefix = cmd.match(/^\/bin\/\w*sh\s+(-\w+\s+)*/);
          if (bashPrefix) cmd = cmd.slice(bashPrefix[0].length);
          // Detect heredoc writes
          let detail: string | undefined;
          const heredocMatch = cmd.match(/^cat\s+<<\s*'?EOF'?\s*>\s*(.+)/);
          if (heredocMatch) {
            const filePath = heredocMatch[1].trim();
            const eofIdx = cmd.lastIndexOf('\nEOF');
            if (eofIdx > 0) {
              const hContent = cmd.slice(cmd.indexOf('\n') + 1, eofIdx);
              if (hContent) detail = truncateLines(hContent, 25, 2000);
            }
            steps.push({ source: 'tool', text: `write: ${filePath}`, ...(detail ? { detail } : {}) });
          } else {
            steps.push({ source: 'tool', text: `bash: ${cmd.slice(0, 300)}` });
          }
        } else if (item.type === 'file_change') {
          steps.push({ source: 'tool', text: `file_change: ${item.filename || 'unknown'}` });
        }
      }
    } catch {}
  }

  return { steps: steps.slice(0, 200) };
}

function parseKimiLog(content: string): { steps: TrajectoryStep[] } {
  const steps: TrajectoryStep[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    if (line.startsWith('[kimi-loop]')) {
      steps.push({ source: 'agent', text: line });
      continue;
    }
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'text') {
        const text = entry.part?.content || entry.part?.text || '';
        if (text) {
          steps.push({ source: 'agent', text });
        }
      } else if (entry.type === 'tool_use') {
        const tool = entry.part?.tool || '';
        const input = entry.part?.state?.input || {};
        if (tool === 'bash') {
          steps.push({ source: 'tool', text: `bash: ${input.command || ''}`.slice(0, 200) });
        } else if (tool === 'read') {
          steps.push({ source: 'tool', text: `read: ${input.filePath || ''}` });
        } else if (tool === 'write') {
          steps.push({ source: 'tool', text: `write: ${input.filePath || ''}` });
        } else if (tool) {
          steps.push({ source: 'tool', text: tool });
        }
      }
    } catch {}
  }

  return { steps: steps.slice(0, 200) };
}

function parseGeminiCliLog(content: string): { steps: TrajectoryStep[] } {
  const steps: TrajectoryStep[] = [];
  const lines = content.split('\n');

  let inBashBlock = false;
  let bashFileName = '';
  let bashCodeLines: string[] = [];
  let inSyntaxErrors = false;

  function flushBashBlock() {
    if (!bashFileName && bashCodeLines.length === 0) return;
    const label = bashFileName ? `write: ${bashFileName}` : 'bash';
    let detail: string | undefined;
    if (bashCodeLines.length > 0) {
      detail = truncateLines(bashCodeLines.join('\n'), 25, 2000);
    }
    steps.push({ source: 'tool', text: label, ...(detail ? { detail } : {}) });
    bashFileName = '';
    bashCodeLines = [];
  }

  for (const line of lines) {
    const trimmed = line.trimEnd();

    // Detect start of a bash command block (heredoc file content + syntax errors)
    if (trimmed.startsWith('Bash command parsing error detected')) {
      // Flush any previous block
      flushBashBlock();
      inBashBlock = true;
      inSyntaxErrors = false;
      const fileMatch = trimmed.match(/> ([\w/./-]+\.\w+)$/);
      bashFileName = fileMatch ? fileMatch[1] : '';
      continue;
    }

    if (inBashBlock) {
      // Detect start of syntax error array
      if (trimmed.startsWith('EOF Syntax Errors:') || trimmed === 'EOF Syntax Errors: [') {
        inSyntaxErrors = true;
        continue;
      }
      if (inSyntaxErrors) {
        if (trimmed === ']') {
          inSyntaxErrors = false;
          inBashBlock = false;
          flushBashBlock();
        }
        continue;
      }
      // Collect code lines (skip EOF marker)
      if (trimmed === 'EOF') continue;
      bashCodeLines.push(line);
      continue;
    }

    // Skip noise lines
    if (!trimmed) continue;
    if (trimmed.startsWith('YOLO mode is enabled')) continue;
    if (trimmed.startsWith('[agent-loop]')) continue;
    if (trimmed.startsWith('missing pgrep output')) continue;

    // Everything else is agent text
    steps.push({ source: 'agent', text: trimmed });
  }

  flushBashBlock();
  const trimmed = steps.slice(0, 200);
  return { steps: trimmed };
}

// ── Main ─────────────────────────────────────────────────────────

const { filter, horizon: horizonArg, explicitDirs } = parseCLIArgs(process.argv.slice(2));
const HORIZON = horizonArg || '15m';
const RESULTS_DIR = join(import.meta.dir, '..', 'results', `skills-${HORIZON}`);

// Load video URL manifest (written by scripts/upload-videos.ts)
const videoManifestPath = join(RESULTS_ROOT, 'video-urls.json');
const videoManifest: Record<string, string> = existsSync(videoManifestPath)
  ? JSON.parse(readFileSync(videoManifestPath, 'utf-8'))
  : {};

console.log(`Extracting skill-xp-${HORIZON} results...\n`);

const jobDirs = resolveJobDirs(JOBS_DIR, explicitDirs, filter, (name, f) => {
  const lower = name.toLowerCase();
  // Match single-task dirs ({skill}-xp-{horizon}-...) or dataset dirs (skills-{horizon}-...)
  const isSkillMatch = KNOWN_SKILLS.some(s => lower.startsWith(`${s}-xp-${HORIZON}`));
  const isDatasetMatch = lower.startsWith(`skills-${HORIZON}-`);
  if (!isSkillMatch && !isDatasetMatch) return false;
  return !f || lower.includes(f);
});

// Extract and group by model -> skill
const combined: Record<string, Record<string, {
  jobName: string;
  peakXpRate: number;
  finalXp: number;
  finalLevel: number;
  durationSeconds: number;
  sampleCount: number;
  samples: Sample[];
  tokenUsage?: TokenUsage;
  trimmedSamples?: number;
  trialDir?: string;
  videoAvailable?: boolean;
  videoUrl?: string;
  containerStartedAt?: string;
  containerFinishedAt?: string;
  agentStartedAt?: string;
}>> = {};

/** Compute peak XP rate (XP/min) from tracking samples for a given skill */
function computePeakXpRate(samples: Sample[], skill: string): number {
  let peak = 0;
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const curr = samples[i];
    const prevXp = getSkillXpFromSample(prev, skill);
    const currXp = getSkillXpFromSample(curr, skill);
    const deltaXp = currXp - prevXp;
    const deltaMs = curr.elapsedMs - prev.elapsedMs;
    if (deltaMs <= 0 || deltaXp <= 0) continue;
    const rate = (deltaXp / deltaMs) * 60000 / 8 / 25; // real-game XP/min
    if (rate > peak) peak = rate;
  }
  return Math.round(peak);
}

function getSkillXpFromSample(sample: Sample, skill: string): number {
  if (!sample?.skills) return 0;
  for (const [name, data] of Object.entries(sample.skills)) {
    if (name.toLowerCase() === skill.toLowerCase()) {
      return (data as { level: number; xp: number }).xp || 0;
    }
  }
  return 0;
}

const REPO_ROOT = join(import.meta.dir, '..');

let extracted = 0;

// Parse horizon into milliseconds for sample trimming
const horizonMatch = HORIZON.match(/^(\d+)m$/);
const horizonMs = horizonMatch ? parseInt(horizonMatch[1]) * 60 * 1000 : 0;

// ── Phase 1: Group job dirs by model and keep only the latest per model ──
// This prevents mixing results from different runs for the same model.

const jobsByModel: Record<string, { dir: string; timestamp: string }[]> = {};

for (const dir of jobDirs) {
  const jobName = basename(dir);
  let model = detectModel(jobName, KNOWN_MODELS);
  if (model === 'unknown') model = detectModelFromConfig(dir, KNOWN_MODELS, {
    preMatch: (lower) => {
      if (lower.includes('gemini-3.1') || lower.includes('gemini-3_1')) return 'gemini31';
      if (lower.includes('gemini-3-flash') || lower.includes('gemini-3_flash')) return 'geminiflash';
      return null;
    },
  });

  if (model === 'unknown') {
    console.log(`  skip: ${jobName} (can't detect model)`);
    continue;
  }

  // Extract timestamp from dir name (YYYYMMDD-HHMMSS, optionally followed by -retry)
  const tsMatch = jobName.match(/(\d{8}-\d{6})(-retry)?$/);
  const timestamp = tsMatch ? tsMatch[1] : '00000000-000000';
  const isRetry = !!tsMatch?.[2];

  if (!jobsByModel[model]) jobsByModel[model] = [];
  jobsByModel[model].push({ dir, timestamp, isRetry });
}

// Process all job dirs per model, newest first. Newest result wins per skill;
// older runs fill in any gaps (so partial re-runs merge with previous full runs).
const allJobDirs: { dir: string; model: string }[] = [];
for (const [model, jobs] of Object.entries(jobsByModel)) {
  // Sort newest first; within same timestamp, retries after main (so main wins)
  jobs.sort((a, b) => {
    const tsCmp = b.timestamp.localeCompare(a.timestamp);
    if (tsCmp !== 0) return tsCmp;
    return (a.isRetry ? 1 : 0) - (b.isRetry ? 1 : 0);
  });
  for (const j of jobs) {
    allJobDirs.push({ dir: j.dir, model });
  }
  console.log(`  ${model}: ${jobs.length} job dir(s), newest: ${basename(jobs[0].dir)}`);
}

// ── Phase 2: Extract results from latest job per model ──

for (const { dir, model } of allJobDirs) {
  const jobName = basename(dir);

  // Detect skill at job level (old single-task format: {skill}-xp-{horizon}-{model}-...)
  const jobSkill = detectSkill(jobName, HORIZON) || detectSkillFromConfig(dir, HORIZON);

  // Iterate over trial dirs to handle both single-task and multi-task (dataset) jobs
  const trialDirs = getTrialDirs(dir);
  if (trialDirs.length === 0) {
    console.log(`  skip: ${jobName} (no trial dirs)`);
    continue;
  }

  for (const trialDir of trialDirs) {
    const trialName = basename(trialDir);
    // Detect skill: try trial dir name first (works for dataset jobs), then fall back to job name
    const skill = detectSkillFromTrialName(trialName, HORIZON) || jobSkill;

    if (!skill) {
      console.log(`  skip: ${jobName}/${trialName} (can't detect skill)`);
      continue;
    }

    const tracking = findTrackingInTrial(trialDir);
    const reward = findRewardInTrial(trialDir);
    const tokenUsage = findTokenUsageInTrial(trialDir);

    // Read timing metadata from result.json (needed for trajectory timestamp interpolation)
    let containerStartedAt: string | undefined;
    let containerFinishedAt: string | undefined;
    let agentStartedAt: string | undefined;
    const resultPath = join(trialDir, 'result.json');
    if (existsSync(resultPath)) {
      try {
        const result = JSON.parse(readFileSync(resultPath, 'utf-8'));
        containerStartedAt = result.started_at;
        containerFinishedAt = result.finished_at;
        agentStartedAt = result.agent_execution?.started_at;
      } catch {}
    }

    const trajectory = extractTrajectoryFromTrial(trialDir);

    // Video and timing metadata
    const videoPath = join(trialDir, 'verifier', 'recording.mp4');
    const videoAvailable = existsSync(videoPath);
    let videoDuration: number | undefined;
    if (videoAvailable) {
      try {
        const probe = require('child_process').execSync(
          `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${videoPath}"`,
          { timeout: 5000 }
        ).toString().trim();
        videoDuration = parseFloat(probe);
        if (isNaN(videoDuration)) videoDuration = undefined;
      } catch {}
    }
    const relTrialDir = trialDir.startsWith(REPO_ROOT)
      ? trialDir.slice(REPO_ROOT.length + 1)
      : trialDir;

    if (!tracking && !reward) {
      continue;
    }

    const allSamples = tracking?.samples || [];

    // Trim samples to the intended game-time window
    const samples = horizonMs > 0 ? trimSamplesToHorizon(allSamples, horizonMs) : allSamples;
    const trimmedCount = allSamples.length - samples.length;

    const durationSeconds = samples.length > 0
      ? samples[samples.length - 1].elapsedMs / 1000
      : 0;

    // Derive XP from the last in-window sample's skill data (more accurate than
    // the verifier's post-timeout reading when orphaned scripts inflate XP)
    let finalXp = reward?.xp ?? 0;
    let finalLevel = reward?.level ?? 1;

    if (samples.length > 0 && horizonMs > 0) {
      const lastSample = samples[samples.length - 1];
      if (lastSample.skills) {
        for (const [sName, sData] of Object.entries(lastSample.skills)) {
          if (sName.toLowerCase() === skill.toLowerCase()) {
            const sd = sData as { level: number; xp: number };
            finalXp = sd.xp;
            finalLevel = sd.level;
            break;
          }
        }
      }
    }

    // Slim down samples: keep elapsedMs and all skills (level only for non-target, level+xp for target)
    // Use first sample as baseline — only include non-target skills that changed from their starting level
    const firstSample = samples.length > 0 ? samples[0] : null;
    function getBaselineLevel(skillName: string): number {
      if (!firstSample?.skills) return 1;
      for (const [sName, sData] of Object.entries(firstSample.skills)) {
        if (sName.toLowerCase() === skillName.toLowerCase()) {
          return (sData as { level: number }).level || 1;
        }
      }
      return 1;
    }
    const slimSamples = samples.map(s => {
      const slimSkills: Record<string, { level: number; xp?: number }> = {};
      if (s.skills) {
        for (const [sName, sData] of Object.entries(s.skills)) {
          const sd = sData as { level: number; xp: number };
          if (sName.toLowerCase() === skill.toLowerCase()) {
            slimSkills[sName] = { level: sd.level, xp: sd.xp };
          } else if (sd.level > getBaselineLevel(sName)) {
            slimSkills[sName] = { level: sd.level };
          }
        }
      }
      return { elapsedMs: s.elapsedMs, skills: slimSkills };
    });

    // Compute peak XP rate from tracking samples
    const peakXpRate = computePeakXpRate(samples as Sample[], skill);

    if (!combined[model]) combined[model] = {};

    const videoUrl = videoManifest[`${HORIZON}/${model}/${skill}`];

    // Merge logic: keep whichever result has better data.
    // A newer run wins only if it has meaningful tracking data (>5 samples);
    // otherwise keep the existing result to avoid replacing good data with failed re-runs.
    const existing = combined[model][skill];
    if (existing) {
      const newHasData = samples.length > 5;
      const existingHasData = existing.sampleCount > 5;
      if (existingHasData && !newHasData) continue; // keep existing good data
      if (existingHasData && newHasData) continue;   // both good, keep newer (already set)
    }

    combined[model][skill] = {
      jobName,
      peakXpRate,
      finalXp,
      finalLevel,
      durationSeconds,
      sampleCount: samples.length,
      samples: slimSamples,
      ...(tokenUsage ? { tokenUsage } : {}),
      ...(trajectory ? { trajectory: trajectory.steps } : {}),
      ...(trajectory?.firstStepAt ? { firstStepAt: trajectory.firstStepAt } : {}),
      ...(trimmedCount > 0 ? { trimmedSamples: trimmedCount } : {}),
      trialDir: relTrialDir,
      videoAvailable,
      ...(videoDuration ? { videoDuration } : {}),
      ...(videoUrl ? { videoUrl } : {}),
      ...(containerStartedAt ? { containerStartedAt } : {}),
      ...(containerFinishedAt ? { containerFinishedAt } : {}),
      ...(agentStartedAt ? { agentStartedAt } : {}),
    };

    const tokenStr = tokenUsage ? `, tokens: ${(tokenUsage.inputTokens / 1000).toFixed(0)}k in / ${(tokenUsage.outputTokens / 1000).toFixed(0)}k out` : '';
    const trimStr = trimmedCount > 0 ? ` (trimmed ${trimmedCount} post-horizon samples)` : '';
    console.log(`  ${model}/${skill}: ${jobName} — peakRate=${peakXpRate} XP/min, xp=${finalXp}, level=${finalLevel}, ${samples.length} samples${trimStr}${tokenStr}`);
    extracted++;
  }
}

if (extracted === 0) {
  console.log(`\nNo skill-xp-${HORIZON} data found in any job directories.`);
  process.exit(1);
}

writeResults(RESULTS_DIR, combined, 'COMBINED_DATA');

// Write per-model JSON files
for (const [model, skills] of Object.entries(combined)) {
  const modelPath = join(RESULTS_DIR, `${model}.json`);
  writeFileSync(modelPath, JSON.stringify({ model, skills }, null, 2));
}

// ── Diagnostics ──────────────────────────────────────────────────

const expectedMinSamples = horizonMs > 0 ? Math.floor(horizonMs / 30000) : 0; // rough: one sample per 30s

console.log(`\n── Diagnostics ──`);
for (const [model, skills] of Object.entries(combined)) {
  const skillEntries = Object.entries(skills);
  const withData = skillEntries.filter(([, v]) => v.sampleCount > 0).length;
  const trimmedEntries = skillEntries.filter(([, v]) => (v as any).trimmedSamples > 0);
  const shortEntries = expectedMinSamples > 0
    ? skillEntries.filter(([, v]) => v.sampleCount > 0 && v.sampleCount < expectedMinSamples * 0.5)
    : [];

  console.log(`  ${model}: ${skillEntries.length} skills, ${withData} with tracking data`);
  if (trimmedEntries.length > 0) {
    for (const [sk, v] of trimmedEntries) {
      console.log(`    ⚠ ${sk}: ${(v as any).trimmedSamples} samples trimmed (orphaned scripts ran past horizon)`);
    }
  }
  if (shortEntries.length > 0) {
    for (const [sk, v] of shortEntries) {
      console.log(`    ⚠ ${sk}: only ${v.sampleCount} samples (expected ~${expectedMinSamples}+, possible early sandbox death)`);
    }
  }
}

console.log(`\n${extracted} result(s) extracted. View: open views/graph-skills.html?horizon=${HORIZON}`);
