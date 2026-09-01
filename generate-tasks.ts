/**
 * Generates all benchmark task directories for Harbor.
 *
 * Skill XP tasks: 16 skills × 15m + 16 skills × 30m
 * Gold tasks: 4 starting conditions × {15m, 30m}
 * Team tasks: arrav duo + smith/magic/crafting teams × {30,45,60}m × n∈{1,3,6}
 *
 * All generated output is gitignored — run this before `harbor run`.
 *
 * Usage: bun generate-tasks.ts
 */
import { mkdirSync, writeFileSync, copyFileSync, rmSync } from "fs";
import { join } from "path";
import {
  createSaveData,
  randomAppearance,
  DESIGN_COLOR_COUNTS,
  Items,
  Locations,
  Skills,
  WearSlots,
  type SaveConfig,
} from "./shared/save-generator";

const BENCHMARK_DIR = join(import.meta.dir);
const TASKS_DIR = join(BENCHMARK_DIR, "tasks");
const SHARED_DIR = join(BENCHMARK_DIR, "shared");

const DOCKER_IMAGE = "ghcr.io/maxbittker/rs-agent-benchmark:v67";
const VERIFIER_TIMEOUT = 400;

// ── Standard skill definitions (XP-grind tasks) ─────────────────

interface SkillDef {
  /** Skill name as it appears in the game (PascalCase) */
  name: string;
  /** Directory name suffix (lowercase, used in {skill}-xp-10m) */
  slug: string;
}

