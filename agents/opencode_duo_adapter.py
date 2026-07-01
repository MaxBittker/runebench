"""
Duo adapter for two-bot cooperative tasks (Shield of Arrav).

Runs TWO concurrent OpenCode sessions of the SAME model in one sandbox:
  - session A drives bot "agenta" (Phoenix Gang route)
  - session B drives bot "agentb" (Black Arm Gang route)

Each session receives the shared task instruction plus a role addendum naming
its bot. Both sessions share the container filesystem (/tmp/team/ is suggested
to them for coordination) and each spawns its own MCP server process.

Logs:    /logs/agent/opencode-agenta.txt, /logs/agent/opencode-agentb.txt
Output:  trajectory.json          (merged, A steps then B steps)
         trajectory-agenta.json / trajectory-agentb.json (per-session)
Context: token counts and cost summed across both sessions.
"""

import json
import logging

from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from opencode_adapter import OpenCodeAdapter, _parse_opencode_log

logger = logging.getLogger(__name__)

_ROLE_ADDENDA = {
    "agenta": (
        "=== YOUR ROLE ===\n"
        "You are PLAYER A. You control bot \"agenta\" ONLY — every execute_code "
        "call must use bot_name: \"agenta\". Your gang for this run: the "
        "PHOENIX GANG."
    ),
    "agentb": (
        "=== YOUR ROLE ===\n"
        "You are PLAYER B. You control bot \"agentb\" ONLY — every execute_code "
        "call must use bot_name: \"agentb\". Your gang for this run: the "
        "BLACK ARM GANG."
    ),
}


class OpenCodeDuoAdapter(OpenCodeAdapter):
    """Two concurrent OpenCode sessions of one model, one per bot."""

    _log_prefix = "opencode-duo"
    _log_file = "opencode-duo.txt"  # unused; per-session files below

    @staticmethod
    def name() -> str:
        return "opencode-duo-adapter"

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

        session_cmds = []
        for bot, addendum in _ROLE_ADDENDA.items():
            role_instruction = f"{instruction}\n\n{addendum}"
            session_cmds.append(
                self._compose_run_command(
                    model_name=model_name,
                    instruction=role_instruction,
                    prefix=f"opencode-{bot}",
                    log_file=self._session_log_file(bot),
                    bash_timeout=bash_timeout,
                )
            )

        # Launch both sessions concurrently; the command returns when both
        # restart loops have exhausted their (shared-length) time budget.
        run_command = (
            f"( {session_cmds[0]} ) & DUO_PID_A=$!; "
            f"( {session_cmds[1]} ) & DUO_PID_B=$!; "
            "wait $DUO_PID_A; wait $DUO_PID_B; "
            "echo '[opencode-duo] Both sessions finished'"
        )

        # Modal-level backstop: bash timeout + 60s buffer (sessions run in
        # parallel, so the budget is NOT doubled).
        modal_timeout = (self._run_timeout_sec + 60) if self._run_timeout_sec else None

        await self.exec_as_agent(
            environment, command=run_command, env=env, timeout_sec=modal_timeout,
        )

    def populate_context_post_run(self, context: AgentContext) -> None:
        """Parse both session logs → per-bot + merged trajectories, summed tokens."""
        trajectories = {}
        for bot in _ROLE_ADDENDA:
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

        # Merged trajectory.json: A's steps then B's, ids renumbered
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
