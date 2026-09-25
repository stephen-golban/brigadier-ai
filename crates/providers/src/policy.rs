//! Brigadier's approval policy for CLI sessions.
//!
//! Workers run full-auto inside their CLI's OS sandbox, but "inside the sandbox" is not the same
//! as "authorized". Two kinds of request always reach a person:
//!
//! - actions that affect the outside world ([`ALWAYS_ASK`]: push, publish, deploy, cloud), at
//!   every permission level (PLAN.md §5);
//! - requests to leave or widen the sandbox.
//!
//! Each adapter makes its CLI ask Brigadier for these (Claude through ask rules and its
//! permission-prompt tool, Codex through its approval policy), and [`route`] decides what
//! Brigadier answers on the user's behalf.

use crate::model::{Access, ApprovalKind, ApprovalRequest};

/// Commands with effects outside the machine, as program + subcommand words. A command matches
/// when its program is the first word and the other words follow in order, with anything in
/// between (`git -C repo push` matches `git push`).
pub const ALWAYS_ASK: &[&[&str]] = &[
    &["git", "push"],
    &["git", "send-pack"],
    &["git", "send-email"],
    &["git", "lfs", "push"],
    &["gh", "gist", "create"],
    &["gh", "pr", "create"],
    &["gh", "pr", "merge"],
    &["gh", "pr", "close"],
    &["gh", "pr", "reopen"],
    &["gh", "pr", "edit"],
    &["gh", "pr", "comment"],
    &["gh", "pr", "review"],
    &["gh", "pr", "ready"],
    &["gh", "issue", "create"],
    &["gh", "issue", "close"],
    &["gh", "issue", "comment"],
    &["gh", "issue", "edit"],
    &["gh", "release"],
    &["gh", "repo", "create"],
    &["gh", "repo", "delete"],
    &["gh", "repo", "edit"],
    &["gh", "repo", "rename"],
    &["gh", "workflow", "run"],
    &["gh", "secret"],
    &["gh", "api"],
    &["npm", "publish"],
    &["npm", "unpublish"],
    &["pnpm", "publish"],
    &["yarn", "publish"],
    &["yarn", "npm", "publish"],
    &["bun", "publish"],
    &["cargo", "publish"],
    &["cargo", "yank"],
    &["twine", "upload"],
    &["poetry", "publish"],
    &["uv", "publish"],
    &["gem", "push"],
    &["pod", "trunk", "push"],
    &["docker", "push"],
    &["vercel"],
    &["netlify", "deploy"],
    &["fly", "deploy"],
    &["flyctl", "deploy"],
    &["wrangler", "deploy"],
    &["wrangler", "publish"],
    &["firebase", "deploy"],
    &["heroku"],
    &["railway", "up"],
    &["terraform", "apply"],
    &["terraform", "destroy"],
    &["pulumi", "up"],
    &["pulumi", "destroy"],
    &["kubectl", "apply"],
    &["kubectl", "delete"],
    &["helm", "install"],
    &["helm", "upgrade"],
    &["helm", "uninstall"],
    &["aws"],
    &["gcloud"],
    &["az"],
];

/// Claude Code permission rules that make every [`ALWAYS_ASK`] command prompt, even when an
/// allow rule or the sandbox's auto-allow would run it.
pub fn claude_ask_rules() -> Vec<String> {
    let mut rules = Vec::with_capacity(ALWAYS_ASK.len() * 2);
    for words in ALWAYS_ASK {
        rules.push(format!("Bash({} *)", words.join(" ")));
        if let [program, rest @ ..] = words
            && !rest.is_empty()
        {
            // Options between the program and its subcommand (`git -C repo push`).
            rules.push(format!("Bash({program} * {} *)", rest.join(" ")));
        }
    }
    rules
}

/// What Brigadier does with an approval request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    /// Answer yes on the user's behalf.
    Allow,
    /// Answer no on the user's behalf.
    Deny,
    /// Only the user can answer.
    AskUser,
}

