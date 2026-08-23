import { runScript } from '../../sdk/runner';

// mining-v2 — best-rock-by-XP/time powerminer with adjacent-rock chaining.
//
// Method (vs mining-best.ts, which mines only copper|tin at one fixed tile,
// drops after EVERY ore, and re-walks to a hardcoded coordinate):
//   1. Tier ladder by Mining level — always target the highest-XP-per-hit
//      rock the current level allows (copper/tin/clay -> iron -> coal ->
//      mithril -> adamant -> runite). Relocate once per tier unlock to a
//      known cluster instead of every cycle.
//   2. Adjacent-rock chaining: only ever click rocks whose options still
//      contain "Mine" (depleted rocks drop the option until respawn), so
//      respawn waiting happens implicitly — the moment a rock depletes we
//      re-target the NEAREST active rock, which is usually its neighbour.
//   3. Powermine: drop ores ONLY when the inventory is actually full;
//      never interrupt an ore mid-cycle for disposal.
//
// Optional env: MINING_DURATION_MS (stop cleanly after this long),
//               MINING_RELOCATE_TILES (default 25 — max walk distance for a
//               tier relocation; below it we just fall back a tier).

await runScript(async ({ bot, sdk }) => {
    const DURATION_MS = Number(process.env.MINING_DURATION_MS || 0);
    const RELOCATE_TILES = Number(process.env.MINING_RELOCATE_TILES || 25);
    const startedAt = Date.now();

    type Tier = { min: number; label: string; re: RegExp; anchor?: [number, number] };
    // All tiers share ONE safe anchor: the Varrock East mine (copper/tin/iron
    // seam, no aggressive NPCs between Lumbridge and the pit). Higher-tier
    // rocks simply aren't here — when they unlock, pickWorkingTier keeps
    // mining the best rock that actually exists nearby instead of walking
    // into hostile territory (an early v2 anchor at Al Kharid got the bot
    // killed by Border Guards).
    const MINE_ANCHOR: [number, number] = [3286, 3365];
    const TIERS: Tier[] = [
        { min: 85, label: 'runite', re: /runite/i, anchor: MINE_ANCHOR },
        { min: 70, label: 'adamant', re: /adamant/i, anchor: MINE_ANCHOR },
        { min: 55, label: 'mithril', re: /mithril/i, anchor: MINE_ANCHOR },
        { min: 30, label: 'coal', re: /coal/i, anchor: MINE_ANCHOR },
        { min: 15, label: 'iron', re: /\biron\b/i, anchor: MINE_ANCHOR },
        { min: 1, label: 'copper-tin', re: /(copper|tin|clay)/i, anchor: MINE_ANCHOR },
    ];

    const ORE_RE = /\bore\b|\bclay\b/i;
    const PICKAXE_RE = /pickaxe/i;
    const MINE_RE = /mine/i;

    const xp = () => sdk.getSkill('Mining')?.experience ?? 0;
    const invCount = () => sdk.getInventory().length;

    function tierFor(level: number): Tier {
        for (const t of TIERS) if (level >= t.min) return t;
        return TIERS[TIERS.length - 1]!;
    }

    function activeRocks(tier: Tier) {
        return sdk
            .getNearbyLocs()
            .filter((l) => tier.re.test(l.name))
            .filter((l) => l.optionsWithIndex.some((o) => MINE_RE.test(o.text)))
            .sort((a, b) => a.distance - b.distance);
    }

    async function scanRocks(tier: Tier) {
        const scanned = await sdk.scanNearbyLocs().catch(() => [] as Awaited<ReturnType<typeof sdk.getNearbyLocs>>);
        return scanned
            .filter((l) => tier.re.test(l.name))
            .filter((l) => l.optionsWithIndex.some((o) => MINE_RE.test(o.text)))
            .sort((a, b) => a.distance - b.distance);
    }

    async function relocateTo(tier: Tier): Promise<boolean> {
        if (!tier.anchor) return false;
        const [ax, az] = tier.anchor;
        const p = sdk.getState()?.player;
        const dist = p ? Math.hypot(p.worldX - ax, p.worldZ - az) : Infinity;
        if (dist > RELOCATE_TILES) {
            console.log(`[mining-v2] relocating to ${tier.label} cluster (${ax},${az})`);
            await bot.walkTo(ax, az, 10).catch(() => {});
            await bot.dismissBlockingUI();
        }
        let rocks = await scanRocks(tier);
        if (rocks.length > 0) return true;
        // Nudge around the anchor in case the exact tile is blocked.
        for (const [dx, dz] of [[8, 0], [-8, 0], [0, 8], [0, -8], [12, 12]] as const) {
            await bot.walkTo(ax + dx, az + dz, 8).catch(() => {});
            rocks = await scanRocks(tier);
            if (rocks.length > 0) return true;
        }
        return false;
    }

    function dropOres() {
        const inv = sdk.getState().inventory;
        for (const item of inv) {
            if (ORE_RE.test(item.name) && !PICKAXE_RE.test(item.name)) {
                sdk.sendDropItem(item.slot).catch(() => {});
            }
        }
    }

    // One mining attempt on the nearest active rock of the tier. Returns as
    // soon as an ore lands (inventory grows), the rock visibly depletes, or
    // the budget expires — the main loop immediately re-chains either way.
    async function chainCycle(tier: Tier, maxMs: number) {
        await bot.dismissBlockingUI();
        if (invCount() >= 28) return { success: false as const, reason: 'inventory-full' };
        const rocks = [...activeRocks(tier)];
        if (!rocks.length) return { success: false as const, reason: 'no-rock' };
        const rock = rocks[0]!;
        const opt = rock.optionsWithIndex.find((o) => MINE_RE.test(o.text))?.opIndex ?? 1;
        const sent = await sdk.sendInteractLoc(rock.x, rock.z, rock.id, opt);
        if (!sent.success) return { success: false as const, reason: 'interact-failed' };

        const start = Date.now();
        let lastInv = invCount();
        let idleMs = 0;
        while (Date.now() - start < maxMs) {
            await sdk.waitForTicks(1).catch(() => {});
            if (sdk.getState()?.dialog?.isOpen) await bot.dismissBlockingUI();
            const inv = invCount();
            if (inv >= 28) return { success: false as const, reason: 'inventory-full' };
            if (inv > lastInv) {
                // Ore landed — chain onward right away.
                lastInv = inv;
                return { success: true as const, reason: 'ore-gained' };
            }
            idleMs += 50;
            // Rock depleted under us (Mine option gone) or nothing happened:
            // re-click occasionally so a silent stop doesn't waste the budget.
            if (idleMs >= 1500) {
                const again = activeRocks(tier)[0];
                if (!again) return { success: true as const, reason: 'rock-depleted' };
                if (again.x !== rock.x || again.z !== rock.z) {
                    return { success: true as const, reason: 'chain-next' };
                }
                await sdk.sendInteractLoc(rock.x, rock.z, rock.id, opt);
                idleMs = 0;
            }
        }
        return { success: true as const, reason: 'cycle-timeout' };
    }

    // ── main loop ──────────────────────────────────────────────────────────
    // Respawn-aware tier selection: prefer the highest eligible tier that has
    // an ACTIVE rock right now; if the whole preferred tier is depleted, fall
    // back down the ladder (copper/tin next to a depleted iron seam beats
    // idling) and let the higher tier respawn in the background.
    async function pickWorkingTier(level: number): Promise<Tier | null> {
        const startIdx = TIERS.indexOf(tierFor(level));
        for (let i = startIdx; i < TIERS.length; i++) {
            const t = TIERS[i]!;
            const rocks = await scanRocks(t);
            if (rocks.length > 0) return t;
        }
        return null;
    }

    const stats = { cycles: 0, ores: 0, inventories: 0, relocates: 0 };
    let currentTierMin = -1;
    let lastRelocateMs = -Infinity;
    while (true) {
        if (DURATION_MS && Date.now() - startedAt > DURATION_MS) break;
        try {
            await bot.dismissBlockingUI();
            const level = sdk.getSkill('Mining')?.level ?? 1;
            let tier = await pickWorkingTier(level);
            if (!tier) {
                // Everything in scan range depleted — widen the net by
                // relocating toward the current tier's known cluster at most
                // every 20s; otherwise idle a couple of ticks for respawn.
                if (Date.now() - lastRelocateMs > 20000) {
                    lastRelocateMs = Date.now();
                    const want = tierFor(level);
                    console.log(`[mining-v2] all rocks depleted — relocating to ${want.label}`);
                    stats.relocates++;
                    if (!(await relocateTo(want))) tier = await pickWorkingTier(level);
                    else tier = want;
                }
                if (!tier || !(await scanRocks(tier)).length) {
                    await sdk.waitForTicks(2).catch(() => {});
                    continue;
                }
            }
            if (tier.min !== currentTierMin) {
                console.log(`[mining-v2] level=${level} targeting ${tier.label}`);
                currentTierMin = tier.min;
            }
            const r = await chainCycle(tier, 4000);
            stats.cycles++;
            if (r.reason === 'ore-gained') stats.ores++;
            if (r.reason === 'inventory-full') {
                stats.inventories++;
                dropOres();
                await sdk.waitForTicks(1).catch(() => {});
            } else if (r.reason === 'no-rock' || r.reason === 'interact-failed') {
                // Brief pause so a transient miss can't become a hot spin.
                await sdk.waitForTicks(1).catch(() => {});
            }
        } catch (e: any) {
            console.error('[mining-v2] error:', e?.message ?? e);
            await sdk.waitForTicks(1).catch(() => {});
        }
        if (stats.cycles % 20 === 0) {
            console.log(
                `[mining-v2] ${(Math.round((Date.now() - startedAt) / 1000))}s lvl=${sdk.getSkill('Mining')?.level} ` +
                    `xp=${xp()} inv=${invCount()} ores=${stats.ores} cycles=${stats.cycles}`,
            );
        }
    }
    return { mining: sdk.getSkill('Mining'), stats, elapsedMs: Date.now() - startedAt };
});
