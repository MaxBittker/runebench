/**
 * Verification for the market benchmark (3 miners / 2 smiths / 1 alchemist).
 *
 * Every player scores INDIVIDUALLY: its coins (inventory + bank + worn) at the
 * END of the run — final holdings, not a peak. The final save files are
 * authoritative; because the engine autosaves on a cadence, each bot's save
 * read is guarded with the watcher's LAST observed sample (market_watcher.ts
 * samples live inventory coins + banked coins every few seconds), taking the
 * max of the two so an unflushed save can't under-report.
 *
 * Harbor needs one scalar, so reward = TOTAL final gold across all bots (the
 * market's aggregate wealth; per-bot/per-role breakdowns + the richest bot are
 * in reward.json for analysis).
 *
 * Env:
 *   BOT_NAMES     space-separated bot usernames
 *   MARKET_ROLES  space-separated bot:role pairs (e.g. "a:miner ...")
 *
 * Writes reward.json: { reward, totalGold, perBot, perRole, winner, chat, ... }
 * Writes reward.txt (raw reward) and chat-transcript.txt.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { parseSave, countItem, INV_TYPE, BANK_TYPE, WORN_TYPE } from './save-parser';

const COINS_ID = 995;

const BOT_NAMES = (process.env.BOT_NAMES || 'a b c d e f').split(/\s+/).filter(Boolean);
const ROLES: Record<string, string> = {};
for (const pair of (process.env.MARKET_ROLES || '').split(/\s+/).filter(Boolean)) {
    const [bot, role] = pair.split(':');
    if (bot && role) ROLES[bot] = role;
}

const TRACKING_PATHS = [
    '/logs/tracking/market_tracking.json',
    '/logs/verifier/market_tracking.json',
];

const savePathsFor = (bot: string) => [
    `/app/server/engine/data/players/main/${bot}.sav`,
    `/app/engine/data/players/main/${bot}.sav`,
];

function main() {
    mkdirSync('/logs/verifier', { recursive: true });

    // ── 1. Watcher tracking data (chat + last-sample floor guard) ────
    let tracking: any = null;
    for (const p of TRACKING_PATHS) {
        if (existsSync(p)) {
            try {
                tracking = JSON.parse(readFileSync(p, 'utf-8'));
                console.log(`Tracking: ${tracking.samples?.length ?? 0} samples (from ${p})`);
                break;
            } catch (err) {
                console.error(`Failed to read ${p}:`, err);
            }
        }
    }

    // Last observed gold per bot (floor guard against a stale final save)
    const lastObserved: Record<string, number> = {};
    for (const s of tracking?.samples ?? []) {
        for (const bot of BOT_NAMES) {
            const g = s.bots?.[bot]?.gold;
            if (typeof g === 'number') lastObserved[bot] = g;
        }
    }

    // ── 2. Final save files (authoritative) ──────────────────────────
    const perBot: Record<string, any> = {};
    for (const bot of BOT_NAMES) {
        let save = null;
        for (const p of savePathsFor(bot)) {
            if (!existsSync(p)) continue;
            try { save = parseSave(new Uint8Array(readFileSync(p))); break; }
            catch (err) { console.error(`Failed to parse ${p}:`, err); }
        }

        let invGold = 0, bankGold = 0, saveGold: number | null = null;
        if (save) {
            invGold = countItem(save.inventories.get(INV_TYPE), COINS_ID);
            bankGold = countItem(save.inventories.get(BANK_TYPE), COINS_ID)
                + countItem(save.inventories.get(WORN_TYPE), COINS_ID);
            saveGold = invGold + bankGold;
        } else {
            console.log(`${bot}: no save file found — using watcher last sample`);
        }

        const observed = lastObserved[bot];
        const finalGold = Math.max(saveGold ?? 0, observed ?? 0);
        perBot[bot] = {
            role: ROLES[bot] ?? 'unknown',
            finalGold,
            saveGold,
            inventoryGold: invGold,
            bankGold,
            lastObservedGold: observed ?? null,
            source: saveGold != null && finalGold === saveGold ? 'save' : (observed != null ? 'watcher' : 'default'),
        };
        console.log(`${bot} (${perBot[bot].role}): final gold ${finalGold} (save=${saveGold ?? 'n/a'}, watcher=${observed ?? 'n/a'})`);
    }

    // ── 3. Score: total market wealth; winner = richest individual ───
    const totalGold = BOT_NAMES.reduce((sum, b) => sum + perBot[b].finalGold, 0);
    let winnerBot = BOT_NAMES[0];
    for (const bot of BOT_NAMES) {
        if (perBot[bot].finalGold > perBot[winnerBot].finalGold) winnerBot = bot;
    }
    const perRole: Record<string, number> = {};
    for (const bot of BOT_NAMES) {
        const role = perBot[bot].role;
        perRole[role] = (perRole[role] ?? 0) + perBot[bot].finalGold;
    }
    const reward = totalGold;

    // ── 4. Chat transcript ───────────────────────────────────────────
    const chat: any[] = tracking?.chat ?? [];
    const transcriptLines = chat.map((c: any) => {
        const t = Math.round((c.elapsedMs ?? 0) / 1000);
        const mm = String(Math.floor(t / 60)).padStart(2, '0');
        const ss = String(t % 60).padStart(2, '0');
        return `[${mm}:${ss}] ${c.sender}: ${c.text}`;
    });
    writeFileSync('/logs/verifier/chat-transcript.txt', transcriptLines.join('\n') + '\n');
    console.log(`Chat transcript: ${chat.length} message(s) → /logs/verifier/chat-transcript.txt`);

    // ── 5. Write reward ──────────────────────────────────────────────
    const rewardObj = {
        reward,
        totalGold,
        winner: { bot: winnerBot, role: perBot[winnerBot].role, gold: perBot[winnerBot].finalGold },
        perBot,
        perRole,
        chatCount: chat.length,
        chat,
        tracking,
    };

    writeFileSync('/logs/verifier/reward.json', JSON.stringify(rewardObj, null, 2));
    writeFileSync('/logs/verifier/reward.txt', reward.toString());

    console.log(`Total market gold: ${totalGold} · richest: ${winnerBot} (${perBot[winnerBot].role}) with ${perBot[winnerBot].finalGold} → reward=${reward}`);

    console.log('__REWARD_JSON_START__');
    console.log(JSON.stringify({ ...rewardObj, tracking: undefined, chat: undefined }));
    console.log('__REWARD_JSON_END__');
}

main();
