"""
Custom Harbor adapter for DeepSeek V4.1 Flash via OpenCode + OpenRouter.

Usage with Harbor:
    PYTHONPATH=. harbor run \
        --agent-import-path 'deepseek41flash_adapter:DeepSeek41FlashOpenCode' \
        -m 'openrouter/deepseek/deepseek-v4.1-flash' \
        -p tasks/woodcutting-xp-30m
"""

from opencode_adapter import OpenCodeAdapter


class DeepSeek41FlashOpenCode(OpenCodeAdapter):
    """deepseek-v4.1-flash pinned to the DeepSeek first-party endpoint.

    Unpinned, OpenRouter routes to the cheapest third-party host (Morph/Relace
    fp4 on 2026-09-22). First-party is the reference serving at the same list
    price ($0.15/$0.60 per 1M, cache read $0.003) and handled an 8-way
    concurrent tool-call probe cleanly, so pin it like glm53flash pins z-ai.
    Reasoning effort left unset (DeepSeek default).
    """

    _default_model = "openrouter/deepseek/deepseek-v4.1-flash"
    _log_prefix = "deepseek41flash"
    _log_file = "opencode-deepseek41flash.txt"
    _model_options = {
        "provider": {
            "order": ["deepseek"],
            "allow_fallbacks": False,
        }
    }

    @staticmethod
    def name() -> str:
        return "deepseek41flash-opencode"
