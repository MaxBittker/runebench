/**
 * Crafting-team watcher for the three-bot cooperative TOTAL-Crafting-XP benchmark.
 *
 * Connects to ALL team bots (agenta, agentb, agentc) in observe mode and
 * records, every SAMPLE_INTERVAL_MS:
 *   - each bot's live Crafting level/XP
 *   - the running total Crafting XP across the team (the score is the SUM, so
 *     every bot's output matters — there is no lone carry)
 *   - the full in-game chat transcript (collaboration artifact)
 *
 * No anti-cheat item gate: the score is skill XP, which can only rise through
 * legitimate crafting, so the final save files are authoritative. This watcher
 * exists for the chat transcript and the XP-over-time timeline;
 * check_crafting_team.ts scores from the save files, falling back to this.
 *
 * Config via environment variables:
 *   BOT_NAMES / GATEWAY_URL / SAMPLE_INTERVAL_MS / TRACKING_FILE / WATCHER_LOCK
 */
// @ts-ignore - absolute path resolved inside Docker container
import { BotSDK } from '/app/sdk/index';
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { dirname } from 'path';

const botNames = (process.env.BOT_NAMES || 'agenta agentb agentc').split(/\s+/).filter(Boolean);
const password = process.env.BOT_PASSWORD || 'test';
const gatewayUrl = process.env.GATEWAY_URL || 'ws://localhost:7780';
const intervalMs = parseInt(process.env.SAMPLE_INTERVAL_MS || '5000');
const outFile = process.env.TRACKING_FILE || '/logs/tracking/crafting_team_tracking.json';
const LOCK_FILE = process.env.WATCHER_LOCK || '/tmp/crafting_team_watcher.lock';

interface SkillSnap { level: number; xp: number; }
interface BotSample { crafting: SkillSnap | null; position?: { x: number; z: number } | null; }
interface Sample { timestamp: string; elapsedMs: number; totalXp: number; bots: Record<string, BotSample>; }
interface ChatMessage { sender: string; text: string; tick: number; type: number; elapsedMs: number; observedBy: string; }
interface TrackingData {
  botNames: string[];
  startTime: string;
  samples: Sample[];
  chat: ChatMessage[];
  best: { maxXp: number; totalXp: number; elapsedMs: number } | null;
}

function isAlreadyRunning(): boolean {
  if (!existsSync(LOCK_FILE)) return false;
  try {
    const pid = parseInt(readFileSync(LOCK_FILE, 'utf-8').trim());
    if (isNaN(pid)) return false;
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

async function connectObserver(botName: string): Promise<any | null> {
  const sdk = new BotSDK({
    botUsername: botName, password, gatewayUrl,
    connectionMode: 'observe', autoLaunchBrowser: false, autoReconnect: true,
  });
  const MAX_ATTEMPTS = 12; // up to ~2 minutes — later bots log in staggered
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await sdk.connect();
      await sdk.waitForCondition((s: any) => s.inGame, 30000);
      console.log(`[craft-watcher] Connected to "${botName}" (attempt ${attempt})`);
      return sdk;
    } catch (err) {
      console.log(`[craft-watcher] ${botName} attempt ${attempt}/${MAX_ATTEMPTS} failed:`, err);
      sdk.disconnect();
      await new Promise(r => setTimeout(r, 10000));
    }
  }
  console.log(`[craft-watcher] Could not connect to "${botName}" — save-file fallback only`);
  return null;
}

async function main() {
  if (isAlreadyRunning()) {
    console.log('[craft-watcher] Another watcher is already running, exiting.');
    process.exit(0);
  }
  writeFileSync(LOCK_FILE, process.pid.toString());
  process.on('exit', () => { try { unlinkSync(LOCK_FILE); } catch {} });

  mkdirSync(dirname(outFile), { recursive: true });

  let tracking: TrackingData;
  let startTime: Date;
  if (existsSync(outFile)) {
    try {
      const existing = JSON.parse(readFileSync(outFile, 'utf-8')) as TrackingData;
      if (existing.startTime && existing.samples) {
        tracking = existing;
        startTime = new Date(existing.startTime);
        console.log(`[craft-watcher] Resuming with ${existing.samples.length} samples`);
      } else throw new Error('invalid format');
    } catch {
      startTime = new Date();
      tracking = { botNames, startTime: startTime.toISOString(), samples: [], chat: [], best: null };
    }
  } else {
    startTime = new Date();
    tracking = { botNames, startTime: startTime.toISOString(), samples: [], chat: [], best: null };
  }

  console.log(`[craft-watcher] bots=${botNames.join(',')} interval=${intervalMs}ms output=${outFile}`);

  const sdks: Record<string, any | null> = {};
  await Promise.all(botNames.map(async name => { sdks[name] = await connectObserver(name); }));

  const seenChat = new Set(tracking.chat.map(c => `${c.sender}|${c.tick}|${c.text}`));

  function takeSample() {
    const now = new Date();
    const elapsedMs = now.getTime() - startTime.getTime();
    const botsSample: Record<string, BotSample> = {};
    let totalXp = 0;

    for (const name of botNames) {
      const sdk = sdks[name];
      let crafting: SkillSnap | null = null;
      let position: { x: number; z: number } | null = null;

      if (sdk) {
        try {
          for (const s of sdk.getSkills() ?? []) {
            const level = s.baseLevel ?? (s as any).level ?? 0;
            if (s.name === 'Crafting') crafting = { level, xp: s.experience };
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
            console.log(`[craft-watcher] chat ${msg.sender}: ${msg.text}`);
          }
        } catch { /* observer hiccup — next sample will catch up */ }
      }

      if (crafting) totalXp += crafting.xp;
      botsSample[name] = { crafting, position };
    }

    // best = highest single-account Crafting XP seen so far (the score is a max)
    let maxXp = 0;
    for (const name of botNames) { const x = botsSample[name]?.crafting?.xp ?? 0; if (x > maxXp) maxXp = x; }
    if (!tracking.best || maxXp > tracking.best.maxXp) {
      tracking.best = { maxXp, totalXp, elapsedMs };
    }

    tracking.samples.push({ timestamp: now.toISOString(), elapsedMs, totalXp, bots: botsSample });

    try {
      writeFileSync(outFile, JSON.stringify(tracking));
    } catch (err) {
      console.log('[craft-watcher] Failed to write tracking file:', err);
    }
  }

  takeSample();
  setInterval(takeSample, intervalMs);
}

main();
