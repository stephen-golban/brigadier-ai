//! The `PreToolUse` hook seam.
//!
//! Why a hook at all, when `can_use_tool` exists: the spike measured `can_use_tool` being
//! shadowed twice over — once by the user's `~/.claude/settings.json` `defaultMode`, and again,
//! even with the mode pinned to `default`, by the **built-in read-only Bash command set**, which
//! auto-approved a bare `echo` without ever putting a frame on the wire. That set is static and
//! **not configurable** (`ls`, `cat`, `echo`, `pwd`, `head`, `tail`, `grep`, `find`, `wc`,
//! `which`, `diff`, `stat`, `du`, `cd`, read-only `git`), and it skips the prompt **in every
//! mode**. It is not the model-based classifier, which is a separate, billable thing bound to
//! `--permission-mode auto`. A `PreToolUse` hook fired on that same `echo`.
// see docs/research/approvals.md §1(b) (documented, quoting
// https://code.claude.com/docs/en/permissions#read-only-commands) and
// docs/research/claude-direct-spike.md "The two shadows over `can_use_tool`" (measured), and
// docs/research/agent-sdk.md §3 — "To gate *every* call regardless of mode and rules, the
// documented answer is a `PreToolUse` hook".
//!
//! Three policies live here. [`AskGatedTools`] is what the operator's own hand-started sessions
//! use: it answers `permissionDecision: "ask"` for the tools that can change the world, which is
//! the one lever that forces a `can_use_tool` prompt past the read-only set. [`AllowAll`] answers
//! `{}` — "no opinion", **not** allow — which is what the spike proved the CLI accepts (scenario
//! 6: the tool proceeded and `can_use_tool` followed); it is kept for replay and for tests that
//! must not change the fixture's behaviour. [`WorkerWall`] is what a loop-dispatched worker child
//! runs under: an allowlist over `crate::wall`'s classifier and the worker's own worktree root,
//! so an unattended worker builds, tests and edits its own tree without a human and parks only
//! where `docs/vision.md` §8 says it should.
// see docs/research/approvals.md §5 for the four decisions the 2.1.258 binary's own zod schema
// accepts (`allow|deny|ask|defer`, measured with `strings`) and §7 gap 1 for why `{}` is not a gate.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use claude_wire::HookJsonOutput;
use serde_json::{json, Value};

use crate::wall::{classify, tables, BashClass, Segment};

/// Callback id registered in the `initialize` handshake and echoed back on every
/// `hook_callback`.
// see docs/research/claude-direct-spike.md, `fixtures/s6-hook-callback.sent.ndjson`.
pub const PRE_TOOL_USE_CALLBACK_ID: &str = "brigadier_pre_tool_use";

/// The tools [`AskGatedTools::default`] prompts for: everything that writes.
///
/// Read-only tools (`Read`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, `TodoWrite`, …) are left to
/// the CLI's own flow — prompting for them would put a card in front of the operator several
/// times a turn and train them to click allow.
pub const GATED_TOOLS: &[&str] = &["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"];

/// The reason [`AskGatedTools::default`] hands the CLI, shown next to the prompt.
pub const DEFAULT_ASK_REASON: &str = "brigadier gates this tool";

/// One `PreToolUse` decision.
///
/// Synchronous on purpose: this is policy the harness already knows, not a question for the
/// operator. A question for the operator is a `can_use_tool` prompt, which parks in the
/// [`crate::approval::ApprovalTable`] with a deadline. A hook that blocked on a human would wedge
/// the turn with no timeout.
pub trait HookPolicy: Send + Sync + 'static {
    /// Decide what to answer a `PreToolUse` callback.
    ///
    /// `tool_name` and `input` come out of the callback's `input` object (`HookInput`); either
    /// can be absent, and an absent name must not be treated as a match for anything.
    fn pre_tool_use(&self, tool_name: Option<&str>, input: &Value) -> HookJsonOutput;
}

/// No opinion, always: answers `{}` and lets the CLI's normal flow decide.
///
/// **Not an allow.** `permissionDecision` is optional in the CLI's schema, so an empty
/// `hookSpecificOutput` falls through to deny rules, ask rules, the permission mode and allow
/// rules — which for a read-only Bash command means no prompt at all. The name is historical.
// see docs/research/approvals.md §5 (fall-through for an empty object is asserted, not stated
// verbatim in the docs) and §7 gap 1.
#[derive(Clone, Copy, Debug, Default)]
pub struct AllowAll;

