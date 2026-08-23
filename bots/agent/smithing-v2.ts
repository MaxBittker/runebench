import { runScript } from '../../sdk/runner';

// smithing-v2 — continuous mine↔furnace smelt loop with a bar-tier ladder.
//
// Method (vs smithing-best.ts, which hand-mines exactly 13+13 copper/tin and
// smelts ONE inventory of bronze bars once, then exits):
//   1. Continuous loop: gather ore, smelt a full load at the Lumbridge
//      furnace, shed bars, repeat until SMITHING_DURATION_MS.
//   2. Bar-tier ladder by Smithing level AND actual stock — always smelt
//      the highest-XP-per-bar tier the current level allows whose ore is
//      carried/banked (iron @15 → 12.5 xp/bar; bronze @1 → 6.2 xp/bar).
//   3. Self-bootstrapping ore supply: powermine copper+tin at the
//      SE Varrock seam and haul loads to the furnace — mining happens in
//      bulk trips, never interleaved with a half-smelted inventory.
//   4. The smelt dialog is resolved dynamically from dialog.allComponents
//      (matched against the bar name) instead of smithing-best's hardcoded
//      component ids, so every tier works with the same code path.
//
// Banking note: this engine has NO bank near the Lumbridge furnace (the
// Lumbridge castle booth does not exist here), so the default loop drops
// smelted bars at the furnace instead of banking them. Set SMITHING_BANK=1
// to restore the withdraw→smelt→deposit bank loop.
//
// Optional env: SMITHING_DURATION_MS   (stop cleanly after this long),
//               SMITHING_ORE_TARGET    (banked copper+tin pairs to accumulate
//                                       before pure smelting; default 100,
//                                       bank mode only),
//               SMITHING_MINING        ('0' disables the bootstrap mining),
//               SMITHING_BANK          ('1' enables the bank loop),
//               SMITHING_MINE_X/Z      (mining anchor, default SE Varrock).

