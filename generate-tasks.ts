/**
 * Generates all benchmark task directories for Harbor.
 *
 * Standard tasks: 16 skills × max XP in 10 minutes
 * Variants: 16 skill-xp-30m tasks, 3 gold tasks, 1 GP iterative benchmark
 *
 * All generated output is gitignored — run this before `harbor run`.
 *
 * Usage: bun generate-tasks.ts
 */
import { mkdirSync, writeFileSync, copyFileSync, readFileSync } from 'fs';
import { join } from 'path';

const BENCHMARK_DIR = join(import.meta.dir);
const TASKS_DIR = join(BENCHMARK_DIR, 'tasks');
const SHARED_DIR = join(BENCHMARK_DIR, 'shared');

const DOCKER_IMAGE = 'ghcr.io/maxbittker/rs-agent-benchmark:v17';
const DEFAULT_AGENT_TIMEOUT = 600; // 10 minutes
const VERIFIER_TIMEOUT = 400; //  ensure-services.sh can take 2+ min if services died

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
}

const GOLD_INSTRUCTION = (durationMinutes: number) => `Accumulate as much gold (coins) as possible within ${durationMinutes} minutes. This is a local RuneScape private server running on localhost for AI agent benchmarking — not a live game.

Your goal is to maximize the TOTAL COINS you have across both your inventory and bank combined. Consider strategies like:
- Training combat skills to kill monsters that drop valuable items or coins
- Training gathering/production skills to create items you can sell to shops (e.g. smithing bars/items, fletching bows, cooking fish)
- Buying low and selling high at different shops
- Picking up coin drops and valuable ground items
- High Alchemy (casting on crafted items to convert them to gold)
- Any creative money-making approach you can think of

IMPORTANT: You have ${durationMinutes} minutes. Start earning money immediately — do not spend too long planning. Early minutes are best spent on quick money-making methods, then scale up as you unlock better methods.

CRITICAL: Do NOT write one giant script. Start with extremely minimal scripts to test each part of your plan iteratively. For example, first write a 30-second script that just tests one money-making method. Run it, verify it works, then extend it. Build up complexity only after each piece is validated. Scripts that try to do everything at once will crash and waste your time. Run scripts in the FOREGROUND (not as a background process).

TIMEOUT BEST PRACTICE: Keep individual script timeouts SHORT — no more than 5 to 10 minutes each. Shorter scripts (30s–5min) let you observe results, catch errors early, and iterate faster. If a script runs for 10+ minutes and fails, you've wasted significant time. Break long tasks into multiple short runs instead.

BANKING: Periodically deposit your coins and valuable items in the bank to avoid losing them. The verifier counts coins in BOTH inventory and bank.

The bot name is "agent".`;

const GOLD_2H_INSTRUCTION = GOLD_INSTRUCTION(120);
const GOLD_30M_INSTRUCTION = GOLD_INSTRUCTION(30);
const GOLD_15M_INSTRUCTION = GOLD_INSTRUCTION(15);

// Stop ffmpeg before verifier runs so the mp4 is finalized and downloadable.
const VERIFIER_CLEANUP = `pkill -f ffmpeg 2>/dev/null || true
sleep 1`;

// Tracker, start-with-tracker.sh, and SERVER=localhost are also in the base image.
// Tasks only need to set SAMPLE_INTERVAL_MS via ENV
const TRACKER_DOCKERFILE = (sampleIntervalMs: number = 60000) => `FROM ${DOCKER_IMAGE}
ENV SAMPLE_INTERVAL_MS=${sampleIntervalMs}

# Fix engine timeouts: at 50ms tick rate the hardcoded 500/1000 tick timeouts
# become 25s/50s instead of the intended 5m/10m. Scale to wall-clock time.
RUN sed -i 's/Environment.NODE_DEBUG_SOCKET ? 60000 : 500;/Environment.NODE_DEBUG_SOCKET ? 60000 : Math.ceil(300_000 \\/ Environment.NODE_TICKRATE);/' /app/server/engine/src/engine/World.ts && \\
    sed -i 's/Environment.NODE_DEBUG_SOCKET ? 60000 : 1000;/Environment.NODE_DEBUG_SOCKET ? 60000 : Math.ceil(600_000 \\/ Environment.NODE_TICKRATE);/' /app/server/engine/src/engine/World.ts
`;

// ── GP iterative benchmark ──────────────────────────────────────

// Base64-encode GP files at generation time (injected into Dockerfile)
const gpLoopInstructionB64 = Buffer.from(
  readFileSync(join(SHARED_DIR, 'gp_loop_instruction.md'), 'utf-8')
).toString('base64');

