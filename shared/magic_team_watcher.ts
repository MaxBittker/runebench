/**
 * Magic-team watcher for the three-bot cooperative Magic-level benchmark.
 *
 * Connects to ALL team bots (agenta, agentb, agentc) in observe mode and
 * records, every SAMPLE_INTERVAL_MS:
 *   - each bot's live Magic level/XP (plus Hitpoints, a side-effect of combat
 *     casting, for context)
 *   - the running best: the highest Magic level reached by ANY account so far
 *   - the full in-game chat transcript (collaboration artifact)
 *
 * Unlike the smith watcher there is no anti-cheat item gate: the score is a
 * skill level, which can only rise through legitimate casting, so the final
 * save file is authoritative. This watcher exists for the chat transcript and
 * the level-over-time timeline used in the write-up; check_magic_team.ts
 * scores from the save files and falls back to this tracking for peak level.
 *
 * Config via environment variables:
 *   BOT_NAMES          - space-separated bot usernames (default: "agenta agentb agentc")
 *   GATEWAY_URL        - gateway WebSocket URL (default: ws://localhost:7780)
 *   SAMPLE_INTERVAL_MS - sampling interval (default: 5000)
 *   TRACKING_FILE      - output path (default: /logs/tracking/magic_team_tracking.json)
 *   WATCHER_LOCK       - lock file (default: /tmp/magic_team_watcher.lock)
 */
// @ts-ignore - absolute path resolved inside Docker container
import { BotSDK } from '/app/sdk/index';
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { dirname } from 'path';

const botNames = (process.env.BOT_NAMES || 'agenta agentb agentc').split(/\s+/).filter(Boolean);
const password = process.env.BOT_PASSWORD || 'test';
const gatewayUrl = process.env.GATEWAY_URL || 'ws://localhost:7780';
const intervalMs = parseInt(process.env.SAMPLE_INTERVAL_MS || '5000');
const outFile = process.env.TRACKING_FILE || '/logs/tracking/magic_team_tracking.json';
const LOCK_FILE = process.env.WATCHER_LOCK || '/tmp/magic_team_watcher.lock';

interface SkillSnap { level: number; xp: number; }
interface BotSample {
  magic: SkillSnap | null;
  hitpoints: SkillSnap | null;
  position?: { x: number; z: number } | null;
}
interface Sample { timestamp: string; elapsedMs: number; bots: Record<string, BotSample>; }
interface ChatMessage { sender: string; text: string; tick: number; type: number; elapsedMs: number; observedBy: string; }
interface TrackingData {
  botNames: string[];
  startTime: string;
  samples: Sample[];
  chat: ChatMessage[];
  best: { bot: string; level: number; xp: number; elapsedMs: number } | null;
}

function isAlreadyRunning(): boolean {
  if (!existsSync(LOCK_FILE)) return false;
  try {
    const pid = parseInt(readFileSync(LOCK_FILE, 'utf-8').trim());
    if (isNaN(pid)) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function connectObserver(botName: string): Promise<any | null> {
  const sdk = new BotSDK({
    botUsername: botName,
    password,
    gatewayUrl,
    connectionMode: 'observe',
    autoLaunchBrowser: false,
    autoReconnect: true,
  });
  const MAX_ATTEMPTS = 12; // up to ~2 minutes — later bots log in staggered
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await sdk.connect();
      await sdk.waitForCondition((s: any) => s.inGame, 30000);
      console.log(`[magic-watcher] Connected to "${botName}" (attempt ${attempt})`);
      return sdk;
    } catch (err) {
      console.log(`[magic-watcher] ${botName} attempt ${attempt}/${MAX_ATTEMPTS} failed:`, err);
      sdk.disconnect();
      await new Promise(r => setTimeout(r, 10000));
    }
  }
  console.log(`[magic-watcher] Could not connect to "${botName}" — save-file fallback only`);
  return null;
}

