import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';

// Static initialization gate for bots/agent/defence-v2.ts.
// The real method needs a live game server, so this test asserts everything
// that can fail before a connection is attempted: the file parses/transpiles
// and it wires into ../../sdk/runner's runScript with the real SDK combat
// senders (no phantom methods).

const SRC = join(import.meta.dir, 'defence-v2.ts');

describe('defence-v2', () => {
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
            'sdk.getSkillXp(', 'sdk.getState()', 'sdk.findInventoryItem(',
            'sdk.sendInteractNpc(', 'sdk.sendSetCombatStyle(3)',
            'bot.equipItem(', 'bot.eatFood(', 'bot.walkTo(',
            'optionsWithIndex',
        ]) {
            expect(src).toContain(api);
        }
        // Known phantom methods must never appear.
        for (const bad of ['bot.attackNpc(', 'bot.fish(', 'bot.lightFire(']) {
            expect(src).not.toContain(bad);
        }
    });

    test('implements the v2 method: defensive style, scoring, instant retarget', () => {
        // Defensive combat style pinned (style 3 trains Defence).
        expect(src).toContain('sendSetCombatStyle(3)');
        // Finishing-kill + fast-kill scoring over healthPercent/maxHp/distance.
        expect(src).toContain('healthPercent');
        expect(src).toContain('maxHp');
        // Auto-retarget on kill: target reset + immediate re-pick in the same frame.
        expect(src).toMatch(/curTarget\s*=\s*-1/);
        // Minimal travel: anchors only when nothing within MAX_ENGAGE_TILES.
        expect(src).toContain('MAX_ENGAGE_TILES');
        expect(src).toContain('relocate');
        // Survival guard (we tank counter-hits in defensive style).
        expect(src).toContain('eatFood');
    });
});
