/**
 * Shared efficiency helpers for <skill>-v2.ts benchmark bots.
 *
 * Self-contained and dependency-free: every SDK type is mirrored as a minimal
 * structural interface (`InventoryItemLike`) so this module compiles anywhere
 * the repo does — including standalone copies inside task containers — without
 * importing from `sdk/`.
 *
 * Three concerns, matching how the benchmark scores (peak real-game XP/min):
 *   1. Action pacing / tick budgeting   — don't hot-spin, don't overrun.
 *   2. Inventory-full checks            — drop only when actually full.
 *   3. XP/min estimation                — measure what the scorer measures.
 *
 * Normalization matches docker/check_xp_rate.ts exactly:
 *   raw server XP ÷ GAME_SPEED(8) ÷ XP_MULTIPLIER(25) = real-game XP.
 * A drift guard exists for these constants upstream; if the Docker image's
 * tick rate or xpRate changes, update them HERE too.
 */

// ── Benchmark constants (keep in sync with docker/check_xp_rate.ts) ─────────

/** Server tick interval in ms at 8x speed (docker/Dockerfile NODE_TICKRATE=50). */
export const SERVER_TICK_MS = 50;
/** Game-speed multiplier vs the default engine tick (400ms / 50ms). */
export const GAME_SPEED = 8;
/** Server xpRate (rs-sdk WorldConfig.ts; overridable via NODE_XPRATE). */
export const XP_MULTIPLIER = 25;
/** raw XP ÷ this = real-game XP. GAME_SPEED * XP_MULTIPLIER. */
export const XP_NORMALIZATION_DIVISOR = GAME_SPEED * XP_MULTIPLIER;
/** Standard OSRS inventory capacity used by all skill bots. */
export const INVENTORY_SIZE = 28;

// ── Structural types (mirror sdk/types.ts shapes we rely on) ────────────────

/** Minimal inventory item shape — satisfied by sdk/types.ts InventoryItem. */
export interface InventoryItemLike {
    slot: number;
    name: string;
    count?: number;
}

/** Anything that can be queried for "how many items am I carrying". */
export type InventorySource = readonly InventoryItemLike[] | number;

function invCount(inv: InventorySource): number {
    return typeof inv === 'number' ? inv : inv.length;
}

// ── 1. Action pacing / tick budgeting ───────────────────────────────────────

/** Convert game ticks to wall-clock ms at the benchmark's server tick rate. */
export function ticksToMs(ticks: number): number {
    return ticks * SERVER_TICK_MS;
}

/** Convert wall-clock ms to whole game ticks (floored). */
export function msToTicks(ms: number): number {
    return Math.floor(ms / SERVER_TICK_MS);
}

/**
 * Wall-clock budget for a loop or action attempt. Create once per run (or per
 * cycle), then gate the loop with `expired()` / `remaining()`. Purely
 * synchronous on purpose — pair it with `await sdk.waitForTicks(1)` yourself.
 */
export class TickBudget {
    readonly startedAt: number;
    readonly maxMs: number;

    constructor(maxMs: number, startedAt: number = Date.now()) {
        if (!Number.isFinite(maxMs) || maxMs <= 0) {
            throw new RangeError(`TickBudget maxMs must be > 0, got ${maxMs}`);
        }
        this.maxMs = maxMs;
        this.startedAt = startedAt;
    }

    elapsed(now: number = Date.now()): number {
        return Math.max(0, now - this.startedAt);
    }

    remaining(now: number = Date.now()): number {
        return Math.max(0, this.maxMs - this.elapsed(now));
    }

    expired(now: number = Date.now()): boolean {
        return this.remaining(now) <= 0;
    }

    /** True while there is still at least `minSliceMs` of budget left. */
    hasTimeFor(minSliceMs: number, now: number = Date.now()): boolean {
        return this.remaining(now) >= minSliceMs;
    }
}

/**
 * Minimum-interval pacer (throttle) for actions that must not be spammed —
 * re-clicks, relocation scans, status logs. `due()` says whether enough time
 * has passed since the last `touch()`; call `touch()` when you act.
 */
export class Pacer {
    private lastAt = -Infinity;

    constructor(readonly minIntervalMs: number) {
        if (!Number.isFinite(minIntervalMs) || minIntervalMs <= 0) {
            throw new RangeError(`Pacer minIntervalMs must be > 0, got ${minIntervalMs}`);
        }
    }

    due(now: number = Date.now()): boolean {
        return now - this.lastAt >= this.minIntervalMs;
    }

    touch(now: number = Date.now()): void {
        this.lastAt = now;
    }

    /** Consume the pacing slot if one is due; returns whether it fired. */
    tryFire(now: number = Date.now()): boolean {
        if (!this.due(now)) return false;
        this.touch(now);
        return true;
    }

    /** Ms until the next slot opens (0 when already due). */
    cooldownLeft(now: number = Date.now()): number {
        return Math.max(0, this.minIntervalMs - (now - this.lastAt));
    }
}

/**
 * Idle-timeout helper for "wait until something happens" loops: returns true
 * once `idleMs` of silence has accumulated, i.e. time to re-click or bail.
 */
export function isIdleTimeout(idleMs: number, timeoutMs: number): boolean {
    return idleMs >= timeoutMs && timeoutMs > 0;
}

// ── 2. Inventory-full checks ────────────────────────────────────────────────

/** True when the inventory has reached capacity (default 28 slots). */
export function isInventoryFull(inv: InventorySource, capacity: number = INVENTORY_SIZE): boolean {
    return invCount(inv) >= capacity;
}

