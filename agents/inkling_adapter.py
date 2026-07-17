"""
Custom Harbor adapter for Inkling (Thinking Machines) via OpenCode + Tinker.

Tinker is NOT a models.dev provider, so OpenCode can't resolve it from its
built-in registry. This adapter declares `tinker` as a custom
`@ai-sdk/openai-compatible` provider in opencode.json, pointing at Tinker's
OpenAI-compatible endpoint, and inlines the cost/limit metadata OpenCode would
normally pull from models.dev.

Because `cost` is declared, OpenCode reports real per-step cost_usd in its JSONL
log (verified: matches prefill/cached/sample rates to 6dp), so unlike the
claude-code/codex/gemini-cli skill runs this needs NO postprocess-costs backfill.

Model ID note: the Tinker model name itself contains a slash, so the full ID is
three segments — `tinker/thinkingmachines/Inkling:peft:262144`. OpenCode's
`--model` parser splits on the FIRST slash only and rejoins the rest
(cli/cmd/run.ts), and the base adapter's split("/", 1) does the same, so
provider=`tinker` / model=`thinkingmachines/Inkling:peft:262144` resolves
correctly on both sides.

Usage with Harbor:
    PYTHONPATH=. harbor run \
        --agent-import-path 'inkling_adapter:InklingOpenCode' \
        -m 'tinker/thinkingmachines/Inkling:peft:262144' \
        -p tasks/woodcutting-xp-30m
"""

from opencode_adapter import OpenCodeAdapter

# Tinker's OpenAI-compatible surface. The native SDK base URL is
# .../services/tinker-prod; the OAI shim lives under /oai/api/v1.
_TINKER_BASE_URL = "https://tinker.thinkingmachines.dev/services/tinker-prod/oai/api/v1"

# Per-1M-token rates, as OpenCode's config expects them (NOT per-token like
# shared/pricing.ts). Tinker bills three meters — prefill / sample / train — so
# prefill maps to `input` and sample maps to `output`. Train is irrelevant here
# (inference only). Cached prefill gets an 80% discount; there is no cache-write
# premium, so `cache_write` is omitted.
#
# Source: https://tinker-docs.thinkingmachines.ai/tinker/models/ (2026-07-15,
# during the "limited-time 50% discount"). Keep in sync with the `inkling`
# entry in shared/pricing.ts.
_INKLING_MODELS = {
    # 256K-context variant. Chosen over the 64K base so 30m agentic runs aren't
    # handicapped by constant context compaction relative to the 200K+ models
    # they're benchmarked against. Costs exactly 2× the 64K row.
    "thinkingmachines/Inkling:peft:262144": {
        "name": "Inkling (256K)",
        "cost": {"input": 3.74, "output": 9.36, "cache_read": 0.748},
        "limit": {"context": 262144, "output": 32768},
    },
    # 64K base variant — cheaper, kept for reference / cost-sensitive reruns.
    "thinkingmachines/Inkling": {
        "name": "Inkling (64K)",
        "cost": {"input": 1.87, "output": 4.68, "cache_read": 0.374},
        "limit": {"context": 65536, "output": 32768},
    },
}


class InklingOpenCode(OpenCodeAdapter):
    _default_model = "tinker/thinkingmachines/Inkling:peft:262144"
    _log_prefix = "inkling"
    _log_file = "opencode-inkling.txt"

    @staticmethod
    def name() -> str:
        return "inkling-opencode"

    def _build_opencode_config(self) -> dict:
        """Layer the custom `tinker` provider onto the base config.

        The base class already sets provider=`tinker` (from the model prefix),
        the 180s request timeout, and the top-level `model` string. We add the
        npm package, endpoint, API key reference, and model metadata that a
        non-models.dev provider needs.
        """
        config = super()._build_opencode_config()

        provider = config["provider"].get("tinker")
        if provider is None:
            # Model ID isn't tinker-prefixed — leave the base config untouched
            # rather than silently misconfiguring a different provider.
            return config

        provider["npm"] = "@ai-sdk/openai-compatible"
        provider["name"] = "Tinker"
        provider["options"]["baseURL"] = _TINKER_BASE_URL
        # OpenCode substitutes {env:VAR} at config load. NOTE: an unset var
        # substitutes to empty string silently, hence the guard in
        # run-common.sh that skips this model when TINKER_API_KEY is absent.
        provider["options"]["apiKey"] = "{env:TINKER_API_KEY}"

        # Attach cost/limit for whichever Inkling variant is selected, keeping
        # any options the base class placed on the model entry.
        for model_suffix, meta in _INKLING_MODELS.items():
            if model_suffix in provider["models"]:
                provider["models"][model_suffix] = {
                    **provider["models"][model_suffix],
                    **meta,
                }

        return config
