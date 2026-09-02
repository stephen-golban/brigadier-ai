//! Classifying one Bash command line, without running it.
//!
//! A command line is sorted into what it *reads* (`cat`, `sed -n`, `git show`, `git diff`), what it
//! only *sees* (`ls`, `find`, `git status`, `git log --oneline`), what it *writes or installs*, and
//! one class that cuts across the rest: a nested `claude`, refused whoever asks. Which of those a
//! line is decides whether it can run with nobody watching, inside the worker's own worktree
//! (`docs/vision.md` §8); making that decision belongs to the hook policy, not here.
//!
//! # What it is not
//!
//! Pure, synchronous, allocation-and-nothing-else: no filesystem, no process, no `PATH` lookup.
//! It cannot know whether `foo` on this machine is a script that runs `cat`.
//!
//! And it **tokenises but does not evaluate**: no variable expansion, no `$(…)`, no subshells.
//! Concretely — `$CMD f` is [`BashClass::Unknown`] because the command word is not known, and a
//! segment carrying a `$(…)` is never better than `Unknown` because anything could be inside it.
//! Neither is resolved; both are flagged.
//!
//! The larger hole is stated rather than hidden: this is not a permission system, and a session
//! that writes a shell script and runs it is past it. It stops the easy path, which is the one that
//! gets taken. [`tables::OPAQUE_COMMANDS`] is that hole, written down
//! — every interpreter in it returns `Unknown` on purpose rather than a guess.
//!
//! # A pipeline is not one command
//!
//! `ls | cat` is an allowed command feeding a refused one, and it must not slip through as `ls`.
//! Every segment of a list or pipeline (`;`, `&&`, `||`, `|`, `&`, newline, `(`…`)`) is classified
//! on its own and **the strictest one wins** — which is the order the [`BashClass`] variants are
//! declared in, so `max()` is the rule. [`Classification::segments`] keeps the per-segment verdicts
//! for a policy that needs to say *why*, and for one whose answer differs by who is asking: a
//! `Read` segment inside a worker's own worktree runs unattended, while an `Unknown` one still
//! deserves a prompt.
//!
//! Where the strictest-wins rule is deliberately blunt: `find . -exec rm {} +` is
//! [`BashClass::Mutate`], not `Unknown`, because `-exec` can run anything and the strictest thing
//! it could do is the honest answer.

use super::lex::{lex, Redir, Tok, Word};
use super::tables;

/// What a command line does, ordered by how strictly it should be treated.
///
/// The declaration order **is** the strictness order, and [`Classification::strictest`] relies on
/// it: `Inspect < Unknown < Read < Mutate < NestedClaude`.
///
/// * `Unknown` above `Inspect`: a command that matched no table must never be reported as one the
///   wall has vouched for.
/// * `Read` above `Unknown`: a segment positively known to print the user's code is a fact, and a
///   neighbouring unrecognised command should not dilute it.
/// * `NestedClaude` at the top: it is the one class refused whoever asks.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum BashClass {
    /// Reveals what exists, not what it says. Orientation.
    Inspect,
    /// Not classifiable. Not an allow and not a refusal — a question.
    Unknown,
    /// Prints the contents of the user's files or a diff of them.
    Read,
    /// Changes the tree, the index, the installed packages or a remote. The class where "inside
    /// the worktree or outside it" is the question, and this module cannot answer it.
    Mutate,
    /// A nested Claude Code CLI. Refused whoever asks.
    NestedClaude,
}

impl BashClass {
    /// A short, stable name for logs and UI.
    pub fn as_str(self) -> &'static str {
        match self {
            BashClass::Inspect => "inspect",
            BashClass::Unknown => "unknown",
            BashClass::Read => "read",
            BashClass::Mutate => "mutate",
            BashClass::NestedClaude => "nested-claude",
        }
    }
}

/// One command in a list or pipeline, and what it was judged to be.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Segment {
    /// The verdict for this segment alone.
    pub class: BashClass,
    /// The segment's words, unquoted, with redirection targets removed.
    pub words: Vec<String>,
    /// Why, in a few words, fit to show an operator next to a refusal.
    pub note: &'static str,
}

/// Every segment of one command line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Classification {
    segments: Vec<Segment>,
}

impl Classification {
    /// The strictest segment's class — the verdict for the line as a whole.
    ///
    /// An empty command line (blank, or only a comment) is [`BashClass::Unknown`]: a line the
    /// classifier found no command in is not one it can vouch for.
    pub fn strictest(&self) -> BashClass {
        self.segments
            .iter()
            .map(|s| s.class)
            .max()
            .unwrap_or(BashClass::Unknown)
    }

    /// The per-segment verdicts, in the order they appear on the line.
    pub fn segments(&self) -> &[Segment] {
        &self.segments
    }

