/**
 * Generates all benchmark task directories for Harbor.
 *
 * Skill XP tasks: 16 skills × 15m + 16 skills × 30m
 * Gold tasks: 15m, 30m, 2h
 *
 * All generated output is gitignored — run this before `harbor run`.
 *
 * Usage: bun generate-tasks.ts
 */
import { mkdirSync, writeFileSync, copyFileSync, rmSync } from 'fs';
import { join } from 'path';
import { createSaveData, Items, Locations, type SaveConfig } from './shared/save-generator';

const BENCHMARK_DIR = join(import.meta.dir);
const TASKS_DIR = join(BENCHMARK_DIR, 'tasks');
const SHARED_DIR = join(BENCHMARK_DIR, 'shared');

const DOCKER_IMAGE = 'ghcr.io/maxbittker/rs-agent-benchmark:v54';
const VERIFIER_TIMEOUT = 400;

// ── Standard skill definitions (XP-grind tasks) ─────────────────

interface SkillDef {
  /** Skill name as it appears in the game (PascalCase) */
  name: string;
  /** Directory name suffix (lowercase, used in {skill}-xp-10m) */
  slug: string;
}

const SKILLS: SkillDef[] = [
  { name: 'Attack', slug: 'attack' },
  { name: 'Defence', slug: 'defence' },
  { name: 'Strength', slug: 'strength' },
  { name: 'Hitpoints', slug: 'hitpoints' },
  { name: 'Ranged', slug: 'ranged' },
  { name: 'Prayer', slug: 'prayer' },
  { name: 'Magic', slug: 'magic' },
  { name: 'Woodcutting', slug: 'woodcutting' },
  { name: 'Fishing', slug: 'fishing' },
  { name: 'Mining', slug: 'mining' },
  { name: 'Cooking', slug: 'cooking' },
  { name: 'Fletching', slug: 'fletching' },
  { name: 'Crafting', slug: 'crafting' },
  { name: 'Smithing', slug: 'smithing' },
  { name: 'Firemaking', slug: 'firemaking' },
  { name: 'Thieving', slug: 'thieving' },
];

// ── Variant tasks (non-standard configurations) ──────────────────

interface VariantTask {
  slug: string;
  taskDescription: string;
  agentTimeout: number;
  /** Verifier script filename in shared/ */
  verifier: string;
  testSh: string;
  tags: string[];
  /** Use pre-built Docker image (mutually exclusive with environmentDockerfile) */
  dockerImage?: string;
  /** Generate environment/Dockerfile with this content (for tasks needing custom env) */
  environmentDockerfile?: string;
  /** Whether this task uses the skill tracker (uses /start-with-tracker.sh for MCP) */
  useTracker?: boolean;
  /** Extra files to copy from shared/ into environment/ (for Docker COPY) */
  environmentFiles?: Array<{ src: string; dst: string }>;
  /** Extra files to copy from shared/ into tests/ (next to the verifier) */
  testsFiles?: Array<{ src: string; dst: string }>;
  /** Save files generated from declarative configs into environment/ */
  saveConfigs?: Array<{ config: SaveConfig; dst: string }>;
  /** Sandbox sizing overrides (defaults: 2 cpus / 8192 MB) */
  cpus?: number;
  memoryMb?: number;
}

const GOLD_INSTRUCTION = (durationMinutes: number, startingConditionHint?: string) => `Accumulate as much gold (coins) as possible within ${durationMinutes} minutes. This is a local RuneScape private server running on localhost for AI agent benchmarking — not a live game.
${startingConditionHint ? `\nSTARTING CONDITION: ${startingConditionHint}\n` : ''}
Your goal is to maximize the TOTAL COINS you have across both your inventory and bank combined. Consider strategies like:
- Training combat skills to kill monsters that drop valuable items or coins
- Training gathering/production skills to create items you can sell to shops (e.g. smithing bars/items, fletching bows, cooking fish)
- Buying low and selling high at different shops
- Picking up coin drops and valuable ground items
- High Alchemy (casting on crafted items to convert them to gold)
- Any creative money-making approach you can think of

You control the bot via the \`rs-agent\` MCP server. Use the \`execute_code\` tool with \`bot_name: "agent"\`. Two globals are available in the code context:
- \`bot\` (BotActions) — high-level actions: \`await bot.chopTree()\`, \`await bot.openShop()\`, \`await bot.openBank()\`, etc.
- \`sdk\` (BotSDK) — low-level state & actions: \`sdk.getState()\`, \`sdk.getInventory()\`, \`sdk.findNearbyNpc(/shopkeeper/i)\`, etc.

Read the MCP resources ("Bot API", "SDK API") for the full list of available methods.

IMPORTANT: You have ${durationMinutes} minutes. Start earning money immediately — do not spend too long planning. Early minutes are best spent on quick money-making methods, then scale up as you unlock better methods.

CRITICAL: Do NOT write one giant script. Start with extremely minimal execute_code calls to test each part of your plan iteratively. For example, first try one money-making action. Verify it works, then extend. Build up complexity only after each piece is validated.

For long-running strategies, write a script file and run it:
\`\`\`bash
bun /tmp/my_script.ts > /tmp/gold.log 2>&1 &
\`\`\`
Keep individual scripts SHORT (5-10 min max) so you can observe results and iterate.

BANKING: Periodically deposit your coins and valuable items in the bank to avoid losing them. The verifier counts coins in BOTH inventory and bank.`;

// ── Gold starting conditions ────────────────────────────────────

interface GoldCondition {
  /** Slug used in task directory name: gold-{slug}-{duration} */
  slug: string;
  /** Human-readable hint included in the agent instruction */
  instructionHint?: string;
  /** Declarative starting state (if undefined, copies shared/agent.sav as-is) */
  saveConfig?: SaveConfig;
}

// Doric's Quest complete (varp 31 = 100) — unlocks access to anvils etc.
const DORICS_QUEST_COMPLETE: Record<number, number> = { 31: 100 };

// Homogeneous team starting kit (all three bots identical, no bot is special):
// bronze gathering tools + basic level-30 melee, and NOTHING ELSE — no coins,
// no runes/ore/materials, no processing tools. Teams must gather/earn/buy
// everything the target skill needs from the world, forcing real cooperation.
const TEAM_START_SKILLS: Record<string, number> = { Attack: 30, Strength: 30, Defence: 30, Hitpoints: 30 };
const TEAM_START_INVENTORY = [
  { id: Items.BRONZE_PICKAXE, count: 1 },
  { id: Items.BRONZE_AXE, count: 1 },
];

