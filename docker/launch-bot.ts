/**
 * Launches a headless Puppeteer browser with the game bot client,
 * connects via SDK to skip the tutorial, then monitors client health
 * for the rest of the run.
 *
 * This runs as a background process in the container entrypoint so
 * the bot is in-game and ready before the agent starts.
 *
 * Health monitoring exists because "process alive" says nothing about the
 * client: a chromium page can lose its game/gateway connections and sit on a
 * disconnect screen forever while every PID check reads healthy (split-market
 * run 2026-08-14: bot out of the game for 11 minutes until the agent itself
 * relaunched a browser). The monitor reloads the page when the client goes
 * unhealthy, and exits non-zero when it can't recover - converting every
 * failure mode into something the entrypoint's PID watchdog can see.
 */
// NOTE: This script must be run from /app/gateway (cd /app/gateway && bun run /app/launch-bot.ts)
// so that 'puppeteer' resolves from gateway's node_modules (avoids bun+debug compat issue at root).
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { BotSDK } from '/app/sdk/index';
import { BotActions } from '/app/sdk/actions';

const BOT_NAME = process.env.BOT_NAME || 'agent';
const BOT_URL = process.env.BOT_URL || 'http://localhost:8888/bot';
const GATEWAY_URL = process.env.GATEWAY_URL || 'ws://localhost:7780';

const HEALTH_INTERVAL_MS = 10_000;   // between health checks
const UNHEALTHY_LIMIT = 3;           // consecutive bad checks before a reload (~30s)
const MAX_FAILED_RECOVERIES = 5;     // consecutive failed recoveries before giving up (exit 1)
// Under box load (chromium + ffmpeg + the agent session on 2 cpus) a login
// can take minutes — the first market-split run showed a 30s initial wait
// makes restarted launch-bots die in a loop before the client ever logs in.
const LOGIN_WAIT_MS = 120_000;

const CLIENT_URL = `${BOT_URL}?bot=${BOT_NAME}&password=test&fps=15`;

function log(msg: string) {
    console.log(`[launch-bot] ${msg}`);
}

/** ws://host -> http://host, wss://host -> https://host (gateway serves both on one port). */
function gatewayHttpBase(): string {
    return GATEWAY_URL.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/$/, '');
}

/**
 * The gateway's view of this bot: 'active' means state frames are flowing.
 * null = the gateway itself was unreachable (tunnel blip, server restart),
 * which says nothing about OUR client - callers must not treat it as unhealthy.
 */
async function fetchGatewayStatus(): Promise<{ status: string; inGame: boolean; stateAge: number | null } | null> {
    try {
        const res = await fetch(`${gatewayHttpBase()}/status/${encodeURIComponent(BOT_NAME)}`, {
            signal: AbortSignal.timeout(5000)
        });
        if (!res.ok) return null;
        return await res.json();
    } catch {
        return null;
    }
}

/**
 * Whether the page's game client reports being in-game. null = the page did
 * not answer (crashed renderer, wedged chromium), which IS unhealthy.
 */
async function pageInGame(page: Page): Promise<boolean | null> {
    try {
        return await Promise.race([
            page.evaluate(() => !!(window as any).gameClient?.ingame),
            new Promise<null>(resolve => setTimeout(() => resolve(null), 8000))
        ]);
    } catch {
        return null;
    }
}

async function waitForInGame(page: Page, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await pageInGame(page) === true) return true;
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    return false;
}

async function openClientPage(browser: Browser): Promise<Page> {
    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 600 });
    log(`Navigating to ${CLIENT_URL}`);
    await page.goto(CLIENT_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    return page;
}

async function launchBrowser(): Promise<Browser> {
    // When DISPLAY is set (Xvfb), run non-headless so the game renders
    // to the virtual display and can be captured by ffmpeg.
    const useHeadless = !process.env.DISPLAY;
    log(`Launching browser (headless: ${useHeadless}, DISPLAY=${process.env.DISPLAY || 'unset'})`);
    return puppeteer.launch({
        headless: useHeadless,
        // A wedged chromium must FAIL protocol calls quickly so the health
        // loop can escalate to a browser relaunch, not hang on the default 180s.
        protocolTimeout: 30_000,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            // Audio stays unmuted so the recording can capture music/sfx;
            // without the autoplay flag chromium suspends the AudioContext
            // until a user gesture (which a bot never produces).
            '--autoplay-policy=no-user-gesture-required',
            '--disable-extensions',
            '--disable-background-timer-throttling',
            '--window-size=800,600',
            '--kiosk',
        ],
    });
}

/** Close politely, then make sure the chromium process is actually gone. */
async function destroyBrowser(browser: Browser) {
    try {
        await Promise.race([
            browser.close(),
            new Promise(resolve => setTimeout(resolve, 10_000))
        ]);
    } catch {}
    try { browser.process()?.kill('SIGKILL'); } catch {}
}

