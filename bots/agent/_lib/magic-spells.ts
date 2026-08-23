/**
 * Magic spell ladder for magic-v2 — data + pure selection logic.
 *
 * XP/rune data transcribed from the server content tables:
 *   server/content/scripts/skill_combat/configs/magic/magic_combat_spells.dbrow
 *   server/content/scripts/skill_magic/configs/magic_spells.dbrow
 *
 * Server grants `experience` base XP per successful cast (x25 server xpRate),
 * on CAST, not on hit — so the best method is the highest-XP spell you can
 * keep casting continuously on a valid target with zero idle ticks.
 *
 * Component ids follow the classic 2004 spellbook layout (see sdk/spells.ts):
 * FALADOR_TELEPORT=1170, CRUMBLE_UNDEAD=1171, WIND_BLAST=1172.
 */

export interface SpellEntry {
    /** Spellbook component id (what sendSpellOnNpc takes). */
    id: number;
    name: string;
    /** Magic level required. */
    minLevel: number;
    /** Base XP per cast (server content `experience` field). */
    xp: number;
    /** Runes consumed per cast: [name-regex source, count]. */
    runes: Array<{ rune: string; count: number }>;
    /** true = only valid on undead NPCs (skeleton/zombie/ghost). */
    undeadOnly: boolean;
}

export const UNDEAD_RE = /^(skeleton|zombie|ghost|skeleton mage|zombie rat|shadow warrior|animated armour)/i;

export const SPELL_LADDER: SpellEntry[] = [
    // ── combat spells (server: magic_combat_spells.dbrow) ──────────────────
    { id: 1152, name: 'Wind Strike', minLevel: 1, xp: 55, runes: [{ rune: 'mind rune', count: 1 }, { rune: 'air rune', count: 1 }], undeadOnly: false },
    { id: 1154, name: 'Water Strike', minLevel: 5, xp: 75, runes: [{ rune: 'mind rune', count: 1 }, { rune: 'water rune', count: 1 }, { rune: 'air rune', count: 1 }], undeadOnly: false },
    { id: 1156, name: 'Earth Strike', minLevel: 9, xp: 95, runes: [{ rune: 'mind rune', count: 1 }, { rune: 'earth rune', count: 2 }, { rune: 'air rune', count: 1 }], undeadOnly: false },
    { id: 1158, name: 'Fire Strike', minLevel: 13, xp: 115, runes: [{ rune: 'mind rune', count: 1 }, { rune: 'fire rune', count: 3 }, { rune: 'air rune', count: 2 }], undeadOnly: false },
    { id: 1160, name: 'Wind Bolt', minLevel: 17, xp: 135, runes: [{ rune: 'chaos rune', count: 1 }, { rune: 'air rune', count: 2 }], undeadOnly: false },
    { id: 1163, name: 'Water Bolt', minLevel: 23, xp: 165, runes: [{ rune: 'chaos rune', count: 1 }, { rune: 'water rune', count: 2 }, { rune: 'air rune', count: 2 }], undeadOnly: false },
    { id: 1166, name: 'Earth Bolt', minLevel: 29, xp: 195, runes: [{ rune: 'chaos rune', count: 1 }, { rune: 'earth rune', count: 3 }, { rune: 'air rune', count: 2 }], undeadOnly: false },
    { id: 1169, name: 'Fire Bolt', minLevel: 35, xp: 225, runes: [{ rune: 'chaos rune', count: 1 }, { rune: 'fire rune', count: 4 }, { rune: 'air rune', count: 3 }], undeadOnly: false },
    // Crumble Undead: 490 XP/cast — more than double any bolt/blast per cast,
    // and its runes (chaos+2 air+2 earth = 140gp at Aubury) are CHEAPER than a
    // fire bolt set. Strictly the best continuous-cast spell once level 39.
    { id: 1171, name: 'Crumble Undead', minLevel: 39, xp: 490, runes: [{ rune: 'chaos rune', count: 1 }, { rune: 'air rune', count: 2 }, { rune: 'earth rune', count: 2 }], undeadOnly: true },
    { id: 1172, name: 'Wind Blast', minLevel: 41, xp: 255, runes: [{ rune: 'death rune', count: 1 }, { rune: 'air rune', count: 3 }], undeadOnly: false },
    { id: 1175, name: 'Water Blast', minLevel: 47, xp: 285, runes: [{ rune: 'death rune', count: 1 }, { rune: 'water rune', count: 3 }, { rune: 'air rune', count: 3 }], undeadOnly: false },
    { id: 1177, name: 'Earth Blast', minLevel: 53, xp: 315, runes: [{ rune: 'death rune', count: 1 }, { rune: 'earth rune', count: 4 }, { rune: 'air rune', count: 3 }], undeadOnly: false },
    { id: 1181, name: 'Fire Blast', minLevel: 59, xp: 345, runes: [{ rune: 'death rune', count: 1 }, { rune: 'fire rune', count: 5 }, { rune: 'air rune', count: 4 }], undeadOnly: false },
];

/** Rune counts held, keyed by lowercase rune name. */
export type RuneCounts = Record<string, number>;

export function runesFor(entries: Array<{ name: string; count?: number }>): RuneCounts {
    const counts: RuneCounts = {};
    for (const e of entries) {
        const name = e.name.toLowerCase();
        if (name.endsWith('rune')) counts[name] = (counts[name] ?? 0) + (e.count ?? 1);
    }
    return counts;
}

export function hasRunes(spell: SpellEntry, held: RuneCounts): boolean {
    return spell.runes.every((r) => (held[r.rune] ?? 0) >= r.count);
}

/**
 * Highest-XP/spell-cost spell the current level + rune pouch + target pool can
 * sustain. Undead-only spells are only eligible when an undead target exists.
 * Returns null when nothing is castable (caller must resupply).
 */
export function pickSpell(
    level: number,
    held: RuneCounts,
    undeadNearby: boolean,
): SpellEntry | null {
    let best: SpellEntry | null = null;
    for (const spell of SPELL_LADDER) {
        if (level < spell.minLevel) continue;
        if (spell.undeadOnly && !undeadNearby) continue;
        if (!hasRunes(spell, held)) continue;
        if (!best || spell.xp > best.xp) best = spell;
    }
    return best;
}

/**
 * Runes to buy with `coins` at Aubury for the given magic level.
 * Shop prices: elemental/mind/body 10gp, chaos 100gp, death 150gp
 * (server varrock.inv stock costs; buy price is a fraction of these, so this
 * is a conservative upper-bound budget).
 */
export function shoppingList(level: number, coins: number): Array<{ rune: string; count: number }> {
    if (level >= 39) {
        // Crumble Undead sets: 1 chaos + 2 air + 2 earth per cast (worst-case 140gp/set).
        const sets = Math.max(0, Math.floor(coins / 140));
        return [
            { rune: 'chaos rune', count: sets },
            { rune: 'air rune', count: sets * 2 },
            { rune: 'earth rune', count: sets * 2 },
        ];
    }
    if (level >= 13) {
        // Fire Strike sets: 1 mind + 3 fire + 2 air (worst-case 60gp/set).
        const sets = Math.max(0, Math.floor(coins / 60));
        return [
            { rune: 'mind rune', count: sets },
            { rune: 'fire rune', count: sets * 3 },
            { rune: 'air rune', count: sets * 2 },
        ];
    }
    // Wind Strike sets: 1 mind + 1 air (20gp/set).
    const sets = Math.max(0, Math.floor(coins / 20));
    return [
        { rune: 'mind rune', count: sets },
        { rune: 'air rune', count: sets },
    ];
}
