# Local patches to the harbor install

`harbor-local.patch` captures the local modifications to the machine-global
harbor install (`uv tool`, harbor 0.4.0) that the run scripts depend on. They
live in site-packages, NOT in this repo, so **they are silently lost on every
`uv tool upgrade harbor` and must be re-applied**.

Generated against pristine harbor 0.4.0; regenerate/rebase after an upgrade if
hunks stop applying.

## What's in it

`harbor/environments/modal.py`:
- `sandbox_region` env kwarg — plumbs `--ek sandbox_region=us-east` through to
  Modal's `Sandbox.create(region=...)`. Required by the grok models (xAI 403s
  EU-origin requests; see the grok case in `scripts/run-skills-30m.sh`).
- Transfer timeouts — `copy_from_local` / `copy_to_local` wrapped in
  `asyncio.wait_for` (180s upload / 600s download) so a stalled Modal
  filesystem call raises instead of hanging the trial indefinitely, and the
  surrounding `@retry` bumped from 2 to 3 attempts. Fixes indefinite
  post-agent stalls during artifact download.
- Memory as `(request, limit)` — `memory=(4096, task.memory_mb)` instead of a
  flat reservation, so Modal bills actual usage above a 4 GB resident floor
  rather than the full `memory_mb`. `generate-tasks.ts` emits `memory_mb`
  as a *cap* on that basis; without this patch every task reserves its cap.
- `tunnel_ports` env kwarg — `--ek tunnel_ports=8888,7780` plumbs through to
  Modal's `Sandbox.create(encrypted_ports=[...])`, exposing those sandbox
  ports as public TLS tunnels. Required by the split (1-box-per-agent) team
  topology: `agents/opencode_split_adapter.py` reads the tunnel URLs off
  `environment._sandbox.tunnels()` and points each agent box's chromium
  client + SDK at them.

`harbor/agents/installed/claude_code.py`:
- `reasoning_effort` enum extended with `xhigh` and `max` (needed for the
  `-xhigh` claude-code variants).
- `fast_mode` agent kwarg — `--ak fast_mode=true` injects
  `--settings '{"fastMode": true}'` plus `CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK=1`.
  Required by the `opus5-fast` row in `scripts/run-skills-30m.sh`.

## Apply

```bash
SITE=$(dirname "$(/Users/max/.local/share/uv/tools/harbor/bin/python -c 'import harbor, os; print(os.path.dirname(harbor.__file__))')")
patch -p1 -d "$SITE" --dry-run < patches/harbor-local.patch && \
patch -p1 -d "$SITE" < patches/harbor-local.patch
```

## Verify

```bash
grep -q sandbox_region "$SITE/harbor/environments/modal.py" && \
grep -q 'memory=(4096' "$SITE/harbor/environments/modal.py" && \
grep -q xhigh "$SITE/harbor/agents/installed/claude_code.py" && \
grep -q fastMode "$SITE/harbor/agents/installed/claude_code.py" && echo OK
```
