# What sits between `spawn` and `system/init`: MCP is half of it

Date: 2026-09-03. Status: **executed against a live account**, 12 spawns, $0.079 spent.
Every number is **[measured]** unless tagged otherwise.

Harness: `crates/claude-spike/src/bin/spawn_split.rs`, driving `crates/claude-spike/src/session.rs`.
Fixtures: `crates/claude-spike/fixtures/spawn-split/` (12 runs, 3 files each) and
`crates/claude-spike/fixtures/spawn-split.summary.json`.

## Bottom line

MCP server startup is **751 ms of the 1,395 ms** median spawn to `system/init`, and it is
**100% of the pre-turn gap** the CLI's own clock does not count (741 ms with MCP on, 6 ms with MCP
off). **[measured]**

Turning MCP off costs $0.00016 per turn in the other direction and buys back roughly three quarters
of a second on every spawn. **[measured]**

Recommendation: **the harness spawns children with `--strict-mcp-config` and no `--mcp-config`, so
no MCP server loads, and a project opts in by naming the servers it actually wants.** §6.

## Environment

| | |
|---|---|
| CLI binary | `/Users/stephen/.local/bin/claude`, Mach-O 64-bit arm64 **[measured]** |
| CLI version | `2.1.259 (Claude Code)` **[measured]** |
| `claude_code_version` on `system/init` | `2.1.259`, all 12 runs **[measured]** |
| Model | `claude-haiku-4-5` **[measured]** |
| Session cwd | `…/scratchpad/split-cwd`, git-initialised, one README **[measured]** |
| MCP servers in the user's settings | `higgsfield` (HTTP, `https://mcp.higgsfield.ai/mcp`), `pencil` (stdio, `/Applications/Pen.app/…/mcp-server-darwin-arm64`) **[measured]**, from `claude mcp list` |
| Turn | one user frame, `"Reply with the word pong. Nothing else."` **[measured]** |
| stderr | 0 bytes across all 12 runs **[measured]** |

## 1. The flag

`--strict-mcp-config`. The CLI's own `--help` on 2.1.259 says: **[measured]**

```
  --strict-mcp-config                   Only use MCP servers from --mcp-config,
                                        ignoring all other MCP configurations
```

