"""
Custom Harbor adapter for GLM-5.2 via OpenCode + OpenRouter, pinned to the
WandB fp4 endpoint (high-throughput serving; distinct row from the z-ai-pinned
`glm52` baseline for a same-model quantization/speed comparison).

Declares explicit `cost` in opencode.json so OpenCode reports the WandB
endpoint's real rates ($1.39/$4.40 per 1M, cache read $0.26) instead of the
models.dev baseline — no postprocess backfill needed.

Usage with Harbor:
    PYTHONPATH=. harbor run \
        --agent-import-path 'glm52wandb_adapter:Glm52WandbOpenCode' \
        -m 'openrouter/z-ai/glm-5.2' \
        -p tasks/woodcutting-xp-30m
"""

from opencode_adapter import OpenCodeAdapter

# WandB fp4 endpoint rates per 1M tokens (OpenRouter endpoints API, 2026-07-17).
# Keep in sync with the 'glm52-wandb' entry in shared/pricing.ts.
_COST = {"input": 1.39, "output": 4.4, "cache_read": 0.26}
_LIMIT = {"context": 262144, "output": 262144}


class Glm52WandbOpenCode(OpenCodeAdapter):
    _default_model = "openrouter/z-ai/glm-5.2"
    _log_prefix = "glm52-wandb"
    _log_file = "opencode-glm52-wandb.txt"
    _model_options = {
        "provider": {
            "order": ["wandb"],
            "allow_fallbacks": False,
        }
    }

    @staticmethod
    def name() -> str:
        return "glm52-wandb-opencode"

    def _build_opencode_config(self) -> dict:
        config = super()._build_opencode_config()
        models = config["provider"]["openrouter"]["models"]
        models["z-ai/glm-5.2"] = {
            **models.get("z-ai/glm-5.2", {}),
            "cost": _COST,
            "limit": _LIMIT,
        }
        return config
