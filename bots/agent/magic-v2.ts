import { runScript } from '../../sdk/runner';
import { pickSpell, runesFor, shoppingList, SPELL_LADDER, UNDEAD_RE } from './_lib/magic-spells';

// magic-v2 — highest-XP/spell-cost continuous caster.
//
// Method (vs magic-best.ts, which spams Wind Strike on a Man until its 15
// starter mind runes run out and then quits):
//   1. Spell ladder from the SERVER content tables (bots/agent/_lib/magic-spells.ts):
//      always cast the highest-XP spell the current level + rune pouch can
//      sustain. Endgame is Crumble Undead (1171): 490 XP/cast — more than
//      double Fire Bolt's 225 — on skeletons/zombies/ghosts (Varrock sewer).
//   2. NO idle ticks: tight cast loop (dismiss UI only when actually blocking,
//      re-acquire target only when it dies), server re-queues early casts so
//      we just keep sending.
//   3. Self-funding resupply: sell starter junk → pickpocket guards/men for
//      coins → buy runes at Aubury (Varrock) → back to casting. The caster
//      never sits idle out of runes.
//
// Env knobs: MAGIC_DURATION_MS (0 = until killed),
//            MAGIC_MIN_COINS   (resupply budget per trip, default 2000).

const AUBURY = { x: 3253, z: 3401 };
// Varrock sewer skeleton room (underground z ≈ 99xx). Entrances tried in order.
const SEWER_ANCHOR = { x: 3248, z: 9914 };
const SEWER_ENTRANCES: Array<{ x: number; z: number }> = [
    { x: 3217, z: 3456 }, // palace-kitchen manhole
    { x: 3226, z: 3464 }, // east drain alternate
];
// Fallback training spot (non-undead) around north Varrock guards/men.
const STREET_SPOT = { x: 3271, z: 3428 };

const JUNK_RE = /^(bronze sword|bronze dagger|wooden shield|shortbow|bronze arrow|small fishing net|bucket|bowl|pot|jug|shears|chisel|hammer|bronze axe|bronze pickaxe|tinderbox|empty cup)$/i;
const FOOD_RE = /bread|shrimp|kebab|cake|cabbage/i;
const PICKPOCKET_RE = /^(guard|man|woman|al-kharid warrior|mugger|thief)$/i;

