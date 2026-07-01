/**
 * Verification for the three-bot cooperative TOTAL-Crafting-XP task.
 *
 * Score = the highest single account's Crafting XP (the MAX across the three
 * bots). Like magic-team, the intended play is to funnel materials onto one
 * designated crafter so a single account climbs as high as possible while the
 * others gather/supply. topShare (best bot's fraction of the team total) is
 * recorded for context — a high share is expected here.
 *
 * A skill's XP can only rise through legitimate crafting, so the final save
 * files (skill index 12 = Crafting) are authoritative; the watcher tracking
 * (crafting_team_watcher.ts) supplies the chat transcript and a per-bot peak-XP
 * fallback if a save is unreadable.
 *
 * Writes reward.json { reward, totalXp, perBot, topBot, chat, ... },
 * reward.txt (raw reward = total Crafting XP) and chat-transcript.txt.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { parseSave } from './save-parser';

const BOT_NAMES = (process.env.BOT_NAMES || 'agenta agentb agentc').split(/\s+/).filter(Boolean);
const CRAFTING_SKILL_INDEX = 12;

const TRACKING_PATHS = [
    '/logs/tracking/crafting_team_tracking.json',
    '/logs/verifier/crafting_team_tracking.json',
];
const savePathsFor = (bot: string) => [
    `/app/server/engine/data/players/main/${bot}.sav`,
    `/app/engine/data/players/main/${bot}.sav`,
];

function main() {
    mkdirSync('/logs/verifier', { recursive: true });

    // ── 1. Watcher tracking (chat + peak-XP fallback) ────────────────
    let tracking: any = null;
    for (const p of TRACKING_PATHS) {
        if (existsSync(p)) {
            try {
                tracking = JSON.parse(readFileSync(p, 'utf-8'));
                console.log(`Tracking: ${tracking.samples?.length ?? 0} samples (from ${p})`);
                break;
            } catch (err) { console.error(`Failed to read ${p}:`, err); }
        }
    }
    const watcherPeakXp: Record<string, number> = {};
    for (const s of tracking?.samples ?? []) {
        for (const bot of BOT_NAMES) {
            const xp = s.bots?.[bot]?.crafting?.xp;
            if (xp == null) continue;
            if (!(bot in watcherPeakXp) || xp > watcherPeakXp[bot]) watcherPeakXp[bot] = xp;
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
        let level = 1, xp = 0;
        if (save) {
            level = save.skills[CRAFTING_SKILL_INDEX]?.level ?? 1;
            xp = save.skills[CRAFTING_SKILL_INDEX]?.xp ?? 0;
        } else {
            console.log(`${bot}: no save file found — using watcher peak`);
        }
        // Guard an unflushed save: never report below what the watcher saw.
        if (watcherPeakXp[bot] != null && watcherPeakXp[bot] > xp) xp = watcherPeakXp[bot];

        perBot[bot] = { crafting: { level, xp }, source: save ? 'save' : (bot in watcherPeakXp ? 'watcher' : 'default') };
        console.log(`${bot}: final Crafting ${level} (${xp} xp)`);
    }

    // ── 3. Score: the MAX single account's Crafting XP ───────────────
    const totalXp = BOT_NAMES.reduce((a, b) => a + (perBot[b].crafting.xp ?? 0), 0);
    let topBot = BOT_NAMES[0];
    for (const bot of BOT_NAMES) if (perBot[bot].crafting.xp > perBot[topBot].crafting.xp) topBot = bot;
    const reward = perBot[topBot].crafting.xp;

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
    const balance = BOT_NAMES.map(b => perBot[b].crafting.xp);
    const rewardObj = {
        reward, totalXp,
        topBot: { bot: topBot, xp: perBot[topBot].crafting.xp, level: perBot[topBot].crafting.level },
        // share of the total held by the single best bot — 0.33 = perfectly even, 1.0 = solo carry
        topShare: totalXp > 0 ? +(perBot[topBot].crafting.xp / totalXp).toFixed(3) : 0,
        perBot,
        chatCount: chat.length,
        chat,
        tracking,
    };
    writeFileSync('/logs/verifier/reward.json', JSON.stringify(rewardObj, null, 2));
    writeFileSync('/logs/verifier/reward.txt', reward.toString());

    console.log(`Best single-account Crafting XP: ${reward} by ${topBot} (Crafting ${perBot[topBot].crafting.level}); team split ${balance.join(' + ')} → reward=${reward}`);
    console.log('__REWARD_JSON_START__');
    console.log(JSON.stringify({ ...rewardObj, tracking: undefined, chat: undefined }));
    console.log('__REWARD_JSON_END__');
}

main();
