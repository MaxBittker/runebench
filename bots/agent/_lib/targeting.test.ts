import { describe, expect, test } from 'bun:test';

import {
    RespawnRotator,
    TargetCache,
    bestByScore,
    distanceBetween,
    euclideanDistance,
    filterTargets,
    hasOption,
    nearestTarget,
    targetKey,
    tileDistance,
    type TargetLike,
} from './targeting';

// Pure logic over fabricated state — no server connection needed.
// Fixtures mimic the SDK's NearbyLoc / NearbyNpc scan shapes structurally.

function loc(
    name: string,
    x: number,
    z: number,
    opts: Partial<TargetLike & { id: number }> = {},
): TargetLike & { id?: number } {
    return {
        id: 1000 + x * 10 + z,
        name,
        x,
        z,
        distance: Math.max(Math.abs(x), Math.abs(z)),
        reachable: true,
        options: [name],
        ...opts,
    };
}

describe('tile math', () => {
    test('tileDistance is Chebyshev (king-move) distance', () => {
        expect(tileDistance(0, 0, 3, 4)).toBe(4);
        expect(tileDistance(0, 0, 4, 3)).toBe(4);
        expect(tileDistance(5, 5, 5, 5)).toBe(0);
        expect(tileDistance(10, 2, 2, 10)).toBe(8);
    });

    test('distanceBetween / euclideanDistance', () => {
        expect(distanceBetween({ x: 1, z: 1 }, { x: 4, z: 5 })).toBe(4);
        expect(euclideanDistance({ x: 0, z: 0 }, { x: 3, z: 4 })).toBe(5);
    });
});

describe('filterTargets / nearestTarget', () => {
    const rocks = [
        loc('Iron rocks', 6, 6),
        loc('Copper rocks', 2, 2, { options: [] }), // depleted: no Mine option
        loc('Tin rocks', 3, 3),
        loc('Iron rocks', 40, 40),
    ];

    test('name pattern filters and sorts nearest-first', () => {
        const out = filterTargets(rocks, { namePattern: /iron/i });
        expect(out.map((r) => [r.x, r.z])).toEqual([
            [6, 6],
            [40, 40],
        ]);
    });

    test('optionPattern drops depleted objects (respawn-aware live scan)', () => {
        const out = filterTargets(rocks, { optionPattern: /copper/i });
        expect(out.length).toBe(0); // the only copper rock lost its option
    });

    test('reachableOnly drops reachable===false but keeps unknown', () => {
        const mixed = [
            loc('A', 1, 1, { reachable: false }),
            loc('B', 9, 9, { reachable: undefined }),
            loc('C', 2, 2),
        ];
        const out = filterTargets(mixed, { reachableOnly: true });
        expect(out.map((t) => t.name).sort()).toEqual(['B', 'C']);
    });

    test('maxTiles uses Chebyshev distance from `from`', () => {
        const out = filterTargets(rocks, { maxTiles: 7, from: { x: 0, z: 0 } });
        // (6,6)=6 tiles in, (3,3)=3, (2,2)=2 pass; (40,40) is out.
        expect(out.map((r) => r.x).sort((a, b) => a - b)).toEqual([2, 3, 6]);
    });

    test('excludeKeys removes a specific identity', () => {
        const banned = targetKey(rocks[0]!);
        const out = filterTargets(rocks, { excludeKeys: new Set([banned]) });
        expect(out.some((t) => targetKey(t) === banned)).toBe(false);
    });

    test('nearestTarget returns first of empty as null', () => {
        expect(nearestTarget([], {})).toBeNull();
        expect(nearestTarget(rocks, { namePattern: /runite/ })).toBeNull();
        expect(nearestTarget(rocks, {})!.x).toBe(2); // copper@2,2 is nearest overall
    });

    test('bestByScore picks minimum score (combat-style scoring)', () => {
        const npcs = [
            { name: 'cow', hpPct: 100, dist: 1 },
            { name: 'goblin', hpPct: 20, dist: 5 },
            { name: 'rat', hpPct: 50, dist: 2 },
        ];
        const picked = bestByScore(npcs, (n) => n.hpPct * 1.0 + n.dist * 2);
        expect(picked?.name).toBe('goblin'); // finishing kill wins
        expect(bestByScore([], () => 0)).toBeNull();
    });

    test('hasOption works on plain string arrays', () => {
        expect(hasOption({ name: 'furnace', x: 0, z: 0 }, /smelt/i)).toBe(false);
        expect(hasOption({ name: 'furnace', x: 0, z: 0, options: ['Smelt', 'Examine'] }, /smelt/i)).toBe(true);
    });

    test('hasOption also matches the SDK menu-entry shape (optionsWithIndex)', () => {
        const spot = {
            name: 'Fishing spot',
            x: 3087,
            z: 3230,
            optionsWithIndex: [
                { text: 'Net', opIndex: 1 },
                { text: 'Examine', opIndex: 99 },
            ],
        };
        expect(hasOption(spot, /^net$/i)).toBe(true);
        expect(hasOption(spot, /^bait$/i)).toBe(false);

        const mined = nearestTarget(
            [spot, loc('Rocks', 1, 1)],
            { optionPattern: /net/i },
        );
        expect(mined!.name).toBe('Fishing spot');
    });
});

