"""
Custom Harbor adapter for Qwen3 Max via OpenCode + OpenRouter.

Usage with Harbor:
    PYTHONPATH=. harbor run \
        --agent-import-path 'qwen3max_adapter:Qwen3MaxOpenCode' \
        -m 'openrouter/qwen/qwen3-max' \
        -p tasks/woodcutting-xp-15m
"""

from opencode_adapter import OpenCodeAdapter


class Qwen3MaxOpenCode(OpenCodeAdapter):
    _default_model = "openrouter/qwen/qwen3-max"
    _log_prefix = "qwen3max"
    _log_file = "opencode-qwen3max.txt"

    @staticmethod
    def name() -> str:
        return "qwen3max-opencode"
