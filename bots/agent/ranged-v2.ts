import { runScript } from '../../sdk/runner';

// ranged-v2 — ranged-style trainer vs low-defense mobs at max bow range,
// with instant retarget and an ammo-safe loop (vs ranged-best.ts, which buys
// gear, then locks onto the nearest cow in a 240s fixed window with a flat
// 2.5s sleep every iteration and no style control).
//
// Method:
//   1. Ranged combat style pinned from the live combat tab: pick the style
//      whose trainsSkills includes "Ranged", preferring "Rapid" (fastest
//      attack interval = most damage-ticks per minute = most Ranged XP,
//      since Ranged XP is granted per point of damage).
//   2. Gear-safe start: buy shortbow + bronze arrows at Lowe's (Varrock east)
//      only when neither inventory nor equipment has them; equip both.
//   3. Target scoring recomputed EVERY state frame over low-defense mobs
//      (Attack option present, within MAX_ENGAGE_TILES — bow range):
//        - finishing kills first: an NPC already damaged dies in 1-2 hits;
//        - otherwise low maxHp first (fast kill, less overkill waste);
//        - nearest distance breaks ties so we never walk past a target.
//   4. Zero-downtime retarget: the loop never sleeps while out of combat.
//      The instant the server reports the target gone/dead, the next-best
//      candidate is clicked in the SAME iteration — no fixed sleep, no
//      stale index reuse.
//   5. Ammo-safe loop: every frame verifies arrows are equipped; re-equips
//      from inventory if they fell out; picks up ground arrows when we run
//      dry nearby; if NO arrows remain anywhere, exits cleanly with an
//      out-of-ammo report instead of spinning on dead clicks.
//   6. Survival: eat food under HP_EAT_FRACTION of max HP; dismiss blocking
//      UI every frame.
//
// Optional env: RANGED_DURATION_MS (stop cleanly after this long; 0 = until killed),
//               RANGED_MAX_ENGAGE_TILES (default 8, shortbow range),
//               RANGED_HP_EAT_FRACTION (default 0.5).

