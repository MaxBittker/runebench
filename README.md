# runescape-bench

[View results website](https://maxbittker.github.io/runescape-bench/)

Benchmark suite for evaluating AI coding agents on RuneScape gameplay tasks via [rs-sdk](https://github.com/MaxBittker/rs-sdk).

<div align="center">
    <img src="views/hero.png" alt="Average XP per Skill over 30 minutes across models" width="800">
</div>

Agents play the game by writing and executing TypeScript snippets against an emulated game server running at 8x speed. Each agent also gets a folder of markdown files extracted from the game wiki for strategy reference. Agents are scored on their peak XP rate — the best XP/min measured in any 15-second window.

Built for [Harbor](https://harborframework.com/), an open-source framework for running agent benchmarks. Built on [rs-sdk](https://github.com/MaxBittker/rs-sdk) and the [LostCity](https://github.com/LostCityRS/Server) engine/client.

## Tasks

**16 Skill XP tasks (15 min)** — Train a single skill, scored on peak XP rate

**16 Skill XP tasks (30 min)** — Extended versions with time-series tracking

**3 Gold accumulation tasks** (15 min / 30 min / 2 hr) — Maximize total coins using any strategy

All task directories are generated from `generate-tasks.ts` and should not be edited directly.

## Tested Models

Claude Opus 4.6, Claude Opus 4.5, Claude Sonnet 4.6, Claude Sonnet 4.5, Claude Haiku 3.5, Gemini 3 Pro, Gemini 3.1 Pro, Gemini 3 Flash, Codex CLI 5.2, Codex CLI 5.3, GPT-5.4, GLM 5, Kimi K2.5, Qwen3 Coder Next, Qwen3.5 35B

## Quick Start

```bash
bun install
bun generate-tasks.ts
harbor run
```

## Architecture

Each task runs inside a Docker container based on a pre-built image that bundles the rs-sdk game server at 8x speed. The agent connects via an MCP server that exposes game interaction tools. A verifier script checks the final game state to produce a score.

```
Agent (Claude, Gemini, Codex, etc.)
  │
  ├── MCP Server (TypeScript SDK)
  │     └── Game Server (8x speed, headless)
  │
  └── Verifier (checks peak XP rate / gold)
```

## License

MIT