const generateGpSavesB64 = Buffer.from(
  readFileSync(join(SHARED_DIR, 'generate_gp_saves.ts'), 'utf-8')
).toString('base64');

const checkGpB64 = Buffer.from(
  readFileSync(join(SHARED_DIR, 'check_gp.ts'), 'utf-8')
).toString('base64');

const gpFreshStartB64 = Buffer.from(
  readFileSync(join(SHARED_DIR, 'gp_fresh_start.ts'), 'utf-8')
).toString('base64');

// Script run at Docker build time to create DB accounts for all GP bots.
// Must run AFTER sqlite:migrate so the account table exists.
// Placed in /app/server/engine/ so bun resolves bcrypt from engine/node_modules.
const gpCreateAccountsScript = `import { Database } from 'bun:sqlite';
import bcrypt from 'bcrypt';
const db = new Database('/app/server/engine/db.sqlite');
const hash = bcrypt.hashSync('test', 10);
const now = new Date().toISOString();
const bots = ['agent','l1a1','l1a2','l2a1','l2a2','l3a1','l3a2','l4a1','l4a2','l5a1','l5a2'];
const stmt = db.prepare('INSERT OR IGNORE INTO account (username, password, registration_ip, registration_date) VALUES (?, ?, ?, ?)');
for (const name of bots) stmt.run(name, hash, '127.0.0.1', now);
console.log('[DB] Created accounts:', bots.join(', '));
db.close();
`;
const gpCreateAccountsB64 = Buffer.from(gpCreateAccountsScript).toString('base64');

const GP_INSTRUCTION = `You are running a 5-loop iterative GP-earning benchmark. Each loop, you spawn a sub-agent that writes ONE money-making script and runs it on 2 bots sequentially.

**No setup needed.** Bots auto-connect on first \\\`execute_code\\\` call (takes ~30s per bot for browser launch + tutorial skip). Do NOT launch browsers manually.

## Loop Execution

Run 5 loops sequentially. For each loop, spawn a fresh sub-agent with this prompt:

"Read these files to understand your task, then do it:
- \\\`/app/gp_loop_instruction.md\\\` — your instructions
- \\\`/app/CLAUDE.md\\\` — SDK and bot API reference
- \\\`/app/learnings.md\\\` — what previous agents learned (empty on loop 1)

Do not finish until you have updated \\\`/app/learnings.md\\\` with what you learned."

Each sub-agent must start with fresh context — no memory of previous loops. Wait for each to complete before starting the next. If one fails, continue to the next loop.

**Each loop should take at most 60 minutes.** If a sub-agent is taking longer, something is wrong.
`;

