/**
 * Market watcher for the six-bot market benchmark (3 miners / 2 smiths /
 * 1 alchemist, each maximizing its OWN final gold).
 *
 * Connects to ALL bots in observe mode and records, every SAMPLE_INTERVAL_MS:
 *   - each bot's live inventory coins (via the observer SDK)
 *   - each bot's bank coins (parsed from its on-disk save file — the engine
 *     autosaves periodically, so this lags live state by up to ~2.5 min)
 *   - total = live inventory coins + bank coins (the per-bot score proxy)
 *   - Mining/Smithing/Magic levels + position for context
 *   - the full in-game chat transcript (the negotiation artifact)
 *
 * The final save files are authoritative for scoring; check_market.ts uses
 * this tracking for the chat transcript, the gold-over-time timeline, and as
 * a floor guard if a final save is stale/unreadable.
 *
 * Config via environment variables:
 *   BOT_NAMES          - space-separated bot usernames
 *   GATEWAY_URL        - gateway WebSocket URL (default: ws://localhost:7780)
 *   SAMPLE_INTERVAL_MS - sampling interval (default: 5000)
 *   TRACKING_FILE      - output path (default: /logs/tracking/market_tracking.json)
 *   WATCHER_LOCK       - lock file (default: /tmp/market_watcher.lock)
 */
// @ts-ignore - absolute path resolved inside Docker container
import { BotSDK } from '/app/sdk/index';
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { dirname } from 'path';
import { parseSave, countItem, INV_TYPE, BANK_TYPE, WORN_TYPE } from './save-parser';

const COINS_ID = 995;

const botNames = (process.env.BOT_NAMES || 'a b c d e f').split(/\s+/).filter(Boolean);
const password = process.env.BOT_PASSWORD || 'test';
const gatewayUrl = process.env.GATEWAY_URL || 'ws://localhost:7780';
const intervalMs = parseInt(process.env.SAMPLE_INTERVAL_MS || '5000');
const outFile = process.env.TRACKING_FILE || '/logs/tracking/market_tracking.json';
const LOCK_FILE = process.env.WATCHER_LOCK || '/tmp/market_watcher.lock';

const savePathsFor = (bot: string) => [
  `/app/server/engine/data/players/main/${bot}.sav`,
  `/app/engine/data/players/main/${bot}.sav`,
];

interface SkillSnap { level: number; xp: number; }
interface BotSample {
  /** live coins in inventory (observer SDK); null if observer is down */
  invCoins: number | null;
  /** coins in bank + worn per the last on-disk autosave */
  bankCoins: number | null;
  /** best-effort total: live inv (or save inv if observer down) + bank */
  gold: number | null;
  mining: SkillSnap | null;
  smithing: SkillSnap | null;
  magic: SkillSnap | null;
  position?: { x: number; z: number } | null;
}
interface Sample { timestamp: string; elapsedMs: number; bots: Record<string, BotSample>; }
interface ChatMessage { sender: string; text: string; tick: number; type: number; elapsedMs: number; observedBy: string; }
interface TrackingData {
  botNames: string[];
  startTime: string;
  samples: Sample[];
  chat: ChatMessage[];
  /** running per-bot peak of the `gold` total (context only; score is FINAL gold) */
  peak: Record<string, { gold: number; elapsedMs: number }>;
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
      console.log(`[market-watcher] Connected to "${botName}" (attempt ${attempt})`);
      return sdk;
    } catch (err) {
      console.log(`[market-watcher] ${botName} attempt ${attempt}/${MAX_ATTEMPTS} failed:`, err);
      sdk.disconnect();
      await new Promise(r => setTimeout(r, 10000));
    }
  }
  console.log(`[market-watcher] Could not connect to "${botName}" — save-file fallback only`);
  return null;
}

/** Read a bot's on-disk save: coins in inventory / bank+worn. */
function readSaveCoins(bot: string): { inv: number; bank: number } | null {
  for (const p of savePathsFor(bot)) {
    if (!existsSync(p)) continue;
    try {
      const save = parseSave(new Uint8Array(readFileSync(p)));
      return {
        inv: countItem(save.inventories.get(INV_TYPE), COINS_ID),
        bank: countItem(save.inventories.get(BANK_TYPE), COINS_ID)
          + countItem(save.inventories.get(WORN_TYPE), COINS_ID),
      };
    } catch { /* mid-write or corrupt — try again next sample */ }
  }
  return null;
}

async function main() {
  if (isAlreadyRunning()) {
    console.log('[market-watcher] Another watcher is already running, exiting.');
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
        tracking.peak ??= {};
        startTime = new Date(existing.startTime);
        console.log(`[market-watcher] Resuming with ${existing.samples.length} samples`);
      } else throw new Error('invalid format');
    } catch {
      startTime = new Date();
      tracking = { botNames, startTime: startTime.toISOString(), samples: [], chat: [], peak: {} };
    }
  } else {
    startTime = new Date();
    tracking = { botNames, startTime: startTime.toISOString(), samples: [], chat: [], peak: {} };
  }

  console.log(`[market-watcher] bots=${botNames.join(',')} interval=${intervalMs}ms output=${outFile}`);

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
      let invCoins: number | null = null;
      let mining: SkillSnap | null = null;
      let smithing: SkillSnap | null = null;
      let magic: SkillSnap | null = null;
      let position: { x: number; z: number } | null = null;

      if (sdk) {
        try {
          for (const s of sdk.getSkills() ?? []) {
            const level = s.baseLevel ?? (s as any).level ?? 0;
            if (s.name === 'Mining') mining = { level, xp: s.experience };
            if (s.name === 'Smithing') smithing = { level, xp: s.experience };
            if (s.name === 'Magic') magic = { level, xp: s.experience };
          }
          let coins = 0;
          for (const it of sdk.getInventory() ?? []) {
            if (it.id === COINS_ID) coins += it.count;
          }
          invCoins = coins;
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
            console.log(`[market-watcher] chat ${msg.sender}: ${msg.text}`);
          }
        } catch { /* observer hiccup — next sample will catch up */ }
      }

      const saveCoins = readSaveCoins(name);
      const bankCoins = saveCoins?.bank ?? null;
      const liveInv = invCoins ?? saveCoins?.inv ?? null;
      const gold = liveInv != null || bankCoins != null ? (liveInv ?? 0) + (bankCoins ?? 0) : null;

      if (gold != null) {
        const prev = tracking.peak[name];
        if (!prev || gold > prev.gold) tracking.peak[name] = { gold, elapsedMs };
      }

      botsSample[name] = { invCoins, bankCoins, gold, mining, smithing, magic, position };
    }

    tracking.samples.push({ timestamp: now.toISOString(), elapsedMs, bots: botsSample });

    try {
      writeFileSync(outFile, JSON.stringify(tracking));
    } catch (err) {
      console.log('[market-watcher] Failed to write tracking file:', err);
    }
  }

  takeSample();
  setInterval(takeSample, intervalMs);
}

main();
