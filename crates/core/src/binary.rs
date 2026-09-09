//! Local CLI discovery without changing the process environment or running a login shell.

use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
};

/// An explicit configuration is authoritative, including when it is invalid. The probe
/// reports its failure instead of silently choosing a different installation.
pub(crate) fn resolve(name: &str, configured: Option<&Path>) -> Option<PathBuf> {
    resolve_in(
        name,
        configured,
        std::env::var_os("PATH").as_deref(),
        std::env::var_os("HOME").as_deref(),
    )
}

fn resolve_in(
    name: &str,
    configured: Option<&Path>,
    path: Option<&OsStr>,
    home: Option<&OsStr>,
) -> Option<PathBuf> {
    if let Some(configured) = configured {
        return Some(configured.to_owned());
    }
    candidates(name, path, home)
        .into_iter()
        .find(|candidate| is_executable(candidate))
}

fn candidates(name: &str, path: Option<&OsStr>, home: Option<&OsStr>) -> Vec<PathBuf> {
    let mut paths: Vec<_> = path
        .into_iter()
        .flat_map(std::env::split_paths)
        .filter(|dir| !dir.as_os_str().is_empty())
        .map(|dir| dir.join(name))
        .collect();
    if let Some(home) = home.filter(|home| !home.is_empty()) {
        paths.push(PathBuf::from(home).join(".local/bin").join(name));
    }
    // LaunchServices does not inherit the user's interactive shell PATH.
    #[cfg(target_os = "macos")]
    paths.extend([
        PathBuf::from("/opt/homebrew/bin").join(name),
        PathBuf::from("/usr/local/bin").join(name),
    ]);
    paths
}

fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    fn executable(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn launch_services_path_finds_native_symlinks_for_both_providers() {
        let home = tempfile::tempdir().unwrap();
        for name in ["codex", "claude"] {
            let actual = home.path().join("packages").join(name);
            executable(&actual);
            let link = home.path().join(".local/bin").join(name);
            std::fs::create_dir_all(link.parent().unwrap()).unwrap();
            symlink(&actual, &link).unwrap();
            assert_eq!(
                resolve_in(
                    name,
                    None,
                    Some(OsStr::new("/usr/bin:/bin:/usr/sbin:/sbin")),
                    Some(home.path().as_os_str())
                ),
                Some(link)
            );
        }
    }

    #[test]
    fn configured_binary_wins_even_if_missing() {
        let home = tempfile::tempdir().unwrap();
        executable(&home.path().join(".local/bin/codex"));
        let configured = home.path().join("configured-codex");
        assert_eq!(
            resolve_in(
                "codex",
                Some(&configured),
                None,
                Some(home.path().as_os_str())
            ),
            Some(configured)
        );
    }

    #[test]
    fn path_precedes_native_fallback_and_keeps_its_order() {
        let home = tempfile::tempdir().unwrap();
        let first = home.path().join("first");
        let second = home.path().join("second");
        for dir in [&first, &second, &home.path().join(".local/bin")] {
            executable(&dir.join("codex"));
        }
        let path = std::env::join_paths([&first, &second]).unwrap();
        assert_eq!(
            resolve_in("codex", None, Some(&path), Some(home.path().as_os_str())),
            Some(first.join("codex"))
        );
    }

    #[test]
    fn skips_non_executable_files_directories_and_broken_symlinks() {
        let home = tempfile::tempdir().unwrap();
        let paths: Vec<_> = ["file", "directory", "broken", "valid"]
            .map(|p| home.path().join(p))
            .into();
        for dir in &paths {
            std::fs::create_dir_all(dir).unwrap();
        }
        std::fs::write(paths[0].join("codex"), "not executable").unwrap();
        std::fs::create_dir(paths[1].join("codex")).unwrap();
        symlink(home.path().join("missing"), paths[2].join("codex")).unwrap();
        executable(&paths[3].join("codex"));
        let path = std::env::join_paths(&paths).unwrap();
        assert_eq!(
            resolve_in("codex", None, Some(&path), None),
            Some(paths[3].join("codex"))
        );
    }

    #[test]
    fn empty_path_and_home_do_not_add_current_directory() {
        let paths = candidates("codex", Some(OsStr::new(":")), Some(OsStr::new("")));
        assert!(paths.iter().all(|p| p.is_absolute()));
        assert!(resolve_in("brigadier-test-missing-cli", None, None, None).is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_fallbacks_include_both_homebrew_prefixes() {
        assert_eq!(
            candidates("codex", None, None),
            vec![
                PathBuf::from("/opt/homebrew/bin/codex"),
                PathBuf::from("/usr/local/bin/codex")
            ]
        );
    }
}
