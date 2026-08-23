import { runScript } from '../../sdk/runner';

/**
 * fishing-v2 — optimized Fishing XP-rate bot.
 *
 * Strategy (from engine source: server/content/scripts/skill_fishing):
 *  - Lure spots (trout 500xp / salmon 700xp per catch) have the best XP-per-roll
 *    of any reachable spot; rolls happen server-side every ~4 ticks.
 *  - Feathers are consumed 1/catch, so the whole run is budgeted up-front:
 *    Phase A bootstraps gold by selling raw shrimp/anchovies (Rimmington net
 *    spot — same coastline as Gerrant's shop, no aggressive NPCs unlike Draynor),
 *    then buys a fly fishing rod + max feathers.
 *  - Phase B fly-fishes the Lumbridge lure spot forever with drip-dropping:
 *    free slots are topped up continuously instead of batch-dropping at a full
 *    inventory, so the server-side roll loop never stalls on
 *    "You can't carry any more fish" and never needs a re-click.
 */
await runScript(async ({ bot, sdk }) => {
    const T0 = Date.now();
    const t = () => ((Date.now() - T0) / 1000).toFixed(1);
    const log = (...a: any[]) => console.log(`[${t()}s]`, ...a);

    const GERRANT_POS = { x: 3012, z: 3224 };
    const NET_SPOT_POS = { x: 2986, z: 3176 }; // Rimmington net/bait
    const LURE_SPOT_POS = { x: 3238, z: 3252 }; // Lumbridge river lure/bait
    const FLY_ROD_COST = 5;
    const FEATHER_COST = 2;
    const MIN_FEATHERS_AFTER_BUY = 900;
    const FREE_SLOT_FLOOR = 5;      // keep at least this many free slots
    const DROP_DOWN_TO = 12;        // when dipping below floor, drop raw fish until here
    const FISHING_ANIMS = new Set([618, 619, 620, 621, 622, 623]);
    const RAW_FISH = /^raw (shrimps?|anchov(y|ies)|trout|salmon|sardine|herring|pike|tuna|lobster|swordfish)$/i;

    let drops = 0, clicks = 0, sells = 0, dialogs = 0, reclicksBlocked = 0;
    let dropMsTotal = 0;
    const dropTimes: number[] = [];

    const dismissDialog = async (): Promise<boolean> => {
        const st = sdk.getState();
        if (st?.dialog?.isOpen) {
            await sdk.sendClickDialog(st.dialog.options?.[0]?.index ?? 0);
            dialogs++;
            await new Promise(r => setTimeout(r, 60));
            return true;
        }
        return false;
    };

    const rawFish = () => sdk.getInventory().filter(i => RAW_FISH.test(i.name));
    const countItem = (pattern: RegExp): number => {
        const item = sdk.findInventoryItem(pattern);
        return item?.count ?? 0;
    };
    const coins = (): number => countItem(/coin/i);

    const openGerrant = async (): Promise<boolean> => {
        await bot.walkTo(GERRANT_POS.x, GERRANT_POS.z, 5);
        for (let i = 0; i < 5; i++) {
            const gerrant = sdk.findNearbyNpc(/gerrant/i);
            if (gerrant) {
                try {
                    await bot.openShop(gerrant);
                    return true;
                } catch { /* retry */ }
            }
            await new Promise(r => setTimeout(r, 300));
        }
        return false;
    };

    // ---- Phase A: bootstrap gold, buy fly rod + feathers ----
    log('Phase A: bootstrap. startXp=', sdk.getSkillXp('Fishing'), 'coins=', coins());

    // sanity: need a net; if lost (death), buy one at Gerrant
    if (!sdk.findInventoryItem(/small (fishing )?net/i)) {
        log('no net — buying one at Gerrant');
        if (await openGerrant()) {
            await bot.buyFromShop(/small (fishing )?net/i, 1);
            await bot.closeShop();
        }
    }

    let bootstrapDone = false;
    let sellTrips = 0;
    while (!bootstrapDone && Date.now() - T0 < 25 * 60_000) {
        if (!(await ensureNet())) break;
        // fish the net spot until inventory is full of raw fish
        await fishNetSpotUntilFull();
        if (rawFish().length === 0) continue;

        // walk to Gerrant, sell everything raw
        if (await openGerrant()) {
            for (const item of rawFish()) {
                const r = await bot.sellToShop(item.name, item.count ?? 1);
                if (r?.success) sells += item.count ?? 1;
            }
            sellTrips++;
            log(`sell trip #${sellTrips}: coins=${coins()}, sold=${sells}`);

            // buy gear as soon as affordable
            const hasRod = !!sdk.findInventoryItem(/fly (fishing )?rod/i);
            if (!hasRod && coins() >= FLY_ROD_COST + 2) {
                await bot.buyFromShop(/fly (fishing )?rod/i, 1);
                log('bought fly fishing rod');
            }
            const feathers = countItem(/^feather$/i);
            if (feathers < MIN_FEATHERS_AFTER_BUY && coins() >= FLY_ROD_COST + 100 * FEATHER_COST) {
                const affordable = Math.min(1000, Math.floor((coins() - 10) / FEATHER_COST));
                if (affordable >= 100) {
                    await bot.buyFromShop(/^feather$/i, affordable);
                    log(`bought ${affordable} feathers, total=${countItem(/^feather$/i)}, coins left=${coins()}`);
                }
            }
            await bot.closeShop();
        }
        const hasRodNow = !!sdk.findInventoryItem(/fly (fishing )?rod/i);
        if (hasRodNow && countItem(/^feather$/i) >= MIN_FEATHERS_AFTER_BUY) bootstrapDone = true;
    }

    async function ensureNet(): Promise<boolean> {
        if (sdk.findInventoryItem(/small (fishing )?net/i)) return true;
        log('lost net — rebuying');
        if (await openGerrant()) {
            await bot.buyFromShop(/small (fishing )?net/i, 1);
            await bot.closeShop();
            return !!sdk.findInventoryItem(/small (fishing )?net/i);
        }
        return false;
    }

    async function findSpot(option: RegExp) {
        return sdk.getNearbyNpcs()
            .filter(n => /fishing\s*spot/i.test(n.name) && n.optionsWithIndex?.some(o => option.test(o.text)))
            .sort((a, b) => a.distance - b.distance)[0];
    }

    async function fishNetSpotUntilFull(): Promise<void> {
        await bot.walkTo(NET_SPOT_POS.x, NET_SPOT_POS.z, 8);
        let lastXp = sdk.getSkillXp('Fishing');
        let lastProgress = Date.now();
        while (Date.now() - T0 < 25 * 60_000) {
            await dismissDialog();
            const st = sdk.getState();
            if (!st?.player || st.player.worldX === 0) return;
            const xp = sdk.getSkillXp('Fishing');
            if (xp !== lastXp) { lastXp = xp; lastProgress = Date.now(); }
            if (sdk.getInventory().length >= 26) return;
            if (Date.now() - lastProgress > 15000) { // stuck — reposition
                await bot.walkTo(NET_SPOT_POS.x, NET_SPOT_POS.z, 8);
                lastProgress = Date.now();
            }
            const anim = st.player.animId ?? -1;
            if (!FISHING_ANIMS.has(anim)) {
                const spot = await findSpot(/^net$/i);
                if (spot) {
                    const opt = spot.optionsWithIndex.find(o => /^net$/i.test(o.text))!;
                    await sdk.sendInteractNpc(spot.index, opt.opIndex);
                    clicks++;
                    await new Promise(r => setTimeout(r, 150));
                } else {
                    await bot.walkTo(NET_SPOT_POS.x, NET_SPOT_POS.z, 8);
                    await new Promise(r => setTimeout(r, 250));
                }
            } else {
                await new Promise(r => setTimeout(r, 70));
            }
        }
    }

    if (!bootstrapDone) {
        log('FAILED to finish bootstrap — returning stats');
        return {
            mode: 'fishing-v2', phase: 'bootstrap-failed', startXp: undefined,
            xp: sdk.getSkillXp('Fishing'), coins: coins(),
            feathers: countItem(/^feather$/i), sellTrips, clicks, sells,
        };
    }

    // ---- Phase B: fly fish Lumbridge with drip-dropping ----
    log('Phase B: lure fishing. feathers=', countItem(/^feather$/i), 'xp=', sdk.getSkillXp('Fishing'));
    await bot.walkTo(LURE_SPOT_POS.x, LURE_SPOT_POS.z, 8);

    const startXp = sdk.getSkillXp('Fishing');
    let lastXp = startXp;
    let lastCatchAt = Date.now();
    let lastReclick = 0;
    const endAt = T0 + 28 * 60_000;

    while (Date.now() < endAt) {
        await dismissDialog();
        const st = sdk.getState();
        if (!st?.player) continue;

        const xp = sdk.getSkillXp('Fishing');
        if (xp !== lastXp) { lastXp = xp; lastCatchAt = Date.now(); }

        const invLen = sdk.getInventory().length;
        // drip-drop: keep free slots above the floor so the server roll loop
        // never hits freespace=0 (which would stop fishing entirely)
        if (28 - invLen < FREE_SLOT_FLOOR) {
            const victims = sdk.getInventory().filter(i => RAW_FISH.test(i.name)).slice(0, invLen - DROP_DOWN_TO > 0 ? invLen - DROP_DOWN_TO : 1);
            for (const item of victims.slice(0, 4)) {
                const a = Date.now();
                const r = await sdk.sendDropItem(item.slot);
                dropMsTotal += Date.now() - a;
                dropTimes.push(Date.now() - a);
                if (r?.success !== false) drops++;
            }
            continue; // immediately re-evaluate space
        }

        const anim = st.player.animId ?? -1;
        const busy = FISHING_ANIMS.has(anim);
        // re-click only when not mid-cast; clicking while the roll loop runs
        // would reset %action_delay and cost ~4 ticks
        if (!busy && Date.now() - lastCatchAt > 400 && Date.now() - lastReclick > 600) {
            const spot = await findSpot(/^lure$/i);
            if (spot) {
                const opt = spot.optionsWithIndex.find(o => /^lure$/i.test(o.text))!;
                await sdk.sendInteractNpc(spot.index, opt.opIndex);
                clicks++;
                lastReclick = Date.now();
            } else {
                await bot.walkTo(LURE_SPOT_POS.x, LURE_SPOT_POS.z, 8);
                lastReclick = Date.now();
            }
        } else if (busy) {
            reclicksBlocked++;
        }
        await new Promise(r => setTimeout(r, busy ? 70 : 40));
    }

    const endXp = sdk.getSkillXp('Fishing') ?? 0;
    const sortedDrops = dropTimes.sort((a, b) => a - b);
    return {
        mode: 'fishing-v2',
        startXp: startXp ?? 0, endXp, gained: endXp - (startXp ?? 0),
        level: sdk.getSkill('Fishing'),
        clicks, drops, sells, dialogs, sellTrips,
        feathersLeft: countItem(/^feather$/i),
        avgDropMs: drops ? +(dropMsTotal / drops).toFixed(1) : 0,
        p95DropMs: sortedDrops.length ? sortedDrops[Math.floor(sortedDrops.length * 0.95)] : 0,
    };
});
