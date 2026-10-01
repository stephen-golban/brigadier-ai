//! Warm task worktrees: a new worktree gets copy-on-write copies of the dependency installs and
//! build caches the user's checkout already has, so a worker's first build or test run doesn't
//! start from nothing.
//!
//! Best effort throughout: anything that can't be copied safely is left out, and the worker
//! installs or builds it as it would have anyway. Never fails the task.
//!
//! - **What:** git-ignored folders named in [`CACHES`], at the root or in a tracked package
//!   folder (one holding a [`MANIFESTS`] file) up to [`MAX_DEPTH`] folders down.
//! - **Never:** Python environments ([`NEVER`], or anything holding a `pyvenv.cfg`). Their
//!   scripts point at the interpreter and packages they were made with, so a copy would keep
//!   using the user's own environment.
//! - **Paths back into the checkout:** each copy is checked before it is published. Absolute
//!   links into the checkout, and the files known to hold its path ([`known_kind`]: package
//!   shims and package-manager state, Cargo's build-script outputs and dep-info, Turbo's logs),
//!   are rewritten to the worktree. A small file near the top of the copy that still names the
//!   checkout means a kind we don't know how to rewrite: the whole copy is dropped.
//! - **Atomic:** each folder is copied into a temp folder beside its destination, checked and
//!   rewritten there, then renamed into place; on any failure the temp folder is removed. A
//!   destination that already exists is never touched.
//! - **Not mid-write:** a `target` is copied only while every profile's `.cargo-lock` can be
//!   held (and it is held for the whole copy); a `node_modules` is skipped while an install runs
//!   in the checkout or wrote to it in the last [`RECENT_WRITE`].

use std::collections::BTreeSet;
use std::fs::{self, File};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime};

use brigadier_git::Repo;
use brigadier_sandbox::Platform;
use brigadier_sandbox::clone::{self, Method};

/// Folders worth copying, as paths inside a package folder.
const CACHES: &[&str] = &[
    "node_modules",
    "target",
    ".next/cache",
    ".turbo",
    ".gradle",
    "Pods",
    ".build",
];

/// Python environments, never copied whatever else they are called.
const NEVER: &[&str] = &[".venv", "venv", "env"];

/// Files that make the folder holding them a package folder.
const MANIFESTS: &[&str] = &[
    "package.json",
    "Cargo.toml",
    "build.gradle",
    "build.gradle.kts",
    "settings.gradle",
    "settings.gradle.kts",
    "Podfile",
    "Package.swift",
];

/// How deep a package folder may sit below the root.
const MAX_DEPTH: usize = 3;

/// Marks a copy in progress: `<name>.brigadier-warming-<random>` beside its destination.
const IN_PROGRESS: &str = ".brigadier-warming-";

/// A `node_modules` written to this recently may be mid-install.
const RECENT_WRITE: Duration = Duration::from_secs(10);

/// A copy with more entries than this isn't checked (and so isn't published).
const MAX_ENTRIES: usize = 2_000_000;

/// A known file bigger than this can't be rewritten (and so the copy isn't published).
const MAX_REWRITE_BYTES: u64 = 4 << 20;

/// Files up to this size near the top of a copy are checked for the checkout's path.
const MAX_PROBE_BYTES: u64 = 64 << 10;

/// How deep in a copy those files are checked: in it, or one folder down.
const PROBE_DEPTH: usize = 2;

/// What warming did, for the log.
#[derive(Debug, Default)]
pub struct Warmed {
    /// Repo-relative folders copied in, and how.
    pub copied: Vec<(String, Method)>,
    /// Folders the checkout has that were left out, and why.
    pub skipped: Vec<(String, String)>,
}

