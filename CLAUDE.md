# RuneBench — Benchmark Tasks (Harbor)

Benchmark suite for evaluating AI agents on RuneScape gameplay tasks.
Uses [rs-sdk](https://github.com/MaxBittker/rs-sdk) as the game environment (cloned at Docker build time).

All task directories are **generated** — never edit them directly.

## Source of truth

| Path | Purpose |
|------|---------|
| `generate-tasks.ts` | Generates all task directories (16 skills × {15m,30m} + 4 gold conditions × {15m,30m} + a 5m smoke task) |
| `shared/check_skill_xp.ts` | XP verifier for single-skill tasks (embeds tracking data) |
| `shared/check_gold.ts` | Gold verifier — reads the save file directly, counts coins in inventory + bank |
| `shared/extract-utils.ts` | Shared utilities for extract scripts |
| `shared/pricing.ts` | Single source of truth for per-model token pricing (used by postprocess + extractors + UI) |
| `shared/skill_tracker.ts` | Standalone skill tracker (single source of truth — copied into Docker image at build time) |
| `shared/agent-gold-{vanilla,fish,fletch-alch,smith-alch}.sav` | Starting save files for the four gold-task conditions |
| `docker/` | Shared Docker image source (pre-built, pushed to GHCR) |

The game wiki agents read at `/app/wiki` lives in **rs-sdk**, not here — this repo keeps no copy.
The website's copy is the generated `app/wiki-data.js`; refresh it when the image's rs-sdk pin moves:

```bash
bun scripts/build-wiki-data.ts          # reads ../rs-sdk/wiki, stamps the commit into the file
RS_SDK_PATH=/path/to/rs-sdk bun scripts/build-wiki-data.ts
```

## Directory structure

```
RuneBench/
├── scripts/              ← run.sh, run-skills-15m.sh, run-skills-30m.sh, run-gold.sh, run-common.sh
├── extractors/           ← extract-skill-results.ts, extract-gold-results.ts
├── agents/               ← opencode_adapter.py, per-provider adapters, install-opencode.sh.j2
├── app/                  ← components for the results website (loaded by index.html)
├── views/                ← graph-skills.html, graph-gold.html (local viewers), model-icons/, skill-icons/
├── shared/               ← verifiers + extract-utils.ts
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

## Running benchmarks

```bash
# Per-skill XP benchmarks
./scripts/run-skills-15m.sh
./scripts/run-skills-30m.sh

# Gold benchmarks (4 starting conditions × all models, unified opencode agent)
./scripts/run-gold.sh                    # 15m, all models × 4 conditions
./scripts/run-gold.sh --horizon 30m
./scripts/run-gold.sh -m opus -c smith-alch

# Ad-hoc single-task run (all models)
./scripts/run.sh -t woodcutting-xp-15m
```

Gold tasks use the unified OpenCode adapter (`agents/opencode_adapter.py`) for every
provider so logs and cost tracking are uniform. OpenCode writes cost_usd per step;
for claude-code/codex/gemini-cli skill runs, `scripts/postprocess-costs.ts` backfills
cost_usd from token counts using `shared/pricing.ts`.

Each task has an `environment/Dockerfile` that `FROM`s the pre-built GHCR image, so Modal pulls the image with no build step beyond the layer cache.

## Extracting results

```bash
bun scripts/postprocess-costs.ts                     # backfill cost_usd on jobs/
bun extractors/extract-skill-results.ts              # 15m (default)
bun extractors/extract-skill-results.ts --horizon 30m
bun extractors/extract-gold-results.ts               # gold: keyed by condition-horizon
```

## Adding a new task

1. Add a new entry to the `SKILLS` array or modify `generateSkillXpVariants()` in `generate-tasks.ts`
2. If the task needs a new verifier, add it to `shared/`
3. Run `bun generate-tasks.ts`

## Docker image

The Docker setup is split into two images to keep Modal pulls fast:

- **Base image** (`rs-agent-benchmark-base:v2`) — Debian, chromium, JRE, ffmpeg, pulseaudio, bun (~1.6GB). Rarely changes.
- **App image** (`rs-agent-benchmark:vXX`) — rs-sdk, workspace deps, Claude CLI, config (~1GB on top of base). Changes per version bump.

All tasks `FROM` the app image. Variant tasks that need different env settings use a thin `FROM` layer on top.

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
