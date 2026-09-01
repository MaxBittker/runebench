# rs-sdk chat API — investigation + recommendations (RuneBench, 2026-06-30)

> **STATUS: implemented in rs-sdk on 2026-06-30** (all 6 items). See the
> "Implemented" section at the bottom for the file-by-file changes and the
> refinements found while wiring it up. The recommendations below are the
> original investigation, kept for context.


Context: the collaborative tasks (Shield of Arrav duo, smith-team trio) hinge
on agents talking to each other in-game via `sdk.sendSay()` + reading
`sdk.getState().gameMessages`. Across the fable-5 + 9-model sweeps the agents
*talk constantly* but cooperation keeps breaking down. Investigating how they
actually use the chat API shows the API itself is a big part of why.

Evidence drawn from agent trajectories (`jobs/arrav-duo-*/agent/opencode-*.txt`,
`jobs/smith-team-*/...`) and rs-sdk source.

---

## What the agents actually do (observed patterns)

- **Manually prefix every message** with `"A: "` / `"B: "` —
  `sendSay("A: killed jonny, have report...")` — even though `sender` exists.
- **Hand-roll a "new since last poll" cursor**: loops like
  `for (const msg of state.gameMessages) { if (msg.tick > msgBaseline) {...} }`,
  tracking their own `msgBaseline` tick.
- **Hand-roll sender filtering** with undefined guards:
  `gameMessages.slice(-8).filter(m => /agentb/i.test(m.sender || ''))`.
