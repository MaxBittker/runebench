/**
 * Extracts market-run artifacts for the local viewer (views/graph-market.html).
 *
 * Scans jobs/market-* for trial reward.json files and writes
 * results/market/_data.js: window.MARKET_RUNS = [ { meta, bots, samples,
 * events, chat } ] — one entry per trial, newest first.
 *
 *   samples  [{ t, gold: { bot: gp }, bank: { bot: gp } }]   forward-filled 5s balance
 *            series (gold = inventory + bank; bank = banked part, when the watcher records it)
 *   events   the derived trade ledger: per-bot balance deltas, with opposite
 *            deltas of equal size within a ±2-sample window paired into
 *            `transfer` events (from → to); unpaired deltas stay `gain`/`loss`.
 *   chat     [{ t, sender, text }]
 *   videos   { bot: relative mp4 path } — per-bot screen recordings, referenced
 *            in place under jobs/ (paths are relative to views/)
 *   sales    the actual trades. Primary source: the engine's trade ledger,
 *            folded into the watcher tracking as `trades` (authoritative —
 *            written by the engine at the moment of each exchange, with both
 *            usernames + both item lists). Each sale gets exact goods,
 *            quantity and unit price (gp per ore/bar/platebody; bundles
 *            priced per bundle); barters and one-sided gifts keep unit = null.
 *            Fallback for pre-ledger runs: trade records regex-mined from the
 *            per-bot trajectories (`partner`/`gave`/`received`), then gp-delta
 *            pairing with `## Inventory` snapshot deltas as a last resort.
 *
 * Usage: bun scripts/extract-market-viz.ts
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const REPO = join(import.meta.dir, '..');
const JOBS_DIR = join(REPO, 'jobs');
const OUT_DIR = join(REPO, 'results', 'market');

const DELTA_FLOOR = 25;        // ignore balance wiggles under this many gp
const PAIR_WINDOW = 2;         // samples (±) within which a loss can match a gain
const PAIR_TOLERANCE = 0.02;   // relative amount mismatch allowed for a pair

interface RunOut {
  meta: {
    job: string; trial: string; model: string; launchedAt: string;
    totalGold: number; winner: { bot: string; role: string; gold: number };
    capSecs: number;
  };
  bots: Array<{ name: string; role: string; finalGold: number; model?: string }>;
  samples: Array<{ t: number; gold: Record<string, number>; bank?: Record<string, number> }>;
  /** total item quantities across all bots (inv+bank), aligned to samples: qty[i][j] = names[j] at samples[i] */
  itemSeries?: { names: string[]; qty: number[][] };
  events: Array<{
    t: number; type: 'transfer' | 'gain' | 'loss';
    bot?: string; from?: string; to?: string; amount: number;
    before?: number; after?: number;
  }>;
  chat: Array<{ t: number; sender: string; text: string }>;
  /** per-bot screen recording, path relative to views/ (only bots whose mp4 exists) */
  videos: Record<string, string>;
  /** per-bot transcript file (script-tag loadable, path relative to views/) */
  transcripts: Record<string, string>;
  /** transfers attributed to goods: unit = gp/qty when the basket is one item type */
  sales: Array<{
    t: number; from: string; to: string; gp: number;
    item: string | null; qty: number | null; unit: number | null; note?: string;
  }>;
}

// ── Trade records mined from trajectories (primary source for sales) ──

/** One completed trade, canonicalized: participants sorted, itemsX = what X handed over. */
interface TradeRec { t: number; a: string; b: string; itemsA: Record<string, number>; itemsB: Record<string, number>; }

const aggItems = (l: any[]): Record<string, number> => {
  const r: Record<string, number> = {};
  for (const it of l ?? []) if (it?.name) r[it.name] = (r[it.name] ?? 0) + (it.count ?? 0);
  return r;
};
const basketSig = (b: Record<string, number>) =>
  Object.keys(b).sort().map(n => `${b[n]}x${n}`).join('+');
