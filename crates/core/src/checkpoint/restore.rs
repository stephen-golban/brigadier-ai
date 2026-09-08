use super::*;
use rustix::fs::{self as at, AtFlags, Mode, OFlags};
use std::os::unix::fs::MetadataExt;
use std::{
    fs::File,
    io::{Read, Write},
    path::Path,
};

fn err(e: rustix::io::Errno) -> Error {
    std::io::Error::from(e).into()
}
fn attributes(file: &File) -> Result<BTreeMap<String, Vec<u8>>> {
    let mut names = vec![0; 64 * 1024];
    let size = at::flistxattr(file, names.as_mut_slice()).map_err(err)?;
    let mut result = BTreeMap::new();
    let mut total = 0usize;
    for name in names[..size].split(|b| *b == 0).filter(|b| !b.is_empty()) {
        let name =
            std::str::from_utf8(name).map_err(|_| unavailable("Non-UTF-8 extended attribute"))?;
        if !restorable_attribute(name) {
            continue;
        }
        let mut data = vec![0; 64 * 1024];
        let len = at::fgetxattr(file, name, data.as_mut_slice()).map_err(err)?;
        total += len;
        if total > 64 * 1024 {
            return Err(unavailable("File metadata exceeds checkpoint limit"));
        }
        data.truncate(len);
        result.insert(name.to_owned(), data);
    }
    Ok(result)
}
fn acl_free(path: &Path) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        // Safe API propagates ACL read errors. Unlike ls output, an empty successful result
        // is an explicit absence of extended entries. Parent traversal still requires the
        // quiescent workspace contract because this metadata API is path-based.
        if !exacl::getfacl(path, exacl::AclOption::SYMLINK_ACL)?.is_empty() {
            return Err(unavailable(
                "ACL-bearing metadata is outside checkpoint coverage",
            ));
        }
    }
    Ok(())
}
pub(crate) fn capture_metadata(file: &File, path: &Path) -> Result<FileMetadata> {
    let meta = file.metadata()?;
    if meta.nlink() != 1 || meta.mode() & 0o7000 != 0 {
        return Err(unavailable(
            "Hardlinks and special permission bits are outside checkpoint coverage",
        ));
    }
    acl_free(path)?;
    #[cfg(target_os = "macos")]
    if at::fstat(file).map_err(err)?.st_flags != 0 {
        return Err(unavailable("File flags are outside checkpoint coverage"));
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        return Err(unavailable(
            "File restore metadata has only been verified on macOS",
        ));
    }
    #[allow(unreachable_code)]
    Ok(FileMetadata {
        permissions: meta.mode() & 0o777,
        uid: meta.uid(),
        gid: meta.gid(),
        attributes: attributes(file)?,
    })
}
fn parent(root: &Path, path: &str) -> Result<(File, String)> {
    parent_with_create(root, path, false)
}
fn parent_with_create(root: &Path, path: &str, create: bool) -> Result<(File, String)> {
    if !valid_path(path) || scan::excluded(path) {
        return Err(unavailable("Unsafe restore path"));
    }
    let fd = at::open(
        root,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(err)?;
    let mut dir = File::from(fd);
    let mut parts = path.split('/').peekable();
    while let Some(part) = parts.next() {
        if parts.peek().is_none() {
            acl_free(root.join(path).parent().unwrap())?;
            return Ok((dir, part.to_owned()));
        }
        let next = at::openat(
            &dir,
            part,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        );
        dir = match next {
            Ok(fd) => File::from(fd),
            Err(rustix::io::Errno::NOENT) if create => {
                match at::mkdirat(&dir, part, Mode::from_raw_mode(0o755)) {
                    Ok(()) => sync(&dir)?,
                    Err(rustix::io::Errno::EXIST) => {}
                    Err(e) => return Err(err(e)),
                }
                File::from(
                    at::openat(
                        &dir,
                        part,
                        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                        Mode::empty(),
                    )
                    .map_err(err)?,
                )
            }
            Err(e) => return Err(err(e)),
        };
    }
    Err(unavailable("Empty restore path"))
}
fn sync(file: &File) -> Result<()> {
    file.sync_all()?;
    Ok(())
}
impl SnapshotStore {
    /// Validate every planned path and blob before the caller journals any mutation.
    pub fn validate_restore(&self, plan: &RestorePlan) -> Result<()> {
        if !plan.conflicts.is_empty() {
            return Err(unavailable("Manual edits conflict with this rewind"));
        }
        if scan::root_identity(&plan.current.root)? != plan.current.identity {
            return Err(unavailable("Workspace root was replaced"));
        }
        let current = self.capture(&plan.current.root, plan.current.coverage.clone())?;
        if current.files != plan.current.files || current.git != plan.current.git {
            return Err(unavailable(
                "Workspace changed; refresh the restore preview",
            ));
        }
        self.validate_support(plan)
    }
    /// Check supported metadata and topology without writing workspace files.
    pub fn validate_support(&self, plan: &RestorePlan) -> Result<()> {
        for c in &plan.changes {
            if c.after.is_some() {
                match parent(&plan.current.root, &c.path) {
                    Ok(_) => {}
                    Err(Error::Io(e))
                        if e.kind() == std::io::ErrorKind::NotFound && c.before.is_none() => {}
                    Err(e) => return Err(e),
                }
            }
            for other in &plan.changes {
                if other.path.starts_with(&format!("{}/", c.path)) {
                    return Err(unavailable(
                        "File/directory topology restoration is unsupported",
                    ));
                }
            }
            if c.before.as_ref().is_some_and(|s| s.mode == "120000")
                || c.after.as_ref().is_some_and(|s| s.mode == "120000")
            {
                return Err(unavailable(
                    "Symlink restoration is not yet supported; checkpoint retained",
                ));
            }
            if let Some(after) = &c.after {
                if after.metadata.is_none() {
                    return Err(unavailable("Checkpoint lacks file metadata"));
                }
                if self.blob(&after.oid)?.len() as u64 != after.bytes {
                    return Err(unavailable("Checkpoint blob size mismatch"));
                }
            }
        }
        Ok(())
    }
    /// Apply a single already-journaled path intent under the caller's workspace lease.
    /// Parent traversal is descriptor-relative and never follows links.
    pub fn apply_change(&self, root: &Path, identity: &str, change: &Change) -> Result<()> {
        if scan::root_identity(root)? != identity {
            return Err(unavailable("Workspace root identity changed"));
        }
        // Missing target ancestors are unsupported; directories are never recursively removed.
        let (dir, name) = match parent_with_create(root, &change.path, change.after.is_some()) {
            Ok(parent) => parent,
            Err(Error::Io(e))
                if e.kind() == std::io::ErrorKind::NotFound && change.after.is_none() =>
            {
                return Ok(())
            }
            Err(e) => return Err(e),
        };
        let actual = self.path_state(&dir, &name, &root.join(&change.path))?;
        if actual == change.after {
            return Ok(());
        }
        if actual != change.before {
            return Err(unavailable(format!(
                "File changed since preview: {}",
                change.path
            )));
        }
        if let Some(after) = &change.after {
            if !["100644", "100755"].contains(&after.mode.as_str()) {
                return Err(unavailable("Unsupported restore type"));
            }
            let metadata = after
                .metadata
                .as_ref()
                .ok_or_else(|| unavailable("Missing checkpoint metadata"))?;
            let bytes = self.blob(&after.oid)?;
            let tmp = format!(".brigadier-restore-{}", uuid::Uuid::new_v4());
            let fd = at::openat(
                &dir,
                tmp.as_str(),
                OFlags::RDWR | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::from_raw_mode(0o600),
            )
            .map_err(err)?;
            let mut file = File::from(fd);
            let result = (|| {
                file.write_all(&bytes)?;
                // Preserve original owner/group only when the OS permits it; failure is pre-write.
                at::fchown(
                    &file,
                    Some(rustix::fs::Uid::from_raw(metadata.uid)),
                    Some(rustix::fs::Gid::from_raw(metadata.gid)),
                )
                .map_err(err)?;
                at::fchmod(
                    &file,
                    Mode::from_raw_mode((metadata.permissions & 0o777) as _),
                )
                .map_err(err)?;
                for key in attributes(&file)?.keys() {
                    if !metadata.attributes.contains_key(key) {
                        at::fremovexattr(&file, key.as_str()).map_err(err)?;
                    }
                }
                for (key, value) in &metadata.attributes {
                    at::fsetxattr(&file, key.as_str(), value, at::XattrFlags::empty())
                        .map_err(err)?;
                }
                if capture_metadata(&file, &root.join(&change.path).parent().unwrap().join(&tmp))?
                    != *metadata
                {
                    return Err(unavailable("Restored metadata did not round trip"));
                }
                sync(&file)?;
                if self.path_state(&dir, &name, &root.join(&change.path))? != change.before {
                    return Err(unavailable("File changed before replacement"));
                }
                // Re-open parent from the root to catch directory replacement/renaming.
                let (live, _) = parent(root, &change.path)?;
                if (live.metadata()?.dev(), live.metadata()?.ino())
                    != (dir.metadata()?.dev(), dir.metadata()?.ino())
                {
                    return Err(unavailable("Restore parent changed"));
                }
                if change.before.is_none() {
                    at::renameat_with(
                        &dir,
                        tmp.as_str(),
                        &dir,
                        name.as_str(),
                        at::RenameFlags::NOREPLACE,
                    )
                    .map_err(err)?;
                } else {
                    at::renameat(&dir, tmp.as_str(), &dir, name.as_str()).map_err(err)?;
                }
                sync(&dir)?;
                Ok(())
            })();
            if result.is_err() {
                let _ = at::unlinkat(&dir, tmp.as_str(), AtFlags::empty());
            }
            result
        } else {
            let (live, _) = parent(root, &change.path)?;
            if (live.metadata()?.dev(), live.metadata()?.ino())
                != (dir.metadata()?.dev(), dir.metadata()?.ino())
            {
                return Err(unavailable("Restore parent changed"));
            }
            at::unlinkat(&dir, name.as_str(), AtFlags::empty()).map_err(err)?;
            sync(&dir)
        }
    }
    fn path_state(&self, dir: &File, name: &str, path: &Path) -> Result<Option<PathState>> {
        let fd = match at::openat(
            dir,
            name,
            OFlags::RDONLY | OFlags::NONBLOCK | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        ) {
            Ok(fd) => fd,
            Err(e) if e == rustix::io::Errno::NOENT => return Ok(None),
            Err(e) => return Err(err(e)),
        };
        let mut file = File::from(fd);
        let m = file.metadata()?;
        if !m.is_file() || m.len() > self.limits.file_bytes {
            return Err(unavailable("Unsupported restore file"));
        }
        let metadata = capture_metadata(&file, path)?;
        let mut bytes = Vec::new();
        (&mut file)
            .take(self.limits.file_bytes + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > self.limits.file_bytes {
            return Err(unavailable("File exceeds restore limit"));
        }
        Ok(Some(PathState {
            oid: self.hash(&bytes)?,
            mode: if m.mode() & 0o111 != 0 {
                "100755"
            } else {
                "100644"
            }
            .into(),
            bytes: bytes.len() as u64,
            metadata: Some(metadata),
        }))
    }
}
