/**
 * Standalone skill tracker for benchmarks.
 * Connects to the gateway in observe mode, samples all skill levels periodically,
 * and writes the data to a JSON file.
 *
 * Config via environment variables:
 *   BOT_NAME          - bot username (default: "agent")
 *   BOT_PASSWORD      - bot password (default: "test")
 *   GATEWAY_URL       - gateway WebSocket URL (default: "ws://localhost:7780")
 *   SAMPLE_INTERVAL_MS - sampling interval in ms (default: 15000)
 *   TRACKING_FILE     - output JSON path (default: "/logs/tracking/skill_tracking.json")
 *
 * Run: bun run benchmark/shared/skill_tracker.ts
 */
// @ts-ignore - absolute path resolved inside Docker container
import { BotSDK } from '/app/sdk/index';
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { dirname } from 'path';

const botName = process.env.BOT_NAME || 'agent';
const password = process.env.BOT_PASSWORD || 'test';
const gatewayUrl = process.env.GATEWAY_URL || 'ws://localhost:7780';
const intervalMs = parseInt(process.env.SAMPLE_INTERVAL_MS || '15000');
const outFile = process.env.TRACKING_FILE || '/logs/tracking/skill_tracking.json';

const COINS_ID = 995;
const INV_TYPE = 93;
const BANK_TYPE = 95;
const SAV_MAGIC = 0x2004;
const SAVE_PATHS = [
  '/app/server/engine/data/players/main/agent.sav',
  '/app/engine/data/players/main/agent.sav',
];

function readBankGoldFromSave(): number {
  for (const p of SAVE_PATHS) {
    if (!existsSync(p)) continue;
    try {
      const data = new Uint8Array(readFileSync(p).buffer);
      const view = new DataView(data.buffer);
      let pos = 0;
      const g1 = () => data[pos++]!;
      const g2 = () => { const v = view.getUint16(pos, false); pos += 2; return v; };
      const g4s = () => { const v = view.getInt32(pos, false); pos += 4; return v; };

      if (g2() !== SAV_MAGIC) return 0;
      const version = g2();
      pos += 5; // x, z, level
      pos += 13; // appearance (7 body + 5 colors + 1 gender)
      pos += 2; // run energy
      pos += version >= 2 ? 4 : 2; // playtime
      pos += 21 * 5; // skills (xp:4 + level:1 each)
      const varpCount = g2();
      pos += varpCount * 4;

      const invCount = g1();
      let bankGold = 0;
      for (let i = 0; i < invCount; i++) {
        const type = g2();
        const size = version >= 5 ? g2() : 28;
        let typeCoins = 0;
        for (let slot = 0; slot < size; slot++) {
          const id = g2() - 1;
          if (id === -1) continue;
          let count = g1();
          if (count === 255) count = g4s();
          if (id === COINS_ID && type === BANK_TYPE) typeCoins += count;
        }
        if (type === BANK_TYPE) bankGold = typeCoins;
      }
      return bankGold;
    } catch { return 0; }
  }
  return 0;
}

interface SkillSnapshot { level: number; xp: number; }
interface Sample { timestamp: string; elapsedMs: number; skills: Record<string, SkillSnapshot>; totalLevel: number; gold?: number; inventoryGold?: number; bankGold?: number; }
interface TrackingData { botName: string; startTime: string; samples: Sample[]; }

// Root-only location so a non-root agent can't plant a fake lock (entrypoint.sh
// watchdog and ensure-services.sh only trust a root-owned lock). An unprivileged
// tracker copy just runs lock-less.
const LOCK_FILE = process.env.TRACKER_LOCK_FILE || '/run/skill_tracker.lock';

function isTrackerAlreadyRunning(): boolean {
  if (!existsSync(LOCK_FILE)) return false;
  try {
    const pid = parseInt(readFileSync(LOCK_FILE, 'utf-8').trim());
    if (isNaN(pid)) return false;
    // Check if process is alive
    process.kill(pid, 0);
    return true;
  } catch {
    // Process doesn't exist — stale lock
    return false;
  }
}

function acquireLock() {
  try {
    writeFileSync(LOCK_FILE, process.pid.toString());
  } catch (err: any) {
    // Non-root copies can't write /run — run lock-less rather than die.
    console.warn(`[skill-tracker] Could not write lock ${LOCK_FILE} (${err?.code ?? err}); continuing without lock`);
    return;
  }
  // Clean up lock on exit
  const removeLock = () => { try { unlinkSync(LOCK_FILE); } catch {} };
  process.on('exit', removeLock);
}

