import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

// Static initialization gate for bots/agent/fishing-v2.ts.
// The real method needs a live game server, so this test asserts everything
// that can fail before a connection is attempted: the file parses/transpiles,
// it wires into ../../sdk/runner's runScript, and it implements the intended
// strategy (bootstrap -> fly-rod + feathers -> lure spot with drip-dropping).

const SRC = join(import.meta.dir, 'fishing-v2.ts');

describe('fishing-v2', () => {
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
        expect(src).toContain('sendInteractNpc');
    });

    test('method shape: bootstrap shop trip then lure fishing', () => {
        // Phase A funds the method by selling raw fish at Gerrant's ...
        expect(src).toContain('openGerrant');
        expect(src).toMatch(/sellToShop/);
        // ... buys the fly fishing rod and feathers (1 consumed per catch) ...
        expect(src).toMatch(/fly \(fishing \)?rod/i);
        expect(src).toContain('/^feather$/i');
        // ... then fishes the Lumbridge Lure spot (best XP/roll per engine source).
        expect(src).toContain('/^lure$/i');
        expect(src).toContain('LURE_SPOT_POS');
    });

    test('drip-drop keeps free slots above floor (never stalls roll loop)', () => {
        // Server stops rolling when inv freespace = 0; v2 must top up space
        // continuously instead of only dropping at a full inventory.
        expect(src).toContain('FREE_SLOT_FLOOR');
        expect(src).toContain('DROP_DOWN_TO');
        const floor = Number(src.match(/FREE_SLOT_FLOOR\s*=\s*(\d+)/)?.[1]);
        const dropTo = Number(src.match(/DROP_DOWN_TO\s*=\s*(\d+)/)?.[1]);
        expect(floor).toBeGreaterThanOrEqual(1);
        expect(dropTo).toBeLessThanOrEqual(28 - floor);
        // Raw-fish-only victims: never drops rod/feathers/net.
        expect(src).toContain('RAW_FISH');
    });
});
