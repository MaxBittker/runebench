"""
Custom Harbor adapter for Tencent Hy4 preview via OpenCode + OpenRouter.

Hy4PreviewOpenCode — tencent/hy4-preview (770B MoE, 49B active), pinned to the
sole Tencent endpoint (fp8) with no fallbacks (nemotron/laguna pattern). The
endpoint supports `tools`/`tool_choice` and serves reasoning ON by default
(probed 2026-10-26), so no effort override.

Tencent bills by time of day: 00:00–16:00 UTC $0.834/$2.501 (cache read
$0.042), 16:00–24:00 UTC $0.7506/$2.2509 (cache read $0.0378). The declared
`cost` is the 16:00–24:00 rate the first sweep ran in (2026-10-26 ~21:00 UTC).

Usage with Harbor:
    PYTHONPATH=. harbor run \
        --agent-import-path 'hy4_adapter:Hy4PreviewOpenCode' \
        -m 'openrouter/tencent/hy4-preview' \
        -p tasks/woodcutting-xp-30m
"""

from nemotron_adapter import _PinnedOpenRouter


class Hy4PreviewOpenCode(_PinnedOpenRouter):
    _default_model = "openrouter/tencent/hy4-preview"
    _or_model = "tencent/hy4-preview"
    _log_prefix = "hy4preview"
    _log_file = "opencode-hy4preview.txt"
    _model_options = {"provider": {"order": ["tencent"], "allow_fallbacks": False}}
    # Per-1M rates (OpenRouter endpoints API, 2026-10-26). Keep in sync with
    # shared/pricing.ts.
    _cost = {"input": 0.7506, "output": 2.2509, "cache_read": 0.0378}
    _limit = {"context": 1048576, "output": 32768}

    @staticmethod
    def name() -> str:
        return "hy4preview-opencode"
