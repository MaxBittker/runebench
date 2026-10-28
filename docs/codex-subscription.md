# Run Codex with ChatGPT authentication

Use `codex_subscription_adapter:CodexSubscription` when a benchmark must use
ChatGPT sign-in and must fail instead of falling back to an API key. This is an
opt-in alternative to `codex_adapter:CodexWithTimeout`; existing API-key runs are
unchanged.

Codex supports [ChatGPT sign-in for subscription access](https://learn.chatgpt.com/docs/auth)
and API keys for usage-based access. Subscription usage is subject to your
plan's limits and model availability. This adapter selects authentication; it
cannot change account billing settings, prevent consumption of already purchased
ChatGPT credits, or guarantee that every model is available on your plan. It does
not purchase credits or fall back to API billing when a limit is reached.

## Prerequisites

- Python 3.12 and Harbor 0.25.0 (the tested integration version).
- Codex CLI signed in through `codex login`, using **Sign in with ChatGPT**.
  Check the method with `codex login status`.
- A model supported by your ChatGPT plan and Codex CLI.
- A trusted agent execution environment. Harbor uploads the selected `auth.json`
  into that environment so Codex can authenticate. Treat it as a credential-bearing
  environment; do not share it with untrusted game code or other users. The adapter
  is an authentication guard, not a credential-isolation sandbox.

Never commit `auth.json`, encode its contents into a command line, or include it in
logs or benchmark results. Prefer an explicit path to a securely stored file.

## Run a task

From the repository root, after generating tasks and preparing your benchmark
image:

```bash
bun generate-tasks.ts
codex login status

# Replace with a model available to your ChatGPT account.
MODEL='openai/<your-supported-model>'
CODEX_AUTH_JSON_PATH="$HOME/.codex/auth.json" \
PYTHONPATH=agents harbor run \
  --agent-import-path codex_subscription_adapter:CodexSubscription \
  --ak run_timeout_sec=400 \
  -m "$MODEL" \
  -p tasks/woodcutting-xp-5m \
  -n 1
```

If `CODEX_AUTH_JSON_PATH` is absent, the adapter checks `~/.codex/auth.json`.
An explicit missing or invalid file is an error; it never falls back to another
credential source. The example starts one benchmark and consumes plan usage;
container hosting and other infrastructure costs are separate.

## What is enforced

Before running the agent, the adapter requires a JSON object containing a
nonempty `tokens.access_token`. It accepts `auth_mode: "chatgpt"`, or an omitted
mode for older OAuth files, and rejects a populated `OPENAI_API_KEY` field or any
other explicit mode. This is structural validation; Codex validates token
validity, expiry, account access and model eligibility.

It also:

- Rejects `CODEX_FORCE_API_KEY=true` and `CODEX_AUTH_JSON_B64`.
- Rejects external model providers and custom API endpoint/provider configuration.
- Forces `forced_login_method = "chatgpt"` and `model_provider = "openai"` in the
  effective Codex config and execution command.
- Clears `OPENAI_API_KEY` and `CODEX_API_KEY` in the Codex execution environment.
- Resolves auth per adapter instance, without mutating process-wide auth variables.
- Retains the existing timeout, optional service-tier flags and log cleanup behavior.

Missing credentials, unsupported models, expired sessions and exhausted limits
produce errors rather than switching billing methods. Use the original adapter
explicitly if you intend to run with API billing.

## Tests

The tests use synthetic credentials and mocked execution; no account, Docker
server, model call or API credit is needed.

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements-test.txt
LITELLM_LOCAL_MODEL_COST_MAP=True \
  .venv/bin/python -m unittest discover -s tests -v
```

The tests cover accepted OAuth files, rejected API/missing/empty credentials,
forced API and base64 rejection, endpoint restrictions, effective configuration,
and execution environment guards. A local subscription-authenticated Codex MCP
smoke test also completed a tutorial and one woodcutting harvest; that verifies
the separate interactive runner, not a full scored Harbor trial.
