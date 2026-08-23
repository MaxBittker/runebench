import { runScript } from '../../sdk/runner';

import { XpRateTracker, findDropTargets, ticksToMs } from './_lib/efficiency';

// thieving-v2 — level-laddered pickpocketer with stun-recovery pacing and
// power-drop loot disposal (vs thieving-best.ts, which never pickpockets at
// all — it buys cups of tea from the Varrock tea seller and drinks them).
//
// Method:
//   1. Tier ladder by Thieving level — always pickpocket the highest-XP NPC
//      the current level allows (man/woman 8xp -> farmer 14.5xp -> guard
//      46.8xp). Each tier has a known multi-NPC cluster anchor; when the
//      current tier has no visible Pickpocket target we relocate ONCE per
//      unlock instead of wandering every cycle.
//   2. Stun-recovery optimization — a failed pickpocket stuns the player for
//      a fixed number of engine ticks during which every click is discarded.
//      After a stun we wait exactly the tier's stun window (wall-clock at the
//      server tick rate) and then re-click IMMEDIATELY — no fixed sleeps on
//      the success path, so successful chains run back-to-back.
//   3. Power-drop loot — coins stack, but farmers drop seeds and similar
//      non-stackables. When the inventory fills up we drop everything except
//      coins and emergency food, right where we stand. Never a bank trip.
//   4. HP guard — guards retaliate on failure. Eat any carried food below
//      50% HP; below RETREAT_HP with no food, fall back a tier (men/women
//      never fight back) instead of dying.
//
// Optional env: THIEVING_DURATION_MS   (stop cleanly after this long)
//               THIEVING_STUN_SAFETY   (fraction of the stun window waited,
//                                       default 0.9 — slightly early is fine,
//                                       a rejected click costs ~1 RTT)

/** One pickpocketable NPC family: level gate, XP/action, stun length, home cluster. */
type Tier = {
    min: number;
    label: string;
    re: RegExp;
    /** Engine ticks the player stays stunned after a failed attempt. */
    stunTicks: number;
    /** Known multi-NPC cluster, used only when no target is visible nearby. */
    anchor: [number, number];
};

const TIERS: Tier[] = [
    // Varrock north gate / palace guards — the best target reachable without
    // crossing the continent (knights/paladins/heroes live in East Ardougne).
    { min: 40, label: 'guard', re: /^guard$/i, stunTicks: 8, anchor: [3211, 3380] },
    // Farmers around the Lumbridge windmill fields, just north-west of spawn.
    { min: 10, label: 'farmer', re: /^farmer$/i, stunTicks: 6, anchor: [3161, 3295] },
    // Men and women inside Lumbridge castle — the level-1 floor.
    { min: 1, label: 'man-woman', re: /^(man|woman)$/i, stunTicks: 4, anchor: [3222, 3219] },
];

const PICK_RE = /pickpocket/i;
/** Coins stack — everything else picked from NPCs is disposable loot… */
const KEEP_RE = /coins/i;
/** …except emergency food, kept for the HP guard. */
const FOOD_RE = /bread|cake|shrimp|trout|salmon|tuna|lobster|swordfish|cheese|meat|pie|chocolate/i;
/** Drop loot once the inventory is this full — well before it blocks picks. */
const DROP_AT_SLOTS = 24;
/** Below this fraction of max HP with no food, fall back a tier. */
const RETREAT_HP_FRACTION = 0.3;

