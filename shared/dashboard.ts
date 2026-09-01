/**
 * Live observation dashboard for split team runs (1 box per agent + 1 server
 * box). Runs ON the server box next to the engine/gateway/watcher and serves a
 * read-only web view of the run over its own tunneled port (default 8790,
 * exposed via --ek tunnel_ports=8888,7780,8790; the split adapter logs the
 * public URL and writes it to the job's logs dir as dashboard-url.txt).
 *
 * Data sources (both already on this box — no extra engine load):
 *   - TRACKING_FILE: the task watcher's JSON (chat transcript, gold/level
 *     timeline, live inventories for tasks whose watcher records them)
 *   - each bot's on-disk save file: inventory / worn / bank items + all skill
 *     levels. The engine autosaves periodically, so save-derived views lag
 *     live state by up to ~2.5 min — the UI shows the save age per bot.
 *   - the engine's obj.sym symbol table: item id → name for display
 *
 * Endpoints:
 *   GET /      the dashboard page (dashboard.html, same directory)
 *   GET /data  JSON snapshot: bots (save + latest watcher sample), chat,
 *              downsampled per-bot gold-or-XP series, item names
 *
 * Config via environment variables:
 *   DASHBOARD_PORT - listen port (default 8790)
 *   TRACKING_FILE  - watcher output (default: first /logs/tracking/*_tracking.json)
 *   BOT_NAMES      - space-separated bot usernames (default: tracking.botNames)
 *   SAVE_DIR       - player save dir (default /app/server/engine/data/players/main)
 *   OBJ_SYM        - obj symbol table (default /app/server/engine/data/symbols/obj.sym)
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { parseSave, INV_TYPE, WORN_TYPE, BANK_TYPE, countItem } from './save-parser';

const COINS_ID = 995;
const PORT = parseInt(process.env.DASHBOARD_PORT || '8790');
const SAVE_DIR = process.env.SAVE_DIR || '/app/server/engine/data/players/main';
const OBJ_SYM = process.env.OBJ_SYM || '/app/server/engine/data/symbols/obj.sym';
const HTML_PATH = join(import.meta.dir, 'dashboard.html');
const MAX_SERIES_POINTS = 400;

const SKILL_NAMES = [
  'Attack', 'Defence', 'Strength', 'Hitpoints', 'Ranged', 'Prayer', 'Magic',
  'Cooking', 'Woodcutting', 'Fletching', 'Fishing', 'Firemaking', 'Crafting',
  'Smithing', 'Mining', 'Herblore', 'Agility', 'Thieving', 'Stat18', 'Stat19', 'Runecraft',
];

function resolveTrackingFile(): string | null {
  if (process.env.TRACKING_FILE) return process.env.TRACKING_FILE;
  try {
    const files = readdirSync('/logs/tracking').filter(f => f.endsWith('_tracking.json'));
    if (files.length > 0) return join('/logs/tracking', files[0]!);
  } catch { /* tracking dir not there yet */ }
  return null;
}

// ── Item names (obj.sym: "<id>\t<name>") ─────────────────────────
const itemNames = new Map<number, string>();
try {
  for (const line of readFileSync(OBJ_SYM, 'utf-8').split('\n')) {
    const [id, name] = line.split('\t');
    if (id !== undefined && name) {
      const pretty = name.trim().replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
      itemNames.set(parseInt(id), pretty);
    }
  }
  console.log(`[dashboard] Loaded ${itemNames.size} item names from ${OBJ_SYM}`);
} catch {
  console.log(`[dashboard] No obj.sym at ${OBJ_SYM} — item ids shown raw`);
}

function readTracking(): any | null {
  const file = resolveTrackingFile();
  if (!file || !existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return null; // mid-write — the client polls again in 5s
  }
}

/** Aggregate an inventory into [id, count] pairs (slot order preserved for inv). */
function toPairs(items: Array<{ id: number; count: number }> | undefined): Array<[number, number]> {
  const agg = new Map<number, number>();
  for (const it of items ?? []) agg.set(it.id, (agg.get(it.id) ?? 0) + it.count);
  return [...agg.entries()];
}

function readSaveView(bot: string): any | null {
  const path = join(SAVE_DIR, `${bot}.sav`);
  if (!existsSync(path)) return null;
  try {
    const save = parseSave(new Uint8Array(readFileSync(path)));
    const ageSec = Math.max(0, Math.round((Date.now() - statSync(path).mtimeMs) / 1000));
    const skills = save.skills
      .map((s, i) => ({ name: SKILL_NAMES[i] ?? `Skill${i}`, level: s.level > 0 ? s.level : 1, xp: s.xp }))
      .filter(s => s.xp > 0);
    const inv = save.inventories.get(INV_TYPE);
    const bank = save.inventories.get(BANK_TYPE);
    const worn = save.inventories.get(WORN_TYPE);
    return {
      ageSec,
      position: save.position,
      skills,
      totalLevel: save.skills.reduce((sum, s) => sum + (s.level > 0 ? s.level : 1), 0),
      inv: toPairs(inv),
      worn: toPairs(worn),
      bank: toPairs(bank),
      invCoins: countItem(inv, COINS_ID),
      bankCoins: countItem(bank, COINS_ID) + countItem(worn, COINS_ID),
    };
  } catch {
    return null; // mid-write or corrupt — next poll
  }
}

