//! The command sets, and nothing else.
//!
//! Everything the wall knows about *which* command is which lives in this file as plain data, so
//! moving a command between sets is an edit here and not a rewrite of [`super::bash`]. W3-A of
//! `docs/plans/phase-4.md` counts on that: it expects the move onto the worktree axis
//! (`docs/vision.md` §8) to be a data edit. The matching *rules* — tokenising, per-segment
//! classification, strictest-wins — are invariant and live next door.
//!
//! Every entry is a **basename**: `/bin/cat`, `./cat` and `cat` all look the set up as `cat`.

/// Commands that print the contents of a file.
///
/// The membership rule is **it echoes file bytes, rather than only saying what exists.** So
/// pagers, dumpers and searchers that echo file bytes are all here — `grep`/`rg` because they print matching lines, `awk`/`cut`/`sort`/`uniq`
/// because a file argument makes them a `cat` with extra steps, `diff` because it prints both
/// sides, `jq`/`yq` because a config file is code too.
///
/// Reading is pre-authorized inside a worker's own worktree (`docs/vision.md` §8), so this is not
/// a refusal list; it is how a policy tells a file read from an orientation command. What it
/// cannot tell is *whose* file — no argument here is resolved to a path (see [`super`]).
///
/// `sed`, `git` and `sort` are not in this table: they are classified by their arguments in
/// [`super::bash`] (`sed -i` writes, `git status` inspects, `sort -o` writes).
pub const READ_COMMANDS: &[&str] = &[
    "ack", "ag", "awk", "bat", "batcat", "cat", "colordiff", "cut", "diff", "egrep", "expand",
    "fgrep", "fold", "gawk", "grep", "head", "hexdump", "jq", "less", "mawk", "more", "most", "nl",
    "od", "pr", "rev", "rg", "sdiff", "strings", "tac", "tail", "uniq", "unexpand", "vimdiff",
    "xxd", "yq", "zcat", "zgrep",
];

/// Commands that reveal what *exists* without revealing what it says: `ls`, `find`, `git status`,
/// `git log --oneline`. Orientation, and cheap to let run.
///
/// `echo`/`printf` are here because they print their own arguments, not a file — and a `>` after
/// one is caught by the redirection rule, not by this table.
pub const INSPECT_COMMANDS: &[&str] = &[
    "basename", "cd", "date", "df", "dirname", "du", "echo", "false", "file", "hostname", "id",
    "ls", "printf", "ps", "pwd", "readlink", "realpath", "sleep", "stat", "test", "tree", "true",
    "type", "uname", "uptime", "wc", "whereis", "which", "whoami", "[", ":",
];

/// Commands that change the tree or the world. This is the set the worktree axis is really about:
/// below the worktree root a write needs no human, while the entries here that reach past it —
/// `ssh`, `scp`, `sftp`, `rsync`, `gh`, `glab`, `crontab`, `launchctl`, `systemctl`,
/// `softwareupdate`, `mount` — are what queues an approval (`docs/vision.md` §8). Which of the two
/// a given invocation is cannot be decided from this table alone; see [`super`].
///
/// Editors are here because an editor is a writer, and from a hook-driven shell an interactive one
/// is a hang as well. Archivers are here because they unpack over the tree. `wget` and `curl` are
/// not here at all: both are classified by their arguments in [`super::bash`], `wget` because it
/// writes a file by default and `curl` because it writes to stdout by default.
pub const MUTATE_COMMANDS: &[&str] = &[
    "7z", "bzip2", "chflags", "chgrp", "chmod", "chown", "crontab", "dd", "defaults", "ed",
    "emacs", "gh", "glab", "gunzip", "gzip", "hg", "install", "kill", "killall", "launchctl", "ln",
    "micro", "mkdir", "mkfifo", "mknod", "mktemp", "mount", "mv", "nano", "patch", "pico", "pkill",
    "rm", "rmdir", "rsync", "scp", "sftp", "shred", "softwareupdate", "ssh", "svn", "systemctl",
    "tar", "tee", "touch", "truncate", "umount", "unxz", "unzip", "vi", "vim", "nvim", "xattr",
    "xz", "zip", "cp",
];

