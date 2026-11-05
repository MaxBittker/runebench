"""
Custom Harbor adapter for Kimi K3.1 Pro via OpenCode + OpenRouter.

Pinned to fast mxfp4 serving: provider order modal → inference-net, no other
fallbacks. Both serve mxfp4, the same quant as Moonshot's own endpoint.
Tool-call probes on 2026-11-05 measured Modal at ~210 tok/s end-to-end and
InferenceNet at ~160; OpenRouter's p50 for Moonshot's own endpoint was 25.

History: the first K3.1 Pro row (2026-10-23) ran through the Kimi Code
subscription endpoint (api.kimi.com/coding/v1) before the model reached
OpenRouter. That serving was slow (50 effective tok/s vs 77 here). The run
was replaced on 2026-11-05; its jobs are archived at
jobs/_archive-kimi31pro-kimicode-20261105.

Effort is pinned to "max", the Kimi Code server's default for k3.1-pro.

Cost: OpenRouter list $2/$10 per 1M, cache read $0.20 (Modal; the
InferenceNet fallback is $1.8/$9/$0.18, a slight overcount if it is used).
Keep in sync with 'kimi31pro' in shared/pricing.ts.

Usage with Harbor:
    PYTHONPATH=. harbor run \\
        --agent-import-path 'kimi31pro_adapter:Kimi31ProOpenCode' \\
        -m 'openrouter/moonshotai/kimi-k3.1-pro' \\
        -p tasks -i 'woodcutting-xp-30m'
"""

from opencode_adapter import OpenCodeAdapter


class Kimi31ProOpenCode(OpenCodeAdapter):
    _default_model = "openrouter/moonshotai/kimi-k3.1-pro"
    _or_model = "moonshotai/kimi-k3.1-pro"
    _log_prefix = "kimi31pro"
    _log_file = "opencode-kimi31pro.txt"
    _model_options = {
        "provider": {"order": ["modal", "inference-net"], "allow_fallbacks": False},
        "reasoning": {"effort": "max"},
    }

    @staticmethod
    def name() -> str:
        return "kimi31pro-opencode"

    def _build_opencode_config(self) -> dict:
        config = super()._build_opencode_config()
        models = config["provider"]["openrouter"]["models"]
        models[self._or_model] = {
            **models.get(self._or_model, {}),
            "name": "Kimi K3.1 Pro",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "cost": {"input": 2.0, "output": 10.0, "cache_read": 0.2},
            "limit": {"context": 1048576, "output": 131072},
        }
        return config
