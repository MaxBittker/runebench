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


class Grok45XhighOpenCode(Grok45OpenCode):
    # OpenRouter forwards reasoning.effort to xAI; both "high" and "xhigh"
    # are accepted for grok-4.5.
    _model_options = {
        "reasoning": {"effort": "xhigh"},
    }
    _log_prefix = "grok45-xhigh"
    _log_file = "opencode-grok45-xhigh.txt"

    @staticmethod
    def name() -> str:
        return "grok45-xhigh-opencode"
