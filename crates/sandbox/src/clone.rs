//! Copy-on-write copies of folders, for warming a task's worktree with the build caches of the
//! user's checkout.
//!
//! - macOS: `clonefile(2)` clones the whole tree on APFS. Nothing is written until either side
//!   changes a file, and then only that file diverges.
//! - Linux: `cp -a --reflink=always`, which fails rather than falling back to a full copy on file
//!   systems that can't share blocks.
//! - Elsewhere: a plain copy, only for folders under [`PLAIN_COPY_LIMIT`].
//!
//! [`rename_new`] publishes a finished copy without ever replacing what is already there.

use std::io;
use std::path::Path;

/// The biggest folder copied byte by byte where the file system can't share blocks.
pub const PLAIN_COPY_LIMIT: u64 = 1 << 30;

/// How a folder was copied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    /// The copy shares storage with the original until either changes.
    CopyOnWrite,
    /// A full copy.
    Plain,
}

/// Copies the folder `src` to `dst`, which must not exist yet. Links are copied as links, never
/// followed. On failure `dst` may be partly written: the caller removes it.
pub fn clone_tree(src: &Path, dst: &Path) -> io::Result<Method> {
    if dst.symlink_metadata().is_ok() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!("{} already exists", dst.display()),
        ));
    }
    platform_clone(src, dst)
}

#[cfg(target_os = "macos")]
fn platform_clone(src: &Path, dst: &Path) -> io::Result<Method> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    // `CLONE_NOFOLLOW` from <sys/clonefile.h>: clone a link itself, not what it points at.
    const CLONE_NOFOLLOW: u32 = 0x0001;
    let from = CString::new(src.as_os_str().as_bytes())?;
    let to = CString::new(dst.as_os_str().as_bytes())?;
    // SAFETY: both arguments are NUL-terminated paths that live for the whole call.
    #[allow(unsafe_code)]
    let status = unsafe { libc::clonefile(from.as_ptr(), to.as_ptr(), CLONE_NOFOLLOW) };
    if status == 0 {
        Ok(Method::CopyOnWrite)
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(target_os = "linux")]
fn platform_clone(src: &Path, dst: &Path) -> io::Result<Method> {
    let output = std::process::Command::new("cp")
        .args(["-a", "--reflink=always", "--"])
        .arg(src)
        .arg(dst)
        .stdin(std::process::Stdio::null())
        .output()?;
    if output.status.success() {
        Ok(Method::CopyOnWrite)
    } else {
        Err(io::Error::other(format!(
            "cp --reflink=always failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )))
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn platform_clone(src: &Path, dst: &Path) -> io::Result<Method> {
    let size = tree_size(src, PLAIN_COPY_LIMIT)?;
    if size >= PLAIN_COPY_LIMIT {
        return Err(io::Error::other(format!(
            "{} is 1 GB or more, too big to copy without copy-on-write",
            src.display()
        )));
    }
    plain_copy(src, dst)?;
    Ok(Method::Plain)
}

/// The bytes of the files in `dir`, counting stops once past `limit`. Links are not followed.
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn tree_size(dir: &Path, limit: u64) -> io::Result<u64> {
    let mut total = 0u64;
    let mut pending = vec![dir.to_owned()];
    while let Some(dir) = pending.pop() {
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            if kind.is_dir() {
                pending.push(entry.path());
            } else if kind.is_file() {
                total += entry.metadata()?.len();
                if total >= limit {
                    return Ok(total);
                }
            }
        }
    }
    Ok(total)
}

/// Copies a tree file by file. A link fails the copy: re-creating one needs rights Windows
/// doesn't give every user.
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn plain_copy(src: &Path, dst: &Path) -> io::Result<()> {
    std::fs::create_dir(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let to = dst.join(entry.file_name());
        if kind.is_symlink() {
            return Err(io::Error::other(format!(
                "{} is a link",
                entry.path().display()
            )));
        } else if kind.is_dir() {
            plain_copy(&entry.path(), &to)?;
        } else {
            std::fs::copy(entry.path(), &to)?;
        }
    }
    Ok(())
}

/// Renames `from` to `to`, failing with `AlreadyExists` when `to` is there (it is never
/// replaced, even by an empty folder).
pub fn rename_new(from: &Path, to: &Path) -> io::Result<()> {
    platform_rename_new(from, to)
}

#[cfg(target_os = "macos")]
fn platform_rename_new(from: &Path, to: &Path) -> io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let source = CString::new(from.as_os_str().as_bytes())?;
    let target = CString::new(to.as_os_str().as_bytes())?;
    // SAFETY: both arguments are NUL-terminated paths that live for the whole call.
    #[allow(unsafe_code)]
    let status = unsafe { libc::renamex_np(source.as_ptr(), target.as_ptr(), libc::RENAME_EXCL) };
    if status == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(all(target_os = "linux", target_env = "gnu"))]
fn platform_rename_new(from: &Path, to: &Path) -> io::Result<()> {
    use nix::fcntl::{AT_FDCWD, RenameFlags, renameat2};
    renameat2(AT_FDCWD, from, AT_FDCWD, to, RenameFlags::RENAME_NOREPLACE).map_err(io::Error::from)
}

/// Windows refuses to rename over an existing folder by itself; elsewhere the check narrows the
/// window to nothing Brigadier itself would race with (the worktree is new and still private).
#[cfg(not(any(target_os = "macos", all(target_os = "linux", target_env = "gnu"))))]
fn platform_rename_new(from: &Path, to: &Path) -> io::Result<()> {
    if to.symlink_metadata().is_ok() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!("{} already exists", to.display()),
        ));
    }
    std::fs::rename(from, to)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "brigadier-clone-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn clones_a_tree_and_refuses_an_existing_destination() {
        let root = temp("tree");
        let src = root.join("src");
        std::fs::create_dir_all(src.join("a/b")).unwrap();
        std::fs::write(src.join("a/b/file"), b"hello").unwrap();
        let dst = root.join("dst");
        // Tests run on whatever file system the temp folder is on; one that can't share
        // blocks fails cleanly, which is all warming needs.
        match clone_tree(&src, &dst) {
            Ok(_) => {
                assert_eq!(std::fs::read(dst.join("a/b/file")).unwrap(), b"hello");
                std::fs::write(dst.join("a/b/file"), b"changed").unwrap();
                assert_eq!(std::fs::read(src.join("a/b/file")).unwrap(), b"hello");
            }
            Err(_) => assert!(!dst.join("a/b/file").exists()),
        }
        std::fs::create_dir_all(root.join("there")).unwrap();
        let err = clone_tree(&src, &root.join("there")).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn rename_new_never_replaces_even_an_empty_folder() {
        let root = temp("rename");
        std::fs::create_dir_all(root.join("from/inner")).unwrap();
        std::fs::create_dir_all(root.join("to")).unwrap();
        assert!(rename_new(&root.join("from"), &root.join("to")).is_err());
        assert!(root.join("from/inner").is_dir());
        rename_new(&root.join("from"), &root.join("fresh")).unwrap();
        assert!(root.join("fresh/inner").is_dir());
        std::fs::remove_dir_all(&root).unwrap();
    }
}
