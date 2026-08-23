import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

// Static initialization gate for bots/agent/thieving-v2.ts.
// The real method needs a live game server, so this test asserts everything
// that can fail before a connection is attempted: the file parses/transpiles,
// it wires into ../../sdk/runner's runScript, and its tier ladder covers every
// Thieving level from 1 to 99 without gaps.

const SRC = join(import.meta.dir, 'thieving-v2.ts');

describe('thieving-v2', () => {
    const src = readFileSync(SRC, 'utf-8');
    const transpiler = new Bun.Transpiler({ loader: 'tsx' });

    test('source transpiles (parses as valid TS)', () => {
        // Throws on syntax errors.
        const out = transpiler.transformSync(src);
        expect(out.length).toBeGreaterThan(0);
    });

    test('initializes via sdk/runner runScript', () => {
        expect(src).toContain("from '../../sdk/runner'");
        expect(src).toContain('await runScript(');
    });

    test('method shape: highest-XP ladder + stun recovery + power drop', () => {
        // Tier ladder ordered high->low so the first eligible tier is the
        // highest-XP NPC the level allows ...
        const mins = [...src.matchAll(/min:\s*(\d+)/g)].map((m) => Number(m[1]));
        for (let i = 1; i < mins.length; i++) expect(mins[i - 1]).toBeGreaterThan(mins[i]);
        // ... pickpockets through the porcelain (stun detection included) ...
        expect(src).toContain('bot.pickpocketNpc(');
        // ... waits out a per-tier stun window after being caught ...
        expect(src).toMatch(/stunTicks:\s*\d+/);
        expect(src).toMatch(/ticksToMs\(tier\.stunTicks\)/);
        // ... and drops loot (never coins or emergency food) instead of banking.
        expect(src).toContain('sdk.sendDropItem(');
        expect(src).toMatch(/KEEP_RE\s*=\s*\/coins\/i/m);
        expect(src).toMatch(/FOOD_RE\s*=\/i?/m);
        expect(src).not.toMatch(/openBank|depositItem/);
    });

    test('tier ladder has no level gaps 1..99', () => {
        // Extract the TIERS table min levels in declared order (40..1).
        const mins = [...src.matchAll(/min:\s*(\d+)/g)].map((m) => Number(m[1]));
        expect(mins.length).toBeGreaterThanOrEqual(3);
        for (let lvl = 1; lvl <= 99; lvl++) {
            // tierFor picks the first tier whose min <= level; must exist.
            const covered = mins.some((m) => lvl >= m);
            if (!covered) throw new Error(`level ${lvl} not covered by tier ladder`);
            expect(covered).toBe(true);
        }
    });
});