/// Fills the new `worktree` of `repo` (the user's checkout) with copies of its caches. `aliases`
/// are other spellings of the checkout's path (the one the project was added with); `installing`
/// says a package install runs in the checkout now ([`install_running`]).
pub fn warm_worktree(
    repo: &Repo,
    aliases: &[PathBuf],
    worktree: &Path,
    installing: bool,
) -> Warmed {
    let mut warmed = Warmed::default();
    let source = repo.root();
    let worktree = fs::canonicalize(worktree).unwrap_or_else(|_| worktree.to_owned());
    let tracked = match repo.tracked_files() {
        Ok(tracked) => tracked,
        Err(err) => {
            warmed.skipped.push((".".into(), err.to_string()));
            return warmed;
        }
    };
    let paths = Paths {
        forms: source_forms(source, aliases),
        worktree: worktree.clone(),
    };
    let mut cleared = BTreeSet::new();
    for rel in candidates(&package_dirs(&tracked)) {
        let from = source.join(&rel);
        // Only real folders: a link would be copied as a link back into the checkout.
        if !fs::symlink_metadata(&from).is_ok_and(|meta| meta.is_dir()) {
            continue;
        }
        let to = worktree.join(&rel);
        let Some(parent) = to.parent() else { continue };
        if cleared.insert(parent.to_owned()) {
            clear_leftovers(parent);
        }
        match warm_one(repo, &paths, &rel, &from, &to, installing) {
            Ok(method) => warmed.copied.push((rel, method)),
            Err(why) => warmed.skipped.push((rel, why)),
        }
    }
    warmed
}

