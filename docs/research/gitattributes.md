# Filter drivers at `git worktree add` — the hole, and what closes it

Measured 2026-09-02 on **git 2.50.1 (Apple Git-155)**, macOS 25.5.0, in throwaway repositories under
the session scratchpad. Every marker below is a benign file containing a fixed string; nothing
destructive was run and nothing outside the scratch directory was written.

`docs/research/worktree-cleanup.md` §4.1 recorded the *policy* — Claude Code neutralizes repository
filter drivers, and did not before v2.1.247 — and tagged brigadier's exposure **[asserted]**. This
file replaces that assertion with measurements, and prescribes the fix that
`crates/core/src/worktree.rs` now carries.

---

## 1. The hole, reproduced

**[measured]** A repository with

- `.gitattributes` (tracked, committed): `*.txt filter=marker`
- `.git/config`: `filter.marker.smudge = <shell command writing a marker file>`

answers `git worktree add -b wt1 <path> HEAD` with **exit 0**, a correctly checked-out worktree, and
the marker file written. The smudge filter is a shell command and git ran it.

**[measured]** The same fires for all three driver spellings:

| key | executed at `worktree add`? |
|---|---|
| `filter.<n>.smudge` | **yes** |
| `filter.<n>.clean` | not at `add` (runs at `status`/`add`-the-index, see §4) |
| `filter.<n>.process` | **yes** — the long-running-protocol driver is spawned before it is spoken to |

**[measured]** A `.gitattributes` naming a filter that no config defines is a silent no-op: exit 0,
no warning, content passed through. So enumerating only the names the config actually defines is
complete, not a guess.

**[measured]** A filter whose command *fails* does not fail `worktree add`: git prints
`error: external filter '…' failed` and still exits 0, leaving the worktree in place.

## 2. What the attacker controls, exactly

The two halves live in different places and this matters.

- **`.gitattributes` — repository content.** Tracked, committed, inside the working tree. An agent
  with a normal file write owns this half outright.
- **`filter.<n>.smudge|clean|process` — configuration.** Never repository content. It has to reach a
  config file git reads for that repository.

So a hostile *clone* alone does not get shell out of `.gitattributes`. What gets shell is a write to
config, and in brigadier's shape that write is cheap:

**[measured] — cross-session escalation, the whole reason this is P0.** In a repository with a
committed `.gitattributes` selecting `filter=evil`:

1. `git worktree add -b s1 <wt1>` — session 1's worktree. `<wt1>/.git` is a **file**, not a
   directory, so there is no per-worktree `config` to defend.
2. Inside `<wt1>`, `git config --local filter.evil.smudge '<command>'` — an ordinary command an
   agent may run for a hundred legitimate reasons — writes into the **main** repository's
   `.git/config`, because `--local` means the common dir.
3. Session 2's `git worktree add -b s2 <wt2>` executes that command. Exit 0.

An agent that can run `git config` in its own worktree gets arbitrary shell in the *next* session's
worktree creation, in the user's own repository, outside any approval prompt. `.git/config` is not
reachable as a path from inside the linked worktree, and that buys nothing: `git config --local`
reaches it anyway.

**[measured]** `git config include.path extra.cfg` plus a `[filter "viainclude"]` block in
`.git/extra.cfg` also fires, and `git config --name-only --list` still reports
`filter.viainclude.smudge`, so include expansion does not hide a driver from enumeration.

