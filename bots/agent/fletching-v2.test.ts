import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';

// Static initialization gate for bots/agent/fletching-v2.ts.
// The real method needs a live game server, so this test asserts everything
// that can fail before a connection is attempted: the file parses/transpiles,
// it wires into ../../sdk/runner's runScript, and its product + log-tier
// ladders are consistent with the engine's fletching tables.

const SRC = join(import.meta.dir, 'fletching-v2.ts');

describe('fletching-v2', () => {
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
        expect(src).toContain('sendUseItemOnItem');
    });

    test('method shape: batched knife runs + tick polling, no fixed sleeps in burst', () => {
        // One knife-on-logs interaction per inventory, Make-X the whole bag ...
        expect(src).toContain('sendCountDialog(amount)');
        // ... waits on ticks / log depletion rather than blind sleeps ...
        expect(src).toContain('waitForTicks(1)');
        expect(src).not.toMatch(/Bun\.sleep\(6000\)/); // -best's batch wait
        // ... drops only unstrung bows (shafts stack), never mid-burst.
        expect(src).toContain('dropBows()');
        expect(src).toContain('unstrung|long\\s*bow');
    });

    test('product ladder never picks shortbow (50xp < shafts 75xp at lvl 5-9)', () => {
        const ladder = src.match(/function productFor[\s\S]*?\n}/)![0];
        expect(ladder).toContain('>= 10'); // longbow(u) 100 xp/log
        // Dialog labels are single-spaced ("15 Arrow Shafts") — the regex must
        // use \s*; a literal "\s " demands two spaces and never matches.
        expect(ladder).toContain('arrow\\s*shafts?');
        expect(ladder).toContain('long\\s*bow');
        expect(ladder).not.toContain('shortbow');
    });

    test('log-tier ladder respects Woodcutting AND Fletching gates', () => {
        const tiers = src.match(/const TIERS[\s\S]*?];/)![0];
        const mins = [...tiers.matchAll(/minWc:\s*(\d+),\s*minFl:\s*(\d+)/g)].map(
            (m) => [Number(m[1]), Number(m[2])] as const,
        );
        expect(mins.length).toBeGreaterThanOrEqual(3);
        // willow(30,40) -> oak(15,25) -> normal(1,10), strictly descending gates.
        for (let i = 1; i < mins.length; i++) {
            expect(mins[i - 1]![0]).toBeGreaterThan(mins[i]![0]);
            expect(mins[i - 1]![1]).toBeGreaterThan(mins[i]![1]);
        }
        expect(src).toContain('wcLevel() >= t.minWc && flLevel() >= t.minFl');
    });
});