async function main() {
    log(`Starting client for "${BOT_NAME}"...`);

    let browser = await launchBrowser();

    // A watchdog `kill` must take chromium down with us - an orphaned client
    // stays logged in and fights the replacement for the bot's session.
    const shutdown = async (signal: string) => {
        log(`Received ${signal}, closing browser...`);
        await destroyBrowser(browser);
        process.exit(0);
    };
    process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
    process.on('SIGINT', () => { void shutdown('SIGINT'); });

    let page = await openClientPage(browser);

    // Wait for game client to be in-game
    if (!await waitForInGame(page, LOGIN_WAIT_MS)) {
        throw new Error(`Timeout waiting for bot to log in (${LOGIN_WAIT_MS / 1000}s)`);
    }
    log(`Bot "${BOT_NAME}" is in-game`);

    // Belt-and-braces: resume Web Audio in case the autoplay flag was ignored.
    await page.evaluate(() => (window as any).audioContext?.resume?.());

    // Randomize character appearance
    await page.evaluate(() => {
        const client = (window as any).gameClient;
        if (client?.randomizeCharacterDesign && client?.acceptCharacterDesign) {
            client.randomizeCharacterDesign();
            client.acceptCharacterDesign();
        }
    });

    // Connect SDK to skip tutorial (with timeout so we always release the connection)
    log(`Connecting SDK to skip tutorial...`);
    const sdk = new BotSDK({
        botUsername: BOT_NAME,
        password: 'test',
        gatewayUrl: GATEWAY_URL,
        connectionMode: 'control',
        autoLaunchBrowser: false,
        autoReconnect: false,
    });

    try {
        await sdk.connect();
        await sdk.waitForCondition(s => s.inGame, 30000);

        const bot = new BotActions(sdk);

        // Skip tutorial (may take several attempts, 60s max)
        const deadline = Date.now() + 60000;
        for (let i = 0; i < 30 && Date.now() < deadline; i++) {
            const state = sdk.getState();
            if (state?.player) {
                const { worldX, worldZ } = state.player;
                // Tutorial Island: X 3050-3156, Z 3056-3136
                if (worldX < 3050 || worldX > 3156 || worldZ < 3056 || worldZ > 3136) {
                    log(`Not on tutorial island (${worldX}, ${worldZ}), done`);
                    break;
                }
            }
            await Promise.race([
                bot.skipTutorial(),
                new Promise(r => setTimeout(r, 10000)),
            ]);
            await new Promise(r => setTimeout(r, 1000));
        }

        log(`Tutorial skip done, disconnecting SDK`);
    } catch (err) {
        console.error(`[launch-bot] Tutorial skip error:`, err);
    } finally {
        sdk.disconnect();
    }

    // ── Health monitor ───────────────────────────────────────────
    // Recovery escalates: page reload first (cheap, fixes a dead game/gateway
    // connection), then a full chromium relaunch (fixes a catatonic browser -
    // the first market-split run had chromium wedged for 30 minutes answering
    // no protocol calls, where page reloads can't help), then exit(1) so the
    // box watchdog restarts the whole tree.
    log(`Bot client running. Monitoring health every ${HEALTH_INTERVAL_MS / 1000}s...`);
    let unhealthyCount = 0;
    let failedRecoveries = 0;

    while (true) {
        await new Promise(resolve => setTimeout(resolve, HEALTH_INTERVAL_MS));

        if (!browser.connected) {
            console.error(`[launch-bot] Browser process gone - exiting for the watchdog to restart us`);
            process.exit(1);
        }

        const inGame = await pageInGame(page);
        const gateway = await fetchGatewayStatus();
        // Healthy = the page says it's in-game AND (when the gateway is
        // reachable at all) the gateway sees live state from this client.
        const healthy = inGame === true
            && (gateway === null || (gateway.status === 'active' && gateway.inGame));

        if (healthy) {
            if (unhealthyCount > 0) log(`Client healthy again`);
            unhealthyCount = 0;
            failedRecoveries = 0;
            continue;
        }

        unhealthyCount++;
        log(`Unhealthy check ${unhealthyCount}/${UNHEALTHY_LIMIT} `
            + `(page inGame=${inGame === null ? 'no-answer' : inGame}, `
            + `gateway=${gateway ? `${gateway.status}/inGame=${gateway.inGame}/stateAge=${gateway.stateAge}` : 'unreachable'})`);
        if (unhealthyCount < UNHEALTHY_LIMIT) continue;

        log(`Client dead for ${(UNHEALTHY_LIMIT * HEALTH_INTERVAL_MS) / 1000}s - recovering (failed recoveries so far: ${failedRecoveries})`);
        unhealthyCount = 0;
        try {
            let reloaded = false;
            if (failedRecoveries === 0) {
                // Cheap path: reload the page. A fresh load re-logs the bot in
                // via the URL params; gateway takeover handles the old session.
                try {
                    await page.goto(CLIENT_URL, { waitUntil: 'networkidle2', timeout: 60000 });
                    reloaded = true;
                } catch (err) {
                    log(`page reload failed (${err instanceof Error ? err.message : err}) - escalating to browser relaunch`);
                }
            }
            if (!reloaded) {
                // A goto/protocol failure (or a previous failed recovery) means
                // chromium itself is suspect - replace the whole browser.
                log(`Relaunching chromium...`);
                await destroyBrowser(browser);
                browser = await launchBrowser();
                page = await openClientPage(browser);
            }
            if (!await waitForInGame(page, LOGIN_WAIT_MS)) {
                throw new Error(`client did not reach in-game within ${LOGIN_WAIT_MS / 1000}s after recovery`);
            }
            await page.evaluate(() => (window as any).audioContext?.resume?.()).catch(() => {});
            failedRecoveries = 0;
            log(`Client recovered`);
        } catch (err) {
            failedRecoveries++;
            console.error(`[launch-bot] Recovery ${failedRecoveries}/${MAX_FAILED_RECOVERIES} failed:`, err instanceof Error ? err.message : err);
            if (failedRecoveries >= MAX_FAILED_RECOVERIES) {
                console.error(`[launch-bot] Cannot recover the client - exiting for the watchdog to restart us`);
                await destroyBrowser(browser);
                process.exit(1);
            }
        }
    }
}

main().catch(err => {
    console.error(`[launch-bot] Fatal error:`, err);
    process.exit(1);
});
