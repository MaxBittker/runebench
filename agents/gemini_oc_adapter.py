"""
Custom Harbor adapters for the Gemini Flash family via OpenCode + the Google
API directly (GEMINI_API_KEY; the base adapter also exports it as
GOOGLE_GENERATIVE_AI_API_KEY for OpenCode's google provider).

Covers the 2026-07-21 launch pair: gemini-3.6-flash and gemini-3.5-flash-lite.
OpenCode is installed @latest per-sandbox (nothing is baked in the image), and
models.dev already carries both models' rate cards ($1.50/$7.50 and $0.30/$2.50
per 1M), so OpenCode reports real per-step cost_usd — no postprocess backfill.

Usage with Harbor:
    PYTHONPATH=. harbor run \
        --agent-import-path 'gemini_oc_adapter:Gemini36FlashOpenCode' \
        -m 'google/gemini-3.6-flash' \
        -p tasks/woodcutting-xp-30m
"""

from opencode_adapter import OpenCodeAdapter


class Gemini36FlashOpenCode(OpenCodeAdapter):
    _default_model = "google/gemini-3.6-flash"
    _log_prefix = "gemini36flash"
    _log_file = "opencode-gemini36flash.txt"

    @staticmethod
    def name() -> str:
        return "gemini36flash-opencode"


class Gemini35FlashLiteOpenCode(OpenCodeAdapter):
    _default_model = "google/gemini-3.5-flash-lite"
    _log_prefix = "gemini35flashlite"
    _log_file = "opencode-gemini35flashlite.txt"

    @staticmethod
    def name() -> str:
        return "gemini35flashlite-opencode"
