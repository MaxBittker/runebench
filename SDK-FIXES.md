# rs-sdk fixes requested from RuneBench (arrav-duo first live run, 2026-06-03)

Context: first live run of the two-bot Shield of Arrav benchmark
(claude-sonnet-4-6, 30m) DNF'd because of a modal-interface tarpit. The quest
*requires* reading a book that opens a full-screen modal; while that modal is
open most actions silently fail, and the agent burned ~27 of 30 minutes
diagnosing it. Trajectory evidence: `rs-bench3/jobs/arrav-duo-sonnet46-20260603-153552/`.

## 1. `dismissBlockingUI()` should close modal interfaces (the real fix)

`sdk/actions.ts:190` — the docstring says "Dismiss any blocking UI like
level-up dialogs" and ~20 porcelain actions call it first, but it only clicks
through `dialog.isOpen` chat dialogs. Modal interfaces
(`state.interface.isOpen`: books, quest scrolls, level-up art) are ignored,
so every subsequent action stalls with no indication why.

Proposed change (inside the existing retry loop, after the dialog branch):

```ts
// Modal interfaces (books, quest scrolls, level-up art) also block input.
// Shop/bank are deliberate interfaces with their own close actions — skip.
if (state.interface?.isOpen && !state.shop?.isOpen && !state.bank?.isOpen) {
    await this.sdk.sendCloseModal();
    await this.sdk.waitForStateChange(2000).catch(() => {});
    continue;
}
```

Safety notes:
- Quest/book varps are set when the modal *opens* (see
  `quest_blackarmgang/scripts/arrav_book.rs2`), so auto-closing loses nothing.
- `state.shop.isOpen` / `state.bank.isOpen` are separate flags, so deliberate
  shop/bank sessions are not disturbed (their actions don't call
  `dismissBlockingUI` anyway, but be conservative).

## 2. Actionable failure when a modal is blocking

When an action fails/times out while `interface.isOpen` is true, include the
cause in the result message, e.g.:

```
"... failed: a modal interface (id 837) is open and blocking input — close it with sendCloseModal()"
```

This is the difference between a 30-second recovery and the 27-minute
source-dive we observed. Cheapest implementation: a shared check in the
porcelain failure paths (or in the MCP `execute_code` result formatter when
the final state has `interface.isOpen && !shop.isOpen && !bank.isOpen`).

## 3. Optional: `bot.closeInterface()` porcelain

`closeBank()`/`closeShop()` exist; a generic
`closeInterface(): Promise<ActionResult>` wrapping `sendCloseModal()` +
`waitForCondition(!interface.isOpen)` would make the capability discoverable
in the Bot API resource where agents look first.

## 4. Regenerate `sdk/API.md` (stale)

`sdk/API.md` predates `sendCloseModal`, `sendCloseShop`, and
`sendCountDialog` — none appear in it. The MCP resource (`mcp/api/sdk.ts`)
does list them, so this is doc-only drift: re-run
`bun sdk/generate-api-docs.ts` (and check the generator picks those methods up).

---

After these land, RuneBench needs a new app image (v41) and a `DOCKER_IMAGE`
bump in `rs-bench3/generate-tasks.ts`. Until then the arrav task instruction
carries a stopgap hint about `sendCloseModal()` (added 2026-06-03).
