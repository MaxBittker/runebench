/**
 * Shared recovery infrastructure: retry-with-backoff for transient action
 * failures, with stale-target revalidation.
 *
 * The raw senders on `BotSDK` (`sendInteractLoc`, `sendInteractNpc`, ...) are
 * fire-and-forget at the transport level: an `ActionResult` with
 * `success: false` and `phase: 'dispatch'` means the packet never reached the
 * engine (action timeout, dropped gateway connection, transient error). Those
 * failures are worth retrying; deterministic refusals (`cant_reach`,
 * `no_match`, `item_not_found`, validation errors) are not — retrying them
 * just burns ticks. Worse, a location object can deplete or despawn between
 * attempts (trees, rocks), so a blind retry can hit a stale tile — the
 * `refreshTarget` hook re-resolves the target before each retry instead.
 *
 * Everything here is bounded: `maxAttempts` is hard-capped and the backoff is
 * clamped, so a wrapper call always terminates. The raw API stays untouched —
 * this module only wraps it, so no existing call site changes behaviour.
 *
 * Dependency-light by design (mirrors the `bots/agent/_lib` convention): the
 * sender is matched structurally, so any object exposing `sendInteractLoc`
 * works — the real `BotSDK` or a test double.
 */

import type { ActionResult } from '../../../sdk/types';

// ── Transient-failure classification ────────────────────────────────────────

/** Failure reasons that a later attempt, without changing anything else, can plausibly resolve. */
const TRANSIENT_REASONS = new Set(['timeout', 'no_response', 'busy', 'disconnected', 'error']);

/**
 * Decide whether a failed result is worth another attempt.
 *
 * Transient  → dispatch-phase losses (timeout / disconnected / error) and
 *              timeout/no_response/busy reasons.
 * Permanent  → validation-phase rejections and world-state refusals such as
 *              `cant_reach` / `no_match`; callers must change something
 *              (position, target) before those can succeed.
 */
export function isTransientActionResult(result: ActionResult): boolean {
    if (result.success) return false;
    if (result.phase === 'validation' || result.phase === 'routing') return false;
    if (result.phase === 'dispatch') return true;
    const reason = (result.reason ?? '').toLowerCase();
    return TRANSIENT_REASONS.has(reason);
}

// ── Options & outcome ───────────────────────────────────────────────────────

export interface RetryWithBackoffOptions {
    /** Total attempts INCLUDING the first. Default 3, hard cap 10. */
    maxAttempts?: number;
    /** Delay before the first retry. Default 200ms. */
    initialDelayMs?: number;
    /** Ceiling for any single backoff delay. Default 1600ms. */
    maxDelayMs?: number;
    /** Multiplier applied per retry. Default 2 (exponential). */
    backoffFactor?: number;
    /**
     * Override the transient-failure test. Return true to retry this failure.
     * Defaults to {@link isTransientActionResult}.
     */
    shouldRetry?: (result: ActionResult) => boolean;
    /** Observability hook, called before each retry (not after the last attempt). */
    onRetry?: (info: { attempt: number; delayMs: number; lastResult: ActionResult }) => void;
}

/** Hard bounds so a misconfigured caller can never spin forever. */
export const MAX_ATTEMPTS_HARD_CAP = 10;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_INITIAL_DELAY_MS = 200;
const DEFAULT_MAX_DELAY_MS = 1600;
const DEFAULT_BACKOFF_FACTOR = 2;

export interface RetryOutcome<T> {
    /** The LAST result observed (the successful one when `succeeded`). */
    result: T;
    attempts: number;
    succeeded: boolean;
}

// ── Core wrapper ────────────────────────────────────────────────────────────

export function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Clamp user options into safe defaults. */
function normalizeOptions(opts: RetryWithBackoffOptions = {}): Required<
    Pick<RetryWithBackoffOptions, 'maxAttempts' | 'initialDelayMs' | 'maxDelayMs' | 'backoffFactor'>
> &
    Pick<RetryWithBackoffOptions, 'shouldRetry' | 'onRetry'> {
    const maxAttempts = Math.min(Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS), MAX_ATTEMPTS_HARD_CAP);
    const initialDelayMs = Math.max(0, opts.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS);
    const maxDelayMs = Math.max(initialDelayMs, opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS);
    const backoffFactor = Math.max(1, opts.backoffFactor ?? DEFAULT_BACKOFF_FACTOR);
    return { maxAttempts, initialDelayMs, maxDelayMs, backoffFactor, shouldRetry: opts.shouldRetry, onRetry: opts.onRetry };
}