/// Copies one cache folder, or says why not.
fn warm_one(
    repo: &Repo,
    paths: &Paths,
    rel: &str,
    from: &Path,
    to: &Path,
    installing: bool,
) -> Result<Method, String> {
    if !repo.is_ignored(rel).map_err(|err| err.to_string())? {
        return Err("git doesn't ignore it".into());
    }
    if to.symlink_metadata().is_ok() {
        return Err("the worktree already has it".into());
    }
    if from.join("pyvenv.cfg").exists() {
        return Err("it is a Python environment".into());
    }
    let name = last_name(rel);
    if name == "node_modules" && (installing || recently_written(from, SystemTime::now())) {
        return Err("an install is running".into());
    }
    // The package folder exists in the worktree (it is tracked); `.next` may not.
    let parent = to.parent().ok_or("no parent folder")?;
    if !parent.is_dir() {
        let package = paths.worktree.join(package_of(rel));
        if !package.is_dir() {
            return Err("the worktree has no such package folder".into());
        }
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let temp = parent.join(format!(
        "{name}{IN_PROGRESS}{}",
        &uuid::Uuid::new_v4().simple().to_string()[..12]
    ));
    let result = (|| {
        let method = {
            // Held for the whole copy: a build can't start writing halfway through.
            let _locks = if name == "target" {
                Some(lock_cargo(from).ok_or("a build is running")?)
            } else {
                None
            };
            clone::clone_tree(from, &temp).map_err(|err| format!("copy failed: {err}"))?
        };
        settle(&temp, name, from, paths)?;
        clone::rename_new(&temp, to).map_err(|err| format!("publishing failed: {err}"))?;
        Ok(method)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&temp);
    }
    result
}

/// The checkout's path as tools may have written it, longest first (so `/private/var/x` is
/// rewritten before `/var/x`).
fn source_forms(source: &Path, aliases: &[PathBuf]) -> Vec<PathBuf> {
    let mut forms: Vec<PathBuf> = std::iter::once(source.to_owned())
        .chain(aliases.iter().cloned())
        .filter(|form| form.is_absolute() && form.components().count() > 1)
        .collect();
    forms.sort_by(|a, b| (b.as_os_str().len().cmp(&a.as_os_str().len())).then_with(|| a.cmp(b)));
    forms.dedup();
    forms
}

/// Package folders among the tracked files: the root (`""`) and every folder up to
/// [`MAX_DEPTH`] down that holds a manifest.
fn package_dirs(tracked: &[String]) -> BTreeSet<String> {
    let mut dirs = BTreeSet::from([String::new()]);
    for path in tracked {
        let (dir, file) = path.rsplit_once('/').unwrap_or(("", path));
        if MANIFESTS.contains(&file) && (dir.is_empty() || dir.split('/').count() <= MAX_DEPTH) {
            dirs.insert(dir.to_owned());
        }
    }
    dirs
}

/// The repo-relative cache folders to look for in each package folder.
fn candidates(dirs: &BTreeSet<String>) -> Vec<String> {
    dirs.iter()
        .flat_map(|dir| {
            CACHES.iter().map(move |cache| match dir.as_str() {
                "" => (*cache).to_owned(),
                dir => format!("{dir}/{cache}"),
            })
        })
        .filter(|rel| !rel.split('/').any(|part| NEVER.contains(&part)))
        .collect()
}

fn last_name(rel: &str) -> &str {
    rel.rsplit('/').next().unwrap_or(rel)
}

/// The package folder a cache path belongs to.
fn package_of(rel: &str) -> &str {
    let cache = CACHES
        .iter()
        .find(|cache| rel == **cache || rel.ends_with(&format!("/{cache}")))
        .map_or(0, |cache| cache.len());
    rel[..rel.len() - cache].trim_end_matches('/')
}

/// Removes copies a crash left half done in `dir`.
fn clear_leftovers(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy().contains(IN_PROGRESS) {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

/// Whether a package manager wrote to `node_modules` (or its state files) within
/// [`RECENT_WRITE`] of `now`.
fn recently_written(node_modules: &Path, now: SystemTime) -> bool {
    [
        "",
        ".modules.yaml",
        ".pnpm",
        ".pnpm/lock.yaml",
        ".package-lock.json",
        ".yarn-state.yml",
        ".yarn-integrity",
    ]
    .iter()
    .filter_map(|part| fs::metadata(node_modules.join(part)).ok()?.modified().ok())
    .any(|modified| is_recent(modified, now))
}

fn is_recent(modified: SystemTime, now: SystemTime) -> bool {
    // A time in the future counts as recent: the clock can't be trusted to say otherwise.
    now.duration_since(modified)
        .map_or(true, |age| age < RECENT_WRITE)
}

/// The checkout's path in each spelling, and the worktree that takes its place in a copy.
struct Paths {
    forms: Vec<PathBuf>,
    worktree: PathBuf,
}

impl Paths {
    /// `path` moved from the checkout to the worktree; `None` when it isn't in the checkout.
    fn in_worktree(&self, path: &Path) -> Option<PathBuf> {
        self.forms.iter().find_map(|form| {
            path.strip_prefix(form)
                .ok()
                .map(|rest| self.worktree.join(rest))
        })
    }

    fn in_checkout(&self, path: &Path) -> bool {
        self.forms.iter().any(|form| path.starts_with(form))
    }
}

/// Holds every `.cargo-lock` in a `target` folder (`target/debug`, `target/<triple>/release`,
/// …), or `None` when a build holds any of them.
fn lock_cargo(target: &Path) -> Option<Vec<File>> {
    let subfolders = |dir: &PathBuf| -> Vec<PathBuf> {
        fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
            .map(|entry| entry.path())
            .collect()
    };
    let mut dirs = vec![target.to_owned()];
    let mut level = dirs.clone();
    for _ in 0..2 {
        level = level.iter().flat_map(subfolders).collect();
        dirs.extend(level.iter().cloned());
    }
    let mut held = Vec::new();
    for dir in dirs {
        let path = dir.join(".cargo-lock");
        if path.is_file() {
            let file = File::open(&path).ok()?;
            file.try_lock().ok()?;
            held.push(file);
        }
    }
    Some(held)
}

/// Checks a finished copy of `from` (a cache folder named `name`) at `copy`: rewrites what
/// points into the checkout to point into the worktree instead, and fails when something still
/// does or can't be checked.
fn settle(copy: &Path, name: &str, from: &Path, paths: &Paths) -> Result<(), String> {
    let mut seen = 0usize;
    let mut pending = vec![(PathBuf::new(), 1usize)];
    while let Some((dir, depth)) = pending.pop() {
        let entries = fs::read_dir(copy.join(&dir)).map_err(|err| err.to_string())?;
        for entry in entries {
            let entry = entry.map_err(|err| err.to_string())?;
            seen += 1;
            if seen > MAX_ENTRIES {
                return Err("too many files to check".into());
            }
            let rel = dir.join(entry.file_name());
            let file_name = entry.file_name().to_string_lossy().into_owned();
            let kind = entry.file_type().map_err(|err| err.to_string())?;
            if kind.is_symlink() {
                relink(&copy.join(&rel), &from.join(&rel), paths)?;
            } else if kind.is_dir() {
                if file_name == ".venv" || file_name == "venv" {
                    return Err(format!("{} is a Python environment", rel.display()));
                }
                pending.push((rel, depth + 1));
            } else if file_name == "pyvenv.cfg" {
                return Err(format!("{} is in a Python environment", rel.display()));
            } else if known_kind(name, &rel) {
                rewrite_file(&copy.join(&rel), paths)
                    .map_err(|why| format!("{}: {why}", rel.display()))?;
            } else if depth <= PROBE_DEPTH
                && entry
                    .metadata()
                    .is_ok_and(|meta| meta.len() <= MAX_PROBE_BYTES)
                && let Ok(bytes) = fs::read(copy.join(&rel))
                && paths
                    .forms
                    .iter()
                    .any(|form| mentions(&bytes, form.as_os_str().as_encoded_bytes()))
            {
                return Err(format!("{} refers to the checkout", rel.display()));
            }
        }
    }
    Ok(())
}

/// Points a copied link at the worktree when it pointed into the checkout by an absolute path,
/// and at the same place by an absolute path when a relative one led out of the checkout (it
/// would lead somewhere else from the worktree). Relative links within the checkout already
/// mean the same place in the worktree.
fn relink(link: &Path, original: &Path, paths: &Paths) -> Result<(), String> {
    let target = fs::read_link(link).map_err(|err| err.to_string())?;
    let new = if target.is_absolute() {
        match paths.in_worktree(&target) {
            Some(new) => new,
            None => return Ok(()),
        }
    } else {
        let resolved = lexical(&original.parent().unwrap_or(original).join(&target));
        if paths.in_checkout(&resolved) {
            return Ok(());
        }
        resolved
    };
    #[cfg(unix)]
    {
        fs::remove_file(link).map_err(|err| err.to_string())?;
        std::os::unix::fs::symlink(&new, link).map_err(|err| err.to_string())
    }
    #[cfg(not(unix))]
    {
        Err(format!(
            "{} can't be pointed at {}",
            link.display(),
            new.display()
        ))
    }
}

/// `..` and `.` resolved without looking at the disk.
fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            part => out.push(part),
        }
    }
    out
}

