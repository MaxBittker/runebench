import { describe, expect, test } from 'bun:test';

import {
    MAX_ATTEMPTS_HARD_CAP,
    delay,
    isTransientActionResult,
    locRevalidator,
    retryAction,
    sendInteractLocRetrying,
    type InteractLocSender,
} from './recovery';
import type { ActionResult } from '../../../sdk/types';

// Pure logic over fabricated results and sender doubles — no server connection needed.

function ok(message = 'sent'): ActionResult {
    return { success: true, message };
}

function fail(overrides: Partial<ActionResult> = {}): ActionResult {
    return { success: false, message: 'failed', ...overrides };
}

/** Sender double whose sendInteractLoc fails N times before succeeding. */
function flakySender(failTimes: number, failure: ActionResult): InteractLocSender & { calls: number } {
    let calls = 0;
    return {
        get calls() {
            return calls;
        },
        async sendInteractLoc(): Promise<ActionResult> {
            calls++;
            return calls <= failTimes ? failure : ok();
        },
    };
}

describe('isTransientActionResult', () => {
    test('successes are never transient', () => {
        expect(isTransientActionResult(ok())).toBe(false);
    });

    test('dispatch-phase losses are transient', () => {
        expect(isTransientActionResult(fail({ phase: 'dispatch', reason: 'error' }))).toBe(true);
        expect(isTransientActionResult(fail({ phase: 'dispatch', reason: 'timeout' }))).toBe(true);
        expect(isTransientActionResult(fail({ phase: 'dispatch', reason: 'disconnected' }))).toBe(true);
    });

    test('timeout / no_response / busy reasons are transient even without a phase', () => {
        expect(isTransientActionResult(fail({ reason: 'timeout' }))).toBe(true);
        expect(isTransientActionResult(fail({ reason: 'no_response' }))).toBe(true);
        expect(isTransientActionResult(fail({ reason: 'busy' }))).toBe(true);
    });

    test('world-state refusals and validation failures are permanent', () => {
        expect(isTransientActionResult(fail({ reason: 'cant_reach' }))).toBe(false);
        expect(isTransientActionResult(fail({ reason: 'no_match' }))).toBe(false);
        expect(isTransientActionResult(fail({ reason: 'item_not_found' }))).toBe(false);
        expect(isTransientActionResult(fail({ phase: 'validation', reason: 'error' }))).toBe(false);
        expect(isTransientActionResult(fail({ phase: 'routing', reason: 'error' }))).toBe(false);
    });
});

describe('retryAction', () => {
    test('retries transient failures and eventually succeeds', async () => {
        const attempts: number[] = [];
        const outcome = await retryAction(
            async (attempt) => {
                attempts.push(attempt);
                return attempt < 3 ? fail({ phase: 'dispatch', reason: 'timeout' }) : ok();
            },
            { initialDelayMs: 1, maxDelayMs: 4 },
        );
        expect(outcome.succeeded).toBe(true);
        expect(outcome.attempts).toBe(3);
        expect(outcome.result.success).toBe(true);
        expect(attempts).toEqual([1, 2, 3]);
    });

    test('gives up after maxAttempts on persistent transient failure (bounded)', async () => {
        let calls = 0;
        const outcome = await retryAction(
            async () => {
                calls++;
                return fail({ phase: 'dispatch', reason: 'disconnected' });
            },
            { maxAttempts: 4, initialDelayMs: 1 },
        );
        expect(calls).toBe(4);
        expect(outcome.succeeded).toBe(false);
        expect(outcome.attempts).toBe(4);
    });

    test('does NOT retry permanent failures', async () => {
        let calls = 0;
        const outcome = await retryAction(
            async () => {
                calls++;
                return fail({ reason: 'cant_reach' });
            },
            { maxAttempts: 5, initialDelayMs: 1 },
        );
        expect(calls).toBe(1);
        expect(outcome.succeeded).toBe(false);
    });

    test('honors a custom shouldRetry predicate', async () => {
        let calls = 0;
        const outcome = await retryAction(
            async () => {
                calls++;
                return fail({ reason: 'weird_reason' });
            },
            { maxAttempts: 3, initialDelayMs: 1, shouldRetry: () => true },
        );
        expect(calls).toBe(3);
        expect(outcome.attempts).toBe(3);
    });

    test('backoff delays grow but stay clamped to maxDelayMs', async () => {
        const delays: number[] = [];
        await retryAction(
            async () => fail({ phase: 'dispatch', reason: 'timeout' }),
            {
                maxAttempts: 6,
                initialDelayMs: 10,
                backoffFactor: 3,
                maxDelayMs: 50,
                onRetry: ({ delayMs }) => delays.push(delayMs),
            },
        );
        // 10, 30, then clamped at 50 forever.
        expect(delays).toEqual([10, 30, 50, 50, 50]);
    });

    test('maxAttempts is hard-capped regardless of options (no infinite loops)', async () => {
        let calls = 0;
        await retryAction(
            async () => {
                calls++;
                return fail({ phase: 'dispatch', reason: 'error' });
            },
            { maxAttempts: 100000, initialDelayMs: 0 },
        );
        expect(calls).toBe(MAX_ATTEMPTS_HARD_CAP);
        expect(calls).toBeLessThanOrEqual(10);
    });
});

