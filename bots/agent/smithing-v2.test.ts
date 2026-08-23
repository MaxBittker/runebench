import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

// Static initialization gate for bots/agent/smithing-v2.ts.
// The real method needs a live game server, so this test asserts everything
// that can fail before a connection is attempted: the file parses/transpiles,
// it wires into ../../sdk/runner's runScript, and its bar-tier ladder plus
// bank↔furnace loop shape are intact.

const SRC = join(import.meta.dir, 'smithing-v2.ts');

describe('smithing-v2', () => {
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

    test('method shape: bank withdraw -> furnace smelt -> deposit loop', () => {
        // Bank interaction through the high-level actions ...
        expect(src).toContain('bot.openBank()');
        expect(src).toContain('bot.withdrawItem');
        expect(src).toContain('bot.depositItem');
        // ... furnace interaction through the low-level loc packet ...
        expect(src).toContain('sendInteractLoc');
        // ... and a smelt-dialog component click (dynamic resolution with the
        // -best fallbacks still present).
        expect(src).toContain('sendClickComponent');
        expect(src).toContain('allComponents');
        expect(src).toContain('fallbackComponents');
    });

    test('bar-tier ladder prefers highest xp/bar accessible tier', () => {
        const xps = [...src.matchAll(/xpPerBar:\s*([\d.]+)/g)].map((m) => Number(m[1]));
        expect(xps.length).toBeGreaterThanOrEqual(2);
        // Declared descending: pickTier returns the first affordable entry.
        for (let i = 1; i < xps.length; i++) expect(xps[i - 1]).toBeGreaterThan(xps[i]);
        const levels = [...src.matchAll(/minLevel:\s*(\d+)/g)].map((m) => Number(m[1]));
        // Strictly descending level gates alongside descending xp — iron
        // (15, 12.5) before bronze (1, 6.2).
        for (let i = 1; i < levels.length; i++) expect(levels[i - 1]).toBeGreaterThan(levels[i]);
        expect(src).toMatch(/iron/i);
        expect(src).toMatch(/bronze/i);
    });

    test('bootstrap mining only when bank ore is below target', () => {
        expect(src).toContain('SMITHING_ORE_TARGET');
        expect(src).toContain('mineTrip');
        // Mining is gated behind the bank-stock check, never unconditional.
        expect(src).toMatch(/if \(!tier && MINING_ENABLED\)/);
    });
});