const GP_DOCKERFILE = () => `FROM ${DOCKER_IMAGE}

# Fix engine timeouts: at 50ms tick rate the hardcoded 500/1000 tick timeouts
# become 25s/50s instead of the intended 5m/10m. Scale to wall-clock time.
RUN sed -i 's/Environment.NODE_DEBUG_SOCKET ? 60000 : 500;/Environment.NODE_DEBUG_SOCKET ? 60000 : Math.ceil(300_000 \\/ Environment.NODE_TICKRATE);/' /app/server/engine/src/engine/World.ts && \\
    sed -i 's/Environment.NODE_DEBUG_SOCKET ? 60000 : 1000;/Environment.NODE_DEBUG_SOCKET ? 60000 : Math.ceil(600_000 \\/ Environment.NODE_TICKRATE);/' /app/server/engine/src/engine/World.ts

# Replace xdg-open with a wrapper that uses launch-bot.ts (Puppeteer).
# The SDK's autoLaunchBrowser calls xdg-open on Linux, which doesn't
# properly create a game client session in Docker. This wrapper extracts
# the bot name from the URL and spawns launch-bot.ts instead.
RUN mv /usr/bin/xdg-open /usr/bin/xdg-open.real 2>/dev/null || true && \\
    printf '#!/bin/bash\\nBOT_NAME=\$(echo "\$1" | sed -n "s/.*[?&]bot=\\\\([^&]*\\\\).*/\\\\1/p")\\nmkdir -p /logs\\ncd /app/server/gateway && BOT_NAME="\$BOT_NAME" nohup bun run launch-bot.ts > /logs/\${BOT_NAME:-unknown}-launch.log 2>&1 &\\n' > /usr/bin/xdg-open && \\
    chmod +x /usr/bin/xdg-open

# Create 10 bot directories (2 bots x 5 loops) with unique credentials
# Bot names: l{loop}a{bot} — e.g. l1a1, l1a2
RUN for loop in \$(seq 1 5); do \\
  for bot in \$(seq 1 2); do \\
    name="l\${loop}a\${bot}"; \\
    mkdir -p bots/\$name && \\
    printf 'BOT_USERNAME=%s\\nPASSWORD=test\\nSERVER=localhost\\nSHOW_CHAT=false\\n' "\$name" > bots/\$name/bot.env; \\
  done; \\
done

# Inject loop instruction, save generator, verifier, and fresh-start utility (base64-encoded)
RUN mkdir -p /app/benchmark/shared && \\
    echo '${gpLoopInstructionB64}' | base64 -d > /app/gp_loop_instruction.md && \\
    echo '${generateGpSavesB64}' | base64 -d > /app/benchmark/shared/generate_gp_saves.ts && \\
    echo '${checkGpB64}' | base64 -d > /app/benchmark/shared/check_gp.ts && \\
    echo '${gpFreshStartB64}' | base64 -d > /app/benchmark/shared/gp_fresh_start.ts

# Create empty learnings file for loop 1
RUN touch /app/learnings.md

# Generate 10 save files with level 50 skills, starting items, and equipment
RUN cd /app && bun run benchmark/shared/generate_gp_saves.ts

# Back up build-time saves so we can restore them at runtime with a simple cp
# (avoids depending on bun at container startup).
RUN mkdir -p /app/saves-backup && \\
    cp /app/server/engine/data/players/main/*.sav /app/saves-backup/ && \\
    ls -la /app/saves-backup/

# Initialize SQLite database and create bot accounts.
# Without this, bots log in as new characters on Tutorial Island instead of
# loading the pre-generated level-50 save files.
RUN echo '${gpCreateAccountsB64}' | base64 -d > /app/server/engine/create_gp_accounts.ts && \\
    cd /app/server/engine && bun run sqlite:migrate && bun create_gp_accounts.ts

# Back up the SQLite database too (accounts)
RUN cp /app/server/engine/db.sqlite /app/saves-backup/db.sqlite

# Replace Docker ENTRYPOINT with a keep-alive — Harbor runs both ENTRYPOINT
# and /start-services.sh, causing port conflicts when both start the engine.
# This entrypoint just keeps the container alive while start-services.sh
# (called by Harbor) handles all service startup.
RUN printf '#!/bin/bash\\nexec tail -f /dev/null\\n' > /entrypoint.sh && chmod +x /entrypoint.sh

# Wrap /start-services.sh to restore saves BEFORE the engine starts.
# Includes diagnostics to debug any startup issues.
RUN mv /start-services.sh /start-services-base.sh && \\
    cat > /start-services.sh << 'WRAPPER_EOF'
#!/bin/bash
LOG=/tmp/savegen-diag.log
exec > >(tee -a "$LOG") 2>&1
echo "=== start-services wrapper $(date) ==="

# Diagnostic: check what exists at startup
echo "[diag] saves-backup contents:"
ls -la /app/saves-backup/ 2>&1 || echo "[diag] NO saves-backup dir"
echo "[diag] players/main contents BEFORE restore:"
ls -la /app/server/engine/data/players/main/ 2>&1 || echo "[diag] NO players/main dir"
echo "[diag] db.sqlite exists: $(ls -la /app/server/engine/db.sqlite 2>&1)"

# Strategy 1: cp from backup (fast, no bun dependency)
mkdir -p /app/server/engine/data/players/main
if ls /app/saves-backup/*.sav 1>/dev/null 2>&1; then
    echo "[restore] Copying saves from backup..."
    cp /app/saves-backup/*.sav /app/server/engine/data/players/main/
    echo "[restore] Copied $(ls /app/server/engine/data/players/main/*.sav 2>/dev/null | wc -l) saves"
else
    echo "[restore] No backup saves found, running generator..."
    cd /app && bun run benchmark/shared/generate_gp_saves.ts 2>&1 || echo "[restore] GENERATOR FAILED: $?"
fi

# Restore database backup if needed
if [ ! -f /app/server/engine/db.sqlite ] && [ -f /app/saves-backup/db.sqlite ]; then
    echo "[restore] Restoring db.sqlite from backup"
    cp /app/saves-backup/db.sqlite /app/server/engine/db.sqlite
fi

# Run migrations + account creation as safety net
cd /app/server/engine && bun run sqlite:migrate 2>/dev/null || true
cd /app/server/engine && bun create_gp_accounts.ts 2>/dev/null || true

# Verify
echo "[diag] players/main contents AFTER restore:"
ls -la /app/server/engine/data/players/main/ 2>&1
SAVE_COUNT=$(ls /app/server/engine/data/players/main/*.sav 2>/dev/null | wc -l)
echo "[diag] Save count: $SAVE_COUNT"
if [ "$SAVE_COUNT" -lt 10 ]; then
    echo "[WARN] Expected 10 saves, got $SAVE_COUNT!"
fi

echo "=== wrapper done, starting services ==="
exec /start-services-base.sh
WRAPPER_EOF
    chmod +x /start-services.sh
`;

