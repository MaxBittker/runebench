import { runScript } from '../../sdk/runner';

// crafting-v2 validation run: fund toll → gather hides at Lumbridge cows →
// cross back → tan at Ellis → needle-craft gloves → report honest XP/min.
await runScript(async ({ bot, sdk }) => {
    const T0 = Date.now();
    const t = () => ((Date.now() - T0) / 1000).toFixed(0);
    const log = (...a: any[]) => console.log(`[crun ${t()}s]`, ...a);
    const st = () => sdk.getState();
    const xp = () => sdk.getSkillXp('Crafting') ?? 0;
    const hides = () => sdk.countInventoryItems(/cow.?hide/i);
    const coins = () => sdk.findInventoryItem(/coin/i)?.count ?? 0;
    const waitCombatEnd = async () => {
        for (let i = 0; i < 30; i++) {
            await sdk.waitForTicks(1);
            if (st()?.dialog?.isOpen) await bot.dismissBlockingUI();
            const s = st();
            if (!s?.inCombat && s?.player.targetIndex < 0 && i > 1) break;
        }
    };
    const crossGate = async () => {
        // east = into Al Kharid; west = back out.
        // Server script: pay toll → forcemove onto gate tile → TELEPORT through.
        // CRITICAL: after clicking "Yes, ok." do NOT send any further actions —
        // a new action cancels the forcemove and the 10gp is wasted.
        const goingEast = (st()?.player?.worldX ?? 0) < 3268;
        const startX = goingEast ? 3263 : 3272;
        const targetX = goingEast ? 3274 : 3256;
        await bot.walkTo(startX, 3227, 4).catch(() => {});
        let paidThisAttempt = false;
        let idleTicks = 0;
        for (let i = 0; i < 60 && Math.abs((st()?.player?.worldX ?? 0) - targetX) > 5; i++) {
            await dismiss();
            const d = st()?.dialog;
            if (d?.isOpen) {
                const opts = d.options ?? [];
                const yes = opts.find((o: any) => /^yes,\s*ok/i.test(o.text));
                if (yes && !paidThisAttempt) {
                    await sdk.clickDialogByText(/^yes,\s*ok/i).catch(() => sdk.sendClickDialog(yes.index));
                    paidThisAttempt = true;           // now wait silently for teleport
                } else {
                    await sdk.sendClickDialog(0);      // narration/choice page → advance
                }
                idleTicks = 0;
                await sdk.waitForTicks(3);
                continue;
            }
            if (!paidThisAttempt && idleTicks > 8) {
                // no dialog appearing — re-poke the guard once per quiet window
                const guard = st()?.nearbyNpcs?.find((n: any) => /border guard/i.test(n.name));
                if (guard) { try { await bot.talkTo(guard.name); } catch { /* */ } }
                else { try { await bot.openDoor(); } catch { /* */ } }
                idleTicks = 0;
            }
            idleTicks++;
            await sdk.waitForTicks(1);
        }
        await dismiss();
    };
    const dismiss = async () => { if (st()?.dialog?.isOpen) await bot.dismissBlockingUI(); };

    // ── 1) fund: sell junk to the Al Kharid general store ──
    if (coins() < 100) {
        log('selling junk for coins');
        try {
            await bot.openShop(/shopkeeper|store/i);
            for (const [re, n] of [[/copper ore/i, 99], [/bones/i, 99], [/raw beef/i, 99]] as [RegExp, number][]) {
                if (sdk.findInventoryItem(re)) { try { await bot.sellToShop(re, n); } catch { /* */ } }
            }
            await bot.closeShop().catch(() => {});
        } catch (e: any) { log('sell err', e?.message); }
        log('coins after selling:', coins());
    }

    // ── 2) gather hides at Lumbridge cow field (free side) ──
    if ((st()?.player?.worldX ?? 0) > 3268 && coins() >= 10) await crossGate();
    await bot.walkTo(3249, 3268, 6);
    const gatherEnd = Date.now() + 240_000;
    while (Date.now() < gatherEnd && (hides() < 15 || coins() < 40)) {
        await dismiss();
        const gi = sdk.findGroundItem(/cow.?hide|coin/i);
        if (gi) { try { await bot.pickupItem(gi); } catch { /* */ } await sdk.waitForTicks(1); continue; }
        if (coins() < 30) {
            const m = st()?.nearbyNpcs?.find((n: any) => /goblin|man/i.test(n.name) && !n.inCombat);
            if (m) { try { await bot.attack(m.name); } catch { /* */ } await waitCombatEnd(); continue; }
        }
        const cow = st()?.nearbyNpcs?.find((n: any) => /^cow\b/i.test(n.name) && !n.inCombat);
        if (cow) { try { await bot.attack(cow.name); } catch { /* */ } await waitCombatEnd(); continue; }
        await sdk.waitForTicks(2);
    }
    log(`gathered: ${hides()} hides, ${coins()} coins`);

    // ── 3) cross back to Al Kharid, tan ALL at Ellis ──
    await crossGate();
    const xpBeforeTan = xp();
    const tanStart = Date.now();
    await bot.walkTo(3276, 3193, 3);
    const ellis = st()?.nearbyNpcs?.find((n: any) => /tanner|ellis/i.test(n.name));
    if (!ellis) { log('NO ELLIS'); return 'no-ellis'; }
    try { await bot.talkTo(ellis.name); } catch { /* */ }
    let iface: any = null;
    for (let i = 0; i < 30 && !iface; i++) {
        if (st()?.interface?.isOpen) { iface = st()!.interface; break; }
        const d = st()?.dialog;
        if (d?.isOpen && d.options?.length) {
            const yes = d.options.find((o: any) => /yes/i.test(o.text)) ?? d.options[0];
            await sdk.sendClickDialog(yes.index);
        }
        await sdk.waitForTicks(2);
    }
    if (!iface) { log('no tan iface'); return 'no-tan-iface'; }
    const hides0 = hides();
    const all = iface.options.find((o: any) => /\ball\b/i.test(o.text)) ?? iface.options.find((o: any) => /soft/i.test(o.text)) ?? iface.options[0];
    await sdk.sendClickComponent(all.componentId);
    for (let i = 0; i < 20 && hides() >= hides0; i++) { await sdk.waitForTicks(1); await dismiss(); }
    const leather = sdk.countInventoryItems(/^leather$/i);
    log(`tanned ${leather} leather (${Date.now() - tanStart}ms)`);

    // ── 4) craft gloves — timed XP window ──
    const needle = sdk.findInventoryItem(/needle/i);
    if (!needle) { log('no needle'); return 'no-needle'; }
    const craftStart = Date.now();
    const xpStartCraft = xp();
    while (sdk.findInventoryItem(/^leather$/i)) {
        const lth = sdk.findInventoryItem(/^leather$/i)!;
        await sdk.sendUseItemOnItem(needle.slot, lth.slot);
        let cif: any = null;
        for (let i = 0; i < 20 && !cif; i++) {
            await sdk.waitForTicks(1);
            if (st()?.interface?.isOpen) cif = st()!.interface;
        }
        if (!cif) { log('no craft iface'); break; }
        const pick = cif.options.find((o: any) => /gloves/i.test(o.text)) ?? cif.options[0];
        await sdk.sendClickComponent(pick.componentId);
        for (let i = 0; i < 60; i++) {
            await sdk.waitForTicks(1);
            await dismiss();
            if (!sdk.findInventoryItem(/^leather$/i)) break;
        }
    }
    const craftMs = Date.now() - craftStart;
    const gained = xp() - xpStartCraft;
    const mins = Math.max(craftMs / 60000, 1 / 600);
    log(`CRAFT: +${gained} xp in ${(craftMs / 1000).toFixed(0)}s → ${(gained / mins).toFixed(1)} xp/min`);
    log(`TOTAL incl tan: +${xp() - xpBeforeTan} xp in ${((Date.now() - tanStart) / 1000).toFixed(0)}s`);
    return { hidesGathered: hides0, leather, craftingXp: gained };
}, { timeout: 15 * 60_000 });
