# RuneBench — Benchmark Tasks (Harbor)

Benchmark suite for evaluating AI agents on RuneScape gameplay tasks.
Uses [rs-sdk](https://github.com/MaxBittker/rs-sdk) as the game environment (cloned at Docker build time).

All task directories are **generated** — never edit them directly.

## Source of truth

| Path | Purpose |
|------|---------|
| `generate-tasks.ts` | Generates all task directories (16 skills × 10m + 16 skills × 30m + 3 gold) |
| `shared/check_skill_xp.ts` | XP verifier for single-skill tasks (embeds tracking data) |
| `shared/extract-utils.ts` | Shared utilities for extract scripts |
| `shared/skill_tracker.ts` | Standalone skill tracker (single source of truth — copied into Docker image at build time) |
| `docker/` | Shared Docker image source (pre-built, pushed to GHCR) |

## Directory structure

```
RuneBench/
├── scripts/              ← run.sh, run-skills-10m.sh, run-skills-30m.sh, run-common.sh
├── extractors/           ← extract-skill-results.ts, extract-gold-results.ts
├── agents/               ← kimi_adapter.py, qwen3_adapter.py, opencode_adapter.py, install-opencode.sh.j2
├── views/                ← graph-skills.html, graph-gold.html, model-icons/, skill-icons/
├── shared/               ← verifiers + extract-utils.ts
├── docker/               ← shared Docker image source
├── results/              ← generated result artifacts
├── tasks/                ← generated task directories
├── generate-tasks.ts     ← source of truth for task generation
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
# 10m per-skill XP benchmarks (all 16 skills × all models)
./scripts/run-skills-10m.sh

# 30m per-skill XP benchmarks (all 16 skills × all models)
./scripts/run-skills-30m.sh

# Ad-hoc single-task run (all models)
./scripts/run.sh -t woodcutting-xp-10m
```

Each task has an `environment/Dockerfile` that `FROM`s the pre-built GHCR image, so Modal pulls the image with no build step beyond the layer cache.

## Extracting results

```bash
bun extractors/extract-skill-results.ts --horizon 10m
bun extractors/extract-skill-results.ts              # 30m (default)
bun extractors/extract-gold-results.ts
```

## Adding a new task

1. Add a new entry to the `SKILLS` array or modify `generateSkillXpVariants()` in `generate-tasks.ts`
2. If the task needs a new verifier, add it to `shared/`
3. Run `bun generate-tasks.ts`

## Docker image

The Docker setup is split into two images to keep Modal pulls fast:

- **Base image** (`rs-agent-benchmark-base:v1`) — Debian, chromium, JRE, ffmpeg, bun (~1.6GB). Rarely changes.
- **App image** (`rs-agent-benchmark:vXX`) — rs-sdk, workspace deps, Claude CLI, config (~1GB on top of base). Changes per version bump.

All tasks `FROM` the app image. Variant tasks that need different env settings use a thin `FROM` layer on top.

Build and push:
```bash
cd docker

# Base image (only when system deps change — should be rare)
PUSH=1 IMAGE_TAG=v1 ./build.sh --base

# App image (bump tag for each new version)
PUSH=1 IMAGE_TAG=v26 ./build.sh
```
