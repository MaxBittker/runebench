"""
Custom Harbor adapter for GPT-4o (2024-08-06 snapshot) via OpenCode + OpenRouter.

Usage with Harbor:
    PYTHONPATH=. harbor run \
        --agent-import-path 'gpt4o_adapter:Gpt4oOpenCode' \
        -m 'openrouter/openai/gpt-4o-2024-08-06' \
        -p tasks/woodcutting-xp-30m
"""

from opencode_adapter import OpenCodeAdapter

# OpenAI first-party list rates per 1M tokens (OpenRouter endpoints API, 2026-10-10).
# The dated snapshot is pinned rather than the `gpt-4o` alias so the row can't drift;
# 2024-08-06 (not 2024-05-13) because it supports prompt caching, which the original
# snapshot does not (~4x cheaper per sweep). Keep in sync with 'gpt4o' in shared/pricing.ts.
_COST = {"input": 2.5, "output": 10.0, "cache_read": 1.25}
_LIMIT = {"context": 128000, "output": 16384}


class Gpt4oOpenCode(OpenCodeAdapter):
    """gpt-4o-2024-08-06 pinned to the OpenAI first-party endpoint (Azure is the other host)."""

    _default_model = "openrouter/openai/gpt-4o-2024-08-06"
    _log_prefix = "gpt4o"
    _log_file = "opencode-gpt4o.txt"
    _model_options = {
        "provider": {
            "order": ["openai"],
            "allow_fallbacks": False,
        }
    }

    @staticmethod
    def name() -> str:
        return "gpt4o-opencode"

    def _build_opencode_config(self) -> dict:
        config = super()._build_opencode_config()
        models = config["provider"]["openrouter"]["models"]
        models["openai/gpt-4o-2024-08-06"] = {
            **models.get("openai/gpt-4o-2024-08-06", {}),
            "cost": _COST,
            "limit": _LIMIT,
        }
        return config
