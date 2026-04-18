"""
Base adapter for OpenCode-based agents.

Supports all providers via OpenCode CLI:
  - anthropic/ → ANTHROPIC_API_KEY
  - openai/    → OPENAI_API_KEY
  - gemini/, google/ → GEMINI_API_KEY
  - openrouter/ → OPENROUTER_API_KEY

Subclasses only need to override:
  - name()           — agent name
  - _default_model   — fallback model ID
  - _log_prefix      — prefix for log messages (e.g. 'kimi', 'qwen3')
  - _log_file        — log file name (e.g. 'opencode-kimi.txt')
"""

import json
import logging
import os
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

logger = logging.getLogger(__name__)

# Path to our AGENTS.md instruction file (same content copied into Docker image)
_AGENTS_MD_PATH = Path(__file__).parent.parent / "docker" / "agents.md"


def _opencode_system_prompt_for_model(model_name: str) -> str:
    """Return the OpenCode built-in system prompt that would be used for a given model.

    OpenCode selects a model-specific prompt based on the model ID string.
    See: https://github.com/sst/opencode/blob/dev/packages/opencode/src/session/system.ts

    We store the prompts in agents/opencode_prompts/ as .txt files.
    """
    prompts_dir = Path(__file__).parent / "opencode_prompts"
    model_lower = model_name.lower()

    if "claude" in model_lower:
        prompt_file = "anthropic.txt"
    elif "codex" in model_lower:
        prompt_file = "codex.txt"
    elif any(k in model_lower for k in ("gpt-4", "o1", "o3")):
        prompt_file = "beast.txt"
    elif "gpt" in model_lower:
        prompt_file = "gpt.txt"
    elif "gemini" in model_lower:
        prompt_file = "gemini.txt"
    elif "kimi" in model_lower:
        prompt_file = "kimi.txt"
    else:
        prompt_file = "default.txt"

    path = prompts_dir / prompt_file
    if path.exists():
        return path.read_text()
    # Fallback: try default
    default = prompts_dir / "default.txt"
    if default.exists():
        return default.read_text()
    return ""


# Map provider prefix → env var name
_PROVIDER_KEY_MAP = {
    "anthropic": "ANTHROPIC_API_KEY",
    "openai": "OPENAI_API_KEY",
    "gemini": "GEMINI_API_KEY",
    "google": "GEMINI_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
}


