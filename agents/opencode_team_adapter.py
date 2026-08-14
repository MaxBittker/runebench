"""
Team adapter for multi-bot cooperative tasks (smith/magic/crafting-team).

Runs N concurrent OpenCode sessions of the SAME model in one sandbox, one per
bot (agenta, agentb, ...). N defaults to 3; pass `--ak team_size=N` to match
the -n<N> task variants (the task's BOT_NAMES env and save files are generated
per size by generate-tasks.ts). Tasks with non-default bot names (the market
task's single-letter a..f) pass them explicitly via `--ak bot_names=a,b,...`,
which overrides team_size.

Each session receives the shared task instruction plus a role addendum naming
its bot. Roles are symmetric — the task instruction asks the team to divide
labor themselves (via in-game chat).

Logs:    /logs/agent/opencode-<bot>.txt (one per bot)
Output:  trajectory.json          (merged, session steps in bot order)
         trajectory-<bot>.json    (per-session)
Context: token counts and cost summed across all sessions.
"""

import json
import logging
import re
import shlex

from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from opencode_adapter import OpenCodeAdapter, _parse_opencode_log

logger = logging.getLogger(__name__)

_DEFAULT_TEAM_SIZE = 3

_NUM_WORDS = {2: "two", 3: "three", 4: "four", 5: "five", 6: "six"}

_ROLE_ADDENDUM = (
    "=== YOUR ROLE ===\n"
    "You are PLAYER {letter}. You control bot \"{bot}\" ONLY — every "
    "execute_code call must use bot_name: \"{bot}\". Your {n_word} "
    "teammate{plural} {verb} separate agent session{plural} controlling the "
    "other bot{plural}. Talk to them through in-game chat using the chat CLI:\n"
    "  cd /app && bun sdk/chat.ts {bot} \"your message\"   # send\n"
    "  cd /app && bun sdk/chat.ts {bot}                   # read recent chat"
)

_SOLO_ADDENDUM = (
    "=== YOUR ROLE ===\n"
    "You are the only player. You control bot \"{bot}\" — every "
    "execute_code call must use bot_name: \"{bot}\"."
)


def _team_bots(n: int) -> list[str]:
    return [f"agent{chr(ord('a') + i)}" for i in range(n)]


def _resolve_bots(team_size: int | str | None, bot_names: str | None) -> list[str]:
    """Explicit names (`--ak bot_names=a,b,c`) win over the derived agenta..N."""
    if bot_names:
        bots = [b for b in re.split(r"[,\s]+", str(bot_names)) if b]
        if bots:
            return bots
    n = int(team_size) if team_size is not None else _DEFAULT_TEAM_SIZE
    return _team_bots(n)


def _role_addendum(bot: str, index: int, team_size: int) -> str:
    if team_size == 1:
        return _SOLO_ADDENDUM.format(bot=bot)
    n_teammates = team_size - 1
    return _ROLE_ADDENDUM.format(
        letter=chr(ord("A") + index),
        bot=bot,
        n_word=_NUM_WORDS.get(n_teammates, str(n_teammates)),
        plural="" if n_teammates == 1 else "s",
        verb="is a" if n_teammates == 1 else "are",
    )


