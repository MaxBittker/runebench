"""
Team adapter for multi-bot cooperative tasks driven by the Claude Code CLI.

Same shape as opencode_team_adapter (N concurrent sessions of ONE model in one
sandbox, one per bot), but each session is a `claude --print` run instead of an
OpenCode session. Exists for models that are only reachable through the Claude
Code client (e.g. EAP models like claude-hotteok-eap that 404 on every API key
and resolve only via the Max-subscription OAuth token, forwarded as
CLAUDE_CODE_OAUTH_TOKEN).

Each session gets its own CLAUDE_CONFIG_DIR (/logs/agent/sessions-<bot>) so
concurrent sessions never race on .claude.json, and resume-on-early-exit is a
simple `claude --continue` (most-recent session in that config dir).

Logs:    /logs/agent/claude-<bot>.txt (stream-json, one per bot)
Output:  trajectory.json          (merged, session steps in bot order)
         trajectory-<bot>.json    (per-session)
Context: token counts and cost summed across all sessions (cost is the CLI's
         own total_cost_usd from result events — no pricing.ts entry needed).
"""

import json
import logging
import os
import re
import shlex
import uuid
from datetime import datetime, timezone
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trajectories.agent import Agent as ATIFAgent
from harbor.models.trajectories.final_metrics import FinalMetrics
from harbor.models.trajectories.metrics import Metrics
from harbor.models.trajectories.observation import Observation
from harbor.models.trajectories.observation_result import ObservationResult
from harbor.models.trajectories.step import Step
from harbor.models.trajectories.tool_call import ToolCall
from harbor.models.trajectories.trajectory import Trajectory

from opencode_team_adapter import _role_addendum, _team_bots

logger = logging.getLogger(__name__)

_DEFAULT_TEAM_SIZE = 3

_CONTINUE_MESSAGE = (
    "You stopped early but there is still time remaining. Check the current "
    "game state with sdk.getState() and CONTINUE working on the task. Do NOT "
    "write a summary — keep going."
)


