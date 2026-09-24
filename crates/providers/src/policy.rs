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
