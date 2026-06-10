"""
Custom Harbor adapter for DeepSeek V4 Pro via OpenCode + OpenRouter.

Usage with Harbor:
    PYTHONPATH=. harbor run \
        --agent-import-path 'deepseek_adapter:DeepSeekOpenCode' \
        -m 'openrouter/deepseek/deepseek-v4-pro' \
        -p tasks/woodcutting-xp-15m
"""

from opencode_adapter import OpenCodeAdapter


class DeepSeekOpenCode(OpenCodeAdapter):
    _default_model = "openrouter/deepseek/deepseek-v4-pro"
    _log_prefix = "deepseek"
    _log_file = "opencode-deepseek.txt"

    @staticmethod
    def name() -> str:
        return "deepseek-opencode"
