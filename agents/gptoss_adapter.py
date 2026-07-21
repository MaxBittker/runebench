"""
Custom Harbor adapter for GPT-OSS-120B via OpenCode + OpenRouter, pinned to the
Cerebras fp16 endpoint (wafer-scale fast inference).

Declares explicit `cost` in opencode.json so OpenCode reports Cerebras's real
rates ($0.35/$0.75 per 1M, no cache-read discount) instead of the models.dev
baseline (Cerebras is ~2x the model's cheapest default routing) — no
postprocess backfill needed.

Usage with Harbor:
    PYTHONPATH=. harbor run \
        --agent-import-path 'gptoss_adapter:GptOss120bOpenCode' \
        -m 'openrouter/openai/gpt-oss-120b' \
        -p tasks/woodcutting-xp-30m
"""

from opencode_adapter import OpenCodeAdapter

# Cerebras fp16 endpoint rates per 1M tokens (OpenRouter endpoints API,
# 2026-07-17). Keep in sync with the 'gptoss120b' entry in shared/pricing.ts.
_COST = {"input": 0.35, "output": 0.75, "cache_read": 0.35}
_LIMIT = {"context": 131072, "output": 40960}


class GptOss120bOpenCode(OpenCodeAdapter):
    _default_model = "openrouter/openai/gpt-oss-120b"
    _log_prefix = "gptoss120b"
    _log_file = "opencode-gptoss120b.txt"
    _model_options = {
        "provider": {
            "order": ["cerebras"],
            "allow_fallbacks": False,
        }
    }

    @staticmethod
    def name() -> str:
        return "gptoss120b-opencode"

    def _build_opencode_config(self) -> dict:
        config = super()._build_opencode_config()
        models = config["provider"]["openrouter"]["models"]
        models["openai/gpt-oss-120b"] = {
            **models.get("openai/gpt-oss-120b", {}),
            "cost": _COST,
            "limit": _LIMIT,
        }
        return config