class OpenCodeTeamAdapter(OpenCodeAdapter):
    """N concurrent OpenCode sessions of one model, one per bot."""

    _log_prefix = "opencode-team"
    _log_file = "opencode-team.txt"  # unused; per-session files below

    # Seconds between session launches (avoids the shared-SQLite boot race)
    _LAUNCH_STAGGER_SEC = 1

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
        return "opencode-team-adapter"

    @staticmethod
    def _session_log_file(bot: str) -> str:
        return f"opencode-{bot}.txt"

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        self._last_instruction = instruction

        env = self._agent_env()
        await self._write_opencode_config(environment, env)

        bash_timeout = self._run_timeout_sec or 1620
        model_name = self._resolved_model_name()

        # Write each session's instruction into the sandbox and reference it
        # via $(cat ...) — inlining N full instructions into the single exec
        # command breaks Modal's 64 KB ARG_MAX at larger team sizes.
        session_cmds = []
        for i, bot in enumerate(self._bots):
            addendum = _role_addendum(bot, i, len(self._bots))
            role_instruction = f"{instruction}\n\n{addendum}"
            instr_file = f"/tmp/opencode-instruction-{bot}.txt"
            await self.exec_as_agent(
                environment,
                command=f"printf %s {shlex.quote(role_instruction)} > {instr_file}",
                env=env,
            )
            session_cmds.append(
                self._compose_run_command(
                    model_name=model_name,
                    instruction=role_instruction,
                    prefix=f"opencode-{bot}",
                    log_file=self._session_log_file(bot),
                    # Shrink each staggered session's budget by its launch
                    # delay so all sessions end at the same wall-clock time.
                    bash_timeout=max(bash_timeout - i * self._LAUNCH_STAGGER_SEC, 60),
                    instruction_file=instr_file,
                )
            )

        # Launch all sessions concurrently; the command returns when every
        # restart loop has exhausted its (shared-length) time budget.
        # Launches are staggered a few seconds apart: simultaneous first boots
        # race on OpenCode's shared SQLite storage (schema creation under
        # ~/.local/share/opencode) and die with "database is locked".
        parts = []
        waits = []
        for i, cmd in enumerate(session_cmds):
            delay = i * self._LAUNCH_STAGGER_SEC
            prefix = f"sleep {delay}; " if delay else ""
            parts.append(f"( {prefix}{cmd} ) & TEAM_PID_{i}=$!")
            waits.append(f"wait $TEAM_PID_{i}")
        run_command = (
            "; ".join(parts) + "; " + "; ".join(waits) + "; "
            "echo '[opencode-team] All sessions finished'"
        )

        # Modal-level backstop: bash timeout + 60s buffer (sessions run in
        # parallel, so the budget is NOT multiplied).
        modal_timeout = (self._run_timeout_sec + 60) if self._run_timeout_sec else None

        await self.exec_as_agent(
            environment, command=run_command, env=env, timeout_sec=modal_timeout,
        )

    def populate_context_post_run(self, context: AgentContext) -> None:
        """Parse all session logs → per-bot + merged trajectories, summed tokens."""
        trajectories = {}
        for bot in self._bots:
            log_path = self.logs_dir / self._session_log_file(bot)
            if not log_path.exists():
                logger.warning("OpenCode log not found: %s", log_path)
                continue
            try:
                trajectories[bot] = _parse_opencode_log(
                    log_path,
                    model_name=self.model_name or self._default_model,
                    agent_name=f"{self.name()}:{bot}",
                    instruction=getattr(self, "_last_instruction", None),
                )
            except Exception:
                logger.exception("Failed to parse OpenCode log for %s", bot)

        if not trajectories:
            return

        # Per-bot trajectory files
        for bot, traj in trajectories.items():
            with open(self.logs_dir / f"trajectory-{bot}.json", "w") as f:
                json.dump(traj.model_dump(exclude_none=True), f, indent=2)

        # Merged trajectory.json: A's steps, then B's, then C's, ids renumbered
        merged = next(iter(trajectories.values())).model_copy(deep=True)
        merged.agent.name = self.name()
        merged.steps = []
        step_id = 0
        for bot, traj in trajectories.items():
            for step in traj.steps:
                step = step.model_copy()
                step_id += 1
                step.step_id = step_id
                # Tag the originating session so the merged view stays legible
                if step.source == "agent" and step.message:
                    step.message = f"[{bot}] {step.message}"
                merged.steps.append(step)

        # Summed final metrics across sessions
        total_prompt = total_completion = total_cached = total_steps = 0
        total_cost = 0.0
        has_cost = False
        for traj in trajectories.values():
            fm = traj.final_metrics
            if not fm:
                continue
            total_prompt += fm.total_prompt_tokens or 0
            total_completion += fm.total_completion_tokens or 0
            total_cached += fm.total_cached_tokens or 0
            total_steps += fm.total_steps or 0
            if fm.total_cost_usd is not None:
                total_cost += fm.total_cost_usd
                has_cost = True
        if merged.final_metrics:
            merged.final_metrics.total_prompt_tokens = total_prompt
            merged.final_metrics.total_completion_tokens = total_completion
            merged.final_metrics.total_cached_tokens = total_cached
            merged.final_metrics.total_steps = total_steps
            merged.final_metrics.total_cost_usd = round(total_cost, 6) if has_cost else None

        with open(self.logs_dir / "trajectory.json", "w") as f:
            json.dump(merged.model_dump(exclude_none=True), f, indent=2)

        context.n_input_tokens = total_prompt
        context.n_output_tokens = total_completion
        context.n_cache_tokens = total_cached
        context.cost_usd = round(total_cost, 6) if has_cost else None
