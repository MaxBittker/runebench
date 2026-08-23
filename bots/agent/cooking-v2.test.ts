import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';

// Static initialization gate for bots/agent/cooking-v2.ts.
// The real method needs a live game server, so this test asserts everything
// that can fail before a connection is attempted: the file parses/transpiles
// and it wires into ../../sdk/runner's runScript with real SDK APIs
// (no phantom methods).

const SRC = join(import.meta.dir, 'cooking-v2.ts');

describe('cooking-v2', () => {
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

    test('uses verified sdk APIs only (no phantom methods)', () => {
        for (const api of [
            'sdk.getSkillXp(', 'sdk.getState()', 'sdk.getInventory()',
            'sdk.sendUseItemOnLoc(', 'sdk.sendInteractNpc(',
            'bot.walkTo(', 'bot.openBank(', 'bot.depositItem(', 'bot.withdrawItem(',
            'bot.dismissBlockingUI', 'optionsWithIndex',
        ]) {
            expect(src).toContain(api);
        }
        // Known phantom methods must never appear.
        for (const bad of ['bot.cook(', 'bot.fish(', 'sdk.sendDropItem(']) {
            expect(src).not.toContain(bad);
        }
    });

    test('implements the v2 method: batch bank→withdraw→cook loop, drops nothing', () => {
        // Batch loop: bank all, withdraw 28 raw, cook at range, repeat.
        expect(src).toContain('bankCycle');
        expect(src).toMatch(/withdrawItem\([^)]*,\s*28\)/);
        // Cooks at the verified public Lumbridge Range (3230, 3196), not the
        // quest-gated castle kitchen.
        expect(src).toContain('3230');
        expect(src).toMatch(/\^range\$\/i/);
        // Peak-rate core: low-level one-click-one-item cooking on the loc.
        expect(src).toContain('sendUseItemOnLoc');
        // Nothing is ever dropped — items cycle through the bank instead.
        expect(src).not.toContain('sendDropItem');
        // Raw tiers are prioritized (lobster first).
        expect(src).toMatch(/raw lobster/i);
    });
});
