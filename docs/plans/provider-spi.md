# Plan: provider adapter SPI and the Claude Code driver

Date: 2026-09-02. Status: work orders issued; nothing below is built until its evidence line says so.

Every decision here cites the research file it rests on. A decision without one is marked
**[asserted]** and is open to challenge.

## Decisions

1. **Rust speaks the Claude Code stdio control protocol directly; the bun sidecar is a fallback,
   not the primary path, until a spike proves otherwise.** `docs/research/cli-protocol.md`: the SDK
   spawns `claude --output-format stream-json --verbose --input-format stream-json
   --permission-prompt-tool stdio` (no `--print`), and the control plane is 8 CLI→host request
   subtypes, of which the harness needs `can_use_tool` and `hook_callback`. Verified by the lead in
   the unpacked `sdk.mjs` 0.3.257. The owner flagged this as an open question in the handoff; the
   settled "Node sidecar" line is not reopened here, it is measured. **Gate:** the spike in WO-C
   must show `can_use_tool` round trip, `interrupt`, and `--resume` against a real session. If it
   fails, the same canonical events and driver trait are fed by a relay sidecar instead; only the
   control-envelope layer changes. Deleting `sidecar/` is the owner's call after the gate.
2. **Spawn children with `tokio::process::Command`, not `tauri-plugin-shell`.**
   `docs/research/tauri-runtime.md`: the plugin's sidecar channel is `channel(1)` with three
   blocking OS threads per child (verified in `tauri-plugin-shell-2.3.6/src/process/mod.rs:320`),
   and its exit sweep never sees Rust-spawned children. Process groups plus a pid file plus a
   startup sweep are ours to build.
3. **Binary resolution: the user's `claude` install, pinned by version check, feature-detected via
   `capabilities` in `system/init`.** `docs/research/agent-sdk.md` §1: SDK patch equals CLI patch,
   `capabilities` is the intended handshake. Ship-vs-depend is a product decision left to the owner;
   the driver takes an explicit path plus a minimum version, defaulting to `which claude`.
4. **One account = one `CLAUDE_CONFIG_DIR`. Never override `HOME`.** `docs/research/agent-sdk.md`
   §9 and `docs/research/provider-driver.md` (t3code's continuation key ignores the account home
   and collapses two accounts; we key identity by config dir).
5. **Driver is a plain value, N instances, no singleton.** `docs/research/provider-driver.md`:
   copy t3code's `driverKind` vs `instanceId` split, per-instance scope, approval parked on a
   locally minted id; reject their unbounded pub-sub, untimed approvals, and twin event lists.
6. **Canonical events: a small shared core (about 15), each carrying a bounded `raw` excerpt.**
   `docs/research/provider-driver.md`: 24 of t3code's 49 event types have one emitter; we do not
   copy those.
7. **Two cancellation shapes are both first-class.** `docs/research/agent-sdk.md` §10: interrupt
   keeps the session and yields a real `result`; kill yields no `result` so the adapter synthesises
   `turn.aborted`.
8. **Cost from `modelUsage` on the latest `result`, cumulative, never summed.**
   `docs/research/agent-sdk.md` §6.
9. **Cargo workspace: `crates/core` (no Tauri dependency) and `src-tauri` (the app).**
   **[asserted]** Standard Cargo layout; lets the SPI and spike build and test headless.

## Work orders

| id | owns | deliverable | model |
|---|---|---|---|
| WO-0 | root `Cargo.toml`, `crates/core/{Cargo.toml,src/lib.rs}`, `src-tauri/Cargo.toml` (workspace membership only) | workspace skeleton, `cargo check` green | sonnet |
| WO-A | `crates/core/src/{event.rs,driver.rs,approval.rs,session.rs}` | canonical event schema, driver trait, session handle, approval park with timeout, unit tests | opus |
| WO-B | `crates/claude-wire/` | serde types for CLI stream-json messages and control envelopes, decode tests | opus |
| WO-C | `crates/claude-spike/`, `docs/research/claude-direct-spike.md` | headless spike proving decision 1's gate, real NDJSON fixtures | opus |
| WO-D (after A+B+C) | `crates/core/src/claude/` | `ClaudeDriver`: wire → canonical, approvals, resume, tested on WO-C fixtures | opus |

## Evidence log