impl HookPolicy for AllowAll {
    fn pre_tool_use(&self, _tool_name: Option<&str>, _input: &Value) -> HookJsonOutput {
        // `{}` — every field is `skip_serializing_if = "Option::is_none"`. This is the exact
        // body the spike sent and the CLI accepted.
        HookJsonOutput::default()
    }
}

/// Answers `permissionDecision: "ask"` for a named set of tools and `{}` for everything else.
///
/// This is the harness's gate. `"ask"` is the only documented lever that reaches a tool call the
/// permission machinery would otherwise auto-approve: hooks run **before** deny rules, ask rules,
/// the permission mode and allow rules, and `"ask"` prompts the user to confirm. A tool that is
/// not in the set gets `{}` and is never held up.
///
/// An absent tool name never matches — a callback the harness cannot identify falls through
/// rather than gating everything.
// see docs/research/approvals.md §5 (documented evaluation order, and the 2.1.258 zod schema
// measured out of the binary: `hookEventName`, `permissionDecision`, `permissionDecisionReason`).
#[derive(Clone, Debug)]
pub struct AskGatedTools {
    tools: BTreeSet<String>,
    reason: String,
}

impl Default for AskGatedTools {
    fn default() -> Self {
        Self::new(GATED_TOOLS.iter().copied())
    }
}

impl AskGatedTools {
    /// Gate exactly `tools`, with [`DEFAULT_ASK_REASON`].
    pub fn new<S: Into<String>>(tools: impl IntoIterator<Item = S>) -> Self {
        Self {
            tools: tools.into_iter().map(Into::into).collect(),
            reason: DEFAULT_ASK_REASON.to_owned(),
        }
    }

    /// Replace the `permissionDecisionReason` sent with every `ask`.
    pub fn with_reason(mut self, reason: impl Into<String>) -> Self {
        self.reason = reason.into();
        self
    }

    /// The gated set, sorted.
    pub fn tools(&self) -> impl Iterator<Item = &str> {
        self.tools.iter().map(String::as_str)
    }

    /// Whether a tool name is gated. `None` is never gated.
    pub fn gates(&self, tool_name: Option<&str>) -> bool {
        tool_name.is_some_and(|name| self.tools.contains(name))
    }
}

impl HookPolicy for AskGatedTools {
    fn pre_tool_use(&self, tool_name: Option<&str>, _input: &Value) -> HookJsonOutput {
        if !self.gates(tool_name) {
            return HookJsonOutput::default();
        }
        HookJsonOutput {
            hook_specific_output: Some(json!({
                "hookEventName": "PreToolUse",
                "permissionDecision": "ask",
                "permissionDecisionReason": self.reason,
            })),
            ..HookJsonOutput::default()
        }
    }
}

// -----------------------------------------------------------------------------------------
// the worker wall
// -----------------------------------------------------------------------------------------

/// The tools whose decision is "is the target inside this worker's worktree".
///
/// `Write`, `Edit` and `MultiEdit` name their target in `file_path`; `NotebookEdit` uses
/// `notebook_path`, and [`WorkerWall`] reads either.
pub const WORKTREE_PATH_TOOLS: &[&str] = &["Write", "Edit", "MultiEdit", "NotebookEdit"];

/// What [`WorkerWall`] says next to an allow.
pub const WALL_ALLOW_REASON: &str = "brigadier pre-authorizes this inside the worker's worktree";

/// What [`WorkerWall`] says when it refuses a nested `claude`.
pub const WALL_NESTED_CLAUDE_REASON: &str =
    "a nested claude session is refused whoever asks; use a subagent";

/// `git` global flags that make git operate somewhere other than its own cwd.
///
/// `git_class` skips global flags to find the subcommand, so `git -C /elsewhere reset --hard`
/// classifies identically to a local `git reset` (`crate::wall::bash`). These three are the only
/// way git leaves the directory it was started in, so [`WorkerWall`] treats any of them as a
/// reason to ask rather than trying to resolve where they point.
pub const GIT_ELSEWHERE_FLAGS: &[&str] = &["-C", "--git-dir", "--work-tree"];

