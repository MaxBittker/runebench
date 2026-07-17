"""
Custom Harbor adapter for Meta Muse Spark 1.1 via OpenCode + OpenRouter.

Usage with Harbor:
    PYTHONPATH=. harbor run \
        --agent-import-path 'muse_adapter:MuseSparkOpenCode' \
        -m 'openrouter/meta/muse-spark-1.1' \
        -p tasks/woodcutting-xp-15m
"""

from opencode_adapter import OpenCodeAdapter


class MuseSparkOpenCode(OpenCodeAdapter):
    _default_model = "openrouter/meta/muse-spark-1.1"
    _log_prefix = "muse"
    _log_file = "opencode-muse.txt"

    @staticmethod
    def name() -> str:
        return "muse-opencode"
