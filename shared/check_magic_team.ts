/**
 * Verification for the three-bot cooperative Magic-level task.
 *
 * Score = the highest Magic level reached by ANY of the three accounts within
 * the horizon. The intended team play is to consolidate runes onto one
 * designated caster (dropped/traded in-game) so a single account climbs higher
 * than any bot could training alone.
 *
 * A skill level can only rise through legitimate casting, so there is no item
 * anti-cheat gate here: the final save file is authoritative. The watcher
 * tracking (magic_team_watcher.ts) is used only for the chat transcript and as
 * a peak-level fallback if a save file is unreadable.
 *
 * Writes reward.json: { reward, best, perBot, chat, ... }
 * Writes reward.txt (raw reward = best Magic level) and chat-transcript.txt.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { parseSave } from './save-parser';

const BOT_NAMES = (process.env.BOT_NAMES || 'agenta agentb agentc').split(/\s+/).filter(Boolean);
const MAGIC_SKILL_INDEX = 6;
const HITPOINTS_SKILL_INDEX = 3;

const TRACKING_PATHS = [
    '/logs/tracking/magic_team_tracking.json',
    '/logs/verifier/magic_team_tracking.json',
];

const savePathsFor = (bot: string) => [
    `/app/server/engine/data/players/main/${bot}.sav`,
    `/app/engine/data/players/main/${bot}.sav`,
];

function main() {
    mkdirSync('/logs/verifier', { recursive: true });

    // ── 1. Watcher tracking data (chat + peak-level fallback) ─────────
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

    // Peak Magic level per bot observed by the watcher (fallback only)
    const watcherPeak: Record<string, { level: number; xp: number }> = {};
    for (const s of tracking?.samples ?? []) {
        for (const bot of BOT_NAMES) {
            const m = s.bots?.[bot]?.magic;
            if (!m) continue;
            const prev = watcherPeak[bot];
            if (!prev || m.level > prev.level || (m.level === prev.level && m.xp > prev.xp)) {
                watcherPeak[bot] = { level: m.level, xp: m.xp };
            }
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

        let magicLevel = 1, magicXp = 0, hpLevel = 10;
        if (save) {
            magicLevel = save.skills[MAGIC_SKILL_INDEX]?.level ?? 1;
            // Save files store XP ×10 (engine-internal); normalize to real XP
            // so it's comparable with the watcher samples and skill tasks.
            magicXp = Math.floor((save.skills[MAGIC_SKILL_INDEX]?.xp ?? 0) / 10);
            hpLevel = save.skills[HITPOINTS_SKILL_INDEX]?.level ?? 10;
        } else {
            console.log(`${bot}: no save file found — using watcher peak`);
        }

        // Guard against an unflushed save: never report below what the watcher saw.
        const peak = watcherPeak[bot];
        if (peak && (peak.level > magicLevel || (peak.level === magicLevel && peak.xp > magicXp))) {
            magicLevel = peak.level;
            magicXp = peak.xp;
        }

        perBot[bot] = {
            magic: { level: magicLevel, xp: magicXp },
            hitpoints: { level: hpLevel },
            source: save ? 'save' : (peak ? 'watcher' : 'default'),
        };
        console.log(`${bot}: final Magic ${magicLevel} (${magicXp} xp)`);
    }

    // ── 3. Score: highest Magic level on any account ─────────────────
    let bestBot = BOT_NAMES[0];
    for (const bot of BOT_NAMES) {
        const a = perBot[bot].magic, b = perBot[bestBot].magic;
        if (a.level > b.level || (a.level === b.level && a.xp > b.xp)) bestBot = bot;
    }
    const best = { bot: bestBot, level: perBot[bestBot].magic.level, xp: perBot[bestBot].magic.xp };
    const reward = best.level;

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
        best: {
            ...best,
            elapsedSecs: tracking?.best?.bot === bestBot && tracking?.best?.elapsedMs != null
                ? Math.round(tracking.best.elapsedMs / 1000) : null,
        },
        perBot,
        chatCount: chat.length,
        chat,
        tracking,
    };

    writeFileSync('/logs/verifier/reward.json', JSON.stringify(rewardObj, null, 2));
    writeFileSync('/logs/verifier/reward.txt', reward.toString());

    console.log(`Best Magic level: ${best.level} (${best.xp} xp) by ${best.bot} → reward=${reward}`);

    console.log('__REWARD_JSON_START__');
    console.log(JSON.stringify({ ...rewardObj, tracking: undefined, chat: undefined }));
    console.log('__REWARD_JSON_END__');
}

main();
