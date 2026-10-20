"""
Custom Harbor adapters for NVIDIA Nemotron via OpenCode + OpenRouter.

Nemotron3UltraOpenCode   — nemotron-3-ultra-550b-a55b, pinned to BaseTen (fp4).
Nemotron35SuperOpenCode  — nemotron-3.5-super-vl, pinned to Together.

Both pinned to one endpoint with no fallbacks (laguna/inkling pattern) so a
later-added provider can't change the environment mid-comparison. Every
Nemotron 3 Ultra endpoint is fp4/fp8; BaseTen is OpenRouter's list price and
has the largest max-output (182k vs DeepInfra's 16k). Both endpoints support
`tools`/`tool_choice` and serve reasoning ON by default (probed 2026-10-20),
so no effort override. Declares explicit `cost` in opencode.json so OpenCode
reports real per-step cost_usd even if models.dev lags on these models.

Usage with Harbor:
    PYTHONPATH=. harbor run \
        --agent-import-path 'nemotron_adapter:Nemotron3UltraOpenCode' \
        -m 'openrouter/nvidia/nemotron-3-ultra-550b-a55b' \
        -p tasks/woodcutting-xp-30m
"""

from opencode_adapter import OpenCodeAdapter


class _PinnedOpenRouter(OpenCodeAdapter):
    _or_model: str
    _provider: str
    # Per-1M rates (OpenRouter endpoints API, 2026-10-20). Keep in sync with
    # shared/pricing.ts.
    _cost: dict
    _limit: dict

    def _build_opencode_config(self) -> dict:
        config = super()._build_opencode_config()
        models = config["provider"]["openrouter"]["models"]
        models[self._or_model] = {
            **models.get(self._or_model, {}),
            "cost": self._cost,
            "limit": self._limit,
        }
        return config


class Nemotron3UltraOpenCode(_PinnedOpenRouter):
    _default_model = "openrouter/nvidia/nemotron-3-ultra-550b-a55b"
    _or_model = "nvidia/nemotron-3-ultra-550b-a55b"
    _log_prefix = "nemotron3ultra"
    _log_file = "opencode-nemotron3ultra.txt"
    _model_options = {"provider": {"order": ["baseten"], "allow_fallbacks": False}}
    _cost = {"input": 0.60, "output": 2.40, "cache_read": 0.12}
    _limit = {"context": 202800, "output": 32768}

    @staticmethod
    def name() -> str:
        return "nemotron3ultra-opencode"


class Nemotron35SuperOpenCode(_PinnedOpenRouter):
    _default_model = "openrouter/nvidia/nemotron-3.5-super-vl"
    _or_model = "nvidia/nemotron-3.5-super-vl"
    _log_prefix = "nemotron35super"
    _log_file = "opencode-nemotron35super.txt"
    _model_options = {"provider": {"order": ["together"], "allow_fallbacks": False}}
    _cost = {"input": 0.15, "output": 0.50, "cache_read": 0.02}
    _limit = {"context": 262144, "output": 32768}

    @staticmethod
    def name() -> str:
        return "nemotron35super-opencode"
