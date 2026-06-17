/**
 * Launches a headless Puppeteer browser with the game bot client,
 * connects via SDK to skip the tutorial, then keeps the browser alive.
 *
 * This runs as a background process in the container entrypoint so
 * the bot is in-game and ready before the agent starts.
 */
// NOTE: This script must be run from /app/gateway (cd /app/gateway && bun run /app/launch-bot.ts)
// so that 'puppeteer' resolves from gateway's node_modules (avoids bun+debug compat issue at root).
import puppeteer from 'puppeteer';
import { BotSDK } from '/app/sdk/index';
import { BotActions } from '/app/sdk/actions';

const BOT_NAME = process.env.BOT_NAME || 'agent';
const BOT_URL = process.env.BOT_URL || 'http://localhost:8888/bot';
const GATEWAY_URL = process.env.GATEWAY_URL || 'ws://localhost:7780';

async function main() {
    console.log(`[launch-bot] Launching headless browser for "${BOT_NAME}"...`);

    // When DISPLAY is set (Xvfb), run non-headless so the game renders
    // to the virtual display and can be captured by ffmpeg.
    const useHeadless = !process.env.DISPLAY;
    console.log(`[launch-bot] Headless: ${useHeadless} (DISPLAY=${process.env.DISPLAY || 'unset'})`);

    const browser = await puppeteer.launch({
        headless: useHeadless,
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

    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 600 });

    const url = `${BOT_URL}?bot=${BOT_NAME}&password=test&fps=15`;
    console.log(`[launch-bot] Navigating to ${url}`);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    // Wait for game client to be in-game
    let attempts = 0;
    while (!(await page.evaluate(() => (window as any).gameClient?.ingame))) {
        await new Promise(r => setTimeout(r, 200));
        attempts++;
        if (attempts > 150) {
            throw new Error('Timeout waiting for bot to log in (30s)');
        }
    }
    console.log(`[launch-bot] Bot "${BOT_NAME}" is in-game`);

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
    console.log(`[launch-bot] Connecting SDK to skip tutorial...`);
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
                    console.log(`[launch-bot] Not on tutorial island (${worldX}, ${worldZ}), done`);
                    break;
                }
            }
            await Promise.race([
                bot.skipTutorial(),
                new Promise(r => setTimeout(r, 10000)),
            ]);
            await new Promise(r => setTimeout(r, 1000));
        }

        console.log(`[launch-bot] Tutorial skip done, disconnecting SDK`);
    } catch (err) {
        console.error(`[launch-bot] Tutorial skip error:`, err);
    } finally {
        sdk.disconnect();
    }

    // Keep browser alive so the bot stays connected
    console.log(`[launch-bot] Bot client running headless. Keeping alive...`);
    await new Promise(() => {});
}

main().catch(err => {
    console.error(`[launch-bot] Fatal error:`, err);
    process.exit(1);
});
