"""
Custom Harbor adapter for Qwen3.7 Max via OpenCode + OpenRouter.

Usage with Harbor:
    PYTHONPATH=. harbor run \
        --agent-import-path 'qwen37max_adapter:Qwen37MaxOpenCode' \
        -m 'openrouter/qwen/qwen3.7-max' \
        -p tasks/woodcutting-xp-15m
"""

from opencode_adapter import OpenCodeAdapter


class Qwen37MaxOpenCode(OpenCodeAdapter):
    _default_model = "openrouter/qwen/qwen3.7-max"
    _log_prefix = "qwen37max"
    _log_file = "opencode-qwen37max.txt"

    @staticmethod
    def name() -> str:
        return "qwen37max-opencode"