await runScript(async ({ bot, sdk }) => {
    const DURATION_MS = Number(process.env.MAGIC_DURATION_MS || 0);
    const MIN_COINS = Number(process.env.MAGIC_MIN_COINS || 2000);
    const startedAt = Date.now();

    const magicXp = () => sdk.getSkillXp('Magic') ?? 0;
    const magicLevel = () => sdk.getSkill('Magic')?.level ?? 1;
    const coins = () => sdk.findInventoryItem(/coins/i)?.count ?? 0;

    const heldRunes = () => runesFor(sdk.getInventory());

    function nearestNpc(re: RegExp) {
        return sdk
            .getNearbyNpcs()
            .filter((n) => re.test(n.name))
            .sort((a, b) => a.distance - b.distance)[0] ?? null;
    }

    async function eatIfNeeded() {
        if ((sdk.getState()?.player?.hp ?? 99) >= 10) return;
        const food = sdk.findInventoryItem(FOOD_RE);
        if (food) await bot.eatFood(food).catch(() => {});
    }

    /** Sell everything worthless at the closest general shop. */
    async function liquidateJunk(): Promise<number> {
        const before = coins();
        const shopkeeper = sdk.findNearbyNpc(/shop(keeper)?|assistant/i);
        if (!shopkeeper) return before;
        await bot.openShop(shopkeeper).catch(() => {});
        for (let i = 0; i < 20; i++) {
            const junk = sdk.findInventoryItem(JUNK_RE);
            if (!junk) break;
            await bot.sellToShop(junk.name, 'all').catch(() => {});
        }
        await bot.closeShop().catch(() => {});
        return coins();
    }

    /** Pickpocket until we have `target` coins or the time box expires. */
    async function earnCoins(target: number, maxMs = 90_000): Promise<void> {
        const deadline = Date.now() + maxMs;
        let lastStunAt = 0;
        while (Date.now() < deadline && coins() < target) {
            await bot.dismissBlockingUI();
            if ((sdk.getState()?.player?.hp ?? 99) < 8) {
                const food = sdk.findInventoryItem(FOOD_RE);
                if (food) await bot.eatFood(food).catch(() => {});
                else break;
            }
            const mark = sdk.findNearbyNpc(PICKPOCKET_RE) ?? nearestNpc(/man|woman|guard/i);
            if (!mark) {
                await sdk.waitForTicks(2);
                continue;
            }
            const r = await bot.pickpocketNpc(mark).catch(() => null);
            if (!r?.success && Date.now() - lastStunAt < 1500) {
                await sdk.waitForTicks(4); // stunned — wait it out
            }
            lastStunAt = Date.now();
        }
    }

    /** Buy the level-appropriate rune set with everything we have. */
    async function buyRunes(): Promise<void> {
        await bot.walkTo(AUBURY.x, AUBURY.z, 2).catch(() => {});
        await bot.dismissBlockingUI();
        const aubury = sdk.findNearbyNpc(/aubury/i);
        if (!aubury) return;
        await bot.openShop(aubury).catch(() => {});
        const list = shoppingList(magicLevel(), coins());
        for (const want of list) {
            if (want.count <= 0) continue;
            const held = sdk.findInventoryItem(new RegExp(`^${want.rune}$`, 'i'))?.count ?? 0;
            const buy = Math.min(want.count, Math.floor(coins() / 10));
            if (buy <= held) continue;
            await bot.buyFromShop(new RegExp(`^${want.rune}$`, 'i'), buy - held).catch(() => {});
        }
        await bot.closeShop().catch(() => {});
    }

    /** Get within casting range of a valid target pool for `undead` spells. */
    async function ensureTargets(undead: boolean): Promise<boolean> {
        const re = undead ? UNDEAD_RE : PICKPOCKET_RE;
        if (nearestNpc(re)) return true;
        const anchors = undead ? [...SEWER_ENTRANCES, SEWER_ANCHOR] : [STREET_SPOT];
        for (const a of anchors) {
            await bot.walkTo(a.x, a.z, 5).catch(() => {});
            await bot.dismissBlockingUI();
            if (nearestNpc(re)) return true;
            // Sewer entrances need opening (manhole/drain/ladder).
            const door = sdk.findNearbyLoc(/manhole|drain|ladder|staircase|stairs/i, { reachable: true });
            if (door) {
                await bot.interactLoc(door, /^(open|climb|climb-down)/i).catch(() => {});
                await sdk.waitForTicks(3);
            }
            if (nearestNpc(re)) return true;
        }
        return false;
    }

    const stats = { casts: 0, resupplies: 0, earnedMs: 0 };

    console.log(
        `[magic-v2] start lvl=${magicLevel()} xp=${magicXp()} coins=${coins()} ` +
            `runes=${JSON.stringify(heldRunes())}`,
    );

    // ── bootstrap: turn starter junk into rune money once ──────────────────
    if (coins() < 500) {
        await liquidateJunk();
        console.log(`[magic-v2] junk sold, coins=${coins()}`);
    }

    // ── main loop ──────────────────────────────────────────────────────────
    while (true) {
        if (DURATION_MS && Date.now() - startedAt > DURATION_MS) break;
        try {
            const level = magicLevel();
            const undeadHere = !!nearestNpc(UNDEAD_RE);
            const spell = pickSpell(level, heldRunes(), undeadHere);

            if (!spell) {
                // Out of level-appropriate runes — fund + resupply + return.
                const tEarn = Date.now();
                if (coins() < MIN_COINS) await earnCoins(MIN_COINS);
                stats.earnedMs += Date.now() - tEarn;
                await buyRunes();
                stats.resupplies++;
                const after = pickSpell(magicLevel(), heldRunes(), true);
                if (!after) {
                    // Still nothing castable (no coins?) — fall back to
                    // wind strikes bought one-by-one, else brief pause to
                    // avoid a hot spin loop.
                    await sdk.waitForTicks(5);
                }
                continue;
            }

            if (!(await ensureTargets(spell.undeadOnly))) {
                await sdk.waitForTicks(3);
                continue;
            }

            // ── continuous cast burst: no idle ticks ──────────────────────
            let target = nearestNpc(spell.undeadOnly ? UNDEAD_RE : /./);
            const burstStart = magicXp();
            for (let sinceAcquire = 0; sinceAcquire < 200; sinceAcquire++) {
                if (DURATION_MS && Date.now() - startedAt > DURATION_MS) break;
                await eatIfNeeded();
                await bot.dismissBlockingUI();
                if (!pickSpell(magicLevel(), heldRunes(), spell.undeadOnly ? !!nearestNpc(UNDEAD_RE) : false)) break;
                // Re-acquire only when the current target vanished/died.
                if (!target || !sdk.getNearbyNpcs().some((n) => n.index === target!.index)) {
                    target = nearestNpc(spell.undeadOnly ? UNDEAD_RE : /./);
                    if (!target) break;
                    sinceAcquire = 0;
                }
                if (target.distance > 8) {
                    await bot.walkTo(target.x, target.z, 2).catch(() => {});
                }
                const sent = await sdk.sendSpellOnNpc(target.index, spell.id);
                if (sent.success) stats.casts++;
                // Server re-queues early casts; 2 ticks keeps the pipe full
                // without flooding the gateway.
                await sdk.waitForTicks(2);
            }
            const gained = magicXp() - burstStart;
            if (gained > 0) {
                console.log(
                    `[magic-v2] ${spell.name} burst +${gained} raw xp | lvl=${magicLevel()} ` +
                        `casts=${stats.casts} coins=${coins()} t=${Math.round((Date.now() - startedAt) / 1000)}s`,
                );
            }
        } catch (e: any) {
            console.error('[magic-v2] error:', e?.message ?? e);
            await sdk.waitForTicks(2).catch(() => {});
        }
    }

    return {
        magic: sdk.getSkill('Magic'),
        casts: stats.casts,
        resupplies: stats.resupplies,
        ladder: SPELL_LADDER.length,
        elapsedMs: Date.now() - startedAt,
    };
});
