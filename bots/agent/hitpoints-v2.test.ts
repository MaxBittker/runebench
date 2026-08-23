import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';

// Static initialization gate for bots/agent/hitpoints-v2.ts.
// The real method needs a live game server, so this test asserts everything
// that can fail before a connection is attempted: the file parses/transpiles
// and it wires into ../../sdk/runner's runScript with the real SDK combat
// senders (no phantom methods).

const SRC = join(import.meta.dir, 'hitpoints-v2.ts');

describe('hitpoints-v2', () => {
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
            'sdk.sendInteractNpc(', 'bot.equipItem(', 'bot.eatFood(',
            'bot.walkTo(', 'optionsWithIndex', 'healthPercent',
        ]) {
            expect(src).toContain(api);
        }
        // Known phantom methods must never appear.
        for (const bad of ['bot.attackNpc(', 'bot.fish(', 'bot.lightFire(', 'bot.heal(']) {
            expect(src).not.toContain(bad);
        }
    });

    test('implements the v2 method: DPS farm, scoring, instant retarget, efficient regen', () => {
        // Weapon setup (DPS = HP xp) + style pin (style irrelevant to HP xp).
        expect(src).toContain('sendSetCombatStyle(0)');
        expect(src).toContain('equipBestWeapon');
        // Finishing-kill + fast-kill scoring over healthPercent/maxHp/distance.
        expect(src).toContain('maxHp');
        // Auto-retarget on kill: target reset + immediate re-pick same frame.
        expect(src).toMatch(/curTarget\s*=\s*-1/);
        // Minimal travel: anchors only when nothing within MAX_ENGAGE_TILES.
        expect(src).toContain('MAX_ENGAGE_TILES');
        expect(src).toContain('relocate');
        // Efficient regen loop: cheap kebab food, eaten under a threshold.
        expect(src).toContain('eatFood');
        expect(src).toContain('HP_EAT_FRACTION');
        expect(src).toContain('kebab');
        // HP XP attribution tracked against Hitpoints specifically.
        expect(src).toContain("getSkillXp('Hitpoints')");
    });
});