/// Files known to hold the checkout's path, by where they sit in a cache folder named `name`:
/// package-manager shims and state, and Cargo's build-script outputs and dep-info.
fn known_kind(name: &str, rel: &Path) -> bool {
    let parts: Vec<String> = std::iter::once(name.to_owned())
        .chain(
            rel.components()
                .map(|part| part.as_os_str().to_string_lossy().into_owned()),
        )
        .collect();
    let at = |back: usize| {
        parts
            .len()
            .checked_sub(back + 1)
            .map(|index| parts[index].as_str())
    };
    let file = at(0).unwrap_or_default();
    let extension = Path::new(file)
        .extension()
        .map(|ext| ext.to_string_lossy().into_owned())
        .unwrap_or_default();
    match name {
        // Shims, and the package manager's own state beside the packages (`.modules.yaml`,
        // `.pnpm-workspace-state-v1.json`, `.package-lock.json`, …).
        "node_modules" => {
            (at(1) == Some(".bin") && at(2) == Some("node_modules"))
                || (at(1) == Some("node_modules")
                    && file.starts_with('.')
                    && ["json", "yaml", "yml"].contains(&extension.as_str()))
        }
        "target" => {
            ((file == "output" || file == "root-output") && at(2) == Some("build"))
                || extension == "d"
        }
        // Turbo's task logs.
        ".turbo" => extension == "log",
        _ => false,
    }
}

/// Rewrites a known file's mentions of the checkout to the worktree. The new content goes to a
/// new file renamed over the old one, so a file hard-linked elsewhere is never written through.
fn rewrite_file(path: &Path, paths: &Paths) -> Result<(), String> {
    let meta = fs::metadata(path).map_err(|err| err.to_string())?;
    if meta.len() > MAX_REWRITE_BYTES {
        return Err("too big to check".into());
    }
    let mut bytes = fs::read(path).map_err(|err| err.to_string())?;
    let to = paths.worktree.as_os_str().as_encoded_bytes();
    let mut changed = false;
    for form in &paths.forms {
        if let Some(new) = replace_paths(&bytes, form.as_os_str().as_encoded_bytes(), to) {
            bytes = new;
            changed = true;
        }
    }
    if !changed {
        return Ok(());
    }
    let mut name = path.file_name().unwrap_or_default().to_owned();
    name.push(".brigadier-rewrite");
    let fresh = path.with_file_name(name);
    // The old time is kept: build tools compare it with their outputs' (Cargo rebuilds what
    // depends on a build script whose `output` looks newer).
    let written = (|| {
        let mut file = File::create(&fresh)?;
        std::io::Write::write_all(&mut file, &bytes)?;
        file.set_permissions(meta.permissions())?;
        file.set_modified(meta.modified()?)?;
        drop(file);
        fs::rename(&fresh, path)
    })();
    if let Err(err) = written {
        let _ = fs::remove_file(&fresh);
        return Err(err.to_string());
    }
    Ok(())
}

