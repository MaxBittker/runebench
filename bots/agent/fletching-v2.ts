import { runScript } from '../../sdk/runner';

// fletching-v2 — highest-XP-per-tick product ladder + full-inventory batch
// knife runs (vs fletching-best.ts, which re-knifes with fixed sleeps, chops
// one log at a time at a single hardcoded tile, and always makes arrow shafts).
//
// Engine facts this method is built on (server/content/scripts/skill_fletching):
//   - EVERY cut product consumes 1 log per 2 game ticks (%action_delay = +2),
//     so XP-per-tick == XP-per-log ÷ 2 and the best product is simply the
//     highest-XP-per-log recipe the current Fletching level allows:
//       arrow shafts   lvl 1  75 xp/log (15 shafts × 5)   ← beats shortbow!
//       longbow (u)    lvl 10 100 xp/log                  ← best normal-log pick
//       oak longbow(u) lvl 25 250 xp/log   (oak logs need Woodcutting 15)
//       willow longbow lvl 40 415 xp/log   (willow logs need Woodcutting 30)
//
// Method:
//   1. Product ladder cuts longbow(u) from Fletching 10+, arrow shafts below
//      (shafts stack — zero inventory churn while levelling 1-9).
//   2. Log-tier ladder relocates once per unlock to a known multi-tree cluster
//      (normal → oak → willow), gated on BOTH Woodcutting (can chop) and
//      Fletching (can cut the better bow). Runtime loc discovery via
//      scanNearbyLocs; anchors are only hints.
//   3. Chop phase powerchops like mining-v2: chain the nearest tree whose
//      options still expose "Chop" (respawn-aware), tick-poll instead of
//      fixed sleeps, never interrupt for disposal — only when the inventory
//      is actually full.
//   4. Fletch phase is ONE knife-on-logs interaction per inventory: Make-X
//      the exact log count, then tick-poll until the logs are gone. No fixed
//      sleeps inside the burst — this is where peak XP/min is set.
//   5. Unstrung bows don't stack: drop them right after the batch (outside
//      the XP burst window); arrow shafts stack and are never dropped.
//
// Bootstrap (the part that decides whether the run scores anything at all):
//   The vanilla start has a KNIFE but NO AXE and NO COINS, and every axe
//   vendor wants ~16gp. So before any chopping: pickpocket Lumbridge castle
//   Men (proven attack-v2 pattern) until ~30gp, then buy a Bronze axe at
//   Bob's Brilliant Axes and VERIFY it landed. No axe → abort loudly rather
//   than silently grinding zero-XP chop clicks forever.
//
// Env: FLETCH_DURATION_MS (clean stop after this long; 0 = run forever),
//      FLETCH_LOG_TIER_MAX (0=normal only, 1=oak, 2=willow cap).

