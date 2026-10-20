"""
Custom Harbor adapter for GLM-5.3 via OpenCode + OpenRouter, pinned to the
PrimeIntellect endpoint.

Built for a harness-only comparison against PrimeIntellect's published RuneBench
run (HF PrimeIntellect/runebench-traces: prime-agent on `internal/glm-5.3-fast`,
image v71): same model on Prime's serving, same image and prompt, our OpenCode
harness. See analysis/primeintellect-traces/. Distinct row from `glm53` (z.ai
coding plan, image v53).

Prime's endpoint is OpenRouter's list rate ($1.40/$4.40 per 1M, cache read
$0.26); declared in opencode.json so OpenCode-native cost_usd reflects it.
Reasoning is left at the provider default, matching PI's sampling config.

Usage with Harbor:
    PYTHONPATH=. harbor run \
        --agent-import-path 'glm53prime_adapter:Glm53PrimeOpenCode' \
        -m 'openrouter/z-ai/glm-5.3' \
        -p tasks/woodcutting-xp-30m
"""

from opencode_adapter import OpenCodeAdapter

# PrimeIntellect endpoint rates per 1M tokens (OpenRouter endpoints API, 2026-10-01).
# Keep in sync with the 'glm53-prime' entry in shared/pricing.ts.
_COST = {"input": 1.4, "output": 4.4, "cache_read": 0.26}
_LIMIT = {"context": 1048576, "output": 131072}


class Glm53PrimeOpenCode(OpenCodeAdapter):
    _default_model = "openrouter/z-ai/glm-5.3"
    _log_prefix = "glm53-prime"
    _log_file = "opencode-glm53-prime.txt"
    _model_options = {
        "provider": {
            "order": ["primeintellect"],
            "allow_fallbacks": False,
        }
    }

    @staticmethod
    def name() -> str:
        return "glm53-prime-opencode"

    def _build_opencode_config(self) -> dict:
        config = super()._build_opencode_config()
        models = config["provider"]["openrouter"]["models"]
        models["z-ai/glm-5.3"] = {
            **models.get("z-ai/glm-5.3", {}),
            "cost": _COST,
            "limit": _LIMIT,
        }
        return config