- WO-0: done. Root `Cargo.toml` workspace, `crates/core` with no Tauri dep; `cargo check --workspace` 0, `npx tauri build --debug --no-bundle` 0. Lead reviewed. `license = "MIT"` in the workspace is a placeholder; no LICENSE file exists.
- WO-A: done. `crates/core/src/{event,driver,session,approval}.rs`, 29 tests, check/test/clippy/doc all 0, re-run by the lead. Lead review: sound; gaps folded into WO-D (`tool_call_id` on `ToolPermission`, parent id on items, `PermissionMode::Other` wire shape, adapter loop must not block commands on event backpressure).
- WO-B: done. `crates/claude-wire/`, 11 tests, check/test/clippy/doc all 0. Lead check: all 119 lines of the real spike captures decode with zero errors, and every known frame lands in its typed arm (`init`, `assistant`, `user`, `result` success/error, `can_use_tool`, `hook_callback`, `control_response`); `thinking_tokens` rides in the system catch-all losslessly. Worker found `docs/research/cli-protocol.md` §2 wrongly credits `sdk.d.ts` for two `initialize` fields that exist only in `sdk.mjs`.
- WO-W: done. `crates/core/src/worktree.rs` + integration tests, 41 tests total in core, test/clippy/doc all 0. Lead review: sound. Known: a failed `add` leaks the branch on git 2.50.1; callers must `delete_branch` on teardown.
- Scrub: done. Zero hits for the email, home path or scratch uuid in the `.ndjson` fixtures. `fixtures/README.md` line 16 still names the original home path in prose; fold into the post-review fix order.
- WO-C: done, **gate passed 7/7**. `docs/research/claude-direct-spike.md`; fixtures in `crates/claude-spike/fixtures/`. Lead verified in the raw captures: `can_use_tool` frame, `terminal_reason` `aborted_streaming` then `completed`, two `system/init` per interrupted session, `hook_callback` frame. Cost $0.10 over 11 sessions on `claude-haiku-4-5`, CLI 2.1.257. Findings that bind WO-D: `can_use_tool` is shadowed by the user's `settings.json` `defaultMode` and by the CLI's safe-command classifier, so the harness pins `--permission-mode` and gates every tool through a `PreToolUse` hook; `system/init` arrives once per turn; `rate_limit_event` and `system/thinking_tokens` are undocumented top-level frames; an interrupted result has `subtype: error_during_execution`. Fixtures carried the owner's email, org and home path; scrub order issued. Not checked by the spike: kill during an active tool call, the `-- all` runner as one command.
- WO-W (worktree module): issued after WO-A, pending.
- Blind review (A+B+W): done, gates re-run green (52 tests). Five confirmed bugs: approval timer fires on a reused request id (no epoch); `Inbound`'s derived `Deserialize` can never yield a control arm; a drifted known control frame hard-errors instead of degrading; `open(.., Some(timeout))` panics off a runtime; one drifted field type demotes `system/init` to the catch-all. Four spec deviations: `raw` bounded only by the helper, `INPUT_EXCERPT_LIMIT`/`SUMMARY_LIMIT` enforced nowhere, no graceful `EndSession` command, round-trip claim overstated. Lead confirmed items 1, 2 and 5 by reading the code. Adjudication: all accepted. F1 (approval.rs + claude-wire + README) issued immediately; F2 (event/session/driver shape: bounded `raw`, enforced limits, `EndSession`, approvals and ids on `SessionHandle`) waits for WO-D so the files are not edited twice.
- F1: done, lead re-ran gates (claude-wire 16 tests, approval 11 tests, clippy clean). Approval timer now epoch-checked; `Inbound` deserialize hand-written over a shared classifier; drifted control frames degrade to `Unknown`; `system/init` fields lenient; `skip_serializing_if` on 182 Option fields with 7 kept as explicit null because the captures always carry them; all 119 real capture lines round-trip byte-faithfully. `AnthropicMessage.stop_reason`/`stop_sequence` moved into `extra` with accessors because assistant frames write them null and user frames omit them.
- WO-D: done. `crates/core/src/claude/{mod,binary,process,hook,adapter,driver}.rs` + `tests/claude_adapter.rs`; 75 core tests. Lead re-ran the whole workspace: 111 passed, 0 failed, 1 ignored; clippy and doc clean. **Lead ran the ignored `live_pong` test against the real `claude` 2.1.257 binary: passed in 3.2 s** (handshake, one turn, `TurnCompleted{EndTurn}`), so the direct-protocol driver has been run, not just built. Loop design: never awaits an event send; outbox plus `reserve` permit keeps commands live under backpressure. New dep `nix` 0.31.3 (`signal` only) for `killpg`. Not tested by anyone: kill during an active tool call (grandchild), SIGTERM→SIGKILL escalation, `stream_event` deltas (off), `compact_boundary`, subagent nesting, resume end to end, two live sessions at once.
- F2 (SPI shape from the review): done. `raw` bounded on deserialize and via `with_raw` (field stays `pub` because `crates/store` tests build `Envelope` literals; a literal inside the workspace can still set an unbounded `raw`); `RequestKind::tool_permission` and `Event::item_*` constructors enforce the excerpt and summary limits and the adapter uses only them; `Command::EndSession` closes stdin and yields `SessionExited{Graceful}`; `SessionCommands::respond` resolves the approval table directly, `Command::Respond` removed; `SessionHandle` carries `session_id` and `instance_id`. 83 core tests.
- **Final gates, run by the lead 2026-09-02:** `cargo test --workspace` 119 passed, 0 failed, 1 ignored (`live_pong`, which the lead ran separately and it passed); `cargo clippy --workspace --all-targets -- -D warnings` clean; `cargo doc --workspace --no-deps` 0 warnings; `cargo build -p brigadier` (the Tauri app crate) 0. 11,891 lines of Rust across `crates/`. Zero `unwrap()` in non-test source. Not committed; awaiting owner approval.
- WO-S (persistence, `crates/store/`): done. 17 tests, test/clippy/doc/check all 0. Measured: 10,000 feed ops in 65–69 ms; 50,000 ops with cap 500 leave a 176,128-byte file. Finding kept in code: `PRAGMA incremental_vacuum` frees one page per step and must be drained as a query, else the same test ends at 12 MB. `rusqlite` 0.40.2 needs the `fallible_uint` feature for `u64` columns. Lead review of schema and loop: matches `docs/research/persistence.md`; two loop smells (read queries wait a full batch window; the window is polled at 1 ms) sent as F-S. Not checked by the worker: concurrency from N tasks, the 250 ms timer path, gzip on rotate.
- Decision 1 outcome: Rust speaks the protocol directly. Owner decided 2026-09-02: `sidecar/` deleted (the bun recipe survives in `docs/research/sidecar-spike.md`); the `claude` binary is never bundled, the harness depends on the user's install and reports when it is missing.