class ClaudeCodeTeamAdapter(BaseInstalledAgent):
    """N concurrent Claude Code CLI sessions of one model, one per bot."""

    _default_model: str = "anthropic/claude-hotteok-eap"

    # Seconds between session launches (spreads the first-request burst)
    _LAUNCH_STAGGER_SEC = 2

    def __init__(
        self,
        team_size: int | str | None = None,
        run_timeout_sec: int | None = None,
        *args,
        **kwargs,
    ):
        super().__init__(*args, **kwargs)
        n = int(team_size) if team_size is not None else _DEFAULT_TEAM_SIZE
        self._bots = _team_bots(n)
        self._run_timeout_sec = int(run_timeout_sec) if run_timeout_sec is not None else None

    @staticmethod
    def name() -> str:
        return "claude-code-team-adapter"

    @property
    def _install_agent_template_path(self) -> Path:
        # Unused — install() is overridden (the CLI is baked into the image).
        return Path(__file__).parent / "install-opencode.sh.j2"

    async def install(self, environment: BaseEnvironment) -> None:
        # Claude Code is pre-installed in the Docker image (/usr/local/bin/claude).
        result = await environment.exec(command="command -v claude && claude --version")
        if result.return_code != 0:
            raise RuntimeError("claude CLI not found in sandbox image")

    @staticmethod
    def _session_log_file(bot: str) -> str:
        return f"claude-{bot}.txt"

    def _resolved_model(self) -> str:
        model = self.model_name or self._default_model
        # Strip the harbor-style provider prefix (anthropic/claude-... → claude-...)
        return model.split("/", 1)[-1]

    def _agent_env(self) -> dict[str, str]:
        env = {
            "ANTHROPIC_API_KEY": os.environ.get("ANTHROPIC_API_KEY", ""),
            "CLAUDE_CODE_OAUTH_TOKEN": os.environ.get("CLAUDE_CODE_OAUTH_TOKEN", ""),
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
            "IS_SANDBOX": "1",
        }
        return {k: v for k, v in env.items() if v}

    def _compose_run_command(
        self,
        model_name: str,
        prefix: str,
        log_file: str,
        bash_timeout: int,
        instruction_file: str,
        config_dir: str,
    ) -> str:
        """Build the claude restart-loop bash command for one session.

        Same loop shape as OpenCodeAdapter._compose_run_command: if claude
        exits early the loop restarts it with `--continue` (context preserved
        via the per-bot CLAUDE_CONFIG_DIR); a resume that fast-fails (<10s)
        falls back to a fresh session with the full instruction.
        """
        q_file = shlex.quote(instruction_file)
        escaped_model = shlex.quote(model_name)
        q_cfg = shlex.quote(config_dir)
        continue_message = shlex.quote(_CONTINUE_MESSAGE)

        claude_base = (
            f"claude --verbose --output-format=stream-json "
            f"--permission-mode=bypassPermissions --model {escaped_model}"
        )
        fresh_cmd = f'{claude_base} --print -- "$(cat {q_file})"'
        resume_cmd = f"{claude_base} --continue --print -- {continue_message}"
        log_pipe = f"2>&1 </dev/null | tee -a /logs/agent/{log_file}"

        # Variable prefix for the restart loop (bash-identifier-safe).
        vp = re.sub(r"[^A-Za-z0-9_]", "_", prefix.upper())

        return (
            f"echo '[{prefix}-setup] Starting claude session'; "
            f"export CLAUDE_CONFIG_DIR={q_cfg}; "
            "mkdir -p $CLAUDE_CONFIG_DIR/debug $CLAUDE_CONFIG_DIR/projects/-app "
            "$CLAUDE_CONFIG_DIR/shell-snapshots $CLAUDE_CONFIG_DIR/statsig "
            "$CLAUDE_CONFIG_DIR/todos; "
            f"command -v claude &>/dev/null || {{ echo '[{prefix}-setup] ERROR: claude not found on PATH' | tee -a /logs/agent/{log_file}; exit 1; }}; "
            "cd /app; "
            f"{vp}_START=$(date +%s); "
            f"{vp}_TIMEOUT={bash_timeout}; "
            f"{vp}_MIN_RESTART=180; "
            f"{vp}_FAST_FAILS=0; "
            f"{vp}_MAX_FAST_FAILS=3; "
            f"{vp}_COOLDOWN_USED=0; "
            f"{vp}_RESUME=1; "
            f"{vp}_RUN=1; "
            f"echo \"[{prefix}-loop] Run ${vp}_RUN starting (budget=${{{vp}_TIMEOUT}}s)\" | tee -a /logs/agent/{log_file}; "
            f"{vp}_RUN_START=$(date +%s); "
            f"timeout ${{{vp}_TIMEOUT}}s {fresh_cmd} {log_pipe}; "
            f"{vp}_RUN_DUR=$(( $(date +%s) - {vp}_RUN_START )); "
            f"echo \"[{prefix}-loop] claude exited after ${{{vp}_RUN_DUR}}s\" | tee -a /logs/agent/{log_file}; "
            f"if [ ${vp}_RUN_DUR -lt 10 ]; then {vp}_FAST_FAILS=$(({vp}_FAST_FAILS + 1)); else {vp}_FAST_FAILS=0; fi; "
            "while true; do "
            f"  if [ ${vp}_FAST_FAILS -ge ${vp}_MAX_FAST_FAILS ]; then "
            f"    if [ ${vp}_COOLDOWN_USED -ge 1 ]; then "
            f"      echo \"[{prefix}-loop] ${{{vp}_FAST_FAILS}} consecutive fast failures (<10s) after cooldown, aborting\" | tee -a /logs/agent/{log_file}; "
            "      break; "
            "    fi; "
            f"    {vp}_COOLDOWN_USED=1; {vp}_FAST_FAILS=0; {vp}_RESUME=0; "
            f"    echo \"[{prefix}-loop] ${{{vp}_MAX_FAST_FAILS}} consecutive fast failures (<10s) — cooling down 60s, then retrying with a fresh session\" | tee -a /logs/agent/{log_file}; "
            "    sleep 60; "
            "  fi; "
            f"  {vp}_ELAPSED=$(( $(date +%s) - {vp}_START )); "
            f"  {vp}_REMAINING=$(( {vp}_TIMEOUT - {vp}_ELAPSED )); "
            f"  echo \"[{prefix}-loop] Elapsed: ${{{vp}_ELAPSED}}s, Remaining: ${{{vp}_REMAINING}}s\" | tee -a /logs/agent/{log_file}; "
            f"  if [ ${vp}_REMAINING -lt ${vp}_MIN_RESTART ]; then "
            f"    echo \"[{prefix}-loop] Less than ${{{vp}_MIN_RESTART}}s remaining, stopping restart loop\" | tee -a /logs/agent/{log_file}; "
            "    break; "
            "  fi; "
            f"  {vp}_RUN=$(({vp}_RUN + 1)); "
            f"  echo \"[{prefix}-loop] Run ${vp}_RUN starting (${{{vp}_REMAINING}}s remaining)\" | tee -a /logs/agent/{log_file}; "
            f"  {vp}_RUN_START=$(date +%s); "
            f"  if [ ${vp}_RESUME -eq 1 ]; then "
            f"    echo \"[{prefix}-loop] Resuming previous session (--continue)\" | tee -a /logs/agent/{log_file}; "
            f"    timeout ${{{vp}_REMAINING}}s {resume_cmd} {log_pipe}; "
            "  else "
            f"    timeout ${{{vp}_REMAINING}}s {fresh_cmd} {log_pipe}; "
            "  fi; "
            f"  {vp}_RUN_DUR=$(( $(date +%s) - {vp}_RUN_START )); "
            f"  echo \"[{prefix}-loop] claude exited after ${{{vp}_RUN_DUR}}s\" | tee -a /logs/agent/{log_file}; "
            f"  if [ ${vp}_RUN_DUR -lt 10 ]; then "
            f"    {vp}_FAST_FAILS=$(({vp}_FAST_FAILS + 1)); "
            f"    if [ ${vp}_RESUME -eq 1 ]; then {vp}_RESUME=0; echo \"[{prefix}-loop] Resume failed fast — next run starts a fresh session\" | tee -a /logs/agent/{log_file}; fi; "
            f"  else {vp}_FAST_FAILS=0; {vp}_RESUME=1; fi; "
            "done; "
            f"echo \"[{prefix}-loop] Finished after ${vp}_RUN runs\" | tee -a /logs/agent/{log_file}"
        )

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        self._last_instruction = instruction

        env = self._agent_env()
        bash_timeout = self._run_timeout_sec or 1620
        model_name = self._resolved_model()

        # Write each session's instruction into the sandbox and reference it
        # via $(cat ...) — inlining N full instructions into the single exec
        # command breaks Modal's 64 KB ARG_MAX at larger team sizes.
        session_cmds = []
        for i, bot in enumerate(self._bots):
            addendum = _role_addendum(bot, i, len(self._bots))
            role_instruction = f"{instruction}\n\n{addendum}"
            instr_file = f"/tmp/claude-instruction-{bot}.txt"
            await self.exec_as_agent(
                environment,
                command=f"printf %s {shlex.quote(role_instruction)} > {instr_file}",
                env=env,
            )
            session_cmds.append(
                self._compose_run_command(
                    model_name=model_name,
                    prefix=f"claude-{bot}",
                    log_file=self._session_log_file(bot),
                    # Shrink each staggered session's budget by its launch
                    # delay so all sessions end at the same wall-clock time.
                    bash_timeout=max(bash_timeout - i * self._LAUNCH_STAGGER_SEC, 60),
                    instruction_file=instr_file,
                    config_dir=f"/logs/agent/sessions-{bot}",
                )
            )

        # Launch all sessions concurrently, staggered a few seconds apart.
        parts = []
        waits = []
        for i, cmd in enumerate(session_cmds):
            delay = i * self._LAUNCH_STAGGER_SEC
            prefix = f"sleep {delay}; " if delay else ""
            parts.append(f"( {prefix}{cmd} ) & TEAM_PID_{i}=$!")
            waits.append(f"wait $TEAM_PID_{i}")
        run_command = (
            "; ".join(parts) + "; " + "; ".join(waits) + "; "
            "echo '[claude-team] All sessions finished'"
        )

        # Modal-level backstop: bash timeout + 60s buffer (sessions run in
        # parallel, so the budget is NOT multiplied).
        modal_timeout = (self._run_timeout_sec + 60) if self._run_timeout_sec else None

        await self.exec_as_agent(
            environment, command=run_command, env=env, timeout_sec=modal_timeout,
        )

    def populate_context_post_run(self, context: AgentContext) -> None:
        """Parse all session stream-json logs → per-bot + merged trajectories."""
        trajectories = {}
        for bot in self._bots:
            log_path = self.logs_dir / self._session_log_file(bot)
            if not log_path.exists():
                logger.warning("Claude log not found: %s", log_path)
                continue
            try:
                trajectories[bot] = _parse_claude_stream_log(
                    log_path,
                    model_name=self.model_name or self._default_model,
                    agent_name=f"{self.name()}:{bot}",
                    instruction=getattr(self, "_last_instruction", None),
                )
            except Exception:
                logger.exception("Failed to parse claude log for %s", bot)

        if not trajectories:
            return

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
                if step.source == "agent" and step.message:
                    step.message = f"[{bot}] {step.message}"
                merged.steps.append(step)

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