/// Bytes that can continue a file or folder name: a match followed or preceded by one is part
/// of a longer name (`/Users/me/app` in `/Users/me/app-old`), not the checkout's path.
fn name_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || b"._-+@~%".contains(&byte)
}

/// Where `path` appears in `bytes` as a whole path or the start of one.
fn path_matches<'a>(bytes: &'a [u8], path: &'a [u8]) -> impl Iterator<Item = usize> + 'a {
    let first = path.first().copied();
    (0..bytes.len()).filter(move |&at| {
        Some(bytes[at]) == first
            && bytes[at..].starts_with(path)
            && (at == 0 || !name_byte(bytes[at - 1]))
            && bytes
                .get(at + path.len())
                .is_none_or(|next| !name_byte(*next))
    })
}

fn mentions(bytes: &[u8], path: &[u8]) -> bool {
    !path.is_empty() && path_matches(bytes, path).next().is_some()
}

/// `bytes` with every mention of `from` replaced by `to`; `None` when there is none.
fn replace_paths(bytes: &[u8], from: &[u8], to: &[u8]) -> Option<Vec<u8>> {
    if from.is_empty() {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len());
    let mut copied = 0;
    for at in path_matches(bytes, from) {
        // A match inside the one just replaced (a path that repeats itself) is already gone.
        if at < copied {
            continue;
        }
        out.extend_from_slice(&bytes[copied..at]);
        out.extend_from_slice(to);
        copied = at + from.len();
    }
    if copied == 0 {
        return None;
    }
    out.extend_from_slice(&bytes[copied..]);
    Some(out)
}

/// Whether a package install (`pnpm install`, `npm ci`, `yarn`, …) runs in `checkout` now.
/// Best effort: `false` when it can't be told.
pub fn install_running(platform: &dyn Platform, checkout: &Path) -> bool {
    let Ok(pids) = platform.processes().in_dir(checkout) else {
        return false;
    };
    pids.into_iter()
        .filter_map(command_line)
        .any(|line| is_install(&line))
}

/// A process's command line, its arguments separated by spaces.
#[cfg(target_os = "linux")]
fn command_line(pid: u32) -> Option<String> {
    let raw = fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    Some(
        raw.split(|byte| *byte == 0)
            .map(String::from_utf8_lossy)
            .collect::<Vec<_>>()
            .join(" "),
    )
}

