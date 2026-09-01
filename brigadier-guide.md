# brigadier

*A conductor's discipline, installed into Claude Code.*

---

## The problem it is for

A long Claude Code session does not announce that it has gone bad. It gets slower, vaguer and more
expensive, and every individual turn still looks reasonable. What actually happened is that the
window filled up: the session read forty files to answer one question, pasted a test run into the
conversation, explained its plan in three paragraphs, and now every subsequent turn re-sends all of
it.

The fix is not a better prompt. It is a different shape:

> **The session that talks to you should not be the session that reads your code.**

A subagent's context window is disposable. It reads what it needs, works, reports one paragraph
back, and its window evaporates. The host's window is the one you live in all day. So the host
routes, the subagents work, and the host's window stays small enough that the fortieth turn is as
good as the first.

brigadier makes that shape mandatory instead of aspirational.

---

## Installing

```sh
bun install && bun run build
export PATH="$PWD/dist:$PATH"
brigadier install
```

brigadier keeps its own things in its own directory, laid out the way `.claude` is:

```
.brigadier/BRIGADIER.md      the instructions. brigadier's file; regenerated, not edited
.brigadier/settings.json     your limits. Written once and never overwritten
~/.brigadier/handoffs/       handoff prompts, always here, never inside a repository
```

Two files of Claude Code's own are touched, both between markers and both reversible:

- `CLAUDE.md` gains **one line** — an `@` import pointing at `BRIGADIER.md`, wrapped in
  `<!-- brigadier:start -->` / `<!-- brigadier:end -->`. The instructions themselves are not
  pasted into a file you also write in;
- `.claude/settings.json` gains two hook entries, each marked `--brigadier`. That one is
  unavoidable: hooks are only read from there. Your own hooks, your permission mode and your model
  choice are untouched, and the file is backed up once before the first write;
- `.claude/commands/handoff.md` adds `/handoff`.

| | global | project |
|---|---|---|
| instructions | `~/.brigadier/BRIGADIER.md` | `<repo>/.brigadier/BRIGADIER.md` |
| settings | `~/.brigadier/settings.json` | `<repo>/.brigadier/settings.json` |
| the pointer | `~/.claude/CLAUDE.md` | `<repo>/CLAUDE.md` |
| hooks | `~/.claude/settings.json` | `<repo>/.claude/settings.json` |

`brigadier install` does the global one, `brigadier install --project` the repository one, and a
project's settings override the global one field by field — the same shape as `.claude`. A project
`.brigadier/` is meant to be committed; that is how a team gets the same discipline.

`brigadier uninstall` removes the pointer, the hooks, the command and the generated `BRIGADIER.md`.
It leaves `settings.json` and your handoffs, because those are yours — and if the `CLAUDE.md` or
`settings.json` it is editing turns out to be one brigadier created and nothing else is left in it,
that goes too, rather than leaving an empty file behind.

There is no wrapper command. Start `claude` the way you always did.

---

## What changes in a session

### It stops reading your code

Inside a git repository, the host session's `Read`, `Grep`, `cat`, `sed -n`, `git show` and
`git diff` are refused. Not discouraged — refused, by a hook, under every permission mode.

It can still see what *exists*: `ls`, `find`, Glob, `git status`, `git log --oneline`. That is
enough to route with, and routing is its job.

### It stops editing your tree

`Write`, `Edit` and mutating shell commands are refused too, in the same place. The subagent that
worked out the change is the one that makes it — in the same breath, without a round trip through
a window that never needed to know.

### It uses subagents, and only subagents

`claude -p` from inside a session is refused, for anyone: it is a second login, a second unwatched
window, and an answer that comes back as raw text somebody then has to read. The Agent tool is the
same capability with a disposable window, several at once in one message, and a report instead of
a transcript.

### It cannot switch itself off

`brigadier uninstall` and `brigadier config <key> <value>` are refused to the session, host and
subagent alike. A rule a model can turn off is not a rule, and "I'll just widen this so I can
explain properly" is exactly how it would go. Reading is untouched — `brigadier config` with no
value, `status`, `standards`, `doctor`, `handoff` — and so is `install`, which only regenerates
what is already there. Those commands are yours, in your own terminal.

### It answers in one line

A reply over three lines or four hundred characters is sent back with a reason, and the session
says it again shorter. Measured against a real session: an unguarded answer of 5 lines and 3,289
characters came back, guarded, at 1 line and 101 characters — the long form written to a file, its
path given.