export const GOLD_CONDITIONS: GoldCondition[] = [
  {
    slug: 'vanilla',
    // No saveConfig — fresh post-tutorial character (shared/agent.sav)
  },
  {
    slug: 'smith-alch',
    instructionHint: 'You start in Falador with 99 Mining, 99 Smithing, and 99 Magic. You have a bronze pickaxe, 100 nature runes, and 500 fire runes in your inventory. A strong strategy is: mine ore → smith bars/items → cast High Alchemy to convert them to gold.',
    saveConfig: {
      position: Locations.FALADOR_CENTER,
      skills: { Mining: 99, Smithing: 99, Magic: 99 },
      inventory: [
        { id: Items.BRONZE_PICKAXE, count: 1 },
        { id: Items.NATURE_RUNE, count: 100 },
        { id: Items.FIRE_RUNE, count: 500 },
      ],
      varps: DORICS_QUEST_COMPLETE,
    },
  },
  {
    slug: 'fish',
    instructionHint: 'You start at the Catherby fishing spots with 50 Fishing and a small fishing net. You can fish and sell or cook your catches for gold.',
    saveConfig: {
      position: Locations.CATHERBY_BEACH,
      skills: { Fishing: 50 },
      inventory: [
        { id: Items.SMALL_FISHING_NET, count: 1 },
      ],
      varps: DORICS_QUEST_COMPLETE,
    },
  },
  {
    slug: 'fletch-alch',
    instructionHint: 'You start in Seers Village with 50 Fletching, 50 Magic, a knife, and high alchemy runes (nature + fire). A strong strategy is: cut logs → fletch into bows → cast High Alchemy to convert them to gold.',
    saveConfig: {
      position: Locations.SEERS_VILLAGE,
      skills: { Fletching: 50, Magic: 50, Woodcutting: 50 },
      inventory: [
        { id: Items.BRONZE_AXE, count: 1 },
        { id: Items.KNIFE, count: 1 },
        { id: Items.NATURE_RUNE, count: 100 },
        { id: Items.FIRE_RUNE, count: 500 },
      ],
      varps: DORICS_QUEST_COMPLETE,
    },
  },
];

const GOLD_DURATIONS = [
  { label: '15m', minutes: 15 },
  { label: '30m', minutes: 30 },
];

// ── Shield of Arrav duo task ────────────────────────────────────
//
// One model, TWO bots, ONE goal: complete the Shield of Arrav quest as fast
// as possible. The quest *requires* two cooperating players (one per gang),
// so the duo adapter (agents/opencode_duo_adapter.py) runs two concurrent
// opencode sessions of the same model — one driving "agenta" (Phoenix Gang
// route), one driving "agentb" (Black Arm Gang route).
//
// Score: seconds saved vs the cap (cap − first completion time); 0 = DNF.

const ARRAV_CAP_MINUTES = 45;

const ARRAV_INSTRUCTION = (durationMinutes: number) => `Complete the quest "Shield of Arrav" as quickly as possible. This is a local RuneScape private server (8x speed) for AI benchmarking — not a live game.

THIS IS A TWO-PLAYER COOPERATIVE TASK. Two agent sessions are running in this
container at the same time — you are one of them. Each session controls its own
bot ("agenta" or "agentb"); your role addendum at the end of this message tells
you which bot is yours. NEVER send commands to your partner's bot.

Your score is the time of the FIRST quest completion (lower is better; cap
${durationMinutes} minutes). Ideally BOTH bots finish — the verifier records that too.

QUEST GUIDE (engine-accurate; the in-game wiki page for this quest is outdated
in several places — where they disagree, trust THIS guide):

Start (each player, independently):
1. Talk to Reldo in the Varrock Palace library (3210, 3492) and ask for a quest.
2. Search the library bookcase for the book "The Shield of Arrav", read it
   (a book modal opens), then talk to Reldo again.
3. The quest requires the two players to join DIFFERENT gangs (your role
   addendum says which is yours).

Phoenix Gang route:
4. Talk to Baraek the fur trader at Varrock Square (3217, 3434); pay him
   20 coins to learn where the Phoenix Gang hideout is.
5. The hideout door is at (3244, 3382) in SE Varrock; Straven is just inside —
   talking at the locked door reaches him. He demands proof of loyalty: kill
   Jonny the Beard in the Blue Moon Inn (3220, 3398) and bring back his
   intelligence report.
6. Kill Jonny (level 2), pick up the intelligence report from the ground, and
   hand it to Straven. You are now a gang member: the hideout door opens for
   you, and Straven gives you the WEAPON STORE KEY.
7. RIGHT SHIELD HALF: climb down the ladder inside the hideout. In the
   underground rooms (around 3235, 9761) there is a chest — Open it, then
   Search it to take the right half.
8. PHOENIX CROSSBOWS: the weapon store is the small building just NE of the
   hideout entrance (around 3245-3253, 3382-3386). Its door at (3251, 3385)
   ALWAYS reports "securely locked" when you click Open, even when you hold
   the key — you must USE the key ON the door (e.g. bot.useItemOnLoc) to
   unlock it. Once inside, climb the ladder at (3252, 3384) UP: the crossbows
   lie on the FLOOR of the UPSTAIRS storeroom (level 1) — Take them; Katrine
   needs TWO. The level-23 weaponsmaster up there interrupts pickups within
   10 tiles of him and will attack you.
   CAUTION: nearby-object/item scans report x/z distance only and ignore
   floors — an item listed at "0 tiles" may be on a different level. If "Take"
   says "I can't reach that!", you are probably on the wrong floor.

Black Arm Gang route:
4. Talk to Charlie the Tramp at the south entrance of Varrock (3231, 3392).
5. The Black Arm hideout is at (3186, 3387) in SW Varrock. Talk to Katrine:
   she demands TWO phoenix crossbows from the Phoenix weapon store (only a
   Phoenix gang member can unlock that store).
6. Hand Katrine the two crossbows. You are now a gang member: go upstairs and
   Search the cupboard for the LEFT SHIELD HALF.

Finish:
9. ONE player must hold BOTH shield halves and talk to the curator of the
   Varrock Museum (3258, 3446). He takes the shield and writes TWO
   certificates, both given to that player. (Showing him a single half does
   nothing — he requires both at once, on one player.)
10. EACH player then needs one certificate: show it to King Roald in Varrock
   Palace. The quest completes for each player the moment they hand it over.

GAME FACTS: There is no player-to-player trade interface on this server; the
only way to transfer an item is to drop it on the ground for the other player.
A dropped item becomes visible to other players only after a short delay, and
despawns a short while later. Players cannot enter the other gang's restricted
rooms.

COORDINATION — IN-GAME CHAT ONLY: Communicate with your partner exclusively
through the in-game public chat. Send messages with \`sdk.sendSay("...")\` and
read your partner's messages from \`sdk.getState().gameMessages\` (each entry
has a sender and text; poll it regularly — it is a rolling window of recent
messages). Public chat reaches your partner anywhere on the map (this server
broadcasts it world-wide). Do NOT coordinate through files, the filesystem, or
any channel other than in-game chat — this benchmark measures in-game
collaboration, and runs are audited.

You control your bot via the \`rs-agent\` MCP server: use the \`execute_code\`
tool with YOUR bot_name. Two globals are available in the code context:
- \`bot\` (BotActions) — high-level actions: \`await bot.talkTo(...)\`, \`await bot.walkTo(x, z)\`, \`await bot.pickupItem(...)\`, etc.
- \`sdk\` (BotSDK) — low-level state & actions: \`sdk.getState()\`, \`sdk.getInventory()\`, \`sdk.getDialog()\`, \`sdk.sendClickDialog(...)\`, etc.

Read the MCP resources ("Bot API", "SDK API") for the full list of available
methods. Dialogs matter a lot in this quest — check \`sdk.getDialog()\` after
talking to NPCs and pick options with \`sdk.sendClickDialog(index)\`.

MODAL INTERFACES: Some quest steps open a full-screen modal (e.g. reading the
book about the shield, or the quest-complete scroll). While
\`sdk.getState().interface.isOpen\` is true, most actions silently fail —
close the modal with \`sdk.sendCloseModal()\` and continue. The quest step
already registered when the modal opened; closing it loses nothing.

IMPORTANT: You have ${durationMinutes} minutes and the clock counts the FIRST
completion. Start immediately, keep execute_code calls SMALL and iterative,
and verify each quest step actually advanced (re-check dialog/inventory state)
before moving on.

RULES: Progress the quest through legitimate in-game actions only. Do NOT
modify server files, save files, or use cheat commands. Do NOT control your
partner's bot.`;

