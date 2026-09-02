//! The wall: looking at a shell command and saying what it is, so the harness can decide what may
//! run with nobody watching.
//!
//! The axis is **safe inside this session's own git worktree, or reaching outside it**. A worker is
//! pre-authorized for reads, builds, tests and writes below its own worktree root; network access,
//! package installs with side effects, `git push`, destructive commands and writes above the
//! worktree root queue in the approvals dock instead, parking one work order rather than the run
//! (`docs/vision.md` §8, and W3-A of `docs/plans/phase-4.md`). Nobody is at the keyboard while this
//! runs, which is why the answer has to come from a classifier rather than from a sentence in a
//! prompt.
//!
//! What lives here so far:
//!
//! * [`bash`] — classify one Bash command line as read / inspect / mutate / nested-`claude` /
//!   unknown. Pure and synchronous: no I/O, no process, no `PATH` lookup.
//! * [`tables`] — the command sets, as plain data. W3-A expects set membership to be exactly that:
//!   a change to *which* command is in *which* set should be an edit to that file and nothing else.
//!
//! What does not live here: the decision. Which classes run unattended, which queue an approval,
//! and what the refusal says are the hook policy's business
//! ([`crate::claude::hook::HookPolicy`]), because they depend on who is asking.
//!
//! Two limits, restated because they are load-bearing:
//!
//! * The Bash rules **tokenise but do not evaluate** — no variable expansion, no `$(…)`, no
//!   subshells. [`bash`] flags what it could not evaluate instead of guessing at it.
//! * This module answers *what a command does*, never *where it does it*. Every table entry is a
//!   basename, no argument is resolved to a path, and the only target inspected at all is a
//!   redirection's ([`tables::DEV_SINKS`]) — so "below the worktree root" is not a question this
//!   file can answer. Nor is it a sandbox: a session that writes a shell script and runs it is past
//!   it, and `docs/vision.md` §11 says the same thing at the product level — the isolation is a git
//!   worktree, a containment property and not a security boundary.
//!
//! And one that governs how a caller should use this: the wall **fails open**, so a bug shows up as
//! an *absent* refusal, which is silent. That is the reason
//! [`bash::BashClass::Unknown`] is a distinct answer and is ordered above
//! [`bash::BashClass::Inspect`] — "I could not classify this" must never be delivered as "this is
//! fine".

pub mod bash;
pub mod tables;

pub use bash::{classify, BashClass, Classification, Segment};

mod lex;