    /// Whether any segment was classified `class`.
    pub fn contains(&self, class: BashClass) -> bool {
        self.segments.iter().any(|s| s.class == class)
    }

    /// The strictest segment, for a message that has to name the offending command.
    pub fn strictest_segment(&self) -> Option<&Segment> {
        self.segments.iter().max_by_key(|s| s.class)
    }
}

/// Classify one Bash command line.
///
/// Splits on `;`, `&&`, `||`, `|`, `&`, newlines and `(`…`)`, classifies each segment, and keeps
/// them all; [`Classification::strictest`] is the single verdict.
pub fn classify(command: &str) -> Classification {
    let toks = lex(command);
    let mut segments = Vec::new();
    let mut start = 0usize;
    for (i, tok) in toks.iter().enumerate() {
        if matches!(tok, Tok::Sep(_)) {
            if i > start {
                segments.push(classify_segment(&toks[start..i]));
            }
            start = i + 1;
        }
    }
    if start < toks.len() {
        segments.push(classify_segment(&toks[start..]));
    }
    Classification { segments }
}

const NOTE_NOTHING: &str = "no command word";
const NOTE_ASSIGNMENT: &str = "a variable assignment, no command";
const NOTE_EXPANDED_COMMAND: &str = "the command word is an unexpanded variable";
const NOTE_SUBSTITUTION: &str = "a $(…) substitution is not evaluated";
const NOTE_UNLISTED: &str = "not in any command table";
const NOTE_OPAQUE: &str = "an interpreter can run anything";
const NOTE_WRITE_REDIRECT: &str = "redirects into a file";
const NOTE_READ_REDIRECT: &str = "reads a file into the command";

fn classify_segment(toks: &[Tok]) -> Segment {
    let mut words: Vec<&Word> = Vec::new();
    let mut redirect = (BashClass::Inspect, "");
    let mut i = 0usize;
    while i < toks.len() {
        match &toks[i] {
            Tok::Word(w) => {
                words.push(w);
                i += 1;
            }
            Tok::Redir(r) => {
                // The word after a redirection is its target, not an argument to the command.
                let target = match toks.get(i + 1) {
                    Some(Tok::Word(w)) => Some(w.text.as_str()),
                    _ => None,
                };
                let found = redirect_class(*r, target);
                if found.0 > redirect.0 {
                    redirect = found;
                }
                i += if target.is_some() { 2 } else { 1 };
            }
            Tok::Sep(_) => i += 1,
        }
    }

    let (mut class, mut note) = command_class(&words);
    if redirect.0 > class {
        class = redirect.0;
        note = redirect.1;
    }
    // Anything could be inside a `$(…)`, so a segment carrying one is never an allow.
    if class < BashClass::Unknown && words.iter().any(|w| w.substitution) {
        class = BashClass::Unknown;
        note = NOTE_SUBSTITUTION;
    }

    Segment {
        class,
        words: words.iter().map(|w| w.text.clone()).collect(),
        note,
    }
}

/// What a redirection alone makes of a segment.
fn redirect_class(redir: Redir, target: Option<&str>) -> (BashClass, &'static str) {
    let sink = target.is_some_and(|t| {
        tables::DEV_SINKS.contains(&t) || t.starts_with("/dev/fd/") || t.starts_with("&")
    });
    match redir {
        Redir::Out | Redir::OutAppend | Redir::OutErr | Redir::ReadWrite if !sink => {
            (BashClass::Mutate, NOTE_WRITE_REDIRECT)
        }
        // `2>&1` is a duplication; `>&out.log` is a file write in disguise.
        Redir::OutDup
            if !sink && !target.is_some_and(|t| t.chars().all(|c| c.is_ascii_digit() || c == '-')) =>
        {
            (BashClass::Mutate, NOTE_WRITE_REDIRECT)
        }
        Redir::In if !sink => (BashClass::Read, NOTE_READ_REDIRECT),
        // `<<`, `<<<` and `<&` read from the script or an fd, never from the tree.
        _ => (BashClass::Inspect, ""),
    }
}

