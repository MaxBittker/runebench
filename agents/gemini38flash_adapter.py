"""
Custom Harbor adapter for Gemini 3.8 Flash via OpenCode + OpenRouter.

Gemini 3.8 Flash launched 2026-09-02. Unlike the 3.6/3.7 Flash rows (which
went Google-direct through gemini_oc_adapter.py), this row runs through
OpenRouter because every Google API key on hand returned API_KEY_INVALID on
launch day. OpenRouter serves the model from Google first-party endpoints
only (Google AI Studio + Vertex) at Google's own rate card ($0.75/$3.75 per
1M, cache read $0.075), and models.dev carries the openrouter entry, so
OpenCode reports real per-step cost_usd — no postprocess backfill.

Usage with Harbor:
    PYTHONPATH=. harbor run \
        --agent-import-path 'gemini38flash_adapter:Gemini38FlashOpenCode' \
        -m 'openrouter/google/gemini-3.8-flash' \
        -p tasks/woodcutting-xp-30m
"""

from opencode_adapter import OpenCodeAdapter


class Gemini38FlashOpenCode(OpenCodeAdapter):
    _default_model = "openrouter/google/gemini-3.8-flash"
    _log_prefix = "gemini38flash"
    _log_file = "opencode-gemini38flash.txt"
    # Both OpenRouter endpoints are Google-operated; prefer AI Studio for
    # parity with the Google-direct 3.6/3.7 rows, fall back to Vertex.
    _model_options = {
        "provider": {
            "order": ["google-ai-studio", "google-vertex"],
            "allow_fallbacks": True,
        }
    }

    @staticmethod
    def name() -> str:
        return "gemini38flash-opencode"