const fmtBasket = (b: Record<string, number>) =>
  Object.keys(b).length ? Object.keys(b).sort().map(n => `${b[n]}× ${n}`).join(' + ') : 'nothing';

function tradesFromTrajectory(trialPath: string, bot: string, t0Ms: number, botNames: string[]): TradeRec[] {
  const trajPath = join(trialPath, 'agent', `trajectory-${bot}.json`);
  if (!existsSync(trajPath)) return [];
  let traj: any;
  try { traj = JSON.parse(readFileSync(trajPath, 'utf-8')); } catch { return []; }
  const out: TradeRec[] = [];
  const seen = new Set<string>();  // same record echoed twice within one trajectory
  for (const step of traj.steps ?? []) {
    const ts = Date.parse(step.timestamp ?? '');
    if (isNaN(ts)) continue;
    let obs = typeof step.observation === 'string' ? step.observation : JSON.stringify(step.observation ?? '');
    // observations nest JSON to varying depth — collapse escapes before matching
    obs = obs.replace(/\\+n/g, '\n').replace(/\\+"/g, '"');
    // partner is the DISPLAY name ("Ivy Smith") — spaces and capitals, not the bot key
    const re = /"partner":\s*"([^"]+)",\s*"gave":\s*(\[[^\]]*\]),\s*"received":\s*(\[[^\]]*\])/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(obs))) {
      let gave: any[], recv: any[];
      try { gave = JSON.parse(m[2]); recv = JSON.parse(m[3]); } catch { continue; }
      if (!gave.length && !recv.length) continue;   // timed-out / cancelled trade
      const partner = m[1].toLowerCase().replace(/\s+/g, '_');
      if (!botNames.includes(partner)) continue;    // doc snippets / non-bot matches
      const key = `${partner}|${step.timestamp}|${m[2]}|${m[3]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const t = Math.max(0, Math.round((ts - t0Ms) / 1000));
      const [a, b] = [bot, partner].sort();
      out.push({
        t, a, b,
        itemsA: a === bot ? aggItems(gave) : aggItems(recv),
        itemsB: a === bot ? aggItems(recv) : aggItems(gave),
      });
    }
  }
  return out;
}

/**
 * Authoritative trades from the engine's ledger (market_watcher folds
 * TRADE_LEDGER_FILE into tracking.trades). Usernames are already the bot keys
 * — no display-name mapping, no mirror records, no truncation exposure. Item
 * names arrive as engine debugnames ("bronze_bar"); prefer the display names
 * the watcher learned live, and prettify the debugname otherwise.
 */
function tradesFromLedger(tracking: any, botNames: string[]): TradeRec[] {
  const itemName = (it: any): string => {
    if (it?.id === 995) return 'Coins';
    const learned = tracking.itemNames?.[it?.id];
    if (learned) return learned;
    const raw = String(it?.name ?? it?.id ?? '?').replace(/_/g, ' ');
    return raw.charAt(0).toUpperCase() + raw.slice(1);
  };
  const agg = (items: any[]): Record<string, number> => {
    const r: Record<string, number> = {};
    for (const it of items ?? []) { const n = itemName(it); r[n] = (r[n] ?? 0) + (it.count ?? 0); }
    return r;
  };
  const out: TradeRec[] = [];
  for (const tr of tracking.trades ?? []) {
    const from = String(tr.from ?? '').toLowerCase();
    const to = String(tr.to ?? '').toLowerCase();
    if (!botNames.includes(from) || !botNames.includes(to)) continue;
    if (!tr.fromItems?.length && !tr.toItems?.length) continue;
    const t = Math.max(0, Math.round((tr.elapsedMs ?? 0) / 1000));
    const [a, b] = [from, to].sort();
    out.push({
      t, a, b,
      itemsA: a === from ? agg(tr.fromItems) : agg(tr.toItems),
      itemsB: a === from ? agg(tr.toItems) : agg(tr.fromItems),
    });
  }
  out.sort((x, y) => x.t - y.t);
  return out;
}

/** Each trade is logged by both sides — collapse mirror records (same pair+contents within 60s). */
function mergeTrades(all: TradeRec[]): TradeRec[] {
  all.sort((x, y) => x.t - y.t);
  const sig = (r: TradeRec) => `${r.a}|${r.b}|${basketSig(r.itemsA)}|${basketSig(r.itemsB)}`;
  const kept: TradeRec[] = [];
  for (const r of all)
    if (!kept.some(k => sig(k) === sig(r) && Math.abs(k.t - r.t) <= 60)) kept.push(r);
  return kept;
}

function salesFromTrades(trades: TradeRec[]): RunOut['sales'] {
  const sales: RunOut['sales'] = [];
  const mk = (t: number, buyer: string, seller: string, gp: number, basket: Record<string, number>) => {
    const names = Object.keys(basket);
    if (names.length === 1)
      return { t, from: buyer, to: seller, gp, item: names[0], qty: basket[names[0]], unit: Math.round((gp / basket[names[0]]) * 100) / 100 };
    return { t, from: buyer, to: seller, gp, item: fmtBasket(basket), qty: 1, unit: gp, note: 'bundle — priced per bundle' };
  };
  for (const r of trades) {
    const coinsA = r.itemsA['Coins'] ?? 0, coinsB = r.itemsB['Coins'] ?? 0;
    const goodsA = { ...r.itemsA }; delete goodsA['Coins'];
    const goodsB = { ...r.itemsB }; delete goodsB['Coins'];
    if (coinsA > 0 && !coinsB && Object.keys(goodsB).length) sales.push(mk(r.t, r.a, r.b, coinsA, goodsB));
    else if (coinsB > 0 && !coinsA && Object.keys(goodsA).length) sales.push(mk(r.t, r.b, r.a, coinsB, goodsA));
    else if (!coinsA && !coinsB) sales.push({
      t: r.t, from: r.a, to: r.b, gp: 0, qty: null, unit: null,
      item: `${fmtBasket(goodsA)} ↔ ${fmtBasket(goodsB)}`, note: 'barter — no gp',
    });
    else if ((coinsA > 0) !== (coinsB > 0)) {
      const [payer, payee, gp] = coinsA > 0 ? [r.a, r.b, coinsA] as const : [r.b, r.a, coinsB] as const;
      sales.push({ t: r.t, from: payer, to: payee, gp, item: null, qty: null, unit: null, note: 'gp only — gift/advance' });
    }
    // coins on both sides: not a sale — skip
  }
  sales.sort((x, y) => x.t - y.t);
  return sales;
}

// ── Per-bot transcripts (agent messages + tool calls + outputs) ──────

interface TranscriptEntry {
  t: number | null;          // secs since watcher start; null for pre-run prompt steps
  type: 'system' | 'user' | 'agent' | 'tool';
  text?: string;             // system/user/agent message text
  name?: string;             // tool name
  input?: string;            // tool input (code or JSON args)
  output?: string;           // tool result content
  notes?: string;            // // comments extracted from the code — the agent's narration
  console?: string;          // agent's console.log output from the result
  inputTrunc?: boolean;
  outputTrunc?: boolean;
}

/** Comment lines out of agent-written code — its plan narrated in place. */
function commentNotes(code: string): string {
  const out: string[] = [];
  for (const line of code.split('\n')) {
    const m = line.match(/^\s*\/\/\s?(.*)/);
    if (m && m[1].trim()) out.push(m[1].trim());
  }
  return out.join('\n');
}

/** The agent's own console.log output inside a tool result, minus engine noise. */
const CONSOLE_NOISE = /^(Pathfinding initialized|\[LOGOUT DEBUG\]|SDK WebSocket|\[BotSDK\])/;
function consoleNarration(output: string): string {
  const chunks: string[] = [];
  const re = /── Console ──\n([\s\S]*?)(?=\n── |$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output))) {
    const lines = m[1].split('\n').filter(l => l.trim() && !CONSOLE_NOISE.test(l.trim()));
    if (lines.length) chunks.push(lines.join('\n'));
  }
  return chunks.join('\n');
}

const INPUT_CAP = 8000, OUTPUT_CAP = 6000, TEXT_CAP = 20000;
const cap = (s: string, n: number): [string, boolean] =>
  s.length > n ? [s.slice(0, n), true] : [s, false];

function transcriptFromTrajectory(trialPath: string, bot: string, t0Ms: number): TranscriptEntry[] {
  const trajPath = join(trialPath, 'agent', `trajectory-${bot}.json`);
  if (!existsSync(trajPath)) return [];
  let traj: any;
  try { traj = JSON.parse(readFileSync(trajPath, 'utf-8')); } catch { return []; }
  const entries: TranscriptEntry[] = [];
  for (const step of traj.steps ?? []) {
    const ts = Date.parse(step.timestamp ?? '');
    const t = isNaN(ts) ? null : Math.max(0, Math.round((ts - t0Ms) / 1000));
    const msg = step.message && step.message !== '(no text)' ? String(step.message) : null;
    if (msg) {
      const type = step.source === 'agent' ? 'agent' : step.source === 'system' ? 'system' : 'user';
      const [text, tTrunc] = cap(msg, TEXT_CAP);
      entries.push({ t, type, text, inputTrunc: tTrunc || undefined });
    }
    // pair each tool call with its result via source_call_id
    const results: Record<string, string> = {};
    let looseObs: string | null = null;
    const obs = step.observation;
    if (obs && typeof obs === 'object' && Array.isArray(obs.results)) {
      for (const r of obs.results) results[r.source_call_id ?? ''] = String(r.content ?? '');
    } else if (obs != null) {
      looseObs = typeof obs === 'string' ? obs : JSON.stringify(obs);
    }
    const calls = step.tool_calls ?? [];
    calls.forEach((tc: any, i: number) => {
      const args = tc.arguments ?? {};
      const raw = typeof args.code === 'string' ? args.code : JSON.stringify(args);
      const [input, inputTrunc] = cap(raw ?? '', INPUT_CAP);
      const rawOut = results[tc.tool_call_id] ?? (i === calls.length - 1 ? looseObs : null);
      const [output, outputTrunc] = rawOut != null ? cap(rawOut, OUTPUT_CAP) : [undefined as any, false];
      const notes = typeof args.code === 'string' ? commentNotes(args.code).slice(0, 2000) : '';
      const consoleOut = rawOut != null ? consoleNarration(rawOut).slice(0, 2000) : '';
      entries.push({
        t, type: 'tool', name: tc.function_name ?? 'tool', input,
        output, inputTrunc: inputTrunc || undefined, outputTrunc: outputTrunc || undefined,
        notes: notes || undefined, console: consoleOut || undefined,
      });
    });
  }
  return entries;
}

// ── Per-bot inventory timelines (fallback attribution of transfers) ──

type InvSnap = { t: number; items: Record<string, number> };

/** Parse one `## Inventory` markdown block into name → total count. */
function parseInvBlock(block: string): Record<string, number> {
  const items: Record<string, number> = {};
  for (const line of block.split('\n')) {
    const m = line.match(/^- (.+?) x([\d,]+)/);
    if (!m) continue;
    const name = m[1].replace(/\s*\[.*$/, '').trim();
    if (name.toLowerCase() === 'coins') continue;
    items[name] = (items[name] ?? 0) + parseInt(m[2].replace(/,/g, ''));
  }
  return items;
}

/** Mine timestamped inventory snapshots out of a bot's trajectory file. */
function invSnapsFromTrajectory(trialPath: string, bot: string, t0Ms: number): InvSnap[] {
  const trajPath = join(trialPath, 'agent', `trajectory-${bot}.json`);
  if (!existsSync(trajPath)) return [];
  let traj: any;
  try { traj = JSON.parse(readFileSync(trajPath, 'utf-8')); } catch { return []; }
  const snaps: InvSnap[] = [];
  for (const step of traj.steps ?? []) {
    const ts = Date.parse(step.timestamp ?? '');
    if (isNaN(ts)) continue;
    let obs = typeof step.observation === 'string' ? step.observation : JSON.stringify(step.observation ?? '');
    obs = obs.replace(/\\n/g, '\n');   // observation is nested JSON — unescape newlines
    // last inventory dump in the step is the freshest state
    const idx = obs.lastIndexOf('## Inventory');
    if (idx < 0) continue;
    const block = obs.slice(idx, obs.length).split(/\n## (?!Inventory)/)[0].slice(0, 4000);
    snaps.push({ t: Math.round((ts - t0Ms) / 1000), items: parseInvBlock(block) });
  }
  snaps.sort((a, b) => a.t - b.t);
  return snaps;
}

/** Snapshots straddling time t: [last at/before, first after]; null if either side missing. */
function straddle(snaps: InvSnap[], t: number): [InvSnap, InvSnap] | null {
  let prev: InvSnap | null = null, next: InvSnap | null = null;
  for (const s of snaps) {
    if (s.t <= t) prev = s;
    else { next = s; break; }
  }
  return prev && next ? [prev, next] : null;
}

function itemDeltas(pair: [InvSnap, InvSnap]): Record<string, number> {
  const [a, b] = pair;
  const d: Record<string, number> = {};
  for (const k of new Set([...Object.keys(a.items), ...Object.keys(b.items)]))
    d[k] = (b.items[k] ?? 0) - (a.items[k] ?? 0);
  return d;
}

const TOOL_ITEMS = /pickaxe|hammer|axe|tinderbox|bucket|jug|knife|shears/i;
const MAX_SNAP_GAP = 300;  // secs; wider straddles are too stale to trust

/**
 * Attribute each transfer (buyer --gp--> seller) to the items that moved:
 * items the seller lost AND the buyer gained across the trade window. A
 * single-item basket yields an exact unit price.
 */
function deriveSales(
  events: RunOut['events'],
  invSnaps: Record<string, InvSnap[]>,
): RunOut['sales'] {
  const sales: RunOut['sales'] = [];
  for (const e of events) {
    if (e.type !== 'transfer' || !e.from || !e.to) continue;
    const sale: RunOut['sales'][number] = {
      t: e.t, from: e.from, to: e.to, gp: e.amount, item: null, qty: null, unit: null,
      note: 'inferred from gp deltas — partner/goods are guesses',
    };
    sales.push(sale);

    const sellerPair = straddle(invSnaps[e.to] ?? [], e.t);
    const buyerPair = straddle(invSnaps[e.from] ?? [], e.t);
    // goods lost by the seller / gained by the buyer around the trade
    const lost: Record<string, number> = {};
    const gained: Record<string, number> = {};
    if (sellerPair && sellerPair[1].t - sellerPair[0].t <= MAX_SNAP_GAP) {
      const d = itemDeltas(sellerPair);
      for (const k in d) if (d[k] < 0 && !TOOL_ITEMS.test(k)) lost[k] = -d[k];
    }
    if (buyerPair && buyerPair[1].t - buyerPair[0].t <= MAX_SNAP_GAP) {
      const d = itemDeltas(buyerPair);
      for (const k in d) if (d[k] > 0 && !TOOL_ITEMS.test(k)) gained[k] = d[k];
    }

    // prefer items both sides agree on; else the side that saw anything
    let basket: Record<string, number> = {};
    for (const k in lost) if (gained[k]) basket[k] = Math.min(lost[k], gained[k]);
    if (!Object.keys(basket).length) basket = Object.keys(gained).length ? gained : lost;
    const names = Object.keys(basket);
    if (!names.length) { sale.note = `no inventory movement observed; ${sale.note}`; continue; }

    if (names.length === 1) {
      sale.item = names[0];
      sale.qty = basket[names[0]];
      sale.unit = Math.round((sale.gp / sale.qty) * 100) / 100;
    } else {
      sale.item = names.map(n => `${basket[n]}× ${n}`).join(' + ');
      sale.note = `mixed basket — no per-item price; ${sale.note}`;
    }
  }
  return sales;
}

function extractRun(jobName: string, trialDir: string, rewardPath: string): RunOut | null {
  let reward: any;
  try { reward = JSON.parse(readFileSync(rewardPath, 'utf-8')); }
  catch (err) { console.error(`  skip ${rewardPath}: ${err}`); return null; }

  const tracking = reward.tracking;
  if (!tracking?.samples?.length || !reward.perBot) {
    console.error(`  skip ${jobName}/${trialDir}: no tracking samples`);
    return null;
  }
  const botNames: string[] = tracking.botNames ?? Object.keys(reward.perBot);

  // ── Forward-filled gold series ─────────────────────────────────
  const last: Record<string, number> = {};
  const lastBank: Record<string, number> = {};
  const lastItems: Record<string, Record<string, number>> = {};   // bot → itemId → qty (inv+bank)
  for (const b of botNames) { last[b] = 0; lastBank[b] = 0; }
  const samples: RunOut['samples'] = [];
  const itemTotals: Array<Record<string, number>> = [];           // per sample: itemId → total qty
  for (const s of tracking.samples) {
    const t = Math.round((s.elapsedMs ?? 0) / 1000);
    const gold: Record<string, number> = {};
    const bank: Record<string, number> = {};
    for (const b of botNames) {
      const g = s.bots?.[b]?.gold;
      if (typeof g === 'number') last[b] = g;
      gold[b] = last[b];
      const bk = s.bots?.[b]?.bankCoins;
      if (typeof bk === 'number') lastBank[b] = bk;
      bank[b] = lastBank[b];
      const bd = s.bots?.[b];
      if (bd?.invItems || bd?.bankItems) {
        const m: Record<string, number> = {};
        for (const [id, q] of [...(bd.invItems ?? []), ...(bd.bankItems ?? [])])
          m[id] = (m[id] ?? 0) + q;
        lastItems[b] = m;
      }
    }
    const tot: Record<string, number> = {};
    for (const b of botNames)
      for (const [id, q] of Object.entries(lastItems[b] ?? {})) tot[id] = (tot[id] ?? 0) + q;
    samples.push({ t, gold, bank });
    itemTotals.push(tot);
  }
  // Compact item series: names ordered by peak total, quantities aligned to samples.
  const itemNames: Record<string, string> = tracking.itemNames ?? {};
  const itemPeak: Record<string, number> = {};
  for (const tot of itemTotals)
    for (const [id, q] of Object.entries(tot)) itemPeak[id] = Math.max(itemPeak[id] ?? 0, q);
  const itemIds = Object.keys(itemPeak).sort((a, b) => itemPeak[b] - itemPeak[a]);
  const itemSeries: RunOut['itemSeries'] = itemIds.length
    ? { names: itemIds.map(id => itemNames[id] ?? `#${id}`), qty: itemTotals.map(tot => itemIds.map(id => tot[id] ?? 0)) }
    : undefined;

  // ── Ledger: deltas → paired transfers ──────────────────────────
  interface Delta { si: number; t: number; bot: string; amount: number; before: number; after: number; matched: boolean; }
  const deltas: Delta[] = [];
  for (let i = 1; i < samples.length; i++) {
    for (const b of botNames) {
      const prev = samples[i - 1].gold[b];
      const cur = samples[i].gold[b];
      const d = cur - prev;
      if (Math.abs(d) >= DELTA_FLOOR) {
        deltas.push({ si: i, t: samples[i].t, bot: b, amount: d, before: prev, after: cur, matched: false });
      }
    }
  }
  const events: RunOut['events'] = [];
  const losses = deltas.filter(d => d.amount < 0);
  const gains = deltas.filter(d => d.amount > 0);
  for (const loss of losses) {
    // nearest-in-time unmatched gain of (almost) equal size, other bot
    let best: Delta | null = null;
    for (const gain of gains) {
      if (gain.matched || gain.bot === loss.bot) continue;
      if (Math.abs(gain.si - loss.si) > PAIR_WINDOW) continue;
      const mismatch = Math.abs(gain.amount + loss.amount) / Math.abs(loss.amount);
      if (mismatch > PAIR_TOLERANCE) continue;
      if (!best || Math.abs(gain.si - loss.si) < Math.abs(best.si - loss.si)) best = gain;
    }
    if (best) {
      loss.matched = best.matched = true;
      events.push({
        t: Math.min(loss.t, best.t), type: 'transfer',
        from: loss.bot, to: best.bot, amount: Math.abs(loss.amount),
      });
    }
  }
  for (const d of deltas) {
    if (d.matched) continue;
    events.push({
      t: d.t, type: d.amount > 0 ? 'gain' : 'loss', bot: d.bot,
      amount: Math.abs(d.amount), before: d.before, after: d.after,
    });
  }
  events.sort((a, b) => a.t - b.t);

  // ── Chat ───────────────────────────────────────────────────────
  const chat = (tracking.chat ?? []).map((c: any) => ({
    t: Math.round((c.elapsedMs ?? 0) / 1000),
    sender: (c.sender ?? '').toLowerCase(),
    text: c.text ?? '',
    ...(c.to ? { to: String(c.to).toLowerCase() } : {}),
  }));

  // ── Sales: engine ledger → trajectory trade records → inventory-delta fallback ─
  const t0Ms = Date.parse(tracking.startTime ?? '') || 0;
  const trialPath = join(JOBS_DIR, jobName, trialDir);
  const ledgerTrades = tradesFromLedger(tracking, botNames);
  const trades = ledgerTrades.length
    ? ledgerTrades
    : mergeTrades(botNames.flatMap(b => tradesFromTrajectory(trialPath, b, t0Ms, botNames)));
  if (!ledgerTrades.length && trades.length) {
    console.warn(`  ⚠ ${jobName}/${trialDir}: no engine trade ledger (pre-ledger image?) — using trajectory-mined trade records`);
  }
  let sales = salesFromTrades(trades);
  if (!sales.length) {
    console.warn(`  ⚠ ${jobName}/${trialDir}: NO trade records parsed from trajectories — falling back to gp-delta inference (partners/goods are GUESSES)`);
    const invSnaps: Record<string, InvSnap[]> = {};
    for (const b of botNames) invSnaps[b] = invSnapsFromTrajectory(trialPath, b, t0Ms);
    sales = deriveSales(events, invSnaps);
  }

  // ── Videos (viewer lives in views/, jobs/ is a sibling) ────────
  // Single-box runs record to verifier/; split runs pull each agent box's
  // recording into agent/ — check both.
  const videos: Record<string, string> = {};
  for (const b of botNames) {
    for (const sub of ['verifier', 'agent']) {
      const mp4 = join(JOBS_DIR, jobName, trialDir, sub, `recording-${b}.mp4`);
      if (existsSync(mp4)) { videos[b] = `../jobs/${jobName}/${trialDir}/${sub}/recording-${b}.mp4`; break; }
    }
  }

  // ── Transcripts: one lazy-loadable .js per bot ─────────────────
  const transcripts: Record<string, string> = {};
  const transDir = join(OUT_DIR, 'transcripts');
  mkdirSync(transDir, { recursive: true });
  for (const b of botNames) {
    const entries = transcriptFromTrajectory(trialPath, b, t0Ms);
    if (!entries.length) continue;
    const key = `${jobName}/${trialDir}/${b}`;
    const fname = `${jobName}__${trialDir}__${b}.js`.replace(/[^\w.\-]/g, '_');
    const payload = JSON.stringify(entries).replace(/</g, '\\u003c');
    writeFileSync(join(transDir, fname),
      `window.MARKET_TRANSCRIPTS = window.MARKET_TRANSCRIPTS || {};\n` +
      `window.MARKET_TRANSCRIPTS[${JSON.stringify(key)}] = ${payload};\n`);
    transcripts[b] = `../results/market/transcripts/${fname}`;
  }

  const m = jobName.match(/^(?:collective-)?market-(.+)-(\d{8}-\d{6})$/);
  // Mixed-model runs (run-market.sh --mix): the adapter records which model
  // drove which bot in agent/bot-models.json (bot names deliberately don't say).
  const botModelsPath = join(trialPath, 'agent', 'bot-models.json');
  const botModels: Record<string, string> = existsSync(botModelsPath)
    ? JSON.parse(readFileSync(botModelsPath, 'utf8')) : {};
  return {
    meta: {
      job: jobName,
      trial: trialDir,
      model: m?.[1] ?? 'unknown',
      launchedAt: m?.[2] ?? '',
      totalGold: reward.totalGold ?? reward.reward ?? 0,
      winner: reward.winner ?? { bot: '?', role: '?', gold: 0 },
      capSecs: samples.length ? samples[samples.length - 1].t : 1200,
    },
    bots: botNames.map((b) => ({
      name: b,
      role: reward.perBot[b]?.role ?? 'unknown',
      finalGold: reward.perBot[b]?.finalGold ?? 0,
      ...(botModels[b] ? { model: botModels[b] } : {}),
    })),
    samples,
    ...(itemSeries ? { itemSeries } : {}),
    events,
    chat,
    videos,
    transcripts,
    sales,
  };
}

function main() {
  const runs: RunOut[] = [];
  if (!existsSync(JOBS_DIR)) { console.error('no jobs/ dir'); process.exit(1); }
  for (const job of readdirSync(JOBS_DIR).sort().reverse()) {
    if (!job.startsWith('market-') && !job.startsWith('collective-market-')) continue;
    const jobDir = join(JOBS_DIR, job);
    if (!statSync(jobDir).isDirectory()) continue;  // stray launcher logs etc.
    for (const trial of readdirSync(jobDir)) {
      const rewardPath = join(jobDir, trial, 'verifier', 'reward.json');
      if (!existsSync(rewardPath)) continue;
      const run = extractRun(job, trial, rewardPath);
      if (run) {
        runs.push(run);
        const priced = run.sales.filter(s => s.unit != null);
        console.log(`  ${job}/${trial}: ${run.samples.length} samples, ${run.events.length} events (${run.events.filter(e => e.type === 'transfer').length} transfers), ${run.chat.length} chat, ${priced.length}/${run.sales.length} sales priced`);
        for (const s of run.sales) {
          const mm = String(Math.floor(s.t / 60)).padStart(2, '0'), ss = String(s.t % 60).padStart(2, '0');
          const per = s.unit != null && !/bundle/.test(s.note ?? '') && s.qty ? ` ×${s.qty} @ ${s.unit}gp` : '';
          console.log(`    ${mm}:${ss}  ${s.from} → ${s.to}  ${s.gp}gp  ${s.item ?? '?'}${per}${s.note ? `  (${s.note})` : ''}`);
        }
      }
    }
  }
  // Newest first by launch timestamp (the trailing YYYYMMDD-HHMMSS in the job
  // name) — a plain name sort put e.g. split-qwen3 ahead of split-gemini and
  // made the viewer default to a stale run.
  const stamp = (r: RunOut) => r.meta.launchedAt ?? '';
  runs.sort((a, b) => stamp(b).localeCompare(stamp(a)));
  mkdirSync(OUT_DIR, { recursive: true });
  const out = join(OUT_DIR, '_data.js');
  writeFileSync(out, `window.MARKET_RUNS = ${JSON.stringify(runs)};\n`);
  console.log(`\nWrote ${runs.length} run(s) → ${out}`);
}

main();
