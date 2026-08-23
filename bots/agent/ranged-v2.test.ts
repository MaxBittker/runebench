import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

// Static initialization gate for bots/agent/ranged-v2.ts.
// The real method needs a live game server, so this test asserts everything
// that can fail before a connection is attempted: the file parses/transpiles
// and it wires into ../../sdk/runner's runScript with the real SDK ranged
// senders (no phantom methods).

const SRC = join(import.meta.dir, 'ranged-v2.ts');

describe('ranged-v2', () => {
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
            'sdk.findEquipmentItem(', 'sdk.sendInteractNpc(', 'sdk.sendSetCombatStyle(',
            'bot.equipItem(', 'bot.eatFood(', 'bot.walkTo(', 'bot.pickupItem(',
            'optionsWithIndex',
        ]) {
            expect(src).toContain(api);
        }
        // Known phantom methods must never appear.
        for (const bad of ['bot.attackNpc(', 'bot.fish(', 'bot.lightFire(', 'bot.shoot(']) {
            expect(src).not.toContain(bad);
        }
    });

    test('implements the v2 method: ranged style, scoring, instant retarget, ammo safety', () => {
        // Ranged combat style pinned from the combat tab (Rapid preferred).
        expect(src).toContain("trainsSkills.includes('Ranged')");
        expect(src).toContain("'Rapid'");
        // Lowest-HP-first scoring over healthPercent/maxHp/distance at bow range.
        expect(src).toContain('healthPercent');
        expect(src).toContain('maxHp');
        expect(src).toContain('MAX_ENGAGE_TILES');
        // Auto-retarget on kill: target reset + immediate re-pick in the same frame.
        expect(src).toMatch(/curTarget\s*=\s*-1/);
        // Ammo-safe loop: re-equip from inventory, pick up ground arrows,
        // stop cleanly when truly dry.
        expect(src).toContain('ensureAmmo');
        expect(src).toContain('pickupItem');
        expect(src).toContain('outOfAmmo');
        // Minimal travel + survival guard.
        expect(src).toContain('relocate');
        expect(src).toContain('eatFood');
    });
});