/** Free slots left before the inventory is full. */
export function freeSlots(inv: InventorySource, capacity: number = INVENTORY_SIZE): number {
    return Math.max(0, capacity - invCount(inv));
}

/** Count carried items whose name matches `pattern`. */
export function countItems(inv: readonly InventoryItemLike[], pattern: RegExp): number {
    let n = 0;
    for (const item of inv) {
        if (pattern.test(item.name)) n += typeof item.count === 'number' ? item.count : 1;
    }
    return n;
}

/**
 * Slots whose items should be dropped: name matches `dropPattern` AND not
 * `keepPattern`. Typical use: drop ores/logs but never the pickaxe/tinderbox,
 * e.g. `findDropTargets(inv, /\bore\b/i, /pickaxe/i).map((i) => i.slot)`.
 */
export function findDropTargets(
    inv: readonly InventoryItemLike[],
    dropPattern: RegExp,
    keepPattern?: RegExp,
): InventoryItemLike[] {
    return inv.filter(
        (item) => dropPattern.test(item.name) && !(keepPattern && keepPattern.test(item.name)),
    );
}

/**
 * True when picking up / gaining `incoming` more stack-free items would fill
 * the inventory — check BEFORE committing to an action that adds items.
 */
export function wouldFillInventory(
    inv: InventorySource,
    incoming: number = 1,
    capacity: number = INVENTORY_SIZE,
): boolean {
    return freeSlots(inv, capacity) < incoming;
}

// ── 3. XP/min estimation ────────────────────────────────────────────────────

/** Raw (server-side) XP per minute over a measured span. */
export function rawXpPerMin(deltaXp: number, deltaMs: number): number {
    if (!(deltaMs > 0)) return 0;
    if (!(deltaXp > 0)) return 0;
    return (deltaXp / deltaMs) * 60_000;
}

/** Convert raw server XP/min to scored real-game XP/min. */
export function normalizeXpRate(rawRatePerMin: number, divisor: number = XP_NORMALIZATION_DIVISOR): number {
    return divisor > 0 ? rawRatePerMin / divisor : 0;
}

/** Scored real-game XP/min between two observations (0 when degenerate). */
export function estimateXpPerMin(
    startXp: number,
    endXp: number,
    startMs: number,
    endMs: number,
    divisor: number = XP_NORMALIZATION_DIVISOR,
): number {
    return normalizeXpRate(rawXpPerMin(endXp - startXp, endMs - startMs), divisor);
}

interface XpSample {
    at: number;
    xp: number;
}

/**
 * Online XP-rate tracker mirroring the scorer (`docker/check_xp_rate.ts`):
 * score = peak real-game XP/min over any 15-second sampling window.
 *
 * Feed it every loop iteration (cheap); read `peakRate()` in progress logs.
 * All timestamps are wall-clock ms (Date.now()) unless you pass your own.
 */
export class XpRateTracker {
    private samples: XpSample[] = [];
    private peak = 0;

    /**
     * @param peakWindowMs Scoring window width (the scorer uses 15s).
     * @param maxSamples   Ring size — old samples are pruned so long runs
     *                     stay O(window), not O(run).
     */
    constructor(
        readonly peakWindowMs: number = 15_000,
        readonly maxSamples: number = 600,
    ) {}

    /** Record the current cumulative XP for the tracked skill. */
    sample(xp: number, now: number = Date.now()): void {
        const last = this.samples[this.samples.length - 1];
        // Ignore duplicate back-to-back reads; they carry no rate information.
        if (last && last.xp === xp && now === last.at) return;
        this.samples.push({ at: now, xp });
        if (this.samples.length > this.maxSamples) {
            this.samples.splice(0, this.samples.length - this.maxSamples);
        }
        this.recomputePeak();
    }

    private recomputePeak(): void {
        const win = this.peakWindowMs;
        const s = this.samples;
        // Sliding two-pointer over sample pairs inside the window; bot-scale
        // sample counts make the inner scan negligible.
        for (let j = s.length - 1; j > 0; j--) {
            for (let i = j - 1; i >= 0; i--) {
                const deltaMs = s[j]!.at - s[i]!.at;
                if (deltaMs > win) break;
                const deltaXp = s[j]!.xp - s[i]!.xp;
                if (deltaXp <= 0 || deltaMs <= 0) continue;
                const rate = normalizeXpRate(rawXpPerMin(deltaXp, deltaMs));
                if (rate > this.peak) this.peak = rate;
            }
        }
    }

    /** Best real-game XP/min observed in any scoring window so far. */
    peakRate(): number {
        return this.peak;
    }

    /** Real-game XP/min over the most recent `windowMs` (0 if too little data). */
    currentRate(windowMs: number = this.peakWindowMs): number {
        const s = this.samples;
        if (s.length === 0) return 0;
        const newest = s[s.length - 1]!;
        let oldest: XpSample | undefined;
        for (let i = s.length - 1; i >= 0; i--) {
            if (newest.at - s[i]!.at <= windowMs) oldest = s[i];
            else break;
        }
        if (!oldest || oldest === newest) return 0;
        return estimateXpPerMin(oldest.xp, newest.xp, oldest.at, newest.at);
    }

    /** Total XP gained since tracking began. */
    totalGain(): number {
        if (this.samples.length < 2) return 0;
        const first = this.samples[0]!;
        const last = this.samples[this.samples.length - 1]!;
        return Math.max(0, last.xp - first.xp);
    }

    reset(): void {
        this.samples = [];
        this.peak = 0;
    }
}
