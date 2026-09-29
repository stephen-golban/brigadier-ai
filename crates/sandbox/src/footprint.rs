//! What a Brigadier app leaves around the system outside its data directory, found only by
//! exact names: the per-app folders the OS and the webview keep under its bundle identifier,
//! and the temp folders its Claude sessions made (named `brigadier-<12 hex>`, this user's,
//! private, and marked with the data directory that made them).

use std::path::PathBuf;

/// Where Claude sessions' own temp folders are (see the Claude adapter).
#[cfg(unix)]
pub const SESSION_TEMP_BASE: &str = "/tmp";

/// A per-app folder or file, with the folder it must stay inside.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppFolder {
    pub root: PathBuf,
    pub path: PathBuf,
}

/// Whether `identifier` is a Brigadier bundle identifier (`ai.brigadier.app`, or a development
/// one under `ai.brigadier.`), safe to join to a folder: letters, digits, dots and dashes.
pub fn is_brigadier_identifier(identifier: &str) -> bool {
    identifier
        .strip_prefix("ai.brigadier.")
        .is_some_and(|rest| {
            !rest.is_empty()
                && rest.len() <= 100
                && rest.split('.').all(|part| {
                    !part.is_empty() && part.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
                })
        })
}

/// Every place the OS and the webview keep for the app `identifier`, whether it is there or
/// not. Empty for an identifier that isn't Brigadier's.
pub fn app_folders(identifier: &str) -> Vec<AppFolder> {
    if !is_brigadier_identifier(identifier) {
        return Vec::new();
    }
    let mut folders = Vec::new();
    let mut add = |root: Option<PathBuf>, name: String| {
        if let Some(root) = root {
            folders.push(AppFolder {
                path: root.join(name),
                root,
            });
        }
    };
    #[cfg(target_os = "macos")]
    {
        let library = dirs::home_dir().map(|home| home.join("Library"));
        let under = |part: &str| library.as_ref().map(|library| library.join(part));
        add(under("Application Support"), identifier.to_owned());
        add(under("Caches"), identifier.to_owned());
        add(under("WebKit"), identifier.to_owned());
        add(under("HTTPStorages"), identifier.to_owned());
        add(under("HTTPStorages"), format!("{identifier}.binarycookies"));
        add(under("Preferences"), format!("{identifier}.plist"));
        add(
            under("Saved Application State"),
            format!("{identifier}.savedState"),
        );
        add(under("Logs"), identifier.to_owned());
        add(
            darwin_user_dir("DARWIN_USER_CACHE_DIR"),
            identifier.to_owned(),
        );
        add(
            darwin_user_dir("DARWIN_USER_TEMP_DIR"),
            identifier.to_owned(),
        );
    }
    #[cfg(target_os = "linux")]
    {
        add(dirs::config_dir(), identifier.to_owned());
        add(dirs::data_dir(), identifier.to_owned());
        add(dirs::cache_dir(), identifier.to_owned());
    }
    #[cfg(windows)]
    {
        add(dirs::config_dir(), identifier.to_owned());
        add(dirs::data_local_dir(), identifier.to_owned());
    }
    folders
}

/// This user's per-user folder the system names `key` (`getconf DARWIN_USER_CACHE_DIR`).
#[cfg(target_os = "macos")]
fn darwin_user_dir(key: &str) -> Option<PathBuf> {
    let output = std::process::Command::new("/usr/bin/getconf")
        .arg(key)
        .output()
        .ok()
        .filter(|output| output.status.success())?;
    let dir = String::from_utf8(output.stdout).ok()?;
    let dir = PathBuf::from(dir.trim());
    (dir.starts_with("/var/folders") || dir.starts_with("/private/var/folders")).then_some(dir)
}

/// A session temp folder: its path and what its owner marker says (`None`: an older Brigadier
/// made it without one).
#[derive(Debug, Clone)]
pub struct SessionTemp {
    pub path: PathBuf,
    pub marker: Option<String>,
}

impl SessionTemp {
    /// Made by the data directory whose instance id is `instance`.
    pub fn made_by(&self, instance: &str) -> bool {
        self.marker
            .as_deref()
            .is_some_and(|marker| marker.lines().next() == Some(instance))
    }
}

/// Session temp folders in [`SESSION_TEMP_BASE`]: `brigadier-<12 lowercase hex>` folders (not
/// links) of this user, readable by nobody else.
#[cfg(unix)]
pub fn session_temp_folders() -> Vec<SessionTemp> {
    use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};
    let uid = nix::unistd::getuid().as_raw();
    let base = std::path::Path::new(SESSION_TEMP_BASE);
    let Ok(entries) = std::fs::read_dir(base) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_session_dir = name.strip_prefix("brigadier-").is_some_and(|id| {
            id.len() == 12
                && id
                    .chars()
                    .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        });
        if !is_session_dir {
            continue;
        }
        let path = base.join(&name);
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if !meta.is_dir() || meta.uid() != uid || meta.permissions().mode() & 0o777 != 0o700 {
            continue;
        }
        found.push(SessionTemp {
            marker: crate::removal::read_owner_marker(&path),
            path,
        });
    }
    found
}

#[cfg(not(unix))]
pub fn session_temp_folders() -> Vec<SessionTemp> {
    Vec::new()
}
