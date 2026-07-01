/**
 * Shield of Arrav completion watcher for the duo benchmark.
 *
 * Connects to BOTH bots (agenta, agentb) in observe mode and records:
 *   - the full in-game chat transcript (public chat both bots see) — the
 *     primary artifact for studying collaboration
 *   - quest-item milestones (intel report, shield halves, crossbows, certificate)
 *     sampled from live inventories every SAMPLE_INTERVAL_MS
 *   - quest completion, detected two ways:
 *       precise:       the full Certificate (obj 769) leaves a bot's inventory
 *                      (it is deleted the moment King Roald accepts it)
 *       authoritative: quest varp read from the on-disk save file
 *                      (varp 145 blackarmgang == 4, varp 146 phoenixgang == 10;
 *                       engine autosaves every 1500 ticks ≈ 75s, so this lags)
 *
 * Writes /logs/tracking/arrav_tracking.json continuously. The verifier
 * (check_arrav.ts) scores from this file, falling back to save-file varps.
 *
 * Config via environment variables:
 *   BOT_NAMES          - space-separated bot usernames (default: "agenta agentb")
 *   GATEWAY_URL        - gateway WebSocket URL (default: ws://localhost:7780)
 *   SAMPLE_INTERVAL_MS - sampling interval (default: 5000)
 *   TRACKING_FILE      - output path (default: /logs/tracking/arrav_tracking.json)
 */
// @ts-ignore - absolute path resolved inside Docker container
import { BotSDK } from '/app/sdk/index';
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { dirname } from 'path';
import { parseSave } from './save-parser';

const botNames = (process.env.BOT_NAMES || 'agenta agentb').split(/\s+/).filter(Boolean);
const password = process.env.BOT_PASSWORD || 'test';
const gatewayUrl = process.env.GATEWAY_URL || 'ws://localhost:7780';
const intervalMs = parseInt(process.env.SAMPLE_INTERVAL_MS || '5000');
const outFile = process.env.TRACKING_FILE || '/logs/tracking/arrav_tracking.json';

const VARP_BLACKARM = 145;   // ^blackarmgang_complete = 4
const VARP_PHOENIX = 146;    // ^phoenixgang_complete = 10
const BLACKARM_COMPLETE = 4;
const PHOENIX_COMPLETE = 10;

// Quest item IDs (engine obj.sym)
const QUEST_ITEMS: Record<number, string> = {
  761: 'intelligence_report',
  763: 'arravshield1',       // right half (Phoenix weapon store)
  765: 'arravshield2',       // left half (Black Arm cupboard)
  767: 'phoenix_crossbow',
  769: 'arravcertificate',   // full certificate (curator gives 2)
};
const CERTIFICATE_ID = 769;

const savePath = (bot: string) => `/app/server/engine/data/players/main/${bot.toLowerCase()}.sav`;

/** Parse quest varps {145, 146} out of a binary save file (v6 or v7 format). */
function readQuestVarps(path: string): { blackarm: number; phoenix: number } | null {
  if (!existsSync(path)) return null;
  try {
    const save = parseSave(new Uint8Array(readFileSync(path)));
    return {
      blackarm: save.varps[VARP_BLACKARM] ?? 0,
      phoenix: save.varps[VARP_PHOENIX] ?? 0,
    };
  } catch {
    return null;
  }
}

interface Milestone { bot: string; item: string; event: 'gained' | 'lost'; elapsedMs: number; timestamp: string; }
interface BotSample { items: Record<string, number>; questVarps: { blackarm: number; phoenix: number } | null; position?: { x: number; z: number } | null; }
interface Sample { timestamp: string; elapsedMs: number; bots: Record<string, BotSample>; }
interface Completion { bot: string; elapsedMs: number; timestamp: string; method: 'certificate-handover' | 'save-varp'; }
interface ChatMessage { sender: string; text: string; tick: number; type: number; elapsedMs: number; observedBy: string; }
interface TrackingData {
  botNames: string[];
  startTime: string;
  samples: Sample[];
  milestones: Milestone[];
  chat: ChatMessage[];             // deduped public/private chat transcript
  completions: Completion[];       // one entry per bot, first detection wins
  firstCompletionMs: number | null;
}

const LOCK_FILE = '/tmp/arrav_watcher.lock';

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
  const MAX_ATTEMPTS = 12; // up to ~2 minutes — second bot logs in late
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await sdk.connect();
      await sdk.waitForCondition((s: any) => s.inGame, 30000);
      console.log(`[arrav-watcher] Connected to "${botName}" (attempt ${attempt})`);
      return sdk;
    } catch (err) {
      console.log(`[arrav-watcher] ${botName} attempt ${attempt}/${MAX_ATTEMPTS} failed:`, err);
      sdk.disconnect();
      await new Promise(r => setTimeout(r, 10000));
    }
  }
  console.log(`[arrav-watcher] Could not connect to "${botName}" — varp fallback only`);
  return null;
}

