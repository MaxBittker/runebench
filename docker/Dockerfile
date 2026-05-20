ARG BASE_IMAGE=ghcr.io/maxbittker/rs-agent-benchmark-base:v1
FROM ${BASE_IMAGE}

# 8x faster game simulation (50ms ticks vs default 420ms)
ENV NODE_TICKRATE=50

# Clone rs-sdk (shallow clone, then delete .git to save ~50MB)
ARG RS_SDK_REPO=https://github.com/MaxBittker/rs-sdk.git
ARG RS_SDK_REF=main
RUN git clone --depth 1 --branch $RS_SDK_REF $RS_SDK_REPO /app \
    && rm -rf /app/.git
WORKDIR /app

# Install all workspace dependencies
RUN bun install
RUN cd server/engine && bun install
RUN cd server/gateway && bun install
RUN cd server/webclient && bun install && bun run build
RUN cp -r server/webclient/out/bot server/engine/public/bot
RUN cd sdk && bun install

# Remove scripts/ and sdk/test/ — benchmark agents waste budget reading/running these
RUN rm -rf /app/scripts /app/sdk/test

# Replace upstream instruction files with our simplified benchmark version
RUN rm -f /app/agents.md /app/claude.md /app/GEMINI.md
COPY agents.md /app/agents.md

# Pre-pack game cache and let engine fully start so all data files are generated.
# Wait for "World ready" in output, then kill. This ensures maps, scripts, configs are all packed.
RUN cd server/engine && \
    bun run src/app.ts > /tmp/engine.log 2>&1 & \
    for i in $(seq 1 300); do \
        grep -q "World ready" /tmp/engine.log 2>/dev/null && break; \
        sleep 1; \
    done && \
    sleep 2 && kill $(jobs -p) 2>/dev/null; rm -f /tmp/engine.log; true

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

# Ensure bot.env has SERVER=localhost so scripts connect to the local gateway
RUN echo 'SERVER=localhost' >> /app/bots/agent/bot.env

# Install MCP server deps (mcp/ comes from the rs-sdk clone)
RUN cd /app/mcp && bun install

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
