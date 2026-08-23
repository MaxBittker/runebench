/**
 * Shared targeting/selection utilities for <skill>-best.ts / <skill>-v2 bots.
 *
 * Extracts the targeting patterns every skill bot was re-implementing inline
 * (`mining-best.ts` nearest-rock scoring, woodcutting tree rotation,
 * attack-v2 NPC scoring) into one pure, unit-testable module:
 *
 *   1. Nearest-resource scoring  — `filterTargets` / `nearestTarget`
 *      (name + option + reachability + max-range filtering, nearest-first,
 *      stable order).
 *   2. Respawn-aware object picking — `RespawnRotator`: remembers WHICH
 *      tiles were just depleted and for how long, so a stale scan (or an
 *      option lingering a tick) can't make the bot re-click a rock/tree
 *      that isn't there yet, and so it rotates across equivalent objects
 *      instead of hammering one tile.
 *   3. Target caching — `TargetCache`: TTL cache keyed by stable identity,
 *      for expensive lookups (path checks, per-name respawn estimates)
 *      between state frames. Injectable clock keeps it testable.
 *   4. Tile-distance math — `tileDistance` (Chebyshev, the OSRS routing
 *      metric) and `euclideanDistance`.
 *
 * Design rules:
 *   - SELF-CONTAINED: zero imports. Structurally compatible with the SDK's
 *     `NearbyLoc` / `NearbyNpc` scans (including their `optionsWithIndex`
 *     option lists) and with fabricated test fixtures alike.
 *   - PURE except `RespawnRotator` / `TargetCache`, whose clocks are
 *     injectable (`now`), so everything is unit-testable without a server.
 *
 * Usage from a bot script (the usual runScript loop):
 *
 *   import { runScript } from '../../sdk/runner';
 *   import { nearestTarget, RespawnRotator } from './_lib/targeting';
 *
 *   await runScript(async ({ sdk }) => {
 *       const rotator = new RespawnRotator({ respawnMs: 4000 });
 *       // ...per loop:
 *       const state = sdk.getState();
 *       const pick = rotator.rotate(state.nearbyLocs, {
 *           namePattern: /rocks? (copper|tin)/i,
 *           optionPattern: /^mine$/i,
 *       });
 *   });
 */

// ─────────────────────────────────────────────────────────────────────────────
// Tile math
// ─────────────────────────────────────────────────────────────────────────────

/** Anything positioned on the world grid. */
export interface Tile {
    x: number;
    z: number;
}

/**
 * Chebyshev ("king move") distance in tiles — the metric the game's own
 * `distance` readouts and interaction ranges use: you can step diagonally,
 * so distance is the larger of the axis gaps.
 */
export function tileDistance(ax: number, az: number, bx: number, bz: number): number {
    return Math.max(Math.abs(ax - bx), Math.abs(az - bz));
}

/** {@link tileDistance} for two tiles. */
export function distanceBetween(a: Tile, b: Tile): number {
    return tileDistance(a.x, a.z, b.x, b.z);
}

/** Straight-line tile distance — what `Math.hypot(dx, dz)` anchor checks use. */
export function euclideanDistance(a: Tile, b: Tile): number {
    return Math.hypot(a.x - b.x, a.z - b.z);
}

// ─────────────────────────────────────────────────────────────────────────────
// Nearest-target selection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Structural shape shared by NearbyLoc, NearbyNpc and fabricated fixtures.
 * Options may arrive either as plain text strings (`options`) or as the SDK's
 * `{ text, opIndex }` menu entries (`optionsWithIndex`) — both are matched by
 * `optionPattern`. Objects without either never match an `optionPattern`.
 */
export interface TargetLike extends Tile {
    name: string;
    /** Server-reported distance; used for ranking when present. */
    distance?: number;
    /** `false` = client routefinder says unreachable; unknown = undefined. */
    reachable?: boolean;
    /** Convenience option-text array from some SDK scans. */
    options?: readonly string[];
    /** Menu-entry array from `nearbyLocs`/`nearbyNpcs` (`{text, opIndex}`). */
    optionsWithIndex?: readonly { text: string }[];
}

