"""
Custom Harbor adapter for Meta Muse Spark 1.2 (contributor tier) via OpenCode +
the Meta Model API directly (api.meta.ai — the model has no OpenRouter route,
unlike muse-spark-1.1).

The Model API is OpenAI-compatible, so OpenCode reaches it through a custom
`meta` provider block (@ai-sdk/openai-compatible) keyed by META_API_KEY.
Declares explicit `cost` in opencode.json so OpenCode reports real per-step
cost_usd without a models.dev entry (contributor tier: $0.10/$0.002/$0.20 per
1M input/cached/output, dev.meta.ai pricing page 2026-08-13). Keep in sync
with the 'muse12' entry in shared/pricing.ts.

Usage with Harbor:
    PYTHONPATH=. harbor run \
        --agent-import-path 'muse12_adapter:Muse12OpenCode' \
        -m 'meta/muse-spark-1.2-contributor' \
        -p tasks/smith-team-45m-n6
"""

from opencode_adapter import OpenCodeAdapter
from opencode_team_adapter import OpenCodeTeamAdapter

_MODEL_ID = "meta/muse-spark-1.2-contributor"
_MODEL_SUFFIX = "muse-spark-1.2-contributor"

# Per-1M-token rates for the contributor tier; opencode `cost` is per 1M.
_COST = {"input": 0.10, "output": 0.20, "cache_read": 0.002}
_LIMIT = {"context": 1048576, "output": 32768}


class _MetaProviderMixin:
    """Rewrites the auto-generated `meta` provider block into a full custom
    OpenAI-compatible provider declaration (the Model API is not a provider
    OpenCode knows natively)."""

    def _build_opencode_config(self) -> dict:
        config = super()._build_opencode_config()
        provider = config["provider"][_MODEL_ID.split("/", 1)[0]]
        provider["npm"] = "@ai-sdk/openai-compatible"
        provider["name"] = "Meta Model API"
        provider["options"] = {
            **provider.get("options", {}),
            "baseURL": "https://api.meta.ai/v1",
            "apiKey": "{env:META_API_KEY}",
        }
        models = provider["models"]
        models[_MODEL_SUFFIX] = {
            **models.get(_MODEL_SUFFIX, {}),
            "name": "Muse Spark 1.2 (contributor)",
            "cost": _COST,
            "limit": _LIMIT,
        }
        return config


class Muse12OpenCode(_MetaProviderMixin, OpenCodeAdapter):
    _default_model = _MODEL_ID
    _log_prefix = "muse12"
    _log_file = "opencode-muse12.txt"

    @staticmethod
    def name() -> str:
        return "muse12-opencode"


class Muse12TeamAdapter(_MetaProviderMixin, OpenCodeTeamAdapter):
    """N concurrent Muse Spark 1.2 sessions (smith/magic/crafting-team).

    The team launch scripts rewrite --agent-import-path to the generic
    OpenCodeTeamAdapter for any *opencode* agent, which would drop the custom
    `meta` provider block — so the team rows need this explicit subclass.
    """

    _default_model = _MODEL_ID

    @staticmethod
    def name() -> str:
        return "muse12-team-adapter"
