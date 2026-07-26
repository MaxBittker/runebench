"""
Custom Harbor adapter for Poolside Laguna S 2.1 via OpenCode + OpenRouter,
pinned to the Poolside bf16 endpoint (the model's only OpenRouter provider as
of 2026-07-22; pinned so a later-added provider can't change the environment
mid-comparison). The endpoint supports `tools`/`tool_choice` (verified via the
OpenRouter endpoints API). Reasoning is default-enabled on this model.

Declares explicit `cost` in opencode.json so OpenCode reports real per-step
cost_usd even if models.dev lags on this model — no postprocess backfill needed.

Usage with Harbor:
    PYTHONPATH=. harbor run \
        --agent-import-path 'laguna_adapter:LagunaOpenCode' \
        -m 'openrouter/poolside/laguna-s-2.1' \
        -p tasks/woodcutting-xp-30m
"""

from opencode_adapter import OpenCodeAdapter

# Poolside endpoint rates per 1M tokens (OpenRouter endpoints API, 2026-07-22).
# Keep in sync with the 'laguna' entry in shared/pricing.ts.
_COST = {"input": 0.10, "output": 0.20, "cache_read": 0.01}
_LIMIT = {"context": 1048576, "output": 131072}


class LagunaOpenCode(OpenCodeAdapter):
    _default_model = "openrouter/poolside/laguna-s-2.1"
    _log_prefix = "laguna"
    _log_file = "opencode-laguna.txt"
    _model_options = {
        "provider": {
            "order": ["poolside"],
            "allow_fallbacks": False,
        },
    }

    @staticmethod
    def name() -> str:
        return "laguna-opencode"

    def _build_opencode_config(self) -> dict:
        config = super()._build_opencode_config()
        models = config["provider"]["openrouter"]["models"]
        models["poolside/laguna-s-2.1"] = {
            **models.get("poolside/laguna-s-2.1", {}),
            "cost": _COST,
            "limit": _LIMIT,
        }
        return config
