ARG BASE_IMAGE=ghcr.io/maxbittker/rs-agent-benchmark-base:v2
FROM ${BASE_IMAGE}

# 8x faster game simulation (50ms ticks vs default 420ms)
ENV NODE_TICKRATE=50

# Bot-friendly engine tuning (rs-sdk config, plumbed via NODE_* env vars):
#   maxMessageLength — allow long chat messages so bots can coordinate freely
#   objRevealTicks 0 — dropped items are immediately visible to the other bot
#   objDespawnScale 20000 — ground items linger ~200x longer so hand-offs don't
#     despawn before the other bot picks them up
ENV NODE_MAX_MESSAGE_LENGTH=500
ENV NODE_OBJ_REVEAL_TICKS=0
ENV NODE_OBJ_DESPAWN_SCALE=20000

# Clone rs-sdk (shallow clone, then delete .git to save ~50MB)
ARG RS_SDK_REPO=https://github.com/MaxBittker/rs-sdk.git
ARG RS_SDK_REF=main
# CACHE-BUST — must change for the clone below to re-run. Nothing else in this
# layer varies between builds, so without this Docker reuses the cached clone and
# a freshly-tagged image silently ships the OLD rs-sdk. build.sh resolves the live
# ref to a SHA (git ls-remote) and passes it, so a plain `./build.sh` is always
# fresh. Note $RS_SDK_REF can't itself be a SHA: `clone --depth 1 --branch`
# only accepts branch/tag names.
ARG RS_SDK_COMMIT=unknown
RUN git clone --depth 1 --branch $RS_SDK_REF $RS_SDK_REPO /app \
    && git -C /app rev-parse HEAD > /app/.rs-sdk-commit \
    && rm -rf /app/.git \
    && echo "baked rs-sdk $RS_SDK_REF = $(cat /app/.rs-sdk-commit) (requested: $RS_SDK_COMMIT)" \
    && if [ "$RS_SDK_COMMIT" != "unknown" ] && [ "$(cat /app/.rs-sdk-commit)" != "$RS_SDK_COMMIT" ]; then \
         echo "FATAL: baked SDK $(cat /app/.rs-sdk-commit) != requested $RS_SDK_COMMIT (stale cache or ref moved mid-build)" >&2; \
         exit 1; \
       fi
WORKDIR /app

# Install all workspace dependencies.
# NOTE: rs-sdk folded the sdk/ and mcp/ sub-packages into the ROOT package.json
# (c8bf7c1 removed sdk/package.json, 6db0cf3 removed mcp/package.json + mcp/bun.lock,
# and moved @modelcontextprotocol/sdk into the root deps). So the root `bun install`
# below now covers both; the old `cd sdk && bun install` / `cd /app/mcp && bun install`
# steps have no manifest to read and are gone. If a future rs-sdk re-splits them,
# these need to come back.
RUN bun install
RUN cd server/engine && bun install
RUN cd server/gateway && bun install
RUN cd server/webclient && bun install && bun run build
RUN cp -r server/webclient/out/bot server/engine/public/bot

# Remove scripts/ and sdk/test/ — benchmark agents waste budget reading/running these
RUN rm -rf /app/scripts /app/sdk/test

# Replace upstream instruction files with our simplified benchmark version
RUN rm -f /app/agents.md /app/claude.md /app/GEMINI.md
COPY agents.md /app/agents.md
# claude-code only auto-loads CLAUDE.md/AGENTS.md (not lowercase agents.md), so the
# guidance — including "read and grep the learnings/ and wiki/ folders" — never reached
# the model. Surface it by giving claude-code the filename it loads.
RUN cp /app/agents.md /app/CLAUDE.md

# Pre-pack the game cache using the engine's own pack step.
#
# DO NOT go back to "boot the engine, kill it N seconds after 'World ready'". rs-sdk's
# PackAll runs in a WORKER THREAD, so the engine logs "World ready" while packing is
# still in flight — that approach silently shipped a TRUNCATED cache as soon as rs-sdk
# 9f113a42 added packOnDemandZip (~18s of extra zipping; the old grace period was 2s).
# A cache missing the version list (archive 0 file 5) makes /versionlist0 return null
# (src/web/pages/client.ts does Buffer.from(cache.read(0,5)!) -> TypeError), so the bot
# client never logs in, `status` stays "dead", and EVERY run scores zero — while the
# build still reports success because the old step ended in `; true`.
RUN cd server/engine && bun run build

