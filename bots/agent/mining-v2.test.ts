import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

// Static initialization gate for bots/agent/mining-v2.ts.
// The real method needs a live game server, so this test asserts everything
// that can fail before a connection is attempted: the file parses/transpiles,
// it wires into ../../sdk/runner's runScript, and its tier ladder covers every
// Mining level from 1 to 99 without gaps.

const SRC = join(import.meta.dir, 'mining-v2.ts');

describe('mining-v2', () => {
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
        expect(src).toContain('sendInteractLoc');
    });

    test('method shape: chaining + full-inventory powermine', () => {
        // Only clicks rocks that currently expose the Mine option (respawn-
        // aware chaining) ...
        expect(src).toMatch(/MINE_RE\s*=\s*\/mine\/i/m);
        expect(src).toContain("optionsWithIndex.some((o) => MINE_RE.test(o.text))");
        // ... and drops only when the inventory is actually full.
        expect(src).toContain("'inventory-full'");
        expect(src).not.toMatch(/dropOres\(\);?\s*\/\/\s*every ore/i);
        expect(src).toContain('ORE_RE');
    });

    test('tier ladder has no level gaps 1..99', () => {
        // Extract the TIERS table min levels in declared order (85..1).
        const mins = [...src.matchAll(/min:\s*(\d+)/g)].map((m) => Number(m[1]));
        expect(mins.length).toBeGreaterThanOrEqual(6);
        for (let lvl = 1; lvl <= 99; lvl++) {
            // tierFor picks the first tier whose min <= level; must exist.
            const covered = mins.some((m) => lvl >= m);
            if (!covered) throw new Error(`level ${lvl} not covered by tier ladder`);
            expect(covered).toBe(true);
        }
        // Strictly descending mins -> highest eligible tier is picked first.
        for (let i = 1; i < mins.length; i++) expect(mins[i - 1]).toBeGreaterThan(mins[i]);
    });
});