/// How approvals are answered for a session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalMode {
    /// Approve for me: allow what stays inside the session's access, ask the user otherwise.
    Delegated,
    /// Decline everything (a read-only session such as the orchestrator).
    DeclineAll,
}

/// Decides who answers `request`.
pub fn route(request: &ApprovalRequest, access: &Access, mode: ApprovalMode) -> Route {
    if mode == ApprovalMode::DeclineAll {
        return Route::Deny;
    }
    if let Some(command) = &request.command
        && is_outward(command)
    {
        return Route::AskUser;
    }
    if request.escalation || request.kind == ApprovalKind::Permissions {
        return Route::AskUser;
    }
    match access {
        Access::ReadOnly => Route::AskUser,
        Access::Workspace { .. } | Access::Full => Route::Allow,
        // The OS sandbox confines commands; file tools outside it may only write where the
        // sandbox would let a command write.
        Access::Scoped {
            write_cwd,
            writable_roots,
            ..
        } => {
            if request.kind != ApprovalKind::FileChange {
                return Route::Allow;
            }
            let cwd = request.cwd.as_deref().map(std::path::Path::new);
            let writable = |path: &std::path::Path| {
                writable_roots.iter().any(|root| path.starts_with(root))
                    || (*write_cwd && cwd.is_some_and(|cwd| path.starts_with(cwd)))
            };
            if !request.paths.is_empty()
                && request
                    .paths
                    .iter()
                    .all(|path| writable(std::path::Path::new(path)))
            {
                Route::Allow
            } else {
                Route::AskUser
            }
        }
    }
}

/// Whether a shell command line runs any [`ALWAYS_ASK`] command. Errs on the side of asking:
/// every simple command in the line is checked, including those inside `sh -c '…'` wrappers,
/// subshells and command substitutions.
pub fn is_outward(command: &str) -> bool {
    simple_commands(command).iter().any(|words| {
        ALWAYS_ASK
            .iter()
            .any(|pattern| matches_pattern(words, pattern))
    })
}

/// The script of a `sh -c '…'` wrapper (`/bin/zsh -lc 'npm test'` → `npm test`), else the
/// command itself.
pub fn unwrapped_command(command: &str) -> String {
    let commands = simple_commands(command);
    if let [inner @ .., outer] = commands.as_slice()
        && let Some(script) = shell_script(outer)
        && simple_commands(&script).len() == inner.len()
    {
        return script.trim().to_owned();
    }
    command.trim().to_owned()
}

fn matches_pattern(words: &[String], pattern: &[&str]) -> bool {
    let words = strip_prefixes(words);
    let Some((program, rest)) = words.split_first() else {
        return false;
    };
    let name = program.rsplit('/').next().unwrap_or(program);
    if name != pattern[0] {
        return false;
    }
    let mut remaining = rest.iter();
    pattern[1..]
        .iter()
        .all(|wanted| remaining.any(|word| word == wanted))
}

/// Drops environment assignments and transparent wrappers (`env`, `sudo`, `command`, …).
fn strip_prefixes(words: &[String]) -> &[String] {
    const WRAPPERS: &[&str] = &["env", "sudo", "command", "exec", "nohup", "time", "nice"];
    let mut index = 0;
    while let Some(word) = words.get(index) {
        let assignment = word
            .split_once('=')
            .is_some_and(|(name, _)| !name.is_empty() && !name.starts_with('-'));
        let wrapper = WRAPPERS.contains(&word.as_str());
        let wrapper_option = index > 0 && word.starts_with('-');
        if assignment || wrapper || wrapper_option {
            index += 1;
        } else {
            break;
        }
    }
    &words[index..]
}

/// Splits a command line into simple commands (word lists), descending into `sh -c` scripts,
/// `$(…)`, backticks and parentheses.
fn simple_commands(line: &str) -> Vec<Vec<String>> {
    let mut commands = Vec::new();
    collect_commands(line, &mut commands, 0);
    commands
}

