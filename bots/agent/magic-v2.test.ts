import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { pickSpell, runesFor, shoppingList, SPELL_LADDER, UNDEAD_RE } from './_lib/magic-spells';

// Static + pure-logic gate for bots/agent/magic-v2.ts.
// The live cast loop needs a game server; everything that can fail BEFORE a
// connection is covered here: the script parses, wires into sdk/runner's
// runScript, and the spell ladder / selection logic behaves.

const SRC = join(import.meta.dir, 'magic-v2.ts');

describe('magic-v2', () => {
    const src = readFileSync(SRC, 'utf-8');
    const transpiler = new Bun.Transpiler({ loader: 'tsx' });

    test('source transpiles (parses as valid TS)', () => {
        const out = transpiler.transformSync(src);
        expect(out.length).toBeGreaterThan(0);
    });

    test('initializes via sdk/runner runScript + sdk APIs', () => {
        expect(src).toContain("from '../../sdk/runner'");
        expect(src).toContain('await runScript(');
        expect(src).toContain('sendSpellOnNpc');
        expect(src).toContain('getNearbyNpcs');
    });

    test('does not touch magic-best.ts', () => {
        const best = readFileSync(join(import.meta.dir, 'magic-best.ts'), 'utf-8');
        expect(best).not.toContain('magic-v2');
    });

    test('spell ladder is XP-descending per level gate and covers 1..75', () => {
        expect(SPELL_LADDER.length).toBeGreaterThanOrEqual(8);
        for (let lvl = 1; lvl <= 75; lvl++) {
            // With every rune available and an undead target, a spell must exist.
            const held: Record<string, number> = {};
            for (const s of SPELL_LADDER) for (const r of s.runes) held[r.rune] = 99;
            const pick = pickSpell(lvl, held, true);
            expect(pick).not.toBeNull();
        }
        // XP must be non-decreasing in level (higher levels cast better spells).
        for (let lvl = 2; lvl <= 75; lvl++) {
            const held: Record<string, number> = {};
            for (const s of SPELL_LADDER) for (const r of s.runes) held[r.rune] = 99;
            expect(pickSpell(lvl, held, true)!.xp).toBeGreaterThanOrEqual(
                pickSpell(lvl - 1, held, true)!.xp,
            );
        }
    });

    test('crumble undead is picked at 39+ with undead targets and its runes', () => {
        const held = runesFor([
            { name: 'chaos rune', count: 10 },
            { name: 'air rune', count: 20 },
            { name: 'earth rune', count: 20 },
            { name: 'mind rune', count: 10 },
        ]);
        expect(pickSpell(39, held, true)?.name).toBe('Crumble Undead');
        // Without undead targets it must fall back to the best affordable
        // non-undead spell (Wind Blast needs death runes we don't hold).
        expect(pickSpell(39, held, false)?.name).toBe('Earth Bolt');
    });

    test('crumble is skipped when chaos runes run out (falls to affordable spell)', () => {
        const held = runesFor([
            { name: 'air rune', count: 20 },
            { name: 'earth rune', count: 20 },
            { name: 'mind rune', count: 10 },
        ]);
        expect(pickSpell(45, held, true)?.name).toBe('Earth Strike');
        expect(pickSpell(45, {}, true)).toBeNull();
    });

    test('undead regex matches sewer targets, not men/guards', () => {
        expect(UNDEAD_RE.test('Skeleton')).toBe(true);
        expect(UNDEAD_RE.test('Zombie')).toBe(true);
        expect(UNDEAD_RE.test('Ghost')).toBe(true);
        expect(UNDEAD_RE.test('Man')).toBe(false);
        expect(UNDEAD_RE.test('Guard')).toBe(false);
    });

    test('shopping list buys crumble sets at 39+ and strike sets below', () => {
        const crumble = shoppingList(40, 1400);
        expect(crumble.find((w) => w.rune === 'chaos rune')?.count).toBe(10);
        expect(crumble.find((w) => w.rune === 'air rune')?.count).toBe(20);
        const strike = shoppingList(10, 200);
        expect(strike.find((w) => w.rune === 'mind rune')?.count).toBe(10);
        expect(strike.find((w) => w.rune === 'air rune')?.count).toBe(10);
        expect(shoppingList(50, 0).every((w) => w.count === 0)).toBe(true);
    });
});
