/**
 * Verification for the Shield of Arrav duo task.
 *
 * Completion (per bot) is confirmed from the on-disk save file varps:
 *   varp 145 (blackarmgang) == 4  → quest complete via Black Arm route
 *   varp 146 (phoenixgang)  == 10 → quest complete via Phoenix route
 *
 * Timing comes from /logs/tracking/arrav_tracking.json (arrav_watcher.ts):
 *   - precise: the last moment the full Certificate (obj 769) left a
 *     varp-confirmed bot's inventory (it is deleted when King Roald accepts it)
 *   - fallback: the watcher's save-varp detection time (≤ ~75s lag), or the
 *     full horizon if the watcher produced nothing.
 *
 * Reward (higher is better, 0 = did not finish):
 *   reward = max(0, CAP_SECS - firstCompletionSecs)   # "seconds saved"
 *
 * Writes reward.json: { reward, completed, bothCompleted, firstCompletionMs,
 *                       perBot, chat, milestones, tracking }
 * Writes reward.txt with the raw reward for Harbor compatibility.
 * Writes chat-transcript.txt — the in-game chat log between the two bots
 * (the primary artifact for studying collaboration).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { parseSave } from './save-parser';

const CAP_SECS = parseInt(process.env.ARRAV_CAP_SECS || '1800'); // 30m
const BOT_NAMES = (process.env.BOT_NAMES || 'agenta agentb').split(/\s+/).filter(Boolean);

const VARP_BLACKARM = 145;
const VARP_PHOENIX = 146;
const BLACKARM_COMPLETE = 4;
const PHOENIX_COMPLETE = 10;
const CERTIFICATE_LABEL = 'arravcertificate';

const TRACKING_PATHS = [
    '/logs/tracking/arrav_tracking.json',
    '/logs/verifier/arrav_tracking.json',
];

const savePathsFor = (bot: string) => [
    `/app/server/engine/data/players/main/${bot}.sav`,
    `/app/engine/data/players/main/${bot}.sav`,
];

interface QuestState { blackarm: number; phoenix: number; }

function readQuestVarps(paths: string[]): QuestState | null {
    for (const path of paths) {
        if (!existsSync(path)) continue;
        try {
            const save = parseSave(new Uint8Array(readFileSync(path)));
            return {
                blackarm: save.varps[VARP_BLACKARM] ?? 0,
                phoenix: save.varps[VARP_PHOENIX] ?? 0,
            };
        } catch (err) {
            console.error(`Failed to parse ${path}:`, err);
        }
    }
    return null;
}

const questComplete = (q: QuestState | null) =>
    !!q && (q.blackarm >= BLACKARM_COMPLETE || q.phoenix >= PHOENIX_COMPLETE);

function main() {
    mkdirSync('/logs/verifier', { recursive: true });

    // ── 1. Authoritative per-bot completion from save files ─────────
    const perBot: Record<string, { varps: QuestState | null; completed: boolean; completionMs: number | null; method: string | null }> = {};
    for (const bot of BOT_NAMES) {
        const varps = readQuestVarps(savePathsFor(bot));
        perBot[bot] = { varps, completed: questComplete(varps), completionMs: null, method: null };
        console.log(`${bot}: varps blackarm=${varps?.blackarm ?? 'n/a'} phoenix=${varps?.phoenix ?? 'n/a'} → ${perBot[bot]!.completed ? 'COMPLETE' : 'incomplete'}`);
    }

    // ── 2. Timing from the watcher's tracking file ───────────────────
    let tracking: any = null;
    for (const p of TRACKING_PATHS) {
        if (existsSync(p)) {
            try {
                tracking = JSON.parse(readFileSync(p, 'utf-8'));
                console.log(`Tracking: ${tracking.samples?.length ?? 0} samples, ${tracking.milestones?.length ?? 0} milestones (from ${p})`);
                break;
            } catch (err) {
                console.error(`Failed to read ${p}:`, err);
            }
        }
    }

    for (const bot of BOT_NAMES) {
        const info = perBot[bot]!;
        if (!info.completed) continue;

        // Precise: last time the certificate left this bot's inventory.
        // (After King Roald takes it the bot can never regain it, so the
        //  final 'lost' event is the handover moment.)
        const certLosses = (tracking?.milestones ?? []).filter(
            (m: any) => m.bot === bot && m.item === CERTIFICATE_LABEL && m.event === 'lost',
        );
        if (certLosses.length > 0) {
            info.completionMs = certLosses[certLosses.length - 1].elapsedMs;
            info.method = 'certificate-handover';
            continue;
        }

        // Fallback: watcher's (lagged) save-varp detection
        const watcherCompletion = (tracking?.completions ?? []).find((c: any) => c.bot === bot);
        if (watcherCompletion) {
            info.completionMs = watcherCompletion.elapsedMs;
            info.method = `watcher-${watcherCompletion.method}`;
            continue;
        }

        // Last resort: completed but no timing data — credit the full horizon
        info.completionMs = CAP_SECS * 1000;
        info.method = 'no-timing-data';
    }

    // ── 2b. In-game chat transcript ───────────────────────────────────
    const chat: any[] = tracking?.chat ?? [];
    const transcriptLines = chat.map((c: any) => {
        const t = Math.round((c.elapsedMs ?? 0) / 1000);
        const mm = String(Math.floor(t / 60)).padStart(2, '0');
        const ss = String(t % 60).padStart(2, '0');
        return `[${mm}:${ss}] ${c.sender}: ${c.text}`;
    });
    writeFileSync('/logs/verifier/chat-transcript.txt', transcriptLines.join('\n') + '\n');
    console.log(`Chat transcript: ${chat.length} message(s) → /logs/verifier/chat-transcript.txt`);
    for (const line of transcriptLines.slice(0, 20)) console.log(`  ${line}`);
    if (transcriptLines.length > 20) console.log(`  ... (${transcriptLines.length - 20} more)`);

    // ── 3. Score ──────────────────────────────────────────────────────
    const completedBots = BOT_NAMES.filter(b => perBot[b]!.completed);
    const completed = completedBots.length > 0;
    const bothCompleted = completedBots.length === BOT_NAMES.length;
    const firstCompletionMs = completed
        ? Math.min(...completedBots.map(b => perBot[b]!.completionMs ?? CAP_SECS * 1000))
        : null;

    const reward = completed
        ? Math.max(0, CAP_SECS - Math.round((firstCompletionMs ?? CAP_SECS * 1000) / 1000))
        : 0;

    const rewardObj = {
        reward,                       // seconds saved vs the cap (higher = faster)
        capSecs: CAP_SECS,
        completed,
        bothCompleted,
        firstCompletionMs,
        firstCompletionSecs: firstCompletionMs !== null ? Math.round(firstCompletionMs / 1000) : null,
        perBot,
        chat,
        chatCount: chat.length,
        milestones: tracking?.milestones ?? [],
        tracking,
    };

    writeFileSync('/logs/verifier/reward.json', JSON.stringify(rewardObj, null, 2));
    writeFileSync('/logs/verifier/reward.txt', reward.toString());

    if (completed) {
        console.log(`Quest COMPLETE at ${Math.round((firstCompletionMs ?? 0) / 1000)}s (${completedBots.join(', ')}${bothCompleted ? ' — both bots' : ''}) → reward=${reward}`);
    } else {
        console.log(`Quest NOT completed within ${CAP_SECS}s → reward=0`);
    }

    console.log('__REWARD_JSON_START__');
    console.log(JSON.stringify({ ...rewardObj, tracking: undefined, milestones: undefined, chat: undefined }));
    console.log('__REWARD_JSON_END__');
}

main();
