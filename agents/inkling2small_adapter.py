"""
Custom Harbor adapter for Inkling 2 Small (Thinking Machines) via OpenCode +
Tinker's OpenAI-compatible inference endpoint (serverless inference beta).

Tinker is not a models.dev provider, so this declares `tinker` as a custom
`@ai-sdk/openai-compatible` provider in opencode.json (same pattern as the
July 2026 Tinker-direct inkling adapter, commit c4649a5), keyed by
TINKER_API_KEY.

Model ID contains a slash, so the full ID has three segments —
`tinker/thinkingmachines/Inkling-2-Small:peft:262144`. OpenCode's --model
parser and the base adapter both split on the FIRST slash only, so provider
=`tinker` / model=`thinkingmachines/Inkling-2-Small:peft:262144`.

Reasoning: Tinker returns `reasoning_content` by default (verified 2026-11-11
probe), no effort knob is set.

Declares `cost` so OpenCode reports real per-step cost_usd — no backfill.

Usage with Harbor:
    PYTHONPATH=. harbor run \
        --agent-import-path 'inkling2small_adapter:Inkling2SmallOpenCode' \
        -m 'tinker/thinkingmachines/Inkling-2-Small:peft:262144' \
        -p tasks -i 'woodcutting-xp-30m'
"""

from opencode_adapter import OpenCodeAdapter

_TINKER_BASE_URL = "https://tinker.thinkingmachines.dev/services/tinker-prod/oai/api/v1"
_MODEL_ID = "tinker/thinkingmachines/Inkling-2-Small:peft:262144"
_MODEL_SUFFIX = "thinkingmachines/Inkling-2-Small:peft:262144"

# Per-1M rates from https://tinker-docs.thinkingmachines.ai/tinker/models/
# (serverless inference table, 2026-11-11): prefill $0.30, cached $0.03,
# sample $1.00; no cache-write premium. Keep in sync with the `inkling2small`
# entry in shared/pricing.ts.
_COST = {"input": 0.30, "output": 1.00, "cache_read": 0.03}
_LIMIT = {"context": 262144, "output": 32768}


class Inkling2SmallOpenCode(OpenCodeAdapter):
    _default_model = _MODEL_ID
    _log_prefix = "inkling2small"
    _log_file = "opencode-inkling2small.txt"

    @staticmethod
    def name() -> str:
        return "inkling2small-opencode"

    def _build_opencode_config(self) -> dict:
        config = super()._build_opencode_config()
        provider = config["provider"]["tinker"]
        provider["npm"] = "@ai-sdk/openai-compatible"
        provider["name"] = "Tinker"
        provider["options"] = {
            **provider.get("options", {}),
            "baseURL": _TINKER_BASE_URL,
            # Unset var substitutes to "" silently — run-common.sh guards it.
            "apiKey": "{env:TINKER_API_KEY}",
        }
        models = provider["models"]
        models[_MODEL_SUFFIX] = {
            **models.get(_MODEL_SUFFIX, {}),
            "name": "Inkling 2 Small (256K)",
            "cost": _COST,
            "limit": _LIMIT,
        }
        return config