/// A policy for a **loop-dispatched worker child**, so an unattended worker runs its own edits,
/// builds and tests without a human and parks only where `docs/vision.md` §8 says it should.
///
/// [`AskGatedTools`] is untouched by this and stays what the operator's own hand-started sessions
/// use. It gates on tool *name* alone, so a worker parks on its first edit — which for an
/// overnight run does not fail, it hangs. That is what this exists to stop
/// (`docs/plans/w1b-loop-order.md` §4, D6).
///
/// # The policy, which is an allowlist
///
/// | tool / class | decision |
/// |---|---|
/// | [`WORKTREE_PATH_TOOLS`] | target resolves inside the worktree root → allow; outside, absent or unresolvable → `ask` |
/// | `Bash`, [`BashClass::NestedClaude`] | **deny** |
/// | `Bash`, a [`tables::PACKAGE_MANAGERS`] command whose class came back [`BashClass::Unknown`] | allow — the build-and-test case, and the reason this policy exists |
/// | `Bash`, `git` with a subcommand in [`tables::GIT_MUTATE_SUBCOMMANDS`] but **not** in [`tables::GIT_REMOTE_SUBCOMMANDS`] | allow — `add`, `commit`, `merge`, `rebase` are the local mutations a worker is pre-authorized for |
/// | `Bash`, [`BashClass::Read`] or [`BashClass::Inspect`] | `{}` — no opinion, the CLI's own flow decides |
/// | `Bash`, everything else — [`BashClass::Mutate`], any other `Unknown` | `ask` |
///
/// Two guards run **before** any allow above, and each turns it into an `ask`:
///
/// 1. **A `git` line carrying [`GIT_ELSEWHERE_FLAGS`].** Without this, `git -C /elsewhere reset
///    --hard` is indistinguishable from a local `git reset`.
/// 2. **Any word carrying an absolute or `~`-rooted path outside the worktree root.** This is
///    what stops `rm -rf /tmp/victim`, and it is also what stops `cat ~/.ssh/id_rsa` reaching a
///    `{}` on the `Read` row. It reads two places in each word — the word itself, and the value
///    after a first `=` — so `GIT_WORK_TREE=/tmp/victim git reset --hard` and
///    `cargo test --target-dir=/tmp/out` are both caught; without the second, guard 1 never sees
///    the first, because [`Segment::command`](crate::wall::Segment::command) peels assignments
///    off to find the command word. It uses the same resolver as the `Write` path check, so a
///    word that cannot be resolved is an `ask` rather than a quiet pass. The command word counts
///    as a word, so `/bin/ls` asks where `ls` does not — a cost of the allowlist, not an
///    oversight.
///
/// The strictest segment of a pipeline wins, in the order deny > ask > allow > no opinion.
///
/// An `ask` is not a failure: it parks **one work order**, never the run (`docs/vision.md` §8).
///
/// # Four limits, because this is not a sandbox
///
/// * The classifier **tokenises but does not evaluate** — no variable expansion, no `$(…)`, no
///   subshells (`crate::wall`). A worker that writes a shell script and runs it is past this
///   policy, and so is anything reached through an interpreter in [`tables::OPAQUE_COMMANDS`].
/// * **This is not a security boundary.** `docs/vision.md` §11: the isolation is a git worktree
///   and the blast radius of a bad worker is work brigadier can throw away — a containment
///   property, not a sandbox.
/// * **The path guard reads arguments, not redirection targets.** `Segment.words` has
///   redirection targets removed (`crate::wall::Segment`), so `cat /etc/passwd` asks and
///   `cat </etc/passwd` does not — the second reads outside the worktree with no prompt. This is
///   a real limit, not a theoretical one, and it is left standing rather than closed because
///   exposing the targets is a change to `crate::wall::bash`'s own contract, out of proportion to
///   the containment `docs/vision.md` §11 promises: a git worktree, not a sandbox. Pinned by a
///   test so a reader finds it rather than discovers it. Relative paths are invisible for the
///   same reason — judging one means evaluating a cwd this never evaluates.
/// * The wall **fails open**. A bug in it shows up as an *absent* refusal, which is silent —
///   nothing logs the approval that should have happened and did not.
/// * **It is an allowlist, deliberately.** Because the wall fails open, a blocklist's bug is a
///   missing refusal that nobody sees; an allowlist's bug is a parked work order, which costs one
///   order and says so out loud. `rm -rf build` inside the worktree is an `ask` under this rule,
///   and that is the cost being accepted rather than an oversight.
#[derive(Clone, Debug)]
pub struct WorkerWall {
    /// The canonical worktree root, or `None` when the path handed in could not be resolved at
    /// all — in which case every path check is an `ask`.
    root: Option<PathBuf>,
}

impl WorkerWall {
    /// A wall for a worker whose worktree is rooted at `worktree_root`.
    ///
    /// The root is canonicalized once, here. A root that does not exist or cannot be resolved
    /// leaves every path check an `ask`, which is the fail-toward-asking direction;
    /// [`WorkerWall::root`] reports it so a caller can say so out loud.
    pub fn new(worktree_root: impl AsRef<Path>) -> Self {
        Self { root: worktree_root.as_ref().canonicalize().ok() }
    }