#[cfg(all(unix, not(target_os = "linux")))]
fn command_line(pid: u32) -> Option<String> {
    let out = std::process::Command::new("/bin/ps")
        .args(["-o", "command=", "-p", &pid.to_string()])
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

#[cfg(not(unix))]
fn command_line(_pid: u32) -> Option<String> {
    None
}

/// Whether a command line runs a package manager command that writes `node_modules`.
fn is_install(line: &str) -> bool {
    const MANAGERS: &[&str] = &[
        "npm",
        "npm-cli.js",
        "pnpm",
        "pnpm.cjs",
        "pnpm.js",
        "yarn",
        "yarn.js",
        "yarn.cjs",
        "bun",
    ];
    const WRITES: &[&str] = &[
        "install",
        "i",
        "add",
        "ci",
        "update",
        "up",
        "upgrade",
        "remove",
        "rm",
        "uninstall",
        "un",
        "rebuild",
        "link",
        "dedupe",
        "prune",
        "import",
    ];
    const OTHERS: &[&str] = &[
        "run", "exec", "dlx", "x", "test", "start", "build", "dev", "lint", "why", "list", "ls",
        "outdated", "audit", "view", "info", "init", "create", "publish", "pack",
    ];
    let words: Vec<&str> = line.split_whitespace().collect();
    let Some(at) = words
        .iter()
        .position(|word| MANAGERS.contains(&word.rsplit(['/', '\\']).next().unwrap_or(word)))
    else {
        return false;
    };
    let manager = words[at].rsplit(['/', '\\']).next().unwrap_or_default();
    let mut commands = words[at + 1..]
        .iter()
        .filter(|word| !word.starts_with('-'))
        .peekable();
    if commands.peek().is_none() {
        // A bare `yarn` installs.
        return manager.starts_with("yarn");
    }
    // The command may come after an option's value (`pnpm --filter web add x`): the first
    // known command decides.
    commands
        .find(|word| WRITES.contains(*word) || OTHERS.contains(*word))
        .is_some_and(|word| WRITES.contains(word))
}

#[cfg(test)]
mod tests {
    use super::*;
    use brigadier_git::{Git, WorktreeSpec};
    use std::ffi::OsString;

    #[test]
    fn package_folders_are_tracked_manifests_up_to_three_down() {
        let tracked = [
            "package.json",
            "apps/web/package.json",
            "a/b/c/Cargo.toml",
            "a/b/c/d/package.json",
            "docs/readme.md",
            "ios/Podfile",
        ]
        .map(String::from);
        let dirs = package_dirs(&tracked);
        assert_eq!(
            dirs.iter().map(String::as_str).collect::<Vec<_>>(),
            ["", "a/b/c", "apps/web", "ios"]
        );
        let found = candidates(&dirs);
        assert!(found.contains(&"node_modules".to_owned()));
        assert!(found.contains(&"apps/web/.next/cache".to_owned()));
        assert!(found.contains(&"a/b/c/target".to_owned()));
        assert!(
            found
                .iter()
                .all(|rel| !rel.split('/').any(|part| NEVER.contains(&part)))
        );
        assert_eq!(package_of("apps/web/.next/cache"), "apps/web");
        assert_eq!(package_of(".next/cache"), "");
        assert_eq!(package_of("node_modules"), "");
    }

    #[test]
    fn only_whole_paths_are_rewritten() {
        let from = b"/Users/me/app";
        let to = b"/data/worktrees/task-1";
        let text = b"NODE_PATH=\"/Users/me/app/node_modules/.pnpm\" /Users/me/app-old /x/Users/me/apps /Users/me/app";
        let out = replace_paths(text, from, to).expect("a rewrite");
        assert_eq!(
            String::from_utf8(out.clone()).unwrap(),
            "NODE_PATH=\"/data/worktrees/task-1/node_modules/.pnpm\" /Users/me/app-old /x/Users/me/apps /data/worktrees/task-1"
        );
        assert!(!mentions(&out, from));
        assert!(mentions(
            b"cargo:rustc-link-search=/Users/me/app/target",
            from
        ));
        assert!(!mentions(b"/Users/me/application", from));
        assert!(replace_paths(b"nothing here", from, to).is_none());
    }

    #[test]
    fn longer_spellings_are_rewritten_first() {
        let forms = source_forms(
            Path::new("/private/var/me/app"),
            &[
                PathBuf::from("/var/me/app"),
                PathBuf::from("relative/app"),
                PathBuf::from("/private/var/me/app"),
            ],
        );
        assert_eq!(
            forms,
            [
                PathBuf::from("/private/var/me/app"),
                PathBuf::from("/var/me/app")
            ]
        );
    }

    #[test]
    fn known_kinds_are_package_shims_state_and_cargo_build_outputs() {
        let known = |name: &str, rel: &str| known_kind(name, Path::new(rel));
        assert!(known("node_modules", ".bin/vite"));
        assert!(known(
            "node_modules",
            ".pnpm/vite@5/node_modules/.bin/esbuild"
        ));
        assert!(known("node_modules", ".modules.yaml"));
        assert!(known("node_modules", ".pnpm-workspace-state-v1.json"));
        assert!(known("node_modules", ".package-lock.json"));
        assert!(!known("node_modules", "vite/.state.json"));
        assert!(known(".turbo", "turbo-build.log"));
        assert!(!known("node_modules", "vite/package.json"));
        assert!(!known("node_modules", "vite/.bin/x"));
        assert!(known("target", "debug/build/ring-1a2b/output"));
        assert!(known("target", "debug/build/ring-1a2b/root-output"));
        assert!(known(
            "target",
            "x86_64-apple-darwin/release/build/x-1/output"
        ));
        assert!(known("target", "debug/deps/brigadier_core-1a2b.d"));
        assert!(!known("target", "debug/output"));
        assert!(!known("Pods", "Manifest.lock"));
    }

    #[test]
    fn installs_are_told_from_other_package_commands() {
        assert!(is_install(
            "node /opt/homebrew/bin/pnpm install --frozen-lockfile"
        ));
        assert!(is_install(
            "/usr/local/bin/node /usr/local/lib/node_modules/npm/bin/npm-cli.js ci"
        ));
        assert!(is_install("pnpm --filter web add react"));
        assert!(is_install("node /Users/me/.yarn/bin/yarn.js"));
        assert!(!is_install("pnpm build"));
        assert!(!is_install("npm run dev"));
        assert!(!is_install("node server.js install"));
        assert!(!is_install("vim package.json"));
    }

    #[test]
    fn writes_within_ten_seconds_are_recent() {
        let now = SystemTime::now();
        assert!(is_recent(now - Duration::from_secs(3), now));
        assert!(is_recent(now + Duration::from_secs(60), now));
        assert!(!is_recent(now - Duration::from_secs(30), now));
    }

    /// A checkout with a commit, and a worktree of it.
    struct Fixture {
        dir: PathBuf,
        repo: Repo,
        worktree: PathBuf,
    }

    impl Fixture {
        fn new(ignore: &str) -> Self {
            let dir = fs::canonicalize(std::env::temp_dir())
                .unwrap()
                .join(format!("brigadier-warm-{}", uuid::Uuid::new_v4().simple()));
            fs::create_dir_all(&dir).unwrap();
            let config = dir.join("gitconfig");
            fs::write(&config, "").unwrap();
            let mut env: Vec<(OsString, OsString)> = std::env::vars_os()
                .filter(|(key, _)| !key.to_string_lossy().starts_with("GIT_"))
                .collect();
            env.push(("GIT_CONFIG_GLOBAL".into(), config.into_os_string()));
            for (key, value) in [
                ("GIT_CONFIG_NOSYSTEM", "1"),
                ("GIT_AUTHOR_NAME", "Test"),
                ("GIT_AUTHOR_EMAIL", "test@example.com"),
                ("GIT_COMMITTER_NAME", "Test"),
                ("GIT_COMMITTER_EMAIL", "test@example.com"),
            ] {
                env.push((key.into(), value.into()));
            }
            let git = Git::new(PathBuf::from("git"), env);
            let root = dir.join("checkout");
            assert!(git.init(&root).unwrap().is_none());
            let repo = git.open(&root).unwrap();
            fs::write(root.join(".gitignore"), ignore).unwrap();
            fs::write(root.join("package.json"), "{}").unwrap();
            fs::write(root.join("Cargo.toml"), "").unwrap();
            let commit = repo.commit_changes("Start", true).unwrap();
            let worktree = dir.join("worktree");
            repo.add_worktree(&worktree, WorktreeSpec::Detached { at: commit })
                .unwrap();
            Self {
                dir,
                repo,
                worktree,
            }
        }

        fn root(&self) -> &Path {
            self.repo.root()
        }

        /// Writes a file in the checkout, its folders created and dated a minute back (so they
        /// don't look mid-install).
        fn write(&self, rel: &str, content: &[u8]) {
            let path = self.root().join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, content).unwrap();
        }

        fn age(&self, rel: &str) {
            let past = SystemTime::now() - Duration::from_secs(60);
            File::open(self.root().join(rel))
                .unwrap()
                .set_modified(past)
                .unwrap();
        }

        fn warm(&self) -> Warmed {
            warm_worktree(&self.repo, &[], &self.worktree, false)
        }

        fn leftovers(&self) -> Vec<String> {
            fs::read_dir(&self.worktree)
                .unwrap()
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .filter(|name| name.contains(IN_PROGRESS))
                .collect()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    #[cfg(unix)]
    #[test]
    fn copies_are_separate_and_point_into_the_worktree() {
        let fx = Fixture::new("node_modules/\n");
        let source = fx.root().to_string_lossy().into_owned();
        fx.write("node_modules/vite/index.js", b"export {}");
        fx.write(
            "node_modules/.bin/vite",
            format!("#!/bin/sh\nNODE_PATH=\"{source}/node_modules/.pnpm\" exec node \"$@\"\n")
                .as_bytes(),
        );
        std::os::unix::fs::symlink(
            fx.root().join("node_modules/vite"),
            fx.root().join("node_modules/absolute"),
        )
        .unwrap();
        std::os::unix::fs::symlink("vite", fx.root().join("node_modules/relative")).unwrap();
        fx.age("node_modules");
        let warmed = fx.warm();
        assert_eq!(warmed.copied.len(), 1, "{warmed:?}");
        let copy = fx.worktree.join("node_modules");
        let shim = fs::read_to_string(copy.join(".bin/vite")).unwrap();
        let worktree = fs::canonicalize(&fx.worktree).unwrap();
        assert!(shim.contains(&format!("{}/node_modules/.pnpm", worktree.display())));
        assert!(!shim.contains(&source));
        // Rewritten files keep their time, so build tools don't see them as new.
        let modified = |path: &Path| fs::metadata(path).unwrap().modified().unwrap();
        assert_eq!(
            modified(&copy.join(".bin/vite")),
            modified(&fx.root().join("node_modules/.bin/vite"))
        );
        assert_eq!(
            fs::read_link(copy.join("absolute")).unwrap(),
            worktree.join("node_modules/vite")
        );
        assert_eq!(
            fs::read_link(copy.join("relative")).unwrap(),
            Path::new("vite")
        );
        // The checkout's own files are untouched, and the copy is a different file.
        assert!(
            fs::read_to_string(fx.root().join("node_modules/.bin/vite"))
                .unwrap()
                .contains(&source)
        );
        use std::os::unix::fs::MetadataExt;
        assert_ne!(
            fs::metadata(copy.join("vite/index.js")).unwrap().ino(),
            fs::metadata(fx.root().join("node_modules/vite/index.js"))
                .unwrap()
                .ino()
        );
        // A second warming leaves what is there alone.
        let again = fx.warm();
        assert!(again.copied.is_empty());
        assert_eq!(again.skipped[0].1, "the worktree already has it");
    }

    #[test]
    fn a_copy_that_still_refers_to_the_checkout_is_removed_whole() {
        let fx = Fixture::new("node_modules/\n.venv/\n");
        let source = fx.root().to_string_lossy().into_owned();
        fx.write("node_modules/a/index.js", b"export {}");
        fx.write(
            "node_modules/a/build.json",
            format!("{{\"root\":\"{source}\"}}").as_bytes(),
        );
        fx.write(".venv/pyvenv.cfg", b"home = /usr/bin");
        fx.age("node_modules");
        // A copy a crash left behind is cleared too.
        fs::create_dir_all(fx.worktree.join(format!("node_modules{IN_PROGRESS}old/a"))).unwrap();
        let warmed = fx.warm();
        assert!(warmed.copied.is_empty(), "{warmed:?}");
        assert_eq!(warmed.skipped.len(), 1, "{warmed:?}");
        assert!(warmed.skipped[0].1.contains("refers to the checkout"));
        assert!(!fx.worktree.join("node_modules").exists());
        assert!(!fx.worktree.join(".venv").exists());
        assert!(fx.leftovers().is_empty(), "{:?}", fx.leftovers());
    }

    #[test]
    fn python_environments_inside_a_cache_drop_the_copy() {
        let fx = Fixture::new("node_modules/\n");
        fx.write("node_modules/tool/venv/pyvenv.cfg", b"home = /usr/bin");
        fx.age("node_modules");
        let warmed = fx.warm();
        assert!(warmed.copied.is_empty(), "{warmed:?}");
        assert!(warmed.skipped[0].1.contains("Python environment"));
        assert!(!fx.worktree.join("node_modules").exists());
        assert!(fx.leftovers().is_empty());
    }

    #[test]
    fn a_busy_build_or_a_fresh_install_is_skipped() {
        let fx = Fixture::new("target/\nnode_modules/\n");
        fx.write("target/debug/.cargo-lock", b"");
        fx.write("target/debug/deps/lib.d", b"");
        fx.write("node_modules/a/index.js", b"export {}");
        let build = File::open(fx.root().join("target/debug/.cargo-lock")).unwrap();
        build.lock().unwrap();
        let warmed = fx.warm();
        assert!(warmed.copied.is_empty(), "{warmed:?}");
        let why = |rel: &str| {
            warmed
                .skipped
                .iter()
                .find(|(path, _)| path == rel)
                .map(|(_, why)| why.clone())
        };
        assert_eq!(why("target").as_deref(), Some("a build is running"));
        assert_eq!(
            why("node_modules").as_deref(),
            Some("an install is running")
        );
        assert!(fx.leftovers().is_empty());
        drop(build);
        fx.age("node_modules");
        let warmed = fx.warm();
        let copied: Vec<&str> = warmed.copied.iter().map(|(rel, _)| rel.as_str()).collect();
        assert_eq!(copied, ["node_modules", "target"], "{warmed:?}");
    }

    #[test]
    fn folders_git_does_not_ignore_are_left_alone() {
        let fx = Fixture::new("");
        fx.write("node_modules/a/index.js", b"export {}");
        fx.age("node_modules");
        let warmed = fx.warm();
        assert!(warmed.copied.is_empty());
        assert_eq!(warmed.skipped[0].1, "git doesn't ignore it");
    }
}
