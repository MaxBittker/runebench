import { runScript } from '../../sdk/runner';

// hitpoints-v2 — pure Hitpoints XP trainer.
//
// Hitpoints XP = 1.33 × every point of damage DEALT, regardless of combat
// style, so the optimal method is simply maximum sustained damage-per-minute
// against mobs that cannot kill us. Damage TAKEN grants nothing — it only
// threatens uptime (deaths cost minutes) — so survival is managed with cheap
// food, not by picking weaker targets.
//
// Method (vs hitpoints-best.ts, which fights the nearest COW with fixed
// 2.0–2.5 s sleeps, walks back to the field whenever the scan comes up empty,
// and hard-stops after 4 minutes / 2000 xp):
//
//   SETUP (time-budgeted, every step individually optional):
//     1. Equip the best weapon we already carry (DPS = HP xp).
//     2. Pickpocket Men until HITPOINTS_STEEL_COINS (default 430gp).
//     3. Pay the Al Kharid toll, buy Steel scimitar at Zeke's (or Iron at
//        112gp if short) — faster kills = faster HP xp — and equip it.
//     4. Spend the rest on kebabs (1gp, heals 1–19): the efficient regen
//        loop. Natural regen is far too slow to sustain combat; a 1gp kebab
//        bought mid-trip costs ~1 tick of uptime per 3-19 HP restored.
//   FARM:
//     5. Fight Al-Kharid warriors (lvl 9, 19hp, dense aggressive cluster):
//        they re-engage us automatically, so between-kill downtime ≈ 0.
//        Cow field / Lumbridge courtyard are fallback anchors.
//     6. Target scoring recomputed EVERY state frame, tuned for HP xp:
//          - finishing an already-damaged NPC first (its remaining HP was
//            already paid for — best xp per swing);
//          - low maxHp next (fast kill → fast next target);
//          - distance as final tiebreak (less walking = more swinging).
//     7. Zero-downtime retarget: no sleeps while out of combat. The instant
//        the server reports no target / NPC gone / 0% health, the next-best
//        candidate is clicked in the SAME iteration. If combat silently
//        drops we re-click the CURRENT target before relocating.
//     8. Efficient regen/survival: eat a kebab under
//        HITPOINTS_HP_EAT_FRACTION of max HP (eating costs ~1 combat swing,
//        so the threshold balances food ticks against death risk); if we
//        die anyway, walk back to the nearest farm anchor automatically.
//
// Optional env: HITPOINTS_DURATION_MS (0 = until killed),
//               HITPOINTS_SETUP_BUDGET_MS (default 480000),
//               HITPOINTS_MAX_ENGAGE_TILES (default 12),
//               HITPOINTS_HP_EAT_FRACTION (default 0.6),
//               HITPOINTS_STEEL_COINS (default 430).