    /// The canonical worktree root, or `None` when it could not be resolved.
    pub fn root(&self) -> Option<&Path> {
        self.root.as_deref()
    }

    /// Whether `target` — absolute, `~`-rooted, or relative to the worktree root — resolves
    /// inside the root.
    ///
    /// The target need not exist: the deepest existing ancestor is canonicalized and the missing
    /// tail re-joined, so creating a new file is the ordinary case rather than an error. A target
    /// that still cannot be resolved — a `..` that walks off a non-existent ancestor, a `~` with
    /// no `HOME`, or a root that would not canonicalize — is `false`, never a quiet allow.
    ///
    /// Comparison is by **path component**: [`Path::starts_with`] matches whole components, so
    /// `/a/bc` is not inside `/a/b`. Canonicalizing the existing part is also what catches a
    /// symlink escape — `<root>/link/f` where `link` points outside resolves outside.
    pub fn resolves_inside(&self, target: &str) -> bool {
        let Some(root) = self.root.as_deref() else {
            return false;
        };
        resolve_against(root, target).is_some_and(|path| path.starts_with(root))
    }

    fn path_decision(&self, input: &Value) -> HookJsonOutput {
        let target = input
            .get("file_path")
            .or_else(|| input.get("notebook_path"))
            .and_then(Value::as_str);
        match target {
            Some(target) if self.resolves_inside(target) => decision("allow", WALL_ALLOW_REASON),
            Some(_) => {
                decision("ask", "the target is outside the worker's worktree, or unresolvable")
            }
            None => decision("ask", "the tool named no path to check"),
        }
    }

    fn bash_decision(&self, input: &Value) -> HookJsonOutput {
        let Some(command) = input.get("command").and_then(Value::as_str) else {
            return decision("ask", "the Bash call carried no command to classify");
        };
        let verdict = classify(command)
            .segments()
            .iter()
            .map(|segment| self.segment_verdict(segment))
            .max_by_key(|(rank, _)| *rank)
            .unwrap_or((Rank::Ask, "the line ran no command the classifier could see"));
        match verdict {
            (Rank::NoOpinion, _) => HookJsonOutput::default(),
            (Rank::Allow, reason) => decision("allow", reason),
            (Rank::Ask, reason) => decision("ask", reason),
            (Rank::Deny, reason) => decision("deny", reason),
        }
    }

    fn segment_verdict(&self, segment: &Segment) -> (Rank, &'static str) {
        // Refused whoever asks, and before any guard: there is nothing to qualify.
        if segment.class == BashClass::NestedClaude {
            return (Rank::Deny, WALL_NESTED_CLAUDE_REASON);
        }
        let Some((name, args)) = segment.command() else {
            return (Rank::Ask, "the segment ran no command the classifier could see");
        };
        // Guard 1 — git told to work somewhere other than here.
        if name == "git" && args.iter().any(|a| is_git_elsewhere_flag(a)) {
            return (Rank::Ask, "this git command names a directory outside the worktree");
        }
        // Guard 2 — an absolute or `~`-rooted word that does not land inside the worktree. This
        // is checked for every class, so `cat ~/.ssh/id_rsa` asks instead of falling through.
        if segment.words.iter().any(|w| self.escapes_worktree(w)) {
            return (Rank::Ask, "a path on this line is outside the worker's worktree");
        }

        // The allowlist.
        if segment.class == BashClass::Unknown && tables::PACKAGE_MANAGERS.contains(&name) {
            // `cargo test`, `npm test`, `go build`: `package_manager_class` answers `Unknown`
            // ("a build or test run, contents unknown") for every non-mutating subcommand, so a
            // mutating one — `npm install`, `cargo fmt` — is `Mutate` and never reaches here.
            return (Rank::Allow, "a build or test run inside the worker's worktree");
        }
        if name == "git" {
            if let Some(sub) = git_subcommand(args) {
                if tables::GIT_MUTATE_SUBCOMMANDS.contains(&sub)
                    && !tables::GIT_REMOTE_SUBCOMMANDS.contains(&sub)
                {
                    return (Rank::Allow, "a local git mutation inside the worker's worktree");
                }
            }
        }
        match segment.class {
            BashClass::Read | BashClass::Inspect => (Rank::NoOpinion, ""),
            // `Mutate` that is not one of the allowed shapes, and every other `Unknown`. This is
            // the allowlist being deliberately conservative: `rm -rf build` inside the worktree
            // lands here and parks one order rather than running unwatched.
            _ => (Rank::Ask, "brigadier does not pre-authorize this command"),
        }
    }

