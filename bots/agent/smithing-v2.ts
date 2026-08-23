import { runScript } from '../../sdk/runner';

// smithing-v2 — bank↔furnace smelt loop with bank-aware bar-tier ladder.
//
// Method (vs smithing-best.ts, which hand-mines exactly 13+13 copper/tin and
// smelts ONE inventory of bronze bars once, then exits):
//   1. Continuous loop: withdraw a full load of the best ore the bank holds,
//      smelt it at the Lumbridge furnace, walk back, deposit the bars, repeat.
//   2. Bar-tier ladder by Smithing level AND actual bank stock — always smelt
//      the highest-XP-per-bar tier the current level allows whose ore is
//      present (iron @15 → 12.5 xp/bar; bronze @1 → 6.2 xp/bar). Since smelt
//      time is per-bar, higher XP/bar == higher XP/tick.
//   3. Self-bootstrapping ore supply: a fresh character's bank is empty, so
//      while banked ore is below target the bot powermines copper+tin at the
//      Lumbridge swamp seam and banks it — mining happens in bulk trips, never
//      interleaved with a half-smelted inventory.
//   4. The smelt dialog is resolved dynamically from dialog.allComponents
//      (matched against the bar name) instead of smithing-best's hardcoded
//      component ids, so every tier works with the same code path.
//
// Optional env: SMITHING_DURATION_MS   (stop cleanly after this long),
//               SMITHING_ORE_TARGET    (banked copper+tin pairs to accumulate
//                                       before pure smelting; default 100),
//               SMITHING_MINING        ('0' disables the bootstrap mining).