Fenced code blocks are exempt from the line count. Showing you a command to run is not the failure
this is for.

```sh
brigadier config lines 5             # if three is too tight for your taste
brigadier config characters 600
brigadier config lines 5 --project   # …just in this repository
```

`brigadier config` with no arguments prints what is in force and where it came from.

### It hands off before it dies

Past 700,000 tokens of context, the next turn is stopped and the session is told to do one of two
things: write a prompt for a fresh session, or say the work is finished and ask whether you want
one anyway.

The number comes from the session's own transcript — `input + cache_creation + cache_read +
output` on the last main-chain turn. Subagent turns are excluded, because spending a subagent's
window is the entire point of having one.

A handoff is a *prompt*, not a summary: the goal in one sentence, what is done with paths, what is
left in order, the verify command, the decisions already settled, and what to read first. Files
are named, never pasted — pasting them is how the next window fills as fast as this one did.

```sh
claude "$(brigadier handoff auth-refactor)"   # prints it, and deletes it
```

A handoff is consumed when it is read: it exists to be pasted into one fresh session, and after
that it describes work that has moved on. `brigadier handoff` with no name lists what is waiting;
`--keep` prints one without consuming it. Nothing else brigadier writes outlives the turn that
wrote it — there is no state directory, and the loop that would need one is stopped by the
vendor`s own `stop_hook_active` flag instead.

`/handoff` writes one on demand, at any point, without waiting for the line.

---

## Living with it

**"I just need to fix one typo."** Say so. A subagent does it in one turn, and you did not spend
the host's window on the file it lives in.

**"It refused something I actually needed."** Two possibilities. Outside a git repository nothing
is refused, so check where you are. Inside one, the answer is a subagent — and if that is genuinely
wrong for what you are doing, `brigadier uninstall --project` in that repository is one command
and no argument.

**"The subagent came back with rubbish."** Send the same agent a follow-up rather than starting
another. The host should never end a turn saying it is waiting for one.

**"I want to see what it is telling my sessions."** `brigadier standards` prints the instructions
verbatim — byte for byte what is in `.brigadier/BRIGADIER.md`, which is the whole of what your
CLAUDE.md points at. There is nothing hidden, and `brigadier status` shows you both ends of the
pointer.

---

## What it does not do

`brigadier doctor` prints this list every time. The short form:

- hooks are a guardrail, not a security boundary, in every vendor's own documentation;
- brigadier **fails open**. A crash, a timeout or an unparseable input means it stands aside — so
  a bug shows up as an *absent* refusal, which is silent;
- subagents are not walled, deliberately. Inside one, your repository is read and written normally;
- the host is not stopped from running your build or your test suite, only from reading and
  writing files. A session that runs `bun test` in the host window still fills it. That one is
  instruction;
- the Bash rule tokenises but does not evaluate: no variable expansion, no `$(…)`, no subshells;
- the rule that stops a session switching brigadier off reads the command line, like every other
  Bash rule. It is not a permission system — a session that writes a shell script and runs it is
  past it. It stops the easy path, which is the one that gets taken;
- the brevity wall blocks a turn and asks for it again. It cannot rewrite one, and it blocks
  ONCE per turn — if the retry is still too long it stands aside and that reply goes through;
- the handoff fires once per session, and reads the transcript to decide. If the transcript cannot
  be read it never fires and says nothing about it; a turn that made no tool calls can be missed
  by one turn, because the entry carrying its token count may not be on disk yet;
- brigadier edits two files another program owns — one line in `CLAUDE.md`, two hook entries in
  `settings.json`. It writes only between its own markers and backs one up, but a future version of
  Claude Code may not like it;
- the pointer is an `@` import, and **a broken import is silent** — no error, no instructions, no
  sign. `@~/…` does not resolve at all, which is why the global scope writes an absolute path, and
  `brigadier status` checks that the file the pointer names is really there;
- `AGENTS.md` is not read by Claude Code at all, so it cannot carry the pointer. When Codex arrives
  it will be the natural place for it;
- Claude Code only. Codex and the rest are not built, not measured, not claimed.

---

## The evidence

`docs/proof/` holds live runs against the real `claude`, each paired with a negative control — an
identical run without brigadier, so the difference between "it works" and "it would have done that
anyway" is visible rather than asserted. `scripts/prove.sh` regenerates all of it.
