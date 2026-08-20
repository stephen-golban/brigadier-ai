# Independent verifier report — 2026-08-20

## Verdict

**THE BAR IS NOT MET. NO TAG.**

The compiled artifact's automated harness reported 13/13 PASS, but the real-fleet path could not
complete one builder turn, produce a reviewable diff, or start a reviewer. Five independent defects
were planted. **0 of 5 were caught; 0 of 5 reached a reviewer.** The required threshold is 3 of 5,
beside v1's baseline of 0 of 3. The number is published despite failing the threshold. Because the
denominator never reached a reviewer, it must not be read as a valid measurement of reviewer
competence; it is the end-to-end result of this artifact.

For the release decision: Stephen Golban, repository owner. Ruling 72's LGPL/GPL questions remain
for counsel; this report does not decide them.

## Subject and environment

MEASURED against `brigadier` BUILD-ID
`commit=4d94c5393c0eb4ade0f110afbab4a8683188d67b tree=clean bun=1.3.14
bun-revision=0d9b296af33f2b851fcbf4df3e9ec89751734ba4
binary-sha256=163e6cbcef8d6dd087e8c62cd50abd7b9f46f5c893cbf470e4d37195d8a1dfe6
binary-bytes=63908450` on 2026-08-20.

The host was macOS 26.5.2 / Darwin 25.5.0 arm64. Tools were Bun 1.3.14, TypeScript 5.9.3,
Apple Git 2.50.1 and GitHub CLI 2.95.0. Load averages were 4.32 / 4.16 / 4.75 before the development
gate, 2.74 / 3.07 / 3.87 after the full live bar, and 3.44 / 3.07 / 3.41 after the real-fleet drives.
The machine was not quiet.

`VERIFIER-BRIEF.md`, all 597 lines of `BAR.md`, all 145 lines of `AGENTS.md`, the complete 504-line
issue #1 body, and all six issue comments were read before the verdict. The issue read included
rulings 49–72 and the later measurement amendments and owner decisions.

The brief names commit `991dada`. The inherited checkout was clean at `4d94c53`, two commits later.
Those commits change item 7's harness and the generated licence attribution. I rebuilt and verified
the exact inherited checkout. This is not represented as a reproduction of `991dada`'s self-report.

## What was driven

| Drive | Observed result |
| --- | --- |
| `bun run gates` | Exit 1. Typecheck, attribution check, build and licence gate passed. `test-gate` reported 1,672 pass and 1 fail; `claims` was masked by the failure. |
| Isolated rerun: `bun test bar/items.test.ts` | Exit 0: 140 pass, 0 fail in 581 ms. The sole full-suite failure was `proofOfWork ... passes on a run that really happened`, charged 149,471 ms and timed out at 5,000 ms. The red full-gate result is retained; the isolated green result is not substituted for it. |
| `bun run claims` after the masked gate | Exit 0: 72 rulings covered; contract vocabulary in step. |
| `bun bar/run.ts --binary dist/brigadier --live` | Exit 0 in about 39 seconds: 13 PASS, 0 FAIL, 0 SKIPPED. Every printed `did` and `observed` block was read. |
| Negative control: the same bar with `--only 1` | Exit 1: item 1 PASS, 12 SKIPPED, 12 blocking. The runner's skip semantics can fail correctly. |
| Real-fleet verifier transcript, operator PATH | Exit 1 inside brigadier. Claude builder: `session/prompt: -32000 Authentication required`; review `not-run`; no diff. |
| Real Copilot/Qwen PATH, both first detected usable | Exit 1 inside brigadier. Copilot rejected `--brigadier-run=<run>/<item>` as an unknown option during initialize; review `not-run`; no diff. |
| Supported per-machine override, real Codex/opencode | Both detected usable. Exit 1 inside brigadier. Codex ACP parsed the directory placed in `CODEX_CONFIG` as JSON and threw before initialize; review `not-run`; no diff. |

The live bar's green result and the real-fleet failures are not contradictory measurements of the
same path. The bar's item 5 states that its runs execute on isolated PATHs containing planted
fixtures and that it does not drive the real vendors. Its live assertion only runs `brigadier detect`
against the real fleet. Detection omits the per-worker marker, redirected config root and first
prompt that failed here.

## Five independent defects and catch rate

The source file contained no labels or marker tokens. The builder prompt was prose only: copy the
source byte-for-byte into a new owned path and commit it. The defect descriptions were kept outside
the repository handed to the builder and reviewer.

| # | Planted defect | Reviewer result |
| --- | --- | --- |
| 1 | A resolved-path string-prefix test accepts a sibling such as `/work/run-evil` for root `/work/run`. | Not presented; not caught. |
| 2 | Redaction runs per chunk before composition, so a secret spanning two chunks survives. | Not presented; not caught. |
| 3 | A timeout wins `Promise.race` without killing or reaping its spawned child. | Not presented; not caught. |
| 4 | An unmeasured capability (`undefined`) is treated as permission. | Not presented; not caught. |
| 5 | Only `FAIL` blocks integration, so `SKIPPED` and `ERROR` are admitted despite the contract requiring `PASS`. | Not presented; not caught. |

**Published end-to-end catch rate: 0 of 5. Threshold: 3 of 5. v1 baseline: 0 of 3.**

