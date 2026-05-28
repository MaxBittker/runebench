"""
Custom Harbor adapter for the Gemini CLI that forces an elevated reasoning
(thinking) level.

Gemini 3.5 Flash has no "extra high" reasoning tier the way OpenAI's gpt-5.5 has
`reasoning_effort=xhigh`. Its `thinking_level` enum tops out at `high`
(minimal | low | medium | high), and the API default for gemini-3.5-flash is
`medium`. This adapter runs the model at its maximum `thinking_level=high` so it
can be benchmarked as a second row alongside the default (medium) row, mirroring
the gpt-5.5 / gpt-5.5-xhigh two-row treatment.

The stock harbor `gemini-cli` agent exposes no flag for thinking level — the only
way to set it is via `~/.gemini/settings.json`'s `modelConfigs`. Harbor's base
`run()` rewrites that file (mcp registration step), so we take over the write and
inject a `customOverrides` entry that deep-merges `thinkingLevel: HIGH` onto the
resolved config for the target model. `customOverrides` is "merged with (and added
to) the built-in overrides" (per gemini-cli's settingsSchema), and overrides apply
on top of alias resolution, so this changes *only* the thinking level — every other
setting (temperature, includeThoughts, etc.) stays identical to the default row.

Verified offline against gemini-cli-core's ModelConfigService:
    gemini-3.5-flash (default)          -> thinkingConfig: {includeThoughts:true}
    gemini-3.5-flash (this adapter)     -> thinkingConfig: {includeThoughts:true, thinkingLevel:"HIGH"}

Usage with Harbor:
    PYTHONPATH=agents harbor run \\
        --agent-import-path 'gemini_adapter:GeminiCliHighThinking' \\
        --ak version=0.38.2 \\
        -m 'google/gemini-3.5-flash' \\
        -p tasks/woodcutting-xp-30m
"""

import json
import shlex
from typing import Any

from harbor.agents.installed.gemini_cli import GeminiCli


class GeminiCliHighThinking(GeminiCli):
    """Gemini CLI agent pinned to its maximum thinking_level (HIGH)."""

    def __init__(self, thinking_level: str = "HIGH", *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._thinking_level = (thinking_level or "HIGH").upper()

    @staticmethod
    def name() -> str:
        return "gemini-cli-high"

    @property
    def _target_model(self) -> str:
        """The bare model name gemini-cli resolves (e.g. 'gemini-3.5-flash')."""
        if self.model_name and "/" in self.model_name:
            return self.model_name.split("/")[-1]
        return self.model_name or ""

    def _build_register_mcp_servers_command(self) -> str | None:
        """Write ~/.gemini/settings.json with skills + (optional) MCP servers +
        a modelConfigs override that forces thinkingLevel for the target model.

        We always return a command (unlike the base, which returns None when there
        are no MCP servers) so the thinking-level override is guaranteed to land
        right before the `gemini` invocation, regardless of MCP configuration.
        """
        settings: dict[str, Any] = {"experimental": {"skills": True}}

        if self.mcp_servers:
            servers: dict[str, dict[str, Any]] = {}
            for server in self.mcp_servers:
                if server.transport == "stdio":
                    servers[server.name] = {
                        "command": server.command,
                        "args": server.args,
                    }
                elif server.transport == "streamable-http":
                    servers[server.name] = {"httpUrl": server.url}
                else:  # sse
                    servers[server.name] = {"url": server.url}
            settings["mcpServers"] = servers

        settings["modelConfigs"] = {
            "customOverrides": [
                {
                    "match": {"model": self._target_model},
                    "modelConfig": {
                        "generateContentConfig": {
                            "thinkingConfig": {"thinkingLevel": self._thinking_level}
                        }
                    },
                }
            ]
        }

        config = json.dumps(settings, indent=2)
        escaped = shlex.quote(config)
        return f"mkdir -p ~/.gemini && echo {escaped} > ~/.gemini/settings.json"
