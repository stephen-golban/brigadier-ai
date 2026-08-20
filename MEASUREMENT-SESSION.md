> **STATUS: this work order is COMPLETE as of 2026-08-17, and is kept as a record of how phase 1 ran.**
> 17 research and prototype tickets closed; eight locked rulings amended on the map as rulings 38–45.
> Five tickets remain open as stated blanks — #39, #42, #46, #47, #48 — each blocked on a GUI client,
> an authenticated agent, or the owner's consent to exhaust a quota window, not on effort.
> The "Already measured — do not redo" section below was true when written; several of its lines have
> since been superseded by the tickets that measured them properly. **The map is the current record,
> not this file.**

Resolve every **measurement** ticket on the brigadier v2 wayfinder map. This is AFK work — no
decisions are yours to make; your job is to turn assumptions into evidence and record it.

## Context

brigadier v2 is a clean-room rebuild of a shipped orchestrator. It is an **ACP hub**: one Agent
Client Protocol client drives whichever coding agents are installed on the machine, isolates each
unit of work in its own `git clone --local`, and composes them — one vendor builds, a different
vendor reviews. It also presents itself as an ACP agent so editors can drive it. It is a
`bun --compile` binary targeting macOS, Linux and Windows.

**37 design decisions are locked and at least eight of them rest on assumptions nobody has
measured.** That is what you are fixing. Some of your results will *reverse* a locked decision;
that is a success, not a problem, and you must report it plainly rather than softening it.

## The map

`https://github.com/stephen-golban/brigadier-ai/issues/1` — read it **first and completely**. It
holds the destination, all 37 rulings with their reasons, the measured evidence so far, a
rejected-tooling list, the fog, and what is out of scope. Every ticket is a child issue.

Read it before touching anything. Several tickets reference rulings by number and will not make
sense without it.

## Your scope

**Only `wayfinder:research` and `wayfinder:prototype` tickets.** Leave every `wayfinder:grilling`
ticket alone — those are human-in-the-loop and resolving one without the owner is out of order.

Suggested order. #2 first because three other tickets unblock on it, then the rest are independent:

1. **#2** — ACP conformance: what each agent reports, and what its launch profile needs. *Partly
   started; read the existing comments before repeating work.* Unblocks #15, #25, #21.
2. **#27** — Verify Claude Code's plugin surface against the real binary. Contains a documented
   self-contradiction that decides how strong the product's core mechanism can be.
3. **#26** — Agent Plugins 1.0: where do clients actually look. **A path was guessed and written
   into ruling 26. Find the real one.**
4. **#3** — Can the ACP permission model enforce a lane. This is the safety property the whole
   design rests on.
5. **#4** — Vendored bridges: licensing, embedding, and the 16.5× cache lever.
6. **#14** — Prototype: drive two agents over ACP end to end. *Already claimed and step 1 of 5 is
   done.* Steps 2–5 remain: `session/new` with a clone as `cwd`, a real prompt turn, answering
   `session/request_permission`, capturing both diffs.
7. **#23** — Repo map. **Measure whether tree-sitter WASM works under `bun --compile` BEFORE
   building anything else here** — a negative result reverses ruling 22 outright and the rest of
   the ticket is then wasted.
8. **#19** — Large repositories: partial clone, sparse checkout, clone pool.
9. **#5** — The Windows portability contract. Needs a real Windows host or `windows-latest`.
10. **#6** — What it takes for brigadier to *be* an ACP agent.
11. **#22** — Does compaction erase a worker's constraints.
12. **#15** and **#25** once #2 unblocks them.

## Protocol per ticket

1. **Claim it first**, before any work: `gh issue edit <n> --repo stephen-golban/brigadier-ai
   --add-assignee stephen-golban`. An unassigned open ticket means unclaimed, and other sessions
   may be working the map concurrently.
2. Do the work. Prefer a cheap probe over an argument.
3. Post the answer as a **resolution comment** on the ticket — findings, the commands that produced
   them, and what each result implies for the rulings it touches.
4. **Close the issue.**
5. **Append one line to the map's "Decisions so far"** section: the ticket's title as a link, plus a
   one-line gist of the answer. The map is an index, not a store — the detail lives in the ticket.
6. If a result **contradicts a locked ruling**, say so explicitly in the comment, name the ruling
   number, and add a line to the map. Do not quietly work around it.
7. If a result makes new work specifiable, create a child issue (`gh issue create` with the right
   `wayfinder:` label, then attach it: `gh api --method POST
   repos/stephen-golban/brigadier-ai/issues/1/sub_issues -F sub_issue_id=<id>` — note `-F`, not
   `-f`, or it fails with a type error).

## Measurement discipline — non-negotiable

Every one of these was learned the expensive way on the predecessor project. Violating them
produces confident wrong numbers, which is worse than no numbers.

- **Record every result as "MEASURED against `<tool> <version>` on `<date>`", never in the present
  tense.** A dependency moved mid-project last time and made every present-tense claim stale while
  measured-against statements stayed true forever.