async function main() {
  if (isAlreadyRunning()) {
    console.log('[arrav-watcher] Another watcher is already running, exiting.');
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
        console.log(`[arrav-watcher] Resuming with ${existing.samples.length} samples`);
      } else throw new Error('invalid format');
    } catch {
      startTime = new Date();
      tracking = { botNames, startTime: startTime.toISOString(), samples: [], milestones: [], chat: [], completions: [], firstCompletionMs: null };
    }
  } else {
    startTime = new Date();
    tracking = { botNames, startTime: startTime.toISOString(), samples: [], milestones: [], chat: [], completions: [], firstCompletionMs: null };
  }
  tracking.chat ??= [];  // resume from pre-chat tracking files

  console.log(`[arrav-watcher] bots=${botNames.join(',')} interval=${intervalMs}ms output=${outFile}`);

  const sdks: Record<string, any | null> = {};
  await Promise.all(botNames.map(async name => { sdks[name] = await connectObserver(name); }));

  const prevItems: Record<string, Record<string, number>> = {};
  const completedBots = new Set(tracking.completions.map(c => c.bot));
  // Dedupe chat across polls (gameMessages is a rolling window) and across
  // observers (both bots see the same public line).
  const seenChat = new Set(tracking.chat.map(c => `${c.sender}|${c.tick}|${c.text}`));

  function recordCompletion(bot: string, elapsedMs: number, method: Completion['method']) {
    if (completedBots.has(bot)) return;
    completedBots.add(bot);
    const completion: Completion = { bot, elapsedMs, timestamp: new Date().toISOString(), method };
    tracking.completions.push(completion);
    if (tracking.firstCompletionMs === null || elapsedMs < tracking.firstCompletionMs) {
      tracking.firstCompletionMs = elapsedMs;
    }
    console.log(`[arrav-watcher] COMPLETION: ${bot} at ${(elapsedMs / 1000).toFixed(0)}s (${method})`);
  }

  function takeSample() {
    const now = new Date();
    const elapsedMs = now.getTime() - startTime.getTime();
    const botsSample: Record<string, BotSample> = {};

    for (const name of botNames) {
      // Live inventory via observer SDK
      const items: Record<string, number> = {};
      let position: { x: number; z: number } | null = null;
      const sdk = sdks[name];
      if (sdk) {
        try {
          const inv = sdk.getInventory() ?? [];
          for (const it of inv) {
            const label = QUEST_ITEMS[it.id];
            if (label) items[label] = (items[label] ?? 0) + it.count;
          }
          const state = sdk.getState();
          const p = state?.player;
          if (p) position = { x: p.worldX, z: p.worldZ };
          // Chat transcript: public chat (type 2) + private messages (type 3).
          // Record each message ONLY from its sender's own observer — every
          // bot's outgoing chat echoes into its own gameMessages, and client
          // ticks differ between observers so cross-observer dedupe by tick
          // doesn't work (it produced doubled transcripts).
          for (const msg of state?.gameMessages ?? []) {
            if (msg.type !== 2 && msg.type !== 3) continue;
            if (msg.sender?.toLowerCase() !== name.toLowerCase()) continue;
            const key = `${msg.sender}|${msg.tick}|${msg.text}`;
            if (seenChat.has(key)) continue;
            seenChat.add(key);
            tracking.chat.push({
              sender: msg.sender,
              text: msg.text,
              tick: msg.tick,
              type: msg.type,
              elapsedMs,
              observedBy: name,
            });
            console.log(`[arrav-watcher] chat ${msg.sender}: ${msg.text}`);
          }
        } catch { /* observer hiccup — varp fallback still works */ }
      }

      // Milestones: quest items gained/lost since last sample
      const prev = prevItems[name];
      if (prev) {
        for (const label of Object.values(QUEST_ITEMS)) {
          const had = (prev[label] ?? 0) > 0;
          const has = (items[label] ?? 0) > 0;
          if (!had && has) {
            tracking.milestones.push({ bot: name, item: label, event: 'gained', elapsedMs, timestamp: now.toISOString() });
            console.log(`[arrav-watcher] ${name} gained ${label} at ${(elapsedMs / 1000).toFixed(0)}s`);
          } else if (had && !has) {
            tracking.milestones.push({ bot: name, item: label, event: 'lost', elapsedMs, timestamp: now.toISOString() });
            // Certificate leaving the inventory = handed to King Roald (precise completion)
            if (label === QUEST_ITEMS[CERTIFICATE_ID]) {
              recordCompletion(name, elapsedMs, 'certificate-handover');
            }
          }
        }
      }
      prevItems[name] = items;

      // Authoritative (lagged) check: quest varps from the on-disk save
      const questVarps = readQuestVarps(savePath(name));
      if (questVarps && (questVarps.blackarm >= BLACKARM_COMPLETE || questVarps.phoenix >= PHOENIX_COMPLETE)) {
        recordCompletion(name, elapsedMs, 'save-varp');
      }

      botsSample[name] = { items, questVarps, position };
    }

    tracking.samples.push({ timestamp: now.toISOString(), elapsedMs, bots: botsSample });

    try {
      writeFileSync(outFile, JSON.stringify(tracking));
    } catch (err) {
      console.log('[arrav-watcher] Failed to write tracking file:', err);
    }
  }

  takeSample();
  setInterval(takeSample, intervalMs);
}

main();