fn collect_commands(line: &str, commands: &mut Vec<Vec<String>>, depth: usize) {
    if depth > 4 {
        return;
    }
    // Simple commands at this level; nested ones go straight to `commands`.
    let mut local: Vec<Vec<String>> = Vec::new();
    let mut current: Vec<String> = Vec::new();
    let mut word = String::new();
    let mut in_word = false;
    let mut chars = line.chars().peekable();

    let finish_word = |word: &mut String, in_word: &mut bool, current: &mut Vec<String>| {
        if *in_word {
            current.push(std::mem::take(word));
            *in_word = false;
        }
    };

    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                in_word = true;
                for c in chars.by_ref() {
                    if c == '\'' {
                        break;
                    }
                    word.push(c);
                }
            }
            '"' => {
                in_word = true;
                let mut inner = String::new();
                while let Some(c) = chars.next() {
                    match c {
                        '"' => break,
                        '\\' => {
                            if let Some(next) = chars.next() {
                                inner.push(next);
                            }
                        }
                        _ => inner.push(c),
                    }
                }
                if inner.contains("$(") || inner.contains('`') {
                    collect_commands(&inner, commands, depth + 1);
                }
                word.push_str(&inner);
            }
            '\\' => {
                in_word = true;
                if let Some(next) = chars.next() {
                    word.push(next);
                }
            }
            '$' if chars.peek() == Some(&'(') => {
                chars.next();
                let inner = take_balanced(&mut chars);
                collect_commands(&inner, commands, depth + 1);
                in_word = true;
            }
            '`' => {
                let inner: String = chars.by_ref().take_while(|c| *c != '`').collect();
                collect_commands(&inner, commands, depth + 1);
                in_word = true;
            }
            '(' | '{' if !in_word => {
                let inner = if c == '(' {
                    take_balanced(&mut chars)
                } else {
                    chars.by_ref().take_while(|c| *c != '}').collect()
                };
                collect_commands(&inner, commands, depth + 1);
            }
            ';' | '&' | '|' | '\n' => {
                finish_word(&mut word, &mut in_word, &mut current);
                if !current.is_empty() {
                    local.push(std::mem::take(&mut current));
                }
            }
            c if c.is_whitespace() => finish_word(&mut word, &mut in_word, &mut current),
            c => {
                in_word = true;
                word.push(c);
            }
        }
    }
    finish_word(&mut word, &mut in_word, &mut current);
    if !current.is_empty() {
        local.push(current);
    }

    // `sh -c 'script'` and friends: the script is where the commands are.
    for words in &local {
        if let Some(script) = shell_script(words) {
            collect_commands(&script, commands, depth + 1);
        }
    }
    commands.extend(local);
}

fn take_balanced(chars: &mut std::iter::Peekable<std::str::Chars<'_>>) -> String {
    let mut depth = 1;
    let mut inner = String::new();
    for c in chars.by_ref() {
        match c {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            _ => {}
        }
        inner.push(c);
    }
    inner
}

/// The script of `bash -c '…'`, `zsh -lc '…'` and similar.
fn shell_script(words: &[String]) -> Option<String> {
    let words = strip_prefixes(words);
    let (program, rest) = words.split_first()?;
    let name = program.rsplit('/').next().unwrap_or(program);
    if !matches!(name, "sh" | "bash" | "zsh" | "dash" | "ksh" | "fish") {
        return None;
    }
    let flag = rest
        .iter()
        .position(|word| word.starts_with('-') && !word.starts_with("--") && word.contains('c'))?;
    rest.get(flag + 1).cloned()
}

// ----- the command gate: argv-level matching -----------------------------------------------

/// The environment variable that carries a CLI session's gate grant to the command gate.
/// Codex's default environment filter drops names containing KEY, SECRET or TOKEN, so this one
/// avoids them.
pub const GATE_ENV: &str = "BRIGADIER_GATE";

