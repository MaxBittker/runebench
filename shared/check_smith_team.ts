/**
 * Verification for the three-bot cooperative smithing task.
 *
 * Score = store value (obj cost) of the single most valuable SMITHABLE item
 * the team legitimately produced within the horizon.
 *
 * Anti-cheat gate (not disclosed to the agents): an item only counts if it
 * appeared in a bot's inventory while that bot had the Smithing level
 * required to make it. A purchased or scavenged high-tier item held by a
 * low-level bot is recorded but scores nothing.
 *
 * Evidence sources, in order of preference:
 *   1. Watcher events (/logs/tracking/smith_team_tracking.json,
 *      smith_team_watcher.ts): live "gained" events carry the bot's Smithing
 *      level at the moment the item appeared — 5s resolution.
 *   2. Final save files (fallback, e.g. watcher outage): smithable items in
 *      inventory/worn/bank count if the bot's FINAL Smithing level meets the
 *      requirement.
 *
 * Writes reward.json: { reward, bestItem, perBot, invalidCandidates, chat, ... }
 * Writes reward.txt (raw reward) and chat-transcript.txt.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { parseSave, INV_TYPE, WORN_TYPE, BANK_TYPE } from './save-parser';

const BOT_NAMES = (process.env.BOT_NAMES || 'agenta agentb agentc').split(/\s+/).filter(Boolean);
const SMITHING_SKILL_INDEX = 13;

// Items every bot starts with (TEAM_START_INVENTORY in generate-tasks.ts;
// exported by the task's test.sh). The starting bronze axe (1351) is itself a
// level-1 smithable worth 16gp — without this filter it puts a 16gp floor
// under every run. A run that genuinely smiths a bronze axe forfeits those
// 16gp; anything beyond the very first bar/dagger out-scores it anyway.
const STARTING_ITEM_IDS = new Set(
    (process.env.STARTING_ITEM_IDS || '1265 1351').split(/\s+/).filter(Boolean).map(Number),
);

const TRACKING_PATHS = [
    '/logs/tracking/smith_team_tracking.json',
    '/logs/verifier/smith_team_tracking.json',
];

const TABLE_PATHS = [
    join(import.meta.dir, 'smithing-table.json'),
    '/app/benchmark/shared/smithing-table.json',
];

const savePathsFor = (bot: string) => [
    `/app/server/engine/data/players/main/${bot}.sav`,
    `/app/engine/data/players/main/${bot}.sav`,
];

interface SmithRecipe { name: string; id: number; cost: number; level: number; method: string; }

interface Candidate {
    bot: string;
    itemId: number;
    name: string;
    cost: number;
    levelRequired: number;
    smithingLevel: number;
    valid: boolean;
    method: 'watcher-event' | 'final-save';
    elapsedMs: number | null;
}

function main() {
    mkdirSync('/logs/verifier', { recursive: true });

    // ── Smithing table ────────────────────────────────────────────────
    let recipes: SmithRecipe[] = [];
    for (const p of TABLE_PATHS) {
        if (existsSync(p)) { recipes = JSON.parse(readFileSync(p, 'utf-8')); break; }
    }
    if (recipes.length === 0) {
        console.error('FATAL: smithing-table.json not found');
        writeFileSync('/logs/verifier/reward.txt', '0');
        writeFileSync('/logs/verifier/reward.json', JSON.stringify({ reward: 0, error: 'no smithing table' }));
        process.exit(1);
    }
    const recipeById = new Map<number, SmithRecipe>(recipes.map(r => [r.id, r]));

    // ── 1. Watcher tracking data ──────────────────────────────────────
    let tracking: any = null;
    for (const p of TRACKING_PATHS) {
        if (existsSync(p)) {
            try {
                tracking = JSON.parse(readFileSync(p, 'utf-8'));
                console.log(`Tracking: ${tracking.samples?.length ?? 0} samples, ${tracking.events?.length ?? 0} events (from ${p})`);
                break;
            } catch (err) {
                console.error(`Failed to read ${p}:`, err);
            }
        }
    }

    const candidates: Candidate[] = [];

    for (const ev of tracking?.events ?? []) {
        if (ev.event !== 'gained') continue;
        if (STARTING_ITEM_IDS.has(ev.itemId)) continue;
        candidates.push({
            bot: ev.bot,
            itemId: ev.itemId,
            name: ev.name,
            cost: ev.cost,
            levelRequired: ev.levelRequired,
            smithingLevel: ev.smithingLevel,
            valid: !!ev.valid,
            method: 'watcher-event',
            elapsedMs: ev.elapsedMs ?? null,
        });
    }

    // ── 2. Final save files (fallback + per-bot summary) ──────────────
    const perBot: Record<string, any> = {};
    for (const bot of BOT_NAMES) {
        let save = null;
        for (const p of savePathsFor(bot)) {
            if (!existsSync(p)) continue;
            try { save = parseSave(new Uint8Array(readFileSync(p))); break; }
            catch (err) { console.error(`Failed to parse ${p}:`, err); }
        }
        if (!save) {
            console.log(`${bot}: no save file found`);
            perBot[bot] = { finalSmithing: null, finalMining: null };
            continue;
        }

        const smithingLevel = save.skills[SMITHING_SKILL_INDEX]?.level ?? 1;
        const miningLevel = save.skills[14]?.level ?? 1;
        // Save files store XP ×10 (engine-internal); normalize to real XP.
        perBot[bot] = {
            finalSmithing: { level: smithingLevel, xp: Math.floor((save.skills[SMITHING_SKILL_INDEX]?.xp ?? 0) / 10) },
            finalMining: { level: miningLevel, xp: Math.floor((save.skills[14]?.xp ?? 0) / 10) },
        };
        console.log(`${bot}: final Smithing ${smithingLevel}, Mining ${miningLevel}`);

        for (const invType of [INV_TYPE, WORN_TYPE, BANK_TYPE]) {
            for (const item of save.inventories.get(invType) ?? []) {
                const r = recipeById.get(item.id);
                if (!r) continue;
                if (STARTING_ITEM_IDS.has(item.id)) continue;
                candidates.push({
                    bot,
                    itemId: item.id,
                    name: r.name,
                    cost: r.cost,
                    levelRequired: r.level,
                    smithingLevel,
                    valid: smithingLevel >= r.level,
                    method: 'final-save',
                    elapsedMs: null,
                });
            }
        }
    }

    // ── 3. Score: best valid candidate ────────────────────────────────
    const valid = candidates.filter(c => c.valid);
    const invalid = candidates.filter(c => !c.valid);
    // Prefer watcher events over save entries at equal cost (they carry timing)
    valid.sort((a, b) => b.cost - a.cost || (a.method === 'watcher-event' ? -1 : 1));
    const best = valid[0] ?? null;
    const reward = best?.cost ?? 0;

    // Best invalid candidate that BEAT the score — the cheat-detection artifact
    const invalidBest = invalid.sort((a, b) => b.cost - a.cost)[0] ?? null;
    const suspectedCheat = !!(invalidBest && invalidBest.cost > reward);

    // Per-bot best valid item
    for (const bot of BOT_NAMES) {
        const botBest = valid.find(c => c.bot === bot) ?? null;
        perBot[bot] = { ...perBot[bot], bestValidItem: botBest ? { name: botBest.name, cost: botBest.cost } : null };
    }

    // ── 4. Chat transcript ────────────────────────────────────────────
    const chat: any[] = tracking?.chat ?? [];
    const transcriptLines = chat.map((c: any) => {
        const t = Math.round((c.elapsedMs ?? 0) / 1000);
        const mm = String(Math.floor(t / 60)).padStart(2, '0');
        const ss = String(t % 60).padStart(2, '0');
        return `[${mm}:${ss}] ${c.sender}: ${c.text}`;
    });
    writeFileSync('/logs/verifier/chat-transcript.txt', transcriptLines.join('\n') + '\n');
    console.log(`Chat transcript: ${chat.length} message(s) → /logs/verifier/chat-transcript.txt`);

    // ── 5. Write reward ───────────────────────────────────────────────
    const rewardObj = {
        reward,
        bestItem: best ? {
            name: best.name, cost: best.cost, bot: best.bot,
            levelRequired: best.levelRequired, smithingLevel: best.smithingLevel,
            method: best.method, elapsedMs: best.elapsedMs,
            elapsedSecs: best.elapsedMs !== null ? Math.round(best.elapsedMs / 1000) : null,
        } : null,
        suspectedCheat,
        invalidBest: invalidBest ? {
            name: invalidBest.name, cost: invalidBest.cost, bot: invalidBest.bot,
            levelRequired: invalidBest.levelRequired, smithingLevel: invalidBest.smithingLevel,
            method: invalidBest.method,
        } : null,
        perBot,
        validCandidateCount: valid.length,
        invalidCandidates: invalid.map(c => ({ bot: c.bot, name: c.name, cost: c.cost, levelRequired: c.levelRequired, smithingLevel: c.smithingLevel, method: c.method })),
        chat,
        chatCount: chat.length,
        events: tracking?.events ?? [],
        tracking,
    };

    writeFileSync('/logs/verifier/reward.json', JSON.stringify(rewardObj, null, 2));
    writeFileSync('/logs/verifier/reward.txt', reward.toString());

    if (best) {
        console.log(`Best smithed item: ${best.name} (${best.cost}gp) by ${best.bot} [req ${best.levelRequired}, had ${best.smithingLevel}] via ${best.method} → reward=${reward}`);
    } else {
        console.log(`No valid smithed items found → reward=0`);
    }
    if (suspectedCheat) {
        console.log(`SUSPECTED CHEAT: ${invalidBest!.bot} held ${invalidBest!.name} (${invalidBest!.cost}gp, req ${invalidBest!.levelRequired}) at Smithing ${invalidBest!.smithingLevel}`);
    }

    console.log('__REWARD_JSON_START__');
    console.log(JSON.stringify({ ...rewardObj, tracking: undefined, events: undefined, chat: undefined, invalidCandidates: undefined }));
    console.log('__REWARD_JSON_END__');
}

main();
