"""
Custom Harbor adapter for Inkling (Thinking Machines) via OpenCode + OpenRouter,
pinned to the Together endpoint (the model's only OpenRouter provider as of
2026-07-21; pinned so a later-added provider can't change the environment
mid-comparison). Together's endpoint supports `tools`/`tool_choice` (verified
via the OpenRouter endpoints API).

Replaces the earlier Tinker-direct adapter (custom openai-compatible provider
against tinker.thinkingmachines.dev) — that run was removed and re-benchmarked
on OpenRouter, which serves the full 524K-context model at lower rates.

Declares explicit `cost` in opencode.json so OpenCode reports real per-step
cost_usd even if models.dev lags on this model — no postprocess backfill needed.

Usage with Harbor:
    PYTHONPATH=. harbor run \
        --agent-import-path 'inkling_adapter:InklingOpenCode' \
        -m 'openrouter/thinkingmachines/inkling' \
        -p tasks/woodcutting-xp-30m
"""

from opencode_adapter import OpenCodeAdapter

# Together endpoint rates per 1M tokens (OpenRouter endpoints API, 2026-07-21).
# Keep in sync with the 'inkling' entry in shared/pricing.ts.
_COST = {"input": 1.0, "output": 4.05, "cache_read": 0.17}
_LIMIT = {"context": 524288, "output": 32768}


class InklingOpenCode(OpenCodeAdapter):
    _default_model = "openrouter/thinkingmachines/inkling"
    _log_prefix = "inkling"
    _log_file = "opencode-inkling.txt"
    _model_options = {
        "provider": {
            "order": ["together"],
            "allow_fallbacks": False,
        },
        # Together serves inkling with reasoning effectively OFF by default
        # (10-25 reasoning tokens/step observed in the 2026-07-21 run, vs
        # ~250 output tokens/step when Tinker served it). Request high effort;
        # verify post-run via step_finish tokens.reasoning that it isn't inert.
        "reasoning": {"effort": "high"},
    }

    @staticmethod
    def name() -> str:
        return "inkling-opencode"

    def _build_opencode_config(self) -> dict:
        config = super()._build_opencode_config()
        models = config["provider"]["openrouter"]["models"]
        models["thinkingmachines/inkling"] = {
            **models.get("thinkingmachines/inkling", {}),
            "cost": _COST,
            "limit": _LIMIT,
        }
        return config