class OpenCodeAdapter(BaseInstalledAgent):
    """
    Base class for agents that run via OpenCode CLI.
    """

    _default_model: str = ""
    _log_prefix: str = "opencode"
    _log_file: str = "opencode.txt"
    _model_options: dict = {}  # extra options merged into the model config

    def __init__(self, run_timeout_sec: int | None = None, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._run_timeout_sec = int(run_timeout_sec) if run_timeout_sec is not None else None

    @property
    def _install_agent_template_path(self) -> Path:
        return Path(__file__).parent / "install-opencode.sh.j2"

    @staticmethod
    def name() -> str:
        return "opencode-adapter"

    async def install(self, environment: BaseEnvironment) -> None:
        # OpenCode is pre-installed in the Docker image via NVM.
        # Verify it's accessible; if not, install it.
        result = await environment.exec(
            command='export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; command -v opencode',
        )
        if result.return_code != 0:
            await self.exec_as_agent(
                environment,
                command=(
                    "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | bash && "
                    'export NVM_DIR="$HOME/.nvm" && '
                    '. "$NVM_DIR/nvm.sh" && '
                    "nvm install 22 && npm i -g opencode-ai@latest && "
                    "opencode --version"
                ),
            )

    def populate_context_post_run(self, context: AgentContext) -> None:
        """Parse OpenCode JSONL log → ATIF trajectory.json + token counts."""
        log_path = self.logs_dir / self._log_file
        if not log_path.exists():
            logger.warning("OpenCode log not found: %s", log_path)
            return

        try:
            trajectory = _parse_opencode_log(
                log_path,
                model_name=self.model_name or self._default_model,
                agent_name=self.name(),
                instruction=getattr(self, "_last_instruction", None),
            )
        except Exception:
            logger.exception("Failed to parse OpenCode log into ATIF trajectory")
            return

        # Write trajectory.json
        traj_path = self.logs_dir / "trajectory.json"
        with open(traj_path, "w") as f:
            json.dump(trajectory.model_dump(exclude_none=True), f, indent=2)

        # Populate context from final_metrics
        if trajectory.final_metrics:
            fm = trajectory.final_metrics
            context.n_input_tokens = fm.total_prompt_tokens or 0
            context.n_output_tokens = fm.total_completion_tokens or 0
            context.n_cache_tokens = fm.total_cached_tokens or 0
            context.cost_usd = fm.total_cost_usd

    # OpenCode uses "google" as its provider name for Gemini models.
    _PROVIDER_REMAP = {"gemini": "google"}

    def _build_opencode_config(self) -> dict:
        """Build opencode.json config with the appropriate provider and MCP servers."""
        model_id = self.model_name or self._default_model
        if "/" in model_id:
            parts = model_id.split("/", 1)
            provider_name = self._PROVIDER_REMAP.get(parts[0], parts[0])
            model_suffix = parts[1]
        else:
            provider_name = "openrouter"
            model_suffix = model_id

        config: dict = {
            "$schema": "https://opencode.ai/config.json",
            "provider": {
                provider_name: {
                    "options": {
                        "timeout": 180000,  # 3 min hard cutoff to avoid hung API calls
                    },
                    "models": {
                        model_suffix: {"options": self._model_options} if self._model_options else {}
                    }
                }
            },
            "model": f"{provider_name}/{model_suffix}",
            "permission": {
                "*": "allow",
            },
        }

        if self.mcp_servers:
            mcp = {}
            for server in self.mcp_servers:
                if server.transport == "stdio":
                    cmd_parts = [server.command] + (server.args or [])
                    mcp[server.name] = {
                        "type": "local",
                        "command": cmd_parts,
                        "enabled": True,
                    }
                else:
                    mcp[server.name] = {
                        "type": "remote",
                        "url": server.url,
                        "enabled": True,
                    }
            config["mcp"] = mcp

        return config

    # Snapshot env vars at class-load time
    _original_env = {
        k: os.environ.get(k, "")
        for k in ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"]
    }

    def _resolve_api_key_env(self) -> dict[str, str]:
        """Resolve the correct API key env var(s) based on model provider prefix."""
        model_id = self.model_name or self._default_model
        provider_name = model_id.split("/", 1)[0] if "/" in model_id else "openrouter"

        env_var = _PROVIDER_KEY_MAP.get(provider_name, "OPENROUTER_API_KEY")
        key_value = self._original_env.get(env_var) or os.environ.get(env_var, "")

        env = {}
        if key_value:
            env[env_var] = key_value
            # OpenCode's google provider expects GOOGLE_GENERATIVE_AI_API_KEY
            if provider_name in ("gemini", "google"):
                env["GOOGLE_GENERATIVE_AI_API_KEY"] = key_value
        return env

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        self._last_instruction = instruction
        escaped_instruction = shlex.quote(instruction)

        env = self._resolve_api_key_env()
        env["OPENCODE_YOLO"] = "true"
        env["OPENCODE_DANGEROUSLY_SKIP_PERMISSIONS"] = "true"
        env = {k: v for k, v in env.items() if v}

        opencode_config = self._build_opencode_config()
        config_json = json.dumps(opencode_config, indent=2)
        escaped_config = shlex.quote(config_json)

        model_name = self.model_name or self._default_model
        # Remap provider prefix for OpenCode CLI (e.g. gemini/ → google/)
        if "/" in model_name:
            raw_provider, model_suffix = model_name.split("/", 1)
            remapped = self._PROVIDER_REMAP.get(raw_provider)
            if remapped:
                model_name = f"{remapped}/{model_suffix}"

        prefix = self._log_prefix
        log_file = self._log_file

        setup_command = (
            f"echo {escaped_config} > /app/opencode.json && "
            f"echo '[{prefix}-setup] Wrote /app/opencode.json'"
        )

        await self.exec_as_agent(environment, command=setup_command, env=env)

        escaped_model = shlex.quote(model_name)
        continue_instruction = shlex.quote(
            "You were previously working on this task but stopped early. "
            "There is still time remaining. Check the current game state with "
            "sdk.getState() and CONTINUE training. Do NOT write a summary — "
            "keep grinding. " + instruction
        )

        # Variable prefix for the restart loop (uppercase of log_prefix)
        vp = prefix.upper()

        # Use run_timeout_sec if provided, otherwise fall back to env var / 1620s default
        bash_timeout = self._run_timeout_sec or 1620
        bash_timeout_expr = f"{vp}_TIMEOUT=${{{vp}_TIMEOUT:-{bash_timeout}}}; "

        run_command = (
            f"echo '[{prefix}-setup] Starting opencode'; "
            # Source NVM so the nvm-installed opencode binary is on PATH
            "export NVM_DIR=\"$HOME/.nvm\"; "
            "[ -s \"$NVM_DIR/nvm.sh\" ] && . \"$NVM_DIR/nvm.sh\" || true; "
            # Fast-fail if opencode is still not found
            f"command -v opencode &>/dev/null || {{ echo '[{prefix}-setup] ERROR: opencode not found on PATH' | tee -a /logs/agent/{log_file}; exit 1; }}; "
            "cd /app; "
            f"{vp}_START=$(date +%s); "
            f"{bash_timeout_expr}"
            f"{vp}_MIN_RESTART=180; "
            f"{vp}_FAST_FAILS=0; "
            f"{vp}_MAX_FAST_FAILS=3; "
            f"{vp}_RUN=1; "
            f"echo \"[{prefix}-loop] Run ${vp}_RUN starting (budget=${{{vp}_TIMEOUT}}s)\" | tee -a /logs/agent/{log_file}; "
            f"{vp}_RUN_START=$(date +%s); "
            f"timeout ${{{vp}_TIMEOUT}}s opencode --model {escaped_model} run --format=json {escaped_instruction} "
            f"2>&1 </dev/null | tee -a /logs/agent/{log_file}; "
            f"{vp}_RUN_DUR=$(( $(date +%s) - {vp}_RUN_START )); "
            f"echo '[{prefix}-loop] opencode exited after ${{{vp}_RUN_DUR}}s' | tee -a /logs/agent/{log_file}; "
            # Track fast failures (< 10s) to avoid spinning on broken setups
            f"if [ ${vp}_RUN_DUR -lt 10 ]; then {vp}_FAST_FAILS=$(({vp}_FAST_FAILS + 1)); else {vp}_FAST_FAILS=0; fi; "
            "while true; do "
            f"  if [ ${vp}_FAST_FAILS -ge ${vp}_MAX_FAST_FAILS ]; then "
            f"    echo \"[{prefix}-loop] {{{vp}_FAST_FAILS}} consecutive fast failures (<10s), aborting\" | tee -a /logs/agent/{log_file}; "
            "    break; "
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
            f"  timeout ${{{vp}_REMAINING}}s opencode --model {escaped_model} run --format=json {continue_instruction} "
            f"  2>&1 </dev/null | tee -a /logs/agent/{log_file}; "
            f"  {vp}_RUN_DUR=$(( $(date +%s) - {vp}_RUN_START )); "
            f"  echo '[{prefix}-loop] opencode exited after ${{{vp}_RUN_DUR}}s' | tee -a /logs/agent/{log_file}; "
            f"  if [ ${vp}_RUN_DUR -lt 10 ]; then {vp}_FAST_FAILS=$(({vp}_FAST_FAILS + 1)); else {vp}_FAST_FAILS=0; fi; "
            "done; "
            f"echo \"[{prefix}-loop] Finished after ${vp}_RUN runs\" | tee -a /logs/agent/{log_file}"
        )

        # Set Modal-level timeout as backstop: bash timeout + 60s buffer
        modal_timeout = (self._run_timeout_sec + 60) if self._run_timeout_sec else None

        await self.exec_as_agent(
            environment, command=run_command, env=env, timeout_sec=modal_timeout,
        )


def _parse_opencode_log(
    log_path: Path,
    model_name: str,
    agent_name: str,
    instruction: str | None = None,
) -> Trajectory:
    """Parse an OpenCode JSONL log file into an ATIF Trajectory."""
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

    # Build synthetic system/user steps from OpenCode's built-in prompt + AGENTS.md
    opencode_prompt = _opencode_system_prompt_for_model(model_name)
    agents_md = ""
    if _AGENTS_MD_PATH.exists():
        agents_md = _AGENTS_MD_PATH.read_text()
    system_parts = []
    if opencode_prompt:
        system_parts.append(opencode_prompt)
    if agents_md:
        system_parts.append(f"Instructions from: /app/AGENTS.md\n{agents_md}")
    if system_parts:
        step_id += 1
        steps.append(Step(
            step_id=step_id,
            source="system",
            message="\n\n".join(system_parts),
        ))
    if instruction:
        step_id += 1
        steps.append(Step(
            step_id=step_id,
            source="user",
            message=instruction,
        ))

    # Group events by step: step_start → text/tool_use → step_finish
    current_texts: list[str] = []
    current_tool_calls: list[ToolCall] = []
    current_observations: list[ObservationResult] = []
    current_timestamp: str | None = None

    total_prompt = 0
    total_completion = 0
    total_cached = 0
    total_cost = 0.0

    for event in events:
        etype = event.get("type")
        if not session_id:
            session_id = event.get("sessionID", "")

        if etype == "step_start":
            # Reset accumulators for new step
            current_texts = []
            current_tool_calls = []
            current_observations = []
            ts_ms = event.get("timestamp")
            current_timestamp = (
                datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).isoformat()
                if ts_ms
                else None
            )

        elif etype == "text":
            part = event.get("part", {})
            text = part.get("text", "")
            if text:
                current_texts.append(text)

        elif etype == "tool_use":
            part = event.get("part", {})
            call_id = part.get("callID", str(uuid.uuid4()))
            tool_name = part.get("tool", "unknown")
            state = part.get("state", {})

            current_tool_calls.append(ToolCall(
                tool_call_id=call_id,
                function_name=tool_name,
                arguments=state.get("input", {}),
            ))

            output = state.get("output", "")
            current_observations.append(ObservationResult(
                source_call_id=call_id,
                content=str(output) if output else None,
            ))

        elif etype == "step_finish":
            part = event.get("part", {})
            tokens = part.get("tokens", {})
            cache = tokens.get("cache", {})
            cost = part.get("cost", 0.0)

            # OpenCode "input" = non-cached input only; "total" = all tokens.
            # ATIF prompt_tokens = total input including cached = total - output.
            completion_tokens = tokens.get("output", 0)
            total_tokens = tokens.get("total", 0)
            prompt_tokens = total_tokens - completion_tokens
            cached_tokens = cache.get("read", 0)

            total_prompt += prompt_tokens
            total_completion += completion_tokens
            total_cached += cached_tokens
            total_cost += cost or 0.0

            step_id += 1
            message = "\n".join(current_texts).strip() or "(no text)"

            step = Step(
                step_id=step_id,
                timestamp=current_timestamp,
                source="agent",
                message=message,
                tool_calls=current_tool_calls if current_tool_calls else None,
                observation=Observation(results=current_observations) if current_observations else None,
                metrics=Metrics(
                    prompt_tokens=prompt_tokens,
                    completion_tokens=completion_tokens,
                    cached_tokens=cached_tokens,
                    cost_usd=cost if cost else None,
                ),
            )
            steps.append(step)

    if not steps:
        # Create a minimal step so the trajectory is valid
        steps.append(Step(
            step_id=1,
            source="system",
            message="No steps recorded",
        ))

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
