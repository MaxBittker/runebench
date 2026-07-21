"""
Custom Harbor adapter for Gemma 4 31B IT via OpenCode + OpenRouter, pinned to
the Cerebras fp16 endpoint (fastest gemma-4 serving, ~1,400 tok/s measured).

Cerebras was chosen over Friendli (the original pick) because Friendli's
gemma-4 endpoint does not support tool calling — OpenRouter returns
404 "No endpoints found" for any request with `tools` when pinned there,
which fast-fail aborted all 16 skills (job renamed to
jobs/_failed-friendli-notools-gemma4-20260717-163819). Same story for the
WandB and DeepInfra-turbo endpoints; Cerebras is the fastest tool-capable one.

Declares explicit `cost` in opencode.json so OpenCode reports Cerebras's real
rates ($0.99/$1.49 per 1M, no cache-read discount) instead of the models.dev
baseline — no postprocess backfill needed.

Usage with Harbor:
    PYTHONPATH=. harbor run \
        --agent-import-path 'gemma4_adapter:Gemma4OpenCode' \
        -m 'openrouter/google/gemma-4-31b-it' \
        -p tasks/woodcutting-xp-30m
"""

from opencode_adapter import OpenCodeAdapter

# Cerebras fp16 endpoint rates per 1M tokens (OpenRouter endpoints API,
# 2026-07-17). Keep in sync with the 'gemma4' entry in shared/pricing.ts.
_COST = {"input": 0.99, "output": 1.49, "cache_read": 0.99}
_LIMIT = {"context": 131072, "output": 40960}


class Gemma4OpenCode(OpenCodeAdapter):
    _default_model = "openrouter/google/gemma-4-31b-it"
    _log_prefix = "gemma4"
    _log_file = "opencode-gemma4.txt"
    _model_options = {
        "provider": {
            "order": ["cerebras"],
            "allow_fallbacks": False,
        }
    }

    @staticmethod
    def name() -> str:
        return "gemma4-opencode"

    def _build_opencode_config(self) -> dict:
        config = super()._build_opencode_config()
        models = config["provider"]["openrouter"]["models"]
        models["google/gemma-4-31b-it"] = {
            **models.get("google/gemma-4-31b-it", {}),
            "cost": _COST,
            "limit": _LIMIT,
        }
        return config
