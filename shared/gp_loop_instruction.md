You are one agent in a 5-loop iterative GP-earning benchmark. You have been spawned fresh for **one loop**. After you finish, your context is discarded — only the files you write will carry forward to the next agent.

This is a local RuneScape private server running on localhost for AI agent benchmarking.

## Your Process

1. **Read `/app/gp_results.json`** to determine your loop number. Count entries in the `loops` array — if the file is missing or the array is empty, you are **loop 1**. Otherwise you are loop N+1.
2. **Read `/app/learnings.md`** for what previous agents learned (empty on loop 1).
3. **Read the SDK docs** at `/app/sdk/API.md` and files in `/app/learnings/` to understand available game APIs. On loop 1 especially, spend time here.
4. **Write one money-making script** — a single block of TypeScript code that earns as much GP as possible within 10,000 game ticks (~9 minutes at 50ms/tick).
5. **Run it on 2 bots sequentially** — call `execute_code(bot_name, code, timeout=9)` for each of your 2 bots one at a time.
6. **Record results** to `/app/gp_results.json` (read existing file first, append your entry).
7. **Update `/app/learnings.md`** with what you learned for the next agent.

**TIME BUDGET: You have at most 60 minutes.** Read docs (5 min) → Write script (10 min) → Run on 2 bots sequentially (18 min) → Record results and learnings (5 min).

## Your Bots

Each loop uses a unique set of 2 bots. Bot names follow the pattern `l{loop}a{1-2}`:
- Loop 1: `l1a1`, `l1a2`
- Loop 2: `l2a1`, `l2a2`
- Loop 3: `l3a1`, `l3a2`
- Loop 4: `l4a1`, `l4a2`
- Loop 5: `l5a1`, `l5a2`

**Bots are pre-connected and ready to use.** Just call `execute_code(bot_name, code)` directly — no browser launch needed.

## Starting Conditions

Each bot starts with:
- **Level 50** in all skills (**55 Magic** — enough for High Level Alchemy)
- **Position**: Lumbridge (3222, 3218)
- **Inventory**: Rune axe, Knife, Tinderbox, Small fishing net, Hammer, 1000 Nature runes
- **Equipped**: Staff of fire (provides unlimited fire runes)

You do NOT need to bootstrap (earn money for tools, etc.) — bots start fully equipped.

## Rules

- **No pickpocketing** — any other money-making method is fair game
- **10,000 tick limit** — the game runs at 50ms/tick, so 10,000 ticks ≈ 8.3 minutes. Set execute_code timeout to **9** (minutes).
- **GP is measured from inventory** — coins must be in inventory at the end
- **Same script on all 2 bots** — write ONE script, run it 2 times sequentially
- **`sdk` is NOT available outside execute_code** — do not try to run scripts with `bun run`, they will fail. The only way to execute bot code is via `execute_code(bot_name, code)`.

## Notes

**High Alchemy**: You can cast High Level Alchemy on items to convert them to coins. Switch to magic tab `sdk.sendSetTab(6)`, then use the item on the spell. Each cast costs 1 nature rune (fire runes are free from equipped staff). You start with 1,000 nature runes.

**Shop overstocking warning**: All 5 loops share the same game server. If earlier loops sold items to a shop, later loops will find those items already in stock and get lower sell prices.

## Script Template

Use **game ticks** for timing, not wall-clock time:

```typescript
const COINS_ID = 995;
const startTick = sdk.getState()?.tick ?? 0;
const MAX_TICKS = 9500; // 500 tick buffer under 10k limit

function getCoins() {
  return sdk.getState()?.inventory?.filter(i => i.id === COINS_ID)
    .reduce((sum, i) => sum + i.count, 0) ?? 0;
}

function ticksElapsed() {
  return (sdk.getState()?.tick ?? 0) - startTick;
}

console.log('[GP] Start:', getCoins(), 'coins at tick', startTick);

// --- Your money-making loop ---
while (ticksElapsed() < MAX_TICKS) {
  // ... earn GP ...

  // Log progress every ~1000 ticks
  if (ticksElapsed() % 1000 < 50) {
    console.log('[GP]', getCoins(), 'coins at tick', ticksElapsed());
  }
}

const finalGp = getCoins();
console.log('[GP] FINAL:', finalGp, 'coins in', ticksElapsed(), 'ticks');
return { gp: finalGp };
```

## Recording Results

After all 2 bots finish, write to `/app/gp_results.json`:
```json
{
  "loops": [
    {
      "loop": 1,
      "totalGp": 5000,
      "perBot": { "l1a1": 2500, "l1a2": 2500 },
      "method": "description of strategy used",
      "gpPerTick": 1.25
    }
  ]
}
```
**Read the existing file first** and append your loop's entry to the `loops` array.

## Writing Learnings (CRITICAL)

`/app/learnings.md` and `/app/gp_results.json` are the only things that carry forward. Write learnings well:
- **What method you tried** and exact GP earned / GP per tick
- **What worked** — specific code patterns, coordinates, NPC interactions
- **What failed** — errors, pathing issues, things that earned less than expected
- **Recommendations for the next agent** — "try X instead of Y"
- **The FULL working script** — include the complete script that worked best so the next agent can copy-paste and improve it
- **Shop stock levels** — if you sold to shops, note how many items are now in stock

## Reference

- SDK API docs: `/app/sdk/API.md`
- Game tips: `/app/learnings/` (banking, combat, shops, etc.)
- Codebase: `/app`