/** A bot sample's chartable value: gold if the watcher records it, else total XP. */
function sampleValue(botSample: any): { gold: number | null; xp: number | null } {
  if (!botSample) return { gold: null, xp: null };
  let xp: number | null = null;
  for (const v of Object.values(botSample)) {
    if (v && typeof v === 'object' && typeof (v as any).xp === 'number') xp = (xp ?? 0) + (v as any).xp;
  }
  return { gold: typeof botSample.gold === 'number' ? botSample.gold : null, xp };
}

function buildSeries(tracking: any, botNames: string[]) {
  const samples: any[] = tracking?.samples ?? [];
  const hasGold = samples.some(s => botNames.some(b => typeof s.bots?.[b]?.gold === 'number'));
  const metric = hasGold ? 'gold' : 'xp';
  const stride = Math.max(1, Math.ceil(samples.length / MAX_SERIES_POINTS));
  const points: Record<string, Array<[number, number]>> = {};
  for (const b of botNames) points[b] = [];
  samples.forEach((s, i) => {
    if (i % stride !== 0 && i !== samples.length - 1) return;
    for (const b of botNames) {
      const v = sampleValue(s.bots?.[b]);
      const val = metric === 'gold' ? v.gold : v.xp;
      if (val != null) points[b]!.push([s.elapsedMs, val]);
    }
  });
  return { metric, points };
}

// ── Market roles (from the <first>_<role> bot-name convention) ───
const ROLE_BY_SUFFIX: Record<string, string> = { miner: 'miner', smith: 'smith', alch: 'alchemist' };
const botRole = (bot: string): string | null =>
  ROLE_BY_SUFFIX[bot.split('_').pop() ?? ''] ?? null;

/**
 * Total wealth held by each ROLE over the run (the "economy inverted" chart):
 * per-sample sum of every role member's gold, with per-bot carry-forward so a
 * bot missing one sample (observer hiccup / save mid-write) doesn't notch the
 * role's line. Null when the bots don't follow the market naming convention.
 */
function buildRoleSeries(tracking: any, botNames: string[]) {
  const roles = new Map(botNames.map(b => [b, botRole(b)] as const));
  if (![...roles.values()].some(Boolean)) return null;
  const samples: any[] = tracking?.samples ?? [];
  const stride = Math.max(1, Math.ceil(samples.length / MAX_SERIES_POINTS));
  const last: Record<string, number> = {};
  const points: Record<string, Array<[number, number]>> = {};
  samples.forEach((s, i) => {
    for (const b of botNames) {
      const g = s.bots?.[b]?.gold;
      if (typeof g === 'number') last[b] = g;
    }
    if (i % stride !== 0 && i !== samples.length - 1) return;
    const sums: Record<string, number> = {};
    for (const b of botNames) {
      const r = roles.get(b);
      if (r) sums[r] = (sums[r] ?? 0) + (last[b] ?? 0);
    }
    for (const [r, v] of Object.entries(sums)) (points[r] ??= []).push([s.elapsedMs, v]);
  });
  return { points };
}

function buildData() {
  const tracking = readTracking();
  const botNames: string[] = (process.env.BOT_NAMES || '').split(/\s+/).filter(Boolean).length > 0
    ? (process.env.BOT_NAMES || '').split(/\s+/).filter(Boolean)
    : tracking?.botNames ?? [];

  const latest = tracking?.samples?.[tracking.samples.length - 1] ?? null;
  const usedIds = new Set<number>();
  const bots: Record<string, any> = {};
  for (const b of botNames) {
    const save = readSaveView(b);
    const live = latest?.bots?.[b] ?? null;
    for (const src of [save?.inv, save?.worn, save?.bank, live?.invItems, live?.bankItems, live?.held]) {
      for (const entry of src ?? []) {
        usedIds.add(Array.isArray(entry) ? entry[0] : entry.id);
      }
    }
    bots[b] = { save, live };
  }

  const names: Record<number, string> = {};
  for (const id of usedIds) {
    names[id] = itemNames.get(id) ?? tracking?.itemNames?.[id] ?? `obj ${id}`;
  }

  return {
    now: new Date().toISOString(),
    startTime: tracking?.startTime ?? null,
    elapsedMs: latest?.elapsedMs ?? null,
    sampleCount: tracking?.samples?.length ?? 0,
    botNames,
    bots,
    chat: tracking?.chat ?? [],
    series: buildSeries(tracking, botNames),
    roleSeries: buildRoleSeries(tracking, botNames),
    roles: Object.fromEntries(botNames.map(b => [b, botRole(b)])),
    // collective-market: highlight this bot's messages as the guild leader
    guildLeader: process.env.GUILD_LEADER || null,
    peak: tracking?.peak ?? null,
    best: tracking?.best ?? null,
    itemNames: names,
  };
}

Bun.serve({
  port: PORT,
  hostname: '0.0.0.0',
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/data') {
      return Response.json(buildData());
    }
    if (path === '/' || path === '/index.html') {
      try {
        return new Response(readFileSync(HTML_PATH), {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      } catch {
        return new Response('dashboard.html missing', { status: 500 });
      }
    }
    return new Response('not found', { status: 404 });
  },
});

console.log(`[dashboard] Live on :${PORT} (tracking=${resolveTrackingFile() ?? 'pending'}, saves=${SAVE_DIR})`);
