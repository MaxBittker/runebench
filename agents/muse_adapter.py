"""
Custom Harbor adapters for Meta Muse Spark.

MuseSparkOpenCode        — muse-spark-1.1 via the Meta Model API direct.
Muse12ContributorOpenCode — muse-spark-1.2-contributor via the Meta Model API direct.
Muse13ContributorOpenRouter — muse-spark-1.3-contributor via OpenRouter (Meta endpoint).
MuseWonderOpenRouter     — muse-wonder via OpenRouter (Meta endpoint).
MuseWonderMetaOpenCode   — muse-wonder-1.0 via the Meta Model API direct.
MuseSparkOpenOpenRouter  — muse-spark-open (open weights) via OpenRouter third-party hosts.

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


class Muse13ContributorOpenRouter(OpenCodeAdapter):
    """muse-spark-1.3-contributor via OpenRouter (listed 2026-09-02).

    Runs through OpenRouter rather than api.meta.ai per request. OpenRouter has
    a single endpoint for this model (provider "Meta", tools supported, 1M ctx)
    — pinned anyway so a future third-party host can't silently take over.
    Needs the us-east sandbox pin: Meta 403s non-US clients ("only available
    in the United States") exactly like the OpenRouter muse 1.1 run did.
    """
    _default_model = "openrouter/meta/muse-spark-1.3-contributor"
    _log_prefix = "muse13"
    _log_file = "opencode-muse13.txt"
    _model_options = {
        "provider": {
            "order": ["meta"],
            "allow_fallbacks": False,
        }
    }

    @staticmethod
    def name() -> str:
        return "muse13-opencode"

    def _build_opencode_config(self) -> dict:
        """Pin the muse13 row's cost to the muse-spark-1.3 STANDARD rate card.

        Same decision as muse12: the contributor tier bills $0.10/$0.20 per 1M
        (cache read $0.002) for training-data consent, but the leaderboard
        displays the standard list price ($1.25/$4.25, cache read $0.15 — the
        same card as 1.1/1.2) so the row is comparable. Keep in sync with
        'muse13' in shared/pricing.ts.
        """
        config = super()._build_opencode_config()
        models = config["provider"]["openrouter"]["models"]
        models["meta/muse-spark-1.3-contributor"] = {
            **models.get("meta/muse-spark-1.3-contributor", {}),
            "cost": {"input": 1.25, "output": 4.25, "cache_read": 0.15},
        }
        return config


class MuseWonderOpenRouter(OpenCodeAdapter):
    """muse-wonder via OpenRouter (listed 2026-10-12).

    Single "Meta" endpoint on OpenRouter (tools supported, 1M ctx), pinned so a
    future third-party host can't silently take over. Standard paid tier
    ($4/$20, cache read $0.20), so OpenRouter's native cost is the displayed
    cost — no override. Needs the us-east sandbox pin like the other muse rows.
    """
    _default_model = "openrouter/meta/muse-wonder"
    _log_prefix = "musewonder"
    _log_file = "opencode-musewonder.txt"
    _model_options = {
        "provider": {
            "order": ["meta"],
            "allow_fallbacks": False,
        }
    }

    @staticmethod
    def name() -> str:
        return "musewonder-opencode"


class MuseWonderMetaOpenCode(OpenCodeAdapter):
    """muse-wonder-1.0 via the Meta Model API direct (api.meta.ai), 2026-10-12.

    Same model as MuseWonderOpenRouter, served first-party instead of through
    OpenRouter. models.dev lists muse-wonder-1.0 under the native `meta`
    provider but with NO cost block, so OpenCode would report $0 per step —
    declare the standard paid card ($4/$20, cache read $0.20; same as the
    OpenRouter listing). Cost-only override is safe (see module docstring).
    Keep in sync with 'musewonder-meta' in shared/pricing.ts.
    """
    _default_model = "meta/muse-wonder-1.0"
    _log_prefix = "musewonder-meta"
    _log_file = "opencode-musewonder-meta.txt"

    @staticmethod
    def name() -> str:
        return "musewonder-meta-opencode"

    def _build_opencode_config(self) -> dict:
        config = super()._build_opencode_config()
        models = config["provider"]["meta"]["models"]
        models["muse-wonder-1.0"] = {
            **models.get("muse-wonder-1.0", {}),
            "cost": {"input": 4.0, "output": 20.0, "cache_read": 0.20},
        }
        return config


class MuseSparkOpenOpenRouter(OpenCodeAdapter):
    """muse-spark-open via OpenRouter (listed 2026-10-15) — Meta's open-weight
    Muse Spark (HF meta-models/Muse-Spark-Open-816B-A42B).

    Served by third-party hosts only, all at the same card ($1.25/$4.25, cache
    read $0.15). Restricted to the three non-fp4 endpoints (Together, Fireworks,
    Modal; Nebius and BaseTen are fp4) with no fallbacks beyond them — a
    single-host pin risks 429-throttled fake zeros at -n 16 (inkling/Together).
    Reasoning is on by default on all three (probed 2026-10-20), so no effort
    override. Not served by Meta, so no us-east pin needed. models.dev may not
    list it yet → declare cost so OpenCode reports real cost_usd.
    Keep in sync with 'musesparkopen' in shared/pricing.ts.
    """
    _default_model = "openrouter/meta/muse-spark-open"
    _log_prefix = "musesparkopen"
    _log_file = "opencode-musesparkopen.txt"
    _model_options = {
        "provider": {
            "order": ["together", "fireworks", "modal"],
            "allow_fallbacks": False,
        }
    }

    @staticmethod
    def name() -> str:
        return "musesparkopen-opencode"

    def _build_opencode_config(self) -> dict:
        config = super()._build_opencode_config()
        models = config["provider"]["openrouter"]["models"]
        models["meta/muse-spark-open"] = {
            **models.get("meta/muse-spark-open", {}),
            "cost": {"input": 1.25, "output": 4.25, "cache_read": 0.15},
            "limit": {"context": 1000000, "output": 131072},
        }
        return config