/// Programs named in [`ALWAYS_ASK`], each once, in order. The command gate shims each of them
/// on a worker's PATH.
pub fn gate_programs() -> Vec<&'static str> {
    let mut programs: Vec<&'static str> = Vec::new();
    for words in ALWAYS_ASK {
        if !programs.contains(&words[0]) {
            programs.push(words[0]);
        }
    }
    programs
}

/// What the command gate does with a command line, judged from its argv alone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArgvVerdict {
    /// Stays on the machine: runs without asking.
    Local,
    /// Affects the outside world (or cannot be judged): the user decides.
    Outward,
    /// A git subcommand that is not a git command, so it may be an alias. Look up
    /// `alias.<name>` with the real git and these global options, then judge
    /// [`expand_git_alias`]'s result.
    GitAlias { globals: Vec<String>, name: String },
}

/// Judges `argv` (`argv[0]` is the program, as invoked) for the command gate.
///
/// - git: global options before the subcommand are skipped (`git -C repo push`,
///   `git -c k=v --git-dir=… push`), the subcommand is matched exactly (so `git log --grep push`
///   runs), commands that run other commands (`submodule foreach`, `rebase --exec`,
///   `bisect run`) are judged by what they run, and anything that is not a git command may be
///   an alias ([`ArgvVerdict::GitAlias`]). An unknown global option asks.
/// - gh: an unknown top-level command may be an alias or an extension, so it asks.
/// - everything else: [`ALWAYS_ASK`] matching over the words.
pub fn classify_argv(argv: &[String]) -> ArgvVerdict {
    let Some((program, args)) = argv.split_first() else {
        return ArgvVerdict::Local;
    };
    let name = program.rsplit('/').next().unwrap_or(program);
    match name {
        "git" => classify_git(args),
        "gh" if args.first().is_some_and(|command| {
            !command.starts_with('-') && !GH_COMMANDS.contains(&command.as_str())
        }) =>
        {
            ArgvVerdict::Outward
        }
        _ => {
            let mut words = Vec::with_capacity(argv.len());
            words.push(name.to_owned());
            words.extend(args.iter().cloned());
            if ALWAYS_ASK
                .iter()
                .any(|pattern| matches_pattern(&words, pattern))
            {
                ArgvVerdict::Outward
            } else {
                ArgvVerdict::Local
            }
        }
    }
}

/// The command line a git alias stands for: `argv` with the alias word replaced by the
/// alias's words (git's own quoting rules). `None` for a shell alias (`!…`), which runs an
/// arbitrary command line: the gate asks for those.
pub fn expand_git_alias(argv: &[String], value: &str) -> Option<Vec<String>> {
    let value = value.trim();
    if value.starts_with('!') {
        return None;
    }
    let (program, args) = argv.split_first()?;
    let split = split_git_globals(args);
    let command = split.command?;
    let mut expanded = Vec::with_capacity(argv.len() + 4);
    expanded.push(program.clone());
    expanded.extend(args[..command].iter().cloned());
    expanded.extend(split_git_cmdline(value));
    expanded.extend(args[command + 1..].iter().cloned());
    Some(expanded)
}

/// Top-level `gh` commands (2.101) and help topics. Anything else is an alias or an
/// extension.
#[rustfmt::skip]
const GH_COMMANDS: &[&str] = &[
    "accessibility", "actions", "agent-task", "alias", "api", "attestation", "auth", "browse",
    "cache", "codespace", "completion", "config", "copilot", "discussion", "environment",
    "exit-codes", "extension", "formatting", "gist", "gpg-key", "help", "issue", "label",
    "licenses", "mintty", "org", "pr", "preview", "project", "reference", "release", "repo",
    "ruleset", "run", "search", "secret", "skill", "ssh-key", "status", "telemetry", "variable",
    "version", "workflow",
];

