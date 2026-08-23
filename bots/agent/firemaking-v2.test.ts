import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

// Static initialization gate for bots/agent/firemaking-v2.ts.
// The real method needs a live game server, so this test asserts everything
// that can fail before a connection is attempted: the file parses/transpiles,
// it wires into ../../sdk/runner's runScript, and it implements the intended
// row-burn method (direct sendUseItemOnItem + per-tick polling, not the
// high-level burnLogs wrapper).

const SRC = join(import.meta.dir, 'firemaking-v2.ts');

describe('firemaking-v2', () => {
    const src = readFileSync(SRC, 'utf-8');
    const transpiler = new Bun.Transpiler({ loader: 'tsx' });

    test('source transpiles (parses as valid TS)', () => {
        const out = transpiler.transformSync(src);
        expect(out.length).toBeGreaterThan(0);
    });

    test('initializes via sdk/runner runScript', () => {
        expect(src).toContain("from '../../sdk/runner'");
        expect(src).toContain('await runScript(');
        expect(src).toContain('sendUseItemOnItem');
    });

    test('method shape: tinderbox-on-logs row-burn with per-tick polling', () => {
        // Lights via direct low-level combine (tinderbox slot -> logs slot) ...
        expect(src).toMatch(/TINDERBOX_RE\s*=\s*\/tinderbox\/i/m);
        expect(src).toMatch(/LOGS_RE\s*=\s*\/\^logs\$\/i/m);
        expect(src).toContain('sdk.sendUseItemOnItem(tinderbox.slot, log.slot)');
        // ... polls per game tick instead of blocking on a long condition ...
        expect(src).toContain('await sdk.waitForTicks(1)');
        // ... detects failure messages and nudges one tile to re-light ...
        expect(src).toContain("can't light a fire");
        expect(src).toContain('nudgeOneTile');
        // ... and does NOT use the high-level burnLogs wrapper.
        expect(src).not.toContain('bot.burnLogs');
    });

    test('no banking until inventory empty of logs', () => {
        // Refill happens only when zero log slots remain; no bank calls at all.
        expect(src).not.toMatch(/openBank|depositItem|withdrawItem/);
        expect(src).toContain('refillLogs');
    });
});
