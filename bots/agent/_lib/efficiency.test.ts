import { describe, expect, test } from 'bun:test';

// Unit tests for bots/agent/_lib/efficiency.ts.
// The library is pure/synchronous, so these are real behavioral tests — no
// game server needed. They double as the "initializes" gate: importing the
// module proves it parses, transpiles, and exports the shared API surface.

import {
    GAME_SPEED,
    INVENTORY_SIZE,
    Pacer,
    SERVER_TICK_MS,
    TickBudget,
    XP_MULTIPLIER,
    XP_NORMALIZATION_DIVISOR,
    XpRateTracker,
    countItems,
    estimateXpPerMin,
    findDropTargets,
    freeSlots,
    isIdleTimeout,
    isInventoryFull,
    msToTicks,
    normalizeXpRate,
    rawXpPerMin,
    ticksToMs,
    wouldFillInventory,
} from './efficiency';

const inv = (...names: string[]) => names.map((name, slot) => ({ slot, name }));

describe('efficiency lib', () => {
    test('module initializes and normalization constants match the scorer', () => {
        expect(SERVER_TICK_MS).toBe(50);
        expect(GAME_SPEED).toBe(8);
        expect(XP_MULTIPLIER).toBe(25);
        expect(XP_NORMALIZATION_DIVISOR).toBe(GAME_SPEED * XP_MULTIPLIER);
        expect(INVENTORY_SIZE).toBe(28);
    });

    test('tick conversions round-trip at the 50ms server tick', () => {
        expect(ticksToMs(4)).toBe(200);
        expect(msToTicks(200)).toBe(4);
        expect(msToTicks(249)).toBe(4); // floors
        for (const t of [1, 7, 20, 100]) expect(ticksToMs(msToTicks(ticksToMs(t)))).toBe(ticksToMs(t));
    });

    test('TickBudget tracks elapsed/remaining/expiry against injected clock', () => {
        const b = new TickBudget(10_000, 1_000);
        expect(b.elapsed(2_000)).toBe(1_000);
        expect(b.remaining(2_000)).toBe(9_000);
        expect(b.expired(2_000)).toBe(false);
        expect(b.hasTimeFor(5_000, 2_000)).toBe(true);
        expect(b.expired(11_000)).toBe(true);
        expect(b.remaining(99_999)).toBe(0); // clamps at zero
        expect(() => new TickBudget(0)).toThrow(RangeError);
    });

    test('Pacer throttles repeated actions', () => {
        const p = new Pacer(500);
        expect(p.due(0)).toBe(true);
        p.touch(0);
        expect(p.due(400)).toBe(false);
        expect(p.tryFire(400)).toBe(false);
        expect(p.due(500)).toBe(true);
        expect(p.tryFire(500)).toBe(true);
        expect(p.cooldownLeft(600)).toBe(400);
        expect(() => new Pacer(-1)).toThrow(RangeError);
    });

    test('isIdleTimeout fires only after a positive timeout of silence', () => {
        expect(isIdleTimeout(1_500, 1_500)).toBe(true);
        expect(isIdleTimeout(1_499, 1_500)).toBe(false);
        expect(isIdleTimeout(9_999, 0)).toBe(false); // disabled timeout never fires
    });

    test('inventory-full checks accept arrays or bare counts', () => {
        const full = inv(...Array.from({ length: INVENTORY_SIZE }, () => 'ore'));
        expect(isInventoryFull(full)).toBe(true);
        expect(isInventoryFull(inv('pickaxe'))).toBe(false);
        expect(isInventoryFull(INVENTORY_SIZE)).toBe(true);
        expect(freeSlots(full)).toBe(0);
        expect(freeSlots(inv('a', 'b', 'c'))).toBe(INVENTORY_SIZE - 3);
        expect(wouldFillInventory(inv('a'), 27)).toBe(false);
        expect(wouldFillInventory(inv('a'), 28)).toBe(true);
    });

    test('countItems sums counts and findDropTargets respects keep-patterns', () => {
        const items = [...inv('Bronze pickaxe', 'Iron ore', 'Iron ore'), { slot: 3, name: 'Coins', count: 25 }];
        expect(countItems(items, /ore/i)).toBe(2);
        expect(countItems(items, /coins/i)).toBe(25);
        const drops = findDropTargets(items, /ore|coins/i, /pickaxe/i);
        expect(drops.map((d) => d.slot).sort()).toEqual([1, 2, 3]);
        // No keep-pattern -> everything matching drop-pattern.
        expect(findDropTargets(items, /ore/i)).toHaveLength(2);
    });

    test('XP/min estimation normalizes raw rate by 8*25 like check_xp_rate.ts', () => {
        // 200 raw XP in 60s = 200 raw XP/min = 1 scored real-game XP/min.
        expect(rawXpPerMin(200, 60_000)).toBeCloseTo(200);
        expect(normalizeXpRate(200)).toBeCloseTo(1);
        expect(estimateXpPerMin(1_000, 3_000, 0, 60_000)).toBeCloseTo(10);
        // Degenerate spans are 0, never NaN/Infinity.
        expect(rawXpPerMin(100, 0)).toBe(0);
        expect(estimateXpPerMin(100, 100, 0, 60_000)).toBe(0);
        expect(Number.isFinite(estimateXpPerMin(0, 0, 5, 5))).toBe(true);
    });

    test('XpRateTracker reproduces peak-window scoring from samples', () => {
        const t = new XpRateTracker(15_000);
        const base = 1_000;
        t.sample(base, 0);
        // Burst: 150 raw XP over 15s -> 600 raw/min -> 3.0 scored.
        t.sample(base + 75, 7_500);
        t.sample(base + 150, 15_000);
        expect(t.peakRate()).toBeCloseTo(3.0);
        expect(t.currentRate()).toBeCloseTo(3.0);
        expect(t.totalGain()).toBe(150);
        // Flat period must not raise (or lower) the recorded peak.
        t.sample(base + 150, 40_000);
        expect(t.peakRate()).toBeCloseTo(3.0);
        expect(t.currentRate()).toBe(0);
        t.reset();
        expect(t.peakRate()).toBe(0);
        expect(t.totalGain()).toBe(0);
    });
});
