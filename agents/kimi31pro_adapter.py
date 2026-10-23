"""
Custom Harbor adapter for Kimi K3.1 Pro via OpenCode + the Kimi Code
subscription endpoint (api.kimi.com/coding/v1).

K3.1 Pro launched 2026-10-23 as a Kimi Code exclusive — no OpenRouter route
and no published per-token rate. `kimi-code-plan-cn` is a native models.dev
provider (npm @ai-sdk/openai-compatible, env KIMI_API_KEY) but its registry
doesn't list k3.1-pro yet, so the model block is declared here (fields copied
from the registry's k3 entry). The key is the subscription's static `sk-kimi`
coding key, not the CLI's OAuth access token: those expire after 15 min and
16 sandboxes sharing one rotating refresh token would collide.

Reasoning is mandatory; the server default effort for k3.1-pro is "max"
(/coding/v1/models, 2026-10-23) and no override is sent.

The registry declares coding-plan models at $0 (subscription billing). Like
glm53, `cost` is overridden with a stand-in list price: Kimi K3's official
rate card ($3/$15 per 1M, cache read $0.30) until K3.1 Pro rates publish.
Keep in sync with 'kimi31pro' in shared/pricing.ts.

Usage with Harbor:
    PYTHONPATH=. harbor run \
        --agent-import-path 'kimi31pro_adapter:Kimi31ProOpenCode' \
        -m 'kimi-code-plan-cn/k3.1-pro' \
        -p tasks -i 'woodcutting-xp-30m'
"""

from opencode_adapter import OpenCodeAdapter

_MODEL_ID = "kimi-code-plan-cn/k3.1-pro"
_MODEL_SUFFIX = "k3.1-pro"

# Kimi K3 official rate card — stand-in for unpublished K3.1 Pro rates.
_COST = {"input": 3.0, "output": 15.0, "cache_read": 0.3}
_LIMIT = {"context": 1048576, "output": 131072}


class Kimi31ProOpenCode(OpenCodeAdapter):
    _default_model = _MODEL_ID
    _log_prefix = "kimi31pro"
    _log_file = "opencode-kimi31pro.txt"

    @staticmethod
    def name() -> str:
        return "kimi31pro-opencode"

    def _build_opencode_config(self) -> dict:
        config = super()._build_opencode_config()
        models = config["provider"][_MODEL_ID.split("/", 1)[0]]["models"]
        models[_MODEL_SUFFIX] = {
            **models.get(_MODEL_SUFFIX, {}),
            "name": "Kimi K3.1 Pro",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "temperature": False,
            "interleaved": {"field": "reasoning_content"},
            "cost": _COST,
            "limit": _LIMIT,
        }
        return config