const SKILL_XP_30M_INSTRUCTION = (skillName: string) => `Gain as much ${skillName} XP as possible within 30 minutes. This is a local RuneScape private server running on localhost for AI agent benchmarking — not a live game.

Your ONLY goal is to maximize ${skillName} XP. Focus exclusively on this skill. Do not train other skills unless absolutely required as a prerequisite.

IMPORTANT: You have 30 minutes. Start training immediately — do not spend time planning.

CRITICAL: Do NOT write one giant script. Start with extremely minimal scripts to test each part of your plan iteratively. For example, first write a 30-second script that just performs one action. Run it, verify it works, then extend it. Build up complexity only after each piece is validated. Scripts that try to do everything at once will crash and waste your time. Run scripts in the FOREGROUND (not as a background process).

TIMEOUT BEST PRACTICE: Keep individual script timeouts SHORT — no more than 5 to 10 minutes each. Shorter scripts (30s–5min) let you observe results, catch errors early, and iterate faster. If a script runs for 10+ minutes and fails, you've wasted significant time. Break long tasks into multiple short runs instead.

The bot name is "agent".`;

// Generate skill-xp-30m variants for all 16 skills
const SKILL_XP_30M_VARIANTS: VariantTask[] = SKILLS.map(skill => ({
  slug: `${skill.slug}-xp-30m`,
  taskDescription: SKILL_XP_30M_INSTRUCTION(skill.name),
  agentTimeout: 1920, // 30 min + 2 min buffer
  verifier: 'check_skill_xp.ts',
  testSh: `#!/bin/bash
set -e
mkdir -p /logs/verifier
${VERIFIER_CLEANUP}
/ensure-services.sh
export SKILL_NAME="${skill.name}"
cd /app && bun run /tests/check_skill_xp.ts
`,
  tags: ['game', 'runescape', 'automation', 'mcp', 'benchmark', 'skill-xp-30m'],
  useTracker: true,
  environmentDockerfile: TRACKER_DOCKERFILE(30000),
}));

const VARIANTS: VariantTask[] = [
  ...SKILL_XP_30M_VARIANTS,
  // ── Gold accumulation tasks ─────────────────────────────────────
  {
    slug: 'gold-15m',
    taskDescription: GOLD_15M_INSTRUCTION,
    agentTimeout: 900 + 120, // 15 min + 2 min buffer
    verifier: 'check_gold.ts',
    testSh: `#!/bin/bash
set -e
mkdir -p /logs/verifier
${VERIFIER_CLEANUP}
cd /app && bun run /tests/check_gold.ts
`,
    tags: ['game', 'runescape', 'automation', 'mcp', 'benchmark', 'gold'],
    useTracker: true,
    environmentDockerfile: TRACKER_DOCKERFILE(30000),
  },
  {
    slug: 'gold-30m',
    taskDescription: GOLD_30M_INSTRUCTION,
    agentTimeout: 1800 + 120, // 30 min + 2 min buffer
    verifier: 'check_gold.ts',
    testSh: `#!/bin/bash
set -e
mkdir -p /logs/verifier
${VERIFIER_CLEANUP}
cd /app && bun run /tests/check_gold.ts
`,
    tags: ['game', 'runescape', 'automation', 'mcp', 'benchmark', 'gold'],
    useTracker: true,
    environmentDockerfile: TRACKER_DOCKERFILE(30000),
  },
  {
    slug: 'gold-2h',
    taskDescription: GOLD_2H_INSTRUCTION,
    agentTimeout: 7200 + 180, // 2 hr + 3 min buffer
    verifier: 'check_gold.ts',
    testSh: `#!/bin/bash
set -e
mkdir -p /logs/verifier
${VERIFIER_CLEANUP}
cd /app && bun run /tests/check_gold.ts
`,
    tags: ['game', 'runescape', 'automation', 'mcp', 'benchmark', 'gold'],
    useTracker: true,
    environmentDockerfile: TRACKER_DOCKERFILE(60000),
  },
  // ── GP iterative benchmark (5 loops × 5 bots) ─────────────────
  {
    slug: 'gp-10k-ticks',
    taskDescription: GP_INSTRUCTION,
    agentTimeout: 21600, // 6 hours (5 loops × 60 min + buffer)
    verifier: 'check_gp.ts',
    testSh: `#!/bin/bash
set -e
mkdir -p /logs/verifier
${VERIFIER_CLEANUP}
/ensure-services.sh
cd /app && bun run /tests/check_gp.ts
`,
    tags: ['game', 'runescape', 'automation', 'mcp', 'benchmark', 'gp'],
    environmentDockerfile: GP_DOCKERFILE(),
  },
];