/** Filter applied by {@link filterTargets}. Every field is optional ANDed. */
export interface TargetFilter {
    /** Name must match (case handled by caller's regex flags). */
    namePattern?: RegExp;
    /**
     * The target must CURRENTLY publish a matching interaction option.
     * Depleted rocks / felled trees drop their Mine/Chop option until they
     * respawn — this single check is what makes gather bots respawn-aware
     * against live scans.
     */
    optionPattern?: RegExp;
    /** Drop `reachable === false` targets (unknown reachability still passes). */
    reachableOnly?: boolean;
    /** Hard cap on Chebyshev tile distance from `from`. */
    maxTiles?: number;
    /** Reference tile for `maxTiles`. */
    from?: Tile;
    /** Explicit exclusions (e.g. tiles the last attempt failed on). */
    excludeKeys?: ReadonlySet<string>;
}

/** Stable nearest-first sort key: server distance when known, else tile coords order. */
function rankKey(t: TargetLike, from?: Tile): number {
    if (typeof t.distance === 'number') return t.distance;
    if (from) return distanceBetween(from, t);
    return Number.MAX_SAFE_INTEGER;
}

/** True when the target currently publishes an option matching `pattern`. */
export function hasOption(target: TargetLike, pattern: RegExp): boolean {
    if (Array.isArray(target.options) && target.options.some((o) => pattern.test(o))) return true;
    if (
        Array.isArray(target.optionsWithIndex) &&
        target.optionsWithIndex.some((o) => pattern.test(o.text))
    ) {
        return true;
    }
    return false;
}

/**
 * Filter + nearest-first sort. Returns a NEW array; never mutates input.
 * Empty input yields `[]`.
 */
export function filterTargets<T extends TargetLike>(
    targets: readonly T[],
    filter: TargetFilter = {},
): T[] {
    const out = targets.filter((t) => {
        if (filter.namePattern && !filter.namePattern.test(t.name)) return false;
        if (filter.optionPattern && !hasOption(t, filter.optionPattern)) return false;
        if (filter.reachableOnly && t.reachable === false) return false;
        if (filter.excludeKeys?.has(targetKey(t))) return false;
        if (filter.maxTiles !== undefined) {
            const d = filter.from ? distanceBetween(filter.from, t) : rankKey(t);
            if (d > filter.maxTiles) return false;
        }
        return true;
    });
    // Stable nearest-first (Array.prototype.sort is stable in ES2019+).
    return out.sort((a, b) => rankKey(a, filter.from) - rankKey(b, filter.from));
}

/** Convenience wrapper: best target or null. */
export function nearestTarget<T extends TargetLike>(
    targets: readonly T[],
    filter: TargetFilter = {},
): T | null {
    return filterTargets(targets, filter)[0] ?? null;
}

/**
 * Generic scored selector for combat-style targeting (attack-v2 pattern):
 * lower score wins, ties broken by scan order (stable). Returns null on empty.
 */
