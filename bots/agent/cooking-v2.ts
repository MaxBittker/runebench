import { runScript } from '../../sdk/runner';

/**
 * cooking-v2 — batch-cook loop: bank all → withdraw 28 raw → cook at range → repeat.
 * Drops nothing (every item cycles through the bank).
 *
 * Engine facts this method exploits (server/content/scripts/skill_cooking/scripts/cooking.rs2):
 *  - One interaction cooks exactly ONE raw item with a single `p_delay(1)` tick,
 *    so XP/min ≈ foodXP × successRate × clickRate. There is NO make-all dialog;
 *    the win comes from firing low-level `sdk.sendUseItemOnLoc` clicks back-to-back
 *    (state-poll paced, not fixed-sleep paced) while standing still next to the range.
 *  - The quest-gated castle kitchen is named "Cooking range"; the public one is
 *    named "Range" at (3230, 3196) — `/^range$/i` targets it deliberately
 *    (see learnings/cooking.md).
 *  - Raw lobster (120 XP/click, level 40) is the top reachable food, but its only
 *    no-bank source is Karamja cage fishing, so the bot fishes the best raw it can
 *    (shrimp → trout/salmon on the Lumbridge lure spots) and lets the bank loop
 *    prefer whatever highest-tier raw exists (lobsters included if present).
 *
 * Env knobs: COOK_DURATION_MS (stop cleanly after this long),
 *            CK_BANK_ANCHOR_X/Z (bank walk anchor, default Draynor bank).
 */

