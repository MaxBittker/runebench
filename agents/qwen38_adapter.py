"""
Custom Harbor adapter for Qwen3.8 27B via OpenCode + OpenRouter.

Usage with Harbor:
    PYTHONPATH=. harbor run \
        --agent-import-path 'qwen38_adapter:Qwen38OpenCode' \
        -m 'openrouter/qwen/qwen3.8-27b' \
        -p tasks/woodcutting-xp-15m
"""

from opencode_adapter import OpenCodeAdapter


class Qwen38OpenCode(OpenCodeAdapter):
    _default_model = "openrouter/qwen/qwen3.8-27b"
    _log_prefix = "qwen38"
    _log_file = "opencode-qwen38.txt"

    @staticmethod
    def name() -> str:
        return "qwen38-opencode"
