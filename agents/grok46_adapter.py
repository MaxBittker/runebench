"""
Custom Harbor adapter for Grok 4.6 via OpenCode + OpenRouter.

Usage with Harbor:
    PYTHONPATH=. harbor run \
        --agent-import-path 'grok46_adapter:Grok46OpenCode' \
        -m 'openrouter/x-ai/grok-4.6' \
        -p tasks/woodcutting-xp-15m
"""

from opencode_adapter import OpenCodeAdapter


class Grok46OpenCode(OpenCodeAdapter):
    _default_model = "openrouter/x-ai/grok-4.6"
    _log_prefix = "grok46"
    _log_file = "opencode-grok46.txt"

    @staticmethod
    def name() -> str:
        return "grok46-opencode"


class Grok46MediumOpenCode(Grok46OpenCode):
    # Same rate card as the base row — medium effort just emits fewer reasoning
    # tokens (billed as output). Base row leaves effort unset (xAI default).
    _model_options = {
        "reasoning": {"effort": "medium"},
    }
    _log_prefix = "grok46-medium"
    _log_file = "opencode-grok46-medium.txt"

    @staticmethod
    def name() -> str:
        return "grok46-medium-opencode"


class Grok46XhighOpenCode(Grok46OpenCode):
    # NOTE: on grok-4.5 xAI accepted "xhigh" but treated it as high (verified
    # 2026-07-23 via reasoning-token probes), which is why the old grok45-xhigh
    # row was relabeled. Re-verify for 4.6 before reading any delta as real.
    _model_options = {
        "reasoning": {"effort": "xhigh"},
    }
    _log_prefix = "grok46-xhigh"
    _log_file = "opencode-grok46-xhigh.txt"

    @staticmethod
    def name() -> str:
        return "grok46-xhigh-opencode"