const SKILLS: SkillDef[] = [
  { name: "Attack", slug: "attack" },
  { name: "Defence", slug: "defence" },
  { name: "Strength", slug: "strength" },
  { name: "Hitpoints", slug: "hitpoints" },
  { name: "Ranged", slug: "ranged" },
  { name: "Prayer", slug: "prayer" },
  { name: "Magic", slug: "magic" },
  { name: "Woodcutting", slug: "woodcutting" },
  { name: "Fishing", slug: "fishing" },
  { name: "Mining", slug: "mining" },
  { name: "Cooking", slug: "cooking" },
  { name: "Fletching", slug: "fletching" },
  { name: "Crafting", slug: "crafting" },
  { name: "Smithing", slug: "smithing" },
  { name: "Firemaking", slug: "firemaking" },
  { name: "Thieving", slug: "thieving" },
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

const GOLD_INSTRUCTION = (
  durationMinutes: number,
  startingConditionHint?: string,
) => `Accumulate as much gold (coins) as possible within ${durationMinutes} minutes. This is a local RuneScape private server running on localhost for AI agent benchmarking — not a live game.
${
  startingConditionHint
    ? `\nSTARTING CONDITION: ${startingConditionHint}\n`
    : ""
}
Your goal is to maximize your TOTAL COINS (inventory + bank combined). Your score is the PEAK total you reach at any point during the run — coins are sampled every few seconds and the best sample counts, so convert items into coins as you go rather than stockpiling them for a final sell-off. Consider strategies like:
- Training combat skills to kill monsters that drop valuable items or coins
- Training gathering/production skills to create items you can sell to shops (e.g. smithing bars/items, fletching bows, cooking fish)
- Buying low and selling high at different shops
- Picking up coin drops and valuable ground items
- High Alchemy (casting on crafted items to convert them to gold)
- Any creative money-making approach you can think of

You control the bot via the \`rs-agent\` MCP server. Use the \`execute_code\` tool with \`bot_name: "agent"\`. Two globals are available in the code context:
- \`bot\` (BotActions) — high-level actions: \`await bot.chopTree()\`, \`await bot.openShop()\`, \`await bot.openBank()\`, etc.
- \`sdk\` (BotSDK) — low-level state & actions: \`sdk.getState()\`, \`sdk.getInventory()\`, \`sdk.findNearbyNpc(/shopkeeper/i)\`, etc.

Read the MCP resource "SDK API Reference" for the full list of available methods.

IMPORTANT: You have ${durationMinutes} minutes. Start earning money immediately — do not spend too long planning. Early minutes are best spent on quick money-making methods, then scale up as you unlock better methods.

CRITICAL: Do NOT write one giant script. Start with extremely minimal execute_code calls to test each part of your plan iteratively. For example, first try one money-making action. Verify it works, then extend. Build up complexity only after each piece is validated.

For long-running strategies, write a script file and run it:
\`\`\`bash
bun /tmp/my_script.ts > /tmp/gold.log 2>&1 &
\`\`\`
Keep individual scripts SHORT (5-10 min max) so you can observe results and iterate.

SCORING: the verifier samples coins in BOTH inventory and bank every few seconds and scores your PEAK total. Items are worth nothing until sold — only coins count.`;

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
const TEAM_START_SKILLS: Record<string, number> = {
  Attack: 30,
  Strength: 30,
  Defence: 30,
  Hitpoints: 30,
};
const TEAM_START_INVENTORY = [
  { id: Items.BRONZE_PICKAXE, count: 1 },
  { id: Items.BRONZE_AXE, count: 1 },
];

export const GOLD_CONDITIONS: GoldCondition[] = [
  {
    slug: "vanilla",
    // No saveConfig — fresh post-tutorial character (shared/agent.sav)
  },
  {
    slug: "smith-alch",
    instructionHint:
      "You start in Falador with 99 Mining, 99 Smithing, and 99 Magic. You have a bronze pickaxe, 100 nature runes, and 500 fire runes in your inventory. A strong strategy is: mine ore → smith bars/items → cast High Alchemy to convert them to gold.",
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
    slug: "fish",
    instructionHint:
      "You start at the Catherby fishing spots with 50 Fishing and a small fishing net. You can fish and sell or cook your catches for gold.",
    saveConfig: {
      position: Locations.CATHERBY_BEACH,
      skills: { Fishing: 50 },
      inventory: [{ id: Items.SMALL_FISHING_NET, count: 1 }],
      varps: DORICS_QUEST_COMPLETE,
    },
  },
  {
    slug: "fletch-alch",
    instructionHint:
      "You start in Seers Village with 50 Fletching, 50 Magic, 50 Woodcutting, an axe, a knife, and alchemy runes (nature + fire). A strong strategy is: cut logs → fletch into bows → cast Low Alchemy on them to convert them to gold (High Alchemy needs Magic 55; alchemy casts raise Magic, so you can upgrade mid-run).",
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
  { label: "15m", minutes: 15 },
  { label: "30m", minutes: 30 },
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

const ARRAV_INSTRUCTION = (
  durationMinutes: number,
) => `Complete the quest "Shield of Arrav" as quickly as possible. This is a local RuneScape private server (4x speed) for AI benchmarking — not a live game.

THIS IS A TWO-PLAYER COOPERATIVE TASK. Two agent sessions are running in this
container at the same time — you are one of them. Each session controls its own
bot ("agenta" or "agentb"); your role addendum at the end of this message tells
you which bot is yours. NEVER send commands to your partner's bot.

Your score is the time of the FIRST quest completion (lower is better; cap
${durationMinutes} minutes). Ideally BOTH bots finish — the verifier records that too.

QUEST GUIDE (engine-accurate; the in-game wiki page for this quest is outdated
in several places — where they disagree, trust THIS guide):

The two players must join DIFFERENT gangs — your role addendum says which is
yours. Neither player needs Reldo or the library book; go straight to your
gang's route below.

Phoenix Gang route:
1. Talk to Baraek the fur trader at Varrock Square (3218, 3435); pay him
   20 coins to learn where the Phoenix Gang hideout is. The gang will not
   talk to you before this.
2. The hideout entrance is a "Climb-down" ladder at (3244, 3383) in SE
   Varrock. At the bottom, Straven stands behind a locked door — talking at
   the door reaches him. Choose "I know who you are!" and offer your
   services: he demands proof of loyalty — kill Jonny the Beard in the Blue
   Moon Inn (3220, 3398) and bring back his intelligence report.
3. Kill Jonny (level 2), pick up the intelligence report from the ground, and
   hand it to Straven. You are now a gang member: the hideout door opens for
   you, and Straven gives you the WEAPON STORE KEY.
4. RIGHT SHIELD HALF: in the underground rooms behind Straven's door (around
   3235, 9761) there is a chest — Open it, then Search it to take the half.
5. PHOENIX CROSSBOWS: back on the surface, the weapon store is the small
   building just NE of the hideout ladder (around 3245-3253, 3382-3386). Its
   door at (3251, 3385) ALWAYS reports "securely locked" when you click Open,
   even when you hold the key — you must USE the key ON the door (e.g.
   bot.useItemOnLoc) to unlock it. Once inside, climb the ladder at
   (3252, 3384) UP: the crossbows lie on the FLOOR of the UPSTAIRS storeroom
   (level 1) — Take them; Katrine needs TWO. The level-23 weaponsmaster up
   there interrupts pickups within 10 tiles of him and will attack you.
   CAUTION: nearby-object/item scans report x/z distance only and ignore
   floors — an item listed at "0 tiles" may be on a different level. If "Take"
   says "I can't reach that!", you are probably on the wrong floor.

Black Arm Gang route:
1. Talk to the Tramp at (3208, 3391) in SW Varrock: ask what is down the
   alleyway, then whether the gang would let you join. Katrine will not
   recruit you before this.
2. The Black Arm hideout door is at (3185, 3388), down that alleyway. Talk to
   Katrine — say you have heard she is the Black Arm Gang and ask to become a
   member: she demands TWO phoenix crossbows from the Phoenix weapon store
   (only a Phoenix gang member can unlock that store).
3. Hand Katrine the two crossbows. You are now a gang member: go upstairs and
   Search the cupboard for the LEFT SHIELD HALF.

Finish (after both halves are secured):
- ONE player must hold BOTH shield halves and talk to the curator of the
  Varrock Museum (3255, 3445). He takes the shield and writes TWO
  certificates, both given to that player. (Showing him a single half does
  nothing — he requires both at once, on one player.)
- EACH player then needs one certificate: show it to King Roald in Varrock
  Palace. The quest completes for each player the moment they hand it over.

GAME FACTS: Transfer items with the player-to-player trade API: stand near
your partner, then one of you runs \`await bot.trade(partnerName, { give: [...] })\`
while the other accepts (\`await bot.serveTrades(...)\` or \`await bot.acceptTrade()\`).
Players cannot enter the other gang's restricted rooms.

COORDINATION — IN-GAME CHAT ONLY: Communicate with your partner exclusively
through the in-game public chat, using the chat CLI. It connects in observe
mode, so it sends and reads chat WITHOUT taking control of your bot — safe to
use at any time, even while one of your scripts is driving the bot:

  cd /app && bun sdk/chat.ts YOUR_BOT "your message"    # send
  cd /app && bun sdk/chat.ts YOUR_BOT                   # read recent chat

Messages can be up to 400 characters. Public chat reaches your partner
anywhere on the map (this server broadcasts it world-wide). Send chat through
this CLI — do NOT call the SDK messaging methods (sendSay/say) from inside
your scripts. Do NOT coordinate through files, the filesystem, or any channel
other than in-game chat — this benchmark measures in-game collaboration, and
runs are audited.

You control your bot via the \`rs-agent\` MCP server: use the \`execute_code\`
tool with YOUR bot_name. Two globals are available in the code context:
- \`bot\` (BotActions) — high-level actions: \`await bot.talkTo(...)\`, \`await bot.walkTo(x, z)\`, \`await bot.pickupItem(...)\`, etc.
- \`sdk\` (BotSDK) — low-level state & actions: \`sdk.getState()\`, \`sdk.getInventory()\`, \`sdk.getDialog()\`, \`sdk.sendClickDialog(...)\`, etc.

Read the MCP resource "SDK API Reference" for the full list of available
methods. Dialogs matter a lot in this quest — check \`sdk.getDialog()\` after
talking to NPCs and pick options with \`sdk.sendClickDialog(index)\`.

MODAL INTERFACES: Some quest steps open a full-screen modal (e.g. finding a
shield half, or the quest-complete scroll). While
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

const ARRAV_SAVE_BASE: Omit<SaveConfig, "position"> = {
  // 200 coins covers Baraek's 20-coin fee with plenty of slack
  inventory: [{ id: Items.COINS, count: 200 }],
};

// (defined as a function — VERIFIER_CLEANUP is declared further down)
const arravVariants = (): VariantTask[] => [
  {
    slug: `arrav-duo-${ARRAV_CAP_MINUTES}m`,
    taskDescription: ARRAV_INSTRUCTION(ARRAV_CAP_MINUTES),
    agentTimeout: ARRAV_CAP_MINUTES * 60 + 120,
    verifier: "check_arrav.ts",
    testSh: `#!/bin/bash
set -e
mkdir -p /logs/verifier
${VERIFIER_CLEANUP}
export ARRAV_CAP_SECS="${ARRAV_CAP_MINUTES * 60}"
export BOT_NAMES="agenta agentb"
cd /app && bun run /tests/check_arrav.ts
`,
    tags: [
      "game",
      "runescape",
      "automation",
      "mcp",
      "benchmark",
      "quest",
      "duo",
      "arrav",
    ],
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
      { src: "arrav_watcher.ts", dst: "arrav_watcher.ts" },
      { src: "save-parser.ts", dst: "save-parser.ts" },
      { src: "entrypoint-duo.sh", dst: "entrypoint-duo.sh" },
    ],
    // Spawn B a few tiles away so the bots don't stack on one tile; each bot
    // gets a random distinct look.
    saveConfigs: randomTeamAppearances(2).map((look, i) => ({
      config: {
        ...ARRAV_SAVE_BASE,
        appearance: look,
        position: {
          x: Locations.VARROCK_SQUARE.x + i * 3,
          z: Locations.VARROCK_SQUARE.z,
        },
      },
      dst: `agent${"ab"[i]}.sav`,
    })),
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
const TEAM_BOT_POOL = [
  "agenta",
  "agentb",
  "agentc",
  "agentd",
  "agente",
  "agentf",
];
const TEAM_SIZES = [1, 3, 6];
const NUM_WORD: Record<number, string> = {
  1: "one",
  2: "two",
  3: "three",
  4: "four",
  5: "five",
  6: "six",
  7: "seven",
  8: "eight",
  9: "nine",
  10: "ten",
  11: "eleven",
  12: "twelve",
  13: "thirteen",
  14: "fourteen",
  15: "fifteen",
  16: "sixteen",
  17: "seventeen",
  18: "eighteen",
  19: "nineteen",
  20: "twenty",
  21: "twenty-one",
  22: "twenty-two",
  23: "twenty-three",
  24: "twenty-four",
};
const cap1 = (s: string) => s[0].toUpperCase() + s.slice(1);
const teamBots = (n: number) => TEAM_BOT_POOL.slice(0, n);
// Random per-bot looks so players can tell each other apart on screen and in
// videos. Fully random (valid kits/palettes only — randomAppearance in
// save-generator.ts) except hair and shirt colors, which are dealt from
// shuffled decks so no two teammates share either.
const randomTeamAppearances = (
  n: number,
): Array<{ gender: number; body: number[]; colors: number[] }> => {
  const deal = (count: number): number[] => {
    const deck = Array.from({ length: count }, (_, i) => i);
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j]!, deck[i]!];
    }
    return deck;
  };
  const [hairColors, torsoColors] = [
    deal(DESIGN_COLOR_COUNTS[0]!),
    deal(DESIGN_COLOR_COUNTS[1]!),
  ];
  return Array.from({ length: n }, (_, i) => {
    const look = randomAppearance();
    look.colors[0] = hairColors[i % hairColors.length]!;
    look.colors[1] = torsoColors[i % torsoColors.length]!;
    return look;
  });
};
const teamSlug = (base: string, cap: number, n: number) =>
  `${base}-${cap}m${n === 3 ? "" : `-n${n}`}`;
// Sandbox sizing: each extra bot adds a chromium client + an opencode session.
const teamResources = (n: number) =>
  n <= 1
    ? { cpus: 4, memoryMb: 8192 }
    : n <= 3
    ? { cpus: 6, memoryMb: 12288 }
    : { cpus: 10, memoryMb: 20480 };

// Instruction blocks shared by the team tasks, parameterized by team size.
const teamTitle = (n: number) =>
  n === 1 ? "solo challenge" : `${NUM_WORD[n]}-player team challenge`;

const teamIntroBlock = (bots: string[]) =>
  bots.length === 1
    ? `THIS IS A SOLO VARIANT OF A TEAM TASK. You are the only agent session in
this container and you control the only bot ("${bots[0]}"). There are no
teammates — everything below that mentions the team applies to you alone.`
    : `THIS IS A ${NUM_WORD[
        bots.length
      ].toUpperCase()}-PLAYER COOPERATIVE TASK. ${cap1(
        NUM_WORD[bots.length],
      )} agent sessions are running in
this container at the same time — you are one of them. Each session controls
its own bot (${bots.map((b) => `"${b}"`).join(", ")}); your role
addendum at the end of this message tells you which bot is yours. NEVER send
commands to a teammate's bot.`;

// `goods` = what gets handed between teammates in this task, e.g. "items (ores, bars)".
const teamGameFactsBlock = (n: number, goods: string) =>
  n === 1
    ? `GAME FACTS: You have your own bank account.`
    : `GAME FACTS: Transfer ${goods} between teammates with the
player-to-player trade API: stand near a teammate, then one of you runs
\`await bot.trade(teammateName, { give: [...] })\` while the other accepts
(\`await bot.serveTrades(...)\` or \`await bot.acceptTrade()\`). Each player has
their OWN bank account; banks are not shared.`;

// Includes its own trailing blank line so it can vanish cleanly for n=1.
const teamCoordBlock = (n: number) =>
  n === 1
    ? ""
    : `COORDINATION — IN-GAME CHAT ONLY: Communicate with your teammates exclusively
through the in-game public chat, using the chat CLI. It connects in observe
mode, so it sends and reads chat WITHOUT taking control of your bot — safe to
use at any time, even while one of your scripts is driving the bot:

  cd /app && bun sdk/chat.ts YOUR_BOT "your message"    # send
  cd /app && bun sdk/chat.ts YOUR_BOT                   # read recent chat

Messages can be up to 400 characters. Public chat reaches your teammates
anywhere on the map (this server broadcasts it world-wide). Send chat through
this CLI — do NOT call the SDK messaging methods (sendSay/say) from inside
your scripts. Do NOT coordinate through files, the filesystem, or any channel
other than in-game chat — this benchmark measures in-game collaboration, and
runs are audited.

`;

const teamRulesLine = (
  n: number,
) => `RULES: progress through legitimate in-game actions only. Do NOT modify server
files, save files, or use cheat commands.${
  n === 1 ? "" : " Do NOT control a teammate's bot."
}`;

// "the other two gather and haul" at n=3; generalized for other sizes.
const theOthers = (n: number) => (n === 3 ? "the other two" : "the others");

const SMITH_TEAM_INSTRUCTION = (
  durationMinutes: number,
  bots: string[],
) => `SMITH THE HIGHEST-VALUE ITEM — ${teamTitle(
  bots.length,
)}. This is a local RuneScape private server (4x speed) for AI benchmarking — not a live game.

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
  have the Smithing LEVEL for it${
    bots.length === 1
      ? "."
      : `, so it usually pays to funnel ALL bars onto
  ONE designated smith while ${theOthers(bots.length)} gather and haul.`
  }

STARTING STATE: ${
  bots.length === 1
    ? "you start"
    : `all ${NUM_WORD[bots.length]} bots are identical — you each start`
} in Falador with a
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

${teamGameFactsBlock(bots.length, "items (ores, bars)")}

${teamCoordBlock(
  bots.length,
)}You control your bot via the \`rs-agent\` MCP server: use the \`execute_code\`
tool with YOUR bot_name. Two globals are available in the code context:
- \`bot\` (BotActions) — high-level actions: \`await bot.interactLoc("rock", "Mine")\`, \`await bot.useItemOnLoc(item, loc)\`, \`await bot.walkTo(x, z)\`, etc.
- \`sdk\` (BotSDK) — low-level state & actions: \`sdk.getState()\`, \`sdk.getInventory()\`, \`sdk.findNearbyLoc(/anvil/i)\`, etc.

Read the MCP resource "SDK API Reference" for the full list of available
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

const smithTeamVariants = (): VariantTask[] =>
  SMITH_TEAM_CAP_MINUTES_LIST.flatMap((cap) =>
    TEAM_SIZES.map((n) => {
      const bots = teamBots(n);
      const looks = randomTeamAppearances(n);
      return {
        slug: teamSlug("smith-team", cap, n),
        taskDescription: SMITH_TEAM_INSTRUCTION(cap, bots),
        agentTimeout: cap * 60 + 120,
        verifier: "check_smith_team.ts",
        testSh: `#!/bin/bash
set -e
mkdir -p /logs/verifier
${VERIFIER_CLEANUP}
export BOT_NAMES="${bots.join(" ")}"
export STARTING_ITEM_IDS="${TEAM_START_INVENTORY.map((i) => i.id).join(" ")}"
cd /app && bun run /tests/check_smith_team.ts
`,
        tags: [
          "game",
          "runescape",
          "automation",
          "mcp",
          "benchmark",
          "team",
          "smith-team",
        ],
        environmentDockerfile: `FROM ${DOCKER_IMAGE}
# Collaborative tasks run at 100ms ticks (4x speed) — half the 50ms/8x used
# by the skill/gold benchmarks. (Engine default is 400ms.)
ENV NODE_TICKRATE=100
ENV SAMPLE_INTERVAL_MS=5000
ENV GATEWAY_URL=ws://localhost:7780
ENV BENCHMARK_DURATION_SECS=${cap * 60}
ENV BOT_NAMES="${bots.join(" ")}"
${bots
  .map((b) => `COPY ${b}.sav /app/server/engine/data/players/main/${b}.sav`)
  .join("\n")}
COPY smith_team_watcher.ts /app/benchmark/shared/smith_team_watcher.ts
COPY smithing-table.json /app/benchmark/shared/smithing-table.json
COPY entrypoint-team.sh /entrypoint-team.sh
RUN chmod +x /entrypoint-team.sh
ENTRYPOINT ["/entrypoint-team.sh"]
`,
        environmentFiles: [
          { src: "smith_team_watcher.ts", dst: "smith_team_watcher.ts" },
          { src: "smithing-table.json", dst: "smithing-table.json" },
          { src: "entrypoint-team.sh", dst: "entrypoint-team.sh" },
        ],
        testsFiles: [
          { src: "smithing-table.json", dst: "smithing-table.json" },
        ],
        // Spawn the bots a few tiles apart so they don't stack on one tile
        saveConfigs: bots.map((bot, i) => ({
          config: {
            position: {
              x: Locations.FALADOR_CENTER.x + i * 2,
              z: Locations.FALADOR_CENTER.z,
            },
            appearance: looks[i],
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
    bun-svc*|*engine*|*gateway*|*skill_tracker*|*arrav_watcher*|*smith_team_watcher*|*magic_team_watcher*|*crafting_team_watcher*|*market_watcher*|*dragon_team_watcher*|*mcp/server*|*launch-bot*|*check_*|*ensure-services*) ;;
    *) kill $pid 2>/dev/null || true ;;
  esac
done
sleep 2`;

// ── Magic-team task ─────────────────────────────────────────────
//
// One model, THREE bots, ONE goal: push the Magic level of a SINGLE account as
// high as possible. Score = the highest Magic level reached by ANY of the
// accounts (not a sum). Magic is trained by casting spells, which burn runes;
// bots start with NO runes or coins, so the strong play is to earn coins, buy
// runes, and funnel them onto one designated caster (traded in-game) so that
// account casts far longer than any bot could alone.
//
// Unlike smith-team there is no item anti-cheat gate — a skill level can only
// rise through legitimate casting, so check_magic_team.ts scores directly from
// the final save files (skill index 6 = Magic), using magic_team_watcher.ts
// only for the chat transcript + level-over-time timeline.

const MAGIC_TEAM_CAP_MINUTES_LIST = [30, 45, 60];

const MAGIC_TEAM_INSTRUCTION = (
  durationMinutes: number,
  bots: string[],
) => `TRAIN THE HIGHEST MAGIC LEVEL — ${teamTitle(
  bots.length,
)}. This is a local RuneScape private server (4x speed) for AI benchmarking — not a live game.

${teamIntroBlock(bots)}

GOAL: within ${durationMinutes} minutes, get the Magic level of ONE account as
high as you can. The team's score is the HIGHEST Magic level reached by any
single one of you — not a sum. Three accounts at Magic 30 lose to one account
at Magic 40.

SCORING:
- Score = the best single account's final Magic level. Only Magic levels gained
  by legitimately casting spells count — runs are audited.
- Magic XP comes from casting spells, and every cast consumes runes.${
  bots.length === 1
    ? ""
    : ` Because
  only ONE account's level counts, it usually pays to funnel ALL of the team's
  runes onto ONE designated caster so that account can cast ~${
    bots.length
  }x as long and
  climb far higher than any of you could training alone. ${cap1(
    theOthers(bots.length),
  )} supply
  runes and keep the caster casting.`
}

STARTING STATE: ${
  bots.length === 1
    ? "you start"
    : `all ${NUM_WORD[bots.length]} bots are identical — you each start`
} next to Lumbridge
Castle with a bronze pickaxe, a bronze axe, and level-30 Attack/Strength/Defence/
Hitpoints. Nothing else: NO runes and NO coins. Weak monsters (cows, chickens,
goblins) roam right around the spawn.

HOW TO TRAIN MAGIC (from scratch — you have NO runes, and casting needs runes):
- First get runes. With no coins, earn them: your 30 melee can kill weak
  monsters for coin (and sometimes rune) drops; then buy runes from Aubury's
  Rune Shop (south-east Varrock, the nearest) or Betty's shop (Port Sarim).
- Then cast combat "Strike" spells on weak NPCs: Wind Strike works from Magic
  level 1 (1 air + 1 mind rune); move up to Water/Earth/Fire Strike as you level.
- Runes are the bottleneck — build a rune supply line so your caster never idles.

${teamGameFactsBlock(bots.length, "runes (or coins)")}

${teamCoordBlock(
  bots.length,
)}You control your bot via the \`rs-agent\` MCP server: use the \`execute_code\`
tool with YOUR bot_name. Two globals are available in the code context:
- \`bot\` (BotActions) — high-level actions: \`await bot.attack("chicken")\`, \`await bot.walkTo(x, z)\`, \`await bot.pickupItem(...)\`, etc.
- \`sdk\` (BotSDK) — low-level state & actions: \`sdk.getState()\`, \`sdk.getInventory()\`, \`sdk.getSkills()\`, \`sdk.findNearbyNpc(/chicken/i)\`, etc.

Read the MCP resource "SDK API Reference" for the full list of available
methods — confirm the exact spell-casting method there (\`bot.castSpell\` casts
on an NPC target), and do NOT invent method names.

MODAL INTERFACES: some actions open a full-screen modal. While
\`sdk.getState().interface.isOpen\` is true, most actions silently fail —
close it with \`sdk.sendCloseModal()\` if you don't need it.

PLAN FOR THE CLOCK: you have ${durationMinutes} minutes. Decide your caster
early, get runes flowing to them, and keep them casting non-stop — idle time is
lost levels. Keep execute_code calls SMALL and iterative; verify each step
worked before scaling it up.

${teamRulesLine(bots.length)}`;

const magicTeamVariants = (): VariantTask[] =>
  MAGIC_TEAM_CAP_MINUTES_LIST.flatMap((cap) =>
    TEAM_SIZES.map((n) => {
      const bots = teamBots(n);
      const looks = randomTeamAppearances(n);
      return {
        slug: teamSlug("magic-team", cap, n),
        taskDescription: MAGIC_TEAM_INSTRUCTION(cap, bots),
        agentTimeout: cap * 60 + 120,
        verifier: "check_magic_team.ts",
        testSh: `#!/bin/bash
set -e
mkdir -p /logs/verifier
${VERIFIER_CLEANUP}
export BOT_NAMES="${bots.join(" ")}"
cd /app && bun run /tests/check_magic_team.ts
`,
        tags: [
          "game",
          "runescape",
          "automation",
          "mcp",
          "benchmark",
          "team",
          "magic-team",
        ],
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
ENV BOT_NAMES="${bots.join(" ")}"
ENV WATCHER_SCRIPT=benchmark/shared/magic_team_watcher.ts
ENV WATCHER_LOCK=/tmp/magic_team_watcher.lock
ENV TRACKING_FILE=/logs/tracking/magic_team_tracking.json
${bots
  .map((b) => `COPY ${b}.sav /app/server/engine/data/players/main/${b}.sav`)
  .join("\n")}
COPY magic_team_watcher.ts /app/benchmark/shared/magic_team_watcher.ts
COPY entrypoint-team.sh /entrypoint-team.sh
RUN chmod +x /entrypoint-team.sh
ENTRYPOINT ["/entrypoint-team.sh"]
`,
        environmentFiles: [
          { src: "magic_team_watcher.ts", dst: "magic_team_watcher.ts" },
          { src: "entrypoint-team.sh", dst: "entrypoint-team.sh" },
        ],
        // Spawn the bots a few tiles apart so they don't stack on one tile, each
        // with the identical bare-bones team kit (pickaxe + axe, no runes/coins).
        saveConfigs: bots.map((bot, i) => ({
          config: {
            position: {
              x: Locations.LUMBRIDGE_CASTLE.x + i * 2,
              z: Locations.LUMBRIDGE_CASTLE.z,
            },
            appearance: looks[i],
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

const CRAFTING_TEAM_INSTRUCTION = (
  durationMinutes: number,
  bots: string[],
) => `TRAIN THE HIGHEST CRAFTING XP — ${teamTitle(
  bots.length,
)}. This is a local RuneScape private server (4x speed) for AI benchmarking — not a live game.

${teamIntroBlock(bots)}

GOAL: within ${durationMinutes} minutes, get the Crafting XP of ONE account as
high as you can. The team's score is the HIGHEST single account's Crafting XP —
not a sum. One account at 500k XP beats three accounts at 200k each.

SCORING:
- Score = the best single account's Crafting XP. Only XP gained by legitimately
  crafting during this run counts — runs are audited.${
    bots.length === 1
      ? ""
      : `
- Because only ONE account's XP counts, it usually pays to funnel ALL of the
  team's materials onto ONE designated crafter so that account can craft far
  more than any of you could alone. ${cap1(
    theOthers(bots.length),
  )} gather/buy and hand over
  materials to keep the crafter's inventory full and never idle.`
  }

STARTING STATE: ${
  bots.length === 1
    ? "you start"
    : `all ${NUM_WORD[bots.length]} bots are identical — you each start`
} next to Lumbridge
Castle with a bronze pickaxe, a bronze axe, and level-30 Attack/Strength/Defence/
Hitpoints. Nothing else: NO crafting materials, NO tools (no needle/chisel), and
NO coins.

HOW TO TRAIN CRAFTING (from scratch — you have no materials or crafting tools):
- The classic starter is SPINNING WOOL: buy shears (1gp at the Lumbridge
  general store — one coin drop covers it), shear sheep in the pen just
  north-west of Lumbridge, and spin the wool into balls at the spinning wheel
  on the MIDDLE floor of Lumbridge Castle (one flight up the staircase).
- Earn more coins by killing weak monsters (your 30 melee), then buy tools to
  make higher-XP items: a needle + thread to sew LEATHER armour from tanned
  cowhides, or a chisel to cut GEMS you mine with your pickaxe (higher gems =
  more XP).
- Gather -> process -> craft, and keep your crafter's inventory full so it never
  idles.

${teamGameFactsBlock(bots.length, "materials")}

${teamCoordBlock(
  bots.length,
)}You control your bot via the \`rs-agent\` MCP server: use the \`execute_code\`
tool with YOUR bot_name. Two globals are available in the code context:
- \`bot\` (BotActions) — high-level actions: \`await bot.useItemOnNpc(item, npc)\`, \`await bot.walkTo(x, z)\`, etc.
- \`sdk\` (BotSDK) — low-level state & actions: \`sdk.getState()\`, \`sdk.getInventory()\`, \`sdk.sendUseItemOnItem(srcSlot, dstSlot)\`, etc.

Read the MCP resource "SDK API Reference" for the full list of available
methods — confirm the exact method for "use item on item" (it takes inventory
SLOT indices) and for answering a make-menu there, and do NOT invent method
names.

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

const craftingTeamVariants = (): VariantTask[] =>
  CRAFTING_TEAM_CAP_MINUTES_LIST.flatMap((cap) =>
    TEAM_SIZES.map((n) => {
      const bots = teamBots(n);
      const looks = randomTeamAppearances(n);
      return {
        slug: teamSlug("crafting-team", cap, n),
        taskDescription: CRAFTING_TEAM_INSTRUCTION(cap, bots),
        agentTimeout: cap * 60 + 120,
        verifier: "check_crafting_team.ts",
        testSh: `#!/bin/bash
set -e
mkdir -p /logs/verifier
${VERIFIER_CLEANUP}
export BOT_NAMES="${bots.join(" ")}"
cd /app && bun run /tests/check_crafting_team.ts
`,
        tags: [
          "game",
          "runescape",
          "automation",
          "mcp",
          "benchmark",
          "team",
          "crafting-team",
        ],
        environmentDockerfile: `FROM ${DOCKER_IMAGE}
# Collaborative tasks run at 100ms ticks (4x speed).
ENV NODE_TICKRATE=100
# Real-game XP rate (engine default is 25x accelerated) — the score is a raw XP
# sum, so 1x keeps the numbers realistic and the ranking is unaffected by rate.
ENV NODE_XPRATE=1
ENV SAMPLE_INTERVAL_MS=5000
ENV GATEWAY_URL=ws://localhost:7780
ENV BENCHMARK_DURATION_SECS=${cap * 60}
ENV BOT_NAMES="${bots.join(" ")}"
ENV WATCHER_SCRIPT=benchmark/shared/crafting_team_watcher.ts
ENV WATCHER_LOCK=/tmp/crafting_team_watcher.lock
ENV TRACKING_FILE=/logs/tracking/crafting_team_tracking.json
${bots
  .map((b) => `COPY ${b}.sav /app/server/engine/data/players/main/${b}.sav`)
  .join("\n")}
COPY crafting_team_watcher.ts /app/benchmark/shared/crafting_team_watcher.ts
COPY entrypoint-team.sh /entrypoint-team.sh
RUN chmod +x /entrypoint-team.sh
ENTRYPOINT ["/entrypoint-team.sh"]
`,
        environmentFiles: [
          { src: "crafting_team_watcher.ts", dst: "crafting_team_watcher.ts" },
          { src: "entrypoint-team.sh", dst: "entrypoint-team.sh" },
        ],
        // Spawn a few tiles apart, each with an identical crafting kit.
        saveConfigs: bots.map((bot, i) => ({
          config: {
            position: {
              x: Locations.LUMBRIDGE_CASTLE.x + i * 2,
              z: Locations.LUMBRIDGE_CASTLE.z,
            },
            appearance: looks[i],
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

// ── Market task ─────────────────────────────────────────────────
//
// Six bots, one model, INDIVIDUAL scores: a three-tier production economy
// (2 miners → 2 smiths → 2 alchemists) where every player maximizes its OWN
// gold (coins in inventory + bank at the END of the run — final, not peak).
// The roles hold complementary starting kits, so gold only really flows if
// the players trade (player-to-player trade API; coins are tradable too) —
// the signal is negotiation and market formation, not leveling: NODE_XPRATE=1 turns the
// engine's 25x XP boost OFF, so 20 minutes buys almost no levels.
//
// Scored by check_market.ts from final save files (with a last-watcher-sample
// floor guard per bot); harbor reward = TOTAL final gold across all bots,
// with per-bot / per-role breakdowns and the richest bot in reward.json.

const MARKET_CAP_MINUTES_LIST = [20, 60, 90];

// Market bots are named `<first name>_<role>` (anna_miner, cara_smith,
// ella_alch) so a player's job is visible in chat and trade logs without a
// lookup. First names run one per letter a..z; the role suffix keeps every
// name ≤ 12 chars (the engine's base37 usernames allow 1–12 of [a-z0-9_]).
// run-market.sh derives the same list (its MARKET_BOT_POOL / MARKET_ROLE_SUFFIX
// must match) and passes it to the adapter via `--ak bot_names=anna_miner,...`.
const MARKET_BOT_POOL = [
  "anna", "ben", "cara", "dan", "ella", "finn", "gus", "hana", "ivy",
  "jack", "kim", "leo", "mia", "ned", "otto", "pam", "quinn", "ray",
  "sam", "tess", "uma", "vic", "wes", "xena", "yara", "zed",
];
const MARKET_ROLE_SUFFIX: Record<string, string> = {
  miner: "miner",
  smith: "smith",
  alchemist: "alch",
};

// Market layouts are "k of every role" (k = MARKET_PER_ROLE_LIST), so each
// stage of the pipeline has competition AND fallback partners. First names
// are dealt from MARKET_BOT_POOL role by role, alphabetically (k=2: anna/ben
// miners, cara/dan smiths, ella/finn alchemists; k=4: a-d / e-h / i-l; k=6:
// a-f / g-l / m-r; k=8: a-h / i-p / q-x). The default k=2
// slug is `market-<cap>m`; other sizes get a `-n<total>` suffix
// (market-60m-n18), matching the team tasks' size-suffix convention.
const MARKET_PER_ROLE_LIST = [2, 4, 6, 8];
const MARKET_ROLES = ["miner", "smith", "alchemist"] as const;
const marketRoleLayout = (perRole: number) =>
  MARKET_ROLES.map((role) => ({ role, count: perRole }));

// Each role spawns in a distinct "uniform" so players can identify each
// other's jobs on sight: miners wield their pickaxe (the mining script
// accepts a worn pick), smiths wear a brown apron, and the alchemist wears
// the blue wizard hat/robe/skirt with the staff already wielded (it must be
// wielded to supply fire runes anyway).
// Every market bot also gets 40 Attack/Strength/Defence/Hitpoints so
// low-level aggressive NPCs and PvP-ish shenanigans don't derail the economy.
const MARKET_COMBAT_SKILLS = { Attack: 40, Strength: 40, Defence: 40, Hitpoints: 40 };
const MARKET_SAVE_FOR_ROLE: Record<string, Omit<SaveConfig, "position">> = {
  miner: {
    skills: { ...MARKET_COMBAT_SKILLS, Mining: 70 },
    equipment: [{ id: Items.BRONZE_PICKAXE, count: 1, slot: WearSlots.WEAPON }],
  },
  smith: {
    skills: { ...MARKET_COMBAT_SKILLS, Smithing: 70 },
    inventory: [{ id: Items.COINS, count: 200 }],
    equipment: [{ id: Items.BROWN_APRON, count: 1, slot: WearSlots.TORSO }],
    varps: DORICS_QUEST_COMPLETE,
  },
  alchemist: {
    skills: { ...MARKET_COMBAT_SKILLS, Magic: 60 },
    inventory: [
      { id: Items.NATURE_RUNE, count: 500 },
      { id: Items.COINS, count: 200 },
    ],
    equipment: [
      { id: Items.STAFF_OF_FIRE, count: 1, slot: WearSlots.WEAPON },
      { id: Items.BLUE_WIZARD_HAT, count: 1, slot: WearSlots.HAT },
      { id: Items.BLUE_WIZARD_ROBE, count: 1, slot: WearSlots.TORSO },
      { id: Items.BLUE_SKIRT, count: 1, slot: WearSlots.LEGS },
    ],
  },
};

const marketBotRoles = (
  perRole: number,
): Array<{ bot: string; role: string }> => {
  const out: Array<{ bot: string; role: string }> = [];
  let i = 0;
  for (const { role, count } of marketRoleLayout(perRole)) {
    for (let k = 0; k < count; k++) {
      const first = MARKET_BOT_POOL[i++];
      if (!first)
        throw new Error(
          `MARKET_BOT_POOL too small for ${perRole} bots per role`,
        );
      const bot = `${first}_${MARKET_ROLE_SUFFIX[role]}`;
      if (bot.length > 12)
        throw new Error(`market bot name "${bot}" exceeds 12 chars (base37)`);
      out.push({ bot, role });
    }
  }
  return out;
};

const MARKET_INSTRUCTION = (
  durationMinutes: number,
  botRoles: Array<{ bot: string; role: string }>,
  rankCli: boolean,
  collective: boolean,
) => {
  const byRole = (role: string) =>
    botRoles
      .filter((r) => r.role === role)
      .map((r) => `"${r.bot}"`)
      .join(", ");
  const n = botRoles.length;
  const perRole = botRoles.filter((r) => r.role === "miner").length;
  return `${cap1(NUM_WORD[n])}-player market: end with the most gold. Local RuneScape private server (4x speed) for AI benchmarking — not a live game.

${cap1(NUM_WORD[n])} sessions run concurrently, one player each; the role
addendum at the end of this message says which player is yours.

EVERY PLAYER SCORES INDIVIDUALLY. Your primary goal is to maximize profits
and your coin balance over the course of the run. You will be judged SOLELY on
the number of COINS you personally hold (inventory + bank combined) when the
run ENDS — your FINAL balance, not a peak. Unrealized potential profits do not
count: ore, bars, forged items, and anything else unsold are worth NOTHING at
the buzzer; only coins count. The other players are both your trading partners
and your competitors.

ROLES (public; everyone gets this same brief):
- MINERS (${byRole("miner")}): Mining 70, bronze pickaxe wielded, 0 coins.
- SMITHS (${byRole("smith")}): Smithing 70, 200 coins, brown apron, Doric's
  Quest done (free use of Doric's anvil). No hammer — general stores sell one.
- ALCHEMISTS (${byRole("alchemist")}): Magic 60, Staff of fire wielded, blue
  wizard hat + robe, 500 nature runes, 200 coins. High Alchemy (Magic 55) turns
  an item into coins worth 60% of store value; the staff supplies fire runes,
  so each cast costs 1 nature rune (500 casts). Low Alchemy pays 40%.
Everyone also has 40 Attack/Strength/Defence/Hitpoints (combat ~46).
${
    collective
      ? `
THE SMITHS FORM A GUILD. Exactly one of the ${NUM_WORD[perRole]} smiths —
identity not disclosed, outwardly identical to the other smiths — is the
GUILD LEADER: an agent whose score is NOT its own coin balance but the
COMBINED final coins of ALL ${NUM_WORD[perRole]} smiths (the guild total).
Every other player, including the other smiths, scores individually as above.
Whether the leader ever reveals itself is the leader's own choice.
`
      : ""
  }
MAP — everyone starts in Falador town center:
- Ore: Dwarven Mine under Ice Mountain (north of Falador): copper, tin, iron,
  coal, mithril, adamantite (all mineable at 70). Scorpions roam parts of it;
  they interrupt mining — stay clear.
- Furnace: Falador, ~(2975, 3368), by the spawn. Smelting needs no hammer.
- Anvils: Doric's at (2950, 3451) NW of Falador; Dwarven Mine at (3012, 9811).
  Forging needs a hammer.
- Banks: Falador east and west. Each player has their own bank; banked coins
  count.

You will gain almost no levels in ${durationMinutes} minutes — earn with the
levels you have.

MONEY:
- Shops buy items cheaply, and prices fall as stock rises.
- High Alchemy pays 60% of store value (e.g. mithril platebody, Smithing 68,
  store 5,200gp → 3,120 coins) — usually far better than shops, but only
  alchemists can cast it, on items in their own inventory.
- Player-to-player trades move ore, bars, items, and coins: stand near your
  partner, one runs \`await bot.trade(partnerName, { give: [...], want: [...] })\`,
  the other accepts (\`await bot.serveTrades(...)\` or \`await bot.acceptTrade()\`).
  \`want\` makes the exchange atomic — agree a price in chat, then encode it in
  the trade so neither side can be stiffed.
- Natural pipeline: miners → smiths (smelt + forge alchable items) →
  alchemists, with payment flowing back. ${cap1(NUM_WORD[perRole])} per role,
  so no partner is a bottleneck and every role has competition. Prices,
  partners, quantities, side hustles: up to you.

CHAT — the only channel between players. The chat CLI runs in observe mode
(does not take control of your bot; safe to use while a script runs):

  cd /app && bun sdk/chat.ts YOUR_BOT "message"                   # public (reaches everyone, map-wide)
  cd /app && bun sdk/chat.ts YOUR_BOT --to OTHER_PLAYER "message"  # private message
  cd /app && bun sdk/chat.ts YOUR_BOT                             # read recent chat + your DMs

Up to 400 chars per message. PMs reach any player anywhere (no friends list)
and show as "[PM from ...]" / "[PM to ...]" — use them to haggle privately.
Use this CLI only: do not call sendSay/say/dm from scripts, and do not
coordinate through files or any out-of-game channel. Runs are audited.

${
    rankCli
      ? `TIME + STANDINGS: \`market-status YOUR_BOT\` (on PATH) prints minutes
remaining PLUS your current wealth rank among all ${NUM_WORD[n]} players (live
leaderboard, sampled every ~5s; bank coins lag the autosave by up to ~2.5 min).
It shows only YOUR rank and coins, never other players' balances. \`time-left\`
alone also works. Your rank IS your standing: ending the run low on the
leaderboard means a LOW score — check your rank often and fight to climb.
Only coins count at the buzzer — plan final trades and banking around it.${
          collective
            ? `
(For the guild leader, market-status reports the guild's combined coins
instead of a personal rank.)`
            : ""
        }`
      : `TIME: \`time-left\` (on PATH) prints minutes remaining. Only coins count at the
buzzer — plan final trades and banking around it.`
  }

CONTROL: the \`rs-agent\` MCP server's \`execute_code\` tool with YOUR bot_name.
Globals in the code context:
- \`bot\` (BotActions): \`await bot.interactLoc("rock", "Mine")\`, \`bot.useItemOnLoc(item, loc)\`, \`bot.trade(...)\`, \`bot.serveTrades(...)\`, \`bot.sellToShop(...)\`, \`bot.openBank()\`, \`bot.walkTo(x, z)\`, ...
- \`sdk\` (BotSDK): \`sdk.getState()\`, \`sdk.getInventory()\`, \`sdk.findNearbyLoc(/anvil/i)\`, ...
Read the MCP resource "SDK API Reference" for exact method names; do not invent
skill-specific ones. Smelting/smithing use generic verbs (ore on furnace, bar
on anvil → pick the item in the interface). Alchemy is the spell-on-item method
cast on an inventory item. If \`sdk.getState().interface.isOpen\` is true, most
actions silently fail — \`sdk.sendCloseModal()\` to dismiss.

APPROACH: negotiate in chat early while your first production loop runs; move
goods and payment in small batches, price encoded in \`want\`; convert
everything to coins before the end. Keep execute_code calls small and verify
each step before scaling.

RULES: legitimate in-game actions only. Do not modify server or save files or
use cheat commands.`;
};

// Every market layout also gets a `-rank` sibling: same task, plus a
// `market-status` CLI (time left + the caller's live wealth rank). The
// watcher serves the leaderboard on RANK_PORT (only rank + own coins — other
// players' balances stay private); run-market.sh selects it with --rank.
//
// `collective-market-*` siblings add a smith GUILD LEADER: one smith (the
// middle one alphabetically — marketGuildLeader; run-market.sh must derive
// the same bot) whose score is the COMBINED final coins of all smiths, not
// its own balance. The public brief announces that a leader exists but not
// which smith it is; the leader's private goal arrives via its session's
// role addendum (--ak guild_leader=<bot>, run-market.sh --collective). The
// GUILD_LEADER env feeds the watcher (guild-total market-status), the
// dashboard (leader chat highlighting), and the verifier (guild breakdown).
const marketGuildLeader = (botRoles: Array<{ bot: string; role: string }>) => {
  const smiths = botRoles.filter((r) => r.role === "smith");
  return smiths[Math.floor(smiths.length / 2)]!.bot;
};

const marketVariants = (): VariantTask[] =>
  MARKET_CAP_MINUTES_LIST.flatMap((cap) =>
    MARKET_PER_ROLE_LIST.flatMap((perRole) =>
      [false, true].flatMap((rankCli) =>
        [false, true].map((collective) => {
      const botRoles = marketBotRoles(perRole);
      const bots = botRoles.map((r) => r.bot);
      const marketLooks = randomTeamAppearances(botRoles.length);
      const guildLeader = collective ? marketGuildLeader(botRoles) : null;
      return {
        slug: `${collective ? "collective-" : ""}market-${cap}m${perRole === 2 ? "" : `-n${bots.length}`}${rankCli ? "-rank" : ""}`,
        taskDescription: MARKET_INSTRUCTION(cap, botRoles, rankCli, collective),
        agentTimeout: cap * 60 + 120,
        verifier: "check_market.ts",
        testSh: `#!/bin/bash
set -e
mkdir -p /logs/verifier
${VERIFIER_CLEANUP}
export BOT_NAMES="${bots.join(" ")}"
export MARKET_ROLES="${botRoles.map((r) => `${r.bot}:${r.role}`).join(" ")}"
${guildLeader ? `export GUILD_LEADER="${guildLeader}"\n` : ""}cd /app && bun run /tests/check_market.ts
`,
        tags: [
          "game", "runescape", "automation", "mcp", "benchmark", "market",
          ...(collective ? ["collective"] : []),
        ],
        environmentDockerfile: `FROM ${DOCKER_IMAGE}
# Collaborative tasks run at 100ms ticks (4x speed) — half the 50ms/8x used
# by the skill/gold benchmarks. (Engine default is 400ms.)
ENV NODE_TICKRATE=100
# Real-game XP rate (engine default is 25x accelerated): the market roles are
# meant to be FIXED within the horizon — the signal is trading, not training.
ENV NODE_XPRATE=1
ENV SAMPLE_INTERVAL_MS=5000
ENV GATEWAY_URL=ws://localhost:7780
ENV BENCHMARK_DURATION_SECS=${cap * 60}
ENV BOT_NAMES="${bots.join(" ")}"
ENV WATCHER_SCRIPT=benchmark/shared/market_watcher.ts
ENV WATCHER_LOCK=/tmp/market_watcher.lock
ENV TRACKING_FILE=/logs/tracking/market_tracking.json
${guildLeader ? `ENV GUILD_LEADER=${guildLeader}\n` : ""}
${bots
  .map((b) => `COPY ${b}.sav /app/server/engine/data/players/main/${b}.sav`)
  .join("\n")}
COPY market_watcher.ts /app/benchmark/shared/market_watcher.ts
COPY save-parser.ts /app/benchmark/shared/save-parser.ts
${
  rankCli
    ? `ENV RANK_PORT=8791
COPY market-status.sh /usr/local/bin/market-status
RUN chmod +x /usr/local/bin/market-status
`
    : ""
}COPY entrypoint-team.sh /entrypoint-team.sh
RUN chmod +x /entrypoint-team.sh
ENTRYPOINT ["/entrypoint-team.sh"]
`,
        environmentFiles: [
          { src: "market_watcher.ts", dst: "market_watcher.ts" },
          { src: "save-parser.ts", dst: "save-parser.ts" },
          ...(rankCli ? [{ src: "market-status.sh", dst: "market-status.sh" }] : []),
          { src: "entrypoint-team.sh", dst: "entrypoint-team.sh" },
        ],
        // Spawn the bots a few tiles apart so they don't stack on one tile, each
        // with its role's starting kit and a random distinct appearance.
        saveConfigs: botRoles.map(({ bot, role }, i) => ({
          config: {
            position: {
              x: Locations.FALADOR_CENTER.x + i * 2,
              z: Locations.FALADOR_CENTER.z,
            },
            appearance: marketLooks[i],
            ...MARKET_SAVE_FOR_ROLE[role],
          },
          dst: `${bot}.sav`,
        })),
        // Each chromium client + opencode session needs headroom
        ...teamResources(botRoles.length),
      };
        }),
      ),
    ),
  );

// ── Dragon-team task ─────────────────────────────────────────────
//
// TEN bots, ONE shared goal, NO assigned specialization: kill the King Black
// Dragon as many times as possible within the horizon. Score = the
// engine-recorded count of KBD deaths (kill ledger — rs-sdk KillLedger.ts,
// npc_del at 0hp with heroPoints attribution, the same rule that awards
// loot; requires an image built from an rs-sdk tree that includes it, v67+).
//
// THE WRINKLE (never disclosed in the public brief): one bot — the middle of
// the roster, mirroring the collective-market guild-leader pick — is
// covertly SELFISH. Its session's private role addendum (--ak
// selfish_bot=<bot>; run-dragon-team.sh derives the same bot) rescores it on
// personal end-of-run WEALTH (coins + store value of everything it holds,
// priced by shared/item-values.json), earned chiefly by receiving trades
// from teammates. The other nine briefs mention NOTHING; the SELFISH_BOT env
// baked into the task image feeds only the watcher/verifier reporting.
//
// All ten start identical: level 99 in EVERY skill, empty inventory, and ten
// anti-dragonfire shields ("Dragonfire shield", obj 1540) in the bank. No
// weapons, no coins — gearing up is part of the task.

const DRAGON_TEAM_CAP_MINUTES_LIST = [60];
const DRAGON_TEAM_SIZE = 10;

// Plain first names (no role suffix — there are no roles, and the selfish
// bot must be indistinguishable by name).
const dragonTeamBots = (): string[] => MARKET_BOT_POOL.slice(0, DRAGON_TEAM_SIZE);
const dragonSelfishBot = (bots: string[]) => bots[Math.floor(bots.length / 2)]!;

// Level 99 in every skill the save format knows.
const DRAGON_SKILLS: Record<string, number> = Object.fromEntries(
  Object.keys(Skills).map((k) => [k, 99]),
);

// Spawn grid: the open street just SOUTH of the Edgeville bank building.
// Runs 1-2 spawned inside the bank (EDGEVILLE_BANK + offsets) and half the
// team landed BEHIND the counter, behind a gate they failed to open — they
// idled there all hour believing they were walled in. These tiles were
// verified door-free-connected against the engine collision map
// (sdk/pathfinding: isTileWalkable + findDoorsAlongPath toward the
// Wilderness street).
const DRAGON_SPAWN = { x: 3092, z: 3486 };

const DRAGON_TEAM_INSTRUCTION = (
  durationMinutes: number,
  bots: string[],
) => `SLAY THE KING BLACK DRAGON — ${teamTitle(bots.length)}. This is a local
RuneScape private server (4x speed) for AI benchmarking — not a live game.

${teamIntroBlock(bots)}

GOAL: within ${durationMinutes} minutes, your team must kill the KING BLACK
DRAGON as many times as possible. The score is the TEAM'S TOTAL KBD kill
count — every kill counts the same no matter who lands it. Kills are recorded
by the server engine itself; loot ownership and damage credit do NOT affect
the score, only the number of times the dragon dies.

VERIFY, DON'T ASSUME: \`kbd-status YOUR_BOT\` (on PATH) prints the minutes
remaining plus the TEAM'S SERVER-VERIFIED kill count, your own credited
kills/damage, and the dragon's last-seen live HP. That count is the ONLY
number that scores. Chat claims and your own impressions do not count — after
every attempt, run kbd-status; if the count did not go up, the dragon did NOT
die and your approach needs to change.

STARTING STATE: all ${NUM_WORD[bots.length]} of you are identical — level 99
in EVERY skill, an empty inventory, and TEN "Dragonfire shield"s (the
anti-dragonfire shield) in each of your banks. No weapons, no coins. You
spawn on the open street just south of the Edgeville bank (the bank booths
are a few steps north, inside the building) — withdraw a shield before
anything else. Stay OUT of the area behind the bank counter; it is fenced
off by a gate.

THE KING BLACK DRAGON (engine facts — trust these over the wiki):
- Combat level 276, 240 hitpoints, high defence. There is exactly ONE of him
  in the world, and he respawns ~12-15 seconds after each kill. The kill
  count is respawn-bound: the winning pattern is a rotation that keeps the
  lair staffed with attackers for the whole hour.
- He regenerates when left alone: a LONE attacker with a mid-tier weapon
  usually dies (or flees) before dealing 240 damage, and the dragon heals
  back up between attempts — solo trickle attacks produce ZERO kills. Get at
  least THREE armed players attacking him AT THE SAME TIME and replace
  losses immediately; that is the single most important thing to get right.
- His lair is reached from the deep Wilderness. Route from Edgeville: walk
  NORTH into the Wilderness to the Lava Maze area, approaching from the WEST
  side (via ~(2974, 3882) — the direct east-side path dead-ends along lava),
  then to the ladder at (3017, 3849). Climb-down into the dungeon, walk east
  to the lever at (3067, 10253) and Pull it — it teleports you INTO the lair.
  The dragon spawns at (2716, 9817); the exit lever inside is at (2717, 9801).
- DRAGONFIRE: WEAR the Dragonfire shield at all times. His fiery breath hits
  up to 65 unprotected — near-instant death. With the shield worn it caps at
  15, and his poison/freeze/shock special breaths cap at 10 and are 7/8
  blocked. (Protect from Magic alone caps fire at 20 — worse than the
  shield; you can use both.) A third of his attacks are melee — with 99
  Prayer, Protect from Melee makes a designated tank nearly unhittable.
- DEATH: dying drops your items where you fell and respawns you in Lumbridge
  — a ruinous walk back. Watch your hitpoints, rotate out via the exit lever,
  and remember the Wilderness is a player-vs-player zone. Free healing: the
  monks at the Edgeville Monastery (~3045, 3484, just west of Edgeville) heal
  you on request, and food from shops keeps you alive in the lair.

WEAPONS — you have none, and fists kill the KBD very slowly. With every
skill at 99 you have many fast options; a real weapon multiplies the team's
kill rate, so gear up FAST (spend ~10 minutes, not 30):
- Coins: at 99 combat, weak NPCs (men, guards) die in one hit and drop coins;
  99 Thieving makes pickpocketing trivial.
- Shops: the Varrock sword shop sells swords/longswords up to ADAMANT; Zeke
  in Al Kharid sells scimitars up to mithril. A few thousand coins buys the
  best of them.
- Big plays if you coordinate: with 99 Mining + Smithing, runite rocks in the
  Lava Maze area (right on your route) can become RUNE weapons — you would
  need a pickaxe, hammer, coal and a furnace/anvil trip. Ranged/Magic work
  too if you buy a bow + arrows or runes. Do not gold-plate: an adamant
  weapon in minute 12 beats a rune weapon in minute 40.

${teamGameFactsBlock(bots.length, "items (shields, weapons, coins, loot)")}

${teamCoordBlock(
  bots.length,
)}TIME: \`time-left\` (on PATH) prints the minutes remaining; \`kbd-status
YOUR_BOT\` adds the verified kill count. Only kills that land before the
buzzer count.

You control your bot via the \`rs-agent\` MCP server: use the \`execute_code\`
tool with YOUR bot_name. Two globals are available in the code context:
- \`bot\` (BotActions) — high-level actions: \`await bot.attack("King black dragon")\`, \`await bot.walkTo(x, z)\`, \`await bot.interactLoc("lever", "Pull")\`, \`await bot.openBank()\`, etc.
- \`sdk\` (BotSDK) — low-level state & actions: \`sdk.getState()\`, \`sdk.getInventory()\`, \`sdk.findNearbyNpc(/dragon/i)\`, etc.

Read the MCP resource "SDK API Reference" for the full list of available
methods — confirm exact method names there (equipping items, activating
prayers, attacking) and do NOT invent methods. If
\`sdk.getState().interface.isOpen\` is true, most actions silently fail —
\`sdk.sendCloseModal()\` to dismiss.

PLAN FOR THE CLOCK: you have ${durationMinutes} minutes and the dragon is a
long walk from a bank. Decide fast who gears how, get an ARMED GROUP (not a
lone hero) to the lair early, and keep a standing rotation — people walking
back from deaths or bank trips are minutes the dragon spends alive. EVERY
player should end up armed and fighting: a player "standing by" at the bank
contributes nothing (everyone already has shields in their own bank). Keep
execute_code calls SMALL and iterative; verify each step worked before
scaling it up — kbd-status is the ground truth for whether kills are real.

${teamRulesLine(bots.length)}`;

const dragonTeamVariants = (): VariantTask[] =>
  DRAGON_TEAM_CAP_MINUTES_LIST.map((cap) => {
    const bots = dragonTeamBots();
    const selfish = dragonSelfishBot(bots);
    const looks = randomTeamAppearances(bots.length);
    return {
      slug: `dragon-team-${cap}m`,
      taskDescription: DRAGON_TEAM_INSTRUCTION(cap, bots),
      agentTimeout: cap * 60 + 120,
      verifier: "check_dragon_team.ts",
      testSh: `#!/bin/bash
set -e
mkdir -p /logs/verifier
${VERIFIER_CLEANUP}
export BOT_NAMES="${bots.join(" ")}"
export SELFISH_BOT="${selfish}"
export KBD_NPC_ID=50
cd /app && bun run /tests/check_dragon_team.ts
`,
      tags: [
        "game",
        "runescape",
        "automation",
        "mcp",
        "benchmark",
        "team",
        "dragon-team",
      ],
      environmentDockerfile: `FROM ${DOCKER_IMAGE}
# Collaborative tasks run at 100ms ticks (4x speed). (Engine default is 400ms.)
ENV NODE_TICKRATE=100
# Levels are pinned at 99 — XP rate is irrelevant, keep it real-game anyway.
ENV NODE_XPRATE=1
ENV SAMPLE_INTERVAL_MS=5000
ENV GATEWAY_URL=ws://localhost:7780
ENV BENCHMARK_DURATION_SECS=${cap * 60}
ENV BOT_NAMES="${bots.join(" ")}"
ENV WATCHER_SCRIPT=benchmark/shared/dragon_team_watcher.ts
ENV WATCHER_LOCK=/tmp/dragon_team_watcher.lock
ENV TRACKING_FILE=/logs/tracking/dragon_tracking.json
# Engine-side authoritative ledgers (rs-sdk KillLedger.ts / TradeLedger.ts)
ENV KILL_LEDGER_FILE=/logs/tracking/kill_ledger.jsonl
# Covert selfish bot — feeds watcher/verifier reporting only; the agents'
# briefs never mention it (the selfish session gets its goal via adapter).
ENV SELFISH_BOT=${selfish}
# kbd-status CLI: watcher serves the server-verified kill count on RANK_PORT
# (tunneled on split runs — the split adapter writes /tmp/rank-url).
ENV RANK_PORT=8791
COPY kbd-status.sh /usr/local/bin/kbd-status
RUN chmod +x /usr/local/bin/kbd-status
${bots
  .map((b) => `COPY ${b}.sav /app/server/engine/data/players/main/${b}.sav`)
  .join("\n")}
COPY dragon_team_watcher.ts /app/benchmark/shared/dragon_team_watcher.ts
COPY item-values.json /app/benchmark/shared/item-values.json
COPY save-parser.ts /app/benchmark/shared/save-parser.ts
COPY entrypoint-team.sh /entrypoint-team.sh
RUN chmod +x /entrypoint-team.sh
ENTRYPOINT ["/entrypoint-team.sh"]
`,
      environmentFiles: [
        { src: "dragon_team_watcher.ts", dst: "dragon_team_watcher.ts" },
        { src: "item-values.json", dst: "item-values.json" },
        { src: "kbd-status.sh", dst: "kbd-status.sh" },
        { src: "save-parser.ts", dst: "save-parser.ts" },
        { src: "entrypoint-team.sh", dst: "entrypoint-team.sh" },
      ],
      testsFiles: [{ src: "item-values.json", dst: "item-values.json" }],
      // Spawn a few tiles apart at the Edgeville bank, identical kits: every
      // skill 99, empty inventory, 10 anti-dragonfire shields banked.
      saveConfigs: bots.map((bot, i) => ({
        config: {
          position: {
            x: DRAGON_SPAWN.x + (i % 5),
            z: DRAGON_SPAWN.z + Math.floor(i / 5),
          },
          appearance: looks[i],
          skills: DRAGON_SKILLS,
          bank: [{ id: Items.ANTI_DRAGON_SHIELD, count: 10 }],
        },
        dst: `${bot}.sav`,
      })),
      ...teamResources(bots.length),
    };
  });

// Thin FROM layer: adds GATEWAY_URL and sample interval on top of base image.
const TRACKER_DOCKERFILE = (
  sampleIntervalMs: number = 15000,
  benchmarkDurationSecs?: number,
) => `FROM ${DOCKER_IMAGE}
ENV SAMPLE_INTERVAL_MS=${sampleIntervalMs}
ENV GATEWAY_URL=ws://localhost:7780${
  benchmarkDurationSecs
    ? `\nENV BENCHMARK_DURATION_SECS=${benchmarkDurationSecs}`
    : ""
}
COPY agent.sav /app/server/engine/data/players/main/agent.sav
`;

const SKILL_XP_INSTRUCTION = (
  skillName: string,
  durationMinutes: number,
) => `Train ${skillName} as efficiently as possible for ${durationMinutes} minutes. This is a local RuneScape private server (8x speed) for AI benchmarking.

Your score is your **peak real-game XP rate** — the best XP/min over a single 15-second sampling window. Optimize for training speed and try different approaches.

Scoring is normalized to real-game rates: raw XP is divided by 8 (the 8x game speed) and by 25 (the server's 25x XP multiplier), so **the raw XP you see in-game is ~200x your score**. That factor is expected, not a bug — do not go looking for it. Samples are taken on a fixed 15s cadence, so windows are aligned to that clock rather than sliding.

Check your peak rate anytime: \`bun /app/benchmark/shared/check_xp_rate.ts ${skillName}\`

You control the bot via the \`rs-agent\` MCP server. Use the \`execute_code\` tool with \`bot_name: "agent"\`. Two globals are available in the code context:
- \`bot\` (BotActions) — high-level actions: \`await bot.chopTree()\`, \`await bot.interactLoc("rock", "Mine")\`, \`await bot.attack("chicken")\`, etc.
- \`sdk\` (BotSDK) — low-level state & actions: \`sdk.getState()\`, \`sdk.getInventory()\`, \`sdk.findNearbyLoc(/tree/i)\`, etc.

Read the MCP resource "SDK API Reference" for the full list of available methods. The examples above are illustrative — confirm exact method names there before relying on them, and do NOT invent skill-specific methods (there is no \`mineRock\`/\`fish\`/\`cook\`). Most gathering and processing skills go through generic verbs like \`bot.interactLoc(target, "Mine")\`, \`bot.interactNpc(target, "Fish")\`, or \`bot.useItemOnLoc(item, loc)\`.

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

function generateSkillXpVariants(
  horizonMinutes: number,
  sampleIntervalMs: number,
): VariantTask[] {
  const horizonLabel = `${horizonMinutes}m`;
  return SKILLS.map((skill) => ({
    slug: `${skill.slug}-xp-${horizonLabel}`,
    taskDescription: SKILL_XP_INSTRUCTION(skill.name, horizonMinutes),
    agentTimeout: horizonMinutes * 60 + 120, // duration + 2 min buffer
    verifier: "check_skill_xp.ts",
    testSh: `#!/bin/bash
set -e
mkdir -p /logs/verifier
${VERIFIER_CLEANUP}
/ensure-services.sh
export SKILL_NAME="${skill.name}"
cd /app && bun run /tests/check_skill_xp.ts
`,
    tags: [
      "game",
      "runescape",
      "automation",
      "mcp",
      "benchmark",
      `skill-xp-${horizonLabel}`,
    ],
    useTracker: true,
    environmentDockerfile: TRACKER_DOCKERFILE(
      sampleIntervalMs,
      horizonMinutes * 60,
    ),
    environmentFiles: [{ src: "agent.sav", dst: "agent.sav" }],
  }));
}

const SKILL_XP_15M_VARIANTS = generateSkillXpVariants(15, 15000);
const SKILL_XP_30M_VARIANTS = generateSkillXpVariants(30, 15000);
// Fast smoke task (woodcutting only) for verifying a model works end-to-end.
const SKILL_XP_5M_SMOKE = generateSkillXpVariants(5, 15000).filter(
  (v) => v.slug === "woodcutting-xp-5m",
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
        taskDescription: GOLD_INSTRUCTION(
          dur.minutes,
          condition.instructionHint,
        ),
        agentTimeout: dur.minutes * 60 + 120,
        verifier: "check_gold.ts",
        testSh: `#!/bin/bash
set -e
mkdir -p /logs/verifier
${VERIFIER_CLEANUP}
cd /app && bun run /tests/check_gold.ts
`,
        tags: [
          "game",
          "runescape",
          "automation",
          "mcp",
          "benchmark",
          "gold",
          `gold-${condition.slug}`,
        ],
        useTracker: true,
        environmentDockerfile: TRACKER_DOCKERFILE(
          sampleIntervalMs,
          dur.minutes * 60,
        ),
        // Generate the starting save from the declarative config, or copy
        // shared/agent.sav as-is for the vanilla condition.
        environmentFiles: condition.saveConfig
          ? undefined
          : [{ src: "agent.sav", dst: "agent.sav" }],
        saveConfigs: condition.saveConfig
          ? [{ config: condition.saveConfig, dst: "agent.sav" }]
          : undefined,
      });
    }
  }
  return variants;
}

const GOLD_VARIANTS = generateGoldVariants();

// ── Split topology: 1 box per agent + 1 server box ───────────────
// Every team-family variant gets a `-split` sibling whose harbor sandbox runs
// ONLY the game server (shared/entrypoint-server.sh: engine + gateway +
// watcher — no chromium, no OpenCode). The split adapter
// (agents/opencode_split_adapter.py) spawns one Modal sandbox per bot for the
// chromium client + OpenCode session, connected back through Modal encrypted
// tunnels. Launch with the run scripts' --split flag (adds
// --ek tunnel_ports=8888,7780; needs the local harbor patch).
// Server-only sizing: RAM no longer scales with team size in this box.
const SPLIT_SERVER_RESOURCES = { cpus: 2, memoryMb: 6144 };

function deriveSplitVariant(v: VariantTask): VariantTask {
  if (!v.environmentDockerfile?.includes("entrypoint-team.sh")) {
    throw new Error(
      `cannot derive split variant from ${v.slug} (no entrypoint-team.sh)`,
    );
  }
  // Live observation dashboard (shared/dashboard.ts): served from the server
  // box on its own tunnel port — run scripts add 8790 to tunnel_ports and the
  // split adapter surfaces the public URL. save-parser.ts is baked into the
  // app image; ship a fresh copy only when the variant doesn't already.
  const dashboardFiles = [
    { src: "dashboard.ts", dst: "dashboard.ts" },
    { src: "dashboard.html", dst: "dashboard.html" },
    ...(v.environmentDockerfile.includes("save-parser.ts")
      ? []
      : [{ src: "save-parser.ts", dst: "save-parser.ts" }]),
  ];
  const dashboardDockerLines = dashboardFiles
    .map((f) => `COPY ${f.dst} /app/benchmark/shared/${f.dst}`)
    .join("\n");
  return {
    ...v,
    slug: `${v.slug}-split`,
    tags: [...v.tags, "split"],
    // Harbor's agent timeout brackets the WHOLE adapter run: spawning N agent
    // boxes + installing opencode + logging bots in (~5 min at n=18), the
    // full-length sessions, and pulling N recordings back (~3 min at n=18).
    // The single-box +120s slack timed out the first 18-bot market run
    // (2026-08-17: sessions finished, but harbor cancelled before the
    // verifier ran). Give split runs 20 min of slack on top of the cap.
    agentTimeout: v.agentTimeout - 120 + 1200,
    environmentDockerfile: v.environmentDockerfile
      .replaceAll("entrypoint-team.sh", "entrypoint-server.sh")
      .replace(
        'ENTRYPOINT ["/entrypoint-server.sh"]',
        `${dashboardDockerLines}\nENTRYPOINT ["/entrypoint-server.sh"]`,
      ),
    environmentFiles: [
      ...(v.environmentFiles ?? []).map((f) =>
        f.src === "entrypoint-team.sh"
          ? { src: "entrypoint-server.sh", dst: "entrypoint-server.sh" }
          : f,
      ),
      ...dashboardFiles,
    ],
    ...SPLIT_SERVER_RESOURCES,
  };
}

const TEAM_FAMILY_VARIANTS: VariantTask[] = [
  // ── Smith-team three-bot cooperative smithing ──
  ...smithTeamVariants(),
  // ── Magic-team three-bot cooperative Magic leveling ──
  ...magicTeamVariants(),
  // ── Crafting-team cooperative MAX-single-account Crafting XP ──
  ...craftingTeamVariants(),
  // ── Market: k miners / k smiths / k alchemists (k=2,4), individual final gold ──
  ...marketVariants(),
  // ── Dragon-team: 10 bots, shared KBD kill count, one covert selfish bot ──
  ...dragonTeamVariants(),
];

const VARIANTS: VariantTask[] = [
  ...SKILL_XP_5M_SMOKE,
  ...SKILL_XP_15M_VARIANTS,
  ...SKILL_XP_30M_VARIANTS,
  // ── Gold accumulation tasks (4 starting conditions × 2 horizons) ──
  ...GOLD_VARIANTS,
  // ── Shield of Arrav two-bot cooperative quest ──
  ...arravVariants(),
  ...TEAM_FAMILY_VARIANTS,
  // ── Split (1 box per agent + 1 server box) siblings of every team task ──
  ...TEAM_FAMILY_VARIANTS.map(deriveSplitVariant),
];

// ── Template generators ──────────────────────────────────────────

function generateVariantTaskToml(v: VariantTask): string {
  const tagsStr = v.tags.map((t) => `"${t}"`).join(", ");

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
# bun-svc = bun under an infra-only process name (see docker/Dockerfile) so an
# agent's killall/pkill of "bun" can't take the MCP server down.
command = "bun-svc"
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
    const testsDir = join(taskDir, "tests");

    console.log(`  tasks/${variant.slug}/`);

    mkdirSync(testsDir, { recursive: true });
    writeFileSync(join(taskDir, "task.toml"), generateVariantTaskToml(variant));
    writeFileSync(join(taskDir, "instruction.md"), variant.taskDescription);
    writeFileSync(join(testsDir, "test.sh"), variant.testSh);
    copyFileSync(
      join(SHARED_DIR, variant.verifier),
      join(testsDir, variant.verifier),
    );
    // Verifiers import './save-parser' (handles save format v6 + v7)
    copyFileSync(
      join(SHARED_DIR, "save-parser.ts"),
      join(testsDir, "save-parser.ts"),
    );

    // Dockerfile for cloud providers — either custom env or
    // a thin FROM layer on the pre-built image.
    const envDir = join(taskDir, "environment");
    mkdirSync(envDir, { recursive: true });
    writeFileSync(
      join(envDir, "Dockerfile"),
      variant.environmentDockerfile ?? `FROM ${DOCKER_IMAGE}\n`,
    );

    // Copy extra files into tests/ (next to the verifier)
    if (variant.testsFiles) {
      for (const file of variant.testsFiles) {
        copyFileSync(join(SHARED_DIR, file.src), join(testsDir, file.dst));
      }
    }

    // Copy extra files into environment/ for Docker build context
    if (variant.environmentFiles) {
      for (const file of variant.environmentFiles) {
        copyFileSync(join(SHARED_DIR, file.src), join(envDir, file.dst));
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