await runScript(async ({ bot, sdk }) => {
    const DURATION_MS = Number(process.env.COOK_DURATION_MS || 0);
    const startedAt = Date.now();
    const t = () => ((Date.now() - startedAt) / 1000).toFixed(0);
    const log = (...a: any[]) => console.log(`[cook-v2 ${t()}s]`, ...a);

    // ── anchors ──────────────────────────────────────────────────────────────
    const RANGE_POS = { x: 3230, z: 3196 };      // public Lumbridge Range
    const LURE_POS = { x: 3238, z: 3252 };       // Lumbridge river lure/bait spot
    const NET_POS = { x: 3087, z: 3230 };        // Draynor net/bait spot
    const GERRANT_POS = { x: 3013, z: 3225 };    // Port Sarim fishing shop
    const BANK_POS = {
        x: Number(process.env.CK_BANK_ANCHOR_X || 3093),
        z: Number(process.env.CK_BANK_ANCHOR_Z || 3244),
    };                                            // Draynor bank

    const RAW_FISH =
        /^raw (lobster|swordfish|bass|tuna|salmon|trout|pike|cod|mackerel|anchov(y|ies)|herring|sardine|shrimps?)$/i;
    // Highest XP-per-click first; the bank loop always withdraws the best tier present.
    const RAW_TIERS: RegExp[] = [
        /^raw lobster$/i, /^raw swordfish$/i, /^raw bass$/i, /^raw tuna$/i,
        /^raw salmon$/i, /^raw trout$/i, /^raw pike$/i, /^raw cod$/i,
        /^raw mackerel$/i, /^raw anchov(y|ies)$/i, /^raw herring$/i,
        /^raw sardine$/i, /^raw shrimps?$/i,
    ];

    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    const cookingXp = () => sdk.getSkillXp('Cooking') ?? 0;
    const fishingLevel = () => sdk.getSkill('Fishing')?.level ?? 1;
    const cookingLevel = () => sdk.getSkill('Cooking')?.level ?? 1;
    const invCount = () => sdk.getInventory().length;

    async function dismissDialog(): Promise<void> {
        const st = sdk.getState();
        if (st?.dialog?.isOpen) await bot.dismissBlockingUI();
    }

    // ── gear bootstrap ───────────────────────────────────────────────────────
    async function buyAtGerrant(pattern: RegExp, qty: number): Promise<boolean> {
        try {
            await bot.walkTo(GERRANT_POS.x, GERRANT_POS.z, 5);
            for (let i = 0; i < 5; i++) {
                const gerrant = sdk.findNearbyNpc(/gerrant/i);
                if (gerrant) {
                    try {
                        await bot.openShop(gerrant);
                        const r = await bot.buyFromShop(pattern, qty);
                        await bot.closeShop();
                        return !!r?.success;
                    } catch { /* retry */ }
                }
                await sleep(300);
            }
        } catch (e: any) {
            log('gerrant error:', e?.message ?? e);
        }
        return false;
    }

    async function ensureGear(): Promise<boolean> {
        const hasNet = !!sdk.findInventoryItem(/small (fishing )?net/i);
        const hasRod = !!sdk.findInventoryItem(/fly (fishing )?rod/i);
        const feathers = sdk.findInventoryItem(/^feather$/i)?.count ?? 0;
        if (hasNet || (hasRod && feathers > 50)) return true;
        log('bootstrapping gear from Gerrant');
        if (!hasNet && (await buyAtGerrant(/small (fishing )?net/i, 1))) return true;
        if (!hasRod && (await buyAtGerrant(/fly (fishing )?rod/i, 1))) {
            const coins = sdk.findInventoryItem(/coin/i)?.count ?? 0;
            await buyAtGerrant(/^feather$/i, Math.min(1000, Math.max(100, Math.floor((coins - 10) / 2))));
            return true;
        }
        return !!sdk.findInventoryItem(/net|rod/i);
    }

    // ── fishing ──────────────────────────────────────────────────────────────
    const FISHING_ANIMS = new Set([618, 619, 620, 621, 622, 623]);

    async function findSpot(option: RegExp) {
        return sdk.getNearbyNpcs()
            .filter(n => /fishing\s*spot/i.test(n.name) && n.optionsWithIndex?.some(o => option.test(o.text)))
            .sort((a, b) => a.distance - b.distance)[0];
    }

    async function fillWithRaw(maxMs: number): Promise<void> {
        // Lure (trout/salmon) beats net (shrimp) as soon as we can rod-fish.
        const canLure = !!sdk.findInventoryItem(/fly (fishing )?rod/i)
            && (sdk.findInventoryItem(/^feather$/i)?.count ?? 0) > 10
            && fishingLevel() >= 20;
        const pos = canLure ? LURE_POS : NET_POS;
        const option = canLure ? /^lure$/i : /^net$/i;
        await bot.walkTo(pos.x, pos.z, 8);
        let lastProgress = Date.now();
        const endAt = Date.now() + maxMs;
        while (Date.now() < endAt) {
            await dismissDialog();
            if (invCount() >= 28) return;
            const st = sdk.getState();
            if (!st?.player || st.player.worldX === 0) { await sleep(500); continue; }
            const anim = st.player.animId ?? -1;
            if (!FISHING_ANIMS.has(anim)) {
                const spot = await findSpot(option);
                if (spot) {
                    const opt = spot.optionsWithIndex.find(o => option.test(o.text))!;
                    try { await sdk.sendInteractNpc(spot.index, opt.opIndex); } catch { /* reclick */ }
                    lastProgress = Date.now();
                    await sleep(150);
                } else {
                    if (Date.now() - lastProgress > 12000) { lastProgress = Date.now(); await bot.walkTo(pos.x, pos.z, 8); }
                    await sleep(250);
                }
            } else {
                await sleep(70);
            }
        }
    }

    // ── banking: deposit EVERYTHING, withdraw 28 of the best raw present ─────
    async function bankCycle(): Promise<{ raw: RegExp | null }> {
        await bot.walkTo(BANK_POS.x, BANK_POS.z, 6);
        let opened = false;
        for (let i = 0; i < 5 && !opened; i++) {
            try { opened = (await bot.openBank()).success; } catch { /* retry */ }
            if (!opened) await sleep(500);
        }
        if (!opened) {
            log('could not open bank');
            return { raw: null };
        }
        try {
            // bank all: every distinct stack (cooked + burnt + leftovers + tools stay out of the way)
            await bot.depositItem(RAW_FISH, -1);
            await bot.depositItem(/^(lobster|swordfish|bass|tuna|salmon|trout|pike|cod|mackerel|anchovies|herring|sardine|shrimps?|burnt .*)$/i, -1);
            // withdraw the highest tier the bank holds, up to 28
            for (const tier of RAW_TIERS) {
                const r = await bot.withdrawItem(tier, 28);
                if (r?.success || (r as any)?.amountWithdrawn > 0) return { raw: tier };
            }
        } finally {
            try { await bot.closeBank(); } catch { /* ignore */ }
        }
        return { raw: null };
    }

    // ── cooking: stand at the range and spam one-click-one-item ──────────────
    async function cookAllRaw(): Promise<{ cooked: number; burnt: number; clicks: number }> {
        await bot.walkTo(RANGE_POS.x, RANGE_POS.z, 1);
        // Cache the range loc reference; re-scan only if it vanishes.
        let range = sdk.findNearbyLoc(/^range$/i);
        if (!range) {
            const scanned = await sdk.scanNearbyLocs().catch(() => []);
            range = scanned.filter(l => /^range$/i.test(l.name)).sort((a, b) => a.distance - b.distance)[0];
        }
        if (!range) {
            log('no range visible — aborting cook cycle');
            return { cooked: 0, burnt: 0, clicks: 0 };
        }
        let cooked = 0, burnt = 0, clicks = 0;
        let idleMs = 0;
        const idleStart = Date.now();
        while (true) {
            await dismissDialog();
            const inv = sdk.getInventory().filter(i => RAW_FISH.test(i.name));
            if (!inv.length) break;
            const before = invCount();
            const startXp = cookingXp();
            const raw = inv[0]!;
            try {
                await sdk.sendUseItemOnLoc(raw.slot, range.x, range.z, range.id);
                clicks++;
            } catch {
                await sleep(120);
                continue;
            }
            // State-paced: resolve as soon as the item leaves the slot (or 600ms cap),
            // so consecutive clicks ride the server's 1-tick cook delay instead of a
            // fixed sleep.
            let resolved = false;
            while (Date.now() - (idleStart - idleMs) < 600 + idleMs) {
                await sleep(25);
                if (invCount() < before || cookingXp() > startXp) { resolved = true; break; }
                await dismissDialog();
            }
            if (resolved) {
                idleMs = 0;
                const after = sdk.getInventory();
                if (cookingXp() > startXp) cooked++;
                else if (!after.some(i => i.slot === raw.slot && RAW_FISH.test(i.name))) burnt++;
            } else {
                idleMs += 600;
                if (idleMs >= 2400) {
                    // Stuck (moved away / UI blocked) — re-anchor once, then give up on this cycle.
                    idleMs = 0;
                    await bot.walkTo(RANGE_POS.x, RANGE_POS.z, 1);
                    const rescanned = await sdk.scanNearbyLocs().catch(() => []);
                    range = rescanned.filter(l => /^range$/i.test(l.name))[0]
                        ?? sdk.findNearbyLoc(/^range$/i)
                        ?? range;
                    if (sdk.getState()?.dialog?.isOpen) await bot.dismissBlockingUI();
                }
            }
        }
        return { cooked, burnt, clicks };
    }

    // ── main loop ────────────────────────────────────────────────────────────
    const stats = { cycles: 0, cooked: 0, burnt: 0, clicks: 0, banks: 0 };
    const startXp = cookingXp();
    log(`start: cooking=${cookingLevel()} fishing=${fishingLevel()} xp=${startXp}`);

    if (!(await ensureGear())) {
        log('BLOCKED: no fishing gear obtainable (no net/rod and no coins)');
        return { mode: 'cooking-v2', blocked: 'gear', startXp, endXp: cookingXp() };
    }

    while (!DURATION_MS || Date.now() - startedAt < DURATION_MS) {
        try {
            // 1) fill with the best raw we can catch
            await fillWithRaw(4 * 60_000);
            // 2) bank everything, withdraw 28 of the best raw tier
            const { raw } = await bankCycle();
            stats.banks++;
            if (!raw) {
                log('bank cycle returned no raw — refilling');
                continue;
            }
            // 3) cook the whole inventory at the range (peak-XP window)
            const r = await cookAllRaw();
            stats.cycles++;
            stats.cooked += r.cooked;
            stats.burnt += r.burnt;
            stats.clicks += r.clicks;
            log(
                `cycle ${stats.cycles}: cooked=${stats.cooked} burnt=${stats.burnt} ` +
                `clicks=${stats.clicks} ckLvl=${cookingLevel()} xp=+${cookingXp() - startXp}`,
            );
        } catch (e: any) {
            console.error('[cook-v2] cycle error:', e?.message ?? e);
            await sleep(1000);
        }
    }

    const gained = cookingXp() - startXp;
    const elapsedMin = (Date.now() - startedAt) / 60_000;
    log(`DONE: cookingXp+${gained} over ${elapsedMin.toFixed(1)}min, cycles=${stats.cycles}`);
    return { mode: 'cooking-v2', startXp, endXp: cookingXp(), gained, elapsedMs: Date.now() - startedAt, stats };
});
