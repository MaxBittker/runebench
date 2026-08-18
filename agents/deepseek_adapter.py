"""
Custom Harbor adapter for DeepSeek V4 Pro via OpenCode + OpenRouter.

Usage with Harbor:
    PYTHONPATH=. harbor run \
        --agent-import-path 'deepseek_adapter:DeepSeekOpenCode' \
        -m 'openrouter/deepseek/deepseek-v4-pro' \
        -p tasks/woodcutting-xp-15m
"""

from opencode_adapter import OpenCodeAdapter


class DeepSeekOpenCode(OpenCodeAdapter):
    _default_model = "openrouter/deepseek/deepseek-v4-pro"
    _log_prefix = "deepseek"
    _log_file = "opencode-deepseek.txt"

    @staticmethod
    def name() -> str:
        return "deepseek-opencode"


class DeepSeekFlashOpenCode(OpenCodeAdapter):
    _default_model = "openrouter/deepseek/deepseek-v4-flash"
    _log_prefix = "deepseekflash"
    _log_file = "opencode-deepseekflash.txt"

    @staticmethod
    def name() -> str:
        return "deepseekflash-opencode"


# DeepInfra fp4 endpoint rates per 1M tokens (OpenRouter endpoints API, 2026-08-03).
# Keep in sync with the 'deepseekflash0731' entry in shared/pricing.ts.
_FLASH0731_COST = {"input": 0.09, "output": 0.18, "cache_read": 0.018}
_FLASH0731_LIMIT = {"context": 1048576, "output": 65536}


class DeepSeekFlash0731OpenCode(OpenCodeAdapter):
    """deepseek-v4-flash-0731 pinned to the DeepInfra fp4 endpoint.

    Declares explicit `cost` in opencode.json so OpenCode reports the DeepInfra
    endpoint's real rates instead of the models.dev baseline.
    """

    _default_model = "openrouter/deepseek/deepseek-v4-flash-0731"
    _log_prefix = "deepseekflash0731"
    _log_file = "opencode-deepseekflash0731.txt"
    _model_options = {
        "provider": {
            "order": ["deepinfra"],
            "allow_fallbacks": False,
        }
    }

    @staticmethod
    def name() -> str:
        return "deepseekflash0731-opencode"

    def _build_opencode_config(self) -> dict:
        config = super()._build_opencode_config()
        models = config["provider"]["openrouter"]["models"]
        models["deepseek/deepseek-v4-flash-0731"] = {
            **models.get("deepseek/deepseek-v4-flash-0731", {}),
            "cost": _FLASH0731_COST,
            "limit": _FLASH0731_LIMIT,
        }
        return config
