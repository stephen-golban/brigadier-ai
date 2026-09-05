//! Locating the `claude` binary and checking its version.
//!
//! `CLAUDE.md` §2: the `claude` binary is never bundled. The driver drives *the user's* install,
//! taking an explicit path plus a minimum version and falling back to a `PATH` walk. There is no
//! bundled binary and no download; when it is missing the UI says so.

use std::path::{Path, PathBuf};

use crate::driver::DriverError;

/// Executable name looked for on `PATH` when no explicit path is configured.
pub const CLAUDE_BIN: &str = "claude";

/// Minimum CLI version this driver was written against.
///
/// The spike ran end to end on exactly this build, and `docs/research/agent-sdk.md` §1 warns that
/// SDK/CLI drift shows up as silently missing fields rather than an error, so the floor is the
/// measured build rather than a guess at the oldest workable one.
// see docs/research/claude-direct-spike.md "Environment" — `2.1.257 (Claude Code)`.
pub const MIN_VERSION: &str = "2.1.257";

/// Prefer PATH, then standard install locations that Finder launches may omit.
pub fn resolve_claude() -> Option<PathBuf> {
    resolve_in(std::env::var_os("PATH").as_deref(), std::env::var_os("HOME").as_deref())
}

fn resolve_in(path: Option<&std::ffi::OsStr>, home: Option<&std::ffi::OsStr>) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = path.into_iter().flat_map(std::env::split_paths)
        .filter(|dir| !dir.as_os_str().is_empty()).map(|dir| dir.join(CLAUDE_BIN)).collect();
    if let Some(home) = home {
        candidates.push(PathBuf::from(home).join(".local/bin/claude"));
    }
    #[cfg(target_os = "macos")]
    candidates.extend([PathBuf::from("/opt/homebrew/bin/claude"), PathBuf::from("/usr/local/bin/claude")]);
    candidates.into_iter().find(|candidate| is_executable(candidate))
}

#[cfg(all(test, unix))]
#[test]
fn finder_path_finds_native_install_but_explicit_path_wins() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let native = dir.path().join(".local/bin/claude");
    std::fs::create_dir_all(native.parent().unwrap()).unwrap();
    std::fs::write(&native, "#!/bin/sh\n").unwrap();
    std::fs::set_permissions(&native, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(resolve_in(Some(std::ffi::OsStr::new("/usr/bin:/bin")), Some(dir.path().as_os_str())), Some(native));
    let explicit = dir.path().join("claude");
    std::fs::write(&explicit, "#!/bin/sh\n").unwrap();
    std::fs::set_permissions(&explicit, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(resolve_in(Some(dir.path().as_os_str()), Some(dir.path().as_os_str())), Some(explicit));
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

/// Runs `claude --version` and returns the trimmed first line.
///
/// # Errors
/// [`DriverError::BinaryNotFound`] when the binary cannot be executed, and
/// [`DriverError::Protocol`] when it exits non-zero or prints nothing.
pub async fn claude_version(binary: &Path) -> Result<String, DriverError> {
    let out = tokio::process::Command::new(binary)
        .arg("--version")
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|e| DriverError::BinaryNotFound(format!("{} ({e})", binary.display())))?;
    if !out.status.success() {
        return Err(DriverError::Protocol(format!(
            "{} --version exited with {}",
            binary.display(),
            out.status
        )));
    }
    let line = String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .unwrap_or_default()
        .trim()
        .to_owned();
    if line.is_empty() {
        return Err(DriverError::Protocol(format!(
            "{} --version printed nothing",
            binary.display()
        )));
    }
    Ok(line)
}

/// Extracts the `X.Y.Z` prefix of a `claude --version` line.
///
/// The observed output is `2.1.257 (Claude Code)`
/// (see docs/research/claude-direct-spike.md "Environment"), so the version is the first
/// whitespace-delimited token. Returns `None` when that token is not three dot-separated
/// integers, which is the only shape [`version_at_least`] can compare.
pub fn parse_version(line: &str) -> Option<(u64, u64, u64)> {
    parse_triple(line.split_whitespace().next()?)
}

fn parse_triple(token: &str) -> Option<(u64, u64, u64)> {
    let mut parts = token.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    // Tolerate a pre-release suffix on the patch (`257-rc1`) by taking the leading digits.
    let patch_token = parts.next()?;
    let digits: String = patch_token.chars().take_while(char::is_ascii_digit).collect();
    let patch = digits.parse().ok()?;
    Some((major, minor, patch))
}

/// True when `found` is at least `required`, comparing `X.Y.Z` numerically.
///
/// An unparseable `found` is **not** treated as too old: the CLI's version string is not a
/// contract (`docs/research/cli-protocol.md` §3 — nothing about this surface is versioned), and
/// refusing to start on a format change would be worse than running.
pub fn version_at_least(found: &str, required: &str) -> bool {
    match (parse_version(found), parse_version(required)) {
        (Some(f), Some(r)) => f >= r,
        _ => true,
    }
}

/// Resolves the binary, runs `--version`, and enforces the floor.
///
/// # Errors
/// [`DriverError::BinaryNotFound`], [`DriverError::Protocol`] or [`DriverError::VersionTooOld`].
pub async fn probe_binary(
    configured: Option<&Path>,
    min_version: &str,
) -> Result<(PathBuf, String), DriverError> {
    let binary = match configured {
        Some(p) => p.to_path_buf(),
        None => resolve_claude().ok_or_else(|| {
            DriverError::BinaryNotFound(format!("`{CLAUDE_BIN}` is not on PATH"))
        })?,
    };
    let version = claude_version(&binary).await?;
    if !version_at_least(&version, min_version) {
        return Err(DriverError::VersionTooOld {
            found: version,
            required: min_version.to_owned(),
        });
    }
    Ok((binary, version))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_measured_version_line() {
        assert_eq!(parse_version("2.1.257 (Claude Code)"), Some((2, 1, 257)));
        assert_eq!(parse_version("2.1.257"), Some((2, 1, 257)));
        assert_eq!(parse_version("2.1.257-rc1 (Claude Code)"), Some((2, 1, 257)));
        assert_eq!(parse_version("Claude Code"), None);
        assert_eq!(parse_version(""), None);
    }

    #[test]
    fn version_floor_is_numeric_not_lexical() {
        assert!(version_at_least("2.1.257 (Claude Code)", MIN_VERSION));
        assert!(version_at_least("2.1.300 (Claude Code)", MIN_VERSION));
        assert!(version_at_least("2.2.0 (Claude Code)", MIN_VERSION));
        assert!(!version_at_least("2.1.99 (Claude Code)", MIN_VERSION), "99 < 257 numerically");
        assert!(!version_at_least("2.0.999", MIN_VERSION));
        // Unparseable is permissive on purpose: the version string is not a contract.
        assert!(version_at_least("wat", MIN_VERSION));
    }
}