def _parse_claude_stream_log(
    log_path: Path,
    model_name: str,
    agent_name: str,
    instruction: str | None = None,
) -> Trajectory:
    """Parse a Claude Code stream-json log (possibly several concatenated runs
    from the restart loop, interleaved with loop echo lines) into an ATIF
    Trajectory."""
    events: list[dict] = []
    with open(log_path) as f:
        for line in f:
            line = line.strip()
            if not line or not line.startswith("{"):
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                continue

    steps: list[Step] = []
    step_id = 0
    session_id = None

    if instruction:
        step_id += 1
        steps.append(Step(step_id=step_id, source="user", message=instruction))

    total_prompt = 0
    total_completion = 0
    total_cached = 0
    total_cost = 0.0

    # First pass: collect tool_result contents (type=user events) keyed by
    # tool_use_id, so each assistant step's observation can be built complete
    # (pydantic copies list fields at Step creation — no post-hoc appends).
    tool_results: dict[str, str] = {}
    for event in events:
        if event.get("type") != "user":
            continue
        message = event.get("message", {}) or {}
        content = message.get("content", [])
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict) or block.get("type") != "tool_result":
                continue
            call_id = block.get("tool_use_id", "")
            raw = block.get("content", "")
            if isinstance(raw, list):
                raw = "\n".join(
                    b.get("text", "") for b in raw if isinstance(b, dict)
                )
            if call_id:
                tool_results[call_id] = str(raw) if raw else ""

    for event in events:
        etype = event.get("type")
        if not session_id and event.get("session_id"):
            session_id = event["session_id"]

        if etype == "assistant":
            message = event.get("message", {}) or {}
            content = message.get("content", []) or []
            texts = []
            tool_calls = []
            observations: list[ObservationResult] = []
            for block in content:
                btype = block.get("type")
                if btype == "text" and block.get("text"):
                    texts.append(block["text"])
                elif btype == "thinking" and block.get("thinking"):
                    texts.append(f"[thinking] {block['thinking']}")
                elif btype == "tool_use":
                    call_id = block.get("id", str(uuid.uuid4()))
                    tool_calls.append(ToolCall(
                        tool_call_id=call_id,
                        function_name=block.get("name", "unknown"),
                        arguments=block.get("input", {}),
                    ))
                    result = tool_results.get(call_id)
                    observations.append(ObservationResult(
                        source_call_id=call_id,
                        content=result if result else None,
                    ))

            usage = message.get("usage", {}) or {}
            completion_tokens = usage.get("output_tokens", 0) or 0
            cache_read = usage.get("cache_read_input_tokens", 0) or 0
            cache_creation = usage.get("cache_creation_input_tokens", 0) or 0
            prompt_tokens = (usage.get("input_tokens", 0) or 0) + cache_read + cache_creation

            total_prompt += prompt_tokens
            total_completion += completion_tokens
            total_cached += cache_read

            step_id += 1
            timestamp = event.get("timestamp")
            steps.append(Step(
                step_id=step_id,
                timestamp=timestamp if isinstance(timestamp, str) else None,
                source="agent",
                message="\n".join(texts).strip() or "(no text)",
                tool_calls=tool_calls or None,
                observation=Observation(results=observations) if tool_calls else None,
                metrics=Metrics(
                    prompt_tokens=prompt_tokens,
                    completion_tokens=completion_tokens,
                    cached_tokens=cache_read,
                ),
            ))

        elif etype == "result":
            cost = event.get("total_cost_usd")
            if cost:
                total_cost += cost

    if not steps:
        steps.append(Step(step_id=1, source="system", message="No steps recorded"))

    return Trajectory(
        schema_version="ATIF-v1.6",
        session_id=session_id or str(uuid.uuid4()),
        agent=ATIFAgent(
            name=agent_name,
            version="unknown",
            model_name=model_name,
        ),
        steps=steps,
        final_metrics=FinalMetrics(
            total_prompt_tokens=total_prompt,
            total_completion_tokens=total_completion,
            total_cached_tokens=total_cached,
            total_cost_usd=round(total_cost, 6) if total_cost else None,
            total_steps=len(steps),
        ),
    )