await runScript(async ({ bot, sdk }) => {
    const DURATION_MS = Number(process.env.SMITHING_DURATION_MS || 0);
    const ORE_TARGET = Number(process.env.SMITHING_ORE_TARGET || 100);
    const MINING_ENABLED = process.env.SMITHING_MINING !== '0';
    // Banking is opt-in: this engine has no bank anywhere near the Lumbridge
    // furnace (the castle booth the original anchors pointed at does not
    // exist), so by default the loop drops smelted bars instead of banking.
    const BANKING_ENABLED = process.env.SMITHING_BANK === '1';
    const startedAt = Date.now();

    // Lumbridge/Varrock landmarks (verified by probe-smith.ts scans AND live
    // probes on the local bench world 2026-08-23).
    const BANK_ANCHOR: [number, number] = [3208, 3222]; // Lumbridge castle — NOTE: no banker/booth exists here in this engine (bankers are only in Al Kharid/Varrock/Draynor/etc.), so banking is opt-in via SMITHING_BANK=1 and the loop drops bars by default.
    const FURNACE_ANCHOR: [number, number] = [3225, 3256]; // Lumbridge furnace (id 2781 has Smelt; 2785 is an inert decoy)
    const MINE_ANCHOR: [number, number] = [
        Number(process.env.SMITHING_MINE_X || 3285),
        Number(process.env.SMITHING_MINE_Z || 3365),
    ]; // SE Varrock mine: copper + tin (the Lumbridge Swamp seam does not exist in this engine and its rocks ignore mine interactions)

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
            barRe: /iron/i,
            xpPerBar: 12.5,
            ores: [{ re: /^iron ore$/i, perLoad: 28 }],
            // Live smelt-dialog rows carry only the metal name in their text
            // (e.g. "\n\n\n\nBronze"), so match on the metal, not "bar".
            fallbackComponents: [],
        },
        {
            minLevel: 1,
            label: 'bronze',
            barRe: /bronze/i,
            xpPerBar: 6.2,
            ores: [
                { re: /^copper ore$/i, perLoad: 14 },
                { re: /^tin ore$/i, perLoad: 14 },
            ],
            // Verified live on the bench world: the bronze row is component 3987.
            fallbackComponents: [3987],
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
        while ((needCopper() || needTin()) && sdk.getInventory().length < 28 && guard < 150) {
            if (DURATION_MS && Date.now() - startedAt > DURATION_MS) return false;
            await bot.dismissBlockingUI();
            // Rebalance a jammed inventory: if every slot is ore but the
            // copper/tin mix is lopsided, drop the surplus of the majority
            // type so mining the missing half can resume.
            const cop = invCount(/^copper ore$/i);
            const tin = invCount(/^tin ore$/i);
            if (sdk.getInventory().length >= 28 && cop !== tin && (needCopper() || needTin())) {
                const surplusRe = cop > tin ? /^copper ore$/i : /^tin ore$/i;
                const keep = Math.min(cop, tin);
                for (const it of sdk.getInventory()) {
                    if (!surplusRe.test(it.name)) continue;
                    if (invCount(surplusRe) <= keep) break;
                    await sdk.sendDropItem(it.slot).catch(() => {});
                    await sleep(120);
                }
                continue;
            }
            const wantCopper = needCopper() && invCount(/^copper ore$/i) <= invCount(/^tin ore$/i);
            // Loc names are e.g. "Rocks copper ore" — never anchor to ^.
            const re = wantCopper || (!needTin() && needCopper()) ? /copper/i : /tin/i;
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

    // Highest tier the level allows that the CURRENT INVENTORY can supply
    // (used by the default drop-mode loop, where nothing is ever banked).
    function pickInvTier(lvl: number): BarTier | null {
        for (const t of TIERS) {
            if (lvl < t.minLevel) continue;
            if (t.ores.every((o) => invCount(o.re) >= 1)) return t;
        }
        return null;
    }

    async function dropBars(): Promise<number> {
        let dropped = 0;
        for (const it of sdk.getInventory()) {
            if (!BAR_RE.test(it.name)) continue;
            await sdk.sendDropItem(it.slot).catch(() => {});
            dropped += it.count;
            await sleep(120);
        }
        return dropped;
    }

    // One-shot: clear tutorial-junk so powermined ore can use all 28 slots.
    // Keep the pickaxe (mining), coins, and anything edible.
    let junkDropped = false;
    async function dropJunkOnce(): Promise<void> {
        if (junkDropped) return;
        junkDropped = true;
        for (const it of sdk.getInventory()) {
            if (/pickaxe|coin|ore|bar/i.test(it.name)) continue;
            await sdk.sendDropItem(it.slot).catch(() => {});
            await sleep(120);
        }
    }

    while (true) {
        if (DURATION_MS && Date.now() - startedAt > DURATION_MS) break;
        try {
            await bot.dismissBlockingUI();

            if (BANKING_ENABLED) {
                if (!(await openBankNearAnchor())) {
                    await sdk.waitForTicks(2).catch(() => {});
                    continue;
                }
            }

            const lvl = level();
            let tier = BANKING_ENABLED ? pickTier(lvl) : pickInvTier(lvl);

            // No smeltable ore available — bootstrap it with powermining.
            if (!tier && MINING_ENABLED) {
                if (BANKING_ENABLED) {
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
                // Drop mode: fill the inventory with a balanced copper/tin load.
                await dropJunkOnce();
                const got = await mineTrip();
                if (got) stats.mineTrips++;
                continue;
            }
            // Drop mode must only walk to the furnace with a COMPLETE load:
            // the mine↔furnace haul is ~2min each way, so smelting a partial
            // load (2 bars) wastes the entire round trip. Keep mining instead.
            if (!BANKING_ENABLED && MINING_ENABLED &&
                (!tier || !tier.ores.every((o) => invCount(o.re) >= o.perLoad))) {
                await dropJunkOnce();
                const got = await mineTrip();
                if (got) stats.mineTrips++;
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

            if (BANKING_ENABLED) {
                if (!(await withdrawLoad(tier))) {
                    await sdk.waitForTicks(1).catch(() => {});
                    continue;
                }
            }

            // Walk to the furnace (walking auto-closes the bank interface).
            await bot.walkTo(FURNACE_ANCHOR[0], FURNACE_ANCHOR[1], 3).catch(() => {});
            await bot.dismissBlockingUI();

            const r = await smeltLoad(tier);
            stats.trips++;
            stats.bars += r.smelted;

            if (BANKING_ENABLED) {
                // Back to the bank, deposit the bars.
                await openBankNearAnchor();
                const banked = await depositBars();
                if (banked === 0 && r.smelted > 0) {
                    console.log('[smithing-v2] warning: bars not deposited, retrying');
                    await bot.depositItem(BAR_RE, -1).catch(() => {});
                }
            } else {
                // Drop mode: shed the bars at the furnace and head straight
                // back to the mine on the next iteration.
                const dropped = await dropBars();
                if (r.smelted > 0 && dropped === 0) {
                    console.log('[smithing-v2] warning: failed to drop smelted bars');
                }
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