**[measured]** Filter *subsection* names are close to arbitrary. `git config` accepted names
containing `=`, a space, `"`, `\` and `]`; it refused only a newline
(`error: invalid key (newline)`). `.gitattributes` can select them: `*.txt filter=a=b` resolves to
`check-attr filter → a=b` and the driver runs. §3 turns on this.

## 3. Mitigations — what was checked

### Chosen: `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>`

**[documented]** `git-config(1)`: "If `GIT_CONFIG_COUNT` is set to a positive number, all environment
pairs `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>` up to that number will be added to the
process's runtime configuration. […] These environment variables will override values in
configuration files, but will be overridden by any explicit options passed via `git -c`."

**[measured]** Enumerate every filter name from `git -C <repo> config --list --name-only -z`, then
hand the child four pairs per name — `smudge=""`, `clean=""`, `process=""`, `required=false` — and
`worktree add` exits 0, writes no marker, and produces the raw blob contents. Verified against a
`smudge` driver, a `process` driver, an `include.path`-defined driver, and a name containing `=`.

**[measured]** `required` must be in the set. With `filter.evil.required = true` and only the three
command keys blanked, `worktree add` exits **128** with `fatal: f.txt: smudge filter evil failed`
after printing `Preparing worktree`. Adding `required=false` returns it to exit 0. This is not
hypothetical: `git lfs install --local` writes `filter.lfs.required = true`, so omitting this key
would break worktree creation on every LFS repository.

**[measured]** Enumeration keys survive `-z` intact, including a name containing `=` and a space:
`git config --name-only --list -z` returned `filter.a=b c.smudge` as one NUL-terminated record.

### Rejected: `git -c filter.<n>.smudge=`

**[measured]** Works for ordinary names and **is bypassable**. `-c` splits its argument on the first
`=`, so a driver named `a=b` turns `-c 'filter.a=b.smudge='` into key `filter.a`, value
`b.smudge=` — `git config --get-regexp '^filter\.'` shows the original `filter.a=b.smudge` still
live, and the marker is still written. The env-pair form carries key and value in separate
variables and has no such parse. Same reason `--config-env` is not enough on its own.

### Rejected: `$GIT_DIR/info/attributes` containing `* -filter`

**[measured]** It does neutralise the driver — `info/attributes` outranks the in-tree
`.gitattributes`, marker not written. Rejected because it is a **persistent mutation of the user's
repository** that disables filters for every git command they run themselves, not just ours, and
un-writing it afterwards races the user's own git. `info/exclude` is already written by
`ensure_excluded`; that is one idempotent ignore line, not a global attribute override.

### Rejected: `worktree add --no-checkout` then a controlled checkout

Not measured, and it does not need to be: the controlled checkout is the thing that runs the smudge
filters, so the problem moves rather than goes away.

### Not applicable: `core.attributesFile`, `GIT_ATTR_NOSYSTEM`

**[documented]** `gitattributes(5)` precedence is `$GIT_DIR/info/attributes` → in-tree
`.gitattributes` (deepest first) → `core.attributesFile` → the system file. Both levers sit *below*
the in-tree file the attacker controls, so neither can override it. `GIT_ATTR_NOSYSTEM` only
suppresses `$(prefix)/etc/gitattributes`.

## 4. Adjacent mechanisms, checked at the same time

| mechanism | runs at `git worktree add`? | disposition |
|---|---|---|
| `core.fsmonitor = <command>` | **yes [measured]** — marker written by `add`, and again by a later `git status` | neutralised alongside the filters with `core.fsmonitor=false` **[measured]**; it is a performance cache, so disabling it for our own git calls costs nothing |
| `.git/hooks/post-checkout` | **yes [measured]** — an executable hook ran, `add` exit 0 | **not fixed here.** `core.hooksPath` pointed at an empty directory would disable it, but that is a policy call (a repo's checkout hook may be load-bearing) and `crates/supervisor` owns policy. Open item. |
| `filter.<n>.clean` | not at `add`; **does** run under `git status`, so `dirty_count` and the safety net inside `git worktree remove` reach it | neutralised on those two calls as well (§5) |
| `diff.<n>.command`, `diff.<n>.textconv` | **no [measured]** — attribute `*.bin diff=dd` with both keys set, `add` exit 0, neither marker written | no action; they need a `git diff`, which this module never runs |
| `core.sshCommand` | **[asserted]** no — `worktree add` performs no network transport | no action; not measured |
| `.git/config` written directly by a path traversal | not needed — `git config --local` from inside a linked worktree reaches the common config (§2) | the reason the fix must be at the git-invocation layer, not a filesystem sandbox |

## 5. What was implemented

`crates/core/src/worktree.rs`: `filter_neutralising_env()` enumerates the effective filter driver
names and returns the `GIT_CONFIG_*` pairs; `add`, `remove` and `dirty_count` run their git child
with them. Notes that belong with the code:

- The enumeration reads the **effective** config (system + global + local + `include.path`), so a
  driver the user defines globally — `lfs` being the common one — is neutralised too. The accepted
  consequence, the same one Claude Code accepts: **LFS content arrives in a new worktree as pointer
  files**; `git lfs pull` inside the worktree is the cure.
- Disabling clean filters can only make `dirty_count` count *more*, never less: content the clean
  filter would have normalised back to the index now reads as modified. Over-counting refuses a
  removal; under-counting deletes work. The direction is the safe one.
- A config key that is not valid UTF-8 fails the call closed rather than being lossily decoded into
  a name that would not match. **Not measured** — no such key was constructed.
- A repository with enough filter drivers to overflow the environment makes the spawn fail, so
  nothing is created. Fail-closed by construction, **not measured**.
- Time-of-check/time-of-use: the enumeration and the `worktree add` are two processes, so a driver
  added in between is not covered. The window is milliseconds and the attacker already needs write
  access; **not measured**, and judged acceptable.

## 6. What was not checked

- git-lfs is still not installed on this machine (`command -v git-lfs` → exit 1), so the LFS
  pointer-file consequence is reasoned from the config keys, not observed.
- Windows. The `GIT_CONFIG_*` mechanism is documented and platform-independent, but nothing here ran
  outside macOS.
- Whether `.git/hooks/post-checkout` can be reached by an agent that only has write access inside a
  linked worktree without invoking git. `git config core.hooksPath` reaches it trivially; the
  filesystem route was not tested.
- Any git version other than 2.50.1.