await runScript(async ({ bot, sdk }) => {
    const DURATION_MS = Number(process.env.FLETCH_DURATION_MS || 0);
    const TIER_CAP = Number(process.env.FLETCH_LOG_TIER_MAX ?? 2);
    const startedAt = Date.now();

    type LogTier = {
        minWc: number;
        minFl: number;
        treeRe: RegExp;
        label: string;
        anchors: [number, number][];
    };
    // Anchors are candidate clusters; runtime discovery scans around each and
    // keeps whatever actually exposes a matching "Chop down" loc.
    const TIERS: LogTier[] = [
        { minWc: 30, minFl: 40, treeRe: /willow/i, label: 'willow', anchors: [[3085, 3234], [3088, 3231]] },
        { minWc: 15, minFl: 25, treeRe: /oak/i, label: 'oak', anchors: [[3102, 3242], [3106, 3247], [3188, 3247]] },
        { minWc: 1, minFl: 10, treeRe: /^tree$/i, label: 'normal', anchors: [[3190, 3255], [3186, 3250], [3087, 3227]] },
    ];

    const CHOP_RE = /chop|down/i;
    const KNIFE_RE = /knife/i;
    const AXE_RE = /\baxe\b/i;
    const LOGS_RE = /^logs$/i;
    const COIN_RE = /coin/i;

    const flXp = () => sdk.getSkill('Fletching')?.experience ?? 0;
    const wcLevel = () => sdk.getSkill('Woodcutting')?.level ?? 1;
    const flLevel = () => sdk.getSkill('Fletching')?.level ?? 1;
    const invUsed = () => sdk.getInventory().length;
    const coins = () => sdk.countInventoryItems(COIN_RE);
    const hasAxe = () => !!sdk.findInventoryItem(AXE_RE) || !!sdk.findEquipmentItem(AXE_RE);

    function countInv(re: RegExp): number {
        return sdk.getInventory().filter((i) => re.test(i.name)).reduce((a, i) => a + i.count, 0);
    }

    // Best cut product for the current Fletching level (XP/log ÷ 2 ticks):
    // longbow(u) from 10+, arrow shafts below.
    function productFor(level: number): { re: RegExp; label: string } {
        if (level >= 10) return { re: /long\s bow|longbow/i, label: 'longbow' };
        return { re: /arrow\s shafts?/i, label: 'arrow shafts' };
    }

    function tierFor(): LogTier {
        for (const t of TIERS) {
            if (wcLevel() >= t.minWc && flLevel() >= t.minFl && TIERS.indexOf(t) <= TIER_CAP + 1) return t;
        }
        return TIERS[TIERS.length - 1]!;
    }

    // ── tree discovery: cached + throttled (a full rescan floods the gateway) ──
    let cachedTrees: Awaited<ReturnType<typeof sdk.getNearbyLocs>> = [];
    let lastScanAt = 0;
    async function treesInTier(tier: LogTier, force = false) {
        if (!force && cachedTrees.length > 0 && Date.now() - lastScanAt < 5000) {
            return cachedTrees.filter((l) => tier.treeRe.test(l.name));
        }
        await sdk.scanNearbyLocs(25).catch(() => {});
        lastScanAt = Date.now();
        cachedTrees = sdk
            .getNearbyLocs()
            .filter((l) => l.optionsWithIndex.some((o) => CHOP_RE.test(o.text)));
        return cachedTrees.filter((l) => tier.treeRe.test(l.name)).sort((a, b) => a.distance - b.distance);
    }

    async function relocateTo(tier: LogTier): Promise<boolean> {
        const p = sdk.getState()?.player;
        if (!p) return false;
        for (const [ax, az] of tier.anchors) {
            if (Math.hypot(p.worldX - ax, p.worldZ - az) > 12) {
                await bot.walkTo(ax, az, 8).catch(() => {});
            }
            if ((await treesInTier(tier, true)).length > 0) return true;
        }
        return false;
    }

    // ── chop phase: fill the inventory, respawn-aware chaining ──────────────
    async function chopPhase(tier: LogTier, maxMs: number): Promise<'full' | 'no-trees'> {
        const deadline = Date.now() + maxMs;
        let lastClickAt = 0;
        let clickedTree: { x: number; z: number } | null = null;
        while (Date.now() < deadline) {
            await bot.dismissBlockingUI().catch(() => {});
            if (invUsed() >= 28) return 'full';
            const trees = await treesInTier(tier);
            if (!trees.length) return 'no-trees';
            const now = Date.now();
            const target = trees[0]!;
            const movedAway = clickedTree !== null && (target.x !== clickedTree.x || target.z !== clickedTree.z);
            // Click instantly when the current tree depletes (Chop option gone
            // → next-nearest is a different loc), else re-arm every ~1.5s so a
            // silent stop never wastes the phase budget.
            if (!clickedTree || movedAway || now - lastClickAt >= 1500) {
                const opt = target.optionsWithIndex.find((o) => CHOP_RE.test(o.text))?.opIndex ?? 1;
                const sent = await sdk.sendInteractLoc(target.x, target.z, target.id, opt);
                if (sent.success) {
                    clickedTree = { x: target.x, z: target.z };
                    lastClickAt = now;
                } else {
                    clickedTree = null;
                    cachedTrees = []; // stale list — rescan soon
                }
            }
            await sdk.waitForTicks(1).catch(() => {});
        }
        return invUsed() >= 28 ? 'full' : 'no-trees';
    }

    // ── fletch phase: ONE knife interaction per full inventory ──────────────
    async function fletchBatch(product: { re: RegExp; label: string }, depth = 0): Promise<{ ok: boolean; xp: number }> {
        const xpBefore = flXp();
        const knife = sdk.findInventoryItem(KNIFE_RE);
        const logs = sdk.findInventoryItem(LOGS_RE);
        if (!knife || !logs || depth > 2) return { ok: false, xp: flXp() - xpBefore };

        await bot.dismissBlockingUI().catch(() => {});
        const r1 = await sdk.sendUseItemOnItem(knife.slot, logs.slot);
        if (!r1.success) return { ok: false, xp: 0 };

        // Wait for the skill_multi dialog (tick-poll, no fixed sleep).
        let opened = false;
        for (let i = 0; i < 20 && !opened; i++) {
            await sdk.waitForTicks(1).catch(() => {});
            opened = !!sdk.getState()?.dialog?.isOpen;
        }
        if (!opened) return { ok: false, xp: 0 };

        const opt = sdk.getState()?.dialog?.options?.find((o) => product.re.test(o.text));
        if (!opt) {
            await bot.dismissBlockingUI().catch(() => {});
            return { ok: false, xp: 0 };
        }
        await sdk.sendClickDialog(opt.index);
        await Bun.sleep(300);

        // Make-X the exact number of logs in the bag so the whole batch runs
        // server-side without further interactions.
        const amount = Math.max(1, Math.min(26, countInv(LOGS_RE)));
        await sdk.sendCountDialog(amount);

        // Poll until the logs run out ("You have run out of logs") — the
        // engine queue cuts one log every 2 ticks; dismiss any level-up UI
        // that blocks mid-batch and re-arm if progress stalls.
        const deadline = Date.now() + amount * 2000 + 8000;
        let lastXp = flXp();
        let lastProgressAt = Date.now();
        while (Date.now() < deadline) {
            await sdk.waitForTicks(1).catch(() => {});
            if (countInv(LOGS_RE) === 0) break;
            if (sdk.getState()?.dialog?.isOpen) continue; // mid-batch modal
            await bot.dismissBlockingUI().catch(() => {});
            const xpNow = flXp();
            if (xpNow > lastXp) {
                lastXp = xpNow;
                lastProgressAt = Date.now();
            } else if (Date.now() - lastProgressAt > 4000) {
                // Stalled (level-up ate the queue, dropped click, ...): re-knife.
                return fletchBatch(product, depth + 1);
            }
        }
        return { ok: true, xp: flXp() - xpBefore };
    }

    function dropBows(): void {
        // Arrow shafts stack — zero churn. Unstrung bows fill the bag again,
        // so clear them outside the XP burst before chopping resumes.
        for (const item of sdk.getState()?.inventory ?? []) {
            if (/unstrung|\bbow\b/i.test(item.name)) sdk.sendDropItem(item.slot).catch(() => {});
        }
    }

    // ── bootstrap: coins → bronze axe (verified), with retries ──────────────
    async function pickpocketMen(untilCoins: number, budgetMs: number): Promise<boolean> {
        const deadline = Date.now() + budgetMs;
        let fails = 0;
        while (Date.now() < deadline && coins() < untilCoins && fails < 30) {
            try {
                await bot.dismissBlockingUI().catch(() => {});
                const man =
                    sdk.findNearbyNpc(/^man$/i, { withOption: /pick\s?pocket/i }) ??
                    sdk.getNearbyNpcs().find(
                        (n) => /^man$/i.test(n.name) && n.optionsWithIndex.some((o) => /pick\s?pocket/i.test(o.text)),
                    );
                if (!man) {
                    await bot.walkTo(3223, 3221, 4).catch(() => {});
                    await sdk.waitForTicks(2).catch(() => {});
                    continue;
                }
                const before = coins();
                const r = await bot.pickpocketNpc(man).catch(() => null);
                if (r && 'stunned' in r && r.stunned) await Bun.sleep(1500);
                if (coins() === before) fails++;
                await sdk.waitForTicks(1).catch(() => {});
            } catch {
                if (++fails > 40) break;
                await Bun.sleep(300);
            }
        }
        return coins() >= untilCoins;
    }

    async function ensureAxe(attemptBudgetMs = 150000): Promise<boolean> {
        if (hasAxe()) return true;
        console.log('[fl-v2] bootstrap: no axe — coins → Bob → bronze axe');

        // Free axes sometimes lie around as ground spawns near the shops.
        const p0 = sdk.getState()?.player;
        if (p0) {
            await bot.walkTo(3231, 3203, 6).catch(() => {});
            const g = sdk.findGroundItem(AXE_RE);
            if (g) {
                try {
                    await bot.pickupItem(g);
                } catch {}
                if (hasAxe()) return true;
            }
        }

        // Pickpocket Lumbridge castle Men for the ~16gp the axe costs.
        if (coins() < 30) {
            const got = await pickpocketMen(30, attemptBudgetMs * 0.6);
            console.log(`[fl-v2] pickpocket: ${coins()}gp (enough=${got})`);
        }

        for (let tries = 0; tries < 3 && !hasAxe(); tries++) {
            if (coins() < 16) {
                await pickpocketMen(30, 60000);
                if (coins() < 16) break;
            }
            await bot.walkTo(3231, 3203, 3).catch(() => {});
            const opened = await bot.openShop(/bob/i).catch(() => ({ success: false }));
            if (!opened?.success || !sdk.getState()?.shop?.isOpen) {
                console.log(`[fl-v2] shop open failed (try ${tries + 1})`);
                continue;
            }
            const bought = await bot.buyFromShop(/bronze axe/i, 1).catch(() => ({ success: false }));
            await bot.closeShop().catch(() => {});
            console.log(`[fl-v2] buy bronze axe: ${bought?.success} ${('message' in (bought ?? {}) ? (bought as any).message : '')}`);
            if (hasAxe()) return true;
        }
        return hasAxe();
    }

    // ── setup: knife (start inventory has one; ground spawn as fallback) ────
    if (!sdk.findInventoryItem(KNIFE_RE)) {
        await bot.walkTo(3224, 3202).catch(() => {});
        const g = sdk.findGroundItem(KNIFE_RE);
        if (g) {
            try {
                await bot.pickupItem(g);
            } catch {}
        }
    }
    if (!sdk.findInventoryItem(KNIFE_RE)) {
        console.log('[fl-v2] NO KNIFE — aborting');
        return { error: 'no-knife', gained: 0 };
    }
    if (!(await ensureAxe())) {
        console.log('[fl-v2] NO AXE after bootstrap — aborting (never chop without one)');
        return { error: 'no-axe', gained: 0, elapsedMs: Date.now() - startedAt };
    }
    console.log(`[fl-v2] ready: axe=yes coins=${coins()} — heading to trees`);

    // ── main loop ───────────────────────────────────────────────────────────
    const stats = { batches: 0, logsFletched: 0, inventoriesDropped: 0, relocates: 0, axeRecoveries: 0 };
    let tierLabel = '';
    let nextLogAt = Date.now() + 30000;
    let axeFailures = 0;
    while (true) {
        if (DURATION_MS && Date.now() - startedAt > DURATION_MS) break;
        try {
            // Axe guard: losing the axe (drop bug, death, ...) must never turn
            // into a silent zero-XP grind like the first v2 bench run did.
            if (!hasAxe()) {
                axeFailures++;
                if (axeFailures > 3) {
                    console.log('[fl-v2] lost axe repeatedly — aborting');
                    break;
                }
                stats.axeRecoveries++;
                if (!(await ensureAxe())) {
                    await Bun.sleep(3000);
                    continue;
                }
            }
            const tier = tierFor();
            const product = productFor(flLevel());
            if (tier.label !== tierLabel) {
                console.log(`[fl-v2] wc=${wcLevel()} fl=${flLevel()} → ${tier.label} logs, cutting ${product.label}`);
                if (!(await relocateTo(tier))) {
                    console.log(`[fl-v2] no ${tier.label} trees found, falling back to normal`);
                    if (!(await relocateTo(TIERS[TIERS.length - 1]!))) {
                        await Bun.sleep(2000);
                        continue;
                    }
                }
                tierLabel = tier.label;
                stats.relocates++;
            }
            if (invUsed() < 26) {
                const r = await chopPhase(tier, 45000);
                if (r === 'no-trees' && invUsed() < 2) {
                    tierLabel = ''; // force relocation attempt next loop
                    await Bun.sleep(1000);
                    continue;
                }
            }
            const logsBefore = countInv(LOGS_RE);
            if (logsBefore > 0) {
                stats.batches++;
                await fletchBatch(product);
                stats.logsFletched += logsBefore - countInv(LOGS_RE);
                dropBows();
                await sdk.waitForTicks(1).catch(() => {});
                stats.inventoriesDropped++;
            }
        } catch (e: any) {
            console.error('[fl-v2] error:', e?.message ?? e);
            await sdk.waitForTicks(1).catch(() => {});
        }
        if (Date.now() >= nextLogAt) {
            nextLogAt += 30000;
            console.log(
                `[fl-v2] ${Math.round((Date.now() - startedAt) / 1000)}s fl=${flLevel()} wc=${wcLevel()} ` +
                    `xp=${flXp()} batches=${stats.batches} logs=${stats.logsFletched}`,
            );
        }
    }
    return { fletching: sdk.getSkill('Fletching'), gained: sdk.getSkillXp('Fletching'), stats, elapsedMs: Date.now() - startedAt };
});