# Boot the engine once so any remaining runtime data files are generated, then ASSERT
# that the client cache endpoints actually serve. This guard turns an incomplete pack
# into a failed build instead of a silent night of all-zero benchmark runs.
# NOTE on shell mechanics: background the engine with plain `&` in THIS shell (not a
# `( ... &)` subshell) so `jobs -p` can find and kill it below. A detached subshell
# hides the engine from job control and the RUN step hangs forever waiting on it.
RUN cd server/engine && \
    bun run src/app.ts > /tmp/engine.log 2>&1 & \
    for i in $(seq 1 300); do \
        grep -q "World ready" /tmp/engine.log 2>/dev/null && break; \
        sleep 1; \
    done; \
    ok=0; \
    for i in $(seq 1 60); do \
        if curl -sf -o /dev/null http://localhost:8888/versionlist0; then ok=1; break; fi; \
        sleep 1; \
    done; \
    kill $(jobs -p) 2>/dev/null; \
    if [ "$ok" != "1" ]; then \
        echo "FATAL: /versionlist0 not served — game cache pack is incomplete" >&2; \
        tail -30 /tmp/engine.log >&2; \
        exit 1; \
    fi; \
    echo "cache pack verified: /versionlist0 serves OK"; \
    rm -f /tmp/engine.log

# Create bot credentials (local server, no remote)
RUN mkdir -p bots/agent
COPY bot.env bots/agent/bot.env

# Pre-install Claude Code CLI so Harbor doesn't need to curl it at agent start.
RUN curl -fsSL https://claude.ai/install.sh | bash \
    && ln -s /root/.local/share/claude/versions/* /usr/local/bin/claude

# Copy entrypoint and helper scripts
COPY entrypoint.sh /entrypoint.sh
COPY launch-bot.ts /app/server/gateway/launch-bot.ts
RUN chmod +x /entrypoint.sh

# SAMPLE_INTERVAL_MS can be overridden per task via ENV in the thin FROM layer.
COPY skill_tracker.ts /app/benchmark/shared/skill_tracker.ts
COPY check_xp_rate.ts /app/benchmark/shared/check_xp_rate.ts
COPY save-parser.ts /app/benchmark/shared/save-parser.ts

# Ensure bot.env has SERVER=localhost so scripts connect to the local gateway
RUN echo 'SERVER=localhost' >> /app/bots/agent/bot.env

# MCP server deps come from the ROOT bun install now — rs-sdk 6db0cf3 folded the
# mcp sub-package into the root package.json (@modelcontextprotocol/sdk lives there),
# deleting mcp/package.json + mcp/bun.lock. mcp/server.ts itself is still at /app/mcp.
# Guard the path so a future rs-sdk move fails loudly here instead of at agent runtime.
RUN test -f /app/mcp/server.ts || (echo "FATAL: /app/mcp/server.ts missing — rs-sdk layout moved" >&2; exit 1)
RUN bun -e 'require.resolve("@modelcontextprotocol/sdk/server/mcp.js")' \
    || (echo "FATAL: @modelcontextprotocol/sdk not installed by root bun install" >&2; exit 1)

# Write .mcp.json so Claude Code can use the MCP server
RUN echo '{"mcpServers":{"rs-agent":{"command":"bun","args":["run","/app/mcp/server.ts"]}}}' > /app/.mcp.json

# GEMINI.md: heredoc syntax is rejected by gemini-cli's bash parser,
# so create a Gemini-specific file with writefile guidance.
RUN cp /app/agents.md /app/GEMINI.md && cat >> /app/GEMINI.md <<'PATCH'

## Writing Files (Important — Gemini CLI)

**Do NOT use heredoc syntax (`<< 'EOF'`).** It will be rejected by the shell parser.

Instead, use `printf` to write multi-line files:

```bash
printf '%s\n' \
  'import { BotSDK } from "/app/sdk/index";' \
  'import { BotActions } from "/app/sdk/actions";' \
  '' \
  'const sdk = new BotSDK({' \
  '  botUsername: "agent",' \
  '  password: "test",' \
  '  gatewayUrl: "ws://localhost:7780",' \
  '  autoLaunchBrowser: false,' \
  '});' \
  'await sdk.connect();' \
  'const bot = new BotActions(sdk);' \
  'await bot.skipTutorial();' \
  'console.log("done");' \
  'process.exit(0);' \
  > /tmp/my_script.ts
bun /tmp/my_script.ts
```

Or use the `/usr/local/bin/writefile` helper which reads from stdin:

```bash
echo 'console.log("hello")
process.exit(0)' | writefile /tmp/test.ts
bun /tmp/test.ts
```
PATCH

# writefile helper — reads stdin and writes to the path given as $1
RUN printf '#!/bin/bash\ncat > "$1"\n' > /usr/local/bin/writefile && chmod +x /usr/local/bin/writefile

# SDK daemon defaults to remote demo server — force localhost for Docker runs.
# (belt-and-suspenders; bot.env already has SERVER=localhost for the daemon)
ENV GATEWAY_URL=ws://localhost:7780

# Newer gemini-cli releases (post-Apr 2026) refuse to honor --yolo unless the
# workspace is explicitly trusted. Headless-safe override per the gemini-cli
# trusted-folders docs.
ENV GEMINI_CLI_TRUST_WORKSPACE=true

# Idempotent service checker — verifier calls this to ensure services + tracker are alive
COPY ensure-services.sh /ensure-services.sh
RUN chmod +x /ensure-services.sh

ENTRYPOINT ["/entrypoint.sh"]
