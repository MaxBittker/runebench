"""
Custom Harbor adapter for Mistral Large 4 via OpenCode + OpenRouter.

Usage with Harbor:
    PYTHONPATH=. harbor run \
        --agent-import-path 'mistrallarge4_adapter:MistralLarge4OpenCode' \
        -m 'openrouter/mistralai/mistral-large-4-0' \
        -p tasks/woodcutting-xp-30m
"""

from opencode_adapter import OpenCodeAdapter

# Mistral first-party endpoint list rates per 1M tokens (OpenRouter endpoints API +
# models.dev, 2026-10-06). A probe was billed exactly at these rates (the endpoint's
# `discount: 0.5` field did not halve the bill). Reasoning left unset = OFF by default.
# Keep in sync with the 'mistrallarge4' entry in shared/pricing.ts.
_COST = {"input": 0.68, "output": 2.09, "cache_read": 0.07}
_LIMIT = {"context": 524288, "output": 262144}


class MistralLarge4OpenCode(OpenCodeAdapter):
    """mistral-large-4-0 pinned to the Mistral first-party endpoint.

    Mistral is the only endpoint at launch (2026-10-06); pinning keeps a later
    third-party host from silently entering the row. Cost/limit are declared in
    opencode.json because the image's models.dev snapshot predates the release.
    """

    _default_model = "openrouter/mistralai/mistral-large-4-0"
    _log_prefix = "mistrallarge4"
    _log_file = "opencode-mistrallarge4.txt"
    _model_options = {
        "provider": {
            "order": ["mistral"],
            "allow_fallbacks": False,
        }
    }

    @staticmethod
    def name() -> str:
        return "mistrallarge4-opencode"

    def _build_opencode_config(self) -> dict:
        config = super()._build_opencode_config()
        models = config["provider"]["openrouter"]["models"]
        models["mistralai/mistral-large-4-0"] = {
            **models.get("mistralai/mistral-large-4-0", {}),
            "cost": _COST,
            "limit": _LIMIT,
        }
        return config


class MistralLarge4HighOpenCode(MistralLarge4OpenCode):
    """Same pin, reasoning effort high.

    Unset, Mistral serves Large 4 with reasoning OFF (0 reasoning tokens/step);
    the base row scored Σ1562. Like inkling, this row checks whether turning
    reasoning on changes the picture — verify post-run via step_finish
    tokens.reasoning that it was honored.
    """

    _model_options = {
        **MistralLarge4OpenCode._model_options,
        "reasoning": {"effort": "high"},
    }
    _log_prefix = "mistrallarge4-high"
    _log_file = "opencode-mistrallarge4-high.txt"

    @staticmethod
    def name() -> str:
        return "mistrallarge4-high-opencode"
