"""
Split-topology team adapter: 1 Modal sandbox per agent + 1 server sandbox.

The harbor trial sandbox runs ONLY the game server stack (a `-split` task
variant whose image boots shared/entrypoint-server.sh: engine + gateway +
watcher). The verifier, save files, and /logs artifact flow stay on that box,
so scoring is identical to the single-box team tasks.

This adapter spawns one sibling Modal sandbox per bot from the same app/image
as the trial sandbox. Each agent box runs shared/agent-box.sh (Xvfb + chromium
bot client + ffmpeg recording) plus one OpenCode session, and reaches the
server through Modal encrypted tunnels:

  - engine web (8888)  → BOT_URL for chromium (https tunnel)
  - gateway   (7780)  → GATEWAY_URL for the SDK/MCP/chat CLI (wss tunnel)

Launch requirements:
  - task dir must be the `-split` variant (server-only entrypoint + sizing)
  - `--ek tunnel_ports=8888,7780` (needs the local harbor patch; see
    patches/harbor-local.patch)

Agent-box sizing: `--ak agent_box_cpus=2 --ak agent_box_memory_mb=4096`
(defaults shown). RAM scales per-agent instead of one big box: an OOM kills
one agent, not the trial, and team size is no longer capped by single-sandbox
memory.

Logs land in the same places as opencode_team_adapter (opencode-<bot>.txt,
trajectory-<bot>.json, merged trajectory.json, recording-<bot>.mp4): after the
sessions finish, artifacts are pulled from each agent box to the host logs dir
and the session logs are also uploaded to the server box's /logs/agent so the
normal harbor artifact flow sees them.
"""

import asyncio
import json
import logging
import shlex
from pathlib import Path

from modal import Sandbox, Secret

from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from opencode_team_adapter import OpenCodeTeamAdapter

logger = logging.getLogger(__name__)

ENGINE_PORT = 8888
GATEWAY_PORT = 7780
# Live observation dashboard served by the server box (shared/dashboard.ts).
# Optional: only present when launched with tunnel_ports=8888,7780,8790.
DASHBOARD_PORT = 8790
# Wealth-rank endpoint served by the market watcher on the server box (-rank
# task variants set RANK_PORT=8791). Optional: when the tunnel exists, each
# agent box gets the URL in /tmp/rank-url for the market-status CLI.
RANK_PORT = 8791

_AGENT_BOX_SCRIPT = Path(__file__).parent.parent / "shared" / "agent-box.sh"

# Seconds between bot logins across the fleet (mirrors the 5s stagger the
# single-box entrypoint uses so the engine handles one new session at a time).
_LOGIN_STAGGER_SEC = 5

_BOT_READY_TIMEOUT_SEC = 240
_SERVER_READY_TIMEOUT_SEC = 300
_ARTIFACT_TIMEOUT_SEC = 600

# The image ships no opencode — in the single-box flow harbor's install step
# puts it in the trial sandbox at trial start. Agent boxes need the same
# (mirrors OpenCodeAdapter.install's fallback).
_OPENCODE_INSTALL_CMD = (
    'export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; '
    "if command -v opencode &>/dev/null; then echo '[split-install] opencode already present'; else "
    "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | bash && "
    'export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && '
    "nvm install 22 && npm i -g opencode-ai@latest && opencode --version; fi"
)


