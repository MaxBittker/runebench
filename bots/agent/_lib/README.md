# `bots/agent/_lib` — shared bot helpers

Shared, dependency-free modules for the `<skill>-best.ts` / `<skill>-v2.ts`
bot scripts. Everything here is pure logic over fabricated-or-live state and
is unit-tested with `bun:test` — no server or gateway needed to run the tests.

## `targeting.ts`

| Export | Purpose |
|---|---|
| `tileDistance` / `distanceBetween` / `euclideanDistance` | Chebyshev ("king move") and straight-line tile math. |
| `filterTargets(targets, filter)` | Name/option/reachability/max-range filter + stable nearest-first sort. |
| `nearestTarget(targets, filter)` | Best single pick (`null` when nothing qualifies). |
| `bestByScore(items, score)` | Combat-style minimum-score selector (ties keep scan order). |
| `hasOption(target, pattern)` | True when a target currently publishes a matching option; matches both plain `options: string[]` and the SDK menu shape `optionsWithIndex: {text, opIndex}[]`. |
| `targetKey(obj)` | Stable identity string (`id@x,z`, falls back to name). |
| `RespawnRotator` | Remembers depleted tiles + respawn windows; `rotate()` picks a ready object, rotates across the cluster instead of re-clicking one tile, and waits on the soonest-respawning tile when all are down. |
| `TargetCache` | TTL memoization keyed by `targetKey` for expensive per-target work between state frames. |

### Using them from a `-best.ts` script

```typescript
import { runScript } from '../../sdk/runner';
import { RespawnRotator, nearestTarget } from './_lib/targeting';

await runScript(async ({ sdk }) => {
    const rotator = new RespawnRotator({ respawnMs: 4000 });

    while (true) {
        const state = sdk.getState();
        if (!state?.inGame) { await Bun.sleep(1000); continue; }

        // Live-scan selection: only objects that currently publish "Mine".
        const pick = rotator.rotate(state.nearbyLocs ?? [], {
            namePattern: /rocks? (copper|tin)/i,
            optionPattern: /^mine$/i,
            reachableOnly: true,
        });
        if (!pick) { await Bun.sleep(600); continue; }

        const result = await bot.interactLoc(pick as never, 'Mine');
        if (result.success) rotator.markDepleted(pick);
        await Bun.sleep(1000);
    }
});
```

Run tests / typecheck from the repo root:

```bash
bun test bots/agent/_lib/targeting.test.ts
bun run typecheck
```
