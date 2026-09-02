# Can the CLI emit a `system/init` for a turn nobody sent, outside the background-subagent case?

Date: 2026-09-02. **Open question. Not settled by any capture on this machine, and it cannot be
settled from fixtures.** Raised while fixing `docs/STATUS.md` §5 defect 9; the adapter now mints a
continuation turn on a `system/init` that arrives with no open turn
(`crates/core/src/claude/adapter.rs:588`), so what the CLI does with `init` is load-bearing.

Every claim is tagged **[measured]** (a command run on this machine, or an exact byte read from a
file, with the path), **[source]** (read in source on this machine, `file:line`), **[documented]**
(vendor docs) or **[asserted]** (reasoning, unverified).

## The question, stated tightly

Does `claude` in stream-json mode ever write a `system/init` frame when the host has not written a
`user` frame and no background subagent is finishing — and if it does, does a `result` always
follow it?

## Why it matters

- An `init` with no open turn mints a turn (`adapter.rs:588`). If a `result` follows, everything is
  correct: that is the measured background-subagent case. **[measured]**
- If **no** `result` follows, the minted turn stays open. `SendTurn` pre-empts a minted turn
  (`adapter.rs:982-1022`), so the session cannot be locked out; `on_exit` (`adapter.rs:1126`)
  closes it at teardown. The residue is cosmetic and bounded: `busy` reads `true` while the CLI is
  idle, until the next send or exit. **[asserted, from reading those three sites]**
- Before that pre-emption existed the same case was a **wedge**: every `SendTurn` for the rest of
  the process answered `Rejected("a turn is already open")`, with a kill as the only escape.
  **[measured — `crates/core/tests/claude_adapter.rs:702` fails against that revision]**

## What is already known

- `system/init` and `result` alternate one-for-one in 14 of the 16 captures in
  `crates/claude-spike/fixtures/`. The two exceptions are `s7-kill.ndjson` (`I` with no `R`, the
  kill path) and `s7-can-use-tool-write.ndjson` (neither frame). **[measured]**
- An `init` for a turn the host never sent **is real and routine**: a finished background subagent
  produces one — `s9-subagent-agent-id.ndjson` line 56, `f-b-fanout.ndjson` lines 73, 90 and 103,
  each from a file whose `.sent.ndjson` holds exactly one `type:"user"` frame. **[measured]**
- Therefore `docs/research/claude-direct-spike.md:114-116` — "`system/init` only arrives after the
  first user frame is written" — is **true of the first `init` in every capture** and **false as a
  general rule**. It cannot be used to argue that some other bare `init` is impossible.
  **[measured]**
- The vendor documents one `result` per **turn** and a turn the host never sent for a finished
  background task (`origin: {kind:"task-notification"}`), plus a second unprompted kind,
  `auto-continuation`. It documents no rule about when `init` is written.
  **[documented, via docs/research/async-subagent-results.md §D]**

## Three paths that could produce a bare `init`, none captured

1. **Interrupt, then idle.** `s4-interrupt.ndjson` interrupts and then immediately sends a second
   turn; the process never sits idle after an interrupt. **[measured]**
2. **`set_model` or `set_permission_mode` while idle.** No `.sent.ndjson` in the fixture directory
   contains either subtype, so no capture exercises a control request on an idle session.
   **[measured]**
3. **Auto-compaction.** No capture contains a `compact_boundary` frame. **[measured]**

## Why `s4-interrupt` cannot answer it

The capture itself is faithful: the spike's stdout reader is a background task that appends each
line to `fixtures/<scenario>.ndjson` as it arrives and only then forwards it
(`crates/claude-spike/src/session.rs:115-123`, and the module doc at `:4-5`), so file order is the
CLI's production order and does **not** depend on when the caller reads. **[source]**

What is missing is the interleaving. The host's writes go to a *separate* file,
`fixtures/<scenario>.sent.ndjson` (`session.rs:82-84,152-155`), and **neither file carries
timestamps** — every line is the frame verbatim. **[measured]** So nothing in the capture places
`s4`'s second `init` before or after `send_user`. Scenario 4's own shape makes this concrete: it
breaks its read loop at the first `result` (`crates/claude-spike/src/main.rs:374`), then calls
`wait_exit(Duration::from_millis(300))`, which awaits only `child.wait()` and reads no stdout
(`crates/claude-spike/src/session.rs:265-271`), and only then calls `send_user`
(`main.rs:390`). **[source]** An `init` produced anywhere inside that 300 ms window is in the
`.ndjson` either way, in the same place. The fixture's ordering is therefore consistent with both
answers.

## The spike that would settle it

**Do not run this without the owner's go: it spends real money on a live account.** Four turns,
one new scenario in `crates/claude-spike`.

1. Spawn, `initialize`, send one long turn, interrupt mid-turn, read to the `result` — the
   existing scenario 4 setup (`crates/claude-spike/src/main.rs:315`).
2. Then **send nothing and keep reading stdout for 60 s**, recording every frame.
3. Repeat with `set_model` in place of the interrupt; again with `set_permission_mode`; again with
   a turn long enough to auto-compact.
4. Verdict: any `system/init` inside an idle window is the bare `init`, and the report must also
   say whether a `result` followed it within the window. None in 60 s across all four runs leaves
   the risk theoretical and the pre-emption as cheap insurance.

One change the spike needs first: the capture writes frames verbatim with no clock
(`session.rs:115-123`), so add an elapsed-ms sidecar (`<scenario>.timing.ndjson`) rather than
altering the fixture format, which the adapter tests replay byte for byte
(`crates/core/tests/claude_adapter.rs:34`). **[asserted]**

## What was NOT checked

- No `claude` process was run for this file. **[measured claims are all reads of files on disk]**
- Whether a `result` follows a bare `init` — unanswerable without the spike above.
- Whether the CLI queues or rejects a `user` frame written while it is mid-turn. Documented as
  queued, unmeasured here (`docs/research/async-subagent-results.md` §D4).
- Whether `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` changes any of this. It removes the
  subagent-continuation path (`async-subagent-results.md` §D1) but says nothing about the three
  paths above.