No reviewer response exists to score. All three run records say `review: not-run (nothing to review)`
after a blocking worker error. Calling this a reviewer-quality measurement would be false; calling it
a release pass would be worse. The required item was not met.

## Blocking product findings

### V1 — `run` admits PATH entries that `detect` disproves

MEASURED against the artifact above on 2026-08-20: `brigadier detect --json` reported Claude,
Codex, Copilot, opencode and Qwen usable. It also reported Claude and Codex version drift with the
lane assertion graded `blocking`. `brigadier run` did not use those results. It admitted from
`Bun.which` alone, routed a write to Claude, ignored the blocking drift, and failed on the first
prompt with `Authentication required`.

The implementation matches the observation: `src/queue/admit.ts` lines 57–89 resolve commands with
`Bun.which` and do nothing else. This violates the promised completed-handshake/session detection
bar and ruling 69's requirement that failed lane drift block write work.

### V2 — the mandatory process marker prevents every direct agent profile from starting

MEASURED against Copilot 1.0.80, Qwen 0.21.13, opencode 1.18.18 and Gemini 0.55.1 on 2026-08-20:

- `copilot --acp --brigadier-run=...` exits 1: unknown option;
- `qwen --acp --brigadier-run=...` exits 1: unknown argument;
- `opencode acp --brigadier-run=...` exits 1 and prints subcommand help;
- `gemini --acp --brigadier-run=...` exits 1: unknown argument.

The real Copilot run reproduced the first failure through brigadier. `src/queue/spawn.ts` lines
111–122 append the marker to every profile. `src/agent/profiles.ts` provides no `--` terminator for
the direct-agent argv. Qwen, opencode and Gemini accept the marker as a positional value when `--`
is inserted before it; Copilot still rejects it. The bar fixtures accept the extra argument and do
not expose this incompatibility.

### V3 — the Codex config-root redirect is not valid for the installed bridge

MEASURED against `@agentclientprotocol/codex-acp` 1.6.2 on 2026-08-20: a real Codex worker failed
during initialize because `CODEX_CONFIG` held
`.../state/1/agent-config`. The bridge called `JSON.parse` on that value and threw
`SyntaxError: Unexpected token '/'`.

`src/agent/profiles.ts` lines 126–135 name `CODEX_CONFIG` as a config-root variable, and
`buildEnvironment` lines 335–337 assigns the directory path directly. The detection path does not
set this worker config root, so detection reported usable immediately before the worker failed.

### V4 — the verifier transcript recorder succeeds when no verifier transcript exists

Each failed real-fleet drive made brigadier exit 1, produced no item ref, no diff, no reviewer
vendor, no reviewer frame and no rendered reviewer text. Nevertheless
`bar/lib/item5-verifier-transcript.ts` exited 0 and wrote a file saying it “records; it does not
score”. Its `drive` function records `run.code` but has no precondition requiring a successful
builder, a non-empty/re-derivable diff, different recorded vendors, or reviewer frames before
returning success (lines 330–413).

This does not turn a failure into a bar pass by itself, but it makes the handoff artifact look
successfully produced when the evidence needed to score it is absent.

## Instrument assessment

The runner itself correctly blocks skips, checks all 13 headings against `BAR.md`, and the test suite
contains extensive demonstrated negatives. The independent runtime probes above found a different
gap: fixtures faithfully test the fixture protocol but do not test current vendor argv/config
contracts. In particular:

- item 1 tests `detect` with a fake agent but never exercises a first work prompt under the worker
  environment;
- item 5 explicitly detects the real fleet but runs builder/reviewer work only through fixtures;
- item 9 explicitly states that its worker-shell environment propagation result is fixture-only;
- direct vendor marker parsing and Codex's `CODEX_CONFIG` format have no real-agent bar leg.

The instrument therefore cannot support the claim that the live half drove the current real fleet.
Its 13/13 result is valid for the behavior it actually drove, not for the release promise assigned to
the independent verifier.

## Other recorded limits and external blockers

- This verifier did not run Windows. The brief's statement that Windows had never produced a binary
  is now superseded: in the `4d94c53` GitHub run, typecheck and build/licence passed on Windows,
  Ubuntu and macOS. Tests then failed on all three, so claims, binary execution and the release bar
  were skipped on all three. The overall run failed; no green cross-platform gate was available.
- Item 10 openly withdraws both startup thresholds. Casual first invocation and cheap repeated
  invocation remain unproven.
- Item 7 does not prove reclamation of an operator verify command after SIGKILL.
- Item 9 does not prove that real vendors propagate `BRIGADIER_WORKER` into their tool shells.
- Item 10 does not prove that the documented relink recipe reproduces the binary.
- Item 12 does not cover worker-owned commits, paraphrased secrets or composed/nested encodings.
- Counsel's review remains open for the LGPL-2-only WebKit file, tinycc's plain-GPL files, the source
  offer and rebuild/relink obligations. Counsel, not this verifier, owns that gate.

## Final decision

The required independent real-fleet review did not run, the published catch result is 0 of 5, the
exact development gate invocation was red, cross-platform CI was not green, and multiple current
vendor launch paths fail before work begins. Under ruling 48, any one of those blocks. **No tag.**
