# Drift detection for the Claude Code CLI — `scripts/cli-drift.mjs`

Question: the harness spawns the user's own `claude` binary with ~15 flags and speaks its stdio
control protocol. The protocol has held still; argv has not. What is the cheapest thing that turns
the *next* silent argv change into a red build?

Built 2026-09-05 against the installed CLI `2.1.261 (Claude Code)` **[measured]** and
`@anthropic-ai/claude-agent-sdk@0.3.257` from `~/.npm/_npx`. **[measured]**

Prior briefs: `docs/research/cli-protocol.md` (the wire itself), `docs/research/acp.md` (the churn
census this leans on). Not repeated here.

---

## 1. Why argv, and not the wire

- Across **289 SDK releases and 342 days** (0.1.0 2025-09-29 → 0.3.261 2026-09-04) the
  `control_request` / `control_response` / `control_cancel_request` envelope, the base argv literal,
  the `--permission-prompt-tool stdio` sentinel and `can_use_tool` / `hook_callback` / `initialize` /
  `interrupt` were byte-identical; `can_use_tool` gained one field (`default_to_no`) and lost none.
  **[source: docs/research/acp.md:398-406]**
- That figure is **not firsthand**. It is a subagent's eight-tarball diff, and `docs/research/acp.md:648-653`
  already records that only 0.3.257 was on disk and the history was "spot-checked at one endpoint".
  It is repeated here as a reason, not as a measurement of mine. **[source]**
- **Exactly one breaking change was observed in that window, and it was argv, not the wire**:
  `Z.push("--resume", id)` at 0.3.159 became `` Z.push(`--resume=${id}`) `` at 0.3.221.
  **[source: docs/research/cli-protocol.md:233-234]**
- Firsthand cross-check on this machine: the template form `` `--resume=${v}` `` is present in
  `sdk.mjs` at **both 0.3.232 and 0.3.257**; a `"--resume"` string literal appears in neither.
  **[measured]**
- `claude --help` at 2.1.261 prints `-r, --resume [value]` — an **optional** argument. **[measured]**
  With optional arity the old two-argv spelling is not a parse error: the flag is consumed with no
  value and the session id falls through as a positional. The failure shape is silence, not an
  error. **[asserted — never executed against a live CLI, because doing so starts a session;
  `docs/research/acp.md:655-656` records the same gap]**
- `docs/research/cli-protocol.md`'s recommendation asked for "a CI job that re-packs the SDK on each
  CLI bump and diffs the control types". It was never built — `.github/` does not exist in this
  repo. **[measured, 2026-09-05]** And as scoped it would not have caught the one thing that broke,
  because `--resume` is argv, not a control type.

So the detector snapshots argv first and the control types second, and it can run with only the
first available.

## 2. What the script does

`scripts/cli-drift.mjs`, 408 lines, Node ESM, no dependencies. **[measured]**

    node scripts/cli-drift.mjs            # compare; exit 1 on any difference
    node scripts/cli-drift.mjs --update   # rewrite the snapshots; review, then commit
    node scripts/cli-drift.mjs --help

**Cost is zero and must stay zero.** It runs `claude --version` and `claude [<sub>] --help` and
nothing else — no prompt, no session, no API call. The file says so in a banner at the top, because
the next person to edit it will be tempted. Wall clock for a full run: **1707 ms**. **[measured]**

Two committed snapshots, both plain text and line-diffable:

| file | what it holds |
|---|---|
| `scripts/cli-drift.argv.snapshot` | 23,982 B — `cli-version`, then 19 help pages: 19 `usage` lines, 19 `body-digest`s, 102 options, 54 commands, 2 positional arguments **[measured]** |
| `scripts/cli-drift.sdk.snapshot` | 4,877 B — SDK version, `manifest.json` CLI version, the stdio sentinel, 52 argv flag literals, 41 `sdk.mjs` subtypes, 66 `sdk.d.ts` subtypes **[measured]** |

**argv snapshot.** `claude --help` is parsed, then every top-level command it lists gets its own
`claude <sub> --help` — the subcommand list is read from the root help, so a new subcommand is
picked up without editing the script. 19 pages on 2.1.261: root plus `agents attach auth auto-mode
doctor gateway import install logs mcp plugin project respawn rm setup-token stop ultrareview
update`. **[measured]** Each entry is stored keyed by its canonical long flag, with the alias list
and the value spec in separate fields:

    opt	--resume	flags=-r, --resume	arg=[value]	:: Resume a conversation by session ID, or …

Keying that way is the point: an arity change reports as one changed entry, not as an unrelated
add/remove pair.

**Normalisation.** ANSI stripped; `$HOME` and any `/Users/<name>` rewritten to `~`; wrapped
description lines unwrapped and whitespace collapsed, so terminal width cannot move the snapshot.
`COLUMNS=80`, `NO_COLOR=1` are set and stdout is piped, so commander's own wrap is fixed too. Each
help page also carries a `body-digest` (sha256/16 of the whole normalised page) as a backstop for
anything the parser does not model.