/// The class of the command itself, ignoring redirections.
fn command_class(words: &[&Word]) -> (BashClass, &'static str) {
    let mut idx = 0usize;
    // `FOO=1 cat x` runs `cat`.
    while words.get(idx).is_some_and(|w| is_assignment(&w.text)) {
        idx += 1;
    }
    if idx > 0 && idx == words.len() {
        return (BashClass::Inspect, NOTE_ASSIGNMENT);
    }

    // Peel wrappers and shell keywords until a real command word is on top.
    loop {
        let Some(word) = words.get(idx) else {
            return (BashClass::Unknown, NOTE_NOTHING);
        };
        if word.expanded {
            return (BashClass::Unknown, NOTE_EXPANDED_COMMAND);
        }
        let name = basename(&word.text);
        if !tables::PREFIX_COMMANDS.contains(&name) {
            break;
        }
        idx += 1;
        match name {
            "command" => match words.get(idx).map(|w| w.text.as_str()) {
                Some("-v" | "-V") => return (BashClass::Inspect, "a lookup, not a run"),
                Some("-p") => idx += 1,
                _ => {}
            },
            "env" => {
                while words
                    .get(idx)
                    .is_some_and(|w| is_assignment(&w.text) || w.text.starts_with('-'))
                {
                    idx += 1;
                }
                if idx >= words.len() {
                    return (BashClass::Inspect, "prints the environment");
                }
            }
            "sudo" | "doas" | "nice" | "ionice" | "stdbuf" | "xargs" | "timeout" => {
                idx = skip_flags(words, idx);
                if name == "timeout" {
                    // The duration is a bare word, not a flag.
                    idx += 1;
                }
                if idx >= words.len() {
                    return (BashClass::Unknown, "a wrapper with no command after it");
                }
            }
            _ => {}
        }
    }

    let name = basename(&words[idx].text);
    let args: Vec<&str> = words[idx + 1..].iter().map(|w| w.text.as_str()).collect();
    classify_command(name, &args)
}

/// The table lookup, once the command word and its arguments are known.
///
/// Argument-dependent commands are handled first: a flat table cannot tell `git status` from
/// `git show`, `sed -n` from `sed -i`, or `npm test` from `npm install`.
fn classify_command(name: &str, args: &[&str]) -> (BashClass, &'static str) {
    if tables::NESTED_CLAUDE_COMMANDS.contains(&name) {
        let printing = args
            .iter()
            .any(|a| tables::NESTED_CLAUDE_PRINT_FLAGS.contains(a) || a.starts_with("--print="));
        return (
            BashClass::NestedClaude,
            if printing {
                "claude -p is a second unwatched window; use a subagent"
            } else {
                "a nested claude session; use a subagent"
            },
        );
    }

    match name {
        "git" => return git_class(args),
        "sed" => {
            return if has_short_flag(args, 'i') || args.iter().any(|a| a.starts_with("--in-place"))
            {
                (BashClass::Mutate, "sed -i rewrites the file")
            } else {
                (BashClass::Read, "prints file contents")
            }
        }
        "sort" => {
            return if args.iter().any(|a| tables::SORT_OUTPUT_FLAGS.contains(a)) {
                (BashClass::Mutate, "sort -o writes a file")
            } else {
                (BashClass::Read, "prints file contents")
            }
        }
        "find" | "fd" => {
            return if args.iter().any(|a| tables::FIND_ACTION_FLAGS.contains(a)) {
                (BashClass::Mutate, "find -exec/-delete can run or remove anything")
            } else {
                (BashClass::Inspect, "lists what exists")
            }
        }
        "curl" => {
            return if args.iter().any(|a| tables::CURL_OUTPUT_FLAGS.contains(a)) {
                (BashClass::Mutate, "writes the response to a file")
            } else {
                (BashClass::Unknown, "a network call, contents unknown")
            }
        }
        "brigadier" => return brigadier_class(args),
        "wget" => return (BashClass::Mutate, "writes the response to a file"),
        _ => {}
    }

    if tables::PACKAGE_MANAGERS.contains(&name) {
        return package_manager_class(name, args);
    }
    if tables::READ_COMMANDS.contains(&name) {
        return (BashClass::Read, "prints file contents");
    }
    if tables::INSPECT_COMMANDS.contains(&name) {
        return (BashClass::Inspect, "reveals what exists, not what it says");
    }
    if tables::MUTATE_COMMANDS.contains(&name) {
        return (BashClass::Mutate, "changes the tree or the world");
    }
    if tables::OPAQUE_COMMANDS.contains(&name) {
        return (BashClass::Unknown, NOTE_OPAQUE);
    }
    if tables::NO_OP_KEYWORDS.contains(&name) {
        return (BashClass::Inspect, "a shell keyword, not a command");
    }
    (BashClass::Unknown, NOTE_UNLISTED)
}

