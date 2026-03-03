/**
 * freshStart(sdk, bot) — ensure a connected bot is ready for the GP benchmark.
 *
 * The bot's save file already has the correct state (level 50 skills, 55 Magic,
 * starting inventory, staff of fire equipped, Lumbridge position). This function
 * just handles Tutorial Island / character creation if needed, then verifies.
 *
 * NOTE: Does NOT use cheat commands (::setstat, ::give) — they don't work on
 * the Docker server because Client.ts doesn't convert :: to CLIENT_CHEAT packets.
 *
 * IMPORTANT: Pass sdk and bot explicitly — they are execute_code globals,
 * not available in module scope.
 *
 * Usage inside execute_code:
 *
 *   const { freshStart } = await import('/app/benchmark/shared/gp_fresh_start.ts');
 *   await freshStart(sdk, bot);
 *   // Bot is ready with save-loaded state
 */

// Tutorial Island bounds
function isOnTutorialIsland(x: number, z: number): boolean {
    return x >= 3050 && x <= 3156 && z >= 3056 && z <= 3136;
}

export async function freshStart(sdk: any, bot: any): Promise<void> {
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

    console.log('[freshStart] Starting...');

    // --- Phase 0: Wait for initial state ---
    let state = sdk.getState();
    for (let i = 0; i < 30 && !state?.player; i++) {
        await sleep(500);
        state = sdk.getState();
    }
    if (!state?.player) {
        console.warn('[freshStart] WARNING: No player state after 15s, proceeding anyway');
    }

    // --- Phase 1: Handle character creation screen (interface 3559) ---
    state = sdk.getState();
    if (state?.interface?.id === 3559) {
        console.log('[freshStart] Character creation screen detected — accepting...');
        const acceptOption = state.interface.options?.[0];
        if (acceptOption?.componentId) {
            await sdk.sendClickComponent(acceptOption.componentId);
        } else {
            try { await sdk.sendCloseModal(); } catch {}
        }
        await sleep(3000);
    }

    // --- Phase 2: Skip Tutorial Island if needed ---
    state = sdk.getState();
    const px = state?.player?.worldX ?? 0;
    const pz = state?.player?.worldZ ?? 0;

    if (isOnTutorialIsland(px, pz)) {
        console.log('[freshStart] On Tutorial Island — skipping tutorial...');
        for (let attempt = 0; attempt < 30; attempt++) {
            try {
                await bot.skipTutorial();
            } catch (e: any) {
                // skipTutorial errors are expected mid-transition — keep trying
            }
            await sleep(1000);
            state = sdk.getState();
            const x = state?.player?.worldX ?? 0;
            const z = state?.player?.worldZ ?? 0;
            if (!isOnTutorialIsland(x, z)) {
                console.log(`[freshStart] Left Tutorial Island → (${x}, ${z})`);
                break;
            }
        }
        await sleep(2000);
    }

    // --- Phase 3: Verify state (from save file) ---
    await sleep(500);
    state = sdk.getState();
    const skills = sdk.getSkills?.() ?? [];
    const atk = skills.find((s: any) => s.name?.toUpperCase() === 'ATTACK');
    const magic = skills.find((s: any) => s.name?.toUpperCase() === 'MAGIC');
    const inv = sdk.getInventory();
    const pos = `(${state?.player?.worldX}, ${state?.player?.worldZ})`;

    console.log(`[freshStart] Done. Pos=${pos} Attack=${atk?.baseLevel ?? '?'} Magic=${magic?.baseLevel ?? '?'} Inv=${inv.length} items`);
    inv.forEach((i: any) => console.log(`[freshStart]   - ${i.name} x${i.count}`));

    if (inv.length === 0) {
        console.warn('[freshStart] WARNING: Empty inventory! Save file may not have loaded correctly.');
    }
    if (!atk || atk.baseLevel < 50) {
        console.warn('[freshStart] WARNING: Attack level wrong:', atk?.baseLevel);
    }
}