const ARRAV_SAVE_BASE: Omit<SaveConfig, 'position'> = {
  // 200 coins covers Baraek's 20-coin fee with plenty of slack
  inventory: [{ id: Items.COINS, count: 200 }],
};

// (defined as a function — VERIFIER_CLEANUP is declared further down)
const arravVariants = (): VariantTask[] => [
  {
    slug: `arrav-duo-${ARRAV_CAP_MINUTES}m`,
    taskDescription: ARRAV_INSTRUCTION(ARRAV_CAP_MINUTES),
    agentTimeout: ARRAV_CAP_MINUTES * 60 + 120,
    verifier: 'check_arrav.ts',
    testSh: `#!/bin/bash
set -e
mkdir -p /logs/verifier
${VERIFIER_CLEANUP}
export ARRAV_CAP_SECS="${ARRAV_CAP_MINUTES * 60}"
export BOT_NAMES="agenta agentb"
cd /app && bun run /tests/check_arrav.ts
`,
    tags: ['game', 'runescape', 'automation', 'mcp', 'benchmark', 'quest', 'duo', 'arrav'],
    environmentDockerfile: `FROM ${DOCKER_IMAGE}
# Collaborative tasks run at 100ms ticks (4x speed) — half the 50ms/8x used
# by the skill/gold benchmarks — to give cooperating agents more reaction
# time and a wider ground-item handoff window. (Engine default is 400ms.)
ENV NODE_TICKRATE=100
ENV SAMPLE_INTERVAL_MS=5000
ENV GATEWAY_URL=ws://localhost:7780
ENV BENCHMARK_DURATION_SECS=${ARRAV_CAP_MINUTES * 60}
ENV BOT_NAMES="agenta agentb"
COPY agenta.sav /app/server/engine/data/players/main/agenta.sav
COPY agentb.sav /app/server/engine/data/players/main/agentb.sav
COPY arrav_watcher.ts /app/benchmark/shared/arrav_watcher.ts
COPY save-parser.ts /app/benchmark/shared/save-parser.ts
COPY entrypoint-duo.sh /entrypoint-duo.sh
RUN chmod +x /entrypoint-duo.sh
ENTRYPOINT ["/entrypoint-duo.sh"]
`,
    environmentFiles: [
      { src: 'arrav_watcher.ts', dst: 'arrav_watcher.ts' },
      { src: 'save-parser.ts', dst: 'save-parser.ts' },
      { src: 'entrypoint-duo.sh', dst: 'entrypoint-duo.sh' },
    ],
    saveConfigs: [
      { config: { ...ARRAV_SAVE_BASE, position: Locations.VARROCK_SQUARE }, dst: 'agenta.sav' },
      // Spawn B a few tiles away so the bots don't stack on one tile
      { config: { ...ARRAV_SAVE_BASE, position: { x: Locations.VARROCK_SQUARE.x + 3, z: Locations.VARROCK_SQUARE.z } }, dst: 'agentb.sav' },
    ],
    // Two chromium clients + two opencode sessions need more headroom
    cpus: 4,
    memoryMb: 8192,
  },
];

// ── Smith-team three-bot cooperative task ───────────────────────
//
// One model, THREE bots, ONE goal: smith the single most valuable item the
// team can within the horizon. Score = store value (obj cost) of the best
// item any team member smiths. The team adapter
// (agents/opencode_team_adapter.py) runs three concurrent opencode sessions
// of the same model — one per bot.
//
// Anti-cheat (NOT disclosed in the instruction): the watcher
// (shared/smith_team_watcher.ts) samples each bot's inventory + live
// Smithing level every 5s; an item only scores if the bot holding it had the
// Smithing level required to make it when it appeared. Buying a high-tier
// item does not score. See shared/check_smith_team.ts.

const SMITH_TEAM_CAP_MINUTES = 30;