// ── Template generators ──────────────────────────────────────────

function generateSkillTaskToml(): string {
  return `version = "1.0"

[metadata]
author_name = "Sean Lee"
difficulty = "medium"
category = "agent"
tags = ["game", "runescape", "automation", "mcp", "benchmark", "xp-grind"]

[verifier]
timeout_sec = ${VERIFIER_TIMEOUT}.0

[agent]
timeout_sec = ${DEFAULT_AGENT_TIMEOUT}.0

[environment]
cpus = 2
memory_mb = 4096
storage_mb = 10240
allow_internet = true

[[environment.mcp_servers]]
name = "rs-agent"
transport = "stdio"
command = "bash"
args = ["-c", "/start-services.sh && cd /app && bun run mcp/server.ts"]
`;
}

function generateVariantTaskToml(v: VariantTask): string {
  const tagsStr = v.tags.map(t => `"${t}"`).join(', ');

  // Tracker is started by entrypoint.sh / start-services.sh (infrastructure concern),
  // so all tasks use the same MCP command regardless of useTracker flag.
  const mcpCommand = '/start-services.sh && cd /app && bun run mcp/server.ts';

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
cpus = 2
memory_mb = 4096
storage_mb = 10240
allow_internet = true

[[environment.mcp_servers]]
name = "rs-agent"
transport = "stdio"
command = "bash"
args = ["-c", "${mcpCommand}"]
`;
}

function generateTaskDescription(skill: SkillDef): string {
  return `Gain as much ${skill.name} XP as possible within the time limit. The bot name is "agent".`;
}

function generateTestSh(skill: SkillDef): string {
  return `#!/bin/bash
set -e
mkdir -p /logs/verifier
${VERIFIER_CLEANUP}
/ensure-services.sh
export SKILL_NAME="${skill.name}"
cd /app && bun run /tests/check_xp.ts
`;
}

// ── Main ─────────────────────────────────────────────────────────

console.log(`Generating ${SKILLS.length} standard + ${VARIANTS.length} variant benchmark tasks...`);

mkdirSync(TASKS_DIR, { recursive: true });

// Standard XP-grind tasks (all share identical task.toml)
const skillToml = generateSkillTaskToml();

for (const skill of SKILLS) {
  const taskDir = join(TASKS_DIR, `${skill.slug}-xp-10m`);
  const testsDir = join(taskDir, 'tests');

  console.log(`  tasks/${skill.slug}-xp-10m/ (${skill.name})`);

  mkdirSync(testsDir, { recursive: true });

  // Dockerfile for cloud providers that don't support docker_image.
  // Just pulls the pre-built image — no additional build steps needed.
  const envDir = join(taskDir, 'environment');
  mkdirSync(envDir, { recursive: true });
  writeFileSync(join(envDir, 'Dockerfile'), `FROM ${DOCKER_IMAGE}\n`);

  writeFileSync(join(taskDir, 'task.toml'), skillToml);
  writeFileSync(join(taskDir, 'instruction.md'), generateTaskDescription(skill));
  writeFileSync(join(testsDir, 'test.sh'), generateTestSh(skill));
  copyFileSync(join(SHARED_DIR, 'check_xp.ts'), join(testsDir, 'check_xp.ts'));
}

// Variant tasks
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

  // Dockerfile for cloud providers — either custom env or
  // a thin FROM layer on the pre-built image.
  const envDir = join(taskDir, 'environment');
  mkdirSync(envDir, { recursive: true });
  writeFileSync(
    join(envDir, 'Dockerfile'),
    variant.environmentDockerfile ?? `FROM ${DOCKER_IMAGE}\n`,
  );

  // Copy extra files into environment/ for Docker build context
  if (variant.environmentFiles) {
    for (const file of variant.environmentFiles) {
      copyFileSync(
        join(SHARED_DIR, file.src),
        join(envDir, file.dst),
      );
    }
  }

}

console.log(`\nDone! Generated ${SKILLS.length + VARIANTS.length} task directories.`);
console.log(`\nTo build the shared Docker image:`);
console.log(`  cd docker && ./build.sh`);
