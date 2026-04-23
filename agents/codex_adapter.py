"""
Custom Harbor adapter for Codex with Modal-level exec timeout, OAuth-via-base64,
and post-run cleanup of large files in $CODEX_HOME.

Rewritten for harbor 0.4.0, which replaced the old
`create_run_agent_commands -> list[ExecInput]` flow with an async `run()`
method that drives `exec_as_agent` directly.

Responsibilities:
  - Modal-level timeout on the long-running `codex exec` command so Modal kills
    the process server-side before harbor's asyncio.wait_for fires. Avoids the
    Modal synchronicity CancelledError hang on `process.stdout.read.aio()`.
  - Optional OAuth support via CODEX_AUTH_JSON_B64 (base64-encoded auth.json),
    which is decoded to a local tempfile and handed to harbor through its native
    CODEX_AUTH_JSON_PATH mechanism.
  - Post-run cleanup of residual $CODEX_HOME sqlite/lock files so harbor's
    untimed download_file() doesn't hang on large files.

Usage with Harbor:
    # API key auth (gpt-5.2-codex, gpt-5.4, gpt-5.5, ...):
    PYTHONPATH=agents harbor run \\
        --agent-import-path 'codex_adapter:CodexWithTimeout' \\
        --ak run_timeout_sec=1900 \\
        -m 'openai/gpt-5.5' \\
        -p tasks/woodcutting-xp-30m

    # OAuth auth (gpt-5.3-codex):
    CODEX_AUTH_JSON_B64=$(base64 < ~/.codex/auth.json) \\
    PYTHONPATH=agents harbor run \\
        --agent-import-path 'codex_adapter:CodexWithTimeout' \\
        --ak run_timeout_sec=1900 \\
        -m 'openai/gpt-5.3-codex' \\
        -p tasks/woodcutting-xp-30m
"""

import base64
import os
import tempfile

from harbor.agents.installed.codex import Codex
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths


class CodexWithTimeout(Codex):
    """Codex agent with Modal-level exec timeout and OAuth auth support."""

    def __init__(self, run_timeout_sec: int | None = None, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._run_timeout_sec = (
            int(run_timeout_sec) if run_timeout_sec is not None else None
        )
        self._auth_tempfile: str | None = None

    @staticmethod
    def name() -> str:
        return "codex-with-timeout"

    async def install(self, environment: BaseEnvironment) -> None:
        # Mirror the parent install() but drop the trailing `&& codex --version`
        # check. Recent codex CLI versions exit non-zero under `--version` in
        # some environments (e.g. missing auth config), which would blow up
        # setup even though the install itself succeeded. Harbor does a
        # best-effort version probe later via `get_version_command()` anyway.
        await self.exec_as_root(
            environment,
            command=(
                "if ldd --version 2>&1 | grep -qi musl || [ -f /etc/alpine-release ]; then"
                "  apk add --no-cache curl bash nodejs npm ripgrep;"
                " elif command -v apt-get &>/dev/null; then"
                "  apt-get update && apt-get install -y curl ripgrep;"
                " elif command -v yum &>/dev/null; then"
                "  yum install -y curl ripgrep;"
                " fi"
            ),
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )
        version_spec = f"@{self._version}" if self._version else "@latest"
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                "if ldd --version 2>&1 | grep -qi musl || [ -f /etc/alpine-release ]; then"
                f"  npm install -g @openai/codex{version_spec};"
                " else"
                "  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | bash && "
                '  export NVM_DIR="$HOME/.nvm" && '
                '  \\. "$NVM_DIR/nvm.sh" && '
                "  nvm install 22 && nvm alias default 22 && "
                f"  npm install -g @openai/codex{version_spec}; "
                " fi"
            ),
        )
        await self.exec_as_root(
            environment,
            command=(
                "for bin in node codex; do"
                '  BIN_PATH="$(which "$bin" 2>/dev/null || true)";'
                '  if [ -n "$BIN_PATH" ] && [ "$BIN_PATH" != "/usr/local/bin/$bin" ]; then'
                '    ln -sf "$BIN_PATH" "/usr/local/bin/$bin";'
                "  fi;"
                " done"
            ),
        )

    async def exec_as_agent(
        self,
        environment: BaseEnvironment,
        command: str,
        env: dict[str, str] | None = None,
        cwd: str | None = None,
        timeout_sec: int | None = None,
    ):
        # Inject the Modal-level timeout only on the long-running `codex exec`
        # command. Setup/cleanup exec calls keep their (short or default) timeouts.
        if (
            self._run_timeout_sec
            and timeout_sec is None
            and "codex exec" in command
        ):
            timeout_sec = self._run_timeout_sec
        return await super().exec_as_agent(
            environment, command, env=env, cwd=cwd, timeout_sec=timeout_sec
        )

    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        # Auth routing:
        #   - CODEX_AUTH_JSON_B64 set → OAuth: decode to a tempfile and hand to
        #     harbor via its native CODEX_AUTH_JSON_PATH (harbor uploads it).
        #   - Otherwise → force OPENAI_API_KEY. Without this, new harbor's
        #     _resolve_auth_json_path() silently picks up ~/.codex/auth.json
        #     when it exists and routes every codex model through ChatGPT OAuth
        #     — which breaks API-key-only models like gpt-5.4 / gpt-5.5.
        auth_b64 = os.environ.get("CODEX_AUTH_JSON_B64", "")
        auth_path_prev = os.environ.get("CODEX_AUTH_JSON_PATH")
        force_api_key_prev = os.environ.get("CODEX_FORCE_API_KEY")
        if auth_b64 and not auth_path_prev:
            fd, path = tempfile.mkstemp(prefix="codex-auth-", suffix=".json")
            try:
                with os.fdopen(fd, "wb") as f:
                    f.write(base64.b64decode(auth_b64))
            except Exception:
                try:
                    os.unlink(path)
                except OSError:
                    pass
                raise
            os.environ["CODEX_AUTH_JSON_PATH"] = path
            self._auth_tempfile = path
        elif not auth_path_prev and force_api_key_prev is None:
            os.environ["CODEX_FORCE_API_KEY"] = "1"

        try:
            await super().run(instruction, environment, context)
        finally:
            # Pre-download cleanup: harbor's download_file() has no timeout on
            # Modal file reads, so any large residual file in /logs/agent/ can
            # hang the pull. The parent run() already removes tmp/ and
            # auth.json; strip the sqlite/lock leftovers here.
            try:
                await self.exec_as_agent(
                    environment,
                    command=(
                        'cd "$CODEX_HOME" 2>/dev/null && '
                        "rm -f *.sqlite *.sqlite-wal *.sqlite-shm .lock "
                        "2>/dev/null; true"
                    ),
                    env={"CODEX_HOME": EnvironmentPaths.agent_dir.as_posix()},
                    timeout_sec=10,
                )
            except Exception:
                pass

            if self._auth_tempfile:
                try:
                    os.unlink(self._auth_tempfile)
                except OSError:
                    pass
                self._auth_tempfile = None

            # Restore CODEX_FORCE_API_KEY if we set it
            if force_api_key_prev is None and os.environ.get("CODEX_FORCE_API_KEY") == "1":
                os.environ.pop("CODEX_FORCE_API_KEY", None)