**SDK snapshot.** Resolution order: `CLAUDE_AGENT_SDK` → Node resolution from the repo → highest
version found under `~/.npm/_npx/*/node_modules/@anthropic-ai/claude-agent-sdk`. The SDK is not a
dependency of this repo (the harness speaks the protocol directly), so on this machine it resolves
via the npx scan. **[measured]** It reads `sdk.mjs` and `sdk.d.ts` and never executes them.
The flag regex accepts **template literals as well as quotes**, which is why `--resume=` is captured
at all — the minified source spells it `` `--resume=${v}` ``, so a quote-only grep returns nothing.
**[measured: a `"--resume[^"]*"` grep over 0.3.257 `sdk.mjs` returns 0 hits]**

**If the SDK is not resolvable** the script prints one line saying so and completes the argv check
anyway, exiting 0 when argv matches. Verified by running with `CLAUDE_AGENT_SDK=/nope/nothing`:
`SDK type surface NOT checked … carrying on with the argv check only`, exit **0**. **[measured]**

## 3. The diff report

Differences are bucketed, because the ~9 kB of help prose in the snapshot would otherwise bury the
one line that matters:

- **flags, arity and commands** — added/removed entries, alias spelling changes, and `! ARITY`
  lines. This is the bucket that breaks spawning.
- **help text only** — same flag, same arity, reworded description. Review and accept.
- a fallback that dumps raw line diffs if the bytes differ but no parsed entry did (i.e. the
  `body-digest` moved) — the signal to look at the file by hand.

Against a snapshot hand-edited to the historical break, the report reads:

    ! claude: opt --resume: ARITY <value>  ->  [value]

## 4. Verification

| check | result |
|---|---|
| `--update` then run → exit code | **0** **[measured]** |
| run a second and third time → exit code | **0**, **0** — output byte-identical **[measured]** |
| snapshot corrupted (`--resume` arity, `--verbose` deleted, one description reworded, `cli-version` back-dated, an `attach` usage line altered, `--resume=` → `--resume` in the SDK snapshot) → exit code | **1**, with all six reported in the right buckets **[measured]** |
| snapshot restored → exit code | **0** **[measured]** |
| `CLAUDE_AGENT_SDK` pointed at a nonexistent path → exit code | **0**, with the skip announced **[measured]** |

## 5. What it deliberately does not check

- **The wire.** No frame is ever observed. Everything about the control protocol here is read from
  `sdk.mjs` / `sdk.d.ts` on disk. Observing frames means starting a session, which costs money;
  `crates/claude-spike/fixtures/` already holds recorded transcripts for that job.
- **Whether the old `--resume <id>` spelling actually misbehaves.** Inferred from `[value]` arity,
  never executed. Same gap as `docs/research/acp.md:655-656`.
- **Nested subcommands.** One level only. `claude mcp add --help`, `claude auth login --help` and
  friends are not snapshotted; `claude mcp`'s own command list is, so a new nested command shows up
  as a changed `cmd` entry in the `## claude mcp` section but its flags do not.
- **Hand-rolled help pages.** `attach`, `logs`, `respawn`, `rm`, `stop` do not print commander
  sections; only their `Usage:` line and `body-digest` are captured. `rm`'s inline
  `--discard-unpushed <commit>@<worktree-id>` is covered by the usage line, not by a parsed entry.
  **[measured]**
- **Wiring into CI or `package.json`.** Not done — this order owned `scripts/**` only. `.github/`
  still does not exist. Adding `"drift": "node scripts/cli-drift.mjs"` and a workflow step is a
  one-line follow-up for whoever owns those files.
- **Cross-machine portability of the SDK section.** The npx-cache scan picks the highest local
  version, so a machine with a different SDK will diff on `sdk-version` and its flag set. That is
  drift and reporting it is correct, but it means the SDK snapshot is only meaningful once the SDK
  version is pinned or `CLAUDE_AGENT_SDK` is set deliberately.

## Not checked

- No CI run. The three exit-code checks above were run by hand on macOS 25.5.0, Node v24.18.0, one
  machine, one `claude` install.
- The 289-release / 342-day stability figure was not reproduced. Two SDK copies were compared for
  `--resume` (0.3.232, 0.3.257); the other 287 releases are `docs/research/acp.md`'s subagent claim.
- Whether any `claude <sub> --help` can ever be expensive or stateful. All 18 returned usage text in
  60–160 ms on this machine **[measured]**; the script guards a future one with a 15 s timeout and
  records `unavailable` rather than hanging, but that path was not exercised.
- Windows and Linux. Not run. The `/Users/<name>` normalisation is macOS-shaped; `$HOME` rewriting
  covers the general case but was not tested elsewhere.
- Whether commander's help width can be forced by something other than `process.stdout.columns`.
  Descriptions are unwrapped and collapsed before hashing, so width should be irrelevant, but this
  was reasoned about, not fuzzed. **[asserted]**
- The parser's behaviour against a help page that uses a section header this script does not know
  (`Usage:`, `Arguments:`, `Options:`, `Commands:` are the four it parses). Unknown sections are
  skipped, and only the `body-digest` would move.