/// Interpreters and orchestrators: they can do anything, so they are classified `Unknown` rather
/// than guessed at.
///
/// This is the escape hatch, written down rather than hidden: a session that writes a shell script
/// and runs it is past the wall, which stops the easy path and not every path. Naming these
/// explicitly is how that limit stays visible instead of arriving as a surprise `Unknown` from the
/// fall-through.
pub const OPAQUE_COMMANDS: &[&str] = &[
    "bash", "dash", "deno", "docker", "fish", "irb", "kubectl", "make", "node", "perl", "php",
    "podman", "python", "python3", "rake", "ruby", "sh", "source", "tsx", "zsh", ".",
];

/// Wrappers that run another command: skipped, and the command after them is classified instead.
/// `command cat x` is `cat x`.
pub const PREFIX_COMMANDS: &[&str] = &[
    "!", "builtin", "command", "do", "doas", "elif", "else", "env", "exec", "if", "ionice", "nice",
    "nohup", "stdbuf", "sudo", "then", "time", "timeout", "until", "while", "xargs", "{", "}",
];

/// Shell keywords that are not commands at all: a loop header, or the end of a block. Without
/// them, the trailing `fi` of `if [ -f x ]; then ls; fi` would be an unrecognised command and
/// would drag an otherwise-allowed line to `Unknown` — a prompt for a word that runs nothing.
pub const NO_OP_KEYWORDS: &[&str] = &["case", "done", "esac", "fi", "for", "in", "select"];

/// Prefix flags that swallow the following word, per prefix command. `sudo -u root cat f` must not
/// stop at `root`.
///
/// The long spellings are here because their absence was a **downgrade**, not a false alarm:
/// `sudo --user root claude -p x` took `--user` for the command word, so `claude` was never
/// reached and a `NestedClaude` that should be refused whoever asks came back merely
/// unclassifiable. Same word, two spellings, one table.
pub const PREFIX_FLAGS_WITH_ARG: &[&str] = &[
    "--adjustment",
    "--chdir",
    "--delimiter",
    "--directory",
    "--group",
    "--kill-after",
    "--max-args",
    "--max-procs",
    "--prompt",
    "--replace",
    "--signal",
    "--user",
    "-C",
    "-E",
    "-I",
    "-L",
    "-P",
    "-U",
    "-a",
    "-c",
    "-d",
    "-g",
    "-i",
    "-k",
    "-n",
    "-o",
    "-s",
    "-u",
];

/// Redirection targets that are not the user's tree. `ls > /dev/null 2>&1` writes nothing.
pub const DEV_SINKS: &[&str] = &[
    "/dev/null",
    "/dev/stdout",
    "/dev/stderr",
    "/dev/tty",
    "/dev/zero",
];

/// The nested-CLI names, refused whoever asks. brigadier rents and owns every model window itself
/// (`docs/vision.md` §3); one spawned from inside a worker is a window the harness did not rent,
/// cannot see, and cannot count against the usage window it is holding a reserve in
/// (`docs/vision.md` §6).
pub const NESTED_CLAUDE_COMMANDS: &[&str] = &["claude"];

/// The flags that make a `claude` invocation headless — `claude -p`, the one `CLAUDE.md` §2 names
/// outright.
pub const NESTED_CLAUDE_PRINT_FLAGS: &[&str] = &["-p", "--print"];

// ---------------------------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------------------------

/// `git` global flags that take a separate argument, so `git -C /x show` finds `show`.
pub const GIT_GLOBAL_FLAGS_WITH_ARG: &[&str] =
    &["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"];

/// `git` subcommands that print file contents or a diff of them.
pub const GIT_READ_SUBCOMMANDS: &[&str] = &[
    "annotate",
    "blame",
    "cat-file",
    "diff",
    "diff-files",
    "diff-index",
    "diff-tree",
    "grep",
    "range-diff",
    "show",
    "whatchanged",
];

/// `git` subcommands that reveal only shape: what exists, what changed, what it is called.
pub const GIT_INSPECT_SUBCOMMANDS: &[&str] = &[
    "branch",
    "check-ignore",
    "count-objects",
    "describe",
    "help",
    "ls-files",
    "ls-remote",
    "ls-tree",
    "reflog",
    "rev-list",
    "rev-parse",
    "shortlog",
    "show-branch",
    "status",
    "var",
    "version",
];