The published reference says the same, plus what it does under a managed MCP file:
"Only use MCP servers from `--mcp-config`, ignoring all other MCP configurations."
**[source: https://code.claude.com/docs/en/cli-reference]**

No `--mcp-config` is passed, so the allowed set is empty and no server loads. The arm is proven per
run, not assumed: every `system/init` frame's `mcp_servers` array is recorded, and it is
`[{"name":"higgsfield","status":"connected"},{"name":"pencil","status":"connected"}]` on all six
`on` runs and `[]` on all six `off` runs. **[measured]**

The two other candidates the work order named do not survive contact:

- `--plugin-dir-no-mcp` is **not in `--help`** and **not in the published reference**. It appears
  only in the SDK's conditional-flag list (`docs/research/cli-protocol.md:56`). It was not used.
  **[measured]**
- `--strict-mcp-config --mcp-config '{}'` is the form third-party write-ups recommend
  **[source: github.com/anthropics/claude-code issue 20873]**. It was not needed:
  `--strict-mcp-config` alone yields `mcp_servers: []` with an empty stderr. **[measured]**

Argv actually used on the `off` arm, verbatim from the summary: **[measured]**

```
--output-format stream-json --verbose --input-format stream-json \
  --model claude-haiku-4-5 --permission-prompt-tool stdio --strict-mcp-config
```

The `on` arm is the same line without the last flag.

One documented caveat that this run does **not** exercise: with `-p`, the CLI waits for pending MCP
servers up to `MCP_TIMEOUT` (30 s default) before the first turn, and a server with a cached tool
list skips that wait. **[source: https://code.claude.com/docs/en/cli-reference, `--mcp-config`]**
Both of these servers have been connected on this machine before, so the numbers below are the
**cached-tool-list** case, which is the cheap one. A cold server is worse, not better. **[asserted]**

## 2. The twelve runs

Six pairs, alternating `on` then `off`, back to back, one process each, single invocation.
All three latencies are measured off frame **arrival** (`Session::last_arrival`), never off the
moment the caller drained the frame. §5 explains why that distinction changes the number.

| run | arm | spawn → `initialize` resp | spawn → `system/init` | user frame → `result` | CLI `duration_ms` | wall minus CLI clock |
|---|---|---|---|---|---|---|
| 1 | on | 680 | 2,447 | 3,117 | 1,360 | 1,757 |
| 1 | off | 610 | 627 | 1,308 | 1,302 | 6 |
| 2 | on | 757 | 1,181 | 1,901 | 1,489 | 412 |
| 2 | off | 973 | 988 | 1,084 | 1,080 | 4 |
| 3 | on | 611 | 1,363 | 2,046 | 1,305 | 741 |
| 3 | off | 591 | 606 | 1,218 | 1,213 | 5 |
| 4 | on | 653 | 1,659 | 2,291 | 1,294 | 997 |
| 4 | off | 639 | 660 | 1,512 | 1,506 | 6 |
| 5 | on | 621 | 1,373 | 2,067 | 1,326 | 741 |
| 5 | off | 667 | 686 | 1,245 | 1,238 | 7 |
| 6 | on | 673 | 1,417 | 2,097 | 1,364 | 733 |
| 6 | off | 575 | 593 | 1,203 | 1,197 | 6 |

All milliseconds. All 12 runs exited 0 on stdin close. **[measured]**

Medians:

| | `on` (n=6) | `off` (n=6) | delta |
|---|---|---|---|
| spawn → `initialize` control_response | 663.0 | 624.5 | **+38.5** |
| spawn → `system/init` | 1,395.0 | 643.5 | **+751.5** |
| first user frame → `result` | 2,082.0 | 1,231.5 | **+850.5** |
| CLI's own `duration_ms` | 1,343.0 | 1,225.5 | +117.5 |
| CLI's own `duration_api_ms` | 2,207.5 | 2,049.5 | +158.0 |
| wall minus CLI clock | 741.0 | 6.0 | **+735.0** |

## 3. Where the MCP cost actually sits

The `initialize` control_response is **MCP-independent**: 663.0 ms against 624.5 ms, a 38.5 ms
median gap inside a spread that runs 575 to 973 ms within the `off` arm alone. **[measured]** The
CLI answers the handshake before it has finished connecting MCP.

The whole MCP cost lands **between the handshake reply and `system/init`**. On the `off` arm those
two are 19 ms apart (624.5 → 643.5); on the `on` arm they are 732 ms apart (663.0 → 1,395.0).
**[measured]**

The same wait, seen from the other side, is the pre-turn gap. The user frame goes out as soon as
`initialize` returns, and the CLI does not start its own turn clock until it is ready. Wall minus
`duration_ms` is 741 ms median with MCP on and **6 ms** with MCP off. **[measured]** This is one
wait, visible on two legs, not two costs: about 750 ms is paid once per spawn, before the first
turn can begin.

This settles the open item in `docs/research/panel-review-2026-09-03.md:194-196`, which recorded a
1,252 ms "pre-turn work that its own clock does not count" for scenario 1 and left it unnamed. It
is MCP. The `off` arm has no such gap at all. **[measured]**

## 4. The token and dollar side, which is small

`system/init` lists **130 tools** with MCP on and **33** with MCP off, so the two servers contribute
97 tool definitions. **[measured]**

`crates/claude-spike/src/bin/fanout.rs:91` records "125 tools -> 33" on 2.1.258. The off-arm 33 is
unchanged on 2.1.259; the on-arm count has moved to 130. **[measured]**

Steady-state prompt size, from the `result` frames of runs 2 through 6, identical in every run of an
arm: `cache_read_input_tokens` 26,388 on, 24,564 off. **1,824 tokens** of difference. **[measured]**

Steady-state cost per turn: $0.003881 median on, $0.003723 median off. **+$0.00016 per turn, about
4%.** **[measured]**

Run 1 of each arm paid cache creation and is not comparable: `on-1` created 11,758 tokens for
$0.026196, `off-1` created 5,687 for $0.014454. **[measured]** Every later run created 0.

**Total spend for the experiment: $0.078591** across 12 spawns, of which $0.040650 is the two
cache-creating first runs. **[measured]** Under the 12-spawn cap, over the "$0.03 per run" order of
magnitude the work order expected, because Haiku turns cost a tenth of that.

Orphan check: the PID set from `pgrep -f claude` before the run and after it is **identical**, and
none of the 12 child PIDs (`15012, 15062, 15112, 15524, 16791, 16867, 16969, 17023, 17082, 17293,
17338, 17404`) is alive afterwards. **[measured]** Nine `claude`-matching processes were alive
throughout, all belonging to the user's own sessions and to concurrent workers, so an empty `pgrep`
was never the pass condition; set difference was.

## 5. A measurement bug this run had to fix first

`Session::initialize` buffers every frame that arrives before its own `control_response`, so a
caller that timestamps `system/init` with `Instant::now()` after draining the buffer is timing the
drain, not the arrival. `crates/claude-spike/src/main.rs:97` and
`crates/claude-spike/src/bin/fanout.rs:157` both do exactly that. **[source]**

In practice the error is small on those fixtures, because `system/init` lands *after* the handshake
reply in both (`s1-handshake-and-turn.ndjson` line 3, `f-warm.ndjson` line 2, control_response on
line 1) **[measured]**, so their published numbers stand. The fix is in place regardless:
`session.rs` now carries an arrival `Instant` alongside every line from the reader task through the
channel and through the `initialize` buffer, exposed as `Session::last_arrival`
(`crates/claude-spike/src/session.rs:81-91`, `:138-146`, `:200-226`, `:253-262`). This binary reads
that, so none of its three latencies is drain-timed.

## 6. What the numbers say the harness should do

Spawn children with `--strict-mcp-config` and no `--mcp-config` by default; make MCP a per-project
opt-in that passes `--strict-mcp-config --mcp-config <file>` naming only the servers that project
declares.

The reasoning, in order:

1. `docs/vision.md` rents a model window per decision and throws it away, so **every** decision pays
   the spawn cost. A 751 ms tax on each one is the single largest per-spawn item measured so far.
   **[measured]** + **[source: docs/vision.md]**
2. The tax buys nothing by default. The user's `higgsfield` and `pencil` servers have nothing to do
   with supervising a coding agent, and 97 of the 130 tool definitions a default child is handed are
   for image generation and design files. **[measured]**
3. The counter-cost is $0.00016 per turn and 1,824 prompt tokens. **[measured]** It does not
   outweigh three quarters of a second per spawn.
4. `--strict-mcp-config` is the exclusive-control flag, so the harness decides what a child can
   reach rather than inheriting whatever the user installed last week. That is the same posture the
   wall wants. **[asserted]**
5. `crates/claude-spike/src/bin/fanout.rs:97` already passes it, for "so the owner's MCP servers stay
   out" (`:91`). This makes the existing practice the stated default. **[source]**

Two corrections that follow:

- The 569 to 656 ms `spawn_to_init_ms` figures cited in `panel-review-2026-09-03.md:198-202` are
  **MCP-off** numbers, because `fanout.rs:97` passes the flag, and the 1,981 ms in `STATUS.md:129`
  is an **MCP-on** number (`s1-handshake-and-turn.ndjson` `system/init` lists both servers
  connected). **[measured]** The commit message at `232c291` calls the 1,981 ms "a cold outlier".
  It is partly an arm difference, worth about 750 ms of it. Cold start explains the rest: `on-1`
  here was 2,447 ms against an `on` median of 1,395 ms.
- Quote the two arms separately from now on, never one pooled spawn-to-init number.

## 7. What is not explained, and the next split

The `off` arm still spends **643.5 ms** median from spawn to `system/init`, and 624.5 ms of that is
before the CLI answers `initialize` at all. **[measured]** That floor is not process load:
`claude --version` returns in 0 to 10 ms over five runs, and the binary is a native Mach-O, not a
Node script. **[measured]** So the 624 ms is in-process work the CLI does before it will speak.

Candidates, none measured: settings-file reads across user, project and local sources; keychain and
OAuth token read; the model list; CLAUDE.md discovery; plugin sync; LSP; hook registration; the
33-tool and slash-command catalogue build (`s1`'s handshake reply carries the full `commands` array).
**[asserted]**

The next split, and it costs no LLM spend if the child is killed at `system/init` before any user
frame is sent:

1. `--debug-file <path>` with a category filter, which the help says implicitly enables debug mode.
   Timestamped phase logs would name the 624 ms directly instead of bisecting for it. **[measured:
   the flag exists in `--help`]**
2. `--setting-sources=` empty, to price the settings reads.
3. `--safe-mode`, which the help says disables CLAUDE.md, skills, plugins, hooks, MCP, commands,
   agents, output styles, workflows, themes and keybindings while leaving auth, model selection,
   built-in tools and permissions working. That is the floor of the floor; the gap between it and
   the `off` arm is the whole customisation-loading bill in one number. **[measured: the flag exists
   in `--help`]**

`--bare` is the wrong instrument here: the help says Anthropic auth under it is strictly
`ANTHROPIC_API_KEY` or `apiKeyHelper`, never OAuth or keychain, so it would not authenticate on this
machine's subscription. **[measured: the flag's help text]**

## 8. What was not checked

- Cold MCP servers. Both servers had cached tool lists; a first-ever connect was not measured.
- A machine with more than two MCP servers, or with a slow or unreachable one.
- Whether `MCP_TIMEOUT` applies on this stream-json path at all. The docs tie the wait to `-p`, and
  this path does not pass `-p` (`docs/research/cli-protocol.md:41`). No run hit a timeout, so
  nothing here distinguishes the two.
- The effect on any turn that uses a tool. Only a one-word reply was measured, so the 130-tool
  prompt was never exercised for tool selection quality or latency.
- Whether `--strict-mcp-config --mcp-config <file>` actually loads the named servers. Only the empty
  case was run.
- Any model other than `claude-haiku-4-5`.
- Whether the two cache-creating first runs are an artefact of the fresh cwd. Not re-run.
- Statistical rigour. Six runs per arm, medians reported, no confidence intervals. The `on`/`off`
  separation on `spawn → system/init` has no overlap between arms (`on` min 1,181, `off` max 988),
  which is why it is stated as a finding; the 38.5 ms `initialize` delta overlaps heavily and is
  stated as noise.

## 9. Reproducing

```
SPIKE_CWD=<a git-initialised scratch dir> \
  cargo run -p claude-spike --bin spawn_split -- 6
```

The argument is pairs; the binary refuses more than 6 (12 spawns), which is the work order's cap
(`spawn_split.rs`, `main`). `SPIKE_EXTRA_ARGV` appends whitespace-separated argv to **every** child
of any spike binary and is empty by default, so no existing scenario changes shape
(`crates/claude-spike/src/session.rs:52-58`, `:74`).
