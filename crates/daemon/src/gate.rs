//! The outward-command gate (PLAN.md §5: actions that affect the outside world always ask).
//!
//! At start the daemon fills `<data>/gate/bin/` with one symlink per program in
//! `policy::ALWAYS_ASK` (`git`, `gh`, `npm`, …), all pointing at the running `brigadierd`.
//! Workers get that directory first on their PATH, and their gate grant in `policy::GATE_ENV`
//! (`BRIGADIER_GATE`). When a worker runs `git …`, this binary starts under the name `git`
//! ([`shim_program`]) and, before any runtime, logging or store exists ([`run_shim`]):
//!
//! 1. finds the real `git` on PATH, skipping every entry that resolves back to this binary;
//! 2. judges the command line (`policy::classify_argv`), resolving git aliases with the real
//!    git in the command's directory (`-C` and `-c alias.*=…` included; a `!` shell alias
//!    asks), recursively up to `MAX_ALIAS_DEPTH` expansions;
//! 3. a local command is `exec`ed at once, with the same argv and environment;
//! 4. an outward one asks the daemon over its socket (`ClientFrame::Gate`) and waits. Allowed:
//!    `exec`. Denied: `Brigadier: <why>` on stderr, exit status 1. No grant, no daemon, or a
//!    dropped connection deny too (fail closed).
//!
//! It guards against accidents, not against a hostile agent: a program started by absolute
//! path, a script that finds the real binary itself (git puts its own exec path first on the
//! PATH of the commands it runs, so hooks and `!` aliases see the real git), or an
//! interpreter calling an API directly are not seen.
//!
//! Unix only. On Windows the directory is not created and workers are not gated this way.

use std::path::{Path, PathBuf};

/// Alias expansions followed before the gate gives up and asks.
#[cfg(unix)]
const MAX_ALIAS_DEPTH: usize = 8;

/// The directory of gate shims for `data_dir`. Put it first on a worker's PATH.
pub fn gate_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("gate").join("bin")
}

/// (Re)creates the gate shims for `data_dir`, pointing at the running executable, and returns
/// their directory. Called once at daemon start, under the instance lock.
#[cfg(unix)]
pub fn install(data_dir: &Path) -> std::io::Result<PathBuf> {
    let dir = gate_dir(data_dir);
    let exe = std::fs::canonicalize(std::env::current_exe()?)?;
    match std::fs::remove_dir_all(&dir) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(err),
    }
    std::fs::create_dir_all(&dir)?;
    for program in brigadier_providers::policy::gate_programs() {
        std::os::unix::fs::symlink(&exe, dir.join(program))?;
    }
    Ok(dir)
}

/// On Windows there is no gate directory (see the module docs).
#[cfg(not(unix))]
pub fn install(data_dir: &Path) -> std::io::Result<PathBuf> {
    Ok(gate_dir(data_dir))
}

/// The gated program this process was started as (`argv[0]`'s file name), if any.
#[cfg(unix)]
pub fn shim_program() -> Option<&'static str> {
    let argv0 = std::env::args_os().next()?;
    let name = Path::new(&argv0).file_name()?.to_str()?;
    brigadier_providers::policy::gate_programs()
        .into_iter()
        .find(|program| *program == name)
}

/// Runs as the shim for `program`: `exec`s the real program, or exits after a denial.
#[cfg(unix)]
pub fn run_shim(program: &str) -> std::process::ExitCode {
    shim::run(program)
}

#[cfg(unix)]
mod shim {
    use std::ffi::{CString, OsString};
    use std::os::unix::ffi::OsStrExt as _;
    use std::os::unix::fs::PermissionsExt as _;
    use std::path::{Path, PathBuf};
    use std::process::{Command, ExitCode, Stdio};

    use brigadier_ipc::protocol::{ClientFrame, GateVerdict};
    use brigadier_providers::policy::{self, ArgvVerdict, GATE_ENV};
    use brigadier_sandbox::PlatformOptions;

    use super::MAX_ALIAS_DEPTH;

    /// `command not found`, as shells report it.
    const EXIT_NOT_FOUND: u8 = 127;
    /// Found but could not be executed.
    const EXIT_NOT_EXECUTABLE: u8 = 126;

    pub fn run(program: &str) -> ExitCode {
        let args: Vec<OsString> = std::env::args_os().collect();
        let this = std::env::current_exe().and_then(std::fs::canonicalize).ok();
        let Some(real) = find_real(program, this.as_deref()) else {
            eprintln!("{program}: command not found (Brigadier's gate found no {program} on PATH)");
            return ExitCode::from(EXIT_NOT_FOUND);
        };
        let argv: Vec<String> = args
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        if outward(&real, &argv) {
            // The approval is bound to the exact command line, so it must be shown exactly.
            if args.iter().any(|arg| arg.to_str().is_none()) {
                return deny(
                    program,
                    "this command line is not valid UTF-8, so it cannot be shown for approval",
                );
            }
            if let Err(message) = ask(program, this.as_deref(), argv) {
                return deny(program, &message);
            }
        }
        exec(&real, &args)
    }

