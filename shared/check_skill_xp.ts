/**
 * Verification: report XP for a specific skill as reward, with tracking data.
 *
 * Single-skill XP verifier with time-series tracking.
 * Reads SKILL_NAME env var, reports that skill's XP as reward.
 * Also reads skill_tracking.json and embeds time-series data in reward.json
 * so extract-skill-results.ts can find per-sample data.
 *
 * Writes to reward.json: { skill, xp, level, tracking }
 * Writes raw XP to reward.txt for Harbor compatibility.
 */
// @ts-ignore
import { BotSDK } from '/app/sdk/index';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';

const SKILL_NAME = process.env.SKILL_NAME;
if (!SKILL_NAME) {
    console.error('SKILL_NAME environment variable is required');
    process.exit(1);
}

// Only the root-owned tracker output counts. /logs/verifier is agent-writable
// (harbor chmods it 777), so it is deliberately NOT a fallback any more.
const TRACKING_PATHS = [
    '/logs/tracking/skill_tracking.json',
];

// Windows shorter than this are ignored when computing the peak. The tracker samples
// every 15s; a short gap only appears when a tracker was restarted or two ran at once,
// and a 1-second window with one hit in it is not a rate. 12s leaves ~3s of wiggle room
// for scheduler jitter. Keep in sync with shared/check_xp_rate.ts, shared/extract-utils.ts
// and views/shared-constants.js (scripts/check-xp-normalization-sync.ts guards this).
const MIN_PEAK_WINDOW_MS = 12000;

const verifierStartTime = new Date().toISOString();

function getSkillXpFromSample(sample: any, skill: string): number {
    if (!sample?.skills) return 0;
    for (const [name, data] of Object.entries(sample.skills)) {
        if (name.toLowerCase() === skill.toLowerCase()) {
            return (data as any).xp || 0;
        }
    }
    return 0;
}

// Window ending at sample i starts at the NEAREST earlier sample that is at least
// MIN_PEAK_WINDOW_MS back. On the normal 15s cadence that is simply i-1; when a tracker
// restart or a duplicate tracker leaves sub-cadence gaps, several samples are merged
// into one ≥12s window instead of a 1-second spike becoming "the peak".
// Mirrors extractors/extract-skill-results.ts — verifier and extractor must agree.
function peakWindowStart(samples: any[], i: number): number {
    for (let k = i - 1; k >= 0; k--) {
        if (samples[i].elapsedMs - samples[k].elapsedMs >= MIN_PEAK_WINDOW_MS) return k;
    }
    return -1;
}

function computePeakXpRate(samples: any[], skill: string): number {
    let peak = 0;
    for (let i = 1; i < samples.length; i++) {
        const k = peakWindowStart(samples, i);
        if (k < 0) continue;
        const prev = samples[k];
        const curr = samples[i];
        const deltaXp = getSkillXpFromSample(curr, skill) - getSkillXpFromSample(prev, skill);
        const deltaMs = curr.elapsedMs - prev.elapsedMs;
        if (deltaMs <= 0 || deltaXp <= 0) continue;
        const rate = (deltaXp / deltaMs) * 60000 / 8 / 25; // real-game XP/min (÷8 game speed, ÷25 XP rate)
        if (rate > peak) peak = rate;
    }
    return Math.round(peak);
}

async function main() {
    const sdk = new BotSDK({
        botUsername: 'agent',
        password: 'test',
        gatewayUrl: 'ws://localhost:7780',
        connectionMode: 'observe',
        autoLaunchBrowser: false,
        autoReconnect: false,
    });

    try {
        await sdk.connect();
        await sdk.waitForCondition(s => s.inGame && s.skills.length > 0, 15000);

        const skill = sdk.getSkill(SKILL_NAME as string);
        const level = skill?.level ?? 1;
        const xp = skill?.experience ?? 0;

        console.log(`${SKILL_NAME}: level ${level}, xp ${xp}`);

        mkdirSync('/logs/verifier', { recursive: true });

        // Read tracking data from whichever location the tracker used
        let trackingData: any = null;
        for (const trackingPath of TRACKING_PATHS) {
            if (existsSync(trackingPath)) {
                try {
                    trackingData = JSON.parse(readFileSync(trackingPath, 'utf-8')) as any;
                    const sampleCount = trackingData?.samples?.length ?? 0;
                    const lastSampleMs = sampleCount > 0
                        ? trackingData.samples[sampleCount - 1].elapsedMs
                        : 0;
                    console.log(`Tracking data: ${sampleCount} samples, last at ${(lastSampleMs / 1000).toFixed(1)}s (from ${trackingPath})`);
                    break;
                } catch (err) {
                    console.error(`Failed to read tracking data from ${trackingPath}:`, err);
                }
            }
        }
        if (!trackingData) {
            console.log('No tracking data file found in:', TRACKING_PATHS.join(', '));
        }

        // Compute peak XP rate from tracking samples
        const trackingSamples = trackingData?.samples || [];
        const peakXpRate = computePeakXpRate(trackingSamples, SKILL_NAME as string);
        console.log(`Peak XP rate: ${peakXpRate.toLocaleString()} XP/min`);

        const rewardObj = {
            skill: SKILL_NAME,
            peakXpRate,
            xp,
            level,
            verifierStartTime,
            tracking: trackingData,
        };

        writeFileSync('/logs/verifier/reward.json', JSON.stringify(rewardObj, null, 2));
        writeFileSync('/logs/verifier/reward.txt', peakXpRate.toString());

        console.log(`Reward: peakXpRate=${peakXpRate} XP/min, xp=${xp}, level=${level}`);

        // Print reward JSON to stdout for recovery from test-stdout.txt
        console.log(`__REWARD_JSON_START__`);
        console.log(JSON.stringify(rewardObj));
        console.log(`__REWARD_JSON_END__`);
    } finally {
        sdk.disconnect();
    }
}

main().catch(err => {
    console.error('Verification error:', err);
    try {
        mkdirSync('/logs/verifier', { recursive: true });
        writeFileSync('/logs/verifier/reward.txt', '0');
        writeFileSync('/logs/verifier/reward.json', JSON.stringify({
            skill: SKILL_NAME,
            peakXpRate: 0,
            xp: 0,
            level: 1,
            error: err.message,
        }));
    } catch {}
    process.exit(1);
});
