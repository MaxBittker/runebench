"""
Custom Harbor adapter for Kimi K2.7 via OpenCode + OpenRouter.

Usage with Harbor:
    PYTHONPATH=. harbor run \
        --agent-import-path 'kimi27_adapter:Kimi27OpenCode' \
        -m 'openrouter/moonshotai/kimi-k2.7-code' \
        -p tasks/woodcutting-xp-15m
"""

from opencode_adapter import OpenCodeAdapter


class Kimi27OpenCode(OpenCodeAdapter):
    _default_model = "openrouter/moonshotai/kimi-k2.7-code"
    _log_prefix = "kimi27"
    _log_file = "opencode-kimi27.txt"

    @staticmethod
    def name() -> str:
        return "kimi27-opencode"