    /// Whether `argv` needs the user's approval, following git aliases.
    fn outward(real: &Path, argv: &[String]) -> bool {
        let mut argv = argv.to_vec();
        for _ in 0..=MAX_ALIAS_DEPTH {
            match policy::classify_argv(&argv) {
                ArgvVerdict::Local => return false,
                ArgvVerdict::Outward => return true,
                ArgvVerdict::GitAlias { globals, name } => match git_alias(real, &globals, &name) {
                    Ok(None) => return false,
                    Ok(Some(value)) => match policy::expand_git_alias(&argv, &value) {
                        Some(expanded) => argv = expanded,
                        // A shell alias runs anything.
                        None => return true,
                    },
                    // Cannot tell: ask.
                    Err(()) => return true,
                },
            }
        }
        true
    }

    /// `alias.<name>` as the real git sees it here (the same global options, directory and
    /// environment as the call itself).
    fn git_alias(git: &Path, globals: &[String], name: &str) -> Result<Option<String>, ()> {
        let output = Command::new(git)
            .args(globals)
            .args(["config", "--get", &format!("alias.{name}")])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .map_err(|_| ())?;
        match output.status.code() {
            Some(0) => Ok(Some(
                String::from_utf8_lossy(&output.stdout)
                    .trim_end_matches(['\n', '\r'])
                    .to_owned(),
            )),
            // Not set.
            Some(1) => Ok(None),
            _ => Err(()),
        }
    }

    /// Asks the daemon; `Ok` when the user allowed the command.
    fn ask(program: &str, this: Option<&Path>, argv: Vec<String>) -> Result<(), String> {
        let grant = std::env::var(GATE_ENV)
            .ok()
            .filter(|grant| !grant.is_empty())
            .ok_or("no Brigadier session is attached to this command, so it cannot be approved")?;
        let cwd = std::env::current_dir()
            .map_err(|err| format!("cannot read the current directory: {err}"))?
            .to_str()
            .ok_or("the current directory is not valid UTF-8")?
            .to_owned();
        // The gate directory is `<data>/gate/bin`; without it on PATH, fall back to the
        // environment's (or the default) data directory.
        let data_dir = gate_dir_on_path(program, this)
            .and_then(|dir| Some(dir.parent()?.parent()?.to_path_buf()));
        let platform = brigadier_sandbox::native(PlatformOptions { data_dir })
            .map_err(|err| format!("cannot find Brigadier's data folder: {err}"))?;
        let unreachable = |err: brigadier_ipc::Error| {
            format!("cannot reach brigadierd ({err}), so nobody can approve this command")
        };
        let mut stream = brigadier_ipc::connect_blocking(
            platform.paths(),
            &ClientFrame::Gate { grant, argv, cwd },
        )
        .map_err(unreachable)?;
        match brigadier_ipc::read_frame_blocking::<GateVerdict>(&mut stream) {
            Ok(Some(GateVerdict { allow: true, .. })) => Ok(()),
            Ok(Some(GateVerdict {
                allow: false,
                message,
            })) => Err(message.unwrap_or_else(|| "you declined this command".into())),
            Ok(None) => Err("Brigadier closed the connection without an answer".into()),
            Err(err) => Err(unreachable(err)),
        }
    }

    fn deny(program: &str, message: &str) -> ExitCode {
        let message = message.trim_end().trim_end_matches('.');
        eprintln!("Brigadier: {message}. `{program}` was not run.");
        ExitCode::from(1)
    }

    /// The first `program` on PATH that is not this binary (the gate directory, or any other
    /// link back to it).
    fn find_real(program: &str, this: Option<&Path>) -> Option<PathBuf> {
        let path = std::env::var_os("PATH")?;
        std::env::split_paths(&path)
            .map(|dir| {
                if dir.as_os_str().is_empty() {
                    PathBuf::from(".")
                } else {
                    dir
                }
            })
            .map(|dir| dir.join(program))
            .find(|candidate| {
                let Ok(meta) = std::fs::metadata(candidate) else {
                    return false;
                };
                meta.is_file()
                    && meta.permissions().mode() & 0o111 != 0
                    && !is_this(candidate, this)
            })
    }

    /// The PATH entry holding the shim this process was started through.
    fn gate_dir_on_path(program: &str, this: Option<&Path>) -> Option<PathBuf> {
        let path = std::env::var_os("PATH")?;
        std::env::split_paths(&path).find(|dir| is_this(&dir.join(program), this))
    }

    fn is_this(candidate: &Path, this: Option<&Path>) -> bool {
        match (this, std::fs::canonicalize(candidate)) {
            (Some(this), Ok(resolved)) => resolved == this,
            // Without knowing ourselves, only the gate layout itself is recognizable.
            (None, _) => candidate
                .parent()
                .is_some_and(|dir| dir.ends_with("gate/bin")),
            (Some(_), Err(_)) => false,
        }
    }

    /// Replaces this process with `real`, keeping argv (`argv[0]` included) and the
    /// environment. Returns only on failure.
    fn exec(real: &Path, args: &[OsString]) -> ExitCode {
        let program = args
            .first()
            .and_then(|arg0| Path::new(arg0).file_name())
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let to_c = |bytes: &[u8]| CString::new(bytes).ok();
        let (Some(path), Some(argv)) = (
            to_c(real.as_os_str().as_bytes()),
            args.iter()
                .map(|arg| to_c(arg.as_bytes()))
                .collect::<Option<Vec<CString>>>(),
        ) else {
            eprintln!("{program}: invalid argument");
            return ExitCode::from(EXIT_NOT_EXECUTABLE);
        };
        let err = nix::unistd::execv(&path, &argv).unwrap_err();
        eprintln!("{program}: cannot run {}: {err}", real.display());
        ExitCode::from(EXIT_NOT_EXECUTABLE)
    }
}