export function bestByScore<T>(items: readonly T[], score: (item: T) => number): T | null {
    let best: T | null = null;
    let bestScore = Infinity;
    for (const item of items) {
        const s = score(item);
        if (s < bestScore) {
            bestScore = s;
            best = item;
        }
    }
    return best;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stable identity
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stable identity for a world object: id when known (locs/npcs), else name,
 * pinned to its south-west tile so twin objects at different tiles stay distinct.
 */
export function targetKey(t: Tile & { id?: number; name?: string }): string {
    const label = t.id !== undefined ? String(t.id) : (t.name ?? '');
    return `${label}@${t.x},${t.z}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Respawn-aware object rotation
// ─────────────────────────────────────────────────────────────────────────────

export interface RespawnRotatorConfig {
    /**
     * How long (ms) a depleted object takes to respawn. Either a constant or
     * a per-name estimate (e.g. rocks: 4000 normal, coal 12000).
     */
    respawnMs: number | ((name: string) => number);
    /** Injectable clock (defaults to Date.now) — makes the class testable. */
    now?: () => number;
}

/**
 * Tracks recently-depleted world objects so bots can rotate across a cluster
 * instead of re-clicking the same tile:
 *
 *   - `markDepleted()` the moment an interaction lands but the object vanishes
 *     (option dropped from the scan, or the loc disappeared).
 *   - `isReady()` gates re-selection until the respawn window has elapsed —
 *     covers BOTH stale scans (state frame older than the depletion) and
 *     lingering options.
 *   - `rotate()` = filterTargets + skip-not-ready + prefer-nearest-ready,
 *     falling back to the nearest not-yet-respawned object ONLY when nothing
 *     else qualifies (so the bot waits on the best tile instead of wandering).
 */
export class RespawnRotator {
    private readonly depletedAt = new Map<string, { at: number; name: string }>();
    private readonly respawnFor: (name: string) => number;
    private readonly clock: () => number;

    constructor(config: RespawnRotatorConfig) {
        const respawn = config.respawnMs;
        this.respawnFor = typeof respawn === 'function' ? respawn : () => respawn;
        this.clock = config.now ?? Date.now;
    }

    /** Record that the object at this identity deplete NOW. */
    markDepleted(target: Tile & { id?: number; name?: string }, at?: number): void {
        this.depletedAt.set(targetKey(target), { at: at ?? this.clock(), name: target.name ?? '' });
    }

    /** Forget entries whose respawn window has fully elapsed (call once per loop). */
    prune(): void {
        const now = this.clock();
        for (const [key, entry] of this.depletedAt) {
            if (entry.at + this.respawnFor(entry.name) <= now) this.depletedAt.delete(key);
        }
    }

    /** ms until the object is believed respawned (0 = ready / never touched). */
    readyIn(target: Tile & { id?: number; name?: string }): number {
        const key = targetKey(target);
        const entry = this.depletedAt.get(key);
        if (entry === undefined) return 0;
        return Math.max(0, entry.at + this.respawnFor(entry.name || target.name || '') - this.clock());
    }

    isReady(target: Tile & { id?: number; name?: string }): boolean {
        return this.readyIn(target) === 0;
    }

    /**
     * Pick the next object to interact with: live-option filtering via
     * `filter`, minus objects still inside their respawn window. When every
     * candidate is depleted, returns the one closest to respawning (null
     * only when there are no candidates at all) so callers can wait in place.
     */
    rotate<T extends TargetLike & { id?: number }>(
        candidates: readonly T[],
        filter: TargetFilter = {},
    ): T | null {
        const pool = filterTargets(candidates, filter);
        if (pool.length === 0) return null;
        const ready = pool.filter((t) => this.isReady(t));
        if (ready.length > 0) return ready[0]!;
        // All known candidates are within their respawn window: wait on the
        // one that comes back first (pool is already nearest-first; break the
        // tie by smallest remaining respawn time).
        return pool.reduce((a, b) => (this.readyIn(b) < this.readyIn(a) ? b : a));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Target caching
// ─────────────────────────────────────────────────────────────────────────────

export interface TargetCacheConfig {
    /** Entries older than this (ms) are stale. Default 2000 (~1-2 state frames). */
    ttlMs?: number;
    /** Injectable clock (defaults to Date.now) — makes the class testable. */
    now?: () => number;
}

interface CacheEntry<T> {
    value: T;
    at: number;
}

/**
 * Tiny TTL cache for per-target computations that are too expensive to redo
 * every loop iteration (walkability probes, respawn-time estimates learned
 * from observation, last-known-good picks). Keyed by {@link targetKey}, clock
 * injectable for tests.
 *
 *   - `get(key)` returns the cached value while fresh, `undefined` once stale.
 *   - `getOrCompute(target, fn)` memoizes `fn(target)` under the target key.
 *   - `set` / `invalidate` / `clear` manage entries directly.
 */
export class TargetCache<T> {
    private readonly entries = new Map<string, CacheEntry<T>>();
    private readonly ttl: number;
    private readonly clock: () => number;

    constructor(config: TargetCacheConfig = {}) {
        this.ttl = config.ttlMs ?? 2_000;
        this.clock = config.now ?? Date.now;
    }

    /** Cached value if fresh, else undefined (stale entries are dropped). */
    get(key: string): T | undefined {
        const e = this.entries.get(key);
        if (e === undefined) return undefined;
        if (this.clock() - e.at > this.ttl) {
            this.entries.delete(key);
            return undefined;
        }
        return e.value;
    }

    set(key: string, value: T, at?: number): void {
        this.entries.set(key, { value, at: at ?? this.clock() });
    }

    /** Memoize an expensive per-target computation. */
    getOrCompute(key: string, compute: () => T): T {
        const hit = this.get(key);
        if (hit !== undefined) return hit;
        const value = compute();
        this.set(key, value);
        return value;
    }

    invalidate(key: string): void {
        this.entries.delete(key);
    }

    clear(): void {
        this.entries.clear();
    }

    /** Number of live (fresh) entries. */
    size(): number {
        const now = this.clock();
        let n = 0;
        for (const [k, e] of this.entries) {
            if (now - e.at <= this.ttl) n++;
            else this.entries.delete(k);
        }
        return n;
    }

    /** Convenience: cache keyed directly off a world object's identity. */
    static keyOf(t: Tile & { id?: number; name?: string }): string {
        return targetKey(t);
    }
}