/// `git` subcommands that write the tree, the index, the refs or a remote.
pub const GIT_MUTATE_SUBCOMMANDS: &[&str] = &[
    "add",
    "am",
    "apply",
    "bisect",
    "cherry-pick",
    "clean",
    "clone",
    "commit",
    "commit-tree",
    "fetch",
    "filter-branch",
    "format-patch",
    "gc",
    "hash-object",
    "init",
    "merge",
    "mv",
    "notes",
    "prune",
    "pull",
    "push",
    "rebase",
    "restore",
    "revert",
    "rm",
    "reset",
    "send-email",
    "submodule",
    "switch",
    "checkout",
    "update-index",
    "update-ref",
    "write-tree",
];

/// Flags that turn `git log` from a shape listing into a patch. `git log --oneline` reveals shape
/// and `git log -p` prints the file contents; this is the line between them.
pub const GIT_LOG_PATCH_FLAGS: &[&str] =
    &["-p", "-u", "-c", "--patch", "--unified", "--cc", "--patch-with-stat", "--patch-with-raw"];

/// `git` subcommands that talk to a remote, so their effect leaves the worktree.
///
/// `docs/vision.md` §8 pre-authorizes a worker inside its own worktree and names the network and
/// `git push` as things that queue instead; this is that line drawn over `git`'s subcommands.
/// `commit`, `merge` and `rebase` are deliberately absent — they are exactly the local mutations a
/// worker is pre-authorized for.
///
/// `remote` is on the list whole rather than by subcommand: a *reading* `git remote -v` is
/// [`super::BashClass::Inspect`] and never reaches a policy that consults this set, so anything
/// here that is still `Mutate` is one of [`GIT_REMOTE_MUTATE_SUBCOMMANDS`] already.
pub const GIT_REMOTE_SUBCOMMANDS: &[&str] =
    &["clone", "fetch", "pull", "push", "remote", "send-email", "submodule"];

/// `git remote` subcommands that change a remote; anything else only lists.
pub const GIT_REMOTE_MUTATE_SUBCOMMANDS: &[&str] =
    &["add", "remove", "rm", "rename", "set-url", "set-head", "set-branches", "prune", "update"];

/// `git config` flags that only read. Without one of these, `git config` is a write.
pub const GIT_CONFIG_READ_FLAGS: &[&str] =
    &["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l", "--edit", "-e"];

// ---------------------------------------------------------------------------------------------
// package managers
// ---------------------------------------------------------------------------------------------

/// Package managers and build tools whose class depends on the subcommand.
///
/// They cannot be flatly `Mutate`. Running the build or the test suite is exactly what a worker is
/// pre-authorized to do inside its own worktree; installing a package is a side effect on the
/// machine and queues an approval (`docs/vision.md` §8). So `npm test` falls through and
/// `npm install` does not.
pub const PACKAGE_MANAGERS: &[&str] = &[
    "apk", "apt", "apt-get", "brew", "bun", "bundle", "cargo", "composer", "dnf", "gem", "go",
    "npm", "pacman", "pip", "pip3", "pipx", "pnpm", "poetry", "uv", "yarn", "yum",
];

/// Subcommands that install, remove or publish — the ones that change the machine or the manifest.
pub const PACKAGE_MUTATE_SUBCOMMANDS: &[&str] = &[
    "add", "ci", "create", "dedupe", "get", "i", "init", "install", "link", "new", "prune",
    "publish", "remove", "rm", "un", "uninstall", "unlink", "update", "upgrade",
];

/// `cargo` subcommands that rewrite files in the tree on top of the shared set above.
pub const CARGO_MUTATE_SUBCOMMANDS: &[&str] = &["clean", "fix", "fmt", "login", "yank"];

/// A flag that makes an otherwise read-only tool rewrite the tree (`cargo clippy --fix`).
pub const FIX_IN_PLACE_FLAGS: &[&str] = &["--fix", "--write", "--in-place", "--allow-dirty"];

// ---------------------------------------------------------------------------------------------
// per-command argument rules
// ---------------------------------------------------------------------------------------------

/// `find` primaries that run something or delete something. `find` is otherwise an orientation
/// command: it says what exists, not what it says.
pub const FIND_ACTION_FLAGS: &[&str] = &[
    "-delete", "-exec", "-execdir", "-ok", "-okdir", "-fls", "-fprint", "-fprint0", "-fprintf",
    "-x", "-X", "--exec", "--exec-batch",
];