- **Never `cmd | head` and then read `$?`** — you get `head`'s exit code. Same trap through a
  subshell: `out=$(...; cmd | head)` reports the pipeline's last element. Capture with
  `out=$(cmd 2>&1); rc=$?` and no pipe.
- **Never capture multi-line test output into a shell variable.** `out=$(bun test 2>&1)` silently
  drops lines to interleaving and has already produced a fabricated failure count that reached a
  shipped file. Redirect to a file and grep the file.
- **A probe must be the first thing that touches its subject**, or it is measuring its own warm-up.
  A timing check that runs after the same command already ran on the same artifact measures nothing.
- **Do not generalise from one sample.** In this very ticket set, `authMethods: []` was read from
  one agent and reported as an authentication-state signal; the second agent falsified it within the
  hour. Test both directions and at least two subjects before writing a rule.
- **A guard that always passes looks identical to a working one.** Every check needs a negative
  control: show it *fails* when it should. `if cmd; then fail; fi` accepts every nonzero exit
  including "the file does not exist" — establish the precondition on its own line first.
- **A skipped test is not a passing test.** If a check is platform-gated and does not run here, say
  so; do not count it.
- **Check the pid before believing a status file.** A crashed job leaves its state reading
  `running` forever.
- **`pgrep -f <pattern>` matches your own harness.** Put the pattern in a script file or match the
  executable path.
- **Verify negative claims as carefully as positive ones.** "Zero occurrences of X" has been wrong
  before; one `grep` settles it.
- **Search unconstrained, then filter.** Never enumerate file extensions from memory when the answer
  decides scope — a `--include` list already hid an entire file type and undercounted a change.
- **Do not trust a coordinate copied from documentation.** The first Codex probe hung against
  `@zed-industries/codex-acp`, which is a 4,497-byte stub at 0.16.0; the live package is
  `@agentclientprotocol/codex-acp` 1.4.0. Widely-cited docs still list the dead one. Verify against
  the registry.
- **Prefer a scratch install to "not installed, cannot verify."** `npm install --prefix <scratch>`
  with `XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `CODEX_HOME` pointed at scratch gives a real running
  agent without touching the owner's configuration.
- **A negative result is a good result.** Report it plainly. Do not soften, and do not keep
  rewording a probe until it passes.

## Already measured — do not redo, but do dispute if you find otherwise

On this machine (macOS, 24 GB RAM, 14 cores), 2026-08-16:

- `@agentclientprotocol/claude-agent-acp` **0.69.0** answers `initialize` in **4.4 s cold**
  (first run, includes the `npx` package fetch) and **0.68 s warm** (package cached);
  `@agentclientprotocol/codex-acp` **1.4.0** in **5.9 s cold**. Both `protocolVersion: 1`.
  **The expensive part is the one-time bridge fetch, not the handshake.**
- **`authMethods` is NOT an auth-state signal** — Claude returns `[]` and Codex returns two methods,
  both while verified authenticated.
- **Neither agent advertises models or reasoning effort at `initialize`.** `providers` is `{}` on
  both.
- **`sessionCapabilities.fork` is Claude-only.** Codex has resume/list/close/delete/
  additionalDirectories without it.
- `_meta` is a live vendor-extension channel: `claudeCode.promptQueueing`, `jetbrains.air`,
  `steering`, and a `goal` extension whose actions differ by vendor (Codex adds pause/resume).
- Clone cost on a 131 MB-object repo (2,928 tracked files, 67 MB): `clone --local --no-checkout`
  1.39 s / 96 MB; full `clone --local` 1.82 s / 163 MB. **Incremental disk ≈ 67 MB** — the object
  store hardlinks and is effectively free.
- The v1 binary is 63 MB, cold start 70 ms, warm 10 ms.

`probes/acp-handshake.ts` is committed in the repo. Extend it rather than starting over.

## Do not

- Do not resolve `wayfinder:grilling` tickets. They need the owner.
- Do not write product source. There is no brigadier v2 codebase yet and creating one is not this
  session's job. Probes go in `probes/`, clearly marked as throwaway.
- Do not port anything from the v1 repository (`stephen-golban/brigadier`). Ruling 1 is true zero;
  findings are input, code is not.
- Do not invoke `brigadier` or any orchestrator to do this work. A predecessor worker, given a plain
  "write two files" order, cloned the repo and ran the orchestrator instead — 12 minutes, zero
  files, where doing it directly took two. Do the work directly.
- Do not add new design decisions. Measure; the owner rules.

## Deliverable

Every research and prototype ticket closed with a resolution comment carrying its evidence, the map
updated with one Decisions-so-far line each, any contradicted ruling named explicitly, and any newly
specifiable work created as a fresh child ticket.

Report at the end: which rulings your measurements **confirmed**, which they **contradicted**, and
what you could not measure and why.
