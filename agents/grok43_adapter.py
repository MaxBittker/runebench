"""
Custom Harbor adapter for Grok 4.3 via OpenCode + OpenRouter.

Usage with Harbor:
    PYTHONPATH=. harbor run \
        --agent-import-path 'grok43_adapter:Grok43OpenCode' \
        -m 'openrouter/x-ai/grok-4.3' \
        -p tasks/woodcutting-xp-15m
"""

from opencode_adapter import OpenCodeAdapter


class Grok43OpenCode(OpenCodeAdapter):
    _default_model = "openrouter/x-ai/grok-4.3"
    _log_prefix = "grok43"
    _log_file = "opencode-grok43.txt"

    @staticmethod
    def name() -> str:
        return "grok43-opencode"