function computeBackoffDelay(
    attempt: number,
    o: { initialDelayMs: number; maxDelayMs: number; backoffFactor: number },
): number {
    // attempt is the attempt that just FAILED (1-based); first retry delay uses it directly.
    const raw = o.initialDelayMs * Math.pow(o.backoffFactor, attempt - 1);
    return Math.min(raw, o.maxDelayMs);
}

/**
 * Retry `fn` while it returns a transient failure.
 *
 * Calls `fn` up to `maxAttempts` times. Between attempts, waits an
 * exponentially growing, clamped delay. Throws only what `fn` throws
 * (unexpected exceptions are not retried here — senders already convert
 * dispatch errors into results). Never loops forever: attempts are bounded
 * by construction.
 */
export async function retryAction<T extends ActionResult>(
    fn: (attempt: number) => Promise<T>,
    opts: RetryWithBackoffOptions = {},
): Promise<RetryOutcome<T>> {
    const o = normalizeOptions(opts);
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        attempt++;
        const result = await fn(attempt);
        if (result.success || attempt >= o.maxAttempts) {
            return { result, attempts: attempt, succeeded: result.success };
        }
        const transient = o.shouldRetry ? o.shouldRetry(result) : isTransientActionResult(result);
        if (!transient) {
            return { result, attempts: attempt, succeeded: false };
        }
        const delayMs = computeBackoffDelay(attempt, o);
        o.onRetry?.({ attempt, delayMs, lastResult: result });
        await delay(delayMs);
    }
}

// ── sendInteractLoc wrapper ─────────────────────────────────────────────────

/** Structural slice of BotSDK needed to interact with a location. */
export interface InteractLocSender {
    sendInteractLoc(x: number, z: number, locId: number, option?: number): Promise<ActionResult>;
}

/** Structural slice of BotSDK needed by the built-in stale-target revalidator. */
export interface LocFinder {
    getNearbyLocs(): Array<{ x: number; z: number; id?: number; name?: string }>;
}

export interface SendInteractLocRetryingOptions extends RetryWithBackoffOptions {
    /**
     * Re-resolve the target before each retry. Location objects deplete /
     * despawn (trees, rocks), so a retry against a stale id can silently hit
     * nothing. When provided, receives the previous target and returns fresh
     * coordinates + id (or null to give up).
     */
    refreshTarget?: (
        previous: { x: number; z: number; locId: number },
    ) => { x: number; z: number; locId: number } | null;
}

/**
 * Build a `refreshTarget` hook that revalidates the stale target against the
 * bot's CURRENT `nearbyLocs` scan before each retry: it looks for an object
 * matching `pattern` nearest to the previous coordinates (falling back to any
 * match) whose id still publishes the wanted option, so retries follow the
 * object if it respawned elsewhere — or give up (null) when nothing matches.
 *
 *   const refresh = locRevalidator(sdk, /^tree( oak)?$/i);
 *   await sendInteractLocRetrying(sdk, x, z, tree.id, 1, { refreshTarget: refresh });
 */
export function locRevalidator(
    sdk: LocFinder,
    pattern: RegExp,
): (previous: { x: number; z: number; locId: number }) => { x: number; z: number; locId: number } | null {
    return (previous) => {
        const matches = sdk.getNearbyLocs().filter((l) => pattern.test(l.name ?? ''));
        if (matches.length === 0) return null;
        const dist = (l: { x: number; z: number }) =>
            Math.max(Math.abs(l.x - previous.x), Math.abs(l.z - previous.z));
        const best = matches.reduce((a, b) => (dist(b) < dist(a) ? b : a));
        if (best.id === undefined) return null;
        return { x: best.x, z: best.z, locId: best.id };
    };
}

/**
 * `sdk.sendInteractLoc` with bounded retry-with-backoff for transient
 * dispatch failures and optional stale-target revalidation between attempts.
 * The raw method remains available and unchanged; use this where a dropped
 * packet would otherwise waste a whole loop iteration.
 *
 * Returns the final ActionResult plus how many attempts it took.
 */
export async function sendInteractLocRetrying(
    sdk: InteractLocSender,
    x: number,
    z: number,
    locId: number,
    option: number = 1,
    opts: SendInteractLocRetryingOptions = {},
): Promise<RetryOutcome<ActionResult>> {
    const { refreshTarget, ...retryOpts } = opts;
    let target = { x, z, locId };
    return retryAction(async () => {
        const r = await sdk.sendInteractLoc(target.x, target.z, target.locId, option);
        if (!r.success && refreshTarget) {
            const next = refreshTarget(target);
            if (next) target = next;
        }
        return r;
    }, retryOpts);
}
