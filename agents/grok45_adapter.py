"""
Custom Harbor adapter for Grok 4.5 via OpenCode + OpenRouter.

Usage with Harbor:
    PYTHONPATH=. harbor run \
        --agent-import-path 'grok45_adapter:Grok45OpenCode' \
        -m 'openrouter/x-ai/grok-4.5' \
        -p tasks/woodcutting-xp-15m
"""

from opencode_adapter import OpenCodeAdapter


class Grok45OpenCode(OpenCodeAdapter):
    _default_model = "openrouter/x-ai/grok-4.5"
    _log_prefix = "grok45"
    _log_file = "opencode-grok45.txt"

    @staticmethod
    def name() -> str:
        return "grok45-opencode"


class Grok46OpenCode(OpenCodeAdapter):
    _default_model = "openrouter/x-ai/grok-4.6"
    _log_prefix = "grok46"
    _log_file = "opencode-grok46.txt"

    @staticmethod
    def name() -> str:
        return "grok46-opencode"


class Grok45MediumOpenCode(Grok45OpenCode):
    # xAI grok-4.5 honors reasoning_effort low/medium/high only (high is the
    # default). OpenRouter's schema also accepts "xhigh"/"max" but xAI treats
    # those the same as high — verified 2026-07-23 via reasoning-token probes.
    _model_options = {
        "reasoning": {"effort": "medium"},
    }
    _log_prefix = "grok45-medium"
    _log_file = "opencode-grok45-medium.txt"

    @staticmethod
    def name() -> str:
        return "grok45-medium-opencode"