describe('sendInteractLocRetrying', () => {
    test('succeeds after transient dispatch failures', async () => {
        const sender = flakySender(
            2,
            fail({ phase: 'dispatch', reason: 'timeout', message: 'Action timed out: interactLoc' }),
        );
        const outcome = await sendInteractLocRetrying(sender, 3190, 3255, 1001, 2, { initialDelayMs: 1 });
        expect(sender.calls).toBe(3); // first try + 2 retries
        expect(outcome.succeeded).toBe(true);
        expect(outcome.result.success).toBe(true);
    });

    test('passes raw arguments straight through to the underlying sender', async () => {
        const seen: Array<{ x: number; z: number; id: number; opt?: number }> = [];
        const sender: InteractLocSender & { seen: typeof seen } = {
            async sendInteractLoc(x, z, locId, option) {
                seen.push({ x, z, id: locId, opt: option });
                return ok();
            },
            get seen() {
                return seen;
            },
        };
        const outcome = await sendInteractLocRetrying(sender, 10, 20, 300, 4);
        expect(seen).toEqual([{ x: 10, z: 20, id: 300, opt: 4 }]);
        expect(outcome.attempts).toBe(1);
    });

    test('returns the last failure without looping when retries are exhausted', async () => {
        const sender = flakySender(Number.MAX_SAFE_INTEGER, fail({ phase: 'dispatch', reason: 'error' }));
        const outcome = await sendInteractLocRetrying(sender, 0, 0, 1, 1, { maxAttempts: 3, initialDelayMs: 1 });
        expect(sender.calls).toBe(3);
        expect(outcome.succeeded).toBe(false);
    });

    test('refreshTarget re-resolves stale coordinates between attempts', async () => {
        const targets: string[] = [];
        const sender: InteractLocSender = {
            async sendInteractLoc(x, z, locId) {
                targets.push(`${x},${z},${locId}`);
                return targets.length < 3 ? fail({ phase: 'dispatch', reason: 'timeout' }) : ok();
            },
        };
        const refreshed: Array<{ x: number; z: number; locId: number }> = [];
        const outcome = await sendInteractLocRetrying(sender, 1, 2, 100, 1, {
            initialDelayMs: 1,
            refreshTarget: (prev) => {
                const next = { x: prev.x + 1, z: prev.z + 1, locId: prev.locId + 1 };
                refreshed.push(next);
                return next;
            },
        });
        expect(refreshed.length).toBeGreaterThanOrEqual(2);
        // Later attempts used the refreshed target.
        expect(targets[targets.length - 1]).toBe('3,4,102');
        expect(outcome.succeeded).toBe(true);
    });

    test('refreshTarget returning null keeps the original target (no crash)', async () => {
        const sender = flakySender(1, fail({ phase: 'dispatch', reason: 'timeout' }));
        const outcome = await sendInteractLocRetrying(sender, 5, 6, 42, 1, {
            initialDelayMs: 1,
            refreshTarget: () => null,
        });
        expect(outcome.succeeded).toBe(true);
        expect(sender.calls).toBe(2);
    });

    test('does not call refreshTarget when the first attempt succeeds', async () => {
        const sender = flakySender(0, fail());
        let refreshCalls = 0;
        await sendInteractLocRetrying(sender, 1, 1, 1, 1, {
            refreshTarget: () => {
                refreshCalls++;
                return null;
            },
        });
        expect(refreshCalls).toBe(0);
        expect(sender.calls).toBe(1);
    });
});

describe('locRevalidator', () => {
    function sdkWithLocs(locs: Array<{ x: number; z: number; id?: number; name?: string }>) {
        return { getNearbyLocs: () => locs };
    }

    test('picks the matching loc nearest the stale coordinates', () => {
        const revalidate = locRevalidator(
            sdkWithLocs([
                { x: 20, z: 20, id: 7, name: 'Tree' },
                { x: 11, z: 12, id: 8, name: 'Oak tree' },
            ]),
            /tree/i,
        );
        expect(revalidate({ x: 10, z: 10, locId: 99 })).toEqual({ x: 11, z: 12, locId: 8 });
    });

    test('returns null when no live loc matches (target gone for good)', () => {
        const revalidate = locRevalidator(sdkWithLocs([{ x: 1, z: 1, id: 7, name: 'Rocks' }]), /tree/i);
        expect(revalidate({ x: 1, z: 1, locId: 99 })).toBeNull();
    });

    test('returns null when the best match has no usable id', () => {
        const revalidate = locRevalidator(sdkWithLocs([{ x: 1, z: 1, name: 'Tree' }]), /tree/i);
        expect(revalidate({ x: 1, z: 1, locId: 99 })).toBeNull();
    });

    test('end-to-end: retry follows the respawned target via locRevalidator', async () => {
        // Attempt 1 hits the old tile (stale id) and times out; by attempt 2
        // the scan shows the same kind of object respawned at a new tile.
        const locs = [{ x: 30, z: 30, id: 555, name: 'Tree' }];
        const sender: InteractLocSender & { seen: string[] } = {
            seen: [],
            async sendInteractLoc(x, z, locId) {
                this.seen.push(`${x},${z},${locId}`);
                if (this.seen.length === 1) return fail({ phase: 'dispatch', reason: 'timeout' });
                return ok();
            },
        };
        const fakeSdk = {
            sendInteractLoc: sender.sendInteractLoc.bind(sender),
            getNearbyLocs: () => locs,
        };
        const outcome = await sendInteractLocRetrying(fakeSdk, 10, 10, 100, 1, {
            initialDelayMs: 1,
            refreshTarget: locRevalidator(fakeSdk, /tree/i),
        });
        expect(outcome.succeeded).toBe(true);
        expect(sender.seen).toEqual(['10,10,100', '30,30,555']);
    });
});

describe('delay', () => {
    test('resolves after roughly the requested time', async () => {
        const t0 = Date.now();
        await delay(15);
        expect(Date.now() - t0).toBeGreaterThanOrEqual(10);
    });
});
