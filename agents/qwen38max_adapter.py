"""
Custom Harbor adapter for Qwen3.8 Max via OpenCode + OpenRouter.

Usage with Harbor:
    PYTHONPATH=. harbor run \
        --agent-import-path 'qwen38max_adapter:Qwen38MaxOpenCode' \
        -m 'openrouter/qwen/qwen3.8-max' \
        -p tasks/woodcutting-xp-15m
"""

from opencode_adapter import OpenCodeAdapter


class Qwen38MaxOpenCode(OpenCodeAdapter):
    _default_model = "openrouter/qwen/qwen3.8-max"
    _log_prefix = "qwen38max"
    _log_file = "opencode-qwen38max.txt"

    @staticmethod
    def name() -> str:
        return "qwen38max-opencode"