/// `git`, whose class is entirely in the subcommand.
fn git_class(args: &[&str]) -> (BashClass, &'static str) {
    let mut i = 0usize;
    // `git -C /x show` — global flags come before the subcommand, and some take an argument.
    while let Some(arg) = args.get(i) {
        if !arg.starts_with('-') {
            break;
        }
        i += if tables::GIT_GLOBAL_FLAGS_WITH_ARG.contains(arg) {
            2
        } else {
            1
        };
    }
    let Some(sub) = args.get(i).copied() else {
        return (BashClass::Inspect, "git with no subcommand prints usage");
    };
    let rest = &args[(i + 1).min(args.len())..];

    match sub {
        "log" => {
            if rest.iter().any(|a| {
                tables::GIT_LOG_PATCH_FLAGS.contains(a) || a.starts_with("-U") || *a == "-p"
            }) {
                (BashClass::Read, "git log -p prints a diff")
            } else {
                (BashClass::Inspect, "commit shape, not contents")
            }
        }
        "stash" => match rest.iter().find(|a| !a.starts_with('-')).copied() {
            Some("list") => (BashClass::Inspect, "lists stashes"),
            Some("show") => (BashClass::Read, "prints a diff"),
            _ => (BashClass::Mutate, "changes the working tree"),
        },
        "worktree" => match rest.iter().find(|a| !a.starts_with('-')).copied() {
            Some("list") => (BashClass::Inspect, "lists worktrees"),
            _ => (BashClass::Mutate, "creates or removes a worktree"),
        },
        "remote" => match rest.iter().find(|a| !a.starts_with('-')).copied() {
            Some(s) if tables::GIT_REMOTE_MUTATE_SUBCOMMANDS.contains(&s) => {
                (BashClass::Mutate, "changes a remote")
            }
            _ => (BashClass::Inspect, "lists remotes"),
        },
        "config" => {
            if rest.iter().any(|a| tables::GIT_CONFIG_READ_FLAGS.contains(a)) {
                (BashClass::Inspect, "reads a config value")
            } else if rest.iter().filter(|a| !a.starts_with('-')).count() >= 2 {
                (BashClass::Mutate, "sets a config value")
            } else {
                (BashClass::Inspect, "reads a config value")
            }
        }
        "tag" => {
            if rest.iter().any(|a| !a.starts_with('-')) {
                (BashClass::Mutate, "creates or deletes a tag")
            } else {
                (BashClass::Inspect, "lists tags")
            }
        }
        s if tables::GIT_READ_SUBCOMMANDS.contains(&s) => {
            (BashClass::Read, "prints file contents or a diff")
        }
        s if tables::GIT_INSPECT_SUBCOMMANDS.contains(&s) => {
            (BashClass::Inspect, "reveals shape, not contents")
        }
        s if tables::GIT_MUTATE_SUBCOMMANDS.contains(&s) => {
            (BashClass::Mutate, "changes the tree, the index or a remote")
        }
        _ => (BashClass::Unknown, "unrecognised git subcommand"),
    }
}

/// Package managers: installing is a mutation, building and testing are not.
///
/// A worker is pre-authorized to build and test inside its own worktree (`docs/vision.md` §8), so
/// `npm test` must not come back `Mutate`. The answer for it is `Unknown` rather than `Inspect`,
/// because a build script can do anything and this module never guesses.
fn package_manager_class(name: &str, args: &[&str]) -> (BashClass, &'static str) {
    let sub = args.iter().find(|a| !a.starts_with('-')).copied();
    let mutating = sub.is_some_and(|s| {
        tables::PACKAGE_MUTATE_SUBCOMMANDS.contains(&s)
            || (name == "cargo" && tables::CARGO_MUTATE_SUBCOMMANDS.contains(&s))
    }) || args.iter().any(|a| tables::FIX_IN_PLACE_FLAGS.contains(a));
    if mutating {
        (BashClass::Mutate, "installs or rewrites files")
    } else {
        (BashClass::Unknown, "a build or test run, contents unknown")
    }
}

/// `brigadier` itself: `uninstall` and `config <key> <value>` are refused whoever asks, reading is
/// untouched. The installable CLI these subcommands belong to is deleted (`docs/STATUS.md` §7); the
/// rules stay because the name can still appear on a worker's `PATH`.
///
/// There is no separate class for "switches the wall off": turning the wall off *is* a change to
/// the world, so it lands in [`BashClass::Mutate`] with every other reach past the worktree.
fn brigadier_class(args: &[&str]) -> (BashClass, &'static str) {
    let mut positional = args.iter().filter(|a| !a.starts_with('-'));
    let Some(sub) = positional.next().copied() else {
        return (BashClass::Inspect, "prints what is in force");
    };
    if tables::BRIGADIER_MUTATE_SUBCOMMANDS.contains(&sub) {
        return (BashClass::Mutate, "would switch the wall off");
    }
    if sub == "config" {
        // `brigadier config lines` reads; `brigadier config lines 5` writes.
        return if positional.count() >= 2 {
            (BashClass::Mutate, "would widen the wall")
        } else {
            (BashClass::Inspect, "reads the configuration")
        };
    }
    if tables::BRIGADIER_READ_SUBCOMMANDS.contains(&sub) {
        return (BashClass::Inspect, "reads brigadier's own state");
    }
    (BashClass::Unknown, "unrecognised brigadier subcommand")
}