await runScript(async ({ bot, sdk }) => {
    const DURATION_MS = Number(process.env.SMITHING_DURATION_MS || 0);
    const ORE_TARGET = Number(process.env.SMITHING_ORE_TARGET || 100);
    const MINING_ENABLED = process.env.SMITHING_MINING !== '0';
    const startedAt = Date.now();

    // Lumbridge landmarks (verified by probe-smith.ts scans).
    const BANK_ANCHOR: [number, number] = [3208, 3222]; // Lumbridge castle bank
    const FURNACE_ANCHOR: [number, number] = [3227, 3254]; // Lumbridge furnace
    const MINE_ANCHOR: [number, number] = [3230, 3283]; // swamp seam: copper + tin

    type OreSpec = { re: RegExp; perLoad: number };
    type BarTier = {
        minLevel: number;
        label: string;
        barRe: RegExp;
        xpPerBar: number;
        ores: OreSpec[];
        // Fallback component ids when dialog.allComponents is unavailable.
        fallbackComponents: number[];
    };

    // Descending xp-per-bar. Smelting costs one action per bar regardless of
    // tier, so xp/bar IS the xp/tick ordering.
    const TIERS: BarTier[] = [
        {
            minLevel: 15,
            label: 'iron',
            barRe: /^iron bar$/i,
            xpPerBar: 12.5,
            ores: [{ re: /^iron ore$/i, perLoad: 28 }],
            // Smelt-dialog component for the iron-bar row (bronze verified in
            // -best; iron observed on the same dialog layout).
            fallbackComponents: [2807, 3986],
        },
        {
            minLevel: 1,
            label: 'bronze',
            barRe: /bronze bar/i,
            xpPerBar: 6.2,
            ores: [
                { re: /^copper ore$/i, perLoad: 14 },
                { re: /^tin ore$/i, perLoad: 14 },
            ],
            fallbackComponents: [2807, 3986],
        },
    ];

    const ORE_RE = /\bore\b/i;
    const BAR_RE = /\bbar\b/i;
    const SMELT_RE = /smelt/i;
    const MINE_RE = /^mine$/i;

    const xp = () => sdk.getSkill('Smithing')?.experience ?? 0;
    const level = () => sdk.getSkill('Smithing')?.level ?? 1;
    const invCount = (re: RegExp) =>
        sdk.getInventory().filter((i) => re.test(i.name)).reduce((s, i) => s + i.count, 0);

    async function sleep(ms: number) {
        await new Promise((r) => setTimeout(r, ms));
    }

    function bankCount(re: RegExp): number {
        const st = sdk.getState();
        if (!st?.bank?.isOpen) return 0;
        return st.bank.items
            .filter((i) => re.test(i.name))
            .reduce((s, i) => s + i.count, 0);
    }

    async function openBankNearAnchor(): Promise<boolean> {
        await bot.dismissBlockingUI();
        const st = sdk.getState();
        const p = st?.player;
        if (p) {
            const dist = Math.hypot(p.worldX - BANK_ANCHOR[0], p.worldZ - BANK_ANCHOR[1]);
            if (dist > 12) {
                await bot.walkTo(BANK_ANCHOR[0], BANK_ANCHOR[1], 6).catch(() => {});
                await bot.dismissBlockingUI();
            }
        }
        const r = await bot.openBank().catch(() => null);
        if (r?.success) return true;
        // One retry after a short settle — booths occasionally report
        // cant_reach while the walk is still finishing.
        await sleep(600);
        await bot.dismissBlockingUI();
        const r2 = await bot.openBank().catch(() => null);
        return !!r2?.success;
    }

    // Highest tier the level allows that the bank can actually supply.
    // Requires the bank interface to be open (reads live bank stock).
    function pickTier(lvl: number): BarTier | null {
        for (const t of TIERS) {
            if (lvl < t.minLevel) continue;
            if (t.ores.every((o) => bankCount(o.re) >= 1)) return t;
        }
        return null;
    }

    async function withdrawLoad(tier: BarTier): Promise<boolean> {
        for (const o of tier.ores) {
            const have = invCount(o.re);
            const want = Math.max(0, o.perLoad - have);
            if (want === 0) continue;
            const r = await bot.withdrawItem(o.re, want).catch(() => null);
            if (!r?.success) {
                console.log(`[smithing-v2] withdraw ${o.re} x${want} failed: ${r?.message}`);
                return false;
            }
        }
        return true;
    }

    async function depositBars(): Promise<number> {
        const before = invCount(BAR_RE);
        if (before === 0) return 0;
        const r = await bot.depositItem(BAR_RE, -1).catch(() => null);
        const after = invCount(BAR_RE);
        return Math.max(0, before - after) || (r?.success ? before : 0);
    }

    async function findFurnace() {
        const near = sdk
            .getNearbyLocs()
            .filter((l) => /furnace/i.test(l.name))
            .filter((l) => l.optionsWithIndex.some((o) => SMELT_RE.test(o.text)))
            .sort((a, b) => a.distance - b.distance);
        if (near.length) return near[0]!;
        const scanned = await sdk.scanNearbyLocs().catch(() => []);
        return (
            scanned
                .filter((l) => /furnace/i.test(l.name))
                .filter((l) => l.optionsWithIndex.some((o) => SMELT_RE.test(o.text)))
                .sort((a, b) => a.distance - b.distance)[0] ?? null
        );
    }

    // Smelt the whole carried load: open the smelt dialog, click the tier's
    // bar row (resolved from the live dialog components), then wait until the
    // ore is gone or progress stalls.
    async function smeltLoad(tier: BarTier): Promise<{ smelted: number; xpBefore: number; xpAfter: number }> {
        const xpBefore = xp();
        const oreBefore = invCount(ORE_RE);
        if (oreBefore === 0) return { smelted: 0, xpBefore, xpAfter: xpBefore };

        await bot.dismissBlockingUI();
        const furn = await findFurnace();
        if (!furn) {
            console.log('[smithing-v2] no smeltable furnace in range');
            return { smelted: 0, xpBefore, xpAfter: xpBefore };
        }
        const opt = furn.optionsWithIndex.find((o) => SMELT_RE.test(o.text))!;
        const sent = await sdk.sendInteractLoc(furn.x, furn.z, furn.id, opt.opIndex);
        if (!sent.success) {
            console.log('[smithing-v2] furnace interact failed');
            return { smelted: 0, xpBefore, xpAfter: xpBefore };
        }

        // Wait for the smelt dialog, then resolve the bar component.
        let componentId = -1;
        const dialogDeadline = Date.now() + 8000;
        while (Date.now() < dialogDeadline) {
            await sleep(250);
            const dlg = sdk.getState()?.dialog;
            if (!dlg?.isOpen) continue;
            const match = dlg.allComponents?.find(
                (c) => tier.barRe.test(c.text) && c.buttonType !== 0,
            );
            if (match) {
                componentId = match.id;
                break;
            }
            // Some layouts publish the bar name only in option text.
            const optMatch = dlg.options?.find((o) => tier.barRe.test(o.text) && o.componentId != null);
            if (optMatch) {
                componentId = optMatch.componentId!;
                break;
            }
        }
        if (componentId < 0) {
            for (const c of tier.fallbackComponents) {
                await sdk.sendClickComponent(c);
                await sleep(500);
                const dlg = sdk.getState()?.dialog;
                if (dlg?.isOpen) continue;
                componentId = c;
                break;
            }
        }
        if (componentId < 0) {
            console.log('[smithing-v2] smelt dialog never offered ' + tier.label);
            await sdk.sendCloseModal().catch(() => {});
            return { smelted: 0, xpBefore, xpAfter: xpBefore };
        }
        await sdk.sendClickComponent(componentId);

        // Wait for the load to finish: ore drains to 0 (or stops draining).
        const perBarMs = 1500;
        const deadline = Date.now() + oreBefore * perBarMs + 15000;
        let lastOre = invCount(ORE_RE);
        let lastChange = Date.now();
        while (Date.now() < deadline) {
            await sleep(400);
            if (sdk.getState()?.dialog?.isOpen) await bot.dismissBlockingUI();
            const ore = invCount(ORE_RE);
            if (ore !== lastOre) {
                lastOre = ore;
                lastChange = Date.now();
            }
            if (ore === 0) break;
            if (Date.now() - lastChange > 6000) break; // stalled
        }
        return { smelted: oreBefore - lastOre, xpBefore, xpAfter: xp() };
    }

    // Bootstrap: one powermining trip for a full balanced copper/tin load.
    async function mineTrip(): Promise<boolean> {
        const needCopper = () => invCount(/^copper ore$/i) < 14;
        const needTin = () => invCount(/^tin ore$/i) < 14;
        let guard = 0;
        while ((needCopper() || needTin()) && sdk.getInventory().length < 28 && guard < 60) {
            if (DURATION_MS && Date.now() - startedAt > DURATION_MS) return false;
            await bot.dismissBlockingUI();
            const wantCopper = needCopper() && invCount(/^copper ore$/i) <= invCount(/^tin ore$/i);
            const re = wantCopper || (!needTin() && needCopper()) ? /^copper/i : /^tin/i;
            const st = sdk.getState();
            const p = st?.player;
            if (p && Math.hypot(p.worldX - MINE_ANCHOR[0], p.worldZ - MINE_ANCHOR[1]) > 20) {
                await bot.walkTo(MINE_ANCHOR[0], MINE_ANCHOR[1], 8).catch(() => {});
                await bot.dismissBlockingUI();
            }
            const rocks = sdk
                .getNearbyLocs()
                .filter((l) => re.test(l.name))
                .filter((l) => l.optionsWithIndex.some((o) => MINE_RE.test(o.text)))
                .sort((a, b) => a.distance - b.distance);
            const rock = rocks[0];
            if (!rock) {
                // Widen the net with a scan before giving up on this tick.
                const scanned = await sdk.scanNearbyLocs().catch(() => []);
                const far = scanned
                    .filter((l) => re.test(l.name))
                    .filter((l) => l.optionsWithIndex.some((o) => MINE_RE.test(o.text)))
                    .sort((a, b) => a.distance - b.distance)[0];
                if (!far) {
                    guard++;
                    await sdk.waitForTicks(2).catch(() => {});
                    continue;
                }
                await bot.walkTo(far.x, far.z, 6).catch(() => {});
                continue;
            }
            const mineOpt = rock.optionsWithIndex.find((o) => MINE_RE.test(o.text))!;
            const before = invCount(ORE_RE);
            await sdk.sendInteractLoc(rock.x, rock.z, rock.id, mineOpt.opIndex);
            const end = Date.now() + 4000;
            while (Date.now() < end) {
                await sleep(150);
                if (sdk.getState()?.dialog?.isOpen) await bot.dismissBlockingUI();
                if (invCount(ORE_RE) > before) break;
            }
            guard++;
        }
        return invCount(ORE_RE) > 0;
    }

    const stats = { trips: 0, bars: 0, mineTrips: 0, bankedOre: 0 };
    let lastTierLabel = '';
    while (true) {
        if (DURATION_MS && Date.now() - startedAt > DURATION_MS) break;
        try {
            await bot.dismissBlockingUI();
            if (!(await openBankNearAnchor())) {
                await sdk.waitForTicks(2).catch(() => {});
                continue;
            }

            const lvl = level();
            let tier = pickTier(lvl);

            // Bank can't supply the best tier — bootstrap ore while below target.
            if (!tier && MINING_ENABLED) {
                const pairs = Math.min(bankCount(/^copper ore$/i), bankCount(/^tin ore$/i));
                if (pairs < ORE_TARGET) {
                    await bot.depositItem(ORE_RE, -1).catch(() => {}); // park partials
                    stats.bankedOre = pairs;
                    const got = await mineTrip();
                    if (got) {
                        stats.mineTrips++;
                        // Bank the fresh ore, then loop back around to smelt it.
                        await openBankNearAnchor();
                        await bot.depositItem(ORE_RE, -1).catch(() => {});
                    }
                    continue;
                }
                await sdk.waitForTicks(2).catch(() => {});
                continue;
            }
            if (!tier) {
                await sdk.waitForTicks(5).catch(() => {});
                continue;
            }

            if (tier.label !== lastTierLabel) {
                console.log(`[smithing-v2] lvl=${lvl} smelting ${tier.label} bars`);
                lastTierLabel = tier.label;
            }

            if (!(await withdrawLoad(tier))) {
                await sdk.waitForTicks(1).catch(() => {});
                continue;
            }

            // Walk to the furnace (walking auto-closes the bank interface).
            await bot.walkTo(FURNACE_ANCHOR[0], FURNACE_ANCHOR[1], 3).catch(() => {});
            await bot.dismissBlockingUI();

            const r = await smeltLoad(tier);
            stats.trips++;
            stats.bars += r.smelted;

            // Back to the bank, deposit the bars.
            await openBankNearAnchor();
            const banked = await depositBars();
            if (banked === 0 && r.smelted > 0) {
                console.log('[smithing-v2] warning: bars not deposited, retrying');
                await bot.depositItem(BAR_RE, -1).catch(() => {});
            }

            if (stats.trips % 3 === 0) {
                console.log(
                    `[smithing-v2] ${Math.round((Date.now() - startedAt) / 1000)}s lvl=${lvl} ` +
                        `xp=${xp()} bars=${stats.bars} trips=${stats.trips} mineTrips=${stats.mineTrips}`,
                );
            }
        } catch (e: any) {
            console.error('[smithing-v2] error:', e?.message ?? e);
            await sdk.waitForTicks(2).catch(() => {});
        }
    }
    return {
        smithing: sdk.getSkill('Smithing'),
        stats,
        elapsedMs: Date.now() - startedAt,
    };
});
