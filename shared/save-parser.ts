/**
 * Single source of truth for READING engine .sav files.
 *
 * Handles both save formats:
 *   v≤6 — dense varps:  count(u16) then count × int32 (index = varp id)
 *   v7  — sparse varps: count(u16) then count × { id: u16, value: varint }
 *         (engine ≥ LostCity rev 274; varint = 7-bit groups, MSB continuation,
 *          see server/engine/src/io/Packet.ts gVarInt)
 *
 * Used by check_gold.ts, check_arrav.ts, arrav_watcher.ts, skill_tracker.ts,
 * and scripts/validate-saves.ts. NOTE: this file is copied into each task's
 * tests/ dir and into the Docker image — keep it dependency-free.
 *
 * (shared/save-generator.ts still WRITES v6 saves; the engine loader accepts
 *  any version ≤ its own, so generated starting saves remain valid.)
 */

export const SAV_MAGIC = 0x2004;

// Inventory type IDs from engine config
export const INV_TYPE = 93;   // Main inventory (28 slots)
export const WORN_TYPE = 94;  // Equipment (14 slots)
export const BANK_TYPE = 95;  // Bank (496 slots)

export interface ParsedSave {
    version: number;
    position: { x: number; z: number; level: number };
    skills: Array<{ xp: number; level: number }>;
    /** Varp id → value (sparse; absent = 0) */
    varps: Record<number, number>;
    inventories: Map<number, Array<{ slot: number; id: number; count: number }>>;
}

export function parseSave(data: Uint8Array): ParsedSave {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let pos = 0;
    const g1 = () => data[pos++]!;
    const g2 = () => { const v = view.getUint16(pos, false); pos += 2; return v; };
    const g4s = () => { const v = view.getInt32(pos, false); pos += 4; return v; };
    // Variable-length int: 7-bit groups, high bit = continuation (Packet.gVarInt)
    const gVarInt = () => {
        let byte = g1();
        let result = 0;
        while ((byte & 0x80) !== 0) {
            result = (result | (byte & 0x7f)) << 7;
            byte = g1();
        }
        return (result | byte) >>> 0;
    };

    const magic = g2();
    if (magic !== SAV_MAGIC) {
        throw new Error(`Invalid save magic: 0x${magic.toString(16)}`);
    }
    const version = g2();

    const x = g2();
    const z = g2();
    const level = g1();

    pos += 13; // appearance (7 body + 5 colors + 1 gender)
    pos += 2;  // run energy
    pos += version >= 2 ? 4 : 2; // playtime

    const skills: Array<{ xp: number; level: number }> = [];
    for (let i = 0; i < 21; i++) {
        const xp = g4s();
        const lvl = g1();
        skills.push({ xp, level: lvl });
    }

    const varps: Record<number, number> = {};
    const varpCount = g2();
    if (version >= 7) {
        for (let i = 0; i < varpCount; i++) {
            const id = g2();
            varps[id] = gVarInt();
        }
    } else {
        for (let i = 0; i < varpCount; i++) {
            const value = g4s();
            if (value !== 0) varps[i] = value;
        }
    }

    const inventories = new Map<number, Array<{ slot: number; id: number; count: number }>>();
    const invCount = g1();
    for (let i = 0; i < invCount; i++) {
        const type = g2();
        const size = version >= 5 ? g2() : 28;
        const items: Array<{ slot: number; id: number; count: number }> = [];
        for (let slot = 0; slot < size; slot++) {
            const id = g2() - 1;
            if (id === -1) continue;
            let count = g1();
            if (count === 255) count = g4s();
            items.push({ slot, id, count });
        }
        inventories.set(type, items);
    }

    return { position: { x, z, level }, version, skills, varps, inventories };
}

/** Sum the count of a given item id across one parsed inventory. */
export function countItem(
    items: Array<{ id: number; count: number }> | undefined,
    itemId: number,
): number {
    if (!items) return 0;
    return items.filter(i => i.id === itemId).reduce((sum, i) => sum + i.count, 0);
}
