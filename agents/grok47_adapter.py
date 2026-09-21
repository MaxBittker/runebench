"""
Custom Harbor adapter for Grok 4.7 via OpenCode + OpenRouter.

Usage with Harbor:
    PYTHONPATH=. harbor run \
        --agent-import-path 'grok47_adapter:Grok47OpenCode' \
        -m 'openrouter/x-ai/grok-4.7' \
        -p tasks/woodcutting-xp-15m
"""

from opencode_adapter import OpenCodeAdapter


class Grok47OpenCode(OpenCodeAdapter):
    # Base row leaves reasoning effort unset (xAI default), same as grok46.
    _default_model = "openrouter/x-ai/grok-4.7"
    _log_prefix = "grok47"
    _log_file = "opencode-grok47.txt"

    @staticmethod
    def name() -> str:
        return "grok47-opencode"


class Grok47XhighOpenCode(Grok47OpenCode):
    # grok-4.6 honored "xhigh" (completion tokens/step rose monotonically
    # medium < default < xhigh); grok-4.5 accepted it but ran high. Verify on
    # 4.7 via step_finish tokens.reasoning before reading any delta as real.
    _model_options = {
        "reasoning": {"effort": "xhigh"},
    }
    _log_prefix = "grok47-xhigh"
    _log_file = "opencode-grok47-xhigh.txt"

    @staticmethod
    def name() -> str:
        return "grok47-xhigh-opencode"
