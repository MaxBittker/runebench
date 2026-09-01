"""
Custom Harbor adapter for GLM-5.3 via OpenCode + the z.ai API direct.

GLM-5.3 launched 2026-08-14 as a GLM Coding Plan exclusive — there is no
pay-as-you-go per-token rate yet (api.z.ai/api/paas/v4 doesn't serve it), so
this row runs on the coding-plan endpoint (api.z.ai/api/coding/paas/v4).
`zai-coding-plan` is a native models.dev provider (npm
@ai-sdk/openai-compatible, env ZHIPU_API_KEY), so OpenCode resolves it from
its built-in registry; the key is forwarded via _PROVIDER_KEY_MAP in
opencode_adapter.py.

The registry declares the coding-plan models at $0 (subscription billing).
Like the muse12 row, we override `cost` so the leaderboard shows a comparable
list price: GLM-5.2's official rate card ($1.40/$4.40 per 1M, cache read
$0.26) as a stand-in until z.ai publishes GLM-5.3 per-token rates.
Keep in sync with the 'glm53' entry in shared/pricing.ts, and UPDATE BOTH
once real 5.3 rates exist (postprocess-costs --force --models glm53).

Usage with Harbor:
    PYTHONPATH=. harbor run \
        --agent-import-path 'glm53_adapter:Glm53OpenCode' \
        -m 'zai-coding-plan/glm-5.3' \
        -p tasks/woodcutting-xp-30m
"""

from opencode_adapter import OpenCodeAdapter

# GLM-5.2 official z.ai rate card (docs.z.ai pricing, 2026-08-14) — stand-in
# for unpublished GLM-5.3 rates. Keep in sync with 'glm53' in shared/pricing.ts.
_COST = {"input": 1.4, "output": 4.4, "cache_read": 0.26}
_LIMIT = {"context": 1000000, "output": 131072}


class Glm53OpenCode(OpenCodeAdapter):
    _default_model = "zai-coding-plan/glm-5.3"
    _log_prefix = "glm53"
    _log_file = "opencode-glm53.txt"

    @staticmethod
    def name() -> str:
        return "glm53-opencode"

    def _build_opencode_config(self) -> dict:
        config = super()._build_opencode_config()
        models = config["provider"]["zai-coding-plan"]["models"]
        models["glm-5.3"] = {
            **models.get("glm-5.3", {}),
            "cost": _COST,
            "limit": _LIMIT,
        }
        return config