    /// Whether `word` carries an absolute or `~`-rooted path that does not resolve inside the
    /// root.
    ///
    /// Two candidates are checked, which is what makes an assignment and an attached flag value
    /// visible: the word itself, and — for a `NAME=VALUE` or `--flag=VALUE` word — the part after
    /// the **first** `=`. Without the second, `GIT_WORK_TREE=/tmp/victim git reset --hard` and
    /// `cargo test --target-dir=/tmp/out` both slip past, the first because
    /// [`Segment::command`](crate::wall::Segment::command) peels assignments off before guard 1
    /// ever sees the line and the second because the word begins with `-`.
    ///
    /// Relative paths are ignored, in either position: judging one means evaluating the shell's
    /// cwd, which this never does.
    fn escapes_worktree(&self, word: &str) -> bool {
        path_candidates(word).any(|candidate| !self.resolves_inside(candidate))
    }
}

impl HookPolicy for WorkerWall {
    fn pre_tool_use(&self, tool_name: Option<&str>, input: &Value) -> HookJsonOutput {
        match tool_name {
            Some("Bash") => self.bash_decision(input),
            Some(name) if WORKTREE_PATH_TOOLS.contains(&name) => self.path_decision(input),
            // Read, Glob, Grep, WebFetch, TodoWrite, an MCP tool, an unnamed callback: the
            // harness has no opinion and the CLI's own flow decides.
            _ => HookJsonOutput::default(),
        }
    }
}

/// How strict one segment's answer is. Declaration order **is** the strictness order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Rank {
    NoOpinion,
    Allow,
    Ask,
    Deny,
}

/// The path-shaped parts of one word: the word itself when it is rooted, and the value after the
/// first `=` when that is rooted.
///
/// One helper for both spellings a path hides in — `NAME=/path` and `--flag=/path` — because they
/// are the same shape and were the same hole.
fn path_candidates(word: &str) -> impl Iterator<Item = &str> {
    let rooted = |s: &str| s.starts_with('/') || s.starts_with('~');
    let whole = Some(word).filter(|w| rooted(w));
    let after_eq = word.split_once('=').map(|(_, value)| value).filter(|v| rooted(v));
    whole.into_iter().chain(after_eq)
}

/// `-C`, `--git-dir` or `--work-tree`, in either the separate or the `--flag=value` spelling.
fn is_git_elsewhere_flag(arg: &str) -> bool {
    GIT_ELSEWHERE_FLAGS.contains(&arg)
        || GIT_ELSEWHERE_FLAGS
            .iter()
            .any(|f| f.starts_with("--") && arg.starts_with(&format!("{f}=")))
}

/// `git`'s subcommand, past the global flags that take an argument (`git -c a.b=c commit`).
fn git_subcommand(args: &[String]) -> Option<&str> {
    let mut i = 0usize;
    while let Some(arg) = args.get(i) {
        if !arg.starts_with('-') {
            return Some(arg.as_str());
        }
        i += if tables::GIT_GLOBAL_FLAGS_WITH_ARG.contains(&arg.as_str()) {
            2
        } else {
            1
        };
    }
    None
}

/// Make `target` absolute against `root`, then canonicalize as much of it as exists.
///
/// A leading `~/` is expanded from `HOME`; a bare `~` or a `~user` form is not, because neither
/// can be resolved without guessing. Returns `None` for anything unresolvable — a `..` that walks
/// past an ancestor which does not exist, a `~` with no `HOME`, or a path that runs off the
/// filesystem root.
fn resolve_against(root: &Path, target: &str) -> Option<PathBuf> {
    if target.is_empty() {
        return None;
    }
    let absolute = if let Some(rest) = target.strip_prefix("~/") {
        PathBuf::from(std::env::var_os("HOME")?).join(rest)
    } else if target.starts_with('~') {
        // `~` alone, or `~someone/…`: not resolvable here, and not guessed at.
        return None;
    } else {
        let raw = Path::new(target);
        if raw.is_absolute() {
            raw.to_path_buf()
        } else {
            root.join(raw)
        }
    };

    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut cursor = absolute.as_path();
    loop {
        if let Ok(real) = cursor.canonicalize() {
            let mut resolved = real;
            for part in tail.iter().rev() {
                resolved.push(part);
            }
            return Some(resolved);
        }
        // `file_name` is `None` when the path ends in `..` or is a root: neither is something
        // this can peel one component off, so the target is unresolvable.
        let name = cursor.file_name()?;
        tail.push(name.to_os_string());
        cursor = cursor.parent()?;
    }
}