/// `curl` flags that write a file instead of stdout.
pub const CURL_OUTPUT_FLAGS: &[&str] =
    &["-o", "-O", "--output", "--output-dir", "--remote-name", "--remote-name-all"];

/// `sort` flags that write a file instead of stdout.
pub const SORT_OUTPUT_FLAGS: &[&str] = &["-o", "--output"];

// ---------------------------------------------------------------------------------------------
// brigadier itself
// ---------------------------------------------------------------------------------------------

/// The `brigadier` subcommands that only read.
///
/// These name the installable CLI, which was deleted along with `brigadier-guide.md` on 2026-09-02
/// and must not be rebuilt (`docs/STATUS.md` §7, `CLAUDE.md` §2). The rows stay because a
/// `brigadier` on a worker's `PATH` is still a command the classifier has to answer for; set
/// membership under the worktree axis is W3-A's call (`docs/plans/phase-4.md`).
pub const BRIGADIER_READ_SUBCOMMANDS: &[&str] =
    &["config", "doctor", "handoff", "install", "standards", "status"];

/// The `brigadier` subcommands that switch the wall off, refused whoever asks: a rule a model can
/// turn off is not a rule. `config` joins them only when it is given a value, which
/// [`super::bash`] decides by counting its arguments. Same caveat as the read set above: the
/// installable CLI these name is deleted (`docs/STATUS.md` §7).
pub const BRIGADIER_MUTATE_SUBCOMMANDS: &[&str] = &["uninstall"];

#[cfg(test)]
mod tests {
    use super::*;

    /// A command in two sets would make its class depend on match order, which is exactly the
    /// silent failure this file exists to prevent.
    #[test]
    fn no_command_is_in_two_class_tables() {
        let tables: [(&str, &[&str]); 5] = [
            ("read", READ_COMMANDS),
            ("inspect", INSPECT_COMMANDS),
            ("mutate", MUTATE_COMMANDS),
            ("opaque", OPAQUE_COMMANDS),
            ("package-manager", PACKAGE_MANAGERS),
        ];
        for (i, (name_a, a)) in tables.iter().enumerate() {
            for (name_b, b) in tables.iter().skip(i + 1) {
                for cmd in a.iter() {
                    assert!(
                        !b.contains(cmd),
                        "{cmd} is in both the {name_a} and {name_b} tables"
                    );
                }
            }
        }
    }

    /// The prefix table is consulted before the class tables, so an overlap would silently make a
    /// real command disappear.
    #[test]
    fn no_prefix_command_is_also_a_classified_command() {
        for cmd in PREFIX_COMMANDS {
            for table in [READ_COMMANDS, INSPECT_COMMANDS, MUTATE_COMMANDS, OPAQUE_COMMANDS] {
                assert!(!table.contains(cmd), "{cmd} is both a prefix and a command");
            }
        }
    }

    /// Sorted tables are how a spec edit stays reviewable; an unsorted one hides duplicates.
    #[test]
    fn the_class_tables_are_sorted_and_free_of_duplicates() {
        for (name, table) in [
            ("inspect", INSPECT_COMMANDS),
            ("opaque", OPAQUE_COMMANDS),
            ("prefix", PREFIX_COMMANDS),
            ("package-manager", PACKAGE_MANAGERS),
            ("git-read", GIT_READ_SUBCOMMANDS),
            ("git-inspect", GIT_INSPECT_SUBCOMMANDS),
        ] {
            let mut sorted = table.to_vec();
            sorted.sort_unstable();
            sorted.dedup();
            assert_eq!(sorted.len(), table.len(), "{name} has a duplicate");
        }
    }

    /// The commands worth naming by hand, in the sets they belong to: what prints a file, and what
    /// only says a file exists.
    #[test]
    fn the_sets_the_guide_names_by_hand_are_in_the_right_tables() {
        assert!(READ_COMMANDS.contains(&"cat"));
        assert!(READ_COMMANDS.contains(&"grep"));
        for allowed in ["ls", "pwd", "wc", "which", "stat", "du"] {
            assert!(INSPECT_COMMANDS.contains(&allowed), "{allowed} must be allowed");
        }
        assert!(GIT_READ_SUBCOMMANDS.contains(&"show"));
        assert!(GIT_READ_SUBCOMMANDS.contains(&"diff"));
        assert!(GIT_INSPECT_SUBCOMMANDS.contains(&"status"));
    }
}
