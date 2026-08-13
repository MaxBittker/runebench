"""
Custom Harbor adapters for Meta Muse Spark.

MuseSparkOpenCode        — muse-spark-1.1 via the Meta Model API direct.
Muse12ContributorOpenCode — muse-spark-1.2-contributor via the Meta Model API direct.

The muse row originally ran via OpenCode + OpenRouter; the 2026-08-12 Meta-API
run replaced it (old jobs in jobs/_archive-muse-openrouter-20260813).

`meta` is a native models.dev provider (npm @ai-sdk/openai, baseURL
api.meta.ai/v1, env META_MODEL_API_KEY), so OpenCode resolves it from its
built-in registry — including per-model cost, so OpenCode reports real
per-step cost_usd with no postprocess-costs backfill. Do NOT override the
provider's npm package in opencode.json: the models are served through the
OpenAI Responses API, and forcing @ai-sdk/openai-compatible (chat-completions
only) makes every request die with "Z.responses is not a function". The only
non-default wiring these models need is META_MODEL_API_KEY forwarded into the
sandbox (handled by _PROVIDER_KEY_MAP in opencode_adapter.py).

Usage with Harbor:
    PYTHONPATH=. harbor run \
        --agent-import-path 'muse_adapter:Muse12ContributorOpenCode' \
        -m 'meta/muse-spark-1.2-contributor' \
        -p tasks/woodcutting-xp-30m
"""

from opencode_adapter import OpenCodeAdapter


class MuseSparkOpenCode(OpenCodeAdapter):
    _default_model = "meta/muse-spark-1.1"
    _log_prefix = "muse"
    _log_file = "opencode-muse.txt"

    @staticmethod
    def name() -> str:
        return "muse-opencode"


class Muse12ContributorOpenCode(OpenCodeAdapter):
    _default_model = "meta/muse-spark-1.2-contributor"
    _log_prefix = "muse12"
    _log_file = "opencode-muse12.txt"

    @staticmethod
    def name() -> str:
        return "muse12-opencode"

    def _build_opencode_config(self) -> dict:
        """Pin the muse12 row's cost to the muse-spark-1.2 STANDARD rate card.

        The contributor tier actually bills ~95% less ($0.10/$0.20, cache read
        $0.002) in exchange for training-data consent, but the leaderboard
        displays list price for comparability. Overriding only `cost` is safe —
        unlike overriding `npm`, which breaks the Responses-API runtime (see
        module docstring). Keep in sync with 'muse12' in shared/pricing.ts.
        """
        config = super()._build_opencode_config()
        models = config["provider"]["meta"]["models"]
        models["muse-spark-1.2-contributor"] = {
            **models.get("muse-spark-1.2-contributor", {}),
            "cost": {"input": 1.25, "output": 4.25, "cache_read": 0.15},
        }
        return config
