/**
 * freshStart() — reset a connected bot to the GP benchmark starting state.
 *
 * Uses in-game cheat commands (::setstat, ::give, ::unstuck) to set up the
 * character live — no save file regeneration or reconnection needed.
 *
 * Usage inside execute_code:
 *
 *   const { freshStart } = await import('/app/benchmark/shared/gp_fresh_start.ts');
 *   await freshStart();
 *   // Bot is now at Lumbridge, level 50 all skills (55 Magic), with starting gear
 *
 * Call this at the top of every bot script before doing anything else.
 */

const SKILLS_TO_SET: Array<[string, number]> = [
    ['attack',      50],
    ['defence',     50],
    ['strength',    50],
    ['hitpoints',   50],
    ['magic',       55],  // 55 = High Level Alchemy
    ['ranged',      50],
    ['prayer',      50],
    ['woodcutting', 50],
    ['fishing',     50],
    ['mining',      50],
    ['cooking',     50],
    ['crafting',    50],
    ['smithing',    50],
    ['firemaking',  50],
    ['fletching',   50],
    ['thieving',    50],
    ['runecrafting',50],
    ['herblore',    50],
    ['agility',     50],
];

const ITEMS_TO_GIVE: Array<[string, number]> = [
    ['rune_axe',        1],
    ['knife',           1],
    ['tinderbox',       1],
    ['small_fishing_net', 1],
    ['hammer',          1],
    ['nature_rune',     1000],
];

// Staff of fire: item ID 1387, equip to weapon slot (slot 3)
const STAFF_OF_FIRE_ID = 1387;
const STAFF_OF_FIRE_NAME = 'staff_of_fire';

async function cheat(cmd: string): Promise<void> {
    await sdk.sendSay(`::${cmd}`);
    await sdk.waitForTicks(2);
}

export async function freshStart(): Promise<void> {
    console.log('[freshStart] Resetting bot to GP benchmark starting state...');

    // 1. Teleport to Lumbridge
    await cheat('unstuck');
    console.log('[freshStart] Teleported to Lumbridge');

    // 2. Set all skills
    for (const [skill, level] of SKILLS_TO_SET) {
        await cheat(`setstat ${skill} ${level}`);
    }
    console.log('[freshStart] Skills set to level 50 (Magic 55)');

    // 3. Clear inventory (drop everything)
    const inv = sdk.getInventory();
    for (let i = inv.length - 1; i >= 0; i--) {
        await sdk.sendDropItem(i);
        await sdk.waitForTicks(1);
    }
    console.log('[freshStart] Inventory cleared');

    // 4. Give starting items
    for (const [item, count] of ITEMS_TO_GIVE) {
        await cheat(`give ${item} ${count}`);
    }
    console.log('[freshStart] Starting items given');

    // 5. Give and equip staff of fire
    await cheat(`give ${STAFF_OF_FIRE_NAME} 1`);
    await sdk.waitForTicks(2);
    const staffSlot = sdk.getInventory().findIndex(i => i.id === STAFF_OF_FIRE_ID);
    if (staffSlot !== -1) {
        await bot.equipItem(STAFF_OF_FIRE_ID);
        console.log('[freshStart] Staff of fire equipped');
    } else {
        console.warn('[freshStart] WARNING: Staff of fire not found in inventory after give');
    }

    // 6. Verify state
    await sdk.waitForTicks(3);
    const state = sdk.getState();
    const skills = sdk.getSkills();
    const atk = skills.find(s => s.name.toUpperCase() === 'ATTACK');
    const magic = skills.find(s => s.name.toUpperCase() === 'MAGIC');
    const pos = `(${state?.player?.worldX}, ${state?.player?.worldZ})`;

    console.log(`[freshStart] Done. Pos=${pos} Attack=${atk?.baseLevel} Magic=${magic?.baseLevel} Inv=${sdk.getInventory().length} items`);

    if (!atk || atk.baseLevel < 50) {
        console.warn('[freshStart] WARNING: Attack level is wrong:', atk?.baseLevel);
    }
}