/// git's commands (built-ins and the scripts git ships). git never lets an alias shadow a
/// command, so these skip the alias lookup; any other word is looked up.
#[rustfmt::skip]
const GIT_COMMANDS: &[&str] = &[
    "add", "am", "annotate", "apply", "archimport", "archive", "backfill", "bisect", "blame",
    "branch", "bugreport", "bundle", "cat-file", "check-attr", "check-ignore", "check-mailmap",
    "check-ref-format", "checkout", "checkout-index", "cherry", "cherry-pick", "citool", "clean",
    "clone", "column", "commit", "commit-graph", "commit-tree", "config", "count-objects",
    "credential", "credential-cache", "credential-osxkeychain", "credential-store",
    "cvsexportcommit", "cvsimport", "cvsserver", "daemon", "describe", "diagnose", "diff",
    "diff-files", "diff-index", "diff-pairs", "diff-tree", "difftool", "fast-export", "fast-import",
    "fetch", "fetch-pack", "filter-branch", "fmt-merge-msg", "for-each-ref", "for-each-repo",
    "format-patch", "fsck", "fsck-objects", "fsmonitor--daemon", "gc", "get-tar-commit-id", "grep",
    "gui", "hash-object", "help", "hook", "http-backend", "http-fetch", "http-push", "imap-send",
    "index-pack", "init", "init-db", "instaweb", "interpret-trailers", "last-modified", "log",
    "ls-files", "ls-remote", "ls-tree", "mailinfo", "mailsplit", "maintenance", "merge",
    "merge-base", "merge-file", "merge-index", "merge-octopus", "merge-one-file", "merge-ours",
    "merge-recursive", "merge-resolve", "merge-subtree", "merge-tree", "mergetool", "mktag",
    "mktree", "multi-pack-index", "mv", "name-rev", "notes", "p4", "pack-objects", "pack-redundant",
    "pack-refs", "patch-id", "prune", "prune-packed", "pull", "push", "quiltimport", "range-diff",
    "read-tree", "rebase", "receive-pack", "reflog", "refs", "remote", "remote-ext", "remote-fd",
    "remote-ftp", "remote-ftps", "remote-http", "remote-https", "repack", "replace", "replay",
    "repo", "request-pull", "rerere", "reset", "restore", "rev-list", "rev-parse", "revert", "rm",
    "send-email", "send-pack", "sh-i18n--envsubst", "shell", "shortlog", "show", "show-branch",
    "show-index", "show-ref", "sparse-checkout", "stage", "stash", "status", "stripspace",
    "submodule", "subtree", "svn", "switch", "symbolic-ref", "tag", "unpack-file", "unpack-objects",
    "update-index", "update-ref", "update-server-info", "upload-archive", "upload-pack", "var",
    "verify-commit", "verify-pack", "verify-tag", "version", "web--browse", "whatchanged",
    "worktree", "write-tree",
];

/// Where git's global options end.
struct GitSplit {
    /// Index (in the arguments after `git`) of the subcommand; `None` when there is none.
    command: Option<usize>,
    /// A global option this list does not know, so its arguments cannot be told apart.
    unknown_option: bool,
}

/// Skips git's global options (git 2.54 `handle_options`).
fn split_git_globals(args: &[String]) -> GitSplit {
    const WITH_VALUE: &[&str] = &[
        "-C",
        "-c",
        "--git-dir",
        "--work-tree",
        "--namespace",
        "--super-prefix",
        "--config-env",
        "--attr-source",
        "--shallow-file",
        "--exec-path",
    ];
    const FLAGS: &[&str] = &[
        "-p",
        "--paginate",
        "-P",
        "--no-pager",
        "--no-replace-objects",
        "--no-lazy-fetch",
        "--no-optional-locks",
        "--no-advice",
        "--bare",
        "--literal-pathspecs",
        "--no-literal-pathspecs",
        "--glob-pathspecs",
        "--noglob-pathspecs",
        "--icase-pathspecs",
    ];
    // Print something and exit, or turn into `git help` / `git version`.
    const TERMINAL: &[&str] = &[
        "-h",
        "--help",
        "-v",
        "--version",
        "--html-path",
        "--man-path",
        "--info-path",
    ];
    let mut index = 0;
    while let Some(arg) = args.get(index) {
        let arg = arg.as_str();
        if !arg.starts_with('-') {
            return GitSplit {
                command: Some(index),
                unknown_option: false,
            };
        }
        let joined = arg
            .split_once('=')
            .is_some_and(|(name, _)| WITH_VALUE.contains(&name) || name == "--list-cmds");
        if TERMINAL.contains(&arg) || arg.starts_with("--list-cmds=") || arg == "--exec-path" {
            // `--exec-path` without a value prints the path.
            return GitSplit {
                command: None,
                unknown_option: false,
            };
        }
        if joined || FLAGS.contains(&arg) {
            index += 1;
        } else if WITH_VALUE.contains(&arg) {
            index += 2;
        } else {
            return GitSplit {
                command: None,
                unknown_option: true,
            };
        }
    }
    GitSplit {
        command: None,
        unknown_option: false,
    }
}

