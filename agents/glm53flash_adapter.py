"""
Custom Harbor adapter for GLM-5.3 Flash via OpenCode + OpenRouter.

GLM-5.3 Flash is z.ai's small pay-as-you-go sibling of GLM-5.3 (OpenRouter
listing 2026-08-26): $0.075/$0.25 per 1M, cache read $0.015. Pinned to the
first-party Z.AI endpoint (no fallbacks) like the glm52 row so results
aren't confounded by third-party quantized hosts. models.dev carries the
openrouter entry, so OpenCode reports real per-step cost_usd.

Usage with Harbor:
    PYTHONPATH=. harbor run \
        --agent-import-path 'glm53flash_adapter:Glm53FlashOpenCode' \
        -m 'openrouter/z-ai/glm-5.3-flash' \
        -p tasks/woodcutting-xp-30m
"""

from opencode_adapter import OpenCodeAdapter


class Glm53FlashOpenCode(OpenCodeAdapter):
    _default_model = "openrouter/z-ai/glm-5.3-flash"
    _log_prefix = "glm53flash"
    _log_file = "opencode-glm53flash.txt"
    _model_options = {
        "provider": {
            "order": ["z-ai"],
            "allow_fallbacks": False,
        }
    }

    @staticmethod
    def name() -> str:
        return "glm53flash-opencode"
