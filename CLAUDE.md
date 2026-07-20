# RuneBench v3 — Benchmark Tasks (Harbor)

Benchmark suite for evaluating AI agents on RuneScape gameplay tasks.
Uses [rs-sdk](https://github.com/MaxBittker/rs-sdk) as the game environment (cloned at Docker build time).

All task directories are **generated** — never edit them directly.
Every agent is **OpenCode-based** (unified `opencode_adapter.py` or a thin
per-provider subclass) so logs and cost tracking are uniform across providers.

## Source of truth

| Path | Purpose |
|------|---------|
| `generate-tasks.ts` | Generates all task directories (16 skills × {15m,30m} + 4 gold conditions × {15m,30m} + arrav-duo-30m + smith-team-30m + a 5m smoke task). Gold/arrav/smith-team starting states are **declarative `saveConfig` blocks** here. |
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
| `agents/opencode_team_adapter.py` | Three concurrent OpenCode sessions of one model for the smith-team task |
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

`arrav-duo-30m` is a two-player cooperative quest speedrun (the quest
*requires* two players, one per gang). `agents/opencode_duo_adapter.py` runs
two concurrent OpenCode sessions of the **same model** in one sandbox — one
drives bot `agenta` (Phoenix Gang route), one drives `agentb` (Black Arm
route). They coordinate via the shared filesystem (`/tmp/team/`) and exchange
items by dropping them in-game.

- Completion is confirmed from save-file quest varps (145 blackarmgang == 4 /
  146 phoenixgang == 10); precise timing comes from the watcher observing the
  Certificate (obj 769) leaving a bot's inventory at the King Roald handover.
- Reward = `cap_secs − first_completion_secs` (higher = faster; 0 = DNF).
- The task ships its own entrypoint (`shared/entrypoint-duo.sh`) and bigger
  sandbox (4 cpus / 8 GB) via the thin per-task Docker layer — no image
  rebuild needed.
- Logs: `/logs/agent/opencode-agenta.txt` + `opencode-agentb.txt`;
  trajectories: `trajectory.json` (merged) + `trajectory-{agenta,agentb}.json`.

## Extracting results

```bash
bun scripts/postprocess-costs.ts                     # backfill cost_usd on jobs/
bun extractors/extract-skill-results.ts              # 15m (default)
bun extractors/extract-skill-results.ts --horizon 30m
bun extractors/extract-gold-results.ts               # gold: keyed by condition-horizon
bun extractors/extract-arrav-results.ts              # arrav duo: completion times
```

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