class OpenCodeSplitTeamAdapter(OpenCodeTeamAdapter):
    """N OpenCode sessions, each in its own Modal sandbox, one bot each."""

    _log_prefix = "opencode-split"

    def __init__(
        self,
        agent_box_cpus: int | str = 2,
        agent_box_memory_mb: int | str = 4096,
        *args,
        **kwargs,
    ):
        super().__init__(*args, **kwargs)
        self._agent_box_cpus = int(agent_box_cpus)
        self._agent_box_memory_mb = int(agent_box_memory_mb)
        self._agent_sandboxes: dict[str, Sandbox] = {}
        self._rank_url: str | None = None

    @staticmethod
    def name() -> str:
        return "opencode-split-adapter"

    async def install(self, environment: BaseEnvironment) -> None:
        # The trial sandbox is the SERVER box in split mode — no OpenCode
        # session runs there. Each agent box installs opencode for itself in
        # _spawn_agent_box.
        return None

    # ── Modal plumbing ───────────────────────────────────────────

    async def _box_exec(
        self,
        sb: Sandbox,
        command: str,
        env: dict[str, str] | None = None,
        timeout_sec: int | None = None,
    ) -> tuple[int, str, str]:
        """Exec a bash command in an agent sandbox (mirrors harbor's _sdk_exec)."""
        process = await sb.exec.aio(
            "bash",
            "-lc",
            command,
            secrets=[Secret.from_dict(env)] if env else [],
            timeout=timeout_sec,
        )
        stdout = await process.stdout.read.aio()
        stderr = await process.stderr.read.aio()
        return_code = await process.wait.aio()
        return return_code, stdout, stderr

    async def _resolve_tunnels(self, environment: BaseEnvironment) -> tuple[str, str]:
        """Return (web_url, gateway_url) from the server sandbox's tunnels."""
        sandbox = getattr(environment, "_sandbox", None)
        if sandbox is None:
            raise RuntimeError(
                "opencode-split-adapter requires --env modal (no sandbox on environment)"
            )
        tunnels = await sandbox.tunnels.aio()
        missing = [p for p in (ENGINE_PORT, GATEWAY_PORT) if p not in tunnels]
        if missing:
            raise RuntimeError(
                f"server sandbox has no tunnel for port(s) {missing} — launch with "
                f"--ek tunnel_ports={ENGINE_PORT},{GATEWAY_PORT} (needs the local "
                "harbor patch, see patches/harbor-local.patch)"
            )
        self._rank_url = tunnels[RANK_PORT].url if RANK_PORT in tunnels else None
        web_url = tunnels[ENGINE_PORT].url
        gw_host, gw_port = tunnels[GATEWAY_PORT].tls_socket
        gateway_url = f"wss://{gw_host}:{gw_port}"
        logger.info("Server tunnels: web=%s gateway=%s", web_url, gateway_url)
        self._surface_dashboard_url(tunnels)
        return web_url, gateway_url

    def _surface_dashboard_url(self, tunnels) -> None:
        """Log the live dashboard URL and drop it in the job's logs dir."""
        if DASHBOARD_PORT not in tunnels:
            return
        url = tunnels[DASHBOARD_PORT].url
        logger.info("LIVE DASHBOARD: %s", url)
        try:
            self.logs_dir.mkdir(parents=True, exist_ok=True)
            (self.logs_dir / "dashboard-url.txt").write_text(url + "\n")
        except Exception:
            logger.warning("Could not write dashboard-url.txt", exc_info=True)

    async def _wait_for_server(self, environment: BaseEnvironment) -> None:
        """Block until the engine answers on the server box (entrypoint may still be booting)."""
        result = await environment.exec(
            command=(
                f"for i in $(seq 1 {_SERVER_READY_TIMEOUT_SEC}); do "
                f"curl -sf http://localhost:{ENGINE_PORT} >/dev/null 2>&1 && exit 0; "
                "sleep 1; done; exit 1"
            ),
            timeout_sec=_SERVER_READY_TIMEOUT_SEC + 30,
        )
        if result.return_code != 0:
            raise RuntimeError(
                f"game engine on the server box never became ready "
                f"({_SERVER_READY_TIMEOUT_SEC}s) — check the trial's entrypoint logs"
            )

    async def _spawn_agent_box(
        self, environment: BaseEnvironment, bot: str, index: int, web_url: str, gateway_url: str
    ) -> Sandbox:
        sb = await Sandbox.create.aio(
            # NOTE: a Sandbox command does NOT override the image ENTRYPOINT -
            # Modal appends it as entrypoint args (`/entrypoint-server.sh bash
            # -c sleep infinity`). The first split runs (2026-08-14..17) thus
            # booted a full rogue engine+gateway+watcher+dashboard on EVERY
            # agent box (~1 cpu / 1.6 GB each), starving chromium into
            # catatonia. Clear the entrypoint explicitly; agent-box.sh is
            # started by exec below.
            "bash",
            "-c",
            "sleep infinity",
            app=environment._app,
            image=environment._image.entrypoint([]),
            name=f"{environment.session_id}-{bot}",
            cpu=self._agent_box_cpus,
            # Same (request, limit) semantics as the harbor local patch:
            # chromium + one OpenCode session idles ~1.5-2GB; bill usage,
            # cap at agent_box_memory_mb.
            memory=(2048, self._agent_box_memory_mb),
            timeout=environment._sandbox_timeout,
            region=environment._sandbox_region,
        )
        self._agent_sandboxes[bot] = sb

        await asyncio.wait_for(
            sb.filesystem.copy_from_local.aio(_AGENT_BOX_SCRIPT, "/tmp/agent-box.sh"),
            timeout=180,
        )
        box_env = {
            "BOT_NAME": bot,
            "SERVER_WEB_URL": web_url,
            "GATEWAY_URL": gateway_url,
            "LOGIN_STAGGER_SEC": str(index * _LOGIN_STAGGER_SEC),
            # market-status CLI (-rank market variants) reads /tmp/rank-url
            "RANK_URL": self._rank_url or "",
        }
        code, _, stderr = await self._box_exec(
            sb,
            "mkdir -p /logs/agent /logs/verifier && chmod 777 /logs/agent /logs/verifier && "
            '[ -n "$RANK_URL" ] && echo "$RANK_URL" > /tmp/rank-url; '
            "chmod +x /tmp/agent-box.sh && "
            "(setsid nohup /tmp/agent-box.sh >> /logs/agent/agent-box.log 2>&1 &) && sleep 1",
            env=box_env,
            timeout_sec=60,
        )
        if code != 0:
            raise RuntimeError(f"agent box bootstrap failed for {bot}: {stderr}")

        # Install opencode (concurrent across boxes; overlaps the bot login).
        code, stdout, stderr = await self._box_exec(
            sb, _OPENCODE_INSTALL_CMD, timeout_sec=600
        )
        if code != 0:
            raise RuntimeError(
                f"opencode install failed for {bot}: {stderr[-500:] or stdout[-500:]}"
            )
        logger.info("Agent box up for %s (%s)", bot, sb.object_id)
        return sb

    async def _wait_for_bot(self, bot: str) -> None:
        """Wait for this box's chromium client to be in-game (best-effort)."""
        sb = self._agent_sandboxes[bot]
        code, _, _ = await self._box_exec(
            sb,
            f"for i in $(seq 1 {_BOT_READY_TIMEOUT_SEC}); do "
            "[ -f /tmp/bot-ready ] && exit 0; sleep 1; done; exit 1",
            timeout_sec=_BOT_READY_TIMEOUT_SEC + 30,
        )
        if code != 0:
            # Don't fail the trial: the session still starts and the model can
            # observe/debug the client through the SDK.
            logger.warning("Bot %s not in-game after %ss — starting session anyway",
                           bot, _BOT_READY_TIMEOUT_SEC)

    # ── Main flow ────────────────────────────────────────────────

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        self._last_instruction = instruction

        try:
            await self._wait_for_server(environment)
            web_url, gateway_url = await self._resolve_tunnels(environment)

            # Boot all agent boxes concurrently (login order is preserved by
            # each box's LOGIN_STAGGER_SEC, not by spawn order).
            await asyncio.gather(*(
                self._spawn_agent_box(environment, bot, i, web_url, gateway_url)
                for i, bot in enumerate(self._bots)
            ))
            await asyncio.gather(*(self._wait_for_bot(bot) for bot in self._bots))

            # One OpenCode session per box, all concurrent.
            env = self._agent_env()
            env["GATEWAY_URL"] = gateway_url
            env["SERVER_WEB_URL"] = web_url
            config_json = json.dumps(self._build_opencode_config(), indent=2)
            bash_timeout = self._run_timeout_sec or 1620
            self._write_bot_models_manifest()
            modal_timeout = (self._run_timeout_sec + 60) if self._run_timeout_sec else None

            async def run_session(index: int, bot: str) -> None:
                sb = self._agent_sandboxes[bot]
                addendum = self._bot_addendum(bot, index, instruction)
                role_instruction = f"{instruction}\n\n{addendum}"
                instr_file = f"/tmp/opencode-instruction-{bot}.txt"
                code, _, stderr = await self._box_exec(
                    sb,
                    f"echo {shlex.quote(config_json)} > /app/opencode.json && "
                    f"printf %s {shlex.quote(role_instruction)} > {instr_file}",
                    env=env,
                    timeout_sec=60,
                )
                if code != 0:
                    raise RuntimeError(f"session setup failed for {bot}: {stderr}")
                cmd = self._compose_run_command(
                    model_name=self._bot_model_name(bot),
                    instruction=role_instruction,
                    prefix=f"opencode-{bot}",
                    log_file=self._session_log_file(bot),
                    bash_timeout=bash_timeout,
                    instruction_file=instr_file,
                )
                await self._box_exec(sb, cmd, env=env, timeout_sec=modal_timeout)

            results = await asyncio.gather(
                *(run_session(i, bot) for i, bot in enumerate(self._bots)),
                return_exceptions=True,
            )
            for bot, result in zip(self._bots, results):
                if isinstance(result, BaseException):
                    logger.error("Session for %s failed: %r", bot, result)
        finally:
            try:
                await self._collect_artifacts(environment)
            except Exception:
                logger.exception("Artifact collection from agent boxes failed")
            await self._terminate_agent_boxes()

    # ── Artifacts + teardown ─────────────────────────────────────

    async def _collect_artifacts(self, environment: BaseEnvironment) -> None:
        for bot, sb in self._agent_sandboxes.items():
            # Finalize the recording before pulling it.
            try:
                await self._box_exec(
                    sb, "pkill -INT -f ffmpeg 2>/dev/null; sleep 2", timeout_sec=30
                )
            except Exception:
                logger.warning("Could not stop ffmpeg on %s's box", bot)

            pulls = [
                (f"/logs/agent/{self._session_log_file(bot)}",
                 self.logs_dir / self._session_log_file(bot)),
                ("/logs/agent/agent-box.log", self.logs_dir / f"agent-box-{bot}.log"),
                ("/logs/agent/launch-bot.log", self.logs_dir / f"launch-bot-{bot}.log"),
                (f"/logs/verifier/recording-{bot}.mp4",
                 self.logs_dir / f"recording-{bot}.mp4"),
            ]
            for src, dst in pulls:
                try:
                    await asyncio.wait_for(
                        sb.filesystem.copy_to_local.aio(src, str(dst)),
                        timeout=_ARTIFACT_TIMEOUT_SEC,
                    )
                except Exception:
                    logger.warning("Could not pull %s from %s's box", src, bot)

            # Mirror the session log onto the server box so harbor's normal
            # /logs download (and anything reading the job dir) includes it.
            session_log = self.logs_dir / self._session_log_file(bot)
            if session_log.exists():
                try:
                    await environment._sdk_upload_file(
                        session_log, f"/logs/agent/{self._session_log_file(bot)}"
                    )
                except Exception:
                    logger.warning("Could not mirror %s's session log to the server box", bot)

    async def _terminate_agent_boxes(self) -> None:
        for bot, sb in self._agent_sandboxes.items():
            try:
                await sb.terminate.aio()
                logger.info("Terminated %s's agent box", bot)
            except Exception:
                logger.warning("Failed to terminate %s's agent box", bot)
        self._agent_sandboxes = {}
