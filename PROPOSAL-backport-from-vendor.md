# Proposal: Backport two improvements from `vendor-runescape-rl`

The `vendor-runescape-rl` fork (branched ~April 2026 for the xAI vendor-eval
submission) made two structural improvements that are worth bringing back into
the mainline `runebench` repo. Both reduce duplication and make the benchmark
easier to extend safely.

---

## #1 — Declarative gold-task save files

### Problem

Gold tasks start the agent from one of four pre-built conditions. Today those
conditions live as **opaque binary blobs** committed to the repo:

```
shared/agent-gold-vanilla.sav
shared/agent-gold-fish.sav
shared/agent-gold-fletch-alch.sav
shared/agent-gold-smith-alch.sav
```

`generate-tasks.ts` references them by filename (`saveFile: 'agent-gold-smith-alch.sav'`),
and `check_gold.ts` reads them directly. Consequences:

- You **cannot tell from the repo** what a condition grants — position, skills,
  inventory, unlocked quests are all hidden inside the binary.
- Changing a condition (e.g. bump a skill, add an item) means regenerating a
  blob out of band; the change shows up in git as an unreviewable binary diff.
- Adding a fifth condition requires producing a new `.sav` artifact by hand.

### Proposed change

Adopt the vendor fork's `shared/save-generator.ts` and define each condition as
**readable data** in `generate-tasks.ts`:

```ts
saveConfig: {
  position: Locations.FALADOR_CENTER,
  skills: { Mining: 99, Smithing: 99, Magic: 99 },
  inventory: [
    { id: Items.BRONZE_PICKAXE, count: 1 },
    { id: Items.NATURE_RUNE, count: 100 },
    { id: Items.FIRE_RUNE, count: 500 },
  ],
  varps: DORICS_QUEST_COMPLETE,   // { 31: 100 } — quest unlock for anvil access
}
```

`save-generator.ts` provides `Items`, `Locations`, and `InvTypes` enums and
writes the binary `.sav` (handling the SAV magic/version header) from this
config at task-generation time.

### Benefits

- **Self-documenting** — the starting condition is legible in source.
- **Reviewable** — changes show up as readable diffs, not binary churn.
- **Cheap to extend** — new conditions are a few lines, no external tooling.
- **No committed binaries** — the four `.sav` files can be deleted from the repo
  and generated on demand.

### Scope of work

1. Port `shared/save-generator.ts` from the vendor fork (verify `Items` /
   `Locations` IDs match the current rs-sdk/LostCity version).
2. Add a `saveConfig?: SaveConfig` field to the gold-condition type and replace
   the four `saveFile:` entries in `generate-tasks.ts` with `saveConfig` blocks.
3. Wire generation so each gold task emits its `.sav` into `environment/`.
4. Confirm the generated saves are equivalent to the current binaries before
   removing `shared/agent-gold-*.sav`.

### Risk / validation

Low. The generated saves must reproduce the same in-game starting state as the
existing binaries. Validate by diffing the loaded game state (position, skills,
inventory, varps) for each condition, or by running one gold task per condition
and confirming the agent starts as expected. Keep the old `.sav` files until
parity is confirmed.

---

## #2 — Single source of truth for the run harness

### Problem

The model/skill matrix is **redefined in every run script**. `ALL_MODELS` is
declared independently in at least six places:

```
scripts/run.sh
scripts/run-gold.sh
scripts/run-skills-10m.sh
scripts/run-skills-15m.sh
scripts/run-skills-30m.sh
scripts/run-skills-{10m,30m}-staggered.sh
```

These lists have already **drifted**: the default `SELECTED_MODELS` differs per
horizon (e.g. `run-gold.sh` includes `opus47`/`codex53`/`gpt55`, `run-skills-15m.sh`
is missing `gemini35flash`). Each script also repeats per-model credential
checks like:

```bash
if [ -z "${OPENROUTER_API_KEY:-}" ]; then
  echo "  WARNING: OPENROUTER_API_KEY not found, skipping $model_name"
  return 1
fi
```

Adding or renaming a model means editing every script and hoping none are
missed.

### Proposed change

Move the matrix and credential logic into `scripts/run-common.sh` as the single
source of truth, following the vendor fork's structure:

- **Centralized definitions** — `ALL_MODELS`, `ALL_SKILLS`, `ALL_MODEL_LABELS`
  declared once; individual scripts override only when they intentionally want a
  subset.
- **Prefix-based credential dispatch** — check keys by model-id prefix
  (`anthropic/*`, `openai/*`, `gemini/*`, `openrouter/*`, `*grok-build*`) in one
  block each, instead of per-model copy-paste.
- **`AGENT_ENV_FLAGS` / `--ae` passthrough** — uniformly forward API keys into
  the Modal sandbox (Harbor 0.3+).
- **`sandbox_timeout_for_horizon()`** — map a horizon label (5m/10m/15m/30m) to
  a timeout in seconds, replacing inline literals.
- **Consolidated per-model `run_timeout_sec` overrides** in a single `case`.

### Benefits

- Add a model **once** and every run script picks it up — no drift between
  horizons.
- Credential handling lives in one place; adding a provider is one prefix case.
- Run scripts shrink to "which subset + how to launch," with shared mechanics
  factored out.

### Scope of work

1. Add `ALL_MODELS` / `ALL_SKILLS` / `ALL_MODEL_LABELS`, the prefix-based
   credential dispatch, `AGENT_ENV_FLAGS`, and `sandbox_timeout_for_horizon()`
   to `run-common.sh`.
2. Reconcile the drifted model lists into one canonical `ALL_MODELS` (decide the
   intended membership per horizon).
3. Update each run script to source these instead of redefining them; keep only
   intentional per-script `SELECTED_MODELS` overrides.
4. Smoke-test with `--dry-run` on each script to confirm the emitted `harbor run`
   commands are unchanged for the models that should be present.

### Risk / validation

Medium — touches every run script. Mitigate by comparing `--dry-run` output
before and after for each script, model by model, so any change in the launched
command is caught before a real run.

---

## Suggested order

Do **#1 first** — it is self-contained and low-risk. **#2** is higher value for
day-to-day maintenance but touches more files; tackle it once #1 is merged.
