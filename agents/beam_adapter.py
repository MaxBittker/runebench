"""
Custom Harbor adapter for Reflection Beam-1.0-501B-A23B via OpenCode + the
Reflection API directly (api.reflection.ai — no OpenRouter route).

The Reflection API is OpenAI-compatible, so OpenCode reaches it through a
custom `reflection` provider block (@ai-sdk/openai-compatible) keyed by
REFLECTION_API_KEY. Reasoning is mandatory and defaults to effort=max
(/openai/v1/models, 2026-10-19); no effort override is set. No public pricing
yet → no `cost` block, so OpenCode reports cost_usd = 0.

Usage with Harbor:
    PYTHONPATH=. harbor run \
        --agent-import-path 'beam_adapter:BeamOpenCode' \
        -m 'reflection/Beam-1.0-501B-A23B' \
        -p tasks -i 'woodcutting-xp-30m'
"""

from opencode_adapter import OpenCodeAdapter

_MODEL_ID = "reflection/Beam-1.0-501B-A23B"
_MODEL_SUFFIX = "Beam-1.0-501B-A23B"

# /openai/v1/models: context_length 1048576, max_output_tokens 131072
# (default max_tokens 32768 — kept as the per-step output cap).
_LIMIT = {"context": 1048576, "output": 32768}


class _ReflectionProviderMixin:
    """Rewrites the auto-generated `reflection` provider block into a full
    custom OpenAI-compatible provider declaration (the Reflection API is not a
    provider OpenCode knows natively)."""

    def _build_opencode_config(self) -> dict:
        config = super()._build_opencode_config()
        provider = config["provider"][_MODEL_ID.split("/", 1)[0]]
        provider["npm"] = "@ai-sdk/openai-compatible"
        provider["name"] = "Reflection API"
        provider["options"] = {
            **provider.get("options", {}),
            "baseURL": "https://api.reflection.ai/openai/v1",
            "apiKey": "{env:REFLECTION_API_KEY}",
        }
        models = provider["models"]
        models[_MODEL_SUFFIX] = {
            **models.get(_MODEL_SUFFIX, {}),
            "name": "Beam 1.0 501B-A23B",
            "limit": _LIMIT,
        }
        return config


class BeamOpenCode(_ReflectionProviderMixin, OpenCodeAdapter):
    _default_model = _MODEL_ID
    _log_prefix = "beam"
    _log_file = "opencode-beam.txt"

    @staticmethod
    def name() -> str:
        return "beam-opencode"