describe('RespawnRotator', () => {
    test('marks depletion and gates re-selection until respawn elapses', () => {
        let now = 1000;
        const rot = new RespawnRotator({ respawnMs: 4000, now: () => now });
        const rock = { id: 2090, name: 'Rocks', x: 1, z: 1 };

        expect(rot.isReady(rock)).toBe(true); // never touched
        rot.markDepleted(rock);
        expect(rot.isReady(rock)).toBe(false);
        now += 3999;
        expect(rot.readyIn(rock)).toBe(1);
        now += 1;
        expect(rot.isReady(rock)).toBe(true);

        rot.prune();
        // After prune the memory is gone entirely.
        now += 10_000;
        rot.prune();
        expect(rot.readyIn(rock)).toBe(0);
    });

    test('per-name respawn windows', () => {
        let now = 0;
        const rot = new RespawnRotator({
            respawnMs: (name) => (/coal/i.test(name) ? 12_000 : 4_000),
            now: () => now,
        });
        rot.markDepleted({ id: 1, name: 'Coal rocks', x: 0, z: 0 });
        rot.markDepleted({ id: 2, name: 'Iron rocks', x: 5, z: 5 });
        now = 5_000;
        expect(rot.readyIn({ id: 2, name: 'Iron rocks', x: 5, z: 5 })).toBe(0);
        expect(rot.readyIn({ id: 1, name: 'Coal rocks', x: 0, z: 0 })).toBe(7_000);
    });

    test('rotate prefers a farther READY object over a nearer still-depleted one', () => {
        let now = 0;
        const rot = new RespawnRotator({ respawnMs: 4_000, now: () => now });
        const nearDepleted = loc('Iron rocks', 2, 2, { options: ['Examine'] }); // stale scan: no Mine
        const farReady = loc('Tin rocks', 8, 8);

        rot.markDepleted({ id: nearDepleted.id, name: nearDepleted.name, x: 2, z: 2 });

        const pick = rot.rotate([nearDepleted, farReady], { optionPattern: /rocks/i });
        // nearDepleted fails the option filter entirely; even without it the
        // rotator would skip it until its window elapses.
        expect(pick).not.toBeNull();
        expect(pick!.x).toBe(8);
    });

    test('rotate waits on the soonest-respawning object when all are depleted', () => {
        let now = 0;
        const rot = new RespawnRotator({ respawnMs: 4_000, now: () => now });
        const a = loc('Iron rocks', 1, 1, { id: 11 });
        const b = loc('Iron rocks', 2, 2, { id: 22 });
        rot.markDepleted({ id: 11, name: 'Iron rocks', x: 1, z: 1 }, 3_000); // ready at 7000
        rot.markDepleted({ id: 22, name: 'Iron rocks', x: 2, z: 2 }, 1_500); // ready at 5500

        now = 2_000;
        const wait = rot.rotate([a, b]);
        expect(wait).not.toBeNull();
        expect(wait!.id).toBe(22); // comes back first -> wait here

        now = 6_000;
        const next = rot.rotate([a, b]);
        expect(next!.id).toBe(22); // now genuinely ready; nearer tiebreak keeps b? b is also nearer
    });

    test('rotate returns null with no candidates at all', () => {
        const rot = new RespawnRotator({ respawnMs: 1_000, now: () => 0 });
        expect(rot.rotate([], {})).toBeNull();
        expect(rot.rotate([loc('Tree', 1, 1)], { namePattern: /rock/ })).toBeNull();
    });
});