- **Slice past the end of the buffer**: `.slice(-12)` / `.slice(-8)` — but the
  buffer is only 5 deep (see #1), so these silently return ≤5.
- **Spam status pings**: "URGENT status check", "reply yes/no", "STATUS? did you
  get it?" — because there is no delivery/visibility feedback.

## Root causes in the API

### 1. The readable chat buffer is 5 messages deep and mixes player chat with system spam  ← biggest issue
`StateCollector.collectGameMessages()` returns **at most 5** entries, pulled
from the client's combined chat arrays — so player chat is interleaved with
system messages (level-ups, combat, "You advanced a Smithing level", etc.).
At 4–8× speed those system lines fire constantly, so a partner's message is
pushed out of the 5-slot window within a few ticks. If you don't poll in that
narrow gap, the message is **gone**. This is the structural reason cooperation
fails: it's not that the models won't coordinate — their messages physically
evaporate before the partner reads them, which is why the transcripts are full
of "STATUS?", "reply", "did you get it?". The agents' `.slice(-12)` filters are
operating on a 5-deep buffer they think is deeper.

### 2. "New since last read" exists internally but isn't on the SDK surface
The MCP server already tracks `lastShownMessageTick` and only renders NEW
messages in `execute_code` output (`mcp/server.ts:279`). But
`sdk.getState().gameMessages` exposes no cursor, so agents reinvent it with
`msgBaseline`. The concept exists — it's just not promoted to the SDK.

### 3. No self/other distinction
Each `GameMessage` is `{type, text, sender, tick}` with no "is this me?" flag,
so agents regex-match `sender` (with `|| ''` guards) and additionally bake
`"A:"/"B:"` into the text. Both are workarounds for a missing affordance.

### 4. ~80-char limit + word-filter censorship, with no feedback
Chat goes through `WordEnc.filter` (`MessagePublicHandler`) and a ~80-char RS
cap. Long coordinated plans get truncated mid-word, and some tokens get
asterisked out (observed: `"...right *******"`, `"X****x! Got 13tin..."`).
`sendSay` returns nothing useful, so the agent never learns its message was
clipped or censored — it just gets ignored downstream.

### 5. Undocumented
`sdk/API.md` lists only `sendSay(message)`. `gameMessages` and "how to read
your partner's chat" appear nowhere in the SDK reference — agents discover the
read path by trial and error.

---

## Recommendations (ranked by impact)

1. **Dedicated, deeper, player-only chat ring buffer.** Keep player chat
   (type 2/3) in its own buffer of ~50 messages, separate from the 5-deep
   system `gameMessages`, so system spam can't evict it. Expose
   `sdk.getChat({ limit })`. *This alone fixes most of the cooperation failure.*

2. **Cursor-based read: `sdk.getNewChat()`** returning only messages since the
   last call (per-session high-water tick) — promote the MCP formatter's
   `lastShownMessageTick` to the SDK. Removes the hand-rolled `msgBaseline`
   loops and the "did I already see this?" ambiguity.

3. **Tag self vs others.** Add `fromSelf: boolean` to each chat entry and a
   `sdk.getChatFrom(name)` / `getPartnerChat()` helper. Eliminates the
   `sender || ''` regex filtering and the manual `"A:/B:"` prefixing.

4. **Make `sendSay` report back.** Return `{ sent, truncated, filtered,
   finalText }` so the agent knows if its message was clipped or censored.
   Optionally add `sdk.say(longText)` that auto-splits into ≤N-char lines and
   sends them in order (with a small inter-line delay), so plans aren't lost to
   the 80-char cap.

5. **Document it.** Add `getChat` / `getNewChat` / `sendSay` (with the length
   limit + filter caveat) to `API.md` and the MCP "SDK API" resource, plus a
   3-line "talk to your teammate" recipe.

6. **Optional porcelain.** `bot.broadcast(msg)` and `bot.readNewMessages()` in
   the Bot API for the common duo/team pattern.

Items 1–2 are the high-leverage fixes; they convert "messages silently
vanish" into "messages reliably arrive once," which is the actual bottleneck
for every collaborative task. After landing, bump the app image + DOCKER_IMAGE.

---

## Implemented (2026-06-30)

All six items shipped. Both type files (`sdk/types.ts` + the webclient
`bot/types.ts`) and `sdk/API.md` (regenerated) are updated. SDK + webclient
typecheck clean (only a pre-existing nullability error in
`sdk/test/banking-withdraw-amount.ts`, unrelated).

### Refinements found while implementing (these changed the plan)

1. **The deep buffer already existed — fix #1 was ~5 lines, not a new subsystem.**
   The client (`Client.ts:495-498`) already keeps a **100-deep**, type-tagged
   chat ring. `StateCollector.collectGameMessages()` was throwing away 95 of
   them *and* not type-filtering. Fix = stop truncating + tag each message.

2. **Order was a latent bug.** The ring is newest-first, but the formatter and
   the agents' `.slice(-N)` expect newest-*last*. With the old 5-cap this was
   masked (slice(-5) of 5 == all). Bumping to 50 would have surfaced the 5
   *oldest*. `collectGameMessages` now returns **chronological** order.

3. **The `{2,3}` player-chat filter had a gap.** Crowned public chat is **type
   1** and crowned PMs are **type 7** (`addChat` calls in `Client.ts`). The old
   `showChat` filter and the formatter keyed on `{2,3}` only, so a teammate's
   chat would vanish the moment that bot had any rank icon. Now everything keys
   on a shared `PLAYER_CHAT_TYPES = [1,2,3,6,7]` / `isPlayerChat()`.

4. **`fromSelf` / `truncated` / `finalText` are computable with zero round-trip.**
   Own messages echo into the buffer under the local name, so `fromSelf` is set
   server-side in `collectGameMessages` (no agent-supplied name needed).
   `Client.say()` already computed the filtered text locally, so it now returns
   `{ ok, truncated, filtered, finalText }` directly. (Caveat: client
   `WordFilter` ≈ server `WordEnc.filter`, so `finalText` is a close
   approximation, not byte-authoritative.)

5. **Own-echo caveat (now handled):** because own chat echoes into the buffer,
   `getChat`/`getNewChat` exclude `fromSelf` by default (`includeSelf` opt to
   override) so a cursor read doesn't resurface your own messages.

### Files changed (rs-sdk)

- `server/webclient/src/client/Client.ts` — `say()` returns `SayOutcome`
  `{ ok, truncated, filtered, finalText }` (was `boolean`); new `SayOutcome`
  interface.
- `server/webclient/src/bot/ActionExecutor.ts` — `case 'say'` surfaces the
  outcome via `ActionResult.data` + an annotated message.
- `server/webclient/src/bot/StateCollector.ts` — `collectGameMessages()` now
  keeps the 50 most recent, strips `@cr/@col` codes from sender, sets
  `fromSelf`, returns chronological order.
- `server/webclient/src/bot/types.ts` + `sdk/types.ts` — `GameMessage.fromSelf`;
  `PLAYER_CHAT_TYPES` + `isPlayerChat()`; `SayResult` type.
- `sdk/index.ts` — new `getChat({limit,types,includeSelf})`,
  `getNewChat({types,includeSelf})` (internal `chatCursor` high-water tick),
  `getChatFrom(name,{limit})`, `say(text,{maxLen,delayTicks})` auto-chunker
  (module-level `chunkMessage`); `sendSay` JSDoc'd; `showChat` filter uses
  `isPlayerChat`.
- `sdk/formatter.ts` — Player Chat / Recent Messages split uses `isPlayerChat`
  + `fromSelf`; PM tag covers types 3 & 7.
- `server/webclient/src/bot/formatters.ts` — debug dumps capped at last 10
  (buffer grew 10×).
- `sdk/API.md` — regenerated (`getChat`/`getNewChat`/`getChatFrom`/`say` +
  `SayResult` now documented).

### MCP cursor — no change needed

The MCP's `lastShownMessageTick` (`mcp/server.ts:279`) reads `gameMessages`,
which is now 50-deep + chronological, so it reliably surfaces new messages on
its own. `sdk.getNewChat()` is the SDK-surface promotion of that same idea
(independent per-SDK cursor, so the two don't interfere).

### Still to do (not code)

- Bump the rs-sdk app image and `DOCKER_IMAGE` so the benchmark picks this up.
- Optional: empirically confirm the message-loss rate on the old sweeps to
  quantify the before/after (item the user offered).