async function main() {
  if (isAlreadyRunning()) {
    console.log('[magic-watcher] Another watcher is already running, exiting.');
    process.exit(0);
  }
  writeFileSync(LOCK_FILE, process.pid.toString());
  process.on('exit', () => { try { unlinkSync(LOCK_FILE); } catch {} });

  mkdirSync(dirname(outFile), { recursive: true });

  // Resume existing tracking data if the watcher was restarted
  let tracking: TrackingData;
  let startTime: Date;
  if (existsSync(outFile)) {
    try {
      const existing = JSON.parse(readFileSync(outFile, 'utf-8')) as TrackingData;
      if (existing.startTime && existing.samples) {
        tracking = existing;
        startTime = new Date(existing.startTime);
        console.log(`[magic-watcher] Resuming with ${existing.samples.length} samples`);
      } else throw new Error('invalid format');
    } catch {
      startTime = new Date();
      tracking = { botNames, startTime: startTime.toISOString(), samples: [], chat: [], best: null };
    }
  } else {
    startTime = new Date();
    tracking = { botNames, startTime: startTime.toISOString(), samples: [], chat: [], best: null };
  }

  console.log(`[magic-watcher] bots=${botNames.join(',')} interval=${intervalMs}ms output=${outFile}`);

  const sdks: Record<string, any | null> = {};
  await Promise.all(botNames.map(async name => { sdks[name] = await connectObserver(name); }));

  // Dedupe chat across polls (gameMessages is a rolling window). Record each
  // message only from its sender's own observer (see arrav_watcher.ts).
  const seenChat = new Set(tracking.chat.map(c => `${c.sender}|${c.tick}|${c.text}`));

  function takeSample() {
    const now = new Date();
    const elapsedMs = now.getTime() - startTime.getTime();
    const botsSample: Record<string, BotSample> = {};

    for (const name of botNames) {
      const sdk = sdks[name];
      let magic: SkillSnap | null = null;
      let hitpoints: SkillSnap | null = null;
      let position: { x: number; z: number } | null = null;

      if (sdk) {
        try {
          for (const s of sdk.getSkills() ?? []) {
            const level = s.baseLevel ?? (s as any).level ?? 0;
            if (s.name === 'Magic') magic = { level, xp: s.experience };
            if (s.name === 'Hitpoints') hitpoints = { level, xp: s.experience };
          }
          const state = sdk.getState();
          const p = state?.player;
          if (p) position = { x: p.worldX, z: p.worldZ };
          for (const msg of state?.gameMessages ?? []) {
            if (msg.type !== 2 && msg.type !== 3) continue;
            if (msg.sender?.toLowerCase() !== name.toLowerCase()) continue;
            const key = `${msg.sender}|${msg.tick}|${msg.text}`;
            if (seenChat.has(key)) continue;
            seenChat.add(key);
            tracking.chat.push({ sender: msg.sender, text: msg.text, tick: msg.tick, type: msg.type, elapsedMs, observedBy: name });
            console.log(`[magic-watcher] chat ${msg.sender}: ${msg.text}`);
          }
        } catch { /* observer hiccup — next sample will catch up */ }
      }

      if (magic && (!tracking.best || magic.level > tracking.best.level ||
          (magic.level === tracking.best.level && magic.xp > tracking.best.xp))) {
        tracking.best = { bot: name, level: magic.level, xp: magic.xp, elapsedMs };
        console.log(`[magic-watcher] NEW BEST: ${name} Magic ${magic.level} (${magic.xp} xp) at ${(elapsedMs / 1000).toFixed(0)}s`);
      }

      botsSample[name] = { magic, hitpoints, position };
    }

    tracking.samples.push({ timestamp: now.toISOString(), elapsedMs, bots: botsSample });

    try {
      writeFileSync(outFile, JSON.stringify(tracking));
    } catch (err) {
      console.log('[magic-watcher] Failed to write tracking file:', err);
    }
  }

  takeSample();
  setInterval(takeSample, intervalMs);
}

main();