describe('TargetCache', () => {
    test('stores and returns fresh values, drops stale ones', () => {
        let now = 1000;
        const cache = new TargetCache<string>({ ttlMs: 2000, now: () => now });
        const rock = { id: 2090, name: 'Copper rocks', x: 3, z: 3 };

        cache.set(TargetCache.keyOf(rock), 'mine-here');
        expect(cache.get(TargetCache.keyOf(rock))).toBe('mine-here');

        now += 2000; // exactly TTL -> still fresh (<= ttl)
        expect(cache.get(TargetCache.keyOf(rock))).toBe('mine-here');
        now += 1; // past TTL -> stale, entry dropped
        expect(cache.get(TargetCache.keyOf(rock))).toBeUndefined();

        cache.set(TargetCache.keyOf(rock), 'again');
        cache.invalidate(TargetCache.keyOf(rock));
        expect(cache.get(TargetCache.keyOf(rock))).toBeUndefined();
        expect(cache.size()).toBe(0);
    });

    test('getOrCompute memoizes per-target work and honors invalidation', () => {
        let now = 0;
        const cache = new TargetCache<number>({ ttlMs: 5000, now: () => now });
        const tree = { name: 'Tree', x: 1, z: 2 };
        const key = TargetCache.keyOf(tree);
        let computations = 0;

        const compute = () => ++computations * 10;
        expect(cache.getOrCompute(key, compute)).toBe(10);
        expect(cache.getOrCompute(key, compute)).toBe(10); // cached
        expect(computations).toBe(1);

        now += 5001; // stale
        expect(cache.getOrCompute(key, compute)).toBe(20);
        expect(computations).toBe(2);

        cache.clear();
        expect(cache.size()).toBe(0);
    });

    test('size counts only live entries', () => {
        let now = 0;
        const cache = new TargetCache<number>({ ttlMs: 1000, now: () => now });
        cache.set('a@1,1', 1);
        cache.set('b@2,2', 2);
        now += 1500;
        cache.set('c@3,3', 3);
        expect(cache.size()).toBe(1); // a and b aged out
    });
});

describe('module initializes end-to-end (bot-loop shaped smoke test)', () => {
    test('rotator + cache drive a mining-style selection loop', () => {
        let now = 0;
        const rotator = new RespawnRotator({
            respawnMs: (name) => (/coal/i.test(name) ? 12_000 : 4_000),
            now: () => now,
        });
        const estimates = new TargetCache<number>({ ttlMs: 60_000, now: () => now });

        // Live-scan fixtures in the SDK's optionsWithIndex shape.
        const copper = {
            id: 2090,
            name: 'Copper rocks',
            x: 2,
            z: 2,
            distance: 2,
            optionsWithIndex: [{ text: 'Mine', opIndex: 2 }],
        };
        const tin = {
            id: 2093,
            name: 'Tin rocks',
            x: 4,
            z: 3,
            distance: 4,
            optionsWithIndex: [{ text: 'Mine', opIndex: 2 }],
        };

        // Loop 1: copper wins (nearest).
        const pick1 = rotator.rotate([copper, tin], {
            namePattern: /rocks?/i,
            optionPattern: /^mine$/i,
        });
        expect(pick1!.name).toBe('Copper rocks');
        estimates.getOrCompute(TargetCache.keyOf(pick1!), () => 4000);

        // Interaction lands -> deplete; loop 2 must rotate to tin.
        rotator.markDepleted(pick1!);
        now += 500;
        const pick2 = rotator.rotate([copper, tin], {
            namePattern: /rocks?/i,
            optionPattern: /^mine$/i,
        });
        expect(pick2!.name).toBe('Tin rocks');

        // Tin depletes too -> nothing ready; wait on the sooner-respawning
        // one: copper was depleted at t=0 (ready 4000), tin at t=500
        // (ready 4500), so copper comes back first.
        rotator.markDepleted(pick2!);
        now += 250;
        const wait = rotator.rotate([copper, tin]);
        expect(wait!.name).toBe('Copper rocks');

        // After both windows elapse, prune clears memory and copper is back.
        now += 20_000;
        rotator.prune();
        estimates.clear();
        const pick3 = rotator.rotate([copper, tin], {
            namePattern: /rocks?/i,
            optionPattern: /^mine$/i,
        });
        expect(pick3!.name).toBe('Copper rocks');
        expect(estimates.get(TargetCache.keyOf(copper))).toBeUndefined(); // cleared above
    });
});