/// `NAME=value`, the form bash treats as an assignment prefix rather than a command.
fn is_assignment(text: &str) -> bool {
    let Some(eq) = text.find('=') else {
        return false;
    };
    // `FOO+=x` is an assignment too.
    let name = text[..eq].strip_suffix('+').unwrap_or(&text[..eq]);
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// The last path component: `/bin/cat`, `./cat` and `cat` all resolve to `cat`.
fn basename(text: &str) -> &str {
    text.rsplit('/').next().unwrap_or(text)
}

/// Whether a short-flag cluster carries `flag` — `sed -i`, `sed -ni`, `sed -i.bak`.
fn has_short_flag(args: &[&str], flag: char) -> bool {
    args.iter().any(|a| {
        a.starts_with('-')
            && !a.starts_with("--")
            && a[1..]
                .chars()
                .take_while(|c| c.is_ascii_alphabetic())
                .any(|c| c == flag)
    })
}

/// Skip a wrapper's own flags, honouring the ones that swallow the next word.
fn skip_flags(words: &[&Word], mut idx: usize) -> usize {
    while let Some(word) = words.get(idx) {
        if !word.text.starts_with('-') || word.text.len() < 2 {
            break;
        }
        idx += if tables::PREFIX_FLAGS_WITH_ARG.contains(&word.text.as_str()) {
            2
        } else {
            1
        };
    }
    idx
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The verdict for a whole line — what a hook policy actually asks for.
    fn class(line: &str) -> BashClass {
        classify(line).strictest()
    }

    fn assert_all(lines: &[&str], want: BashClass) {
        for line in lines {
            assert_eq!(class(line), want, "{line}");
        }
    }

    #[test]
    fn strictness_runs_from_inspect_up_to_nested_claude() {
        assert!(BashClass::Inspect < BashClass::Unknown);
        assert!(BashClass::Unknown < BashClass::Read);
        assert!(BashClass::Read < BashClass::Mutate);
        assert!(BashClass::Mutate < BashClass::NestedClaude);
    }

    /// `cat`, `sed -n`, `git show` and `git diff` are the obvious ones; the rest of the family
    /// follows from the same principle — it echoes file bytes.
    #[test]
    fn the_read_family_is_a_read() {
        assert_all(
            &[
                "cat src/main.rs",
                "head -n 20 f",
                "tail -f log",
                "less f",
                "more f",
                "bat f",
                "od -c f",
                "xxd f",
                "sed -n '1,5p' f",
                "sed -n 1,5p f",
                "git show HEAD",
                "git show HEAD:src/main.rs",
                "git diff",
                "git diff --stat",
                "git blame f",
                "git log -p",
                "git log --patch --oneline",
                "git log -U3",
                "grep -n needle f",
                "rg needle",
                "awk '{print $1}' f",
                "cut -d, -f1 f",
                "diff a b",
                "jq . package.json",
                "sort f",
                "strings bin",
                "git cat-file -p HEAD",
                "git grep needle",
            ],
            BashClass::Read,
        );
    }

    /// Orientation commands, kept out of every stricter class on purpose: routing needs them.
    #[test]
    fn the_inspect_set_the_guide_allows_stays_allowed() {
        assert_all(
            &[
                "ls",
                "ls -la src",
                "find . -name '*.rs'",
                "find . -type f",
                "git status",
                "git status --porcelain",
                "git log --oneline",
                "git log --oneline -20",
                "git log",
                "pwd",
                "wc -l src/main.rs",
                "which cargo",
                "stat -f %z f",
                "du -sh .",
                "echo hello",
                "git branch",
                "git rev-parse HEAD",
                "git ls-files",
                "git worktree list",
                "git remote -v",
                "git config --get user.name",
                "git tag",
                "git stash list",
            ],
            BashClass::Inspect,
        );
    }

    #[test]
    fn the_mutate_set_is_a_mutation() {
        assert_all(
            &[
                "rm -rf target",
                "mv a b",
                "cp a b",
                "mkdir -p src/new",
                "touch f",
                "sed -i 's/a/b/' f",
                "sed -i.bak 's/a/b/' f",
                "sed --in-place 's/a/b/' f",
                "sed -ni 's/a/b/' f",
                "tee f",
                "patch -p1",
                "git add .",
                "git commit -m 'x'",
                "git checkout main",
                "git switch -c topic",
                "git reset --hard origin/main",
                "git apply patch.diff",
                "git push",
                "git worktree add ../wt",
                "git config user.name Someone",
                "git tag v1",
                "git stash pop",
                "git remote add origin url",
                "npm install",
                "npm i left-pad",
                "pnpm add react",
                "yarn remove react",
                "cargo add serde",
                "cargo fmt",
                "pip install requests",
                "brew install jq",
                "go get ./...",
                "sort -o out.txt f",
                "wget https://example.com/x",
                "curl -o out.json https://example.com",
                "ln -s a b",
                "chmod +x f",
                "tar xzf a.tgz",
            ],
            BashClass::Mutate,
        );
    }

    /// A build and a test suite are not what the wall stops: a worker runs both inside its own
    /// worktree with no human (`docs/vision.md` §8). They classify `Unknown`, not `Inspect`,
    /// because nothing here can see what a build script does — the class is a question for the
    /// policy, not a verdict.
    #[test]
    fn a_build_or_test_run_is_not_a_mutation() {
        assert_all(
            &[
                "cargo test",
                "cargo build --release",
                "cargo check",
                "npm test",
                "npm run build",
                "bun test",
                "make",
                "make -j8",
                "go test ./...",
            ],
            BashClass::Unknown,
        );
    }

    #[test]
    fn a_nested_claude_is_refused_however_it_is_spelled() {
        assert_all(
            &[
                "claude -p 'do the thing'",
                "claude --print 'do the thing'",
                "claude --print='x'",
                "/usr/local/bin/claude -p x",
                "./claude -p x",
                "/Users/x/.claude/local/claude --print x",
                "claude",
                "FOO=1 claude -p x",
                "sudo claude -p x",
                "ls && claude -p x",
                "claude -p x > out.txt",
            ],
            BashClass::NestedClaude,
        );
        // The name has to be the command, not an argument.
        assert_eq!(class("which claude"), BashClass::Inspect);
        assert_eq!(class("echo claude -p"), BashClass::Inspect);
    }

    #[test]
    fn a_pipeline_or_list_takes_the_strictest_segment() {
        // The case the whole rule exists for.
        assert_eq!(class("ls | cat"), BashClass::Read);
        assert_eq!(class("cat f | grep x | wc -l"), BashClass::Read);
        assert_eq!(class("ls && rm -rf target"), BashClass::Mutate);
        assert_eq!(class("cat a; ls"), BashClass::Read);
        assert_eq!(class("pwd || cat f"), BashClass::Read);
        assert_eq!(class("ls\ncat f"), BashClass::Read);
        assert_eq!(class("ls & pwd"), BashClass::Inspect);
        assert_eq!(class("ls |& cat"), BashClass::Read);
        assert_eq!(class("git status && git add . && git commit -m x"), BashClass::Mutate);
        assert_eq!(class("cat f | claude -p x"), BashClass::NestedClaude);
        // Grouping is a separator too, so the inside is classified.
        assert_eq!(class("(cat f)"), BashClass::Read);
        assert_eq!(class("{ cat f; }"), BashClass::Read);
        assert_eq!(class("if [ -f x ]; then cat x; fi"), BashClass::Read);
        assert_eq!(class("for f in *.rs; do cat $f; done"), BashClass::Read);
    }

    #[test]
    fn every_segment_is_kept_with_its_own_verdict() {
        let c = classify("ls | cat f | rm -rf target");
        assert_eq!(c.segments().len(), 3);
        assert_eq!(c.segments()[0].class, BashClass::Inspect);
        assert_eq!(c.segments()[1].class, BashClass::Read);
        assert_eq!(c.segments()[2].class, BashClass::Mutate);
        assert_eq!(c.segments()[1].words, ["cat", "f"]);
        assert!(c.contains(BashClass::Read));
        assert!(!c.contains(BashClass::NestedClaude));
        assert_eq!(c.strictest(), BashClass::Mutate);
        assert_eq!(c.strictest_segment().map(|s| s.class), Some(BashClass::Mutate));
        assert!(!c.segments()[2].note.is_empty());
    }

    #[test]
    fn leading_environment_assignments_do_not_hide_the_command() {
        assert_eq!(class("FOO=1 cat x"), BashClass::Read);
        assert_eq!(class("FOO=1 BAR=2 rm -rf x"), BashClass::Mutate);
        assert_eq!(class("FOO=1 BAR=2 ls"), BashClass::Inspect);
        assert_eq!(class("RUST_LOG=debug cargo test"), BashClass::Unknown);
        // An assignment on its own changes nothing on disk.
        assert_eq!(class("FOO=1"), BashClass::Inspect);
        assert_eq!(class("PATH+=:/x"), BashClass::Inspect);
        // `a=b` as an argument is not a prefix assignment.
        assert_eq!(class("cat a=b"), BashClass::Read);
    }

    #[test]
    fn wrappers_and_escapes_do_not_hide_the_command() {
        assert_all(
            &[
                "command cat x",
                r"\cat x",
                "/bin/cat x",
                "./cat x",
                "../bin/cat x",
                r#""cat" x"#,
                "'cat' x",
                "env cat x",
                "env FOO=1 cat x",
                "nohup cat x",
                "time cat x",
                "xargs cat",
                "xargs -I{} cat {}",
                "xargs -n 1 cat",
                "nice -n 5 cat f",
                "timeout 5 cat f",
                "sudo cat /etc/hosts",
                "sudo -u root cat /etc/hosts",
                "exec cat f",
                "builtin cat f",
                "! cat f",
                "stdbuf -o0 cat f",
            ],
            BashClass::Read,
        );
        assert_eq!(class("sudo rm -rf /"), BashClass::Mutate);
        // `command -v` is a lookup, not a run.
        assert_eq!(class("command -v cat"), BashClass::Inspect);
        // A wrapper with nothing after it cannot be classified.
        assert_eq!(class("sudo"), BashClass::Unknown);
        assert_eq!(class("env"), BashClass::Inspect);
    }

    #[test]
    fn git_global_flags_before_the_subcommand_are_skipped() {
        assert_eq!(class("git -C /x show HEAD"), BashClass::Read);
        assert_eq!(class("git -C /x status"), BashClass::Inspect);
        assert_eq!(class("git --no-pager diff"), BashClass::Read);
        assert_eq!(class("git -c user.name=x commit -m y"), BashClass::Mutate);
        assert_eq!(class("git --git-dir /x/.git log --oneline"), BashClass::Inspect);
        assert_eq!(class("git -C /x -c core.pager=cat show"), BashClass::Read);
        assert_eq!(class("git"), BashClass::Inspect);
        assert_eq!(class("git frobnicate"), BashClass::Unknown);
    }

    #[test]
    fn a_redirection_makes_any_command_a_mutation() {
        assert_eq!(class("echo hi > f"), BashClass::Mutate);
        assert_eq!(class("echo hi >> f"), BashClass::Mutate);
        assert_eq!(class("echo hi >| f"), BashClass::Mutate);
        assert_eq!(class("ls > listing.txt"), BashClass::Mutate);
        assert_eq!(class("ls &> out.log"), BashClass::Mutate);
        assert_eq!(class("ls 2> err.log"), BashClass::Mutate);
        assert_eq!(class("ls >& out.log"), BashClass::Mutate);
        assert_eq!(class("cat f > g"), BashClass::Mutate);
        assert_eq!(class("> f"), BashClass::Mutate);
        // A duplication is not a write, and neither is a sink.
        assert_eq!(class("ls 2>&1"), BashClass::Inspect);
        assert_eq!(class("ls > /dev/null"), BashClass::Inspect);
        assert_eq!(class("ls > /dev/null 2>&1"), BashClass::Inspect);
        assert_eq!(class("ls >&2"), BashClass::Inspect);
        // The redirection target is not an argument to the command.
        assert_eq!(classify("ls > f").segments()[0].words, ["ls"]);
    }

    #[test]
    fn an_input_redirection_reads_the_tree() {
        assert_eq!(class("./script < src/main.rs"), BashClass::Read);
        assert_eq!(class("./script < /dev/null"), BashClass::Unknown);
        assert_eq!(class("./script <<< 'a string'"), BashClass::Unknown);
        assert_eq!(class("./script <&3"), BashClass::Unknown);
    }

    /// The adversarial case the operator sets are useless without: a `>` that is text.
    #[test]
    fn an_operator_inside_quotes_is_not_an_operator() {
        assert_eq!(class(r#"echo "a > b""#), BashClass::Inspect);
        assert_eq!(class("echo 'x > y'"), BashClass::Inspect);
        assert_eq!(class(r#"echo "a | rm -rf /""#), BashClass::Inspect);
        assert_eq!(class("echo 'a; rm -rf /'"), BashClass::Inspect);
        assert_eq!(class(r#"grep ">" src/main.rs"#), BashClass::Read);
        assert_eq!(class(r"echo a\>b"), BashClass::Inspect);
        // …and one that really is an operator, for contrast.
        assert_eq!(class("echo a > b"), BashClass::Mutate);
    }

    #[test]
    fn what_is_not_evaluated_is_never_reported_as_allowed() {
        // The command word is unknown, so the command is unknown.
        assert_eq!(class("$CMD f"), BashClass::Unknown);
        assert_eq!(class("$(which cat) f"), BashClass::Unknown);
        // A substitution anywhere in the segment can hide anything.
        assert_eq!(class("echo $(cat secret)"), BashClass::Unknown);
        assert_eq!(class("echo `cat secret`"), BashClass::Unknown);
        // …but it cannot make a known-strict segment weaker.
        assert_eq!(class("rm -rf $(cat list)"), BashClass::Mutate);
        assert_eq!(class("cat $(ls)"), BashClass::Read);
        // A plain variable is common enough that it is not by itself a question.
        assert_eq!(class("ls $DIR"), BashClass::Inspect);
        assert_eq!(class("cat $FILE"), BashClass::Read);
    }

    #[test]
    fn an_interpreter_is_unknown_rather_than_guessed_at() {
        assert_all(
            &["bash script.sh", "sh -c 'cat f'", "python x.py", "node x.js", "./x.sh"],
            BashClass::Unknown,
        );
        // The escape hatch, demonstrated rather than described: the inner `cat` is an argument.
        assert_eq!(classify("sh -c 'cat f'").segments().len(), 1);
    }

    #[test]
    fn an_empty_line_is_unknown_not_allowed() {
        assert_eq!(class(""), BashClass::Unknown);
        assert_eq!(class("   \t "), BashClass::Unknown);
        assert_eq!(class("# just a comment"), BashClass::Unknown);
        assert!(classify("").segments().is_empty());
    }

    #[test]
    fn find_that_runs_something_is_not_an_orientation_command() {
        assert_eq!(class("find . -name '*.rs'"), BashClass::Inspect);
        assert_eq!(class("find . -type f -exec cat {} +"), BashClass::Mutate);
        assert_eq!(class("find . -name '*.tmp' -delete"), BashClass::Mutate);
        assert_eq!(class("fd -e rs"), BashClass::Inspect);
        assert_eq!(class("fd -e rs -x cat"), BashClass::Mutate);
    }

    #[test]
    fn the_session_cannot_switch_the_wall_off() {
        assert_eq!(class("brigadier uninstall"), BashClass::Mutate);
        assert_eq!(class("brigadier uninstall --project"), BashClass::Mutate);
        assert_eq!(class("brigadier config lines 5"), BashClass::Mutate);
        assert_eq!(class("brigadier config lines 5 --project"), BashClass::Mutate);
        // Reading is untouched.
        assert_eq!(class("brigadier config"), BashClass::Inspect);
        assert_eq!(class("brigadier config lines"), BashClass::Inspect);
        assert_eq!(class("brigadier status"), BashClass::Inspect);
        assert_eq!(class("brigadier standards"), BashClass::Inspect);
        assert_eq!(class("brigadier doctor"), BashClass::Inspect);
        assert_eq!(class("brigadier handoff auth"), BashClass::Inspect);
        assert_eq!(class("brigadier install"), BashClass::Inspect);
    }

    #[test]
    fn a_heredoc_body_can_only_make_the_verdict_stricter() {
        assert_eq!(class("cat <<EOF\nhello\nEOF"), BashClass::Read);
        assert_eq!(class("cat > f <<'EOF'\nhello\nEOF"), BashClass::Mutate);
        // The body's words are classified as if they were commands — strict, never lax.
        assert_eq!(class("cat <<EOF\nrm -rf /\nEOF"), BashClass::Mutate);
    }

    #[test]
    fn a_class_has_a_stable_name() {
        assert_eq!(BashClass::Inspect.as_str(), "inspect");
        assert_eq!(BashClass::Read.as_str(), "read");
        assert_eq!(BashClass::Mutate.as_str(), "mutate");
        assert_eq!(BashClass::NestedClaude.as_str(), "nested-claude");
        assert_eq!(BashClass::Unknown.as_str(), "unknown");
    }

    /// The adversarial set, in one place: every one of these has bitten a shell-command matcher
    /// somewhere, and each is a spelling of something the tables already rule on.
    #[test]
    fn adversarial_spellings_do_not_change_the_verdict() {
        for (line, want) in [
            // No whitespace around the operators.
            ("ls|cat", BashClass::Read),
            ("echo a>b", BashClass::Mutate),
            ("git status;cat f", BashClass::Read),
            ("ls&&rm -rf x", BashClass::Mutate),
            // The command word wearing a disguise.
            (r#""/bin/cat" f"#, BashClass::Read),
            (r"/bin/\cat f", BashClass::Read),
            ("FOO=1 /bin/cat f", BashClass::Read),
            ("command /bin/cat f", BashClass::Read),
            ("sudo -- rm -rf /", BashClass::Mutate),
            ("cat -- f", BashClass::Read),
            // Keywords that run nothing must not drag an allowed line to a prompt.
            ("if [ -f x ]; then ls; fi", BashClass::Inspect),
            ("for f in *.rs; do ls; done", BashClass::Inspect),
            // Flags before the git subcommand, with a patch flag after it.
            ("git -C /x log -p", BashClass::Read),
            ("git -C /x log --oneline", BashClass::Inspect),
            // A trailing separator leaves no empty segment behind.
            ("ls;", BashClass::Inspect),
            ("ls &", BashClass::Inspect),
        ] {
            assert_eq!(class(line), want, "{line}");
        }
    }

    #[test]
    fn an_unrecognised_command_is_unknown() {
        assert_eq!(class("frobnicate --x"), BashClass::Unknown);
        assert_eq!(class("./target/debug/brigadier-core"), BashClass::Unknown);
        assert_eq!(class("docker ps"), BashClass::Unknown);
    }
}