// ── Team-size machinery ──────────────────────────────────────────
// Every team task is generated at several team sizes (same goal, same per-bot
// starting kit) to measure how score scales with the number of agents.
// n=3 keeps the original slug (smith-team-30m); other sizes get a -n<N>
// suffix (smith-team-30m-n1, smith-team-30m-n6). The team adapter is told the
// size via `--ak team_size=N` by the run scripts.
const TEAM_BOT_POOL = ['agenta', 'agentb', 'agentc', 'agentd', 'agente', 'agentf'];
const TEAM_SIZES = [1, 3, 6];
const NUM_WORD: Record<number, string> = { 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six' };
const cap1 = (s: string) => s[0].toUpperCase() + s.slice(1);
const teamBots = (n: number) => TEAM_BOT_POOL.slice(0, n);
const teamSlug = (base: string, cap: number, n: number) => `${base}-${cap}m${n === 3 ? '' : `-n${n}`}`;
// Sandbox sizing: each extra bot adds a chromium client + an opencode session.
const teamResources = (n: number) =>
  n <= 1 ? { cpus: 4, memoryMb: 8192 }
  : n <= 3 ? { cpus: 6, memoryMb: 12288 }
  : { cpus: 10, memoryMb: 20480 };

// Instruction blocks shared by the team tasks, parameterized by team size.
const teamTitle = (n: number) => (n === 1 ? 'solo challenge' : `${NUM_WORD[n]}-player team challenge`);

const teamIntroBlock = (bots: string[]) => bots.length === 1
  ? `THIS IS A SOLO VARIANT OF A TEAM TASK. You are the only agent session in
this container and you control the only bot ("${bots[0]}"). There are no
teammates — everything below that mentions the team applies to you alone.`
  : `THIS IS A ${NUM_WORD[bots.length].toUpperCase()}-PLAYER COOPERATIVE TASK. ${cap1(NUM_WORD[bots.length])} agent sessions are running in
this container at the same time — you are one of them. Each session controls
its own bot (${bots.map((b) => `"${b}"`).join(', ')}); your role
addendum at the end of this message tells you which bot is yours. NEVER send
commands to a teammate's bot.`;

// `goods` = what gets handed between teammates in this task, e.g. "items (ores, bars)".
const teamGameFactsBlock = (n: number, goods: string) => n === 1
  ? `GAME FACTS: There is no player-to-player trade interface on this server. You
have your own bank account.`
  : `GAME FACTS: There is no player-to-player trade interface on this server; the
only way to transfer ${goods} between teammates is to drop them on
the ground for the other player. A dropped item becomes visible to other
players after a short delay and despawns a short while later — drop at an
agreed spot with your teammate standing nearby, and confirm pickup before
dropping more. Each player has their OWN bank account; banks are not shared.`;

// Includes its own trailing blank line so it can vanish cleanly for n=1.
const teamCoordBlock = (n: number) => n === 1 ? '' : `COORDINATION — IN-GAME CHAT ONLY: Communicate with your teammates exclusively
through the in-game public chat. Send messages with \`sdk.sendSay("...")\` and
read teammates' messages from \`sdk.getState().gameMessages\` (each entry has
a sender and text; poll it regularly — it is a rolling window of recent
messages). Public chat reaches your teammates anywhere on the map (this
server broadcasts it world-wide). Do NOT coordinate through files, the
filesystem, or any channel other than in-game chat — this benchmark measures
in-game collaboration, and runs are audited.

`;

const teamRulesLine = (n: number) => `RULES: progress through legitimate in-game actions only. Do NOT modify server
files, save files, or use cheat commands.${n === 1 ? '' : ' Do NOT control a teammate\'s bot.'}`;

// "the other two gather and haul" at n=3; generalized for other sizes.
const theOthers = (n: number) => (n === 3 ? 'the other two' : 'the others');

const SMITH_TEAM_INSTRUCTION = (durationMinutes: number, bots: string[]) => `SMITH THE HIGHEST-VALUE ITEM — ${teamTitle(bots.length)}. This is a local RuneScape private server (8x speed) for AI benchmarking — not a live game.

${teamIntroBlock(bots)}

GOAL: within ${durationMinutes} minutes, your team must SMITH the single most
valuable item it can. The team's score is the store value of the BEST single
item any of you smiths — not a sum. One rune scimitar beats a thousand bronze
daggers.

SCORING:
- Only items your team smiths during this run count: anvil products
  (weapons/armour) and furnace-smelted bars. Items bought from shops or
  otherwise acquired count for NOTHING — runs are audited.
- Score = the item's store value. Reference points: bronze dagger 10gp ·
  steel longsword 500gp (Smithing 36) · steel platebody 2,000gp (48) ·
  runite bar 5,000gp (85, smelted) · mithril platebody 5,200gp (68) ·
  adamant platebody 12,800gp (88) · rune platebody 65,000gp (99). Higher
  metal tiers are worth far more — push as high up the ladder as time allows.
- Smithing XP is per-player and whoever smiths your best item must personally
  have the Smithing LEVEL for it${bots.length === 1 ? '.' : `, so it usually pays to funnel ALL bars onto
  ONE designated smith while ${theOthers(bots.length)} gather and haul.`}

STARTING STATE: ${bots.length === 1 ? 'you start' : `all ${NUM_WORD[bots.length]} bots are identical — you each start`} in Falador with a
bronze pickaxe, a bronze axe, and level-30 Attack/Strength/Defence/Hitpoints.
Nothing else: no coins, no ore, no bars, and NO HAMMER. You must gather and earn
everything.
- Furnace: Falador, around (2975, 3368) — right by your spawn. Smelting ore into
  bars needs no hammer, and smelted bars themselves score.
- Anvils: Doric's anvil at (2950, 3451) (his quest is already done for you) and
  inside the Dwarven Mine at (3012, 9811). FORGING items at an anvil needs a
  hammer, which you do NOT have — buy one from a general store once you have a
  few coins (kill weak monsters for coin drops, or sell ore/bars).
- Ore: the Dwarven Mine under Ice Mountain (north of Falador) has copper, tin,
  iron, coal, mithril and adamantite; your 30 melee helps you survive its
  scorpions and fight weak monsters for starter coins.

${teamGameFactsBlock(bots.length, 'items (ores, bars)')}

${teamCoordBlock(bots.length)}You control your bot via the \`rs-agent\` MCP server: use the \`execute_code\`
tool with YOUR bot_name. Two globals are available in the code context:
- \`bot\` (BotActions) — high-level actions: \`await bot.interactLoc("rock", "Mine")\`, \`await bot.useItemOnLoc(item, loc)\`, \`await bot.walkTo(x, z)\`, etc.
- \`sdk\` (BotSDK) — low-level state & actions: \`sdk.getState()\`, \`sdk.getInventory()\`, \`sdk.findNearbyLoc(/anvil/i)\`, etc.

Read the MCP resources ("Bot API", "SDK API") for the full list of available
methods — confirm exact method names there, and do NOT invent skill-specific
methods. Smelting and smithing go through generic verbs (use ore on the
furnace, use a bar on the anvil — the anvil opens an interface where you pick
the item to forge).

MODAL INTERFACES: some actions open a full-screen modal. While
\`sdk.getState().interface.isOpen\` is true, most actions silently fail —
close it with \`sdk.sendCloseModal()\` if you don't need it.

PLAN FOR THE CLOCK: you have ${durationMinutes} minutes. A good team ramps
tiers: get your smith to steel fast, keep ore flowing, then judge how high up
the ladder you can reach in the time remaining — an item you never finish
scores nothing, so always bank a completed item at your current best tier
before attempting the next. Keep execute_code calls SMALL and iterative;
verify each step worked before scaling it up.

${teamRulesLine(bots.length)}`;

// (defined as a function — VERIFIER_CLEANUP is declared further down)
const SMITH_TEAM_CAP_MINUTES_LIST = [30, 45, 60];

const smithTeamVariants = (): VariantTask[] => SMITH_TEAM_CAP_MINUTES_LIST.flatMap((cap) =>
  TEAM_SIZES.map((n) => {
    const bots = teamBots(n);
    return {
    slug: teamSlug('smith-team', cap, n),
    taskDescription: SMITH_TEAM_INSTRUCTION(cap, bots),
    agentTimeout: cap * 60 + 120,
    verifier: 'check_smith_team.ts',
    testSh: `#!/bin/bash
set -e
mkdir -p /logs/verifier
${VERIFIER_CLEANUP}
export BOT_NAMES="${bots.join(' ')}"
export STARTING_ITEM_IDS="${TEAM_START_INVENTORY.map((i) => i.id).join(' ')}"
cd /app && bun run /tests/check_smith_team.ts
`,
    tags: ['game', 'runescape', 'automation', 'mcp', 'benchmark', 'team', 'smith-team'],
    environmentDockerfile: `FROM ${DOCKER_IMAGE}
# Collaborative tasks run at 100ms ticks (4x speed) — half the 50ms/8x used
# by the skill/gold benchmarks. (Engine default is 400ms.)
ENV NODE_TICKRATE=100
ENV SAMPLE_INTERVAL_MS=5000
ENV GATEWAY_URL=ws://localhost:7780
ENV BENCHMARK_DURATION_SECS=${cap * 60}
ENV BOT_NAMES="${bots.join(' ')}"
${bots.map(b => `COPY ${b}.sav /app/server/engine/data/players/main/${b}.sav`).join('\n')}
COPY smith_team_watcher.ts /app/benchmark/shared/smith_team_watcher.ts
COPY smithing-table.json /app/benchmark/shared/smithing-table.json
COPY entrypoint-team.sh /entrypoint-team.sh
RUN chmod +x /entrypoint-team.sh
ENTRYPOINT ["/entrypoint-team.sh"]
`,
    environmentFiles: [
      { src: 'smith_team_watcher.ts', dst: 'smith_team_watcher.ts' },
      { src: 'smithing-table.json', dst: 'smithing-table.json' },
      { src: 'entrypoint-team.sh', dst: 'entrypoint-team.sh' },
    ],
    testsFiles: [
      { src: 'smithing-table.json', dst: 'smithing-table.json' },
    ],
    // Spawn the bots a few tiles apart so they don't stack on one tile
    saveConfigs: bots.map((bot, i) => ({
      config: {
        position: { x: Locations.FALADOR_CENTER.x + i * 2, z: Locations.FALADOR_CENTER.z },
        skills: TEAM_START_SKILLS,
        inventory: TEAM_START_INVENTORY,
        varps: DORICS_QUEST_COMPLETE,
      },
      dst: `${bot}.sav`,
    })),
    // Each chromium client + opencode session needs headroom
    ...teamResources(n),
    };
  }),
);

// Stop ffmpeg and kill orphaned agent scripts before verifier runs.
// This ensures the bot stops training before the verifier takes its final measurement,
// and the mp4 is finalized and downloadable.
const VERIFIER_CLEANUP = `echo "VERIFIER_START_EPOCH=$(date +%s)"
pkill -f ffmpeg 2>/dev/null || true
# Kill orphaned agent-spawned scripts (bun/node processes that aren't core services)
for pid in $(pgrep -f "bun" 2>/dev/null); do
  cmdline=$(cat /proc/$pid/cmdline 2>/dev/null | tr '\\0' ' ')
  case "$cmdline" in
    *engine*|*gateway*|*skill_tracker*|*arrav_watcher*|*smith_team_watcher*|*magic_team_watcher*|*crafting_team_watcher*|*mcp/server*|*launch-bot*|*check_*|*ensure-services*) ;;
    *) kill $pid 2>/dev/null || true ;;
  esac
done
sleep 2`;

// ── Magic-team task ─────────────────────────────────────────────
//
// One model, THREE bots, ONE goal: push the Magic level of a SINGLE account as
// high as possible. Score = the highest Magic level reached by ANY of the three
// accounts (not a sum). Magic is trained by casting spells, which burn runes;
// each bot starts with an identical rune stash + coins, so the strong play is
// to funnel ALL runes onto one designated caster (dropped in-game) so that
// account casts far longer than any bot could alone.
//
// Unlike smith-team there is no item anti-cheat gate — a skill level can only
// rise through legitimate casting, so check_magic_team.ts scores directly from
// the final save files (skill index 6 = Magic), using magic_team_watcher.ts
// only for the chat transcript + level-over-time timeline.

const MAGIC_TEAM_CAP_MINUTES_LIST = [30, 45, 60];

const MAGIC_TEAM_INSTRUCTION = (durationMinutes: number, bots: string[]) => `TRAIN THE HIGHEST MAGIC LEVEL — ${teamTitle(bots.length)}. This is a local RuneScape private server (8x speed) for AI benchmarking — not a live game.

${teamIntroBlock(bots)}

GOAL: within ${durationMinutes} minutes, get the Magic level of ONE account as
high as you can. The team's score is the HIGHEST Magic level reached by any
single one of you — not a sum. Three accounts at Magic 30 lose to one account
at Magic 40.

SCORING:
- Score = the best single account's final Magic level. Only Magic levels gained
  by legitimately casting spells count — runs are audited.
- Magic XP comes from casting spells, and every cast consumes runes.${bots.length === 1 ? '' : ` Because
  only ONE account's level counts, it usually pays to funnel ALL of the team's
  runes onto ONE designated caster so that account can cast ~${bots.length}x as long and
  climb far higher than any of you could training alone. ${cap1(theOthers(bots.length))} supply
  runes and keep the caster casting.`}

STARTING STATE: ${bots.length === 1 ? 'you start' : `all ${NUM_WORD[bots.length]} bots are identical — you each start`} next to Lumbridge
Castle with a bronze pickaxe, a bronze axe, and level-30 Attack/Strength/Defence/
Hitpoints. Nothing else: NO runes and NO coins. Weak monsters (cows, chickens,
goblins) roam right around the spawn.

HOW TO TRAIN MAGIC (from scratch — you have NO runes, and casting needs runes):
- First get runes. With no coins, earn them: your 30 melee can kill weak
  monsters for coin (and sometimes rune) drops; then buy runes from Aubury's
  Rune Shop (south-east Varrock) or Betty's shop (Port Sarim). Alternatively
  mine rune essence with your pickaxe and runecraft it into runes at an altar.
- Then cast combat "Strike" spells on weak NPCs: Wind Strike works from Magic
  level 1 (1 air + 1 mind rune); move up to Water/Earth/Fire Strike as you level.
  From Magic 25+, repeatable Teleport spells (Law runes) also give XP.
- Runes are the bottleneck — build a rune supply line so your caster never idles.

${teamGameFactsBlock(bots.length, 'runes (or coins)')}

${teamCoordBlock(bots.length)}You control your bot via the \`rs-agent\` MCP server: use the \`execute_code\`
tool with YOUR bot_name. Two globals are available in the code context:
- \`bot\` (BotActions) — high-level actions: \`await bot.attackNpc("chicken")\`, \`await bot.walkTo(x, z)\`, \`await bot.pickupItem(...)\`, etc.
- \`sdk\` (BotSDK) — low-level state & actions: \`sdk.getState()\`, \`sdk.getInventory()\`, \`sdk.getSkills()\`, \`sdk.findNearbyNpc(/chicken/i)\`, etc.

Read the MCP resources ("Bot API", "SDK API") for the full list of available
methods — confirm the exact spell-casting method name there (spells are cast on
an NPC target or, for teleports, cast directly), and do NOT invent method names.

MODAL INTERFACES: some actions open a full-screen modal. While
\`sdk.getState().interface.isOpen\` is true, most actions silently fail —
close it with \`sdk.sendCloseModal()\` if you don't need it.

PLAN FOR THE CLOCK: you have ${durationMinutes} minutes. Decide your caster
early, get runes flowing to them, and keep them casting non-stop — idle time is
lost levels. Keep execute_code calls SMALL and iterative; verify each step
worked before scaling it up.

${teamRulesLine(bots.length)}`;

const magicTeamVariants = (): VariantTask[] => MAGIC_TEAM_CAP_MINUTES_LIST.flatMap((cap) =>
  TEAM_SIZES.map((n) => {
    const bots = teamBots(n);
    return {
    slug: teamSlug('magic-team', cap, n),
    taskDescription: MAGIC_TEAM_INSTRUCTION(cap, bots),
    agentTimeout: cap * 60 + 120,
    verifier: 'check_magic_team.ts',
    testSh: `#!/bin/bash
set -e
mkdir -p /logs/verifier
${VERIFIER_CLEANUP}
export BOT_NAMES="${bots.join(' ')}"
cd /app && bun run /tests/check_magic_team.ts
`,
    tags: ['game', 'runescape', 'automation', 'mcp', 'benchmark', 'team', 'magic-team'],
    environmentDockerfile: `FROM ${DOCKER_IMAGE}
# Collaborative tasks run at 100ms ticks (4x speed) — half the 50ms/8x used
# by the skill/gold benchmarks. (Engine default is 400ms.)
ENV NODE_TICKRATE=100
# Real-game XP rate (engine default is 25x accelerated). At 25x the Magic-level
# metric saturated — most models hit the level-99 cap — so drop the multiplier
# to 1x. The best prior run's stored 77M XP came from ~3.08M base XP, which at
# 1x lands ~level 73, keeping the score band discriminating and un-capped.
ENV NODE_XPRATE=1
ENV SAMPLE_INTERVAL_MS=5000
ENV GATEWAY_URL=ws://localhost:7780
ENV BENCHMARK_DURATION_SECS=${cap * 60}
ENV BOT_NAMES="${bots.join(' ')}"
ENV WATCHER_SCRIPT=benchmark/shared/magic_team_watcher.ts
ENV WATCHER_LOCK=/tmp/magic_team_watcher.lock
ENV TRACKING_FILE=/logs/tracking/magic_team_tracking.json
${bots.map(b => `COPY ${b}.sav /app/server/engine/data/players/main/${b}.sav`).join('\n')}
COPY magic_team_watcher.ts /app/benchmark/shared/magic_team_watcher.ts
COPY entrypoint-team.sh /entrypoint-team.sh
RUN chmod +x /entrypoint-team.sh
ENTRYPOINT ["/entrypoint-team.sh"]
`,
    environmentFiles: [
      { src: 'magic_team_watcher.ts', dst: 'magic_team_watcher.ts' },
      { src: 'entrypoint-team.sh', dst: 'entrypoint-team.sh' },
    ],
    // Spawn the bots a few tiles apart so they don't stack on one tile, each
    // with an identical rune stash + coins to pool onto one caster.
    saveConfigs: bots.map((bot, i) => ({
      config: {
        position: { x: Locations.LUMBRIDGE_CASTLE.x + i * 2, z: Locations.LUMBRIDGE_CASTLE.z },
        skills: TEAM_START_SKILLS,
        inventory: TEAM_START_INVENTORY,
      },
      dst: `${bot}.sav`,
    })),
    // Each chromium client + opencode session needs headroom
    ...teamResources(n),
    };
  }),
);

// ── Crafting-team task ──────────────────────────────────────────
//
// One model, THREE bots, ONE goal: get the highest Crafting XP on any single
// account (the MAX across the three bots) — like magic-team, funnel materials
// onto one designated crafter while the others supply. Scored from the save
// files (skill index 12 = Crafting) via check_crafting_team.ts.

const CRAFTING_TEAM_CAP_MINUTES_LIST = [30, 45, 60];

const CRAFTING_TEAM_INSTRUCTION = (durationMinutes: number, bots: string[]) => `TRAIN THE HIGHEST CRAFTING XP — ${teamTitle(bots.length)}. This is a local RuneScape private server (8x speed) for AI benchmarking — not a live game.

${teamIntroBlock(bots)}

GOAL: within ${durationMinutes} minutes, get the Crafting XP of ONE account as
high as you can. The team's score is the HIGHEST single account's Crafting XP —
not a sum. One account at 500k XP beats three accounts at 200k each.

SCORING:
- Score = the best single account's Crafting XP. Only XP gained by legitimately
  crafting during this run counts — runs are audited.${bots.length === 1 ? '' : `
- Because only ONE account's XP counts, it usually pays to funnel ALL of the
  team's materials onto ONE designated crafter so that account can craft far
  more than any of you could alone. ${cap1(theOthers(bots.length))} gather/buy and hand over
  materials to keep the crafter's inventory full and never idle.`}

STARTING STATE: ${bots.length === 1 ? 'you start' : `all ${NUM_WORD[bots.length]} bots are identical — you each start`} next to Lumbridge
Castle with a bronze pickaxe, a bronze axe, and level-30 Attack/Strength/Defence/
Hitpoints. Nothing else: NO crafting materials, NO tools (no needle/chisel), and
NO coins.

HOW TO TRAIN CRAFTING (from scratch — you have no materials or crafting tools):
- The fastest no-cost start is SPINNING WOOL: shear a sheep (the pen is just
  north-west of Lumbridge) and spin the wool into a ball at the spinning wheel on
  the top floor of Lumbridge Castle — pure Crafting XP with no tools or coins.
- Earn coins by killing weak monsters (your 30 melee), then buy tools to make
  higher-XP items: a needle + thread to sew LEATHER armour from tanned cowhides,
  or a chisel to cut GEMS you mine with your pickaxe (higher gems = more XP).
- Gather -> process -> craft, and keep your crafter's inventory full so it never
  idles.

${teamGameFactsBlock(bots.length, 'materials')}

${teamCoordBlock(bots.length)}You control your bot via the \`rs-agent\` MCP server: use the \`execute_code\`
tool with YOUR bot_name. Two globals are available in the code context:
- \`bot\` (BotActions) — high-level actions: \`await bot.useItemOnItem(a, b)\`, \`await bot.walkTo(x, z)\`, etc.
- \`sdk\` (BotSDK) — low-level state & actions: \`sdk.getState()\`, \`sdk.getInventory()\`, \`sdk.getSkills()\`, etc.

Read the MCP resources ("Bot API", "SDK API") for the full list of available
methods — confirm the exact method for "use item on item" and for answering a
make-menu there, and do NOT invent method names.

MODAL INTERFACES: crafting opens a full-screen make menu. While
\`sdk.getState().interface.isOpen\` is true, most actions silently fail — read
the interface, choose your item, and close it with \`sdk.sendCloseModal()\` when
done.

PLAN FOR THE CLOCK: you have ${durationMinutes} minutes. Decide your crafter
early, get a working craft loop going FAST (leather first, then gems as the
level climbs), and keep that one account's inventory full so it never idles —
one account's XP, not the team's combined output, is the score. Keep
execute_code calls SMALL and iterative; verify each step worked before scaling.

${teamRulesLine(bots.length)}`;

const craftingTeamVariants = (): VariantTask[] => CRAFTING_TEAM_CAP_MINUTES_LIST.flatMap((cap) =>
  TEAM_SIZES.map((n) => {
    const bots = teamBots(n);
    return {
    slug: teamSlug('crafting-team', cap, n),
    taskDescription: CRAFTING_TEAM_INSTRUCTION(cap, bots),
    agentTimeout: cap * 60 + 120,
    verifier: 'check_crafting_team.ts',
    testSh: `#!/bin/bash
set -e
mkdir -p /logs/verifier
${VERIFIER_CLEANUP}
export BOT_NAMES="${bots.join(' ')}"
cd /app && bun run /tests/check_crafting_team.ts
`,
    tags: ['game', 'runescape', 'automation', 'mcp', 'benchmark', 'team', 'crafting-team'],
    environmentDockerfile: `FROM ${DOCKER_IMAGE}
# Collaborative tasks run at 100ms ticks (4x speed).
ENV NODE_TICKRATE=100
# Real-game XP rate (engine default is 25x accelerated) — the score is a raw XP
# sum, so 1x keeps the numbers realistic and the ranking is unaffected by rate.
ENV NODE_XPRATE=1
ENV SAMPLE_INTERVAL_MS=5000
ENV GATEWAY_URL=ws://localhost:7780
ENV BENCHMARK_DURATION_SECS=${cap * 60}
ENV BOT_NAMES="${bots.join(' ')}"
ENV WATCHER_SCRIPT=benchmark/shared/crafting_team_watcher.ts
ENV WATCHER_LOCK=/tmp/crafting_team_watcher.lock
ENV TRACKING_FILE=/logs/tracking/crafting_team_tracking.json
${bots.map(b => `COPY ${b}.sav /app/server/engine/data/players/main/${b}.sav`).join('\n')}
COPY crafting_team_watcher.ts /app/benchmark/shared/crafting_team_watcher.ts
COPY entrypoint-team.sh /entrypoint-team.sh
RUN chmod +x /entrypoint-team.sh
ENTRYPOINT ["/entrypoint-team.sh"]
`,
    environmentFiles: [
      { src: 'crafting_team_watcher.ts', dst: 'crafting_team_watcher.ts' },
      { src: 'entrypoint-team.sh', dst: 'entrypoint-team.sh' },
    ],
    // Spawn a few tiles apart, each with an identical crafting kit.
    saveConfigs: bots.map((bot, i) => ({
      config: {
        position: { x: Locations.LUMBRIDGE_CASTLE.x + i * 2, z: Locations.LUMBRIDGE_CASTLE.z },
        skills: TEAM_START_SKILLS,
        inventory: TEAM_START_INVENTORY,
      },
      dst: `${bot}.sav`,
    })),
    // Each chromium client + opencode session needs headroom
    ...teamResources(n),
    };
  }),
);

// Thin FROM layer: adds GATEWAY_URL and sample interval on top of base image.
const TRACKER_DOCKERFILE = (sampleIntervalMs: number = 15000, benchmarkDurationSecs?: number) => `FROM ${DOCKER_IMAGE}
ENV SAMPLE_INTERVAL_MS=${sampleIntervalMs}
ENV GATEWAY_URL=ws://localhost:7780${benchmarkDurationSecs ? `\nENV BENCHMARK_DURATION_SECS=${benchmarkDurationSecs}` : ''}
COPY agent.sav /app/server/engine/data/players/main/agent.sav
`;

const SKILL_XP_INSTRUCTION = (skillName: string, durationMinutes: number) => `Train ${skillName} as efficiently as possible for ${durationMinutes} minutes. This is a local RuneScape private server (8x speed) for AI benchmarking.

Your score is your **peak real-game XP rate** — the best XP/min over a single 15-second sampling window. Optimize for training speed and try different approaches.

Scoring is normalized to real-game rates: raw XP is divided by 8 (the 8x game speed) and by 25 (the server's 25x XP multiplier), so **the raw XP you see in-game is ~200x your score**. That factor is expected, not a bug — do not go looking for it. Samples are taken on a fixed 15s cadence, so windows are aligned to that clock rather than sliding.

Check your peak rate anytime: \`bun /app/benchmark/shared/check_xp_rate.ts ${skillName}\`

You control the bot via the \`rs-agent\` MCP server. Use the \`execute_code\` tool with \`bot_name: "agent"\`. Two globals are available in the code context:
- \`bot\` (BotActions) — high-level actions: \`await bot.chopTree()\`, \`await bot.interactLoc("rock", "Mine")\`, \`await bot.attackNpc("chicken")\`, etc.
- \`sdk\` (BotSDK) — low-level state & actions: \`sdk.getState()\`, \`sdk.getInventory()\`, \`sdk.findNearbyLoc(/tree/i)\`, etc.

Read the MCP resources ("Bot API", "SDK API") for the full list of available methods. The examples above are illustrative — confirm exact method names there before relying on them, and do NOT invent skill-specific methods (there is no \`mineRock\`/\`fish\`/\`cook\`). Most gathering and processing skills go through generic verbs like \`bot.interactLoc(target, "Mine")\`, \`bot.interactNpc(target, "Fish")\`, or \`bot.useItemOnLoc(item, loc)\`.

IMPORTANT: You have ${durationMinutes} minutes. Start experimenting immediately. Try to get a non-zero baseline then optimize or find new strategies.

Start simple — your first execute_code call should be ONE action:

\`\`\`
await bot.skipTutorial();
\`\`\`

Then try training:

\`\`\`
const result = await bot.chopTree();
return result;
\`\`\`

If it works, iterate and build loops. If it errors, fix the ONE thing that broke. Do NOT spend time planning before you have a working baseline.

For long-running training, write a script file and run it in the background:
\`\`\`bash
bun /tmp/my_script.ts > /tmp/train.log 2>&1 &
\`\`\`
Then check progress with \`bun /app/benchmark/shared/check_xp_rate.ts ${skillName}\` and \`tail /tmp/train.log\`.
Do NOT use the \`timeout\` command — it sends SIGTERM which kills the game connection.

RULES: Gain XP through legitimate in-game actions only. Do NOT modify server files, save files, or use cheat commands.`;

function generateSkillXpVariants(horizonMinutes: number, sampleIntervalMs: number): VariantTask[] {
  const horizonLabel = `${horizonMinutes}m`;
  return SKILLS.map(skill => ({
    slug: `${skill.slug}-xp-${horizonLabel}`,
    taskDescription: SKILL_XP_INSTRUCTION(skill.name, horizonMinutes),
    agentTimeout: horizonMinutes * 60 + 120, // duration + 2 min buffer
    verifier: 'check_skill_xp.ts',
    testSh: `#!/bin/bash
set -e
mkdir -p /logs/verifier
${VERIFIER_CLEANUP}
/ensure-services.sh
export SKILL_NAME="${skill.name}"
cd /app && bun run /tests/check_skill_xp.ts
`,
    tags: ['game', 'runescape', 'automation', 'mcp', 'benchmark', `skill-xp-${horizonLabel}`],
    useTracker: true,
    environmentDockerfile: TRACKER_DOCKERFILE(sampleIntervalMs, horizonMinutes * 60),
    environmentFiles: [{ src: 'agent.sav', dst: 'agent.sav' }],
  }));
}

const SKILL_XP_15M_VARIANTS = generateSkillXpVariants(15, 15000);
const SKILL_XP_30M_VARIANTS = generateSkillXpVariants(30, 15000);
// Fast smoke task (woodcutting only) for verifying a model works end-to-end.
const SKILL_XP_5M_SMOKE = generateSkillXpVariants(5, 15000).filter(
  v => v.slug === 'woodcutting-xp-5m',
);

function generateGoldVariants(): VariantTask[] {
  const variants: VariantTask[] = [];
  for (const condition of GOLD_CONDITIONS) {
    for (const dur of GOLD_DURATIONS) {
      const slug = `gold-${condition.slug}-${dur.label}`;
      // 5s sampling for gold — we need tight resolution to capture transient
      // peaks (sell-to-shop, drop pickups) before they're lost to death/etc.
      // Peak-gold scoring (see shared/check_gold.ts) depends on this.
      const sampleIntervalMs = 5000;
      variants.push({
        slug,
        taskDescription: GOLD_INSTRUCTION(dur.minutes, condition.instructionHint),
        agentTimeout: dur.minutes * 60 + 120,
        verifier: 'check_gold.ts',
        testSh: `#!/bin/bash
set -e
mkdir -p /logs/verifier
${VERIFIER_CLEANUP}
cd /app && bun run /tests/check_gold.ts
`,
        tags: ['game', 'runescape', 'automation', 'mcp', 'benchmark', 'gold', `gold-${condition.slug}`],
        useTracker: true,
        environmentDockerfile: TRACKER_DOCKERFILE(sampleIntervalMs, dur.minutes * 60),
        // Generate the starting save from the declarative config, or copy
        // shared/agent.sav as-is for the vanilla condition.
        environmentFiles: condition.saveConfig ? undefined : [{ src: 'agent.sav', dst: 'agent.sav' }],
        saveConfigs: condition.saveConfig ? [{ config: condition.saveConfig, dst: 'agent.sav' }] : undefined,
      });
    }
  }
  return variants;
}

const GOLD_VARIANTS = generateGoldVariants();

const VARIANTS: VariantTask[] = [
  ...SKILL_XP_5M_SMOKE,
  ...SKILL_XP_15M_VARIANTS,
  ...SKILL_XP_30M_VARIANTS,
  // ── Gold accumulation tasks (4 starting conditions × 2 horizons) ──
  ...GOLD_VARIANTS,
  // ── Shield of Arrav two-bot cooperative quest ──
  ...arravVariants(),
  // ── Smith-team three-bot cooperative smithing ──
  ...smithTeamVariants(),
  // ── Magic-team three-bot cooperative Magic leveling ──
  ...magicTeamVariants(),
  // ── Crafting-team three-bot cooperative TOTAL Crafting XP ──
  ...craftingTeamVariants(),
];

// ── Template generators ──────────────────────────────────────────

function generateVariantTaskToml(v: VariantTask): string {
  const tagsStr = v.tags.map(t => `"${t}"`).join(', ');

  return `version = "1.0"

[metadata]
author_name = "Sean Lee"
difficulty = "medium"
category = "agent"
tags = [${tagsStr}]

[verifier]
timeout_sec = ${VERIFIER_TIMEOUT}.0

[agent]
timeout_sec = ${v.agentTimeout}.0

[environment]
cpus = ${v.cpus ?? 2}
# Hard memory LIMIT, not a flat reservation — the local harbor modal.py
# patch passes memory=(4096, memory_mb): 4GB reserved floor (the always-
# resident baseline), dynamic growth up to this cap, billed at actual usage
# instead of a flat request. The single-bot cap stays at 8192 — no run has
# legitimately hit it, so OOM risk is unchanged; the savings come from the
# lower request. Multi-bot tasks override it (arrav duo / teamResources).
# History: at a plain 4096 request the baseline stack (game server + gateway +
# MCP + tracker + agent CLI) sat at the ceiling and Modal SIGTERMed the agent
# exec mid-run once agents backgrounded a few bun scripts (exit 143, log cut
# mid-step; 9/16 gemini35flashlite trials on 2026-07-21). Sandbox survived, so
# trials scored as unfair floor estimates rather than failing loudly — hence
# the floor must cover the ~4GB baseline (memory above the request is
# best-effort on Modal).
memory_mb = ${v.memoryMb ?? 8192}
storage_mb = 10240
allow_internet = true
build_timeout_sec = 1200.0

[[environment.mcp_servers]]
name = "rs-agent"
transport = "stdio"
command = "bun"
args = ["run", "/app/mcp/server.ts"]
`;
}

// ── Main ─────────────────────────────────────────────────────────

function main() {
console.log(`Generating ${VARIANTS.length} benchmark tasks...`);

// Wipe tasks/ first so stale files from previous generations don't linger
rmSync(TASKS_DIR, { recursive: true, force: true });
mkdirSync(TASKS_DIR, { recursive: true });

// All tasks (10m skill, 30m skill, gold)
for (const variant of VARIANTS) {
  const taskDir = join(TASKS_DIR, variant.slug);
  const testsDir = join(taskDir, 'tests');

  console.log(`  tasks/${variant.slug}/`);

  mkdirSync(testsDir, { recursive: true });
  writeFileSync(join(taskDir, 'task.toml'), generateVariantTaskToml(variant));
  writeFileSync(join(taskDir, 'instruction.md'), variant.taskDescription);
  writeFileSync(join(testsDir, 'test.sh'), variant.testSh);
  copyFileSync(
    join(SHARED_DIR, variant.verifier),
    join(testsDir, variant.verifier),
  );
  // Verifiers import './save-parser' (handles save format v6 + v7)
  copyFileSync(
    join(SHARED_DIR, 'save-parser.ts'),
    join(testsDir, 'save-parser.ts'),
  );

  // Dockerfile for cloud providers — either custom env or
  // a thin FROM layer on the pre-built image.
  const envDir = join(taskDir, 'environment');
  mkdirSync(envDir, { recursive: true });
  writeFileSync(
    join(envDir, 'Dockerfile'),
    variant.environmentDockerfile ?? `FROM ${DOCKER_IMAGE}\n`,
  );

  // Copy extra files into tests/ (next to the verifier)
  if (variant.testsFiles) {
    for (const file of variant.testsFiles) {
      copyFileSync(
        join(SHARED_DIR, file.src),
        join(testsDir, file.dst),
      );
    }
  }

  // Copy extra files into environment/ for Docker build context
  if (variant.environmentFiles) {
    for (const file of variant.environmentFiles) {
      copyFileSync(
        join(SHARED_DIR, file.src),
        join(envDir, file.dst),
      );
    }
  }

  // Generate save files from declarative configs
  if (variant.saveConfigs) {
    for (const save of variant.saveConfigs) {
      writeFileSync(join(envDir, save.dst), createSaveData(save.config));
    }
  }

}

console.log(`\nDone! Generated ${VARIANTS.length} task directories.`);
console.log(`\nTo build the shared Docker image:`);
console.log(`  cd docker && ./build.sh`);
}

if (import.meta.main) main();
