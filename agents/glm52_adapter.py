"""
Custom Harbor adapter for GLM-5.2 via OpenCode + OpenRouter.

Usage with Harbor:
    PYTHONPATH=. harbor run \
        --agent-import-path 'glm52_adapter:Glm52OpenCode' \
        -m 'openrouter/z-ai/glm-5.2' \
        -p tasks/woodcutting-xp-30m
"""

from opencode_adapter import OpenCodeAdapter


class Glm52OpenCode(OpenCodeAdapter):
    _default_model = "openrouter/z-ai/glm-5.2"
    _log_prefix = "glm52"
    _log_file = "opencode-glm52.txt"
    _model_options = {
        "provider": {
            "order": ["z-ai"],
            "allow_fallbacks": False,
        }
    }

    @staticmethod
    def name() -> str:
        return "glm52-opencode"
