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

`harbor/agents/installed/claude_code.py`:
- `reasoning_effort` enum extended with `xhigh` and `max` (needed for the
  `-xhigh` claude-code variants).

## Apply

```bash
SITE=$(dirname "$(/Users/max/.local/share/uv/tools/harbor/bin/python -c 'import harbor, os; print(os.path.dirname(harbor.__file__))')")
patch -p1 -d "$SITE" --dry-run < patches/harbor-local.patch && \
patch -p1 -d "$SITE" < patches/harbor-local.patch
```

## Verify

```bash
grep -q sandbox_region "$SITE/harbor/environments/modal.py" && \
grep -q xhigh "$SITE/harbor/agents/installed/claude_code.py" && echo OK
```
