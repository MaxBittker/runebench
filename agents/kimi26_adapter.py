"""
Custom Harbor adapter for Kimi K2.6 via OpenCode + OpenRouter.

Usage with Harbor:
    PYTHONPATH=. harbor run \
        --agent-import-path 'kimi26_adapter:Kimi26OpenCode' \
        -m 'openrouter/moonshotai/kimi-k2.6' \
        -p tasks/woodcutting-xp-15m
"""

from opencode_adapter import OpenCodeAdapter


class Kimi26OpenCode(OpenCodeAdapter):
    _default_model = "openrouter/moonshotai/kimi-k2.6"
    _log_prefix = "kimi26"
    _log_file = "opencode-kimi26.txt"

    @staticmethod
    def name() -> str:
        return "kimi26-opencode"