fn classify_git(args: &[String]) -> ArgvVerdict {
    let split = split_git_globals(args);
    if split.unknown_option {
        return ArgvVerdict::Outward;
    }
    let Some(command) = split.command else {
        return ArgvVerdict::Local;
    };
    let sub = args[command].as_str();
    let rest = &args[command + 1..];
    let outward_sub = ALWAYS_ASK.iter().any(|pattern| {
        pattern[0] == "git"
            && pattern
                .get(1)
                .is_some_and(|wanted| wanted.eq_ignore_ascii_case(sub))
            && pattern[2..]
                .iter()
                .all(|wanted| rest.iter().any(|word| word == wanted))
    });
    if outward_sub || git_runs_outward(sub, rest) {
        return ArgvVerdict::Outward;
    }
    if GIT_COMMANDS.contains(&sub) {
        ArgvVerdict::Local
    } else {
        ArgvVerdict::GitAlias {
            globals: args[..command].to_vec(),
            name: sub.to_owned(),
        }
    }
}

/// git commands that run a command line of their own.
fn git_runs_outward(sub: &str, rest: &[String]) -> bool {
    let command_line = match sub {
        // `git submodule [--quiet] foreach [--recursive] <command>`
        "submodule" => match rest.iter().position(|word| word == "foreach") {
            Some(at) => rest[at + 1..]
                .iter()
                .skip_while(|word| word.starts_with('-'))
                .cloned()
                .collect::<Vec<_>>()
                .join(" "),
            None => return false,
        },
        // `git rebase -x <cmd>`, `--exec <cmd>`, `--exec=<cmd>`
        "rebase" => {
            let mut commands = Vec::new();
            let mut words = rest.iter();
            while let Some(word) = words.next() {
                if word == "-x" || word == "--exec" {
                    commands.extend(words.next().cloned());
                } else if let Some(command) = word.strip_prefix("--exec=") {
                    commands.push(command.to_owned());
                } else if let Some(command) = word.strip_prefix("-x")
                    && !command.is_empty()
                {
                    commands.push(command.to_owned());
                }
            }
            commands.join("\n")
        }
        // `git bisect run <cmd> [<args>…]`
        "bisect" if rest.first().is_some_and(|word| word == "run") => rest[1..].join(" "),
        _ => return false,
    };
    is_outward(&command_line)
}

/// Splits an alias value the way git's `split_cmdline` does: whitespace separates words,
/// single and double quotes group them, and a backslash escapes the next character (outside
/// single quotes).
fn split_git_cmdline(value: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut in_word = false;
    let mut quote: Option<char> = None;
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        match (quote, c) {
            (Some('\''), '\'') | (Some('"'), '"') => quote = None,
            (Some('"') | None, '\\') => {
                in_word = true;
                if let Some(next) = chars.next() {
                    word.push(next);
                }
            }
            (None, '\'' | '"') => {
                in_word = true;
                quote = Some(c);
            }
            (None, c) if c.is_whitespace() => {
                if in_word {
                    words.push(std::mem::take(&mut word));
                    in_word = false;
                }
            }
            (_, c) => {
                in_word = true;
                word.push(c);
            }
        }
    }
    if in_word {
        words.push(word);
    }
    words
}
