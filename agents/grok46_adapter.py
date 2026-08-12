"""
Custom Harbor adapter for Grok 4.6 via OpenCode + OpenRouter.

Usage with Harbor:
    PYTHONPATH=. harbor run \
        --agent-import-path 'grok46_adapter:Grok46OpenCode' \
        -m 'openrouter/x-ai/grok-4.6' \
        -p tasks/woodcutting-xp-15m
"""

from opencode_adapter import OpenCodeAdapter


class Grok46OpenCode(OpenCodeAdapter):
    _default_model = "openrouter/x-ai/grok-4.6"
    _log_prefix = "grok46"
    _log_file = "opencode-grok46.txt"

    @staticmethod
    def name() -> str:
        return "grok46-opencode"
