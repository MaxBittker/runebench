"""
Custom Harbor adapter for Kimi K3 via OpenCode + OpenRouter.

Usage with Harbor:
    PYTHONPATH=. harbor run \
        --agent-import-path 'kimi3_adapter:Kimi3OpenCode' \
        -m 'openrouter/moonshotai/kimi-k3' \
        -p tasks/woodcutting-xp-15m
"""

from opencode_adapter import OpenCodeAdapter


class Kimi3OpenCode(OpenCodeAdapter):
    _default_model = "openrouter/moonshotai/kimi-k3"
    _log_prefix = "kimi3"
    _log_file = "opencode-kimi3.txt"

    @staticmethod
    def name() -> str:
        return "kimi3-opencode"


class Kimi3LowOpenCode(Kimi3OpenCode):
    # DEAD END — DO NOT USE FOR COMPARISONS. `reasoning.effort` is INERT on
    # moonshotai/kimi-k3: setting it "low" does not reduce reasoning tokens.
    _model_options = {
        "reasoning": {"effort": "low"},
    }
    _log_prefix = "kimi3-low"
    _log_file = "opencode-kimi3-low.txt"

    @staticmethod
    def name() -> str:
        return "kimi3-low-opencode"
