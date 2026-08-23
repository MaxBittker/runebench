import { runScript } from '../../sdk/runner';

// firemaking-v2 — tinderbox+logs row-burn loop, minimal per-log idle ticks.
//
// Method (vs firemaking-best.ts, which burns each log through the high-level
// BotActions helper — that wrapper re-resolves items, dismisses UI, and can
// block up to 30s waiting on a condition that already resolved — and chops
// yew mid-loop):
//   1. Row-burn loop at the LOW level: for every log in inventory we send
//      tinderbox-on-log directly via sdk.sendUseItemOnItem (no high-level
//      wrapper), then poll state once per game tick (~300ms) for either a
//      Firemaking XP delta (success — the server auto-steps us one tile off
//      the fire) or a failure game message ("you need to move" etc.). The
//      moment XP lands we immediately send the next attempt, so per-log
//      overhead is ~1 tick instead of seconds.
//   2. Failure handling without idling: on "can't light" / "need to move"
//      (or a silent timeout) we nudge one tile along an open row and retry
//      the SAME log — never re-walk to a fixed anchor.
//   3. No banking until the inventory is empty of logs: only when no logs
//      remain do we chop the nearest active tree back up to a full inventory
//      (regular trees near Lumbridge; normal logs = 40 FM XP each).
//
// Optional env: FIREMAKING_DURATION_MS (stop cleanly after this long).