async function main() {
  if (isTrackerAlreadyRunning()) {
    console.log('[skill-tracker] Another tracker is already running, exiting.');
    process.exit(0);
  }
  acquireLock();

  mkdirSync(dirname(outFile), { recursive: true });

  console.log(`[skill-tracker] Connecting to bot "${botName}" in observe mode...`);
  console.log(`[skill-tracker] interval=${intervalMs}ms output=${outFile}`);

  const sdk = new BotSDK({
    botUsername: botName,
    password,
    gatewayUrl,
    connectionMode: 'observe',
    autoLaunchBrowser: false,
    autoReconnect: true,
  });

  // Retry connection — gateway/engine may still be starting or restarting via watchdog
  const MAX_ATTEMPTS = 6; // up to 1 minute of retries
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await sdk.connect();
      console.log(`[skill-tracker] Connected (attempt ${attempt}), waiting for game state...`);
      await sdk.waitForCondition(s => s.inGame && s.skills.length > 0, 30000);
      console.log('[skill-tracker] Game state received, starting tracking');
      break;
    } catch (err) {
      console.log(`[skill-tracker] Attempt ${attempt}/${MAX_ATTEMPTS} failed:`, err);
      if (attempt === MAX_ATTEMPTS) {
        console.log('[skill-tracker] All attempts failed, giving up');
        process.exit(1);
      }
      sdk.disconnect();
      await new Promise(r => setTimeout(r, 10000));
    }
  }

  // Load existing tracking data if present (survives tracker restarts)
  let trackingData: TrackingData;
  let startTime: Date;
  if (existsSync(outFile)) {
    try {
      const existing = JSON.parse(readFileSync(outFile, 'utf-8')) as TrackingData;
      if (existing.samples && existing.startTime) {
        trackingData = existing;
        startTime = new Date(existing.startTime);
        console.log(`[skill-tracker] Resuming with ${existing.samples.length} existing samples from ${existing.startTime}`);
      } else {
        throw new Error('invalid format');
      }
    } catch {
      startTime = new Date();
      trackingData = { botName, startTime: startTime.toISOString(), samples: [] };
    }
  } else {
    startTime = new Date();
    trackingData = { botName, startTime: startTime.toISOString(), samples: [] };
  }

  function takeSample() {
    const skills = sdk.getSkills();
    if (!skills || skills.length === 0) return;

    const now = new Date();
    const skillMap: Record<string, SkillSnapshot> = {};
    let totalLevel = 0;

    for (const s of skills) {
      skillMap[s.name] = { level: s.baseLevel, xp: s.experience };
      totalLevel += s.baseLevel;
    }

    const inventory = sdk.getInventory();
    const inventoryGold = inventory.filter(i => i.id === COINS_ID).reduce((sum, i) => sum + i.count, 0);
    const bankGold = readBankGoldFromSave();
    const gold = inventoryGold + bankGold;

    const sample: Sample = {
      timestamp: now.toISOString(),
      elapsedMs: now.getTime() - startTime.getTime(),
      skills: skillMap,
      totalLevel,
      gold,
      inventoryGold,
      bankGold,
    };

    trackingData.samples.push(sample);

    try {
      writeFileSync(outFile, JSON.stringify(trackingData));
    } catch (err) {
      console.log('[skill-tracker] Failed to write tracking file:', err);
    }

    console.log(`[skill-tracker] Sample #${trackingData.samples.length}: totalLevel=${totalLevel} gold=${gold} (inv=${inventoryGold} bank=${bankGold}) elapsed=${Math.round(sample.elapsedMs / 1000)}s`);
  }

  takeSample();
  setInterval(() => {
    try { takeSample(); } catch (err) { console.log('[skill-tracker] Error:', err); }
  }, intervalMs);

  // On shutdown, take a final sample and exit
  const dumpAndExit = () => {
    try {
      takeSample();
      console.log(`[skill-tracker] Final sample taken. ${trackingData.samples.length} total samples written to ${outFile}`);
    } catch {}
    process.exit(0);
  };
  process.on('SIGTERM', dumpAndExit);
  process.on('SIGINT', dumpAndExit);

  // Keep alive forever
  await new Promise(() => {});
}

main().catch(err => {
  console.error('[skill-tracker] Fatal:', err);
  process.exit(1);
});
