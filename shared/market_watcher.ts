/**
 * Market watcher for the six-bot market benchmark (2 miners / 2 smiths /
 * 2 alchemists, each maximizing its OWN final gold).
 *
 * Connects to ALL bots in observe mode and records, every SAMPLE_INTERVAL_MS:
 *   - each bot's live inventory coins (via the observer SDK)
 *   - each bot's bank coins (parsed from its on-disk save file — the engine
 *     autosaves periodically, so this lags live state by up to ~2.5 min)
 *   - total = live inventory coins + bank coins (the per-bot score proxy)
 *   - each bot's NON-COIN holdings: live inventory items (observer SDK) and
 *     banked items (save file), as compact [itemId, count] pairs — so
 *     end-of-run "assets at the buzzer" and stock flows are reconstructable.
 *     Item names are learned from the live SDK into a top-level itemNames map.
 *   - Mining/Smithing/Magic levels + position for context
 *   - the full in-game chat transcript (the negotiation artifact)
 *   - every completed player↔player trade, from the engine's trade ledger
 *     (TRADE_LEDGER_FILE, a JSONL the engine appends at the moment of the
 *     exchange) — the authoritative record of who traded what with whom
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

const botNames = (process.env.BOT_NAMES || 'anna_miner ben_miner cara_smith dan_smith ella_alch finn_alch').split(/\s+/).filter(Boolean);
const password = process.env.BOT_PASSWORD || 'test';
const gatewayUrl = process.env.GATEWAY_URL || 'ws://localhost:7780';
const intervalMs = parseInt(process.env.SAMPLE_INTERVAL_MS || '5000');
const outFile = process.env.TRACKING_FILE || '/logs/tracking/market_tracking.json';
const LOCK_FILE = process.env.WATCHER_LOCK || '/tmp/market_watcher.lock';
// Engine-side trade ledger (see rs-sdk TradeLedger.ts) — the image sets the
// same path in the engine's env, so both sides agree without wiring.
const tradeLedgerFile = process.env.TRADE_LEDGER_FILE || '/logs/tracking/trade_ledger.jsonl';
// collective-market: the smith whose score is the guild's combined coins
const guildLeader = process.env.GUILD_LEADER || '';

const savePathsFor = (bot: string) => [
  `/app/server/engine/data/players/main/${bot}.sav`,
  `/app/engine/data/players/main/${bot}.sav`,
];

interface SkillSnap { level: number; xp: number; }
/** Non-coin holdings as [itemId, count] pairs, aggregated by id, sorted by id. */
type ItemPairs = Array<[number, number]>;
interface BotSample {
  /** live coins in inventory (observer SDK); null if observer is down */
  invCoins: number | null;
  /** coins in bank + worn per the last on-disk autosave */
  bankCoins: number | null;
  /** best-effort total: live inv (or save inv if observer down) + bank */
  gold: number | null;
  /** live NON-COIN inventory items (observer SDK); null if observer is down */
  invItems: ItemPairs | null;
  /** banked NON-COIN items per the last on-disk autosave */
  bankItems: ItemPairs | null;
  mining: SkillSnap | null;
  smithing: SkillSnap | null;
  magic: SkillSnap | null;
  position?: { x: number; z: number } | null;
}
interface Sample { timestamp: string; elapsedMs: number; bots: Record<string, BotSample>; }
// `to` is set for private messages (type 6 = the observer's own outgoing PM;
// its gameMessages entry names the RECIPIENT in `sender`).
interface ChatMessage { sender: string; text: string; tick: number; type: number; elapsedMs: number; observedBy: string; to?: string; }
/** One completed trade as the engine recorded it, + elapsedMs vs watcher start. */
interface TradeEvent {
  ts: string; tick: number;
  /** login usernames — already the bot keys, no display-name mapping needed */
  from: string; to: string;
  fromItems: Array<{ id: number; name: string | null; count: number }>;
  toItems: Array<{ id: number; name: string | null; count: number }>;
  fromValue: number; toValue: number;
  elapsedMs: number;
}
interface TrackingData {
  botNames: string[];
  startTime: string;
  samples: Sample[];
  chat: ChatMessage[];
  /** completed trades from the engine ledger (authoritative; empty on pre-ledger images) */
  trades: TradeEvent[];
  /** running per-bot peak of the `gold` total (context only; score is FINAL gold) */
  peak: Record<string, { gold: number; elapsedMs: number }>;
  /** itemId → display name, learned from live observer inventories */
  itemNames: Record<number, string>;
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

/** Aggregate an item list into sorted non-coin [id, count] pairs. */
function toItemPairs(items: Array<{ id: number; count: number }> | undefined): ItemPairs {
  const agg = new Map<number, number>();
  for (const it of items ?? []) {
    if (it.id === COINS_ID) continue;
    agg.set(it.id, (agg.get(it.id) ?? 0) + it.count);
  }
  return [...agg.entries()].sort((a, b) => a[0] - b[0]);
}

/**
 * Re-parse the engine's trade ledger (a few KB of JSONL even on long runs).
 * Rebuilding from scratch every sample keeps this idempotent across watcher
 * restarts; a half-written last line (append in flight) is skipped and picked
 * up next sample. Returns null if the ledger doesn't exist (pre-ledger image).
 */
function readTradeLedger(startMs: number): TradeEvent[] | null {
  if (!existsSync(tradeLedgerFile)) return null;
  try {
    const out: TradeEvent[] = [];
    for (const line of readFileSync(tradeLedgerFile, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        out.push({ ...e, elapsedMs: Math.max(0, Date.parse(e.ts) - startMs) });
      } catch { /* truncated tail line — retry next sample */ }
    }
    return out;
  } catch {
    return null;
  }
}

/** Read a bot's on-disk save: coins in inventory / bank+worn, + banked items. */
function readSaveCoins(bot: string): { inv: number; bank: number; bankItems: ItemPairs } | null {
  for (const p of savePathsFor(bot)) {
    if (!existsSync(p)) continue;
    try {
      const save = parseSave(new Uint8Array(readFileSync(p)));
      return {
        inv: countItem(save.inventories.get(INV_TYPE), COINS_ID),
        bank: countItem(save.inventories.get(BANK_TYPE), COINS_ID)
          + countItem(save.inventories.get(WORN_TYPE), COINS_ID),
        bankItems: toItemPairs(save.inventories.get(BANK_TYPE)),
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
        tracking.itemNames ??= {};
        tracking.trades ??= [];
        startTime = new Date(existing.startTime);
        console.log(`[market-watcher] Resuming with ${existing.samples.length} samples`);
      } else throw new Error('invalid format');
    } catch {
      startTime = new Date();
      tracking = { botNames, startTime: startTime.toISOString(), samples: [], chat: [], trades: [], peak: {}, itemNames: {} };
    }
  } else {
    startTime = new Date();
    tracking = { botNames, startTime: startTime.toISOString(), samples: [], chat: [], trades: [], peak: {}, itemNames: {} };
  }

  console.log(`[market-watcher] bots=${botNames.join(',')} interval=${intervalMs}ms output=${outFile}`);

  // ── Optional wealth-rank endpoint (the -rank task variants set
  // RANK_PORT=8791; the market-status CLI curls it). Deliberately serves the
  // caller's OWN standing + coins only — never other players' balances, so
  // chat-based price discovery stays meaningful. On split runs the port is
  // tunneled and the split adapter hands agent boxes the URL (/tmp/rank-url).
  const rankPort = parseInt(process.env.RANK_PORT || '0');
  if (rankPort > 0) {
    // Most recent non-null gold per bot (a sample can miss a bot when its
    // observer hiccups and the save is mid-write).
    const currentGold = (bot: string): number | null => {
      for (let i = tracking.samples.length - 1; i >= 0; i--) {
        const g = tracking.samples[i]!.bots[bot]?.gold;
        if (g != null) return g;
      }
      return null;
    };
    Bun.serve({
      port: rankPort,
      hostname: '0.0.0.0',
      fetch(req: Request) {
        const url = new URL(req.url);
        if (url.pathname !== '/rank') return new Response('not found\n', { status: 404 });
        const bot = url.searchParams.get('bot') ?? '';
        if (!botNames.includes(bot)) {
          return new Response(`unknown bot "${bot}" — expected one of: ${botNames.join(', ')}\n`, { status: 400 });
        }
        if (tracking.samples.length === 0) {
          return new Response('leaderboard warming up — no samples yet, try again in a few seconds\n', { status: 503 });
        }
        // collective-market: the guild leader is scored on the smiths'
        // combined coins, so its market-status reports the guild total
        // instead of a personal rank (still never other INDIVIDUAL balances).
        if (guildLeader && bot === guildLeader) {
          const smiths = botNames.filter(b => b.endsWith('_smith'));
          const total = smiths.reduce((sum, b) => sum + (currentGold(b) ?? 0), 0);
          return new Response(
            `Guild total: ${total.toLocaleString('en-US')} coins held by the ${smiths.length} smiths combined ` +
            `(inventory + bank; bank totals lag the autosave by up to ~2.5 min). This total is your score.\n`,
          );
        }
        const mine = currentGold(bot) ?? 0;
        // Standard competition ranking: ties share the better rank.
        const rank = 1 + botNames.filter(b => b !== bot && (currentGold(b) ?? 0) > mine).length;
        return new Response(
          `Wealth rank: #${rank} of ${botNames.length} — you hold ${mine.toLocaleString('en-US')} coins ` +
          `(inventory + bank; bank total lags the autosave by up to ~2.5 min)\n`,
        );
      },
    });
    console.log(`[market-watcher] wealth-rank endpoint on :${rankPort}/rank`);
  }

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
      let invItems: ItemPairs | null = null;
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
          const liveInv = sdk.getInventory() ?? [];
          for (const it of liveInv) {
            if (it.id === COINS_ID) coins += it.count;
            else if (it.name && tracking.itemNames[it.id] == null) tracking.itemNames[it.id] = it.name;
          }
          invCoins = coins;
          invItems = toItemPairs(liveInv);
          const state = sdk.getState();
          const p = state?.player;
          if (p) position = { x: p.worldX, z: p.worldZ };
          for (const msg of state?.gameMessages ?? []) {
            // Public chat (2/3) is kept only when this bot SENT it (each
            // observer logs its own bot's messages once). Private messages
            // are logged from the sender's side too: type 6 is the outgoing
            // "To <name>" echo, whose `sender` field is the recipient.
            const isPm = msg.type === 6;
            if (!isPm && msg.type !== 2 && msg.type !== 3) continue;
            if (!isPm && msg.sender?.toLowerCase() !== name.toLowerCase()) continue;
            const key = `${isPm ? 'pm>' : ''}${msg.sender}|${msg.tick}|${msg.text}`;
            if (seenChat.has(key)) continue;
            seenChat.add(key);
            if (isPm) {
              tracking.chat.push({ sender: name, to: msg.sender, text: msg.text, tick: msg.tick, type: msg.type, elapsedMs, observedBy: name });
              console.log(`[market-watcher] pm ${name} -> ${msg.sender}: ${msg.text}`);
            } else {
              tracking.chat.push({ sender: msg.sender, text: msg.text, tick: msg.tick, type: msg.type, elapsedMs, observedBy: name });
              console.log(`[market-watcher] chat ${msg.sender}: ${msg.text}`);
            }
          }
        } catch { /* observer hiccup — next sample will catch up */ }
      }

      const saveCoins = readSaveCoins(name);
      const bankCoins = saveCoins?.bank ?? null;
      const bankItems = saveCoins?.bankItems ?? null;
      const liveInvCoins = invCoins ?? saveCoins?.inv ?? null;
      const gold = liveInvCoins != null || bankCoins != null ? (liveInvCoins ?? 0) + (bankCoins ?? 0) : null;

      if (gold != null) {
        const prev = tracking.peak[name];
        if (!prev || gold > prev.gold) tracking.peak[name] = { gold, elapsedMs };
      }

      botsSample[name] = { invCoins, bankCoins, gold, invItems, bankItems, mining, smithing, magic, position };
    }

    tracking.samples.push({ timestamp: now.toISOString(), elapsedMs, bots: botsSample });

    const trades = readTradeLedger(startTime.getTime());
    if (trades) {
      for (const t of trades.slice(tracking.trades.length)) {
        const fmt = (items: TradeEvent['fromItems']) => items.length ? items.map(i => `${i.name ?? i.id} x${i.count}`).join(', ') : 'nothing';
        console.log(`[market-watcher] trade ${t.from} -> ${t.to}: gave ${fmt(t.fromItems)}, received ${fmt(t.toItems)}`);
      }
      tracking.trades = trades;
    }

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