await runScript(async ({ bot, sdk }) => {
    const DURATION_MS = Number(process.env.HITPOINTS_DURATION_MS || 0);
    const SETUP_BUDGET_MS = Number(process.env.HITPOINTS_SETUP_BUDGET_MS || 480_000);
    const MAX_ENGAGE_TILES = Number(process.env.HITPOINTS_MAX_ENGAGE_TILES || 12);
    const HP_EAT_FRACTION = Number(process.env.HITPOINTS_HP_EAT_FRACTION || 0.6);
    const STEEL_COINS = Number(process.env.HITPOINTS_STEEL_COINS || 430);
    const startedAt = Date.now();
    const setupDeadline = startedAt + SETUP_BUDGET_MS;

    // Farm anchors in priority order (warrior cluster first — aggressive,
    // dense, so they restart combat on us for free; cows as safe fallback).
    let ANCHORS: Array<[number, number]> = [
        [3282, 3176], // Al-Kharid warrior palace
        [3256, 3287], // cow field east of Lumbridge
        [3222, 3218], // Lumbridge castle courtyard (men/rats)
    ];

    const ATTACK_RE = /attack/i;
    const COIN_RE = /coin/i;
    const FOOD_RE = /kebab/i;
    const WEAPONS: Array<[RegExp, number]> = [
        [/mithril scimitar/i, 20],
        [/steel scimitar/i, 5],
        [/iron scimitar/i, 1],
        [/bronze scimitar/i, 1],
        [/(sword|scimitar|longsword|axe)$/i, 1],
    ];

    const hpXp = () => sdk.getSkillXp('Hitpoints') ?? 0;
    const coins = () => sdk.countInventoryItems(COIN_RE);
    const log = (...a: unknown[]) => console.log('[hp-v2]', ...a);
    const stats = { attacks: 0, kills: 0, reclicks: 0, eats: 0, walks: 0, picks: 0 };

    async function equipBestWeapon(): Promise<boolean> {
        const level = sdk.getSkill('Attack')?.level ?? 1;
        for (const [re, req] of WEAPONS) {
            if (level < req) continue;
            const w = sdk.findInventoryItem(re);
            if (!w) continue;
            await bot.equipItem(w).catch(() => {});
            log('equipped', w.name);
            return true;
        }
        return false;
    }

    function hasBetterWeaponEquipped(): boolean {
        return !!sdk.findEquipmentItem(/scimitar/i);
    }

    // ── SETUP phase ────────────────────────────────────────────────────────
    async function pickpocketMen(untilCoins: number): Promise<void> {
        let fails = 0;
        while (Date.now() < setupDeadline && coins() < untilCoins && fails < 30) {
            try {
                await bot.dismissBlockingUI().catch(() => {});
                const man =
                    sdk.findNearbyNpc(/^man$/i, { withOption: /pick\s?pocket/i }) ??
                    sdk.getNearbyNpcs().find((n) => /^man$/i.test(n.name) && n.optionsWithIndex.some((o) => /pick\s?pocket/i.test(o.text)));
                if (!man) {
                    await bot.walkTo(3223, 3221, 4).catch(() => {});
                    await sdk.waitForTicks(2).catch(() => {});
                    continue;
                }
                const before = coins();
                const r = await bot.pickpocketNpc(man).catch(() => null);
                if (r?.success) stats.picks++;
                if (r && 'stunned' in r && r.stunned) await Bun.sleep(1500);
                if (coins() === before && ++fails % 10 === 0) {
                    log(`pickpocket stalled (${fails} fails, ${coins()}gp)`);
                    await bot.walkTo(3227, 3226, 3).catch(() => {});
                }
                await sdk.waitForTicks(1).catch(() => {});
            } catch (e: any) {
                if (++fails > 40) break;
                await Bun.sleep(300);
            }
        }
    }

    async function payTollAndCross(): Promise<boolean> {
        const p = sdk.getState()?.player;
        if (!p) return false;
        // Already east of the gate?
        if (p.worldX > 3270 && p.worldZ < 3230) return true;
        await bot.walkTo(3267, 3228, 2).catch(() => {});
        for (let attempt = 0; attempt < 3; attempt++) {
            const gate = sdk.getState()?.nearbyLocs.find((l) => /gate/i.test(l.name));
            if (!gate) break;
            await sdk.sendInteractLoc(gate.x, gate.z, gate.id, 1).catch(() => {});
            await sdk.waitForTicks(2).catch(() => {});
            for (let i = 0; i < 10; i++) {
                const s = sdk.getState();
                if (!s?.dialog.isOpen) {
                    await Bun.sleep(200);
                    continue;
                }
                const yes = s.dialog.options.find((o) => /yes|pay/i.test(o.text));
                await sdk.sendClickDialog(yes?.index ?? 0).catch(() => {});
                await sdk.waitForTicks(1).catch(() => {});
            }
            await bot.walkTo(3277, 3227, 3).catch(() => {});
            const now = sdk.getState()?.player;
            if (now && now.worldX > 3270) return true;
        }
        // Last resort: plain pathfind across (SDK opens doors along the way).
        await bot.walkTo(3288, 3190, 8).catch(() => {});
        const now = sdk.getState()?.player;
        return !!now && now.worldX > 3270;
    }

    async function buyScimitar(): Promise<boolean> {
        await bot.walkTo(3288, 3190, 4).catch(() => {});
        const opened = await bot.openShop(/zeke/i).catch(() => null);
        if (!opened?.success) {
            log('failed to open Zeke shop');
            return false;
        }
        const wantSteel = coins() >= 400 + 10;
        const bought = await bot
            .buyFromShop(wantSteel ? /steel scimitar/i : /iron scimitar/i, 1)
            .catch(() => null);
        await bot.closeShop().catch(() => {});
        if (!bought?.success) {
            // Fall back to whatever we can afford.
            await bot.openShop(/zeke/i).catch(() => {});
            await bot.buyFromShop(/bronze scimitar/i, 1).catch(() => {});
            await bot.closeShop().catch(() => {});
        }
        return hasBetterWeaponEquipped() || !!(await equipBestWeapon());
    }

    async function buyKebabs(maxKebabs = 20): Promise<void> {
        let bought = 0;
        while (bought < maxKebabs && Date.now() < setupDeadline && coins() >= 15) {
            try {
                const seller = sdk.getNearbyNpcs().find((n) => /kebab/i.test(n.name));
                if (!seller) {
                    await bot.walkTo(3273, 3180, 3).catch(() => {});
                    continue;
                }
                const talkOpt = seller.optionsWithIndex.find((o) => /talk/i.test(o.text));
                if (!talkOpt) break;
                await sdk.sendInteractNpc(seller.index, talkOpt.opIndex);
                let done = false;
                for (let i = 0; i < 15 && !done; i++) {
                    const s = sdk.getState();
                    if (!s?.dialog.isOpen) {
                        await Bun.sleep(200);
                        continue;
                    }
                    const buy = s.dialog.options.find((o) => /yes/i.test(o.text));
                    if (buy) {
                        await sdk.sendClickDialog(buy.index).catch(() => {});
                        done = true;
                    } else {
                        await sdk.sendClickDialog(0).catch(() => {});
                        await Bun.sleep(250);
                    }
                }
                if (!done) break;
                bought++;
                await sdk.waitForTicks(1).catch(() => {});
            } catch {
                break;
            }
        }
        log(`bought ${bought} kebaps`);
    }

    async function setup(): Promise<void> {
        await bot.dismissBlockingUI().catch(() => {});
        // Style choice does not change HP xp (1.33/dmg always) — pin style 0
        // so the fastest anim set applies and nothing random is active.
        await sdk.sendSetCombatStyle(0).catch(() => {});
        await equipBestWeapon();

        if (Date.now() >= setupDeadline) return;
        if (!hasBetterWeaponEquipped()) {
            log(`pickpocketing men to ${STEEL_COINS}gp (have ${coins()})`);
            await pickpocketMen(STEEL_COINS);
        }
        if (Date.now() >= setupDeadline) return;

        if (!hasBetterWeaponEquipped()) {
            log(`crossing toll gate with ${coins()}gp`);
            if (await payTollAndCross()) {
                ANCHORS = [[3282, 3176], [3256, 3287], [3222, 3218]];
                if (coins() >= 122) await buyScimitar();
                if (coins() >= 15) await buyKebabs();
                await bot.walkTo(3282, 3176, 6).catch(() => {});
            }
        } else if (sdk.countInventoryItems(FOOD_RE) === 0 && coins() >= 50) {
            // Already across the gate with a weapon but no food — top up.
            if (coins() >= 15) await buyKebabs();
        }
        log(`setup done: ${coins()}gp, equipped=${JSON.stringify(sdk.getEquipment()?.map((e) => e?.name))}`);
    }

    // ── FARM phase ─────────────────────────────────────────────────────────
    interface Candidate {
        index: number;
        score: number;
        opIndex: number;
    }

    /** Score candidates; lower score = attacked first. Recomputed each frame. */
    function candidates(): Candidate[] {
        const s = sdk.getState();
        if (!s?.nearbyNpcs) return [];
        const out: Candidate[] = [];
        for (const n of s.nearbyNpcs) {
            if (n.distance > MAX_ENGAGE_TILES) continue;
            if (n.reachable === false) continue;
            const op = n.optionsWithIndex.find((o) => ATTACK_RE.test(o.text));
            if (!op) continue;
            // HP-xp weighting: finishing a damaged NPC converts already-
            // invested swings into XP almost immediately; low maxHp keeps
            // kill frequency high (each kill = full 19×1.33xp for warriors);
            // distance is the last tiebreak (less walking, more swinging).
            const hpPct = n.healthPercent ?? 100;
            const maxHp = n.maxHp ?? n.combatLevel ?? 5;
            const busyElsewhere = n.inCombat && n.targetIndex !== -1 ? 40 : 0;
            const score = hpPct * 1.0 + maxHp * 1.5 + n.distance * 2 + busyElsewhere;
            out.push({ index: n.index, score, opIndex: op.opIndex });
        }
        return out.sort((a, b) => a.score - b.score);
    }

    async function tryEat(): Promise<boolean> {
        const s = sdk.getState();
        if (!s?.player) return false;
        if (s.player.hp > Math.max(4, s.player.maxHp * HP_EAT_FRACTION)) return false;
        const food = sdk.findInventoryItem(FOOD_RE) ?? sdk.findInventoryItem(/(bread|shrimp|herring|meat)/i);
        if (!food) return false;
        await bot.eatFood(food).catch(() => {});
        stats.eats++;
        return true;
    }

    async function relocate(): Promise<void> {
        const p = sdk.getState()?.player;
        if (!p) return;
        let best = ANCHORS[0]!;
        let bestD = Infinity;
        for (const [ax, az] of ANCHORS) {
            const d = Math.hypot(p.worldX - ax, p.worldZ - az);
            if (d < bestD && d > 6) {
                bestD = d;
                best = [ax, az];
            }
        }
        stats.walks++;
        log(`relocating to (${best[0]},${best[1]}) d=${bestD.toFixed(0)} tiles`);
        await bot.walkTo(best[0], best[1], 5).catch(() => {});
    }

    await setup();

    let curTarget = -1;
    let lastXp = hpXp();
    let startXp = hpXp();
    let sendFails = 0;
    let reportCount = 0;
    while (true) {
        if (DURATION_MS && Date.now() - startedAt > DURATION_MS) break;
        try {
            const s = sdk.getState();
            if (!s?.inGame || !s.player) {
                await Bun.sleep(500);
                continue;
            }
            await tryEat();

            // Death recovery: respawned away from the farm → walk back.
            if (s.player.isDead) {
                curTarget = -1;
                await sdk.waitForStateChange(3000).catch(() => {});
                continue;
            }

            const inCombat = s.player.combat.inCombat || s.player.combat.targetIndex !== -1;
            // Adopt an untracked engagement (e.g. right after setup or an
            // aggressive warrior starting on us): clicking another NPC now
            // would just bounce off "already under attack".
            if (inCombat && curTarget === -1 && s.player.combat.targetType === 'npc') {
                curTarget = s.player.combat.targetIndex;
                stats.attacks++;
            }
            const cands = candidates();

            // Kill detection: our tracked target is gone, dead, or 0% health →
            // instantly re-pick the next-best candidate in this same frame.
            const curNpc = s.nearbyNpcs.find((n) => n.index === curTarget);
            const stillThere = curTarget !== -1 && !!cands.some((c) => c.index === curTarget) && (curNpc?.healthPercent ?? 0) > 0;

            if (curTarget !== -1 && !stillThere) {
                stats.kills++;
                curTarget = -1;
                const gained = hpXp() - lastXp;
                lastXp = hpXp();
                if (++reportCount % 10 === 0) {
                    const mins = (Date.now() - startedAt) / 60000;
                    log(
                        `${Math.round((Date.now() - startedAt) / 1000)}s lvl=${sdk.getSkill('Hitpoints')?.level} ` +
                            `hpXp=+${hpXp() - startXp} (${Math.round((hpXp() - startXp) / Math.max(mins, 0.01))}/min raw) ` +
                            `kills=${stats.kills} (+${gained})`,
                    );
                }
            }

            if (curTarget !== -1 && inCombat) {
                // Fighting: just observe the next state frame.
                await sdk.waitForStateChange(1500).catch(() => {});
                continue;
            }

            if (curTarget === -1 || !stillThere || !inCombat) {
                const next = cands[0];
                if (!next) {
                    if (++sendFails >= 3) {
                        sendFails = 0;
                        await relocate();
                    } else {
                        await sdk.waitForTicks(2).catch(() => {});
                    }
                    continue;
                }
                const sent = await sdk.sendInteractNpc(next.index, next.opIndex);
                if (sent.success) {
                    sendFails = 0;
                    if (next.index !== curTarget) stats.attacks++;
                    else stats.reclicks++;
                    curTarget = next.index;
                } else if (++sendFails >= 3) {
                    sendFails = 0;
                    await relocate();
                }
                await sdk.waitForTicks(1).catch(() => {});
            } else {
                await sdk.waitForStateChange(1500).catch(() => {});
            }
        } catch (e: any) {
            console.error('[hp-v2] error:', e?.message ?? e);
            await Bun.sleep(300);
        }
    }
    return {
        hitpoints: sdk.getSkill('Hitpoints'),
        hpXpGained: hpXp() - startXp,
        attack: sdk.getSkill('Attack'),
        stats,
        elapsedMs: Date.now() - startedAt,
    };
});