/// One `hookSpecificOutput` in the CLI's own spelling.
fn decision(what: &str, reason: &str) -> HookJsonOutput {
    HookJsonOutput {
        hook_specific_output: Some(json!({
            "hookEventName": "PreToolUse",
            "permissionDecision": what,
            "permissionDecisionReason": reason,
        })),
        ..HookJsonOutput::default()
    }
}


/// A shared policy, as the adapter holds it.
pub type SharedHookPolicy = Arc<dyn HookPolicy>;

/// [`AllowAll`], boxed.
pub fn allow_all() -> SharedHookPolicy {
    Arc::new(AllowAll)
}

/// [`AskGatedTools::default`], boxed. The policy every [`ClaudeDriver`](crate::claude::ClaudeDriver)
/// starts with.
pub fn ask_gated_tools() -> SharedHookPolicy {
    Arc::new(AskGatedTools::default())
}

/// [`WorkerWall`] for one worktree, boxed. What a loop-dispatched worker child is spawned with.
pub fn worker_wall(worktree_root: impl AsRef<Path>) -> SharedHookPolicy {
    Arc::new(WorkerWall::new(worktree_root))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allow_all_serializes_to_the_empty_object_the_cli_accepted() {
        let out = AllowAll.pre_tool_use(Some("Bash"), &serde_json::json!({"command": "echo hi"}));
        assert_eq!(serde_json::to_string(&out).expect("ser"), "{}");
    }

    /// The exact bytes that go back on a `hook_callback` for a gated tool. Field casing is the
    /// whole point: the 2.1.258 binary's zod schema is
    /// `{hookEventName: x("PreToolUse"), permissionDecision: …optional(), permissionDecisionReason:
    /// …optional()}` and a snake_case key is silently ignored, not rejected.
    // see docs/research/approvals.md §5 (measured with `strings` over 2.1.258).
    #[test]
    fn a_gated_tool_asks_in_the_cli_spelling() {
        let policy = AskGatedTools::default().with_reason("brigadier gates this tool");
        let out = policy.pre_tool_use(Some("Bash"), &serde_json::json!({"command": "ls -1"}));
        assert_eq!(
            serde_json::to_string(&out).expect("ser"),
            r#"{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"brigadier gates this tool"}}"#
        );
    }

    #[test]
    fn an_ungated_tool_and_an_unnamed_callback_both_fall_through() {
        let policy = AskGatedTools::default();
        for name in [Some("Read"), Some("Glob"), Some("Grep"), Some("WebFetch"), Some("TodoWrite")] {
            let out = policy.pre_tool_use(name, &Value::Null);
            assert_eq!(serde_json::to_string(&out).expect("ser"), "{}", "{name:?} must not ask");
        }
        // An absent name must not be treated as a match for anything.
        assert_eq!(
            serde_json::to_string(&policy.pre_tool_use(None, &Value::Null)).expect("ser"),
            "{}"
        );
    }

    #[test]
    fn the_default_set_is_every_tool_that_writes() {
        let policy = AskGatedTools::default();
        assert_eq!(
            policy.tools().collect::<Vec<_>>(),
            ["Bash", "Edit", "MultiEdit", "NotebookEdit", "Write"]
        );
        for tool in GATED_TOOLS {
            assert!(policy.gates(Some(tool)), "{tool} must be gated");
        }
    }

    // -------------------------------------------------------------------------------------
    // the worker wall
    // -------------------------------------------------------------------------------------

    /// `permissionDecision`, or `None` for the `{}` fall-through.
    fn verdict(out: &HookJsonOutput) -> Option<String> {
        out.hook_specific_output
            .as_ref()
            .and_then(|v| v.get("permissionDecision"))
            .and_then(Value::as_str)
            .map(str::to_owned)
    }

    fn bash(wall: &WorkerWall, command: &str) -> Option<String> {
        verdict(&wall.pre_tool_use(Some("Bash"), &json!({ "command": command })))
    }

    fn write_to(wall: &WorkerWall, path: &str) -> Option<String> {
        verdict(&wall.pre_tool_use(Some("Write"), &json!({ "file_path": path })))
    }

    /// A worktree with one file in it, and the wall built on its canonical root.
    fn scratch() -> (tempfile::TempDir, WorkerWall) {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(dir.path().join("src")).expect("src");
        std::fs::write(dir.path().join("src/main.rs"), "fn main() {}").expect("write");
        let wall = WorkerWall::new(dir.path());
        assert!(wall.root().is_some(), "the root must canonicalize");
        (dir, wall)
    }

    #[test]
    fn a_write_inside_the_worktree_is_allowed_and_one_above_it_asks() {
        let (dir, wall) = scratch();
        assert_eq!(write_to(&wall, &dir.path().join("src/main.rs").display().to_string()), Some("allow".into()));
        // A file that does not exist yet is the ordinary case for `Write`.
        assert_eq!(write_to(&wall, &dir.path().join("src/new/deep.rs").display().to_string()), Some("allow".into()));
        // Relative paths resolve against the worktree root, which is the worker's cwd.
        assert_eq!(write_to(&wall, "src/main.rs"), Some("allow".into()));

        let above = dir.path().parent().expect("parent").join("escape.rs");
        assert_eq!(write_to(&wall, &above.display().to_string()), Some("ask".into()));
        assert_eq!(write_to(&wall, "../escape.rs"), Some("ask".into()));
        // No path at all is a question, never an allow.
        assert_eq!(
            verdict(&wall.pre_tool_use(Some("Write"), &json!({}))),
            Some("ask".into())
        );
        // `NotebookEdit` names its target differently.
        assert_eq!(
            verdict(&wall.pre_tool_use(
                Some("NotebookEdit"),
                &json!({ "notebook_path": dir.path().join("a.ipynb").display().to_string() })
            )),
            Some("allow".into())
        );
    }

    /// The comparison is by path component, so a sibling whose name merely starts with the root's
    /// is outside. A string prefix would get this wrong.
    #[test]
    fn a_sibling_directory_sharing_a_name_prefix_is_outside() {
        let parent = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir(parent.path().join("b")).expect("b");
        std::fs::create_dir(parent.path().join("bc")).expect("bc");
        let wall = WorkerWall::new(parent.path().join("b"));
        assert!(wall.resolves_inside(&parent.path().join("b/f.rs").display().to_string()));
        assert!(!wall.resolves_inside(&parent.path().join("bc/f.rs").display().to_string()));
    }

    /// Canonicalizing the existing part is what catches a symlink pointing out of the worktree.
    #[cfg(unix)]
    #[test]
    fn a_symlink_out_of_the_worktree_does_not_count_as_inside() {
        let outside = tempfile::tempdir().expect("outside");
        let (dir, wall) = scratch();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("link")).expect("symlink");
        assert_eq!(write_to(&wall, "link/loot.txt"), Some("ask".into()));
        assert_eq!(write_to(&wall, "src/ok.txt"), Some("allow".into()));
    }

    /// A root that cannot be resolved leaves every path check an `ask`, never an allow.
    #[test]
    fn an_unresolvable_root_asks_for_everything_it_cannot_check() {
        let wall = WorkerWall::new("/no/such/worktree/anywhere");
        assert!(wall.root().is_none());
        assert_eq!(write_to(&wall, "/no/such/worktree/anywhere/f.rs"), Some("ask".into()));
    }

    /// The Bash table, row by row. Everything that is not on the allowlist parks.
    #[test]
    fn the_bash_policy_is_an_allowlist() {
        let (_dir, wall) = scratch();
        let rows: &[(&str, Option<&str>)] = &[
            // The build-and-test case. `cargo test` classifies `Unknown`, and asking for it would
            // park the run on its own green gate.
            ("cargo test", Some("allow")),
            ("RUST_LOG=debug cargo test --workspace", Some("allow")),
            ("npm test", Some("allow")),
            ("npm run build", Some("allow")),
            // Installing is a side effect on the machine.
            ("npm install left-pad", Some("ask")),
            ("cargo fmt", Some("ask")),
            // Local git is what a worker is pre-authorized for; a remote is not.
            ("git commit -m x", Some("allow")),
            ("git add -A && git commit -m x", Some("allow")),
            ("git merge feature", Some("allow")),
            ("git push origin main", Some("ask")),
            ("git fetch origin", Some("ask")),
            // `git_class` skips global flags, so without guard 1 this reads as a local reset.
            ("git -C /elsewhere reset --hard", Some("ask")),
            ("git --git-dir=/elsewhere/.git log -p", Some("ask")),
            // An absolute path outside the worktree, on any class.
            ("rm -rf /tmp/victim", Some("ask")),
            ("cat ~/.ssh/id_rsa", Some("ask")),
            // Deliberately conservative: an allowlist parks a destructive local command too.
            ("rm -rf build", Some("ask")),
            ("ssh host true", Some("ask")),
            // Refused whoever asks.
            ("claude -p 'do the thing'", Some("deny")),
            ("claude", Some("deny")),
            // A wrapper's long flag must not swallow the command word: without `--user` in
            // `tables::PREFIX_FLAGS_WITH_ARG` this downgraded to `ask`.
            ("sudo --user root claude -p x", Some("deny")),
            ("sudo -u root claude -p x", Some("deny")),
            // Not classifiable is a question, never an allow.
            ("frobnicate --wat", Some("ask")),
            ("$CMD --go", Some("ask")),
            ("", Some("ask")),
            // Reading and orienting: no opinion, the CLI's own flow decides.
            ("ls -1", None),
            ("git status", None),
            ("cat src/main.rs", None),
            // The strictest segment of a pipeline wins.
            ("ls | claude -p x", Some("deny")),
            ("cargo test | grep ok", Some("allow")),
        ];
        for (command, want) in rows {
            assert_eq!(
                bash(&wall, command).as_deref(),
                *want,
                "{command:?}"
            );
        }
    }

    /// An environment assignment is a path the guard has to see.
    ///
    /// `Segment::command()` peels leading assignments to find the command word, so guard 1 sees
    /// no `--work-tree` here and the assignment word does not begin with `/`. Without inspecting
    /// the value after the `=`, `GIT_WORK_TREE=/tmp/victim git reset --hard` is an allow.
    #[test]
    fn an_assignment_pointing_out_of_the_worktree_asks() {
        let (dir, wall) = scratch();
        for command in [
            "GIT_WORK_TREE=/tmp/victim git reset --hard",
            "GIT_DIR=/tmp/victim/.git git commit -m x",
            "GIT_INDEX_FILE=/tmp/victim/index git add -A",
            "CARGO_TARGET_DIR=/tmp/out cargo test",
        ] {
            assert_eq!(bash(&wall, command).as_deref(), Some("ask"), "{command:?}");
        }
        // An assignment that stays inside is not a reason to park.
        let inside = format!("CARGO_TARGET_DIR={}/target cargo test", dir.path().display());
        assert_eq!(bash(&wall, &inside).as_deref(), Some("allow"), "{inside:?}");
        // And an assignment that names no path at all is left alone.
        assert_eq!(bash(&wall, "RUST_LOG=debug cargo test").as_deref(), Some("allow"));
    }

    /// A path attached to a flag with `=` begins with `-`, so the bare-word check never sees it.
    #[test]
    fn a_path_attached_to_a_flag_asks() {
        let (dir, wall) = scratch();
        assert_eq!(
            bash(&wall, "cargo test --target-dir=/tmp/brigadier-out").as_deref(),
            Some("ask")
        );
        assert_eq!(
            bash(&wall, "cargo test --manifest-path=/elsewhere/Cargo.toml").as_deref(),
            Some("ask")
        );
        // The same flag pointing inside the worktree is still a build.
        let inside = format!("cargo test --target-dir={}/target", dir.path().display());
        assert_eq!(bash(&wall, &inside).as_deref(), Some("allow"), "{inside:?}");
    }

    /// The documented limit, pinned: the guard reads a command's **arguments**, and
    /// `Segment.words` has redirection targets removed, so a redirected read is invisible to it.
    ///
    /// This is not a theoretical gap and the rustdoc says so. It is left standing because
    /// exposing redirection targets is a change to `crate::wall::bash`'s own contract, out of
    /// proportion to the containment `docs/vision.md` §11 actually promises — a git worktree, not
    /// a sandbox.
    #[test]
    fn a_redirected_read_from_outside_the_worktree_is_a_documented_blind_spot() {
        let (_dir, wall) = scratch();
        // Seen, because the path is an argument.
        assert_eq!(bash(&wall, "cat /etc/passwd").as_deref(), Some("ask"));
        // Not seen, because the path is a redirection target.
        assert_eq!(bash(&wall, "cat </etc/passwd"), None, "the documented blind spot");
    }

    /// Everything that is not Bash and not a path tool falls through untouched.
    #[test]
    fn the_wall_has_no_opinion_about_tools_it_does_not_gate() {
        let (_dir, wall) = scratch();
        for name in [Some("Read"), Some("Glob"), Some("Grep"), Some("WebFetch"), Some("Task"), None]
        {
            assert_eq!(
                serde_json::to_string(&wall.pre_tool_use(name, &Value::Null)).expect("ser"),
                "{}",
                "{name:?}"
            );
        }
    }

    #[test]
    fn a_custom_set_gates_only_what_it_names() {
        let policy = AskGatedTools::new(["Write"]).with_reason("writes only");
        assert!(policy.gates(Some("Write")));
        assert!(!policy.gates(Some("Bash")));
        let out = policy.pre_tool_use(Some("Write"), &Value::Null);
        let json: Value = serde_json::to_value(&out).expect("ser");
        assert_eq!(json["hookSpecificOutput"]["permissionDecisionReason"], "writes only");
    }
}
