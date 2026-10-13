"""
Custom Harbor adapter for Gemini 4 Argon via OpenCode + OpenRouter.

Gemini 4 Argon (Google's flagship reasoning model) was listed on OpenRouter
2026-10-13. Runs through OpenRouter like the 3.8 Flash row because the Google
API keys on hand are still invalid. OpenRouter serves it from Google first-party
endpoints only, in three tiers: standard ($2/$10 per 1M, cache read $0.20),
"flex" (half price) and "priority" (1.8×). We pin the STANDARD AI Studio and
Vertex endpoints with no fallbacks, so neither discounted-and-slower flex nor
premium priority serving can slip in. (Bare "google-ai-studio" in the order
was verified to hit the standard tier: a probe was billed at $2/$10.)

Reasoning is mandatory on this model; effort is left at the endpoint
default (medium).

Cost: launch billing is Google's introductory HALF-PRICE promo ($2/$10, cache
read $0.10); the regular card is $4/$20 (cache read $0.20, write $0.375). The
row displays the regular price so it stays comparable once the promo ends (same
decision as muse12/13), so _build_opencode_config pins OpenCode's per-step cost
to the regular card. The 2026-10-13 run predates this override; its costs were
rescaled afterwards from the logged per-step tokens (exactly 2x the billed cost).

Usage with Harbor:
    PYTHONPATH=. harbor run \
        --agent-import-path 'gemini4argon_adapter:Gemini4ArgonOpenCode' \
        -m 'openrouter/google/gemini-4-argon' \
        -p tasks/woodcutting-xp-30m
"""

from opencode_adapter import OpenCodeAdapter


class Gemini4ArgonOpenCode(OpenCodeAdapter):
    _default_model = "openrouter/google/gemini-4-argon"
    _log_prefix = "gemini4argon"
    _log_file = "opencode-gemini4argon.txt"
    _model_options = {
        "provider": {
            "order": ["google-ai-studio", "google-vertex/global"],
            "allow_fallbacks": False,
        }
    }

    @staticmethod
    def name() -> str:
        return "gemini4argon-opencode"

    def _build_opencode_config(self) -> dict:
        """Pin per-step cost to the regular (non-promo) card; keep in sync with
        'gemini4argon' in shared/pricing.ts."""
        config = super()._build_opencode_config()
        models = config["provider"]["openrouter"]["models"]
        models["google/gemini-4-argon"] = {
            **models.get("google/gemini-4-argon", {}),
            "cost": {"input": 4, "output": 20, "cache_read": 0.2, "cache_write": 0.375},
        }
        return config
