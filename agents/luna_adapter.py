"""
Custom Harbor adapter for GPT-5.6 Luna via OpenCode + the OpenAI API.

The skill/gold rows for Luna run through the codex CLI (`codex_adapter`), but
the team tasks are OpenCode-only (there is no codex team adapter), so the team
rows drive the same model through OpenCode instead.

Usage with Harbor:
    PYTHONPATH=. harbor run \
        --agent-import-path 'luna_adapter:LunaXhighOpenCode' \
        -m 'openai/gpt-5.6-luna' \
        -p tasks/smith-team-30m-n6
"""

from opencode_adapter import OpenCodeAdapter
from opencode_solo_adapter import OpenCodeSoloTeamAdapter
from opencode_team_adapter import OpenCodeTeamAdapter


class LunaOpenCode(OpenCodeAdapter):
    _default_model = "openai/gpt-5.6-luna"
    _log_prefix = "gpt56luna"
    _log_file = "opencode-gpt56luna.txt"

    @staticmethod
    def name() -> str:
        return "luna-opencode"


class LunaXhighOpenCode(LunaOpenCode):
    # OpenCode's OpenAI provider passes model options straight through to the
    # AI SDK, which spells reasoning effort `reasoningEffort` (the OpenRouter
    # models use the nested {"reasoning": {"effort": ...}} form instead).
    _model_options = {
        "reasoningEffort": "xhigh",
    }
    _log_prefix = "gpt56luna-xhigh"
    _log_file = "opencode-gpt56luna-xhigh.txt"

    @staticmethod
    def name() -> str:
        return "luna-xhigh-opencode"


class LunaXhighTeamAdapter(OpenCodeTeamAdapter):
    """N concurrent Luna sessions at xhigh effort (smith/magic/crafting-team).

    The team launch scripts rewrite --agent-import-path to the generic
    OpenCodeTeamAdapter for any *opencode* agent, which would drop
    _model_options and leave Luna at OpenCode's default effort — so the team
    rows need this explicit subclass.
    """

    _default_model = LunaXhighOpenCode._default_model
    _model_options = LunaXhighOpenCode._model_options

    @staticmethod
    def name() -> str:
        return "luna-xhigh-team-adapter"


class LunaXhighSoloAdapter(OpenCodeSoloTeamAdapter):
    """ONE Luna session at xhigh effort controlling all N bots (--solo runs).

    Same rationale as LunaXhighTeamAdapter: the run scripts' --solo override
    points at the generic solo adapter, which would drop _model_options.
    """

    _default_model = LunaXhighOpenCode._default_model
    _model_options = LunaXhighOpenCode._model_options

    @staticmethod
    def name() -> str:
        return "luna-xhigh-solo-adapter"
