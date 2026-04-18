/**
 * Verification: report total gold (coins in inventory + bank) by reading the save file directly.
 *
 * The engine auto-saves every 1500 ticks (~75s at 8x speed). This verifier reads
 * the binary save file from disk rather than connecting to the game, so it works
 * regardless of player position or bank proximity.
 *
 * Save file format: see sdk/test/utils/save-generator.ts and engine PlayerLoading.ts
 *
 * Writes to reward.json: { gold, inventoryGold, bankGold, tracking }
 * Writes raw gold to reward.txt for Harbor compatibility.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';

const COINS_ID = 995;
const SAV_MAGIC = 0x2004;

// Inventory type IDs from engine
const INV_TYPE = 93;   // Main inventory (28 slots)
const WORN_TYPE = 94;  // Equipment (14 slots)
const BANK_TYPE = 95;  // Bank (496 slots)

const TRACKING_PATHS = [
    '/logs/tracking/skill_tracking.json',
    '/logs/verifier/skill_tracking.json',
];

// Save file is at /app/server/engine/data/players/main/agent.sav
const SAVE_PATHS = [
    '/app/server/engine/data/players/main/agent.sav',
    '/app/engine/data/players/main/agent.sav',
];

class SaveReader {
    private data: Uint8Array;
    private view: DataView;
    public pos: number = 0;

    constructor(data: Uint8Array) {
        this.data = data;
        this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    }

    g1(): number {
        return this.data[this.pos++]!;
    }

    g2(): number {
        const val = this.view.getUint16(this.pos, false); // Big-endian
        this.pos += 2;
        return val;
    }

    g4s(): number {
        const val = this.view.getInt32(this.pos, false); // Big-endian
        this.pos += 4;
        return val;
    }

    g8(): bigint {
        const val = this.view.getBigInt64(this.pos, false);
        this.pos += 8;
        return val;
    }
}

interface ParsedSave {
    position: { x: number; z: number; level: number };
    skills: Array<{ xp: number; level: number }>;
    inventories: Map<number, Array<{ slot: number; id: number; count: number }>>;
}

function parseSave(data: Uint8Array): ParsedSave {
    const reader = new SaveReader(data);

    const magic = reader.g2();
    if (magic !== SAV_MAGIC) {
        throw new Error(`Invalid save magic: 0x${magic.toString(16)}`);
    }

    const version = reader.g2();

    // Position
    const x = reader.g2();
    const z = reader.g2();
    const level = reader.g1();

    // Appearance: 7 body + 5 colors + 1 gender
    for (let i = 0; i < 7; i++) reader.g1();
    for (let i = 0; i < 5; i++) reader.g1();
    reader.g1(); // gender

    // Run energy
    reader.g2();

    // Playtime
    if (version >= 2) {
        reader.g4s();
    } else {
        reader.g2();
    }

    // Skills (21)
    const skills: Array<{ xp: number; level: number }> = [];
    for (let i = 0; i < 21; i++) {
        const xp = reader.g4s();
        const currentLevel = reader.g1();
        skills.push({ xp, level: currentLevel });
    }

    // Varps
    const varpCount = reader.g2();
    for (let i = 0; i < varpCount; i++) {
        reader.g4s();
    }

    // Inventories
    const inventories = new Map<number, Array<{ slot: number; id: number; count: number }>>();
    const invCount = reader.g1();

    for (let i = 0; i < invCount; i++) {
        const type = reader.g2();
        const size = version >= 5 ? reader.g2() : 28; // fallback

        const items: Array<{ slot: number; id: number; count: number }> = [];
        for (let slot = 0; slot < size; slot++) {
            const id = reader.g2() - 1;
            if (id === -1) continue;

            let count = reader.g1();
            if (count === 255) {
                count = reader.g4s();
            }

            items.push({ slot, id, count });
        }

        inventories.set(type, items);
    }

    return { position: { x, z, level }, skills, inventories };
}

function countCoins(items: Array<{ id: number; count: number }> | undefined): number {
    if (!items) return 0;
    return items
        .filter(i => i.id === COINS_ID)
        .reduce((sum, i) => sum + i.count, 0);
}

function main() {
    mkdirSync('/logs/verifier', { recursive: true });

    // Find save file
    let savePath: string | null = null;
    for (const p of SAVE_PATHS) {
        if (existsSync(p)) {
            savePath = p;
            break;
        }
    }

    if (!savePath) {
        console.error('No save file found at:', SAVE_PATHS.join(', '));
        // Debug: list what IS in the data directories
        for (const base of ['/app/server/engine/data/players', '/app/engine/data/players']) {
            try {
                if (existsSync(base)) {
                    const profiles = readdirSync(base);
                    console.error(`  ${base}/ contains: ${profiles.join(', ')}`);
                    for (const p of profiles) {
                        try {
                            const files = readdirSync(`${base}/${p}`);
                            console.error(`  ${base}/${p}/ contains: ${files.join(', ')}`);
                        } catch {}
                    }
                } else {
                    console.error(`  ${base}/ does not exist`);
                }
            } catch (e) {
                console.error(`  Error listing ${base}:`, e);
            }
        }
        writeFileSync('/logs/verifier/reward.txt', '0');
        writeFileSync('/logs/verifier/reward.json', JSON.stringify({
            gold: 0, inventoryGold: 0, bankGold: 0, error: 'no save file found',
        }));
        // Still print stdout markers for recovery
        console.log('__REWARD_JSON_START__');
        console.log(JSON.stringify({ gold: 0, inventoryGold: 0, bankGold: 0, error: 'no save file found' }));
        console.log('__REWARD_JSON_END__');
        process.exit(1);
    }

    console.log(`Reading save file: ${savePath}`);
    const saveData = readFileSync(savePath);
    const save = parseSave(new Uint8Array(saveData));

    console.log(`Position: ${save.position.x}, ${save.position.z} (level ${save.position.level})`);

    // Count coins in each inventory type
    const inventoryGold = countCoins(save.inventories.get(INV_TYPE));
    const bankGold = countCoins(save.inventories.get(BANK_TYPE));
    const wornGold = countCoins(save.inventories.get(WORN_TYPE)); // shouldn't have coins but check anyway
    const totalGold = inventoryGold + bankGold + wornGold;

    console.log(`Inventory coins: ${inventoryGold}`);
    console.log(`Bank coins: ${bankGold}`);
    console.log(`Total gold: ${totalGold}`);

    // Log all inventories for debugging
    for (const [type, items] of save.inventories) {
        const typeName = type === INV_TYPE ? 'Inventory' : type === BANK_TYPE ? 'Bank' : type === WORN_TYPE ? 'Worn' : `Type${type}`;
        const nonEmpty = items.filter(i => i.count > 0);
        if (nonEmpty.length > 0) {
            console.log(`${typeName} (${nonEmpty.length} items):`);
            for (const item of nonEmpty) {
                console.log(`  slot ${item.slot}: id=${item.id} x${item.count}`);
            }
        }
    }

    // Log skills
    const SKILL_NAMES = [
        'Attack', 'Defence', 'Strength', 'Hitpoints', 'Ranged', 'Prayer', 'Magic',
        'Cooking', 'Woodcutting', 'Fletching', 'Fishing', 'Firemaking', 'Crafting',
        'Smithing', 'Mining', 'Herblore', 'Agility', 'Thieving', 'Stat18', 'Stat19', 'Runecraft',
    ];
    let totalLevel = 0;
    for (let i = 0; i < save.skills.length; i++) {
        const s = save.skills[i]!;
        const level = s.level > 0 ? s.level : 1;
        totalLevel += level;
        if (s.xp > 0) {
            console.log(`${SKILL_NAMES[i]}: level ${level}, xp ${s.xp}`);
        }
    }
    console.log(`Total level: ${totalLevel}`);

    // Read tracking data
    let trackingData = null;
    for (const trackingPath of TRACKING_PATHS) {
        if (existsSync(trackingPath)) {
            try {
                trackingData = JSON.parse(readFileSync(trackingPath, 'utf-8'));
                console.log(`Tracking data: ${trackingData.samples?.length ?? 0} samples (from ${trackingPath})`);
                break;
            } catch (err) {
                console.error(`Failed to read tracking data from ${trackingPath}:`, err);
            }
        }
    }
    if (!trackingData) {
        console.log('No tracking data file found');
    }

    // Peak-gold scoring: reward = max(any sample's gold, final save read).
    // This protects against death-loss and bank-failure variance at the very
    // end of the run — if the agent successfully built up N coins at any
    // point, we credit N regardless of what they had at verifier time.
    let peakGold = totalGold;
    let peakAtMs: number | null = null;
    const samples = trackingData?.samples || [];
    for (const s of samples) {
        const g = typeof s.gold === 'number' ? s.gold : 0;
        if (g > peakGold) {
            peakGold = g;
            peakAtMs = typeof s.elapsedMs === 'number' ? s.elapsedMs : null;
        }
    }

    const rewardObj = {
        gold: peakGold,          // primary reward (peak)
        peakGold,
        peakAtMs,
        finalGold: totalGold,    // what the save file showed at verifier time
        inventoryGold,
        bankGold,
        totalLevel,
        tracking: trackingData,
    };

    writeFileSync('/logs/verifier/reward.json', JSON.stringify(rewardObj, null, 2));
    writeFileSync('/logs/verifier/reward.txt', peakGold.toString());

    console.log(`Reward: gold=${peakGold} (peak); finalGold=${totalGold}${peakAtMs != null ? ` (peak at ${(peakAtMs/1000).toFixed(0)}s)` : ''}`);

    // Print reward JSON to stdout for recovery
    console.log('__REWARD_JSON_START__');
    console.log(JSON.stringify(rewardObj));
    console.log('__REWARD_JSON_END__');
}

main();
