"""
Custom Harbor adapter for Mistral Large 4 via OpenCode + OpenRouter.

Usage with Harbor:
    PYTHONPATH=. harbor run \
        --agent-import-path 'mistrallarge4_adapter:MistralLarge4OSSOpenCode' \
        -m 'openrouter/mistralai/mistral-large-4-0' \
        -p tasks/woodcutting-xp-30m
"""

from opencode_adapter import OpenCodeAdapter

# Mistral first-party endpoint list rates per 1M tokens (OpenRouter endpoints API,
# 2026-10-30; the run was billed exactly at these rates).
# Keep in sync with the 'mistrallarge4oss' entry in shared/pricing.ts.
_COST = {"input": 0.70, "output": 2.10, "cache_read": 0.07}
_LIMIT = {"context": 1048576, "output": 262144}


class MistralLarge4OSSOpenCode(OpenCodeAdapter):
    """Open-weight Mistral Large 4 (Mistral-Large-4-1T-A52B), pinned to Mistral.

    Mistral's open-weight release (2026-10-29) is the Oct-6 preview plus ~3 weeks
    more RL, served under the unchanged `mistral-large-4-0` slug — the preview is
    no longer reachable (its rows were archived). The endpoint changed with it:
    reasoning is ON when unset (Mistral: High is default; probe 2026-10-30 → 173
    reasoning tokens vs 0 on 2026-10-06), so reasoning is left unset per the
    provider-default convention. Pinning keeps a later third-party host from
    silently entering the row; cost/limit are declared because the image's
    models.dev snapshot predates the release.
    """

    _default_model = "openrouter/mistralai/mistral-large-4-0"
    _log_prefix = "mistrallarge4oss"
    _log_file = "opencode-mistrallarge4oss.txt"
    _model_options = {
        "provider": {
            "order": ["mistral"],
            "allow_fallbacks": False,
        }
    }

    @staticmethod
    def name() -> str:
        return "mistrallarge4oss-opencode"

    def _build_opencode_config(self) -> dict:
        config = super()._build_opencode_config()
        models = config["provider"]["openrouter"]["models"]
        models["mistralai/mistral-large-4-0"] = {
            **models.get("mistralai/mistral-large-4-0", {}),
            "cost": _COST,
            "limit": _LIMIT,
        }
        return config
