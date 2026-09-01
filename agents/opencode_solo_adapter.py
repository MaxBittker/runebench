"""
Solo-controller adapter for the multi-bot cooperative tasks
(smith/magic/crafting-team): ONE OpenCode session controls ALL N bots.

Comparison condition to opencode_team_adapter (N concurrent sessions, one per
bot, coordinating via in-game chat): the solo controller has zero
coordination overhead — no chat, no role negotiation — but a single stream of
attention across all bots. Same task dir, same bots, same wall-clock budget;
only the agent side differs. Launch via the team run scripts' --solo flag
(job names gain a -solo- marker, e.g. smith-team-n6-solo-<label>-<ts>).

The task instruction is written for a team (chat-only coordination, "do NOT
control a teammate's bot"), so the appended role addendum explicitly
overrides that framing.

Logs:   /logs/agent/opencode-solo.txt (single session)
Output: trajectory.json (single session, via the base adapter)
"""

import logging

from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from opencode_adapter import OpenCodeAdapter
from opencode_team_adapter import _resolve_bots

logger = logging.getLogger(__name__)

_SOLO_ADDENDUM = (
    "=== YOUR ROLE — SOLO CONTROLLER (overrides the team framing above) ===\n"
    "You are ONE agent controlling ALL {n} bots yourself: {bots}. There are no\n"
    "other players and no other agent sessions.\n"
    "- Issue commands to ANY bot by passing its bot_name to execute_code — every\n"
    "  bot is yours, so the \"do NOT control a teammate's bot\" rule does not\n"
    "  apply. All other rules still apply (legitimate in-game actions only; no\n"
    "  server-file edits, no cheat commands).\n"
    "- Do NOT use in-game chat — you are the only agent, so there is nobody to\n"
    "  talk to. Coordinate the bots by orchestrating their actions directly.\n"
    "- Move items between bots with the player-to-player trade API: stand two\n"
    "  bots together, then `await bot.trade(receiverName, {{ give: [...] }})` on\n"
    "  the giver while the receiver runs `await bot.serveTrades(...)` or\n"
    "  `await bot.acceptTrade()`. Banks are per-account, and whoever performs\n"
    "  the scoring action needs the level and materials personally.\n"
    "- Work the bots in parallel where useful: kick off a long-running script on\n"
    "  one bot, then command the next bot while it runs."
)


class OpenCodeSoloTeamAdapter(OpenCodeAdapter):
    """One OpenCode session driving every bot of a team task."""

    _log_prefix = "opencode-solo"
    _log_file = "opencode-solo.txt"

    def __init__(
        self,
        team_size: int | str | None = None,
        bot_names: str | None = None,
        *args,
        **kwargs,
    ):
        super().__init__(*args, **kwargs)
        self._bots = _resolve_bots(team_size, bot_names)

    @staticmethod
    def name() -> str:
        return "opencode-solo-team-adapter"

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        addendum = _SOLO_ADDENDUM.format(
            n=len(self._bots), bots=", ".join(self._bots)
        )
        await super().run(f"{instruction}\n\n{addendum}", environment, context)
