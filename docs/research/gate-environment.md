# The gate's environment — what PATH a launched brigadier actually has

Date: 2026-09-04. Measured by the lead during the unattended run, on macOS 26.5 / Darwin 25.5.0,
zsh 5.9, git 2.50.1 (Apple Git-155).

This closes the one question `docs/research/orchestration-loop.md` §6.2 marked open and said must
not be guessed at: *"A harness launched from Finder has a different environment from one launched
in a terminal … A verify command like `cargo test` may resolve in one launch and not the other,
and the failure would read as a red gate rather than as a missing tool."*

**It does not resolve. The design's worry was correct and is now a number.**

Rules of this file, per `CLAUDE.md` §1 rule 5: every claim tagged **[measured]** (run on this
machine today, method shown), **[source]** or **[asserted]**. §5 says what was not checked.

---

## 1. Method

A minimal `LSBackgroundOnly` app bundle whose executable is a `/bin/sh` script that writes its own
`PATH` and three `command -v` lookups to a file. Launched two ways:

- **`open(1)` from this shell** — and this is a trap, not a result: `open` propagates the calling
  shell's environment, so the app saw *my* PATH. Any measurement taken this way is measuring the
  terminal, not the launch. It is recorded here only so nobody repeats it.
- **`osascript -e 'tell application "Finder" to open POSIX file …'`** — Finder is the launcher, so
  no shell is anywhere in the chain. **This is the Finder case**, and it is the one the owner will
  actually use when he double-clicks `brigadier.app`.

---

## 2. What a Finder-launched app gets — **[measured]**

```
PATH=/usr/bin:/bin:/usr/sbin:/sbin
cargo   MISSING
npm     MISSING
git     /usr/bin/git
sh      /bin/sh
```

Four entries. Not homebrew, not `~/.cargo/bin`, not nvm, not `~/.local/bin`. `launchctl getenv
PATH` prints **nothing** (exit 0), so launchd carries no PATH override and this is simply the
system default. **[measured]**

**Consequence, stated plainly: a brigadier launched from Finder would run `cargo test` as a verify
command and get exit 127.** Without a `command_not_found` reason slug that reads to the owner as
*"the code is broken"* when what happened is *"this machine's PATH does not have the tool the plan
named"*. That is `orchestration-loop.md` §6.3 rule 4, and this file is the evidence for why that
rule is not optional.

## 3. Three candidate remedies, all measured from a real Finder launch

| what the harness would run once at startup | cargo | npm | wall clock |
|---|---|---|---|
| inherit, i.e. do nothing | MISSING | MISSING | 0 |
| `$SHELL -l -c 'printf %s "$PATH"'` | MISSING | MISSING | fast |
| `$SHELL -l -i -c 'printf %s "$PATH"'` | **MISSING** | **found** | **between 5 s and 13 s** |

All three rows **[measured]** from the Finder-launched bundle.

Two things fall out, and the second is the surprising one.

**`-l` is not enough, and `-i` is what costs.** A login-but-non-interactive zsh reads `.zprofile`
and `.zlogin`; it does not read `.zshrc`, and `.zshrc` is where this machine's nvm, bun, pnpm and
`~/.local/bin` entries live. Adding `-i` finds `npm` and adds those entries — and takes somewhere
between 5 and 13 seconds to return, because an interactive shell with no tty runs the owner's whole
interactive startup. The bound is loose because the first attempt was sampled at 5 s (empty) and the
second at 13 s (complete); it was not timed precisely. **[measured]**, weakly.

**`cargo` is missing from every one of them, including the interactive login shell.** `~/.cargo/bin`
is on no PATH on this machine at all — not the GUI default, not the login shell, not the interactive
login shell, and not the shell this run's own subagents were given. `cargo` resolves only after an
explicit `export PATH="$HOME/.cargo/bin:$PATH"`, after which `cargo --version` is
**`cargo 1.98.0 (797e8a9bc 2026-08-05)`**, exit 0, with the toolchain present at
`~/.rustup/toolchains/stable-aarch64-apple-darwin`. **[measured]**

This corrects a landmine in `docs/plans/autonomous-run-2026-09-04.md` §6, which says
`npm run tauri build` needs that prefix *"from a non-interactive shell"*. The qualifier is too
narrow: on this machine it needs the prefix from an **interactive login** shell too. The remedy in
that line is right; the reason given for it is not.

## 4. What the gate runner must therefore do

1. **Never inherit the launch PATH and hope.** Resolve a PATH deliberately, once per launch, and
   record which one was used so a 127 can be explained rather than guessed at.
2. **`$SHELL -l -i -c` is the best single source and is still not sufficient.** It must be run with
   a **timeout** — 13 s of startup on the launch path is not acceptable, and an interactive shell
   with no tty is a hang risk, not merely a slow one. On timeout, fall back to the inherited PATH
   and say so.
3. **Append the well-known toolchain directories that no shell startup exports**, `~/.cargo/bin`
   first, only if they exist on disk. This is the one place a hardcoded path list is the correct
   answer, because the alternative measured above is a gate that cannot run this repository's own
   verify command.
4. **127 gets its own reason slug**, `command_not_found`, and the plan card must say *the plan named
   a command this machine does not have* — never *the code is broken*. A red gate the owner cannot
   attribute is worse than no gate.
5. `git` needs none of this: `/usr/bin/git` is present in the bare Finder PATH. **[measured]**

## 5. Not checked

- **Nothing here was measured against `brigadier.app` itself.** The bundle used was a four-line
  `sh` script; a Tauri app is a different binary but takes the same launch path, so the PATH result
  carries and the timing may not. **[asserted]**
- The 5 s / 13 s bound on `-l -i` is two samples on a machine at load average 7.5 with two other
  Claude sessions running. It is an order of magnitude, not a figure.
- macOS only. No Linux, no Windows.
- `open(1)`'s env propagation was observed, not read in Apple's source.
- Whether `CI=1` changes any runner this repository uses is still unverified —
  `orchestration-loop.md` §6.2 tagged it **[asserted]** and this file does not improve on it.