await runScript(async ({ bot, sdk }) => {
    const DURATION_MS = Number(process.env.THIEVING_DURATION_MS || 0);
    const STUN_SAFETY = Number(process.env.THIEVING_STUN_SAFETY || 0.9);
    const startedAt = Date.now();

    const tracker = new XpRateTracker();
    let attempts = 0;
    let successes = 0;
    let stuns = 0;
    let drops = 0;
    let tierSwitches = 0;

    const xp = () => sdk.getSkill('Thieving')?.experience ?? 0;
    const level = () => sdk.getSkill('Thieving')?.level ?? 1;
    const startXp = xp();

    function tierFor(lvl: number): Tier {
        for (const t of TIERS) if (lvl >= t.min) return t;
        return TIERS[TIERS.length - 1]!;
    }

    function visibleTargets(tier: Tier) {
        return sdk
            .getNearbyNpcs()
            .filter((n) => tier.re.test(n.name))
            .filter((n) => n.optionsWithIndex.some((o) => PICK_RE.test(o.text)))
            .sort((a, b) => a.distance - b.distance);
    }

    async function relocateTo(tier: Tier): Promise<boolean> {
        const [ax, az] = tier.anchor;
        const p = sdk.getState()?.player;
        const dist = p ? Math.hypot(p.worldX - ax, p.worldZ - az) : Infinity;
        if (dist > 25) {
            console.log(`[thieving-v2] relocating to ${tier.label} cluster (${ax},${az})`);
            await bot.walkTo(ax, az, 10).catch(() => {});
            await bot.dismissBlockingUI();
        }
        if (visibleTargets(tier).length > 0) return true;
        // Nudge around the anchor in case the exact tile is blocked.
        for (const [dx, dz] of [[6, 0], [-6, 0], [0, 6], [0, -6], [8, 8]] as const) {
            await bot.walkTo(ax + dx, az + dz, 6).catch(() => {});
            if (visibleTargets(tier).length > 0) return true;
        }
        return false;
    }

    /** Drop non-stackable loot (and never food) once the inventory fills up. */
    function dropLoot() {
        const inv = sdk.getState().inventory;
        if (inv.length < DROP_AT_SLOTS) return;
        const junk = findDropTargets(inv, /.*/, KEEP_RE).filter(
            (i) => !FOOD_RE.test(i.name),
        );
        for (const item of junk) {
            sdk.sendDropItem(item.slot).catch(() => {});
            drops++;
        }
    }

    function eatIfNeeded(): boolean {
        const p = sdk.getState()?.player;
        if (!p || p.maxHp <= 0) return false;
        if (p.hp > p.maxHp * 0.5) return false;
        const food = sdk.findInventoryItem(FOOD_RE);
        if (!food) return false;
        void bot.eatFood(food).catch(() => {});
        return true;
    }

    /**
     * One pickpocket attempt on the nearest live target of the tier.
     * Resolves fast: bot.pickpocketNpc returns as soon as XP lands, a stun
     * message appears, or the op is discarded — the main loop re-chains
     * immediately either way.
     */
    async function attempt(tier: Tier): Promise<'success' | 'stunned' | 'skip'> {
        const targets = visibleTargets(tier);
        if (!targets.length) return 'skip';
        const npc = targets[0]!;
        attempts++;
        const r = await bot.pickpocketNpc(npc);
        if (r.success) {
            successes++;
            tracker.sample(xp());
            return 'success';
        }
        if (r.reason === 'stunned') {
            stuns++;
            // Wait out the stun window (minus a small safety margin), then the
            // very next thing the loop does is re-click — that tight pacing IS
            // the stun-recovery optimization.
            await Bun.sleep(Math.max(1, Math.round(ticksToMs(tier.stunTicks) * STUN_SAFETY)));
            return 'stunned';
        }
        // cant_reach / dispatch_failed / rejected / timeout — cheap skip; the
        // next attempt re-scans and picks whatever is actually reachable.
        return 'skip';
    }

    // Consecutive unusable cycles before we give up on the current tier and
    // fall back (prevents flip-flopping while an NPC wanders out of reach).
    let failStreak = 0;

    console.log(
        `[thieving-v2] start lvl=${level()} xp=${startXp} tier=${tierFor(level()).label}`,
    );

    while (!DURATION_MS || Date.now() - startedAt < DURATION_MS) {
        try {
            await bot.dismissBlockingUI().catch(() => {});

            if (eatIfNeeded()) continue;

            // Hurt with no food: retreat to a tier whose targets don't fight back.
            const p = sdk.getState()?.player;
            let tier = tierFor(level());
            if (
                p &&
                p.maxHp > 0 &&
                p.hp <= p.maxHp * RETREAT_HP_FRACTION &&
                !sdk.findInventoryItem(FOOD_RE) &&
                tier.min > TIERS[TIERS.length - 1]!.min
            ) {
                const fallback = tierFor(Math.max(1, tier.min - 1));
                if (fallback !== tier) {
                    console.log(`[thieving-v2] low HP (${p.hp}/${p.maxHp}), retreating to ${fallback.label}`);
                    tier = fallback;
                    tierSwitches++;
                    failStreak = 0;
                }
            }

            tracker.sample(xp());
            dropLoot();

            let targets = visibleTargets(tier);
            if (!targets.length) {
                if (!(await relocateTo(tier)) && tier.min > TIERS[TIERS.length - 1]!.min) {
                    failStreak++;
                }
                targets = visibleTargets(tier);
                if (!targets.length) {
                    // Anchor failed too — degrade toward the level-1 floor.
                    const fallback = tierFor(Math.max(1, tierFor(level()).min - 1));
                    if (fallback !== tier && failStreak >= 3) {
                        console.log(`[thieving-v2] no ${tier.label} found, falling back to ${fallback.label}`);
                        tier = fallback;
                        tierSwitches++;
                        failStreak = 0;
                        continue;
                    }
                    await sdk.waitForTicks(10).catch(() => {});
                    continue;
                }
            }

            const outcome = await attempt(tier);
            if (outcome === 'success') {
                failStreak = 0;
            } else if (outcome === 'skip' || outcome === 'stunned') {
                failStreak += outcome === 'skip' ? 1 : 0;
            }

            // Progress telemetry every ~30s.
            if ((attempts & 31) === 0 && attempts > 0) {
                console.log(
                    `[thieving-v2] progress attempts=${attempts} ok=${successes} stuns=${stuns} ` +
                        `drops=${drops} xp=${xp() - startXp} peak=${tracker.peakRate().toFixed(0)} ` +
                        `tier=${tier.label} lvl=${level()}`,
                );
            }
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`[thieving-v2] error: ${msg}`);
            await Bun.sleep(500);
            failStreak++;
        }

        // Hard anti-stall: if nothing at all happened for a long stretch,
        // sample + nudge the loop rather than sitting still.
        if (failStreak > 20) {
            console.log('[thieving-v2] long failure streak, sampling state');
            tracker.sample(xp());
            failStreak = 0;
        }
    }

    const summary = {
        event: 'end',
        durationMs: Date.now() - startedAt,
        attempts,
        successes,
        stuns,
        drops,
        tierSwitches,
        thievingXpGained: xp() - startXp,
        finalLevel: level(),
        peakXpPerMin: tracker.peakRate(),
        currentXpPerMin: tracker.currentRate(),
    };
    console.log('[thieving-v2] done', JSON.stringify(summary));
    return summary;
});
