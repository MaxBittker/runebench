# RuneBench v3 — Benchmark Tasks (Harbor)

Benchmark suite for evaluating AI agents on RuneScape gameplay tasks.
Uses [rs-sdk](https://github.com/MaxBittker/rs-sdk) as the game environment (cloned at Docker build time).

All task directories are **generated** — never edit them directly.
Every agent is **OpenCode-based** (unified `opencode_adapter.py` or a thin
per-provider subclass) so logs and cost tracking are uniform across providers.

## Source of truth

| Path | Purpose |
|------|---------|
| `generate-tasks.ts` | Generates all task directories (16 skills × {15m,30m} + 4 gold conditions × {15m,30m} + arrav-duo-45m + smith/magic/crafting team tasks × {30,45,60}m × n∈{1,3,6} + a 5m smoke task). Gold/arrav/team starting states are **declarative `saveConfig` blocks** here. |
| `shared/save-generator.ts` | Writes binary `.sav` files from `SaveConfig` objects (Items/Locations enums, SAV header/CRC) at task-generation time |
| `shared/check_skill_xp.ts` | XP verifier for single-skill tasks (embeds tracking data) |
| `shared/check_gold.ts` | Gold verifier — reads the save file directly, counts coins in inventory + bank |
| `shared/check_arrav.ts` | Shield of Arrav verifier — per-bot quest varps from save files + completion timing from the watcher |
| `shared/arrav_watcher.ts` | Observes both duo bots; records quest-item milestones + completion timestamps to `/logs/tracking/arrav_tracking.json` |
| `shared/entrypoint-duo.sh` | Container entrypoint for duo tasks (two bot clients + arrav watcher); copied per-task, overrides `/entrypoint.sh` |
| `shared/check_smith_team.ts` | Smith-team verifier — best smithed item by store value, level-gated anti-cheat (see `analysis/smith-team/METHODOLOGY.md`; the gate is NOT disclosed to agents) |
| `shared/smith_team_watcher.ts` | Observes all three team bots: 5s inventory+level samples, item-gain events with level-gate verdicts, chat transcript |
| `shared/smithing-table.json` | Smithable items (id, cost, level req) generated from engine data by `scripts/generate-smithing-table.ts` |
| `shared/entrypoint-team.sh` | Container entrypoint for N-bot team tasks (env-parameterized BOT_NAMES/WATCHER_SCRIPT) |
| `shared/entrypoint-server.sh` | Server-only entrypoint for `-split` team variants (engine + gateway + watcher + live dashboard; no clients) |
| `shared/dashboard.ts` + `dashboard.html` | Live observation dashboard for split runs (chat, inventories, banks, gold timeline) — served from the server box on tunnel port 8790 |
| `shared/agent-box.sh` | Per-agent-sandbox services for split runs (Xvfb + chromium client + ffmpeg), uploaded by the split adapter |
| `agents/opencode_team_adapter.py` | Three concurrent OpenCode sessions of one model for the smith-team task |
| `agents/opencode_split_adapter.py` | Split topology: 1 Modal sandbox per agent + 1 server sandbox (see “Split team topology”) |
| `shared/extract-utils.ts` | Shared utilities for extract scripts |
| `shared/pricing.ts` | Single source of truth for per-model token pricing (used by postprocess + extractors + UI) |
| `shared/skill_tracker.ts` | Standalone skill tracker (single source of truth — copied into Docker image at build time) |
| `scripts/run-common.sh` | Single source of truth for the run harness: `ALL_MODELS`, `ALL_SKILLS`, `ALL_MODEL_LABELS`, `ALL_GOLD_CONDITIONS`, prefix-based credential dispatch, `sandbox_timeout_for_horizon()`, `run_timeout_for_horizon()` |
| `docker/` | Shared Docker image source (pre-built, pushed to GHCR) |

`shared/agent.sav` is the vanilla post-tutorial character (used by skill tasks
and the vanilla gold condition). The old `agent-gold-*.sav` binaries are gone —
those conditions are generated from `saveConfig` blocks; parity with the legacy
binaries was verified by `scripts/validate-saves.ts` before removal.

The game wiki agents read at `/app/wiki` lives in **rs-sdk**, not here — this repo keeps no copy.
The website's copy is the generated `app/wiki-data.js`; refresh it when the image's rs-sdk pin moves:

```bash
bun scripts/build-wiki-data.ts          # reads ../rs-sdk/wiki, stamps the commit into the file
RS_SDK_PATH=/path/to/rs-sdk bun scripts/build-wiki-data.ts
```

## Directory structure

```
RuneBench/
├── scripts/              ← run.sh, run-skills.sh, run-gold.sh, run-arrav.sh, run-common.sh, validate-saves.ts
├── extractors/           ← extract-skill-results.ts, extract-gold-results.ts, extract-arrav-results.ts
├── agents/               ← opencode_adapter.py, opencode_duo_adapter.py, per-provider adapters, install-opencode.sh.j2
├── app/                  ← components for the results website (loaded by index.html)
├── views/                ← graph-skills.html, graph-gold.html (local viewers), model-icons/, skill-icons/
├── shared/               ← verifiers, save-generator, watcher, extract-utils.ts
├── docker/               ← shared Docker image source
├── results/              ← generated result artifacts
├── jobs/                 ← raw harbor job outputs (gitignored)
├── tasks/                ← generated task directories (gitignored)
├── generate-tasks.ts     ← source of truth for task generation
├── index.html            ← results website (GitHub Pages; prerendered by scripts/prerender.ts)
├── dataset.toml          ← Harbor dataset manifest (harbor add / harbor publish)
├── package.json
├── CLAUDE.md
└── .gitignore
```

## Regenerate tasks

```bash
bun generate-tasks.ts
```

Run this before `harbor run`. Generated directories are gitignored.
Gold/arrav `.sav` files are emitted into each task's `environment/` from the
declarative `saveConfig` blocks.

## Running benchmarks

```bash
# Per-skill XP benchmarks
./scripts/run-skills.sh                  # 15m default
./scripts/run-skills.sh --horizon 30m
# (run-skills-15m.sh / run-skills-30m.sh are compatibility shims)

# Gold benchmarks (4 starting conditions × all models)
./scripts/run-gold.sh                    # 15m, all models × 4 conditions
./scripts/run-gold.sh --horizon 30m
./scripts/run-gold.sh -m opus -c smith-alch

# Shield of Arrav duo quest (one model drives BOTH bots; score = time to complete)
./scripts/run-arrav.sh                   # all models
./scripts/run-arrav.sh -m opus47 -k 4

# Ad-hoc single-task run (all models)
./scripts/run.sh -t woodcutting-xp-15m
```

All run scripts source `scripts/run-common.sh` for the model matrix and
credential handling — **add a model there once** and every script picks it up.
Every script supports `--dry-run` to print the `harbor run` commands without
launching.

OpenCode writes cost_usd per step; `scripts/postprocess-costs.ts` backfills
cost_usd from token counts using `shared/pricing.ts` for any runs that lack it.

Each task has an `environment/Dockerfile` that `FROM`s the pre-built GHCR image, so Modal pulls the image with no build step beyond the layer cache.

## Shield of Arrav duo task

`arrav-duo-45m` is a two-player cooperative quest speedrun (the quest
*requires* two players, one per gang). `agents/opencode_duo_adapter.py` runs
two concurrent OpenCode sessions of the **same model** in one sandbox — one
drives bot `agenta` (Phoenix Gang route), one drives `agentb` (Black Arm
route). They coordinate via in-game chat only (the chat CLI; filesystem
coordination is forbidden by the instruction) and exchange items by dropping
them in-game.

- Completion is confirmed from save-file quest varps (145 blackarmgang == 4 /
  146 phoenixgang == 10); precise timing comes from the watcher observing the
  Certificate (obj 769) leaving a bot's inventory at the King Roald handover.
- Reward = `cap_secs − first_completion_secs` (higher = faster; 0 = DNF).
- The task ships its own entrypoint (`shared/entrypoint-duo.sh`) and bigger
  sandbox (4 cpus / 8 GB) via the thin per-task Docker layer — no image
  rebuild needed.
- Logs: `/logs/agent/opencode-agenta.txt` + `opencode-agentb.txt`;
  trajectories: `trajectory.json` (merged) + `trajectory-{agenta,agentb}.json`.

## Split team topology (1 box per agent + 1 server box)

Every team task has a `-split` sibling (e.g. `smith-team-30m-n6-split`) that
replaces the one-big-sandbox layout with N+1 sandboxes:

- **Server box** = the harbor trial sandbox. Boots `shared/entrypoint-server.sh`
  (engine + gateway + watcher only) at a fixed 2 cpus / 6 GB regardless of team
  size. Save files, the watcher, the verifier, and the `/logs` artifact flow
  all stay here, so scoring is identical to the single-box variants.
- **Agent boxes** = one Modal sandbox per bot, spawned by
  `agents/opencode_split_adapter.py` from the same app/image as the trial
  sandbox (default 2 cpus / 4 GB, `--ak agent_box_cpus/agent_box_memory_mb`).
  Each runs `shared/agent-box.sh` (Xvfb + chromium client + ffmpeg) plus one
  OpenCode session, and dials back to the server through Modal encrypted
  tunnels: engine web 8888 → `BOT_URL`, gateway 7780 → `GATEWAY_URL` (the SDK,
  MCP server, and chat CLI all honor the `GATEWAY_URL` env override).

Launch with the team run scripts' `--split` flag, which selects the `-split`
task dir, the split adapter, and adds `--ek tunnel_ports=8888,7780,8790`
(requires the `tunnel_ports` harbor patch — `patches/harbor-local.patch`):

```bash
./scripts/run-smith-team.sh --split -m qwen3 -n 6
./scripts/run-market.sh --split -m qwen3
# 12-bot (4 per role) MIXED-MODEL market: models dealt evenly + randomly
# within each role; the bot→model map lands in the job's agent/bot-models.json
./scripts/run-market.sh --split -H 60m -n 4 --mix grok46,gemini37flash
```

Market sizes: `-n <per_role>` picks `market-<H>m` (2 per role, default) or
`market-<H>m-n<3k>` (`-n 4` → `market-60m-n12`, `-n 6` → `-n18`, `-n 8` → `-n24`;
`MARKET_PER_ROLE_LIST` + the 26-letter `MARKET_BOT_POOL` in `generate-tasks.ts`).
`--mix m1,m2` runs ONE trial with several models — the team/split adapters take
`--ak bot_models=a=<id>,b=<id>,...` (per-bot model, one merged `opencode.json`
with every provider, creds for all of them) and write `bot-models.json` next to
the trajectories. Models whose own adapter subclass carries `_model_options`
(e.g. `gpt56luna-xhigh` → `reasoningEffort=xhigh`) keep them in a mix via
`team_model_options` in `run-common.sh` → `--ak model_options=<id>:k=v[;…]`.

**Live dashboard**: every split run serves a read-only observation dashboard
from the server box (`shared/dashboard.ts` + `dashboard.html`, port 8790) —
live chat transcript, per-bot inventories/banks/skills, and a gold-or-XP
timeline. It reads the watcher's tracking JSON plus the on-disk save files
(bank/inventory views lag live state by up to ~2.5 min for tasks whose watcher
doesn't record live items; the UI shows the save age). The split adapter logs
`LIVE DASHBOARD: <url>` and writes `dashboard-url.txt` into the job's logs
dir; the URL is also in the harbor log at `/tmp/harbor-<job>.log`.

Why: RAM scales per-agent instead of one 20 GB box at n=6, an OOM kills one
agent instead of the whole trial, and team size is no longer bounded by
single-sandbox memory. Caveats: the tunnels are public (obscure-URL) TLS
endpoints with gateway auth off — acceptable for short-lived benchmark runs;
`--split` currently supports only the generic opencode-family adapter (models
needing `_model_options` or claude-code auth want their own subclass); `--solo`
and `--split` are mutually exclusive. Per-bot session logs and recordings are
pulled from the agent boxes into the job's logs dir after the run (session
logs are also mirrored to the server box's `/logs/agent`).

Gotchas learned the hard way (`analysis/SPLIT-MARKET-ISSUES-20260816.md`):
a Modal `Sandbox.create(cmd…)` does **not** replace the image ENTRYPOINT (it
appends args), so agent boxes are spawned with `image.entrypoint([])` —
otherwise every agent box also boots a full engine+gateway+watcher and
starves chromium. Agent boxes run their own PulseAudio null sink so
recordings carry game audio.

## In-sandbox agent CLIs

- `time-left` (`docker/time-left.sh`, on PATH in the image) prints the minutes
  remaining; every OpenCode adapter writes the session deadline to
  `/tmp/task-deadline` right before launching (also on split agent boxes).
- Private messages: `bun sdk/chat.ts <bot> --to <player> "msg"` (rs-sdk
  `042ad988c`+, image ≥ v65). Needs the engine's friend server —
  `EASY_STARTUP=true FRIEND_SERVER=true` are image ENV; without them PMs are
  dropped silently. The market watcher logs outgoing PMs (type 6) with a `to`
  field; dashboard/graph-market render them as `sender → to (pm)`.

## Infra processes run as `bun-svc`

The image ships `/usr/local/bin/bun-svc` — a copy of bun under an
infra-only process name. All entrypoints, watchers, `launch-bot.ts`, and the
MCP server (`.mcp.json` + generated `task.toml`) launch with it, so an
agent's `killall bun` / `pkill -f "bun run"` (very common when they restart
their own scripts) can't kill the game client or their MCP tools. Keep new
infra launch lines on `bun-svc`; the verifier cleanup whitelists `bun-svc*`.

## Extracting results

```bash
bun scripts/postprocess-costs.ts                     # backfill cost_usd on jobs/
bun extractors/extract-skill-results.ts              # 15m (default)
bun extractors/extract-skill-results.ts --horizon 30m
bun extractors/extract-gold-results.ts               # gold: keyed by condition-horizon
bun extractors/extract-arrav-results.ts              # arrav duo: completion times
```

The skill extractor writes three artifacts per horizon dir: `_data.js` (slim summary, no
trajectory/samples — loaded up-front by the website), per-model `<model>.json` (full payloads,
lazy-fetched by `app/model-data.js` when a trajectory is viewed — commit these alongside
`_data.js` for skills-30m), and `_combined.json` (full, gitignored, for local viewers).

## Adding a new task

1. Add a new entry to the `SKILLS` array or modify `generateSkillXpVariants()` in `generate-tasks.ts`
2. Starting state goes in a `saveConfig` block (see `GOLD_CONDITIONS`) — no binary `.sav` blobs
3. If the task needs a new verifier, add it to `shared/`
4. Run `bun generate-tasks.ts`

## Adding a new model

1. Add one `agent|model-id|label` line to `ALL_MODELS` in `scripts/run-common.sh` (+ the label in `ALL_MODEL_LABELS`)
2. If it's a new provider prefix, add a credential case to `configure_model_env`
3. Add pricing to `shared/pricing.ts` and a display label to the extractors

## Local harbor patches

The run scripts depend on two local modifications to the machine-global harbor
install (`sandbox_region` support + bounded artifact transfers in `modal.py`;
`xhigh`/`max` effort enum in `claude_code.py`). They live in site-packages and
are **lost on every `uv tool upgrade harbor`** — re-apply from
`patches/harbor-local.patch` (see `patches/README.md`).

## Docker image

The Docker setup is split into two images to keep Modal pulls fast:

- **Base image** (`rs-agent-benchmark-base:v2`) — Debian, chromium, JRE, ffmpeg, pulseaudio, bun (~1.6GB). Rarely changes.
- **App image** (`rs-agent-benchmark:vXX`) — rs-sdk, workspace deps, Claude CLI, config (~1GB on top of base). Changes per version bump.

All tasks `FROM` the app image. Variant tasks that need different env settings
(or, for the duo task, a different entrypoint + extra save files) use a thin
`FROM` layer on top.

Build and push:
```bash
cd docker

# Base image (only when system deps change — should be rare)
PUSH=1 IMAGE_TAG=v2 ./build.sh --base

# App image (bump tag for each new version)
PUSH=1 IMAGE_TAG=v52 ./build.sh
```

`build.sh` resolves `rs-sdk` `main` to a SHA (`git ls-remote`) and passes it as a cache-bust
build-arg, so the clone layer can't go stale — a plain build always ships current `main`, and the
build hard-fails if the baked SHA doesn't match. The commit is recorded in the image at
`/app/.rs-sdk-commit`, so any run can prove which SDK it used:

```bash
docker run --rm ghcr.io/maxbittker/rs-agent-benchmark:v52 cat /app/.rs-sdk-commit
```

**Pick the next FREE tag** — this image repo is shared with `rs-bench3`, so tags can already exist
above the one this repo pins. Check before building:

```bash
curl -s "https://ghcr.io/token?scope=repository:maxbittker/rs-agent-benchmark:pull&service=ghcr.io" \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])' \
  | xargs -I{} curl -s -H "Authorization: Bearer {}" \
      https://ghcr.io/v2/maxbittker/rs-agent-benchmark/tags/list
```