await runScript(async ({ bot, sdk }) => {
    const DURATION_MS = Number(process.env.FIREMAKING_DURATION_MS || 0);
    const startedAt = Date.now();

    const TINDERBOX_RE = /tinderbox/i;
    const LOGS_RE = /^logs$/i;
    // Same failure strings actions.ts listens for in burnLogs().
    const FAILURE_MESSAGES = ["can't light a fire", "you need to move", "can't do that here"];

    const fmXp = () => sdk.getSkill('Firemaking')?.experience ?? 0;
    const logsInInv = () => sdk.getInventory().filter((i) => LOGS_RE.test(i.name));
    const invSlots = () => sdk.getInventory().length;

    function lastMessageTick(): number {
        const msgs = sdk.getState()?.gameMessages ?? [];
        return msgs.reduce((max, m) => Math.max(max, m.tick), -1);
    }

    // One low-level light attempt: tinderbox -> logs, then poll per tick until
    // XP moves, a failure message arrives, or the budget expires. Returns why.
    async function attemptBurn(maxTicks: number): Promise<
        { ok: true } | { ok: false; reason: 'no-items' | 'send-failed' | 'failure-message' | 'timeout' }
    > {
        await bot.dismissBlockingUI();
        const tinderbox = sdk.findInventoryItem(TINDERBOX_RE);
        if (!tinderbox) return { ok: false, reason: 'no-items' };
        const log = sdk.findInventoryItem(LOGS_RE);
        if (!log) return { ok: false, reason: 'no-items' };

        const before = fmXp();
        const msgBaseline = lastMessageTick();
        const sent = await sdk.sendUseItemOnItem(tinderbox.slot, log.slot);
        if (!sent.success) return { ok: false, reason: 'send-failed' };

        for (let t = 0; t < maxTicks; t++) {
            await sdk.waitForTicks(1).catch(() => {});
            if (sdk.getState()?.dialog?.isOpen) {
                await bot.dismissBlockingUI();
            }
            if (fmXp() > before) return { ok: true };
            for (const msg of sdk.getState()?.gameMessages ?? []) {
                if (msg.tick <= msgBaseline) continue;
                const text = msg.text.toLowerCase();
                if (FAILURE_MESSAGES.some((f) => text.includes(f))) {
                    return { ok: false, reason: 'failure-message' };
                }
            }
        }
        return { ok: false, reason: 'timeout' };
    }

    // Step one tile along an open row (prefer east/west; fall back N/S) so
    // the next attempt happens on fresh ground instead of a used tile.
    async function nudgeOneTile(): Promise<void> {
        const p = sdk.getState()?.player;
        if (!p) return;
        const dirs: Array<[number, number]> = [[-1, 0], [1, 0], [0, -1], [0, 1]];
        for (const [dx, dz] of dirs) {
            const r = await sdk.sendWalk(p.worldX + dx, p.worldZ + dz, false);
            if (r.success) {
                await sdk.waitForTicks(1).catch(() => {});
                return;
            }
        }
    }

    // Refill: chop the nearest ACTIVE tree until the inventory is full or we
    // have enough logs. Only entered when the inventory holds zero logs.
    async function refillLogs(): Promise<boolean> {
        let trees = sdk
            .getNearbyLocs()
            .filter((l) => /^tree$/i.test(l.name))
            .filter((l) => l.optionsWithIndex.some((o) => /chop/i.test(o.text)))
            .sort((a, b) => a.distance - b.distance);
        if (!trees.length) {
            const scanned = await sdk.scanNearbyLocs(20).catch(() => []);
            trees = scanned
                .filter((l) => /^tree$/i.test(l.name))
                .filter((l) => l.optionsWithIndex.some((o) => /chop/i.test(o.text)))
                .sort((a, b) => a.distance - b.distance);
        }
        if (!trees.length) return false;

        const hasTime = () => !DURATION_MS || Date.now() - startedAt < DURATION_MS;
        while (invSlots() < 28 && logsInInv().length < 20 && hasTime()) {
            const tree = sdk
                .getNearbyLocs()
                .filter((l) => /^tree$/i.test(l.name))
                .filter((l) => l.optionsWithIndex.some((o) => /chop/i.test(o.text)))
                .sort((a, b) => a.distance - b.distance)[0];
            if (!tree) return logsInInv().length > 0;
            const res = await bot.chopTree(tree).catch(() => null);
            await bot.dismissBlockingUI();
            if (!res || !(res as any).success) {
                // Tree depleted or unreachable — brief tick wait lets it respawn.
                await sdk.waitForTicks(2).catch(() => {});
            }
            if (logsInInv().length >= 20) break;
        }
        return logsInInv().length > 0;
    }

    // ── startup: ensure tinderbox (Lumbridge general shop, same as -best) ──
    console.log('[fm-v2] start lvl', sdk.getSkill('Firemaking')?.level, 'xp', fmXp());
    if (!sdk.findInventoryItem(TINDERBOX_RE)) {
        await bot.walkTo(3209, 3247).catch(() => {});
        const keeper = sdk.findNearbyNpc(/shop (keeper|assistant)/i, { reachable: true } as never);
        if (keeper) {
            const opt = keeper.optionsWithIndex.find((o) => /trade/i.test(o.text));
            if (opt) {
                await sdk.sendInteractNpc(keeper.index, opt.opIndex);
                await new Promise((r) => setTimeout(r, 4000));
                if (sdk.getState()?.shop?.isOpen) {
                    await bot.buyFromShop(TINDERBOX_RE, 1);
                    await bot.closeShop();
                }
            }
        }
    }
    if (!sdk.findInventoryItem(TINDERBOX_RE)) {
        console.log('[fm-v2] NO TINDERBOX, aborting');
        return { aborted: 'no-tinderbox' };
    }

    // ── main loop ──────────────────────────────────────────────────────────
    const stats = { burned: 0, fails: 0, refills: 0, attempts: 0 };
    while (!DURATION_MS || Date.now() - startedAt < DURATION_MS) {
        try {
            if (!logsInInv().length) {
                const got = await refillLogs();
                if (!got) {
                    stats.refills++; // counts failed refill scans too
                    await sdk.waitForTicks(3).catch(() => {});
                    continue;
                }
                stats.refills++;
                console.log(`[fm-v2] refilled: ${logsInInv().length} log slots`);
            }
            stats.attempts++;
            const r = await attemptBurn(10); // ~10 ticks budget per attempt
            if (r.ok) {
                stats.burned++;
                // Success already auto-stepped us off the fire — chain the next
                // attempt immediately (the loop's fresh item resolution handles
                // the shifted slots).
            } else {
                stats.fails++;
                await nudgeOneTile();
                if (stats.fails % 25 === 0) {
                    console.log(`[fm-v2] many failures (${stats.fails}) — relocating row`);
                    const p = sdk.getState()?.player;
                    if (p) await bot.walkTo(p.worldX + 5, p.worldZ, 3).catch(() => {});
                }
            }
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error('[fm-v2] error:', msg);
            await sdk.waitForTicks(1).catch(() => {});
        }
        if (stats.attempts % 15 === 0) {
            const elapsedS = Math.round((Date.now() - startedAt) / 1000);
            console.log(
                `[fm-v2] ${elapsedS}s lvl=${sdk.getSkill('Firemaking')?.level} xp=${fmXp()} ` +
                    `burned=${stats.burned} fails=${stats.fails}`,
            );
        }
    }

    console.log('[fm-v2] done', JSON.stringify(stats), 'final xp', fmXp());
    return { firemaking: sdk.getSkill('Firemaking'), stats, elapsedMs: Date.now() - startedAt };
});
