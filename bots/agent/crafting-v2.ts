import { runScript } from '../../sdk/runner';

/**
 * crafting-v2 — tan-and-craft loop at Al Kharid:
 *   bank (coins + cowhide) → Ellis tanner (tan ALL soft leather) →
 *   needle-on-leather → Leather Gloves → bank products → repeat.
 *
 * Engine facts this method exploits (server/content/scripts/skill_crafting/):
 *  - Ellis the Tanner (npc 804) at (3277,3193): Trade → dialog → tan interface;
 *    "Tan all Soft Leathers" converts every cowhide for a small gp fee in one
 *    click — no per-hide interaction, so tanning is effectively free time.
 *  - Crafting XP comes ONLY from needle-on-leather (Leather Gloves = 13.8 XP,
 *    level 1). One craft action consumes one leather + one thread charge and
 *    crafts the whole inventory batch, state-poll paced like cooking-v2.
 *  - Needle/thread from Dommik's shop (3322,3194), 1 gp each; auto-restock if
 *    missing from inventory/bank.
 *
 * Env knobs: CRAFT_DURATION_MS (stop cleanly after this long),
 *            CR_BANK_ANCHOR_X/Z (bank walk anchor, default Al Kharid bank).
 */

await runScript(async ({ bot, sdk }) => {
    const DURATION_MS = Number(process.env.CRAFT_DURATION_MS || 0);
    const startedAt = Date.now();
    const t = () => ((Date.now() - startedAt) / 1000).toFixed(0);
    const log = (...a: any[]) => console.log(`[craft-v2 ${t()}s]`, ...a);

    // ── anchors ──────────────────────────────────────────────────────────────
    const ELLIS_POS = { x: 3276, z: 3193 };      // Ellis the Tanner, Al Kharid
    const BANK_POS = {
        x: Number(process.env.CR_BANK_ANCHOR_X || 3269),
        z: Number(process.env.CR_BANK_ANCHOR_Z || 3169),
    };                                            // Al Kharid bank

    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    const craftXp = () => sdk.getSkillXp('Crafting') ?? 0;
    const invCount = (re: RegExp) => sdk.countInventoryItems(re);
    const st = () => sdk.getState();

    async function dismissDialog(): Promise<void> {
        if (st()?.dialog?.isOpen) await bot.dismissBlockingUI();
    }

    async function ensureTools(): Promise<boolean> {
        if (sdk.findInventoryItem(/needle/i) && invCount(/^thread$/i) > 0) return true;
        log('missing tools — trying bank then Dommik');
        await bot.walkTo(BANK_POS.x, BANK_POS.z, 3);
        try {
            await bot.openBank();
            for (const [re, n] of [[/needle/i, 1], [/^thread$/i, 5]] as [RegExp, number][]) {
                try { await bot.withdrawItem(re, n); } catch { /* not in bank */ }
            }
            await bot.closeInterface().catch(() => {});
        } catch (e: any) { log('bank err', e?.message); }
        if (sdk.findInventoryItem(/needle/i) && invCount(/^thread$/i) > 0) return true;

        // Dommik restock (needs coins)
        await bot.walkTo(3320, 3194, 4);
        const dommik = st()?.nearbyNpcs?.find((n: any) => /dommik/i.test(n.name));
        if (!dommik) return false;
        try {
            await bot.openShop(dommik.name);
            if (!sdk.findInventoryItem(/needle/i)) await bot.buyFromShop(/needle/i, 1);
            if (invCount(/^thread$/i) < 5) await bot.buyFromShop(/thread/i, 10);
            await bot.closeShop().catch(() => {});
        } catch (e: any) { log('shop err', e?.message); }
        return !!(sdk.findInventoryItem(/needle/i) && invCount(/^thread$/i) > 0);
    }

    /** Tan every cowhide at Ellis; returns hides remaining. */
    async function tanAllHides(): Promise<number> {
        await bot.walkTo(ELLIS_POS.x, ELLIS_POS.z, 3);
        const ellis = st()?.nearbyNpcs?.find((n: any) => /tanner|ellis/i.test(n.name));
        if (!ellis) { log('no ellis'); return invCount(/cow.?hide/i); }
        try { await bot.talkTo(ellis.name); } catch { /* may already be open */ }

        let tanIface: any = null;
        for (let tick = 0; tick < 30 && !tanIface; tick++) {
            const iface = st()?.interface;
            if (iface?.isOpen) { tanIface = iface; break; }
            const d = st()?.dialog;
            if (d?.isOpen && d.options?.length) {
                const yes = d.options.find((o: any) => /yes/i.test(o.text)) ?? d.options[0];
                await sdk.sendClickDialog(yes.index);
            }
            await sdk.waitForTicks(2);
        }
        if (!tanIface) { log('no tan interface'); return invCount(/cow.?hide/i); }

        const hides0 = invCount(/cow.?hide/i);
        const all = tanIface.options.find((o: any) => /\ball\b/i.test(o.text) && /soft|leather|gp/i.test(o.text))
            ?? tanIface.options.find((o: any) => /^all$/i.test(o.text))
            ?? tanIface.options.find((o: any) => /soft/i.test(o.text));
        if (!all) { log('no tan-all option'); return hides0; }
        await sdk.sendClickComponent(all.componentId);
        for (let tick = 0; tick < 20 && invCount(/cow.?hide/i) >= hides0; tick++) {
            await sdk.waitForTicks(1);
            await dismissDialog();
        }
        log(`tanned ${hides0 - invCount(/cow.?hide/i)} hides`);
        return invCount(/cow.?hide/i);
    }

    /** Needle→leather craft of the whole inventory; fires once per batch. */
    async function craftBatch(): Promise<number> {
        const needle = sdk.findInventoryItem(/needle/i);
        let crafted = 0;
        while (Date.now() - startedAt < (DURATION_MS || Infinity) || !DURATION_MS) {
            const leather = sdk.findInventoryItem(/^leather$/i);
            if (!needle || !leather) break;
            const xpBefore = craftXp();
            await sdk.sendUseItemOnItem(needle.slot, leather.slot);
            let iface: any = null;
            for (let tick = 0; tick < 20 && !iface; tick++) {
                await sdk.waitForTicks(1);
                const i = st()?.interface;
                if (i?.isOpen) iface = i;
            }
            if (!iface) { log('no craft iface'); break; }
            const pick = iface.options.find((o: any) => /gloves/i.test(o.text) && /\b10\b/.test(o.text))
                ?? iface.options.find((o: any) => /gloves/i.test(o.text))
                ?? iface.options[0];
            await sdk.sendClickComponent(pick.componentId);
            for (let tick = 0; tick < 60; tick++) {
                await sdk.waitForTicks(1);
                await dismissDialog();
                if (!sdk.findInventoryItem(/^leather$/i)) break;
            }
            crafted++;
            log(`batch ${crafted}: +${craftXp() - xpBefore} xp, leather left ${invCount(/^leather$/i)}`);
            if (!sdk.findInventoryItem(/^leather$/i)) break;
        }
        return crafted;
    }

    // ── main loop ────────────────────────────────────────────────────────────
    if (!(await ensureTools())) { log('FATAL: no needle/thread obtainable'); return 'no-tools'; }

    let loops = 0;
    const xpStart = craftXp();
    while (!DURATION_MS || Date.now() - startedAt < DURATION_MS) {
        loops++;
        // 1) withdraw coins + cowhide from bank
        await bot.walkTo(BANK_POS.x, BANK_POS.z, 3);
        try {
            await bot.openBank();
            await bot.depositItem(/gloves/i).catch(() => {});
            await bot.depositItem(/^leather$/i).catch(() => {});
            if (invCount(/cow.?hide/i) === 0) {
                try { await bot.withdrawItem(/coin/i, 100); } catch { /* already have */ }
                try { await bot.withdrawItem(/cow.?hide/i, 28); } catch { /* none left */ }
            } else {
                await bot.closeInterface().catch(() => {});
            }
        } catch (e: any) { log('bank err', e?.message); }

        const hides = invCount(/cow.?hide/i);
        if (hides === 0) { log('out of cowhide in bank — stopping honestly'); break; }
        if (!sdk.findInventoryItem(/needle/i) || invCount(/^thread$/i) === 0) {
            if (!(await ensureTools())) { log('lost tools — stopping'); break; }
        }

        // 2) tan everything at Ellis
        const remaining = await tanAllHides();
        if (remaining > 0) log(`${remaining} hides untanned (gp?)`);

        // 3) craft all leather → gloves
        await craftBatch();
    }

    const gained = craftXp() - xpStart;
    const mins = Math.max((Date.now() - startedAt) / 60000, 1 / 60);
    log(`DONE: ${loops} loops, +${gained} crafting xp, peak≈${(gained / mins).toFixed(1)} xp/min`);
    return { loops, craftingXpGained: gained };
}, { timeout: 30 * 60_000 });
