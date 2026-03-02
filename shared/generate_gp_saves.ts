/**
 * Generate save files for the GP benchmark task.
 * Creates 10 bot saves (2 bots x 5 loops) with level 50 in all skills
 * (55 Magic for High Level Alchemy), starting in Lumbridge with tools and runes.
 *
 * Naming: l{loop}a{bot} — e.g. l1a1, l1a2
 * Each loop gets fresh usernames to avoid server caching issues.
 *
 * Usage: bun run benchmark/shared/generate_gp_saves.ts
 */
import { generateSave } from '../../sdk/test/utils/save-generator';

const ALL_SKILLS: Record<string, number> = {
  ATTACK: 50,
  STRENGTH: 50,
  DEFENCE: 50,
  HITPOINTS: 50,
  MAGIC: 55,     // 55 enables High Level Alchemy
  RANGED: 50,
  PRAYER: 50,
  WOODCUTTING: 50,
  FISHING: 50,
  MINING: 50,
  COOKING: 50,
  CRAFTING: 50,
  SMITHING: 50,
  FIREMAKING: 50,
  FLETCHING: 50,
  THIEVING: 50,
  RUNECRAFT: 50,
  HERBLORE: 50,
  AGILITY: 50,
};

// Starting inventory — gives strategic optionality
const STARTING_INVENTORY = [
  { id: 1359, count: 1 },   // Rune axe (woodcutting — level 41 req)
  { id: 946, count: 1 },    // Knife (fletching)
  { id: 590, count: 1 },    // Tinderbox (firemaking/cooking)
  { id: 303, count: 1 },    // Small fishing net (fishing)
  { id: 2347, count: 1 },   // Hammer (smithing)
  { id: 561, count: 1000 }, // Nature runes (alchemy — stackable)
];

// Staff of fire equipped — unlimited fire runes for alchemy
const STARTING_EQUIPMENT = [
  { id: 1387, count: 1, slot: 3 },  // Staff of fire in weapon slot
];

const LOOPS = 5;
const BOTS_PER_LOOP = 2;

async function main() {
  let count = 0;
  for (let loop = 1; loop <= LOOPS; loop++) {
    for (let bot = 1; bot <= BOTS_PER_LOOP; bot++) {
      const username = `l${loop}a${bot}`;
      await generateSave(username, {
        skills: ALL_SKILLS,
        position: { x: 3222, z: 3218 }, // Lumbridge
        inventory: STARTING_INVENTORY,
        equipment: STARTING_EQUIPMENT,
      });
      count++;
    }
  }
  console.log(`[generate_gp_saves] Created ${count} saves (${BOTS_PER_LOOP} bots x ${LOOPS} loops)`);
}

main().catch(err => {
  console.error('[generate_gp_saves] Fatal:', err);
  process.exit(1);
});