await runScript(async ({ bot, sdk }) => {
    const DURATION_MS = Number(process.env.RANGED_DURATION_MS || 0);
    const MAX_ENGAGE_TILES = Number(process.env.RANGED_MAX_ENGAGE_TILES || 8);
    const HP_EAT_FRACTION = Number(process.env.RANGED_HP_EAT_FRACTION || 0.5);
    const startedAt = Date.now();

    // Known dense low-defense clusters (Lumbridge area). Only used when
    // nothing attackable is within MAX_ENGAGE_TILES.
    const ANCHORS: Array<[number, number]> = [
        [3256, 3287], // cow field east of Lumbridge
        [3241, 3292], // cows/goblins across the river
        [3222, 3218], // Lumbridge castle courtyard (men/rats)
        [3260, 3228], // chickens north-east
    ];

    const ATTACK_RE = /attack/i;
    const ARROW_RE = /arrow/i;
    const BOW_RE = /bow/i;
    const FOOD_RE = /(bread|shrimp|sardine|herring|mackerel|meat|chicken|kebab|cake|pie|stew|pizza|potato|apple|banana|cheese|tomato|egg|wine)/i;

    const rangedXp = (): number => sdk.getSkillXp('Ranged') ?? 0;
    const arrowCount = () => {
        const equipped = sdk.getState()?.equipment.find((e) => ARROW_RE.test(e.name));
        return (equipped?.count ?? 0) + sdk.countInventoryItems(ARROW_RE);
    };

    let curTarget = -1;
    let lastXp = rangedXp();
    let ammoReported = false;
    const stats = { attacks: 0, kills: 0, reclicks: 0, eats: 0, walks: 0, rearms: 0, pickups: 0 };
    let outOfAmmo = false;

    /** Pin the fastest Ranged style from the live combat tab (once). */
    async function setupGearAndStyle(): Promise<void> {
        const s = sdk.getState();
        if (!s) return;

        // Buy bow+arrows at Lowe's when we have neither.
        const hasBow = sdk.findInventoryItem(BOW_RE) || sdk.findEquipmentItem(BOW_RE);
        const hasArrows = arrowCount() > 0;
        if (!hasBow || !hasArrows) {
            await bot.walkTo(3232, 3423, 3).catch(() => {});
            const lowe = sdk.findNearbyNpc(/lowe/i);
            const opt = lowe?.optionsWithIndex?.find((o) => /trade/i.test(o.text));
            if (lowe && opt) {
                await sdk.sendInteractNpc(lowe.index, opt.opIndex);
                await Bun.sleep(4000);
                if (sdk.getState()?.shop?.isOpen) {
                    if (!hasBow) await bot.buyFromShop(/shortbow/i, 1).catch(() => {});
                    if (!hasArrows) await bot.buyFromShop(/bronze arrow/i, 100).catch(() => {});
                    await bot.closeShop().catch(() => {});
                }
            }
        }

        for (const pattern of [BOW_RE]) {
            const w = sdk.findInventoryItem(pattern);
            if (w) await bot.equipItem(w).catch(() => {});
        }
        const invArr = sdk.findInventoryItem(ARROW_RE);
        const eqArr = sdk.findEquipmentItem(ARROW_RE);
        if (invArr && !eqArr) await bot.equipItem(invArr).catch(() => {});

        // Ranged style: prefer Rapid (shortest attack interval).
        try {
            const styles = sdk.getState()?.combatStyle?.styles ?? [];
            const rangedStyles = styles.filter((st) => st.trainsSkills.includes('Ranged'));
            const rapid = rangedStyles.find((st) => st.type === 'Rapid') ?? rangedStyles[0];
            if (rapid) await sdk.sendSetCombatStyle(rapid.index);
        } catch {
            /* non-fatal */
        }
    }

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
            // Finishing a damaged NPC is nearly free XP: weight current HP
            // heavily, then max HP (kill speed / low defence), then distance.
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
        if (s.player.hp > Math.max(3, s.player.maxHp * HP_EAT_FRACTION)) return false;
        const food = sdk.findInventoryItem(FOOD_RE);
        if (!food) return false;
        await bot.eatFood(food).catch(() => {});
        stats.eats++;
        return true;
    }

    /**
     * Ammo safety net. Returns false only when we are truly dry: nothing
     * equipped, nothing in inventory, and no ground arrows worth grabbing.
     */
    async function ensureAmmo(): Promise<boolean> {
        const eqArr = sdk.findEquipmentItem(ARROW_RE);
        const invArr = sdk.findInventoryItem(ARROW_RE);
        if (invArr && !eqArr) {
            await bot.equipItem(invArr).catch(() => {});
            stats.rearms++;
            return true;
        }
        if ((eqArr?.count ?? 0) > 0 || invArr) return true;

        // Dry: grab ground arrows dropped nearby before giving up.
        const ground = sdk.getGroundItems().filter((g) => ARROW_RE.test(g.name) && g.distance <= MAX_ENGAGE_TILES);
        const nearest = ground[0];
        if (nearest) {
            await bot.pickupItem(nearest).catch(() => {});
            stats.pickups++;
            return true;
        }
        return false;
    }

    /** Walk toward whichever anchor has most attackable NPCs nearby. */
    async function relocate(): Promise<void> {
        const p = sdk.getState()?.player;
        if (!p) return;
        let best = ANCHORS[0]!;
        let bestD = Infinity;
        for (const [ax, az] of ANCHORS) {
            const d = Math.hypot(p.worldX - ax, p.worldZ - az);
            if (d < bestD && d > 4) {
                bestD = d;
                best = [ax, az];
            }
        }
        stats.walks++;
        console.log(`[rng-v2] relocating to (${best[0]},${best[1]}) d=${bestD.toFixed(0)} tiles`);
        await bot.walkTo(best[0], best[1], 4).catch(() => {});
    }

    await setupGearAndStyle();

    // ── main loop ──────────────────────────────────────────────────────────
    let frames = 0;
    while (true) {
        if (DURATION_MS && Date.now() - startedAt > DURATION_MS) break;
        try {
            const s = sdk.getState();
            if (!s?.inGame || !s.player) {
                await Bun.sleep(500);
                continue;
            }
            await bot.dismissBlockingUI().catch(() => {});
            if (s.player.isDead) break;

            if (!(await ensureAmmo())) {
                if (!ammoReported) {
                    console.log('[rng-v2] out of arrows — stopping cleanly');
                    ammoReported = true;
                    outOfAmmo = true;
                }
                break;
            }
            await tryEat();

            const inCombat = s.player.combat.inCombat || s.player.combat.targetIndex !== -1;
            const cands = candidates();

            // Kill detection: our tracked target is gone, dead, or combat ended.
            const stillThere =
                curTarget !== -1 &&
                cands.some((c) => c.index === curTarget) &&
                (s.nearbyNpcs.find((n) => n.index === curTarget)?.healthPercent ?? 0) > 0;

            if (!stillThere && curTarget !== -1) {
                stats.kills++;
                curTarget = -1; // instant retarget below, same frame
                const gained = rangedXp() - lastXp;
                lastXp = rangedXp();
                if (gained > 0 && stats.kills % 5 === 0) {
                    const mins = (Date.now() - startedAt) / 60000;
                    console.log(
                        `[rng-v2] ${Math.round((Date.now() - startedAt) / 1000)}s lvl=${sdk.getSkill('Ranged')?.level} ` +
                            `xp=${rangedXp()} kills=${stats.kills} arrows=${arrowCount()} rate~${Math.round(gained / mins)}/min`,
                    );
                }
            }

            if (curTarget !== -1 && inCombat) {
                // Fighting: just observe the next state frame.
                await sdk.waitForStateChange(1500).catch(() => {});
                continue;
            }

            if (curTarget === -1 || !stillThere) {
                const next = cands[0];
                if (!next) {
                    await relocate();
                    continue;
                }
                if (next.index !== curTarget || !inCombat) {
                    const sent = await sdk.sendInteractNpc(next.index, next.opIndex);
                    if (sent.success) {
                        if (next.index !== curTarget) stats.attacks++;
                        else stats.reclicks++;
                        curTarget = next.index;
                    } else if (++frames % 20 === 0) {
                        // Repeated send failure — move somewhere useful.
                        await relocate();
                    }
                }
                await sdk.waitForTicks(1).catch(() => {});
            } else {
                await sdk.waitForStateChange(1500).catch(() => {});
            }
        } catch (e: any) {
            console.error('[rng-v2] error:', e?.message ?? e);
            await Bun.sleep(300);
        }
    }
    return {
        ranged: sdk.getSkill('Ranged'),
        hitpoints: sdk.getSkill('Hitpoints'),
        stats,
        outOfAmmo,
        elapsedMs: Date.now() - startedAt,
    };
});
