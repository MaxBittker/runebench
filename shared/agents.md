# RS-Agent Bot Guide

You're here to play the mmo game through the progressive development of botting scripts, starting small then adapting to your desires and ideas.
It is strongly recommended to get started and make the first step towards your goals, then researching and learning as you go.



## Session Workflow

This is a **persistent character** - you don't restart fresh each time. The workflow is:

### 1. Check World State 

Before writing any script, check where the bot is and what it has:

```bash
bun sdk/cli.ts {username}
```

### 2. Execute code

This shows: position, inventory, skills, nearby NPCs/objects, and more.
Code runs in an async context with `bot` (BotActions) and `sdk` (BotSDK) available as globals.

```typescript
// Just execute - auto-connects on first use
execute_code({
  bot_name: "agent",
  code: `
    const state = sdk.getState();
    console.log('Position:', state.player.worldX, state.player.worldZ);

    // Chop trees for 1 minute
    while (Date.now() < endTime) {
      const tree = sdk.findNearbyLoc(/^tree$/i);
      if (tree) await bot.chopTree(tree);
    }

    return sdk.getInventory();
  `
})
```

### 3. Observe and Iterate

Watch the output. After the script finishes (or fails), check state again:

```bash
bun sdk/cli.ts {username}
```

## Script Duration Guidelines

**Start short, extend as you gain confidence:**

| Duration | Use When |
|----------|----------|
| **10s** | New script, single actions, untested logic, debugging |
| **30s-1 min** | Validated approach, building confidence |
| **5+ min** | Proven strategy, grinding runs. USE SPARINGLY |

A failed 5-minute run wastes more time than five 30 second diagnostic runs. **Fail fast and start simple.**

**HARD CAP: shell commands are killed at ~120 seconds**, and when that happens
you may see no output at all — a working script that hits the cap looks exactly
like a broken one. If a long command "vanished" with no output, assume it hit
the cap; do NOT rewrite the script. Run anything longer than ~90s in the
background and poll its log instead:

```bash
nohup bun run /tmp/grind.ts >> /tmp/grind.log 2>&1 &
sleep 30 && tail -20 /tmp/grind.log     # poll progress each turn
```

Have the script print progress (XP, inventory counts) every few iterations so
`tail` shows it's alive.

Look out for "I can't reach" messages - the solution is often to open closed gates or that the item isn't accessible. 

Read and grep in the learnings/ and wiki/ folder for tips, skill guides, item and npc locations, and shop information.

## SDK API Reference

For the complete method reference, see **[sdk/API.md](sdk/API.md)** (auto-generated from source).

**Quick overview:**
- `bot.*` - High-level actions that wait for effects to complete (chopTree, walkTo, attackNpc, etc.)
- `sdk.*` - Low-level methods that resolve on server acknowledgment (sendWalk, getState, findNearbyNpc, etc.)

### bot.* Quick Reference

| Method | What it does |
|--------|-------------|
| `walkTo(x, z, tolerance?)` | Pathfind to coords, opens doors along the way |
| `talkTo(target)` | Walk to NPC, start dialog |
| `interactNpc(target, option?)` | Walk to NPC, interact with any option (e.g. `'trade'`, `'fish'`) |
| `interactLoc(target, option?)` | Walk to loc, interact with any option (e.g. `'mine'`, `'smelt'`) |
| `attackNpc(target)` | Walk to NPC, start combat |
| `pickpocketNpc(target)` | Pickpocket NPC, detects XP gain vs stun |
| `castSpellOnNpc(target, spell)` | Cast combat spell on NPC |
| `chopTree(target?)` | Chop tree, wait for logs |
| `pickupItem(target)` | Pick up ground item |
| `openDoor(target?)` | Open a door or gate |
| `openBank()` | Open nearest bank |
| `depositItem(target, amount?)` | Deposit item to bank |
| `withdrawItem(slot, amount?)` | Withdraw item from bank |
| `openShop(target?)` | Open shop via shopkeeper NPC |
| `buyFromShop(target, amount?)` | Buy item from open shop |
| `sellToShop(target, amount?)` | Sell item to open shop |
| `equipItem(target)` | Equip from inventory |
| `unequipItem(target)` | Unequip to inventory |
| `eatFood(target)` | Eat food, returns HP gained |
| `useItemOnLoc(item, loc)` | Use inventory item on loc (e.g. fish on range) |
| `useItemOnNpc(item, npc)` | Use inventory item on NPC |
| `burnLogs(target?)` | Light logs with tinderbox |
| `fletchLogs(product?)` | Fletch logs with knife |
| `craftLeather(product?)` | Craft leather with needle |
| `smithAtAnvil(product)` | Smith bars at anvil |
| `dismissBlockingUI()` | Dismiss level-up dialogs (called automatically by all actions) |
| `navigateDialog(choices)` | Auto-click through dialog options |
| `skipTutorial()` | Skip the tutorial island |

### sdk.* Commonly Used Directly

| Method | What it does |
|--------|-------------|
| `getState()` | Full world state snapshot |
| `getSkill(name)` / `getSkillXp(name)` | Skill info |
| `getInventory()` / `findInventoryItem(pattern)` | Inventory queries |
| `findNearbyNpc(pattern)` / `findNearbyLoc(pattern)` | Find nearby entities |
| `findGroundItem(pattern)` | Find ground items |
| `getDialog()` | Current dialog state |
| `sendClickDialog(option)` | Click dialog option |
| `sendClickComponent(id)` | Click interface button |
| `sendDropItem(slot)` | Drop inventory item |
| `sendUseItem(slot)` | Use inventory item (bury, etc.) |
| `sendUseItemOnItem(src, dst)` | Combine two items |
| `sendSay(message)` | Send chat message |
| `waitForCondition(pred)` | Wait for state predicate |
| `waitForTicks(n)` | Wait n game ticks |
| `scanNearbyLocs(radius?)` | Extended-range loc scan |



## Project Structure 
If you are stuck, you can improve your knowledge of the game by searching wiki/
or understand the sdk better by reading sdk/

```

bots/
└── {username}/
    ├── bot.env        # Credentials (BOT_USERNAME, PASSWORD, SERVER)
    ├── lab_log.md     # Session notes and observations
    └── script.ts      # Current script

sdk/
├── index.ts           # BotSDK (low-level)
├── actions.ts         # BotActions (high-level)
├── cli.ts             # CLI for checking state
└── types.ts           # Type definitions

learnings/
├── banking.md
└── ...etc

wiki/
├── npcs/
├── items/
├── skills/
└── shops/

```

## Troubleshooting

**"No state received"** - Bot isn't connected to game. Open browser first or use `autoLaunchBrowser: true`.

**Script stalls** - Check for open dialogs (`state.dialog.isOpen`). Level-ups block everything.

**"Can't reach"** - Path is blocked. Try walking closer first, or find a different target.

**Wrong target** - Use more specific regex patterns: `/^tree$/i` not `/tree/i` (which matches "tree stump").


Start small and build up!