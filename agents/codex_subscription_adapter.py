"""Opt-in Harbor adapter that requires ChatGPT subscription authentication."""

import json
from pathlib import Path

from harbor.agents.installed.codex import Codex
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths

from codex_adapter import CodexWithTimeout, _truthy


def _subscription_auth_path(getenv, default: Path | None = None) -> Path:
    if _truthy(getenv("CODEX_FORCE_API_KEY")):
        raise ValueError("Subscription-only: CODEX_FORCE_API_KEY is forbidden")
    if getenv("CODEX_AUTH_JSON_B64"):
        raise ValueError(
            "Subscription-only: use CODEX_AUTH_JSON_PATH, not base64 credentials"
        )
    path = Path(
        getenv("CODEX_AUTH_JSON_PATH")
        or default
        or Path.home() / ".codex" / "auth.json"
    ).expanduser()
    try:
        auth = json.loads(path.read_text())
    except (OSError, ValueError):
        raise ValueError(
            "Subscription-only: a valid ChatGPT auth.json is required; run codex login"
        ) from None
    if (
        not isinstance(auth, dict)
        or auth.get("OPENAI_API_KEY")
        or auth.get("auth_mode") not in (None, "chatgpt")
    ):
        raise ValueError("Subscription-only: API-key authentication is forbidden")
    tokens = auth.get("tokens")
    if (
        not isinstance(tokens, dict)
        or not isinstance(tokens.get("access_token"), str)
        or not tokens["access_token"].strip()
    ):
        raise ValueError(
            "Subscription-only: ChatGPT OAuth tokens are required; no API fallback"
        )
    return path


class CodexSubscription(CodexWithTimeout):
    """Fail closed instead of falling back to API-key authentication."""

    @staticmethod
    def name() -> str:
        return "codex-subscription"

    @classmethod
    def check_model_credentials(cls, connection, *, kwargs, env, explicit_env=None):
        _subscription_auth_path(env.get)
        if connection.provider not in (None, "openai", "openai-responses"):
            raise ValueError(
                "Subscription-only: external model providers are forbidden"
            )

    def _resolve_auth_json_path(self) -> Path:
        return _subscription_auth_path(self._get_env)

    def _build_effective_config(self, openai_base_url):
        if openai_base_url:
            raise ValueError("Subscription-only: custom API endpoints are forbidden")
        config = super()._build_effective_config(openai_base_url)
        if config.get("openai_base_url") or config.get("model_providers"):
            raise ValueError(
                "Subscription-only: custom API provider configuration is forbidden"
            )
        config["forced_login_method"] = "chatgpt"
        config["model_provider"] = "openai"
        return config

    async def exec_as_agent(
        self,
        environment: BaseEnvironment,
        command: str,
        env: dict[str, str] | None = None,
        cwd: str | None = None,
        timeout_sec: int | None = None,
    ):
        if "codex exec " in command:
            self._resolve_auth_json_path()
            env = {**(env or {}), "OPENAI_API_KEY": "", "CODEX_API_KEY": ""}
            command = command.replace(
                "codex exec ",
                "codex exec -c 'forced_login_method=\"chatgpt\"' "
                "-c 'model_provider=\"openai\"' ",
                1,
            )
        return await super().exec_as_agent(
            environment, command, env=env, cwd=cwd, timeout_sec=timeout_sec
        )

    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        # Validate before the parent can upload credentials or execute anything.
        self._resolve_auth_json_path()

        try:
            await Codex.run(self, instruction, environment, context)
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
