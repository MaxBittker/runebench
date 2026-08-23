import { runScript } from '../../sdk/runner';

// woodcutting-v2 — highest-tier-first, minimal-movement chopper.
//
// Method (vs woodcutting-best.ts, which always chopped /^tree$/i and dropped
// after every single log):
//   1. Always chop the HIGHEST-tier tree the current level allows
//      (normal -> oak -> willow -> maple -> yew -> magic), relocating once per
//      tier unlock instead of per tree.
//   2. Minimal tile movement between trees: always re-target the NEAREST
//      available tree of the active tier; never walk on failure unless the
//      whole tier is out of reach (then fall back one tier down).
//   3. Dispose only when the inventory is FULL: use the nearest bank when one
//      is close (< BANK_WALK_TILES tiles), otherwise quick-drop the logs —
//      either way chopping is never interrupted mid-inventory.
//
// Optional env: WC_DURATION_MS (stop cleanly after this long),
//               WC_BANK_WALK_TILES (default 25).

await runScript(async ({ bot, sdk }) => {
    const DURATION_MS = Number(process.env.WC_DURATION_MS || 0);
    const BANK_WALK_TILES = Number(process.env.WC_BANK_WALK_TILES || 25);
    const startedAt = Date.now();

    type Tier = { min: number; label: string; re: RegExp; anchor?: [number, number] };
    // Anchors are well-known clusters from the world wiki/learnings; they are
    // only used when the tier is not visible in any nearby scan.
    const TIERS: Tier[] = [
        { min: 75, label: 'magic', re: /^magic/i, anchor: [2700, 3395] },
        { min: 60, label: 'yew', re: /^(yew|yew tree)$/i, anchor: [2715, 3460] },
        { min: 45, label: 'maple', re: /^(maple|maple tree)$/i, anchor: [2715, 3500] },
        { min: 30, label: 'willow', re: /^(willow|willow tree)$/i, anchor: [3087, 3235] },
        { min: 15, label: 'oak', re: /^(oak|oak tree)$/i, anchor: [3190, 3255] },
        { min: 1, label: 'tree', re: /^tree$/i, anchor: [3195, 3220] },
    ];

    const LOG_RE = /logs?$/i;
    const CHOP_RE = /chop/i;

    const wcXp = () => sdk.getSkill('Woodcutting')?.experience ?? 0;
    const invCount = () => sdk.getInventory().length;

    function tierFor(level: number): Tier {
        for (const t of TIERS) if (level >= t.min) return t;
        return TIERS[TIERS.length - 1]!;
    }

    function visibleTrees(tier: Tier) {
        return sdk
            .getNearbyLocs()
            .filter((l) => tier.re.test(l.name))
            .filter((l) => l.optionsWithIndex.some((o) => CHOP_RE.test(o.text)))
            .sort((a, b) => a.distance - b.distance);
    }

    async function scanTrees(tier: Tier) {
        const scanned = await sdk.scanNearbyLocs().catch(() => []);
        return scanned
            .filter((l) => tier.re.test(l.name))
            .filter((l) => l.optionsWithIndex.some((o) => CHOP_RE.test(o.text)))
            .sort((a, b) => a.distance - b.distance);
    }

    async function ensureAtTier(tier: Tier): Promise<boolean> {
        let trees = await scanTrees(tier);
        if (trees.length > 0) return true;
        // Relocate once to the tier's known cluster, scanning en route.
        if (tier.anchor) {
            const [ax, az] = tier.anchor;
            const p = sdk.getState()?.player;
            const dist = p ? Math.hypot(p.worldX - ax, p.worldZ - az) : Infinity;
            if (dist > 20) {
                console.log(`[wc-v2] relocating to ${tier.label} cluster (${ax},${az})`);
                await bot.walkTo(ax, az, 10).catch(() => {});
                await bot.dismissBlockingUI();
            }
            trees = await scanTrees(tier);
            if (trees.length > 0) return true;
            // Nudge around the anchor in case the exact tile is blocked.
            for (const [dx, dz] of [[8, 0], [-8, 0], [0, 8], [0, -8], [12, 12]] as const) {
                await bot.walkTo(ax + dx, az + dz, 8).catch(() => {});
                trees = await scanTrees(tier);
                if (trees.length > 0) return true;
            }
        }
        return false;
    }

    async function disposeLogs(): Promise<'bank' | 'drop'> {
        const logs = sdk.getInventory().filter((i) => LOG_RE.test(i.name));
        if (!logs.length) return 'drop';
        // Bank only when full AND a booth/banker is genuinely close; otherwise
        // dropping is strictly faster (zero tile movement, no interface ticks).
        const banks = sdk
            .getNearbyLocs()
            .filter((l) => /bank/i.test(l.name))
            .concat(await sdk.scanNearbyLocs().catch(() => []).then((ls) => ls.filter((l) => /bank/i.test(l.name))))
            .sort((a, b) => a.distance - b.distance);
        const nearestBank = banks[0];
        if (nearestBank && nearestBank.distance <= BANK_WALK_TILES) {
            try {
                const opened = await bot.openBank();
                if (opened.success) {
                    for (const _ of logs) {
                        await bot.depositItem(LOG_RE, -1);
                        if (!sdk.getInventory().some((i) => LOG_RE.test(i.name))) break;
                    }
                    await bot.closeBank();
                    return 'bank';
                }
            } catch {
                /* fall through to drop */
            }
        }
        for (const item of logs) {
            await sdk.sendDropItem(item.slot);
            await sdk.waitForTicks(1).catch(() => {});
        }
        return 'drop';
    }

    async function chopCycle(tier: Tier, maxMs: number) {
        await bot.dismissBlockingUI();
        const beforeXp = wcXp();
        const beforeInv = invCount();
        const trees = await scanTrees(tier);
        if (!trees.length) return { success: false as const, reason: 'no-tree' };
        const tree = trees[0]!;
        const opt = tree.optionsWithIndex.find((o) => CHOP_RE.test(o.text))?.opIndex ?? 1;
        const sent = await sdk.sendInteractLoc(tree.x, tree.z, tree.id, opt);
        if (!sent.success) return { success: false as const, reason: 'interact-failed' };
        const start = Date.now();
        let lastLogCount = beforeInv;
        let idleMs = 0;
        while (Date.now() - start < maxMs) {
            await sdk.waitForStateChange(1200).catch(() => {});
            const dialog = sdk.getState()?.dialog;
            if (dialog?.isOpen) await bot.dismissBlockingUI();
            const inv = invCount();
            if (inv >= 28) return { success: true as const, reason: 'inventory-full', xpGained: wcXp() - beforeXp };
            if (inv > lastLogCount) {
                // Log gained — immediately re-click the same tree spot if still
                // standing (keeps us locked on one tile, zero movement).
                lastLogCount = inv;
                idleMs = 0;
                const stillThere = visibleTrees(tier).some((l) => l.x === tree.x && l.z === tree.z);
                if (!stillThere) {
                    return { success: true as const, reason: 'tree-felled', xpGained: wcXp() - beforeXp };
                }
            } else {
                idleMs += 1200;
            }
            if (idleMs >= 6000) {
                // No log for a while — re-click in case the chop silently stopped.
                const again = await sdk.sendInteractLoc(tree.x, tree.z, tree.id, opt);
                if (!again.success) return { success: false as const, reason: 'reclick-failed' };
                idleMs = 0;
            }
        }
        return { success: true as const, reason: 'cycle-timeout', xpGained: wcXp() - beforeXp };
    }

    // ── main loop ──────────────────────────────────────────────────────────
    const stats = { cycles: 0, felled: 0, inventories: 0, banks: 0 };
    let currentTierMin = -1;
    while (true) {
        if (DURATION_MS && Date.now() - startedAt > DURATION_MS) break;
        try {
            const level = sdk.getSkill('Woodcutting')?.level ?? 1;
            const tier = tierFor(level);
            if (tier.min !== currentTierMin) {
                console.log(`[wc-v2] level=${level} targeting ${tier.label}`);
                currentTierMin = tier.min;
            }
            if (!(await ensureAtTier(tier))) {
                // Whole tier unreachable — fall back one tier down.
                const idx = TIERS.indexOf(tier);
                const fallback = TIERS[Math.min(idx + 1, TIERS.length - 1)]!;
                if (fallback !== tier && !(await ensureAtTier(fallback))) {
                    await sdk.waitForTicks(2);
                    continue;
                }
            }
            const r = await chopCycle(tier, 45000);
            stats.cycles++;
            if (r.reason === 'tree-felled') stats.felled++;
            if (r.reason === 'inventory-full') {
                stats.inventories++;
                const how = await disposeLogs();
                if (how === 'bank') stats.banks++;
            }
        } catch (e: any) {
            console.error('[wc-v2] error:', e?.message ?? e);
            await sdk.waitForTicks(1).catch(() => {});
        }
        if (stats.cycles % 10 === 0) {
            console.log(
                `[wc-v2] ${(Math.round((Date.now() - startedAt) / 1000))}s lvl=${sdk.getSkill('Woodcutting')?.level} ` +
                    `xp=${wcXp()} inv=${invCount()} cycles=${stats.cycles}`,
            );
        }
    }
    return { wc: sdk.getSkill('Woodcutting'), stats, elapsedMs: Date.now() - startedAt };
});
